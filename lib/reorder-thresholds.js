"use strict";
/**
 * @module shop.reorderThresholds
 * @title  Reorder thresholds — automated PO suggestions from velocity + lead time
 *
 * @intro
 *   `inventoryAlerts` (the sibling primitive) answers "tell me when
 *   stock crosses a line". This primitive answers a different
 *   question: "given that stock has crossed the line, how much
 *   should the operator actually order, from which supplier, and
 *   what's the runway before the shelf goes empty?" The answer
 *   composes three inputs:
 *
 *     1. Current stock — read from `inventory_stock` (the multi-
 *        location table from migration 0034) when the threshold
 *        carries a `location_code`, otherwise from the catalog
 *        `inventory.stock_on_hand` single bucket.
 *     2. Recent velocity — rows in `sku_velocity` are the operator's
 *        append-only log of "units sold in period". `evaluate`
 *        derives a units/day rolling average from rows whose
 *        `period_end` lands inside the last `VELOCITY_WINDOW_DAYS`
 *        days. Operators that don't supply velocity rows get
 *        `velocity = 0` — `suggested_qty` collapses to the bare
 *        gap (reorder_to - current) and `days_of_supply` reports
 *        `null`.
 *     3. Lead time — `lead_time_days` is the operator's promise
 *        of how long the supplier needs between PO and receive.
 *        The suggested quantity adds `lead_time_days * velocity`
 *        to the gap so the operator doesn't restock to the
 *        threshold then immediately cross it again while the
 *        truck is in transit.
 *
 *   Verbs:
 *     defineThreshold        — register a (sku, location_code?)
 *                              reorder rule. The partial-UNIQUE
 *                              indexes on the active row set
 *                              refuse duplicate (sku, location)
 *                              pairs with a descriptive error
 *                              up front. `location_code: null`
 *                              (or omitted) is the global rule
 *                              for the SKU and is enforced by
 *                              its own partial UNIQUE.
 *     updateThreshold        — patch any of min_stock /
 *                              reorder_to / lead_time_days /
 *                              vendor_slug. Refuses to drive
 *                              reorder_to below min_stock — the
 *                              CHECK constraint backstops, but
 *                              the primitive surfaces a typed
 *                              error first so the operator
 *                              doesn't see a raw SQLITE_CONSTRAINT.
 *     archiveThreshold       — soft-delete. Frees the (sku,
 *                              location) slot for re-definition;
 *                              the row stays in the table so any
 *                              draft PO that captured the id
 *                              still resolves.
 *     listThresholds         — operator dashboard read. Filters
 *                              by vendor_slug + location_code +
 *                              include_archived.
 *     evaluate               — pure SELECT-only computation: pulls
 *                              the threshold row, the current
 *                              stock, the windowed velocity, and
 *                              returns { current_stock, min_stock,
 *                              should_reorder, suggested_qty,
 *                              days_of_supply, lead_time_days }.
 *     scanAll                — every active threshold at-or-
 *                              below its min_stock floor. Optional
 *                              `vendor_slug` / `location_code` /
 *                              `limit` narrowing for the admin
 *                              "reorder queue" view.
 *     proposePurchaseOrder   — aggregates `scanAll` rows whose
 *                              vendor_slug matches into a draft
 *                              PO payload: vendor_slug, total
 *                              line count, total suggested qty,
 *                              and the per-line breakdown. The
 *                              primitive does NOT persist a PO —
 *                              the operator's procurement pipeline
 *                              takes the draft and submits it to
 *                              the supplier via whatever channel
 *                              (email, EDI, supplier portal) they
 *                              use.
 *     recordVelocity         — append a `sku_velocity` row. The
 *                              operator's order-completion hook
 *                              (or a nightly aggregation) writes
 *                              these; `evaluate` consumes them.
 *
 *   Composition:
 *     - b.uuid.v7              — id columns on both tables
 *     - catalog.inventory.get  — fallback stock read when the
 *                                threshold has no location_code
 *     - inventoryLocations     — optional dep; required only when
 *                                a threshold carries a location_code
 *                                so the primitive can read the
 *                                per-location quantity. Tests can
 *                                pass `null` for inventoryLocations
 *                                when every threshold is global.
 *     - vendors                — held only for shape validation of
 *                                `vendor_slug` references in
 *                                `proposePurchaseOrder`; the slug
 *                                is otherwise opaque (no FK so
 *                                archived vendors still surface in
 *                                listThresholds).
 *
 *   Three-tier input validation: every public verb here is either a
 *   config-time entry point (defineThreshold, updateThreshold,
 *   archiveThreshold) or a defensive request-shape reader (evaluate,
 *   scanAll, proposePurchaseOrder, listThresholds, recordVelocity).
 *   Both shapes throw on bad input — there are no drop-silent hot-
 *   path sinks here.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var SKU_RE              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CODE_RE             = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SLUG_RE             = /^[a-z0-9][a-z0-9-]{0,63}$/;
var ID_RE               = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var DAY_MS              = 24 * 60 * 60 * 1000;
var VELOCITY_WINDOW_DAYS = 30;
var MAX_LIMIT           = 500;
var MAX_LEAD_TIME_DAYS  = 3650;   // 10 years — high enough to cover any real-world supplier promise; low enough to refuse a Number.MAX_SAFE_INTEGER typo
var MAX_STOCK           = 1000000000; // a billion units — same envelope as the catalog inventory bucket

// ---- validators ---------------------------------------------------------

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("reorder-thresholds: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}

function _locationCodeOrNull(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("reorder-thresholds: location_code must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars), or be null");
  }
  return s;
}

function _vendorSlugOrNull(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("reorder-thresholds: vendor_slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + dash, 1..64 chars), or be null");
  }
  return s;
}

function _vendorSlugRequired(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("reorder-thresholds: vendor_slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + dash, 1..64 chars)");
  }
  return s;
}

function _stockInt(n, label) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) {
    throw new TypeError("reorder-thresholds: " + label + " must be a non-negative integer ≤ " + MAX_STOCK);
  }
}

function _leadTimeDays(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEAD_TIME_DAYS) {
    throw new TypeError("reorder-thresholds: lead_time_days must be a non-negative integer ≤ " + MAX_LEAD_TIME_DAYS);
  }
}

function _unitsSold(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) {
    throw new TypeError("reorder-thresholds: units_sold must be a non-negative integer ≤ " + MAX_STOCK);
  }
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("reorder-thresholds: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _id(s, label) {
  if (typeof s !== "string" || !ID_RE.test(s)) {
    throw new TypeError("reorder-thresholds: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}

function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("reorder-thresholds: limit must be an integer in 1.." + MAX_LIMIT);
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog || typeof opts.catalog !== "object") {
    throw new TypeError("reorder-thresholds.create: opts.catalog is required");
  }
  // inventoryLocations is optional — only required when at least one
  // threshold carries a location_code. The runtime check inside
  // `_currentStock` surfaces a descriptive error if the operator
  // defines a per-location threshold without wiring the dep.
  var inventoryLocations = opts.inventoryLocations || null;
  if (inventoryLocations !== null && typeof inventoryLocations !== "object") {
    throw new TypeError("reorder-thresholds.create: opts.inventoryLocations must be an object or null");
  }
  // vendors is optional and held purely as a wiring marker; the
  // primitive never reads from it. Operators that want strict-FK
  // validation against the vendors table can compose the check at
  // the caller.
  var vendors = opts.vendors || null;
  if (vendors !== null && typeof vendors !== "object") {
    throw new TypeError("reorder-thresholds.create: opts.vendors must be an object or null");
  }
  var catalog = opts.catalog;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  function _shapeThreshold(row) {
    if (!row) return null;
    return {
      id:              row.id,
      sku:             row.sku,
      location_code:   row.location_code,
      min_stock:       row.min_stock,
      reorder_to:      row.reorder_to,
      lead_time_days:  row.lead_time_days,
      vendor_slug:     row.vendor_slug,
      archived_at:     row.archived_at,
      created_at:      row.created_at,
      updated_at:      row.updated_at,
    };
  }

  // Pull the active threshold row for a (sku, location) pair. When
  // `location_code` is null, the SQL pulls the global row; when set,
  // the per-location row.
  async function _getActiveThreshold(sku, locationCode) {
    var sql;
    var params;
    if (locationCode == null) {
      sql = "SELECT * FROM reorder_thresholds " +
            "WHERE sku = ?1 AND location_code IS NULL AND archived_at IS NULL LIMIT 1";
      params = [sku];
    } else {
      sql = "SELECT * FROM reorder_thresholds " +
            "WHERE sku = ?1 AND location_code = ?2 AND archived_at IS NULL LIMIT 1";
      params = [sku, locationCode];
    }
    var r = await query(sql, params);
    return r.rows[0] || null;
  }

  async function _getThresholdById(id) {
    var r = await query("SELECT * FROM reorder_thresholds WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // Read the current stock for (sku, location_code). The location_code
  // path requires the inventoryLocations dep; the global path reads
  // catalog inventory's stock_on_hand.
  async function _currentStock(sku, locationCode) {
    if (locationCode == null) {
      // Catalog inventory single bucket. `catalog.inventory.get(sku)`
      // returns null on miss — treat that as zero stock.
      var inv = await catalog.inventory.get(sku);
      if (!inv) return 0;
      // The catalog primitive surfaces `stock_on_hand` directly.
      return Number(inv.stock_on_hand) || 0;
    }
    if (!inventoryLocations) {
      throw new TypeError("reorder-thresholds: threshold for sku " +
        JSON.stringify(sku) + " carries location_code " +
        JSON.stringify(locationCode) +
        " but opts.inventoryLocations was not wired into the factory");
    }
    // The locations primitive exposes `stockForSku(sku)` returning
    // `{ total, by_location: [...] }`. Find the matching location.
    var stock = await inventoryLocations.stockForSku(sku);
    var locs = stock.by_location || [];
    for (var i = 0; i < locs.length; i += 1) {
      if (locs[i].code === locationCode) return Number(locs[i].quantity) || 0;
    }
    return 0;
  }

  // Sum velocity rows whose `period_end` falls inside the last
  // VELOCITY_WINDOW_DAYS days. Returns `{ units, days }` where
  // `days` is the elapsed span between the earliest matching
  // period_start and `asOf` — bounded below at 1 so the divisor
  // never goes to zero. When no rows match, returns
  // `{ units: 0, days: 0 }` and the caller treats velocity as
  // unknown (suggested_qty collapses to the bare gap).
  async function _windowedVelocity(sku, locationCode, asOf) {
    var since = asOf - VELOCITY_WINDOW_DAYS * DAY_MS;
    var sql;
    var params;
    if (locationCode == null) {
      // Global rows only — the primitive intentionally does NOT
      // sum per-location velocity into the global computation,
      // because that would double-count when both global and
      // per-location operators write rows.
      sql = "SELECT period_start, period_end, units_sold FROM sku_velocity " +
            "WHERE sku = ?1 AND location_code IS NULL AND period_end >= ?2";
      params = [sku, since];
    } else {
      sql = "SELECT period_start, period_end, units_sold FROM sku_velocity " +
            "WHERE sku = ?1 AND location_code = ?2 AND period_end >= ?3";
      params = [sku, locationCode, since];
    }
    var r = await query(sql, params);
    if (!r.rows.length) return { units: 0, days: 0 };
    var units = 0;
    var earliest = Infinity;
    var latest = -Infinity;
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      units += Number(row.units_sold) || 0;
      if (row.period_start < earliest) earliest = row.period_start;
      if (row.period_end > latest) latest = row.period_end;
    }
    var spanMs = Math.max(latest - earliest, 0);
    var days = Math.max(Math.round(spanMs / DAY_MS), 1);
    return { units: units, days: days };
  }

  // The core computation: given a threshold row + current stock +
  // windowed velocity, derive the evaluate() result.
  function _computeEvaluation(threshold, currentStock, velocity) {
    var unitsPerDay = velocity.days > 0 ? velocity.units / velocity.days : 0;
    var shouldReorder = currentStock <= threshold.min_stock;
    var leadTimeBuffer = Math.ceil(unitsPerDay * threshold.lead_time_days);
    var gap = Math.max(threshold.reorder_to - currentStock, 0);
    var suggestedQty = shouldReorder ? gap + leadTimeBuffer : 0;
    var daysOfSupply;
    if (unitsPerDay > 0) {
      daysOfSupply = Math.floor(currentStock / unitsPerDay);
    } else {
      daysOfSupply = null;
    }
    return {
      current_stock:    currentStock,
      min_stock:        threshold.min_stock,
      should_reorder:   shouldReorder,
      suggested_qty:    suggestedQty,
      days_of_supply:   daysOfSupply,
      lead_time_days:   threshold.lead_time_days,
    };
  }

  return {

    // Constants surfaced for tests + admin dashboards that want to
    // render "velocity computed over the last N days".
    VELOCITY_WINDOW_DAYS: VELOCITY_WINDOW_DAYS,

    // Register a reorder threshold. (sku, location_code) is unique
    // among active rows — the partial-UNIQUE indexes in the
    // migration enforce that. The primitive checks the duplicate up
    // front so the caller sees a typed error instead of a raw
    // SQLITE_CONSTRAINT.
    defineThreshold: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-thresholds.defineThreshold: input object required");
      }
      _sku(input.sku);
      var locationCode = _locationCodeOrNull(input.location_code);
      _stockInt(input.min_stock, "min_stock");
      _stockInt(input.reorder_to, "reorder_to");
      if (input.reorder_to < input.min_stock) {
        throw new TypeError("reorder-thresholds.defineThreshold: reorder_to (" +
          input.reorder_to + ") must be ≥ min_stock (" + input.min_stock + ")");
      }
      _leadTimeDays(input.lead_time_days);
      var vendorSlug = _vendorSlugOrNull(input.vendor_slug);

      var existing = await _getActiveThreshold(input.sku, locationCode);
      if (existing) {
        throw new TypeError("reorder-thresholds.defineThreshold: an active threshold for sku " +
          JSON.stringify(input.sku) + " location_code " +
          JSON.stringify(locationCode) + " already exists (id " + existing.id +
          ") — patch via updateThreshold or archive it first");
      }

      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO reorder_thresholds (id, sku, location_code, min_stock, reorder_to, " +
        "lead_time_days, vendor_slug, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
        [id, input.sku, locationCode, input.min_stock, input.reorder_to,
         input.lead_time_days, vendorSlug, ts],
      );
      return _shapeThreshold(await _getThresholdById(id));
    },

    // Patch a subset of mutable fields. `sku`, `location_code`,
    // `created_at` are immutable; operators that need to change
    // those archive the row and define a fresh one. Refuses any
    // patch that would drive reorder_to below min_stock so the
    // CHECK constraint never has to.
    updateThreshold: async function (id, patch) {
      _id(id, "threshold_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("reorder-thresholds.updateThreshold: patch object required");
      }
      var existing = await _getThresholdById(id);
      if (!existing) {
        throw new TypeError("reorder-thresholds.updateThreshold: id " +
          JSON.stringify(id) + " not found");
      }
      if (existing.archived_at != null) {
        throw new TypeError("reorder-thresholds.updateThreshold: id " +
          JSON.stringify(id) + " is archived — define a fresh threshold instead of patching the archived row");
      }
      var nextMin = existing.min_stock;
      var nextReorderTo = existing.reorder_to;
      var sets = [];
      var params = [];
      var idx = 1;
      if (Object.prototype.hasOwnProperty.call(patch, "min_stock")) {
        _stockInt(patch.min_stock, "min_stock");
        nextMin = patch.min_stock;
        sets.push("min_stock = ?" + idx);   params.push(patch.min_stock);  idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "reorder_to")) {
        _stockInt(patch.reorder_to, "reorder_to");
        nextReorderTo = patch.reorder_to;
        sets.push("reorder_to = ?" + idx);  params.push(patch.reorder_to); idx += 1;
      }
      if (nextReorderTo < nextMin) {
        throw new TypeError("reorder-thresholds.updateThreshold: reorder_to (" +
          nextReorderTo + ") must be ≥ min_stock (" + nextMin + ")");
      }
      if (Object.prototype.hasOwnProperty.call(patch, "lead_time_days")) {
        _leadTimeDays(patch.lead_time_days);
        sets.push("lead_time_days = ?" + idx); params.push(patch.lead_time_days); idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "vendor_slug")) {
        var v = _vendorSlugOrNull(patch.vendor_slug);
        sets.push("vendor_slug = ?" + idx);    params.push(v);                    idx += 1;
      }
      if (sets.length === 0) {
        // No-op patch — return the existing row so the admin UI
        // can refresh.
        return _shapeThreshold(existing);
      }
      sets.push("updated_at = ?" + idx);       params.push(_now());               idx += 1;
      params.push(id);
      await query(
        "UPDATE reorder_thresholds SET " + sets.join(", ") + " WHERE id = ?" + idx,
        params,
      );
      return _shapeThreshold(await _getThresholdById(id));
    },

    // Soft-delete. Frees the (sku, location_code) slot among active
    // rows so the operator can redefine; the row stays in the table
    // so any draft PO that captured the id still resolves.
    archiveThreshold: async function (id) {
      _id(id, "threshold_id");
      var existing = await _getThresholdById(id);
      if (!existing) {
        throw new TypeError("reorder-thresholds.archiveThreshold: id " +
          JSON.stringify(id) + " not found");
      }
      if (existing.archived_at != null) {
        // Idempotent — re-archive returns the row unchanged.
        return _shapeThreshold(existing);
      }
      var ts = _now();
      await query(
        "UPDATE reorder_thresholds SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      return _shapeThreshold(await _getThresholdById(id));
    },

    // Operator dashboard read. Defaults to active rows only;
    // `include_archived: true` returns the full history.
    listThresholds: async function (listOpts) {
      listOpts = listOpts || {};
      var clauses = [];
      var params = [];
      var idx = 1;
      if (!listOpts.include_archived) {
        clauses.push("archived_at IS NULL");
      }
      if (listOpts.vendor_slug !== undefined) {
        if (listOpts.vendor_slug === null) {
          clauses.push("vendor_slug IS NULL");
        } else {
          _vendorSlugRequired(listOpts.vendor_slug);
          clauses.push("vendor_slug = ?" + idx); params.push(listOpts.vendor_slug); idx += 1;
        }
      }
      if (listOpts.location_code !== undefined) {
        if (listOpts.location_code === null) {
          clauses.push("location_code IS NULL");
        } else {
          var lc = _locationCodeOrNull(listOpts.location_code);
          clauses.push("location_code = ?" + idx); params.push(lc); idx += 1;
        }
      }
      if (listOpts.sku !== undefined) {
        _sku(listOpts.sku);
        clauses.push("sku = ?" + idx); params.push(listOpts.sku); idx += 1;
      }
      var where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
      var sql = "SELECT * FROM reorder_thresholds " + where +
                " ORDER BY sku ASC, COALESCE(location_code, '') ASC";
      var r = await query(sql, params);
      return r.rows.map(_shapeThreshold);
    },

    // Pure SELECT-only computation. Resolves the threshold for
    // (sku, location_code?), reads the current stock + windowed
    // velocity, and returns the structured evaluation.
    evaluate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-thresholds.evaluate: input object required");
      }
      _sku(input.sku);
      var locationCode = _locationCodeOrNull(input.location_code);
      var threshold = await _getActiveThreshold(input.sku, locationCode);
      if (!threshold) {
        throw new TypeError("reorder-thresholds.evaluate: no active threshold for sku " +
          JSON.stringify(input.sku) + " location_code " + JSON.stringify(locationCode));
      }
      var asOf = input.as_of == null ? _now() : input.as_of;
      _epochMs(asOf, "as_of");
      var currentStock = await _currentStock(input.sku, locationCode);
      var velocity = await _windowedVelocity(input.sku, locationCode, asOf);
      return _computeEvaluation(threshold, currentStock, velocity);
    },

    // Walk every active threshold, evaluate each, return the ones
    // at or below their min_stock floor. Optional filters narrow
    // the scope; the default sweeps every threshold (capped at
    // `limit` for unbounded callers).
    scanAll: async function (input) {
      input = input || {};
      var asOf = input.as_of == null ? _now() : input.as_of;
      _epochMs(asOf, "as_of");
      var limit = input.limit == null ? MAX_LIMIT : input.limit;
      _limit(limit);
      var clauses = ["archived_at IS NULL"];
      var params = [];
      var idx = 1;
      if (input.vendor_slug !== undefined) {
        if (input.vendor_slug === null) {
          clauses.push("vendor_slug IS NULL");
        } else {
          _vendorSlugRequired(input.vendor_slug);
          clauses.push("vendor_slug = ?" + idx); params.push(input.vendor_slug); idx += 1;
        }
      }
      if (input.location_code !== undefined) {
        if (input.location_code === null) {
          clauses.push("location_code IS NULL");
        } else {
          var lc = _locationCodeOrNull(input.location_code);
          clauses.push("location_code = ?" + idx); params.push(lc); idx += 1;
        }
      }
      params.push(limit);
      var sql = "SELECT * FROM reorder_thresholds WHERE " + clauses.join(" AND ") +
                " ORDER BY sku ASC, COALESCE(location_code, '') ASC LIMIT ?" + idx;
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var threshold = r.rows[i];
        var currentStock = await _currentStock(threshold.sku, threshold.location_code);
        var velocity = await _windowedVelocity(threshold.sku, threshold.location_code, asOf);
        var evalRow = _computeEvaluation(threshold, currentStock, velocity);
        if (!evalRow.should_reorder) continue;
        out.push({
          threshold_id:   threshold.id,
          sku:            threshold.sku,
          location_code:  threshold.location_code,
          vendor_slug:    threshold.vendor_slug,
          current_stock:  evalRow.current_stock,
          min_stock:      evalRow.min_stock,
          suggested_qty:  evalRow.suggested_qty,
          days_of_supply: evalRow.days_of_supply,
          lead_time_days: evalRow.lead_time_days,
        });
      }
      return out;
    },

    // Aggregate `scanAll` rows tagged with a specific vendor_slug
    // into a draft PO. Returns the structured payload — the
    // operator's procurement pipeline decides how to deliver it
    // (email, EDI, supplier portal). Refuses an empty vendor_slug;
    // returns `{ lines: [], total_qty: 0 }` when no thresholds for
    // that vendor are at-or-below.
    proposePurchaseOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-thresholds.proposePurchaseOrder: input object required");
      }
      _vendorSlugRequired(input.vendor_slug);
      var scope = input.scope || {};
      var scanInput = {
        vendor_slug:   input.vendor_slug,
        as_of:         scope.as_of,
        limit:         scope.limit,
      };
      if (scope.location_code !== undefined) scanInput.location_code = scope.location_code;
      var candidates = await this.scanAll(scanInput);
      var totalQty = 0;
      var lines = candidates.map(function (c) {
        totalQty += c.suggested_qty;
        return {
          threshold_id:   c.threshold_id,
          sku:            c.sku,
          location_code:  c.location_code,
          current_stock:  c.current_stock,
          min_stock:      c.min_stock,
          suggested_qty:  c.suggested_qty,
          lead_time_days: c.lead_time_days,
        };
      });
      return {
        vendor_slug:    input.vendor_slug,
        line_count:     lines.length,
        total_qty:      totalQty,
        lines:          lines,
        proposed_at:    scope.as_of == null ? _now() : scope.as_of,
      };
    },

    // Append a velocity row. Operators write these from order-
    // completion hooks or nightly aggregation jobs; `evaluate`
    // consumes them via the windowed sum.
    recordVelocity: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-thresholds.recordVelocity: input object required");
      }
      _sku(input.sku);
      var locationCode = _locationCodeOrNull(input.location_code);
      _epochMs(input.period_start, "period_start");
      _epochMs(input.period_end, "period_end");
      if (input.period_end < input.period_start) {
        throw new TypeError("reorder-thresholds.recordVelocity: period_end (" +
          input.period_end + ") must be ≥ period_start (" + input.period_start + ")");
      }
      _unitsSold(input.units_sold);
      var id = _b().uuid.v7();
      await query(
        "INSERT INTO sku_velocity (id, sku, location_code, period_start, period_end, units_sold) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, input.sku, locationCode, input.period_start, input.period_end, input.units_sold],
      );
      return {
        id:             id,
        sku:            input.sku,
        location_code:  locationCode,
        period_start:   input.period_start,
        period_end:     input.period_end,
        units_sold:     input.units_sold,
      };
    },
  };
}

module.exports = {
  create:               create,
  VELOCITY_WINDOW_DAYS: VELOCITY_WINDOW_DAYS,
};
