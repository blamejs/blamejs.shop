"use strict";
/**
 * @module shop.cycleCounting
 * @title  Cycle counting — scheduled physical inventory audits with
 *         variance reconciliation
 *
 * @intro
 *   Physical stock and recorded stock drift over time. Shrinkage,
 *   mis-pick at receive, mis-scan at ship, the occasional
 *   theft-from-the-back-room — every shop carries a non-zero gap
 *   between "what the database says is on the shelf" and "what is
 *   actually on the shelf." Cycle counting is the operator-discipline
 *   that closes that gap on a cadence: schedule a count, pick a
 *   subset of SKUs, walk the shelf with a worksheet, record the
 *   actual qty, write adjustments for the variances.
 *
 *   This primitive owns the scheduling + worksheet + variance math.
 *   It composes `inventoryLocations.adjustStock` for the per-shelf
 *   correction (when wired) so the audit trail on
 *   `inventory_adjustments` carries the cycle-count slug as the
 *   reason — operators reconstruct "which count produced this
 *   shrinkage write-off" from a single column.
 *
 *   Lifecycle (four-state FSM):
 *
 *     defineCount({ slug, kind, scope, scheduled_at, location_code? })
 *       Validates the scope payload against the kind enum, persists
 *       the header at status='scheduled'. No worksheet rows yet —
 *       worksheetFor pulls expected quantities at call time so a
 *       count scheduled today and walked next Monday captures the
 *       Monday-morning expected qty rather than today's.
 *
 *     worksheetFor(count_slug)
 *       Resolves the scope into an SKU list (rotating: scope.skus;
 *       abc: catalog.skusForAbcClass(scope.abc_class); full:
 *       catalog.allActiveSkus()). For every SKU pulls the expected
 *       quantity (global from catalog.inventory.get(sku) when
 *       location_code is null, per-location from
 *       inventoryLocations.stockForSku(sku) otherwise) and persists
 *       one line per SKU. Transitions scheduled -> in_progress on
 *       first call; subsequent calls are idempotent (return the
 *       same worksheet rows).
 *
 *     recordCount({ slug, lines: [{ sku, location_code?, actual_quantity, counted_by }] })
 *       Patches the actual_quantity + counted_by + counted_at
 *       columns on existing line rows. Refuses SKUs that weren't on
 *       the worksheet (the operator must defineCount + worksheetFor
 *       first). Idempotent on the per-SKU value — calling recordCount
 *       twice for the same SKU overwrites the prior actual_quantity
 *       (a recount). counted_at defaults to now.
 *
 *     finalizeCount({ slug, apply_adjustments? })
 *       in_progress -> finalized. Walks every line, computes
 *       variance = actual_quantity - expected_quantity (lines with
 *       NULL actual_quantity are treated as actual=0 — the operator
 *       didn't count it, every expected unit is a discrepancy).
 *       Writes the variance column on every line. Aggregates
 *       variance_count (lines with non-zero variance) and
 *       variance_value_minor (sum of |variance| * unit_value) onto
 *       the header. When apply_adjustments is true and an
 *       inventoryLocations dep was wired, calls adjustStock for
 *       every non-zero variance with reason "cycle-count:<slug>".
 *       Returns { variance_count, variance_value_minor,
 *       adjustments_written }.
 *
 *     cancelCount({ slug, reason })
 *       scheduled|in_progress -> cancelled. Persists the reason +
 *       cancelled_at timestamp. Cancelling a finalized count is
 *       refused — the adjustments have already landed.
 *
 *   Reads:
 *     discrepanciesFor(slug)         — every line with non-zero variance
 *     listCounts({ kind?, from?, to? })
 *                                    — keyset-paginated count headers
 *     historyForSku(sku, { limit, cursor? })
 *                                    — every line across every count
 *                                      that touched this SKU
 *
 *   Composition:
 *     - b.uuid.v7              — line row PKs (sortable)
 *     - b.pagination           — HMAC-tagged cursors for the list verbs
 *     - catalog                — SOLE source of SKU enumeration for
 *                                abc + full scopes; global-stock reads
 *                                for counts without a location_code;
 *                                optional unitValueMinor(sku) for the
 *                                variance_value_minor aggregation
 *     - inventoryLocations     — optional. Required when the count
 *                                carries a location_code so per-shelf
 *                                expected qty is captured; required
 *                                when finalizeCount({ apply_adjustments:
 *                                true }) is called so the variance
 *                                writes through adjustStock.
 *
 *   Three-tier input validation: every public verb here is either a
 *   config-time entry point (defineCount, cancelCount) or a
 *   defensive request-shape reader (worksheetFor, recordCount,
 *   finalizeCount, discrepanciesFor, listCounts, historyForSku).
 *   Both shapes throw on bad input — no drop-silent hot-path sinks.
 *
 * @primitive cycleCounting
 * @related    inventoryLocations, stockTransfers, catalog
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var SLUG_RE          = /^[a-z0-9][a-z0-9-]{0,79}$/;
var SKU_RE           = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CODE_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var ABC_RE           = /^[A-Za-z][A-Za-z0-9]{0,15}$/;
var COUNTER_RE       = /^[\S\s]{1,128}$/;
var KINDS            = Object.freeze(["rotating", "abc", "full"]);
var STATUSES         = Object.freeze(["scheduled", "in_progress", "finalized", "cancelled"]);
var MAX_REASON       = 280;
var MAX_LINES        = 50000;
var MAX_LIST_LIMIT   = 200;
var LINE_ORDER_KEY   = ["counted_at:desc", "id:desc"];

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("cycle-counting: slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + dash, 1..80 chars)");
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("cycle-counting: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("cycle-counting: " + (label || "location_code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _codeOrNull(s, label) {
  if (s == null) return null;
  _code(s, label);
  return s;
}
function _abc(s) {
  if (typeof s !== "string" || !ABC_RE.test(s)) {
    throw new TypeError("cycle-counting: abc_class must match /^[A-Za-z][A-Za-z0-9]*$/ (1..16 chars)");
  }
}
function _kind(s) {
  if (KINDS.indexOf(s) === -1) {
    throw new TypeError("cycle-counting: kind must be one of " + KINDS.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("cycle-counting: " + label + " must be a non-negative integer (epoch ms)");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("cycle-counting: " + label + " must be a non-negative integer");
  }
}
function _counter(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !COUNTER_RE.test(s) || s.length > 128) {
    throw new TypeError("cycle-counting: counted_by must be a string ≤ 128 chars");
  }
  return s;
}
function _reason(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_REASON) {
    throw new TypeError("cycle-counting: reason must be a string ≤ " + MAX_REASON + " chars");
  }
  return s;
}
function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("cycle-counting: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}

function _now() { return Date.now(); }

// Parse the operator-supplied `scope` against the kind enum. Returns
// a normalized object: { skus: [...] } | { abc_class: string } |
// { all_active: true }. Refuses cross-kind payloads (an abc count
// with an `skus` array, etc.) so misconfiguration surfaces at
// defineCount time rather than at worksheetFor.
function _validateScope(kind, scope) {
  if (!scope || typeof scope !== "object") {
    throw new TypeError("cycle-counting: scope must be an object");
  }
  if (kind === "rotating") {
    if (!Array.isArray(scope.skus) || scope.skus.length === 0) {
      throw new TypeError("cycle-counting: kind=rotating requires scope.skus as a non-empty array");
    }
    if (scope.skus.length > MAX_LINES) {
      throw new TypeError("cycle-counting: scope.skus must contain ≤ " + MAX_LINES + " entries");
    }
    var seen = Object.create(null);
    var normalized = [];
    for (var i = 0; i < scope.skus.length; i += 1) {
      _sku(scope.skus[i]);
      if (seen[scope.skus[i]]) {
        throw new TypeError("cycle-counting: duplicate sku " + JSON.stringify(scope.skus[i]) +
          " in scope.skus");
      }
      seen[scope.skus[i]] = true;
      normalized.push(scope.skus[i]);
    }
    return { skus: normalized };
  }
  if (kind === "abc") {
    if (scope.abc_class == null) {
      throw new TypeError("cycle-counting: kind=abc requires scope.abc_class");
    }
    _abc(scope.abc_class);
    return { abc_class: scope.abc_class };
  }
  // kind === "full"
  if (scope.all_active !== true) {
    throw new TypeError("cycle-counting: kind=full requires scope.all_active === true");
  }
  return { all_active: true };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog || typeof opts.catalog !== "object") {
    throw new TypeError("cycle-counting.create: opts.catalog is required");
  }
  var catalog = opts.catalog;
  // inventoryLocations is optional — required only at run time when
  // either (a) the count carries a location_code (per-shelf expected
  // qty + per-shelf adjustment), or (b) finalizeCount({
  // apply_adjustments: true }) is called. The runtime check surfaces
  // a typed error at the call site rather than failing loud at boot
  // for operators that only run global counts.
  var inventoryLocations = opts.inventoryLocations || null;
  if (inventoryLocations !== null && typeof inventoryLocations !== "object") {
    throw new TypeError("cycle-counting.create: opts.inventoryLocations must be an object or null");
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged so operators can't tamper
  // across deployments. Tests inject a fixed dev string; production
  // demands an explicit secret.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("cycle-counting.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "cycle-counting-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Read the count header or null on miss.
  async function _getHeader(slug) {
    var r = await query("SELECT * FROM cycle_counts WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  // Read every line for a count, ordered by SKU so the worksheet
  // walks the shelf in a stable order.
  async function _getLines(slug) {
    var r = await query(
      "SELECT * FROM cycle_count_lines WHERE count_slug = ?1 ORDER BY sku ASC",
      [slug],
    );
    return r.rows;
  }

  // Hydrate a header + its lines + its parsed scope. Returns null on
  // miss so callers map cleanly to HTTP 404.
  async function _getHydrated(slug) {
    var header = await _getHeader(slug);
    if (!header) return null;
    header.scope = JSON.parse(header.scope_json);
    header.lines = await _getLines(slug);
    return header;
  }

  // Resolve the count's scope into an SKU list. Composes the catalog
  // for the abc + full kinds; the rotating kind is just the persisted
  // scope.skus array.
  async function _resolveSkus(scope) {
    if (scope.skus) return scope.skus.slice();
    if (scope.abc_class) {
      if (typeof catalog.skusForAbcClass !== "function") {
        throw new TypeError("cycle-counting.worksheetFor: kind=abc requires " +
          "catalog.skusForAbcClass(class) but the wired catalog does not expose it");
      }
      var fromAbc = await catalog.skusForAbcClass(scope.abc_class);
      if (!Array.isArray(fromAbc)) {
        throw new TypeError("cycle-counting.worksheetFor: catalog.skusForAbcClass(" +
          JSON.stringify(scope.abc_class) + ") must return an array");
      }
      return fromAbc.slice();
    }
    // scope.all_active === true
    if (typeof catalog.allActiveSkus !== "function") {
      throw new TypeError("cycle-counting.worksheetFor: kind=full requires " +
        "catalog.allActiveSkus() but the wired catalog does not expose it");
    }
    var all = await catalog.allActiveSkus();
    if (!Array.isArray(all)) {
      throw new TypeError("cycle-counting.worksheetFor: catalog.allActiveSkus() must return an array");
    }
    return all.slice();
  }

  // Read the expected quantity for (sku, location_code). Global path
  // hits catalog.inventory.get(sku); per-location path requires the
  // inventoryLocations dep and reads stockForSku.
  async function _expectedQty(sku, locationCode) {
    if (locationCode == null) {
      if (!catalog.inventory || typeof catalog.inventory.get !== "function") {
        throw new TypeError("cycle-counting: catalog.inventory.get(sku) is required " +
          "for counts without a location_code");
      }
      var inv = await catalog.inventory.get(sku);
      if (!inv) return 0;
      return Number(inv.stock_on_hand) || 0;
    }
    if (!inventoryLocations) {
      throw new TypeError("cycle-counting: count carries location_code " +
        JSON.stringify(locationCode) +
        " but opts.inventoryLocations was not wired into the factory");
    }
    var stock = await inventoryLocations.stockForSku(sku);
    var locs = (stock && stock.by_location) || [];
    for (var i = 0; i < locs.length; i += 1) {
      if (locs[i].code === locationCode) return Number(locs[i].quantity) || 0;
    }
    return 0;
  }

  // Optional unit-value read for the variance_value_minor aggregation.
  // Catalogs that don't expose unitValueMinor get a 0 fallback — the
  // variance count + per-line variance ints still carry the operator
  // signal; only the monetary roll-up collapses.
  async function _unitValueMinor(sku) {
    if (typeof catalog.unitValueMinor !== "function") return 0;
    var v = await catalog.unitValueMinor(sku);
    if (v == null) return 0;
    if (!Number.isInteger(v) || v < 0) {
      throw new TypeError("cycle-counting: catalog.unitValueMinor(" + JSON.stringify(sku) +
        ") must return a non-negative integer or null, got " + JSON.stringify(v));
    }
    return v;
  }

  return {

    // Exposed for tests + admin dashboards.
    KINDS:    KINDS,
    STATUSES: STATUSES,

    // Create a new scheduled count. The worksheet is NOT materialized
    // until worksheetFor is called — a count scheduled today for next
    // Monday captures the Monday-morning expected qty, not today's.
    defineCount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cycle-counting.defineCount: input object required");
      }
      _slug(input.slug);
      _kind(input.kind);
      var scope = _validateScope(input.kind, input.scope);
      _epochMs(input.scheduled_at, "scheduled_at");
      var locationCode = _codeOrNull(input.location_code, "location_code");

      // Refuse redefine. Operators that hit this should cancel the
      // prior count (cancelCount) or pick a new slug — silent
      // overwrite would clobber the variance numbers on a finalized
      // count and is never what the operator wants.
      var existing = await _getHeader(input.slug);
      if (existing) {
        throw new TypeError("cycle-counting.defineCount: slug " +
          JSON.stringify(input.slug) + " already exists (status " + existing.status +
          ") — cancel or pick a new slug");
      }

      var ts = _now();
      await query(
        "INSERT INTO cycle_counts (slug, kind, scope_json, scheduled_at, location_code, " +
        "status, variance_count, variance_value_minor, finalized_at, cancelled_at, " +
        "cancel_reason, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'scheduled', NULL, NULL, NULL, NULL, NULL, ?6)",
        [input.slug, input.kind, JSON.stringify(scope), input.scheduled_at, locationCode, ts],
      );
      return await _getHydrated(input.slug);
    },

    // Resolve the scope into an SKU list, persist one line per SKU
    // with the current expected qty, transition scheduled ->
    // in_progress. Idempotent: a second call after worksheet rows
    // already exist returns those rows untouched (the operator is
    // re-reading the worksheet, not re-deriving expected qtys).
    worksheetFor: async function (countSlug) {
      _slug(countSlug);
      var header = await _getHeader(countSlug);
      if (!header) {
        throw new TypeError("cycle-counting.worksheetFor: count " +
          JSON.stringify(countSlug) + " not found");
      }
      if (header.status === "cancelled" || header.status === "finalized") {
        throw new TypeError("cycle-counting.worksheetFor: count is " + header.status +
          ", worksheet only available for scheduled or in_progress counts");
      }
      var existingLines = await _getLines(countSlug);
      if (existingLines.length > 0) {
        // Idempotent: the worksheet has already been materialized.
        // Re-reading is a frequent operator move (the dashboard
        // refreshes); preserving the captured expected_quantity is
        // what we want.
        return existingLines;
      }
      var scope = JSON.parse(header.scope_json);
      var skus = await _resolveSkus(scope);
      if (skus.length === 0) {
        // Edge case: an abc count where no SKU carries that class,
        // or a fresh catalog with no active SKUs for a full count.
        // Persist no lines but still transition status — the operator
        // sees an empty worksheet and finalizes a zero-variance count.
        await query(
          "UPDATE cycle_counts SET status = 'in_progress' WHERE slug = ?1",
          [countSlug],
        );
        return [];
      }
      // De-duplicate the catalog-resolved SKU list. The operator's
      // scope.skus is already deduped at defineCount; the catalog
      // adapters are not contractually deduped, so we defend here.
      var seen = Object.create(null);
      var deduped = [];
      for (var d = 0; d < skus.length; d += 1) {
        _sku(skus[d]);
        if (seen[skus[d]]) continue;
        seen[skus[d]] = true;
        deduped.push(skus[d]);
      }
      for (var i = 0; i < deduped.length; i += 1) {
        var expected = await _expectedQty(deduped[i], header.location_code);
        await query(
          "INSERT INTO cycle_count_lines (id, count_slug, sku, location_code, " +
          "expected_quantity, actual_quantity, counted_by, counted_at, variance) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL)",
          [b.uuid.v7(), countSlug, deduped[i], header.location_code, expected],
        );
      }
      await query(
        "UPDATE cycle_counts SET status = 'in_progress' WHERE slug = ?1",
        [countSlug],
      );
      return await _getLines(countSlug);
    },

    // Record the operator-captured actual qty for one or more lines.
    // Refuses SKUs not on the worksheet — the operator must call
    // defineCount + worksheetFor before recording. Repeated calls for
    // the same SKU overwrite the prior actual_quantity (a recount).
    recordCount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cycle-counting.recordCount: input object required");
      }
      _slug(input.slug);
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new TypeError("cycle-counting.recordCount: lines must be a non-empty array");
      }
      if (input.lines.length > MAX_LINES) {
        throw new TypeError("cycle-counting.recordCount: lines must contain ≤ " + MAX_LINES + " entries");
      }
      var header = await _getHeader(input.slug);
      if (!header) {
        throw new TypeError("cycle-counting.recordCount: count " +
          JSON.stringify(input.slug) + " not found");
      }
      if (header.status !== "scheduled" && header.status !== "in_progress") {
        throw new TypeError("cycle-counting.recordCount: count is " + header.status +
          ", only scheduled or in_progress counts accept recordings");
      }
      // Validate every line up front so a partial write doesn't land
      // on a typo halfway through the batch.
      var normalized = [];
      var seen = Object.create(null);
      for (var i = 0; i < input.lines.length; i += 1) {
        var l = input.lines[i];
        if (!l || typeof l !== "object") {
          throw new TypeError("cycle-counting.recordCount: lines[" + i + "] must be an object");
        }
        _sku(l.sku);
        _nonNegInt(l.actual_quantity, "lines[" + i + "].actual_quantity");
        var lineLoc = _codeOrNull(l.location_code, "lines[" + i + "].location_code");
        var countedBy = _counter(l.counted_by);
        var key = l.sku + "\x00" + (lineLoc || "");
        if (seen[key]) {
          throw new TypeError("cycle-counting.recordCount: duplicate (sku, location_code) " +
            JSON.stringify({ sku: l.sku, location_code: lineLoc }) + " in lines");
        }
        seen[key] = true;
        normalized.push({
          sku:             l.sku,
          location_code:   lineLoc,
          actual_quantity: l.actual_quantity,
          counted_by:      countedBy,
        });
      }
      // Cross-check every recorded SKU is on the worksheet. The
      // worksheet is keyed by (count_slug, sku, location_code) — a
      // location-scoped count has location_code on every line; a
      // global count has location_code NULL on every line. The
      // operator passing a location_code that doesn't match the
      // header is a typo we surface up front.
      var lines = await _getLines(input.slug);
      var index = Object.create(null);
      for (var w = 0; w < lines.length; w += 1) {
        var keyW = lines[w].sku + "\x00" + (lines[w].location_code || "");
        index[keyW] = lines[w];
      }
      for (var r2 = 0; r2 < normalized.length; r2 += 1) {
        var keyR = normalized[r2].sku + "\x00" + (normalized[r2].location_code || "");
        if (!index[keyR]) {
          throw new TypeError("cycle-counting.recordCount: sku " +
            JSON.stringify(normalized[r2].sku) +
            (normalized[r2].location_code
              ? " at location " + JSON.stringify(normalized[r2].location_code)
              : "") +
            " is not on the worksheet for count " + JSON.stringify(input.slug) +
            " — call worksheetFor first");
        }
      }
      var ts = _now();
      for (var u = 0; u < normalized.length; u += 1) {
        var entry = normalized[u];
        var existing = index[entry.sku + "\x00" + (entry.location_code || "")];
        await query(
          "UPDATE cycle_count_lines SET actual_quantity = ?1, counted_by = ?2, " +
          "counted_at = ?3 WHERE id = ?4",
          [entry.actual_quantity, entry.counted_by, ts, existing.id],
        );
      }
      return await _getLines(input.slug);
    },

    // Compute per-line variance, aggregate to the header, optionally
    // write per-shelf adjustments via inventoryLocations.adjustStock.
    // Returns the aggregated numbers + adjustments_written count so
    // the caller doesn't re-read the header.
    finalizeCount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cycle-counting.finalizeCount: input object required");
      }
      _slug(input.slug);
      var applyAdjustments = false;
      if (input.apply_adjustments != null) {
        if (typeof input.apply_adjustments !== "boolean") {
          throw new TypeError("cycle-counting.finalizeCount: apply_adjustments must be a boolean");
        }
        applyAdjustments = input.apply_adjustments;
      }
      if (applyAdjustments && !inventoryLocations) {
        throw new TypeError("cycle-counting.finalizeCount: apply_adjustments=true requires " +
          "opts.inventoryLocations to be wired into the factory");
      }
      var header = await _getHeader(input.slug);
      if (!header) {
        throw new TypeError("cycle-counting.finalizeCount: count " +
          JSON.stringify(input.slug) + " not found");
      }
      if (header.status !== "scheduled" && header.status !== "in_progress") {
        throw new TypeError("cycle-counting.finalizeCount: count is " + header.status +
          ", only scheduled or in_progress counts can be finalized");
      }
      var lines = await _getLines(input.slug);
      var varianceCount = 0;
      var varianceValueMinor = 0;
      var adjustmentsWritten = 0;
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        // NULL actual_quantity = operator didn't count this line.
        // Treat as 0 — every expected unit is a discrepancy. This is
        // the same posture as stock-transfers receiving an empty
        // received_lines array: silent omission must surface loud.
        var actual = line.actual_quantity == null ? 0 : line.actual_quantity;
        var variance = actual - line.expected_quantity;
        await query(
          "UPDATE cycle_count_lines SET variance = ?1 WHERE id = ?2",
          [variance, line.id],
        );
        if (variance !== 0) {
          varianceCount += 1;
          var unitValue = await _unitValueMinor(line.sku);
          varianceValueMinor += Math.abs(variance) * unitValue;
          if (applyAdjustments) {
            // Adjustments only land on lines that carry a location_code.
            // A global count (no location_code on any line) computes
            // variance for the operator's reconciliation report but
            // does NOT write to inventory_locations — the operator's
            // catalog-side correction (catalog.inventory.restock /
            // release / setStock) is the right verb for the single-
            // bucket inventory.
            if (line.location_code) {
              await inventoryLocations.adjustStock({
                sku:           line.sku,
                location_code: line.location_code,
                delta:         variance,
                reason:        "cycle-count:" + input.slug,
              });
              adjustmentsWritten += 1;
            }
          }
        }
      }
      var ts = _now();
      await query(
        "UPDATE cycle_counts SET status = 'finalized', variance_count = ?1, " +
        "variance_value_minor = ?2, finalized_at = ?3 WHERE slug = ?4",
        [varianceCount, varianceValueMinor, ts, input.slug],
      );
      return {
        variance_count:       varianceCount,
        variance_value_minor: varianceValueMinor,
        adjustments_written:  adjustmentsWritten,
      };
    },

    // Abandon a non-terminal count. The header survives so any
    // dashboard read that captured the slug still resolves; the line
    // rows survive too (the FK is CASCADE on DELETE, not on
    // cancellation) so operators can read the partial recordings as
    // forensic data.
    cancelCount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cycle-counting.cancelCount: input object required");
      }
      _slug(input.slug);
      var reason = _reason(input.reason);
      if (!reason.length) {
        throw new TypeError("cycle-counting.cancelCount: reason must be a non-empty string");
      }
      var header = await _getHeader(input.slug);
      if (!header) {
        throw new TypeError("cycle-counting.cancelCount: count " +
          JSON.stringify(input.slug) + " not found");
      }
      if (header.status === "finalized" || header.status === "cancelled") {
        throw new TypeError("cycle-counting.cancelCount: count is " + header.status +
          ", terminal states cannot be cancelled");
      }
      var ts = _now();
      await query(
        "UPDATE cycle_counts SET status = 'cancelled', cancelled_at = ?1, " +
        "cancel_reason = ?2 WHERE slug = ?3",
        [ts, reason, input.slug],
      );
      return await _getHydrated(input.slug);
    },

    // Per-line variance report. Returns every line with non-zero
    // variance — the operator's reconciliation worksheet. Lines with
    // NULL variance (count not yet finalized) are filtered out.
    discrepanciesFor: async function (countSlug) {
      _slug(countSlug);
      var header = await _getHeader(countSlug);
      if (!header) return null;
      var r = await query(
        "SELECT * FROM cycle_count_lines WHERE count_slug = ?1 AND " +
        "variance IS NOT NULL AND variance != 0 ORDER BY sku ASC",
        [countSlug],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var ln = r.rows[i];
        out.push({
          sku:               ln.sku,
          location_code:     ln.location_code,
          expected_quantity: ln.expected_quantity,
          actual_quantity:   ln.actual_quantity,
          variance:          ln.variance,
        });
      }
      return out;
    },

    // List count headers, optionally narrowed by kind + a
    // scheduled_at date range. Ordered by scheduled_at DESC so the
    // operator's dashboard shows the freshest counts first.
    listCounts: async function (listOpts) {
      listOpts = listOpts || {};
      var wheres = [];
      var params = [];
      var p = 1;
      if (listOpts.kind != null) {
        _kind(listOpts.kind);
        wheres.push("kind = ?" + p);
        params.push(listOpts.kind);
        p += 1;
      }
      if (listOpts.from != null) {
        _epochMs(listOpts.from, "from");
        wheres.push("scheduled_at >= ?" + p);
        params.push(listOpts.from);
        p += 1;
      }
      if (listOpts.to != null) {
        _epochMs(listOpts.to, "to");
        wheres.push("scheduled_at <= ?" + p);
        params.push(listOpts.to);
        p += 1;
      }
      var whereClause = wheres.length ? "WHERE " + wheres.join(" AND ") + " " : "";
      var sql = "SELECT * FROM cycle_counts " + whereClause +
                "ORDER BY scheduled_at DESC, slug DESC";
      var r = await query(sql, params);
      var rows = r.rows;
      // Hydrate the scope payload for every header so admin
      // dashboards don't re-parse the JSON column on the client.
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].scope = JSON.parse(rows[i].scope_json);
      }
      return rows;
    },

    // Hydrated single read or null on miss.
    getCount: async function (slug) {
      _slug(slug);
      return await _getHydrated(slug);
    },

    // Keyset-paginated history of every cycle-count line that
    // touched a SKU. The operator dashboard's per-SKU drill-down
    // reads this — "show me every count that recorded WDG-1, with
    // the variance each time." Returns lines without filtering by
    // status: an unfinalized count's line shows up with variance=null,
    // which the dashboard renders as "in-progress count".
    historyForSku: async function (sku, listOpts) {
      _sku(sku);
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit);
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("cycle-counting.historyForSku: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(LINE_ORDER_KEY)) {
            throw new TypeError("cycle-counting.historyForSku: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("cycle-counting.historyForSku: cursor — " + (e && e.message || "malformed"));
        }
      }
      // Order by counted_at DESC NULLS LAST, id DESC. Lines that
      // haven't been counted yet (counted_at IS NULL) sort to the
      // back so the operator sees the most recent activity first.
      // SQLite sorts NULLs first by default; the IFNULL flip pushes
      // them to the back of a DESC sort.
      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM cycle_count_lines WHERE sku = ?1 AND " +
              "(IFNULL(counted_at, 0) < ?2 OR (IFNULL(counted_at, 0) = ?2 AND id < ?3)) " +
              "ORDER BY IFNULL(counted_at, 0) DESC, id DESC LIMIT ?4";
        params = [sku, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM cycle_count_lines WHERE sku = ?1 " +
              "ORDER BY IFNULL(counted_at, 0) DESC, id DESC LIMIT ?2";
        params = [sku, limit];
      }
      var r = await query(sql, params);
      var rows = r.rows;
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: LINE_ORDER_KEY,
          vals:     [last.counted_at == null ? 0 : last.counted_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },
  };
}

module.exports = {
  create:   create,
  KINDS:    KINDS,
  STATUSES: STATUSES,
};
