"use strict";
/**
 * @module shop.inventoryAudits
 * @title  Inventory audits — periodic full-inventory snapshot +
 *         reconciliation (year-end / quarter-end / spot)
 *
 * @intro
 *   Cycle counting (`cycleCounting`) runs on a rolling cadence — pick
 *   a subset of SKUs, walk a few shelves, write the variance, repeat.
 *   That model closes the steady-state drift but it does not produce
 *   the comprehensive "every SKU at every covered location, captured
 *   in a single window" snapshot that quarter-end and year-end
 *   reconciliation demands. Insurers want the latter. Auditors want
 *   the latter. The general ledger's closing entries want the latter.
 *
 *   This primitive owns that comprehensive audit: open one with
 *   `openAudit({ slug, kind, scope })`, record per-scan lines as the
 *   shelf is walked with `recordScanLine`, flag variance lines for a
 *   second pair of eyes with `markRecount`, then `finalizeAudit` to
 *   compute the per-line variance + roll-up totals onto the header.
 *   When `apply_adjustments` is true and an `inventoryLocations` dep
 *   is wired, finalize writes per-shelf adjustments through
 *   `inventoryLocations.adjustStock` so the audit trail on
 *   `inventory_adjustments` carries `reason = "inventory-audit:<slug>"`
 *   — operators reconstruct "which audit produced this write-off"
 *   from a single column.
 *
 *   Distinct from `cycleCounting`:
 *     - cycleCounting picks subsets on a cadence (rotating / abc /
 *       full-active-skus) for steady-state shrinkage detection.
 *     - inventoryAudits captures a single comprehensive window: every
 *       SKU at every covered location, scoped by category / vendor /
 *       location / all. Year-end + quarterly reconciliation drive the
 *       cadence; spot audits handle "the auditor wants the AC-VENDOR
 *       inventory recounted by tomorrow."
 *
 *   Lifecycle (four-state FSM):
 *
 *     openAudit({ slug, kind, scope, scheduled_at, location_codes? })
 *       Persists the header at status='open'. `kind` is full /
 *       quarterly / spot; `scope` is all / category / vendor /
 *       location; `location_codes` is an optional array of
 *       location_code values when the audit narrows to specific
 *       warehouses (required when scope === 'location'; allowed for
 *       any kind to constrain the walk).
 *
 *     recordScanLine({ audit_id, sku, location_code, counted_qty, counter_id })
 *       Records one scan. Captures `expected_qty` from
 *       `inventoryLocations.stockForSku(sku)` at scan time (per-
 *       location when location_code is set, otherwise sum across
 *       every location the snapshot covers). Re-scanning the same
 *       (sku, location_code) overwrites the prior counted_qty — the
 *       operator is correcting a typo, not appending a duplicate.
 *       Transitions open -> in_progress on first scan.
 *
 *     markRecount({ audit_id, sku, location_code, recount_qty, recount_by })
 *       For lines where the original count produced a variance worth
 *       a second-pair-of-eyes recount. Patches `recount_qty` +
 *       `recounted_by` + `recounted_at` on the scan row. The recount
 *       value (when present) wins over `counted_qty` at finalize time.
 *
 *     finalizeAudit({ audit_id, apply_adjustments? })
 *       in_progress -> finalized. Walks every scan line, computes
 *       `variance = effective_qty - expected_qty` where `effective_qty`
 *       is `recount_qty` when present, else `counted_qty`. Writes
 *       `variance` on every line. Aggregates `variance_count` (non-
 *       zero lines) and `variance_value_minor` (sum of |variance| *
 *       unit_value via the optional `costLayers` dep) onto the header.
 *       When apply_adjustments=true and inventoryLocations is wired,
 *       calls adjustStock for every non-zero variance with reason
 *       "inventory-audit:<slug>". Returns `{ variance_count,
 *       variance_value_minor, adjustments_written }`.
 *
 *     cancelAudit({ audit_id, reason })
 *       open|in_progress -> cancelled. Persists the reason +
 *       cancelled_at timestamp. Cancelling a finalized audit is
 *       refused — adjustments have already landed.
 *
 *   Reads:
 *     getAudit(audit_id)                       — hydrated header + lines
 *     listAudits({ kind?, status?, year? })    — operator dashboard listing
 *     variancesForAudit(audit_id)              — non-zero variance lines
 *     historyForSku(sku)                       — every audit touching a SKU
 *     compareToPriorAudit({ audit_id })        — delta vs. the previous
 *                                                finalized audit of the
 *                                                same kind
 *
 *   Composition:
 *     - b.uuid.v7              — audit + line row PKs (sortable)
 *     - b.guardUuid            — strict UUID validation on audit_id reads
 *     - inventoryLocations     — required at openAudit time so the per-
 *                                shelf expected_qty is captured at scan
 *                                time; required when finalizeAudit({
 *                                apply_adjustments: true }) is called so
 *                                the variance writes through adjustStock.
 *                                The factory accepts the handle as
 *                                optional so isolated tests can stub the
 *                                shape; runtime calls that need it but
 *                                find it missing throw at the call site.
 *     - inventorySnapshots (optional) — when wired, openAudit can pin
 *                                a snapshot label tying the audit to a
 *                                point-in-time capture. Not required —
 *                                the audit captures expected_qty at
 *                                scan time directly.
 *     - costLayers (optional)  — when wired, finalizeAudit asks for the
 *                                per-SKU unit cost so variance_value_minor
 *                                rolls up in minor currency units.
 *                                Without it, every line contributes 0 to
 *                                the value roll-up; the per-line variance
 *                                ints still carry the operator signal.
 *
 *   Three-tier input validation: every public verb here is either a
 *   config-time entry point (openAudit, cancelAudit) or a defensive
 *   request-shape reader (recordScanLine, markRecount, finalizeAudit,
 *   variancesForAudit, listAudits, historyForSku, compareToPriorAudit).
 *   Both shapes throw on bad input — no drop-silent hot-path sinks.
 *
 * @primitive inventoryAudits
 * @related    cycleCounting, inventorySnapshots, inventoryLocations,
 *             costLayers
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var SLUG_RE          = /^[a-z0-9][a-z0-9-]{0,79}$/;
var SKU_RE           = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CODE_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var COUNTER_RE       = /^[\S\s]{1,128}$/;
var KINDS            = Object.freeze(["full", "quarterly", "spot"]);
var SCOPES           = Object.freeze(["all", "category", "vendor", "location"]);
var STATUSES         = Object.freeze(["open", "in_progress", "finalized", "cancelled"]);
var MAX_REASON       = 280;
var MAX_LOCATIONS    = 256;
var MAX_LIST_LIMIT   = 200;

// ---- monotonic clock ----------------------------------------------------
//
// FSM transitions, scan recordings, and recount stamps all land on
// epoch-ms timestamps. Two scans against the same audit can arrive in
// the same millisecond from concurrent handheld scanners; strict-
// monotonic ordering guarantees `counted_at` is distinct row-by-row so
// a chronological dashboard sort returns events in the order they
// were issued.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("inventory-audits: slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + dash, 1..80 chars)");
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("inventory-audits: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("inventory-audits: " + (label || "location_code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _codeOrNull(s, label) {
  if (s == null) return null;
  _code(s, label);
  return s;
}
function _kind(s) {
  if (KINDS.indexOf(s) === -1) {
    throw new TypeError("inventory-audits: kind must be one of " + KINDS.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _scope(s) {
  if (SCOPES.indexOf(s) === -1) {
    throw new TypeError("inventory-audits: scope must be one of " + SCOPES.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _status(s) {
  if (STATUSES.indexOf(s) === -1) {
    throw new TypeError("inventory-audits: status must be one of " + STATUSES.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _auditId(s) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("inventory-audits: audit_id — " + (e && e.message || "invalid UUID")); }
}
function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-audits: " + label + " must be a non-negative integer (epoch ms)");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-audits: " + label + " must be a non-negative integer");
  }
}
function _counter(s, label) {
  if (s == null) return null;
  if (typeof s !== "string" || !COUNTER_RE.test(s) || s.length > 128) {
    throw new TypeError("inventory-audits: " + (label || "counter_id") + " must be a string ≤ 128 chars");
  }
  return s;
}
function _counterRequired(s, label) {
  if (typeof s !== "string" || !COUNTER_RE.test(s) || s.length > 128) {
    throw new TypeError("inventory-audits: " + (label || "counter_id") + " must be a non-empty string ≤ 128 chars");
  }
  return s;
}
function _reason(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_REASON) {
    throw new TypeError("inventory-audits: reason must be a string ≤ " + MAX_REASON + " chars");
  }
  return s;
}
function _year(n) {
  if (!Number.isInteger(n) || n < 1970 || n > 9999) {
    throw new TypeError("inventory-audits: year must be a four-digit integer in 1970..9999");
  }
}
function _locationCodes(arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) {
    throw new TypeError("inventory-audits: location_codes must be an array of codes");
  }
  if (arr.length === 0) {
    throw new TypeError("inventory-audits: location_codes, when supplied, must be a non-empty array");
  }
  if (arr.length > MAX_LOCATIONS) {
    throw new TypeError("inventory-audits: location_codes must contain ≤ " + MAX_LOCATIONS + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    _code(arr[i], "location_codes[" + i + "]");
    if (seen[arr[i]]) {
      throw new TypeError("inventory-audits: duplicate location_code " + JSON.stringify(arr[i]) +
        " in location_codes");
    }
    seen[arr[i]] = true;
    out.push(arr[i]);
  }
  return out;
}

// Year start/end epoch-ms (UTC). The dashboard's "show me Q4 2025 +
// the year-end full audit" query lands here — every audit with
// scheduled_at in [year-start, year-end] returns.
function _yearRange(year) {
  var fromIso = Date.UTC(year, 0, 1, 0, 0, 0, 0);
  var toIso   = Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1;
  return { from: fromIso, to: toIso };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  // inventoryLocations is optional at boot — runtime calls that need
  // it (recordScanLine for expected_qty capture, finalizeAudit with
  // apply_adjustments) throw at the call site if it's missing. The
  // factory still shape-checks when the handle is supplied so a typo
  // surfaces at boot rather than at first scan.
  var inventoryLocations = opts.inventoryLocations || null;
  if (inventoryLocations !== null) {
    if (typeof inventoryLocations !== "object"
      || typeof inventoryLocations.stockForSku !== "function") {
      throw new TypeError("inventory-audits.create: opts.inventoryLocations, when supplied, " +
        "must expose stockForSku(sku)");
    }
  }
  // inventorySnapshots is optional — the operator wires it when they
  // want the audit to pin a point-in-time snapshot label. Not used
  // for the variance math itself; reserved for downstream reporting.
  var inventorySnapshots = opts.inventorySnapshots || null;
  if (inventorySnapshots !== null && typeof inventorySnapshots !== "object") {
    throw new TypeError("inventory-audits.create: opts.inventorySnapshots, when supplied, must be an object");
  }
  // costLayers is optional — when wired, finalizeAudit asks for the
  // per-SKU unit cost so variance_value_minor rolls up in minor
  // currency units. Without it, every line contributes 0 to the value
  // roll-up; the per-line variance ints still carry the operator
  // signal.
  var costLayers = opts.costLayers || null;
  if (costLayers !== null && typeof costLayers !== "object") {
    throw new TypeError("inventory-audits.create: opts.costLayers, when supplied, must be an object");
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Read the audit header by id or null on miss.
  async function _getHeader(auditId) {
    var r = await query("SELECT * FROM inventory_audits WHERE id = ?1", [auditId]);
    return r.rows[0] || null;
  }

  // Read the audit header by slug or null on miss.
  async function _getHeaderBySlug(slug) {
    var r = await query("SELECT * FROM inventory_audits WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  // Read every line for an audit, ordered by SKU then location_code so
  // the operator-facing worksheet walks the shelf in a stable order.
  async function _getLines(auditId) {
    var r = await query(
      "SELECT * FROM inventory_audit_lines WHERE audit_id = ?1 " +
      "ORDER BY sku ASC, IFNULL(location_code, '') ASC",
      [auditId],
    );
    return r.rows;
  }

  // Hydrate a header + its lines + its parsed location_codes. Returns
  // null on miss so callers map cleanly to HTTP 404.
  async function _getHydrated(auditId) {
    var header = await _getHeader(auditId);
    if (!header) return null;
    header.location_codes = header.location_codes_json
      ? JSON.parse(header.location_codes_json)
      : null;
    header.lines = await _getLines(auditId);
    return header;
  }

  // Pull the expected_qty for (sku, location_code). Per-location reads
  // hit the matching by_location entry; whole-audit reads sum across
  // the audit's location_codes (or every location, when location_codes
  // is null).
  async function _expectedQty(sku, locationCode, auditLocationCodes) {
    if (!inventoryLocations) {
      throw new TypeError("inventory-audits: opts.inventoryLocations is required to capture " +
        "expected_qty at scan time");
    }
    var stock = await inventoryLocations.stockForSku(sku);
    var locs = (stock && stock.by_location) || [];
    if (locationCode != null) {
      for (var i = 0; i < locs.length; i += 1) {
        if (locs[i].code === locationCode) return Number(locs[i].quantity) || 0;
      }
      return 0;
    }
    // No location_code on the scan line → sum across the audit's
    // location set (or every location, when the audit has no
    // location_codes constraint).
    var total = 0;
    for (var j = 0; j < locs.length; j += 1) {
      if (auditLocationCodes && auditLocationCodes.indexOf(locs[j].code) === -1) continue;
      total += Number(locs[j].quantity) || 0;
    }
    return total;
  }

  // Optional unit-cost read for the variance_value_minor roll-up.
  // costLayers adapters that don't expose unitCostMinor get a 0
  // fallback — the variance count + per-line variance ints still
  // carry the operator signal; only the monetary roll-up collapses.
  async function _unitValueMinor(sku) {
    if (!costLayers || typeof costLayers.unitCostMinor !== "function") return 0;
    var v = await costLayers.unitCostMinor(sku);
    if (v == null) return 0;
    if (!Number.isInteger(v) || v < 0) {
      throw new TypeError("inventory-audits: costLayers.unitCostMinor(" + JSON.stringify(sku) +
        ") must return a non-negative integer or null, got " + JSON.stringify(v));
    }
    return v;
  }

  return {

    // Exposed for tests + admin dashboards.
    KINDS:    KINDS,
    SCOPES:   SCOPES,
    STATUSES: STATUSES,

    // Open a new audit. The header lands at status='open' with no
    // scan lines; the operator drives recordScanLine for each (sku,
    // location_code) pair as the shelf is walked.
    openAudit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-audits.openAudit: input object required");
      }
      _slug(input.slug);
      _kind(input.kind);
      _scope(input.scope);
      _epochMs(input.scheduled_at, "scheduled_at");
      var locationCodes = _locationCodes(input.location_codes);
      // scope === 'location' demands location_codes — the operator is
      // explicitly narrowing the audit to specific warehouses; an
      // empty narrow is a typo we surface up front rather than
      // silently expanding to every location.
      if (input.scope === "location" && (!locationCodes || locationCodes.length === 0)) {
        throw new TypeError("inventory-audits.openAudit: scope=location requires location_codes " +
          "(a non-empty array of location codes)");
      }
      // Refuse redefine. Operators that hit this should cancel the
      // prior audit (cancelAudit) or pick a new slug — silent
      // overwrite would clobber the variance numbers on a finalized
      // audit and is never what the operator wants.
      var existing = await _getHeaderBySlug(input.slug);
      if (existing) {
        throw new TypeError("inventory-audits.openAudit: slug " +
          JSON.stringify(input.slug) + " already exists (status " + existing.status +
          ") — cancel or pick a new slug");
      }
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO inventory_audits (id, slug, kind, scope, scheduled_at, status, " +
        "variance_count, variance_value_minor, finalized_at, cancelled_at, cancel_reason, " +
        "location_codes_json, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'open', NULL, NULL, NULL, NULL, NULL, ?6, ?7, ?7)",
        [
          id,
          input.slug,
          input.kind,
          input.scope,
          input.scheduled_at,
          locationCodes ? JSON.stringify(locationCodes) : null,
          ts,
        ],
      );
      return await _getHydrated(id);
    },

    // Record one scan. Captures expected_qty at scan time from the
    // wired inventoryLocations. Re-scanning the same (sku,
    // location_code) overwrites the prior counted_qty — the operator
    // is correcting a typo, not appending a duplicate. Transitions
    // open -> in_progress on first scan.
    recordScanLine: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-audits.recordScanLine: input object required");
      }
      var auditId = _auditId(input.audit_id);
      _sku(input.sku);
      var locationCode = _codeOrNull(input.location_code, "location_code");
      _nonNegInt(input.counted_qty, "counted_qty");
      var counterId = _counterRequired(input.counter_id, "counter_id");

      var header = await _getHeader(auditId);
      if (!header) {
        throw new TypeError("inventory-audits.recordScanLine: audit " +
          JSON.stringify(auditId) + " not found");
      }
      if (header.status !== "open" && header.status !== "in_progress") {
        throw new TypeError("inventory-audits.recordScanLine: audit is " + header.status +
          ", only open or in_progress audits accept scans");
      }
      var auditLocationCodes = header.location_codes_json
        ? JSON.parse(header.location_codes_json)
        : null;
      // When the audit narrows to a location set, a scan with a
      // location_code outside that set is a typo we surface up front.
      if (locationCode != null && auditLocationCodes
        && auditLocationCodes.indexOf(locationCode) === -1) {
        throw new TypeError("inventory-audits.recordScanLine: location_code " +
          JSON.stringify(locationCode) + " is not in this audit's location_codes " +
          JSON.stringify(auditLocationCodes));
      }
      var expectedQty = await _expectedQty(input.sku, locationCode, auditLocationCodes);
      var ts = _now();

      // Re-scan overwrites the prior row. The UNIQUE index on
      // (audit_id, sku, IFNULL(location_code, '')) enforces single-
      // row-per-key; we look up the existing row first so the audit
      // trail's counted_at reflects the latest scan.
      var existingRows = await query(
        "SELECT id FROM inventory_audit_lines WHERE audit_id = ?1 AND sku = ?2 AND " +
        "IFNULL(location_code, '') = ?3",
        [auditId, input.sku, locationCode || ""],
      );
      if (existingRows.rows.length > 0) {
        await query(
          "UPDATE inventory_audit_lines SET counted_qty = ?1, counted_by = ?2, " +
          "counted_at = ?3, expected_qty = ?4 WHERE id = ?5",
          [input.counted_qty, counterId, ts, expectedQty, existingRows.rows[0].id],
        );
      } else {
        await query(
          "INSERT INTO inventory_audit_lines (id, audit_id, sku, location_code, " +
          "expected_qty, counted_qty, recount_qty, recounted_by, recounted_at, " +
          "variance, counted_by, counted_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, NULL, ?7, ?8)",
          [b.uuid.v7(), auditId, input.sku, locationCode, expectedQty, input.counted_qty, counterId, ts],
        );
      }
      if (header.status === "open") {
        await query(
          "UPDATE inventory_audits SET status = 'in_progress', updated_at = ?1 WHERE id = ?2",
          [ts, auditId],
        );
      } else {
        await query(
          "UPDATE inventory_audits SET updated_at = ?1 WHERE id = ?2",
          [ts, auditId],
        );
      }
      return await _getHydrated(auditId);
    },

    // Patch a recount on an existing scan row. The recount value (when
    // present) wins over `counted_qty` at finalize time. Refuses lines
    // that don't already exist — the operator must recordScanLine
    // first; markRecount only overrides an existing scan.
    markRecount: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-audits.markRecount: input object required");
      }
      var auditId = _auditId(input.audit_id);
      _sku(input.sku);
      var locationCode = _codeOrNull(input.location_code, "location_code");
      _nonNegInt(input.recount_qty, "recount_qty");
      var recountBy = _counterRequired(input.recount_by, "recount_by");

      var header = await _getHeader(auditId);
      if (!header) {
        throw new TypeError("inventory-audits.markRecount: audit " +
          JSON.stringify(auditId) + " not found");
      }
      if (header.status !== "open" && header.status !== "in_progress") {
        throw new TypeError("inventory-audits.markRecount: audit is " + header.status +
          ", only open or in_progress audits accept recounts");
      }
      var existingRows = await query(
        "SELECT id FROM inventory_audit_lines WHERE audit_id = ?1 AND sku = ?2 AND " +
        "IFNULL(location_code, '') = ?3",
        [auditId, input.sku, locationCode || ""],
      );
      if (existingRows.rows.length === 0) {
        throw new TypeError("inventory-audits.markRecount: no scan line for sku " +
          JSON.stringify(input.sku) +
          (locationCode ? " at location " + JSON.stringify(locationCode) : "") +
          " on audit " + JSON.stringify(auditId) + " — call recordScanLine first");
      }
      var ts = _now();
      await query(
        "UPDATE inventory_audit_lines SET recount_qty = ?1, recounted_by = ?2, " +
        "recounted_at = ?3 WHERE id = ?4",
        [input.recount_qty, recountBy, ts, existingRows.rows[0].id],
      );
      await query(
        "UPDATE inventory_audits SET updated_at = ?1 WHERE id = ?2",
        [ts, auditId],
      );
      return await _getHydrated(auditId);
    },

    // Compute per-line variance, aggregate to the header, optionally
    // write per-shelf adjustments via inventoryLocations.adjustStock.
    // Returns the aggregated numbers + adjustments_written count so
    // the caller doesn't re-read the header.
    finalizeAudit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-audits.finalizeAudit: input object required");
      }
      var auditId = _auditId(input.audit_id);
      var applyAdjustments = false;
      if (input.apply_adjustments != null) {
        if (typeof input.apply_adjustments !== "boolean") {
          throw new TypeError("inventory-audits.finalizeAudit: apply_adjustments must be a boolean");
        }
        applyAdjustments = input.apply_adjustments;
      }
      if (applyAdjustments && !inventoryLocations) {
        throw new TypeError("inventory-audits.finalizeAudit: apply_adjustments=true requires " +
          "opts.inventoryLocations to be wired into the factory");
      }
      if (applyAdjustments && typeof inventoryLocations.adjustStock !== "function") {
        throw new TypeError("inventory-audits.finalizeAudit: apply_adjustments=true requires " +
          "opts.inventoryLocations.adjustStock(input)");
      }
      var header = await _getHeader(auditId);
      if (!header) {
        throw new TypeError("inventory-audits.finalizeAudit: audit " +
          JSON.stringify(auditId) + " not found");
      }
      if (header.status !== "open" && header.status !== "in_progress") {
        throw new TypeError("inventory-audits.finalizeAudit: audit is " + header.status +
          ", only open or in_progress audits can be finalized");
      }
      var lines = await _getLines(auditId);
      // PASS 1 — compute each line's variance, persist it (idempotent),
      // and collect the shelf adjustments to apply. No shelf is touched
      // yet: the atomic claim below decides who, if anyone, applies them.
      var varianceCount = 0;
      var varianceValueMinor = 0;
      var adjustable = [];
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        // recount_qty wins when present; else counted_qty drives.
        var effective = line.recount_qty != null ? line.recount_qty : line.counted_qty;
        var variance = effective - line.expected_qty;
        await query(
          "UPDATE inventory_audit_lines SET variance = ?1 WHERE id = ?2",
          [variance, line.id],
        );
        if (variance !== 0) {
          varianceCount += 1;
          var unitValue = await _unitValueMinor(line.sku);
          varianceValueMinor += Math.abs(variance) * unitValue;
          // Adjustments only land on lines that carry a location_code. A
          // whole-audit-summed line (no location_code) computes variance
          // for the operator's reconciliation report but does NOT write
          // to inventory_locations — the catalog-side correction is the
          // right verb for the single-bucket inventory.
          if (applyAdjustments && line.location_code) {
            adjustable.push({ sku: line.sku, location_code: line.location_code, variance: variance });
          }
        }
      }

      var ts = _now();
      // ATOMIC CLAIM — advance the audit out of open/in_progress in a
      // single statement BEFORE any shelf moves. On the D1 bridge there
      // are no interactive transactions, so this UPDATE is the
      // serialization point: two concurrent finalizeAudit calls both
      // reach here, but only one matches a row. The loser changes zero
      // rows, applies NOTHING, and returns the deterministic totals — so
      // a shelf can never be double-adjusted by overlapping finalizes.
      // The flip also freezes the scan lines (recordScanLine / markRecount
      // refuse on a finalized audit), so the variances we're about to
      // apply can't shift underfoot.
      var claim = await query(
        "UPDATE inventory_audits SET status = 'finalized', variance_count = ?1, " +
        "variance_value_minor = ?2, finalized_at = ?3, updated_at = ?3 " +
        "WHERE id = ?4 AND status IN ('open', 'in_progress')",
        [varianceCount, varianceValueMinor, ts, auditId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        // Lost the claim — a concurrent (or prior) finalize already
        // advanced this audit and owns the adjustment writes. Touch no
        // shelves; return the totals computed from the now-frozen lines.
        return {
          variance_count:       varianceCount,
          variance_value_minor: varianceValueMinor,
          adjustments_written:  adjustable.length,
        };
      }

      // PASS 2 (winner only) — apply each shelf adjustment, reconciling
      // against what already landed under this audit's reason. The audit's
      // slug is unique and (audit_id, sku, location_code) is UNIQUE, so
      // every inventory_adjustments row under (sku, location_code, reason)
      // belongs to this one logical adjustment; their summed delta is what
      // the shelf has already moved. Applying only `variance - applied`
      // makes a retry land exactly the remaining delta and never a double,
      // and self-corrects if a recount changed the variance before the
      // retry. The common abort is a respect_holds floor refusal on a
      // negative variance; the catch re-opens the audit so the operator
      // can clear the blocker and retry.
      var adjustmentsWritten = 0;
      var adjReason = "inventory-audit:" + header.slug;
      try {
        for (var j = 0; j < adjustable.length; j += 1) {
          var adj = adjustable[j];
          var appliedRow = await query(
            "SELECT COALESCE(SUM(delta), 0) AS applied FROM inventory_adjustments " +
            "WHERE sku = ?1 AND location_code = ?2 AND reason = ?3",
            [adj.sku, adj.location_code, adjReason],
          );
          var alreadyApplied = Number((appliedRow.rows[0] || {}).applied || 0);
          var needed = adj.variance - alreadyApplied;
          if (needed !== 0) {
            await inventoryLocations.adjustStock({
              sku:           adj.sku,
              location_code: adj.location_code,
              delta:         needed,
              reason:        adjReason,
              // A negative variance shrinks the shelf — guard it from
              // dropping below the outstanding paid holds for the SKU so a
              // later commitHold can't be stranded. Positive variances
              // (credits) ignore the flag.
              respect_holds: true,
            });
          }
          adjustmentsWritten += 1;
        }
      } catch (applyErr) {
        // Re-open the audit so the operator can clear the blocker and
        // retry. The reconciling apply above guarantees the retry lands
        // only the remaining delta, so nothing double-counts.
        await query(
          "UPDATE inventory_audits SET status = 'in_progress', finalized_at = NULL, " +
          "updated_at = ?1 WHERE id = ?2 AND status = 'finalized'",
          [_now(), auditId],
        );
        throw applyErr;
      }

      return {
        variance_count:       varianceCount,
        variance_value_minor: varianceValueMinor,
        adjustments_written:  adjustmentsWritten,
      };
    },

    // Abandon a non-terminal audit. The header survives so any
    // dashboard read that captured the id still resolves; the line
    // rows survive too (the FK is CASCADE on DELETE, not on
    // cancellation) so operators can read the partial recordings as
    // forensic data.
    cancelAudit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-audits.cancelAudit: input object required");
      }
      var auditId = _auditId(input.audit_id);
      var reason = _reason(input.reason);
      if (!reason.length) {
        throw new TypeError("inventory-audits.cancelAudit: reason must be a non-empty string");
      }
      var header = await _getHeader(auditId);
      if (!header) {
        throw new TypeError("inventory-audits.cancelAudit: audit " +
          JSON.stringify(auditId) + " not found");
      }
      if (header.status === "finalized" || header.status === "cancelled") {
        throw new TypeError("inventory-audits.cancelAudit: audit is " + header.status +
          ", terminal states cannot be cancelled");
      }
      var ts = _now();
      await query(
        "UPDATE inventory_audits SET status = 'cancelled', cancelled_at = ?1, " +
        "cancel_reason = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, reason, auditId],
      );
      return await _getHydrated(auditId);
    },

    // Hydrated single read or null on miss.
    getAudit: async function (auditId) {
      var id = _auditId(auditId);
      return await _getHydrated(id);
    },

    // List audit headers, optionally narrowed by kind / status / year.
    // year filters by scheduled_at within the UTC year boundaries.
    // Ordered by scheduled_at DESC so the operator's dashboard shows
    // the freshest audits first.
    listAudits: async function (listOpts) {
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
      if (listOpts.status != null) {
        _status(listOpts.status);
        wheres.push("status = ?" + p);
        params.push(listOpts.status);
        p += 1;
      }
      if (listOpts.year != null) {
        _year(listOpts.year);
        var range = _yearRange(listOpts.year);
        wheres.push("scheduled_at >= ?" + p);
        params.push(range.from);
        p += 1;
        wheres.push("scheduled_at <= ?" + p);
        params.push(range.to);
        p += 1;
      }
      var whereClause = wheres.length ? "WHERE " + wheres.join(" AND ") + " " : "";
      var sql = "SELECT * FROM inventory_audits " + whereClause +
                "ORDER BY scheduled_at DESC, slug DESC LIMIT " + MAX_LIST_LIMIT;
      var r = await query(sql, params);
      var rows = r.rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].location_codes = rows[i].location_codes_json
          ? JSON.parse(rows[i].location_codes_json)
          : null;
      }
      return rows;
    },

    // Per-line variance report. Returns every line with non-zero
    // variance — the operator's reconciliation worksheet. Lines with
    // NULL variance (audit not yet finalized) are filtered out.
    variancesForAudit: async function (auditId) {
      var id = _auditId(auditId);
      var header = await _getHeader(id);
      if (!header) return null;
      var r = await query(
        "SELECT * FROM inventory_audit_lines WHERE audit_id = ?1 AND " +
        "variance IS NOT NULL AND variance != 0 ORDER BY sku ASC, IFNULL(location_code, '') ASC",
        [id],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var ln = r.rows[i];
        out.push({
          sku:           ln.sku,
          location_code: ln.location_code,
          expected_qty:  ln.expected_qty,
          counted_qty:   ln.counted_qty,
          recount_qty:   ln.recount_qty,
          variance:      ln.variance,
        });
      }
      return out;
    },

    // Every audit line that touched the SKU, ordered by counted_at
    // DESC so the operator dashboard's per-SKU drill-down shows the
    // most recent audit activity first.
    historyForSku: async function (sku) {
      _sku(sku);
      var r = await query(
        "SELECT l.*, a.slug AS audit_slug, a.kind AS audit_kind, a.status AS audit_status, " +
        "a.scheduled_at AS audit_scheduled_at, a.finalized_at AS audit_finalized_at " +
        "FROM inventory_audit_lines l JOIN inventory_audits a ON a.id = l.audit_id " +
        "WHERE l.sku = ?1 ORDER BY l.counted_at DESC, l.id DESC LIMIT " + MAX_LIST_LIMIT,
        [sku],
      );
      return r.rows;
    },

    // Compare a finalized audit to the prior finalized audit of the
    // same kind. Returns per-SKU/location deltas (variance trend) so
    // the operator dashboard surfaces "WDG-1 was short 3 in Q3 + short
    // 5 in Q4 — a worsening trend." Returns null when the audit isn't
    // finalized or no prior finalized audit of the same kind exists.
    compareToPriorAudit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-audits.compareToPriorAudit: input object required");
      }
      var auditId = _auditId(input.audit_id);
      var header = await _getHeader(auditId);
      if (!header) {
        throw new TypeError("inventory-audits.compareToPriorAudit: audit " +
          JSON.stringify(auditId) + " not found");
      }
      if (header.status !== "finalized") {
        throw new TypeError("inventory-audits.compareToPriorAudit: audit is " + header.status +
          ", compareToPriorAudit only works on finalized audits");
      }
      // Pick the previous finalized audit of the same kind by
      // scheduled_at. Ties broken by created_at DESC so a same-day
      // re-audit picks the older one as "prior."
      var priorRes = await query(
        "SELECT * FROM inventory_audits WHERE kind = ?1 AND status = 'finalized' " +
        "AND id != ?2 AND (scheduled_at < ?3 OR (scheduled_at = ?3 AND created_at < ?4)) " +
        "ORDER BY scheduled_at DESC, created_at DESC LIMIT 1",
        [header.kind, auditId, header.scheduled_at, header.created_at],
      );
      var prior = priorRes.rows[0];
      if (!prior) {
        return {
          current_audit_id: auditId,
          prior_audit_id:   null,
          deltas:           [],
        };
      }
      var currentLines = await _getLines(auditId);
      var priorLines   = await _getLines(prior.id);
      var byKey = Object.create(null);
      function _key(l) { return l.sku + "\x00" + (l.location_code || ""); }
      for (var i = 0; i < priorLines.length; i += 1) {
        byKey[_key(priorLines[i])] = { prior: priorLines[i], current: null };
      }
      for (var j = 0; j < currentLines.length; j += 1) {
        var k = _key(currentLines[j]);
        if (byKey[k]) byKey[k].current = currentLines[j];
        else byKey[k] = { prior: null, current: currentLines[j] };
      }
      var deltas = [];
      var keys = Object.keys(byKey).sort();
      for (var x = 0; x < keys.length; x += 1) {
        var pair = byKey[keys[x]];
        var priorVar = pair.prior   && pair.prior.variance   != null ? pair.prior.variance   : 0;
        var curVar   = pair.current && pair.current.variance != null ? pair.current.variance : 0;
        var ref = pair.current || pair.prior;
        if (priorVar === 0 && curVar === 0) continue;
        deltas.push({
          sku:               ref.sku,
          location_code:     ref.location_code,
          prior_variance:    priorVar,
          current_variance:  curVar,
          delta:             curVar - priorVar,
        });
      }
      return {
        current_audit_id: auditId,
        prior_audit_id:   prior.id,
        deltas:           deltas,
      };
    },
  };
}

module.exports = {
  create:   create,
  KINDS:    KINDS,
  SCOPES:   SCOPES,
  STATUSES: STATUSES,
};
