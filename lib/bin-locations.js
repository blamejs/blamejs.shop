"use strict";
/**
 * @module shop.binLocations
 * @title  Bin locations — per-SKU warehouse bin/aisle/shelf placement
 *
 * @intro
 *   Multi-location operators need to know where, physically, a given
 *   SKU lives inside a warehouse so the picker walks the floor in a
 *   minimum-distance pattern instead of zig-zagging between aisles.
 *   This primitive owns that addressing layer:
 *
 *     - Assign a SKU to a (location, bin, aisle, shelf, level)
 *       tuple — and, when the same SKU lives across several bins at
 *       the same location, flag one of them as `primary` so the
 *       picker has an unambiguous first-look bin.
 *     - Translate a flat list of SKUs into an aisle-ordered walk
 *       path so a pick list reaches the picker pre-sorted.
 *     - Track each bin's physical condition (clean / needs_audit /
 *       damaged / unusable) so the warehouse-floor dashboard can
 *       surface bins that need a cleaning pass or are unusable until
 *       a repair lands.
 *     - Record bin-content reconciliations (`recordBinAudit`) with
 *       the variance between expected SKUs and the SKUs the auditor
 *       actually found — the audit row stays append-only so the
 *       operator can prove the reconciliation history when a stock
 *       adjustment lands downstream.
 *
 *   Composes:
 *     - `b.uuid.v7`            — assignment / audit row ids
 *       (lexicographic + monotonic so ties on assigned_at sort
 *       deterministically).
 *     - `inventoryLocations` (optional) — when wired, the
 *       `location_code` on every assign / unassign / audit / condition
 *       call is checked against `inventoryLocations.getLocation(code)`
 *       and a missing/inactive location fails the write at the
 *       boundary; absent the dep, the primitive accepts every well-
 *       shaped code (the operator's downstream tooling is expected to
 *       validate the linkage).
 *     - `catalog` (optional) — when wired, every SKU on `assignBin`
 *       / `bulkAssign` is checked against `catalog.get(sku)` and an
 *       unknown SKU fails the write; absent, every well-shaped SKU
 *       string passes the boundary.
 *
 *   Picker-path discipline:
 *     `pickPathSort({ location_code, skus })` returns the input SKU
 *     list sorted by (aisle ASC, shelf ASC, level ASC) using the
 *     PRIMARY bin assignment at the location. A SKU with no
 *     assignment lands at the END of the path under a synthetic
 *     `(zzz, zzz, zzz)` sort key — the picker still gets the SKU on
 *     the list but knows to handle it specially (find-and-fetch
 *     rather than walk-to-bin). The function is stable: duplicate
 *     SKUs keep their relative order; SKUs sharing the same
 *     coordinates sort lexicographically among themselves.
 *
 *   Audit variance:
 *     `recordBinAudit({ expected_skus, actual_skus })` writes the
 *     variance object directly to the audit row:
 *       {
 *         missing:  [...sku strings that were expected but absent],
 *         extra:    [...sku strings that were present but not expected],
 *       }
 *     Both lists are JSON-serialised and sorted lexicographically for
 *     deterministic round-trips.
 *
 *   Three-tier input validation (use the discipline; don't write
 *   the labels in shipped artifacts):
 *     - Config-time / boot: factory `create()` THROWS on bad
 *       optional-dep shapes (catalog without `get`, inventoryLocations
 *       without `getLocation`).
 *     - Hot-path read (`binForSku`, `binsForSku`, `skusInBin`,
 *       `searchBinsByAisle`, `pickPathSort`, `listBinsWithCondition`):
 *       RETURNS DEFAULTS / empty arrays on a missing row, never
 *       throws — the picker / operator dashboard tolerate a transient
 *       miss while a re-assign is in flight.
 *     - Write path (`assignBin`, `unassignBin`, `bulkAssign`,
 *       `bulkUnassign`, `recordBinAudit`, `binCondition`): THROWS on
 *       bad input. The operator's boot-time wiring catches every
 *       typo on the first call.
 *
 * @primitive binLocations
 * @related   b.uuid.v7, inventoryLocations, catalog
 */

// ---- constants ---------------------------------------------------------

var SKU_RE              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var LOC_CODE_RE         = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var BIN_LABEL_RE        = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var AISLE_RE            = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
var SHELF_RE            = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
var LEVEL_RE            = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
var AUDITOR_RE          = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;

var MAX_LIST_LIMIT      = 500;
var MAX_BULK_ROWS       = 1000;
var MAX_AUDIT_SKUS      = 5000;

var CONDITIONS = Object.freeze([
  "clean", "needs_audit", "damaged", "unusable",
]);

// Synthetic sort key for SKUs missing an assignment in pickPathSort —
// a string that lexicographically follows every shape-valid aisle /
// shelf / level value. AISLE_RE etc. require an alphanumeric leading
// byte, so a `zzz` prefix sorts AFTER any real coordinate when the
// operator has not used an `{` or beyond as a leading byte.
var NO_ASSIGN_SORT_KEY = "￿";

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven writes can land in the same millisecond on fast
// machines (bulkAssign loops, immediate assign-then-unassign tests).
// Bumping by 1ms on a tie keeps assigned_at / occurred_at / updated_at
// strictly increasing so a sort-by-timestamp read returns the events
// in the order they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("bin-locations: " + (label || "sku") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _locCode(s) {
  if (typeof s !== "string" || !LOC_CODE_RE.test(s)) {
    throw new TypeError("bin-locations: location_code must match " +
      "/^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
  return s;
}

function _binLabel(s) {
  if (typeof s !== "string" || !BIN_LABEL_RE.test(s)) {
    throw new TypeError("bin-locations: bin_label must match " +
      "/^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
  return s;
}

function _aisle(s) {
  if (typeof s !== "string" || !AISLE_RE.test(s)) {
    throw new TypeError("bin-locations: aisle must match " +
      "/^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..32 chars)");
  }
  return s;
}

function _shelf(s) {
  if (typeof s !== "string" || !SHELF_RE.test(s)) {
    throw new TypeError("bin-locations: shelf must match " +
      "/^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..32 chars)");
  }
  return s;
}

function _level(s) {
  if (typeof s !== "string" || !LEVEL_RE.test(s)) {
    throw new TypeError("bin-locations: level must match " +
      "/^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..32 chars)");
  }
  return s;
}

function _auditor(s) {
  if (typeof s !== "string" || !AUDITOR_RE.test(s)) {
    throw new TypeError("bin-locations: audited_by must match " +
      "/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/ (alnum + . _ @ : -, 1..128 chars)");
  }
  return s;
}

function _condition(s) {
  if (typeof s !== "string" || CONDITIONS.indexOf(s) === -1) {
    throw new TypeError("bin-locations: condition must be one of " +
      CONDITIONS.join(", ") + ", got " + JSON.stringify(s));
  }
  return s;
}

function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("bin-locations: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _skuListForAudit(v, label) {
  if (!Array.isArray(v)) {
    throw new TypeError("bin-locations: " + label + " must be an array of sku strings");
  }
  if (v.length > MAX_AUDIT_SKUS) {
    throw new TypeError("bin-locations: " + label + " must contain <= " +
      MAX_AUDIT_SKUS + " sku entries");
  }
  for (var i = 0; i < v.length; i += 1) _sku(v[i], label + "[" + i + "]");
  return v;
}

// ---- row hydration ------------------------------------------------------

function _hydrateAssignment(r) {
  if (!r) return null;
  return {
    id:            r.id,
    sku:           r.sku,
    location_code: r.location_code,
    bin_label:     r.bin_label,
    aisle:         r.aisle,
    shelf:         r.shelf,
    level:         r.level,
    is_primary:    Number(r.is_primary) === 1,
    assigned_at:   Number(r.assigned_at),
    archived_at:   r.archived_at == null ? null : Number(r.archived_at),
  };
}

function _hydrateAudit(r) {
  if (!r) return null;
  return {
    id:            r.id,
    location_code: r.location_code,
    bin_label:     r.bin_label,
    audited_by:    r.audited_by,
    expected_skus: JSON.parse(r.expected_skus_json),
    actual_skus:   JSON.parse(r.actual_skus_json),
    variance:      JSON.parse(r.variance_json),
    occurred_at:   Number(r.occurred_at),
  };
}

function _hydrateCondition(r) {
  if (!r) return null;
  return {
    location_code: r.location_code,
    bin_label:     r.bin_label,
    condition:     r.condition,
    updated_at:    Number(r.updated_at),
  };
}

// Compute the {missing, extra} variance between expected and actual
// sku sets. Both lists are sorted lexicographically inside the result
// so the JSON round-trip is deterministic.
function _computeVariance(expected, actual) {
  var expSet = Object.create(null);
  var actSet = Object.create(null);
  for (var i = 0; i < expected.length; i += 1) expSet[expected[i]] = true;
  for (var j = 0; j < actual.length;   j += 1) actSet[actual[j]]   = true;

  var missing = [];
  var extra   = [];
  var k;
  for (k in expSet) if (!actSet[k]) missing.push(k);
  for (k in actSet) if (!expSet[k]) extra.push(k);
  missing.sort();
  extra.sort();
  return { missing: missing, extra: extra };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // inventoryLocations is optional — when wired, every assign /
  // unassign / audit / condition call validates the location_code
  // against the registered set. Absent, every well-shaped code passes
  // the boundary.
  var invLocations = opts.inventoryLocations || null;
  if (invLocations && typeof invLocations.getLocation !== "function") {
    throw new TypeError("bin-locations.create: opts.inventoryLocations must expose a getLocation(code) method");
  }

  // catalog is optional — when wired, every assignBin / bulkAssign
  // checks the SKU against catalog.get(sku) and refuses unknown SKUs.
  // Absent, every well-shaped SKU string passes the boundary.
  var catalog = opts.catalog || null;
  if (catalog && typeof catalog.get !== "function") {
    throw new TypeError("bin-locations.create: opts.catalog must expose a get(sku) method");
  }

  async function _checkLocation(code) {
    if (!invLocations) return;
    var loc = await invLocations.getLocation(code);
    if (!loc) {
      throw new TypeError("bin-locations: location_code " + JSON.stringify(code) +
        " is not registered with the wired inventoryLocations");
    }
  }

  async function _checkSku(sku) {
    if (!catalog) return;
    var row = await catalog.get(sku);
    if (!row) {
      throw new TypeError("bin-locations: sku " + JSON.stringify(sku) +
        " is not registered with the wired catalog");
    }
  }

  async function _getActiveAssignment(sku, locationCode, binLabel) {
    var r = await query(
      "SELECT * FROM bin_assignments WHERE sku = ?1 AND location_code = ?2 " +
      "AND bin_label = ?3 AND archived_at IS NULL LIMIT 1",
      [sku, locationCode, binLabel],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  async function _existsPrimaryForSkuLocation(sku, locationCode, excludeBinLabel) {
    var sql = "SELECT COUNT(*) AS n FROM bin_assignments WHERE sku = ?1 " +
              "AND location_code = ?2 AND archived_at IS NULL AND is_primary = 1";
    var params = [sku, locationCode];
    if (excludeBinLabel != null) {
      sql += " AND bin_label != ?3";
      params.push(excludeBinLabel);
    }
    var r = await query(sql, params);
    return Number(r.rows[0].n) > 0;
  }

  async function _assignBinInner(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bin-locations.assignBin: input object required");
    }
    var sku       = _sku(input.sku, "sku");
    var locCode   = _locCode(input.location_code);
    var binLabel  = _binLabel(input.bin_label);
    var aisle     = _aisle(input.aisle);
    var shelf     = _shelf(input.shelf);
    var level     = _level(input.level);
    var explicitPrimary = false;
    var requestedPrimary = false;
    if (input.is_primary !== undefined) {
      if (typeof input.is_primary !== "boolean") {
        throw new TypeError("bin-locations.assignBin: is_primary must be a boolean when provided");
      }
      explicitPrimary  = true;
      requestedPrimary = input.is_primary;
    }

    await _checkLocation(locCode);
    await _checkSku(sku);

    // Primary-flag policy: when the caller hasn't requested one
    // explicitly, the assignment becomes primary IFF no other active
    // assignment for the same (sku, location) already holds the flag.
    // When the caller did request `is_primary: true`, every other
    // active assignment for the same (sku, location) gets demoted in
    // the same write — there is always exactly one primary per
    // (sku, location).
    var existingPrimary = await _existsPrimaryForSkuLocation(sku, locCode, binLabel);
    var isPrimary;
    if (explicitPrimary) {
      isPrimary = requestedPrimary;
    } else {
      isPrimary = !existingPrimary;
    }

    var now = _now();
    var existing = await _getActiveAssignment(sku, locCode, binLabel);
    if (existing) {
      // Re-assigning the same triple updates the coordinates in place
      // rather than throwing the UNIQUE error. Operators correct a
      // mis-typed aisle by re-running assignBin with the right values.
      await query(
        "UPDATE bin_assignments SET aisle = ?1, shelf = ?2, level = ?3, " +
        "is_primary = ?4, assigned_at = ?5 WHERE id = ?6",
        [aisle, shelf, level, isPrimary ? 1 : 0, now, existing.id],
      );
    } else {
      try {
        await query(
          "INSERT INTO bin_assignments (id, sku, location_code, bin_label, " +
          "aisle, shelf, level, is_primary, assigned_at, archived_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
          [_b().uuid.v7(), sku, locCode, binLabel,
            aisle, shelf, level, isPrimary ? 1 : 0, now],
        );
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) {
          throw new TypeError("bin-locations.assignBin: assignment for sku " +
            JSON.stringify(sku) + " at " + JSON.stringify(locCode) + "/" +
            JSON.stringify(binLabel) + " already exists");
        }
        throw e;
      }
    }

    // When the new row is primary, demote every other active
    // assignment for the same (sku, location).
    if (isPrimary) {
      await query(
        "UPDATE bin_assignments SET is_primary = 0 WHERE sku = ?1 " +
        "AND location_code = ?2 AND bin_label != ?3 AND archived_at IS NULL",
        [sku, locCode, binLabel],
      );
    }

    return _hydrateAssignment(await _getActiveAssignment(sku, locCode, binLabel));
  }

  async function _unassignBinInner(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bin-locations.unassignBin: input object required");
    }
    var sku      = _sku(input.sku, "sku");
    var locCode  = _locCode(input.location_code);
    var binLabel = _binLabel(input.bin_label);

    var existing = await _getActiveAssignment(sku, locCode, binLabel);
    if (!existing) {
      throw new TypeError("bin-locations.unassignBin: no active assignment for sku " +
        JSON.stringify(sku) + " at " + JSON.stringify(locCode) + "/" +
        JSON.stringify(binLabel));
    }
    var now = _now();
    await query(
      "UPDATE bin_assignments SET archived_at = ?1, is_primary = 0 WHERE id = ?2",
      [now, existing.id],
    );

    // If the archived row was the primary, promote any remaining
    // active assignment for the same (sku, location) to primary.
    // Stable ordering by assigned_at ASC, bin_label ASC picks a
    // deterministic successor.
    if (Number(existing.is_primary) === 1) {
      var successors = (await query(
        "SELECT id FROM bin_assignments WHERE sku = ?1 AND location_code = ?2 " +
        "AND archived_at IS NULL ORDER BY assigned_at ASC, bin_label ASC LIMIT 1",
        [sku, locCode],
      )).rows;
      if (successors.length) {
        await query(
          "UPDATE bin_assignments SET is_primary = 1 WHERE id = ?1",
          [successors[0].id],
        );
      }
    }

    return { sku: sku, location_code: locCode, bin_label: binLabel,
      archived_at: now };
  }

  return {

    CONDITIONS: CONDITIONS,

    // Assign a SKU to a (location, bin, aisle, shelf, level) tuple.
    // Re-assigning the same triple updates the coordinates in place;
    // a brand-new triple inserts. The is_primary flag is auto-set
    // when the caller doesn't request one explicitly — the first
    // active assignment for a (sku, location) becomes primary; later
    // assignments default to secondary. Operators override by
    // passing `is_primary: true` on the call they want promoted; the
    // primitive demotes every other active assignment in the same
    // write.
    assignBin: _assignBinInner,

    // Soft-delete an assignment. The row stays in the table so the
    // audit history of "where this SKU used to live" survives.
    // When the archived row was the primary, the next-oldest active
    // assignment for the same (sku, location) is promoted.
    unassignBin: _unassignBinInner,

    // Primary-bin read. Returns the active assignment row flagged
    // is_primary at the (sku, location_code), or null when the SKU
    // has no active assignments at that location.
    binForSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("bin-locations.binForSku: input object required");
      }
      var sku     = _sku(input.sku, "sku");
      var locCode = _locCode(input.location_code);
      var r = await query(
        "SELECT * FROM bin_assignments WHERE sku = ?1 AND location_code = ?2 " +
        "AND archived_at IS NULL ORDER BY is_primary DESC, assigned_at ASC, " +
        "bin_label ASC LIMIT 1",
        [sku, locCode],
      );
      return r.rows.length ? _hydrateAssignment(r.rows[0]) : null;
    },

    // Every active assignment across every location for a SKU.
    // Sorted (location_code ASC, is_primary DESC, bin_label ASC) so
    // each location's primary bin lands first within its group.
    binsForSku: async function (sku) {
      _sku(sku, "sku");
      var r = await query(
        "SELECT * FROM bin_assignments WHERE sku = ?1 AND archived_at IS NULL " +
        "ORDER BY location_code ASC, is_primary DESC, bin_label ASC",
        [sku],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateAssignment(r.rows[i]));
      return out;
    },

    // Every SKU residing at a (location, bin). Operator's bin-audit
    // screen reads this to render the "what does this bin hold" list.
    skusInBin: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("bin-locations.skusInBin: input object required");
      }
      var locCode  = _locCode(input.location_code);
      var binLabel = _binLabel(input.bin_label);
      var r = await query(
        "SELECT * FROM bin_assignments WHERE location_code = ?1 AND bin_label = ?2 " +
        "AND archived_at IS NULL ORDER BY sku ASC",
        [locCode, binLabel],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateAssignment(r.rows[i]));
      return out;
    },

    // Aisle-scoped read for the operator's walk-the-floor view.
    // Sorts by (shelf ASC, level ASC, bin_label ASC, sku ASC) so the
    // result reads top-to-bottom, left-to-right along the aisle.
    searchBinsByAisle: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("bin-locations.searchBinsByAisle: input object required");
      }
      var locCode = _locCode(input.location_code);
      var aisle   = _aisle(input.aisle);
      var limit   = input.limit == null ? 100 : input.limit;
      _limit(limit);
      var r = await query(
        "SELECT * FROM bin_assignments WHERE location_code = ?1 AND aisle = ?2 " +
        "AND archived_at IS NULL " +
        "ORDER BY shelf ASC, level ASC, bin_label ASC, sku ASC LIMIT ?3",
        [locCode, aisle, limit],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateAssignment(r.rows[i]));
      return out;
    },

    // Translate a flat list of SKUs into an aisle-ordered walk path
    // at the given location. SKUs with no active assignment land at
    // the END of the path so the picker still gets them on the list
    // but knows to handle them specially. The sort is stable for
    // duplicates and lexicographic across coordinate ties.
    pickPathSort: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("bin-locations.pickPathSort: input object required");
      }
      var locCode = _locCode(input.location_code);
      var skus    = input.skus;
      if (!Array.isArray(skus)) {
        throw new TypeError("bin-locations.pickPathSort: skus must be an array");
      }
      if (skus.length === 0) return [];
      if (skus.length > MAX_LIST_LIMIT) {
        throw new TypeError("bin-locations.pickPathSort: skus must contain <= " +
          MAX_LIST_LIMIT + " entries");
      }
      for (var k = 0; k < skus.length; k += 1) _sku(skus[k], "skus[" + k + "]");

      // Pull every PRIMARY (or sole-active) assignment for the input
      // SKUs at this location in one SQL round-trip. `is_primary DESC`
      // ensures the primary lands first when a SKU has multiple
      // active assignments; the GROUP BY on `sku` keeps one row per
      // SKU.
      var placeholders = [];
      var params       = [locCode];
      for (var i = 0; i < skus.length; i += 1) {
        placeholders.push("?" + (i + 2));
        params.push(skus[i]);
      }
      var r = await query(
        "SELECT sku, aisle, shelf, level FROM bin_assignments WHERE " +
        "location_code = ?1 AND archived_at IS NULL AND sku IN (" +
        placeholders.join(", ") + ") " +
        "ORDER BY sku ASC, is_primary DESC, assigned_at ASC, bin_label ASC",
        params,
      );
      // Build the per-sku coordinate index — first row per sku wins
      // (the ORDER BY already sorted primaries to the front of each
      // sku's group).
      var coordsBySku = Object.create(null);
      for (var j = 0; j < r.rows.length; j += 1) {
        var row = r.rows[j];
        if (coordsBySku[row.sku] != null) continue;
        coordsBySku[row.sku] = {
          aisle: row.aisle, shelf: row.shelf, level: row.level,
        };
      }
      // Build the decorated list preserving original index for
      // stability when coordinates tie.
      var decorated = [];
      for (var m = 0; m < skus.length; m += 1) {
        var sku = skus[m];
        var c   = coordsBySku[sku];
        decorated.push({
          sku:    sku,
          aisle:  c ? c.aisle : NO_ASSIGN_SORT_KEY,
          shelf:  c ? c.shelf : NO_ASSIGN_SORT_KEY,
          level:  c ? c.level : NO_ASSIGN_SORT_KEY,
          idx:    m,
        });
      }
      decorated.sort(function (a, b) {
        if (a.aisle  !== b.aisle)  return a.aisle  < b.aisle  ? -1 : 1;
        if (a.shelf  !== b.shelf)  return a.shelf  < b.shelf  ? -1 : 1;
        if (a.level  !== b.level)  return a.level  < b.level  ? -1 : 1;
        if (a.sku    !== b.sku)    return a.sku    < b.sku    ? -1 : 1;
        return a.idx - b.idx;
      });
      var sorted = [];
      for (var p = 0; p < decorated.length; p += 1) sorted.push(decorated[p].sku);
      return sorted;
    },

    // Bulk assign — N rows, same shape as `assignBin`. Refuses the
    // whole batch on the first malformed row (the write-time
    // validators throw before any row touches the table); rows
    // already valid pass through one-at-a-time so each is_primary
    // promotion sees the prior writes. Returns the per-row hydrated
    // result list.
    bulkAssign: async function (rows) {
      if (!Array.isArray(rows)) {
        throw new TypeError("bin-locations.bulkAssign: rows must be an array");
      }
      if (rows.length === 0) return [];
      if (rows.length > MAX_BULK_ROWS) {
        throw new TypeError("bin-locations.bulkAssign: rows must contain <= " +
          MAX_BULK_ROWS + " entries");
      }
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push(await _assignBinInner(rows[i]));
      }
      return out;
    },

    // Bulk unassign — N rows, same shape as `unassignBin`. Refuses
    // the whole batch on the first malformed row.
    bulkUnassign: async function (rows) {
      if (!Array.isArray(rows)) {
        throw new TypeError("bin-locations.bulkUnassign: rows must be an array");
      }
      if (rows.length === 0) return [];
      if (rows.length > MAX_BULK_ROWS) {
        throw new TypeError("bin-locations.bulkUnassign: rows must contain <= " +
          MAX_BULK_ROWS + " entries");
      }
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push(await _unassignBinInner(rows[i]));
      }
      return out;
    },

    // Append a bin-audit row. Computes the variance (missing /
    // extra) between expected and actual SKU sets and persists the
    // resulting object on the audit row. The operator's
    // reconciliation worker reads `variance` to decide whether to
    // adjust stock, file a damage claim, or escalate to a recount.
    recordBinAudit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("bin-locations.recordBinAudit: input object required");
      }
      var locCode    = _locCode(input.location_code);
      var binLabel   = _binLabel(input.bin_label);
      var auditor    = _auditor(input.audited_by);
      var expected   = _skuListForAudit(input.expected_skus, "expected_skus");
      var actual     = _skuListForAudit(input.actual_skus,   "actual_skus");
      var occurredAt;
      if (input.occurred_at == null) {
        occurredAt = _now();
      } else {
        if (!Number.isInteger(input.occurred_at) || input.occurred_at <= 0) {
          throw new TypeError("bin-locations.recordBinAudit: occurred_at must be a positive integer (epoch ms) when provided");
        }
        occurredAt = input.occurred_at;
      }

      await _checkLocation(locCode);

      var variance = _computeVariance(expected, actual);
      // Sort the expected/actual lists for deterministic storage —
      // the audit row round-trips the same JSON bytes regardless of
      // input order.
      var expectedSorted = expected.slice().sort();
      var actualSorted   = actual.slice().sort();
      var id = _b().uuid.v7();
      await query(
        "INSERT INTO bin_audits (id, location_code, bin_label, audited_by, " +
        "expected_skus_json, actual_skus_json, variance_json, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        [id, locCode, binLabel, auditor,
          JSON.stringify(expectedSorted),
          JSON.stringify(actualSorted),
          JSON.stringify(variance),
          occurredAt],
      );
      var r = await query("SELECT * FROM bin_audits WHERE id = ?1", [id]);
      return _hydrateAudit(r.rows[0]);
    },

    // Upsert a bin's condition flag. The operator's warehouse-floor
    // dashboard reads `listBinsWithCondition({ condition })` to
    // surface bins that need a cleaning pass or are unusable.
    binCondition: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("bin-locations.binCondition: input object required");
      }
      var locCode   = _locCode(input.location_code);
      var binLabel  = _binLabel(input.bin_label);
      var condition = _condition(input.condition);

      await _checkLocation(locCode);

      var now = _now();
      var existing = (await query(
        "SELECT * FROM bin_conditions WHERE location_code = ?1 AND bin_label = ?2",
        [locCode, binLabel],
      )).rows;
      if (existing.length) {
        await query(
          "UPDATE bin_conditions SET condition = ?1, updated_at = ?2 " +
          "WHERE location_code = ?3 AND bin_label = ?4",
          [condition, now, locCode, binLabel],
        );
      } else {
        await query(
          "INSERT INTO bin_conditions (location_code, bin_label, condition, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4)",
          [locCode, binLabel, condition, now],
        );
      }
      var r = await query(
        "SELECT * FROM bin_conditions WHERE location_code = ?1 AND bin_label = ?2",
        [locCode, binLabel],
      );
      return _hydrateCondition(r.rows[0]);
    },

    // List bins flagged with a given condition. When location_code
    // is provided, restricts to that location; absent, returns
    // every flagged bin across every location ordered by
    // (location_code, bin_label).
    listBinsWithCondition: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("bin-locations.listBinsWithCondition: input object required");
      }
      var condition = _condition(input.condition);
      var sql, params;
      if (input.location_code != null) {
        var locCode = _locCode(input.location_code);
        sql = "SELECT * FROM bin_conditions WHERE condition = ?1 AND location_code = ?2 " +
              "ORDER BY bin_label ASC";
        params = [condition, locCode];
      } else {
        sql = "SELECT * FROM bin_conditions WHERE condition = ?1 " +
              "ORDER BY location_code ASC, bin_label ASC";
        params = [condition];
      }
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateCondition(r.rows[i]));
      return out;
    },
  };
}

module.exports = {
  create:     create,
  CONDITIONS: CONDITIONS,
};
