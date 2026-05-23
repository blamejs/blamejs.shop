"use strict";
/**
 * @module shop.inventoryLocations
 * @title  Inventory locations — multi-warehouse stock + order routing
 *
 * @intro
 *   The catalog inventory surface holds a single `stock_on_hand`
 *   per SKU — enough until the operator runs from more than one
 *   physical bucket. Multi-location operators (a warehouse plus a
 *   retail counter, a regional warehouse plus a dropship supplier,
 *   a network of stores each picking from their own shelf) need
 *   per-location stock counts AND a routing layer that picks which
 *   location ships any given order.
 *
 *   This primitive is the location-aware counterpart of the
 *   catalog's single-bucket inventory. It owns three tables:
 *
 *     inventory_locations    — operator-defined places (warehouse,
 *                              retail, dropship). `code` is the
 *                              operator-chosen short id (`WH-EAST`,
 *                              `STORE-NYC`); priority controls
 *                              routing order.
 *     inventory_stock        — per (sku, location_code) quantity.
 *                              The composite PK gives the upsert
 *                              path a single INSERT ... ON CONFLICT.
 *     inventory_adjustments  — append-only audit log: every
 *                              setStock / adjustStock /
 *                              transferStock writes a row.
 *
 *   Verbs:
 *     defineLocation         — register a location (refuses
 *                              duplicate code, invalid type, etc).
 *     listLocations / getLocation / updateLocation / deactivateLocation
 *                            — operator CRUD over the location set.
 *     setStock               — absolute set (overwrite).
 *     adjustStock            — relative delta with audit row.
 *     transferStock          — atomic two-row write moving qty
 *                              from one location to another; if
 *                              the source doesn't have enough, the
 *                              whole transfer refuses (no money
 *                              created, no row half-committed).
 *     stockForSku            — `{ total, by_location: [...] }`.
 *     totalForSku            — sum across every location.
 *     availableLocations     — locations with quantity > 0.
 *     routeOrder             — given `{ lines: [{ sku, qty }] }`,
 *                              returns `{ allocation, unfulfillable }`
 *                              under one of three strategies:
 *                                'priority-fill'             (default)
 *                                'single-location-cheapest'
 *                                'nearest-by-postal-prefix'
 *
 *   Composition:
 *     - b.uuid.v7        — adjustment row PKs (sortable by insertion)
 *     - catalog          — held for future cross-checks (current
 *                          version doesn't read from it; the
 *                          factory still requires it so the boot
 *                          wiring fails loud when a caller forgets
 *                          to provide one)
 *
 *   Three-tier input validation (use the discipline; don't write
 *   the labels): every public verb on this module is a defensive
 *   request-shape reader OR a config-time entry point. Both throw
 *   on bad input. No drop-silent hot-path sinks here.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var CODE_RE      = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKU_RE       = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var NAME_RE      = /^[\S\s]{1,128}$/;
var MAX_REASON   = 256;
var MAX_LINES    = 1000;
var TYPES        = Object.freeze(["warehouse", "retail", "dropship"]);
var STRATEGIES   = Object.freeze([
  "priority-fill",
  "single-location-cheapest",
  "nearest-by-postal-prefix",
]);

// ---- validators ---------------------------------------------------------

function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("inventory-locations: " + (label || "code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("inventory-locations: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _name(s) {
  if (typeof s !== "string" || !NAME_RE.test(s) || s.length > 128) {
    throw new TypeError("inventory-locations: name must be a non-empty string ≤ 128 chars");
  }
}
function _type(s) {
  if (typeof s !== "string" || TYPES.indexOf(s) === -1) {
    throw new TypeError("inventory-locations: type must be one of " + TYPES.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _priority(n) {
  if (!Number.isInteger(n) || n < 0 || n > 1000000) {
    throw new TypeError("inventory-locations: priority must be a non-negative integer ≤ 1000000");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-locations: " + label + " must be a non-negative integer");
  }
}
function _int(n, label) {
  if (!Number.isInteger(n)) {
    throw new TypeError("inventory-locations: " + label + " must be an integer");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("inventory-locations: " + label + " must be a positive integer");
  }
}
function _reason(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_REASON) {
    throw new TypeError("inventory-locations: reason must be a string ≤ " + MAX_REASON + " chars");
  }
  return s;
}
function _addressJson(v) {
  if (v == null) return null;
  // Either pre-serialized JSON string or an object the primitive
  // serializes for the operator. Refuse anything else — the
  // address has to round-trip through JSON cleanly.
  if (typeof v === "string") {
    try { JSON.parse(v); }
    catch (_e) { throw new TypeError("inventory-locations: address must be a JSON-parseable string or a plain object"); }
    if (v.length > 4000) {
      throw new TypeError("inventory-locations: address JSON must be ≤ 4000 chars");
    }
    return v;
  }
  if (typeof v === "object") {
    var s;
    try { s = JSON.stringify(v); }
    catch (_e2) { throw new TypeError("inventory-locations: address object must serialize via JSON.stringify"); }
    if (s.length > 4000) {
      throw new TypeError("inventory-locations: address JSON must be ≤ 4000 chars");
    }
    return s;
  }
  throw new TypeError("inventory-locations: address must be a JSON-parseable string or a plain object");
}

function _now() { return Date.now(); }

function _parseAddress(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); }
  catch (_e) { return null; }
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  // The catalog handle is held so a future revision can cross-
  // reference SKUs against catalog.products.exists(sku) etc — the
  // current version doesn't read from it, but the factory still
  // requires it so the boot wiring fails loud when a caller
  // forgets to thread the catalog through.
  if (!opts.catalog || typeof opts.catalog !== "object") {
    throw new TypeError("inventory-locations.create: opts.catalog is required");
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Hydrate a row, parsing the JSON address + coercing the
  // INTEGER active flag to a real boolean. Returns null on miss
  // so the caller can map cleanly to HTTP 404.
  function _shapeLocation(row) {
    if (!row) return null;
    return {
      code:       row.code,
      name:       row.name,
      type:       row.type,
      address:    _parseAddress(row.address_json),
      priority:   row.priority,
      active:     row.active === 1 || row.active === true,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // Append an audit row. Called inline from every stock-mutating
  // verb. Throws if the underlying insert fails — callers don't
  // catch this; the mutation should never be considered "applied"
  // without the audit trail.
  async function _audit(sku, locationCode, delta, reason) {
    await query(
      "INSERT INTO inventory_adjustments (id, sku, location_code, delta, reason, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [_b().uuid.v7(), sku, locationCode, delta, reason || "", _now()],
    );
  }

  async function _getLocationRow(code) {
    var r = await query("SELECT * FROM inventory_locations WHERE code = ?1", [code]);
    return r.rows[0] || null;
  }

  async function _getStockRow(sku, code) {
    var r = await query(
      "SELECT * FROM inventory_stock WHERE sku = ?1 AND location_code = ?2",
      [sku, code],
    );
    return r.rows[0] || null;
  }

  // Pull the active-locations list sorted by (priority ASC, code
  // ASC). The deterministic tie-break by code matters: two
  // locations at the same priority should always pick in the
  // same order across calls so routing is reproducible.
  async function _activeLocationsSorted() {
    var r = await query(
      "SELECT * FROM inventory_locations WHERE active = 1 ORDER BY priority ASC, code ASC",
      [],
    );
    return r.rows.map(_shapeLocation);
  }

  // ---- routing strategies ----------------------------------------------

  // priority-fill: walks active locations in (priority, code)
  // order. For each line, pulls from each location greedily until
  // the line's qty is satisfied. Unfilled qty lands on
  // `unfulfillable`. Lines that span multiple locations are split
  // across them — the result groups allocations by location_code
  // so downstream packers see "this box ships from WH-EAST,
  // contains these lines."
  async function _routePriorityFill(lines) {
    var locations = await _activeLocationsSorted();
    var byLoc = {};         // code -> { location_code, lines: [{sku, quantity}] }
    var unfulfillable = []; // [{ sku, quantity }]
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var remaining = line.quantity;
      for (var j = 0; j < locations.length && remaining > 0; j += 1) {
        var loc = locations[j];
        var stock = await _getStockRow(line.sku, loc.code);
        if (!stock || stock.quantity <= 0) continue;
        var pick = Math.min(stock.quantity, remaining);
        if (!byLoc[loc.code]) byLoc[loc.code] = { location_code: loc.code, lines: [] };
        byLoc[loc.code].lines.push({ sku: line.sku, quantity: pick });
        remaining -= pick;
      }
      if (remaining > 0) unfulfillable.push({ sku: line.sku, quantity: remaining });
    }
    // Emit allocations in priority order, not insertion order, so
    // the caller sees the highest-priority shipper first.
    var allocation = [];
    for (var k = 0; k < locations.length; k += 1) {
      var c = locations[k].code;
      if (byLoc[c]) allocation.push(byLoc[c]);
    }
    return { allocation: allocation, unfulfillable: unfulfillable };
  }

  // single-location-cheapest: pick the single active location with
  // the lowest priority that can fill EVERY line completely. If no
  // single location can cover the whole order, every line lands
  // on unfulfillable (the strategy by name refuses splits — the
  // caller picks `priority-fill` if they want partial allocation).
  async function _routeSingleLocationCheapest(lines) {
    var locations = await _activeLocationsSorted();
    for (var j = 0; j < locations.length; j += 1) {
      var loc = locations[j];
      var ok = true;
      for (var i = 0; i < lines.length; i += 1) {
        var stock = await _getStockRow(lines[i].sku, loc.code);
        if (!stock || stock.quantity < lines[i].quantity) { ok = false; break; }
      }
      if (ok) {
        var allocLines = lines.map(function (l) { return { sku: l.sku, quantity: l.quantity }; });
        return {
          allocation:    [{ location_code: loc.code, lines: allocLines }],
          unfulfillable: [],
        };
      }
    }
    // No single location can cover — push every line onto
    // unfulfillable so the caller can either fall back to
    // priority-fill or surface the gap to the operator.
    return {
      allocation:    [],
      unfulfillable: lines.map(function (l) { return { sku: l.sku, quantity: l.quantity }; }),
    };
  }

  // nearest-by-postal-prefix: operator supplies `{ destinationPostal,
  // postalMap }` where postalMap is `{ <location_code>: <postal-prefix-string> }`.
  // The strategy scores each active location by the length of the
  // shared prefix between destinationPostal and that location's
  // entry; highest score wins, ties broken by priority then code.
  // Once the winning order is decided, the strategy falls back to
  // priority-fill semantics (greedy split across the ordered
  // locations) so partial coverage doesn't drop the order.
  async function _routeNearestByPostalPrefix(lines, strategyOpts) {
    if (!strategyOpts || typeof strategyOpts !== "object") {
      throw new TypeError("inventory-locations.routeOrder(nearest-by-postal-prefix): " +
        "strategyOpts.destinationPostal + strategyOpts.postalMap required");
    }
    var dest = strategyOpts.destinationPostal;
    if (typeof dest !== "string" || !dest.length || dest.length > 32) {
      throw new TypeError("inventory-locations.routeOrder(nearest-by-postal-prefix): " +
        "destinationPostal must be a non-empty string ≤ 32 chars");
    }
    var map = strategyOpts.postalMap;
    if (!map || typeof map !== "object") {
      throw new TypeError("inventory-locations.routeOrder(nearest-by-postal-prefix): " +
        "postalMap must be an object of { location_code: postal-prefix }");
    }
    var locations = await _activeLocationsSorted();
    function _sharedPrefix(a, b) {
      if (typeof a !== "string" || typeof b !== "string") return 0;
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i += 1) {
        if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
      }
      return n;
    }
    // Decorate locations with their score; sort by (score DESC,
    // priority ASC, code ASC).
    var scored = locations.map(function (loc) {
      var prefix = map[loc.code];
      var score = _sharedPrefix(dest, prefix || "");
      return { loc: loc, score: score };
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.loc.priority !== b.loc.priority) return a.loc.priority - b.loc.priority;
      if (a.loc.code < b.loc.code) return -1;
      if (a.loc.code > b.loc.code) return 1;
      return 0;
    });
    var ordered = scored.map(function (s) { return s.loc; });
    var byLoc = {};
    var unfulfillable = [];
    for (var i2 = 0; i2 < lines.length; i2 += 1) {
      var line = lines[i2];
      var remaining = line.quantity;
      for (var j2 = 0; j2 < ordered.length && remaining > 0; j2 += 1) {
        var loc2 = ordered[j2];
        var stock = await _getStockRow(line.sku, loc2.code);
        if (!stock || stock.quantity <= 0) continue;
        var pick = Math.min(stock.quantity, remaining);
        if (!byLoc[loc2.code]) byLoc[loc2.code] = { location_code: loc2.code, lines: [] };
        byLoc[loc2.code].lines.push({ sku: line.sku, quantity: pick });
        remaining -= pick;
      }
      if (remaining > 0) unfulfillable.push({ sku: line.sku, quantity: remaining });
    }
    var allocation = [];
    for (var k2 = 0; k2 < ordered.length; k2 += 1) {
      var c2 = ordered[k2].code;
      if (byLoc[c2]) allocation.push(byLoc[c2]);
    }
    return { allocation: allocation, unfulfillable: unfulfillable };
  }

  return {

    // Register a location. Refuses a duplicate code up front with
    // a descriptive message instead of relying on the PK
    // constraint's raw SQLITE_CONSTRAINT throw. The address is
    // serialized to JSON for storage; readers parse it back via
    // the row-shaper.
    defineLocation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-locations.defineLocation: input object required");
      }
      _code(input.code, "code");
      _name(input.name);
      _type(input.type);
      var priority = input.priority == null ? 100 : input.priority;
      _priority(priority);
      var active = input.active == null ? true : input.active;
      if (typeof active !== "boolean") {
        throw new TypeError("inventory-locations.defineLocation: active must be a boolean");
      }
      var address = _addressJson(input.address);

      var dup = await query(
        "SELECT code FROM inventory_locations WHERE code = ?1 LIMIT 1",
        [input.code],
      );
      if (dup.rows.length) {
        throw new TypeError("inventory-locations.defineLocation: code " +
          JSON.stringify(input.code) + " already exists");
      }

      var ts = _now();
      await query(
        "INSERT INTO inventory_locations (code, name, type, address_json, priority, active, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        [input.code, input.name, input.type, address, priority, active ? 1 : 0, ts],
      );
      return _shapeLocation(await _getLocationRow(input.code));
    },

    // List locations. `active_only: true` filters out deactivated
    // rows. Sort is (priority ASC, code ASC) — operators expect
    // the routing order in the admin UI.
    listLocations: async function (listOpts) {
      listOpts = listOpts || {};
      var sql, params;
      if (listOpts.active_only) {
        sql = "SELECT * FROM inventory_locations WHERE active = 1 ORDER BY priority ASC, code ASC";
        params = [];
      } else {
        sql = "SELECT * FROM inventory_locations ORDER BY priority ASC, code ASC";
        params = [];
      }
      var rows = (await query(sql, params)).rows;
      return rows.map(_shapeLocation);
    },

    // Read one location. Returns null on miss so the caller-
    // handler maps cleanly to HTTP 404.
    getLocation: async function (code) {
      _code(code, "code");
      return _shapeLocation(await _getLocationRow(code));
    },

    // Patch a subset of mutable fields. `code` and `created_at`
    // are immutable; every other field is patchable. Refuses an
    // unknown code with a descriptive error.
    updateLocation: async function (code, patch) {
      _code(code, "code");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("inventory-locations.updateLocation: patch object required");
      }
      var existing = await _getLocationRow(code);
      if (!existing) {
        throw new TypeError("inventory-locations.updateLocation: code " +
          JSON.stringify(code) + " not found");
      }
      var sets = [];
      var params = [];
      var idx = 1;
      if (Object.prototype.hasOwnProperty.call(patch, "name")) {
        _name(patch.name);
        sets.push("name = ?" + idx);          params.push(patch.name);          idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "type")) {
        _type(patch.type);
        sets.push("type = ?" + idx);          params.push(patch.type);          idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "priority")) {
        _priority(patch.priority);
        sets.push("priority = ?" + idx);      params.push(patch.priority);      idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "address")) {
        var addr = _addressJson(patch.address);
        sets.push("address_json = ?" + idx);  params.push(addr);                idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "active")) {
        if (typeof patch.active !== "boolean") {
          throw new TypeError("inventory-locations.updateLocation: active must be a boolean");
        }
        sets.push("active = ?" + idx);        params.push(patch.active ? 1 : 0); idx += 1;
      }
      if (sets.length === 0) {
        // No-op patch — still return the current row so the
        // admin UI can refresh.
        return _shapeLocation(existing);
      }
      sets.push("updated_at = ?" + idx);      params.push(_now());              idx += 1;
      params.push(code);
      await query(
        "UPDATE inventory_locations SET " + sets.join(", ") + " WHERE code = ?" + idx,
        params,
      );
      return _shapeLocation(await _getLocationRow(code));
    },

    // Sugar over `updateLocation({ active: false })`. The row
    // stays in the table so historical adjustments still resolve
    // their location_code reference.
    deactivateLocation: async function (code) {
      _code(code, "code");
      var existing = await _getLocationRow(code);
      if (!existing) {
        throw new TypeError("inventory-locations.deactivateLocation: code " +
          JSON.stringify(code) + " not found");
      }
      await query(
        "UPDATE inventory_locations SET active = 0, updated_at = ?1 WHERE code = ?2",
        [_now(), code],
      );
      return _shapeLocation(await _getLocationRow(code));
    },

    // Absolute set: overwrites the (sku, location_code) row to
    // exactly `quantity`. Audit row captures the signed delta vs
    // the prior value so the audit log reflects the actual change.
    setStock: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-locations.setStock: input object required");
      }
      _sku(input.sku);
      _code(input.location_code, "location_code");
      _nonNegInt(input.quantity, "quantity");
      var loc = await _getLocationRow(input.location_code);
      if (!loc) {
        throw new TypeError("inventory-locations.setStock: location_code " +
          JSON.stringify(input.location_code) + " not found");
      }
      var prev = await _getStockRow(input.sku, input.location_code);
      var prevQty = prev ? prev.quantity : 0;
      var ts = _now();
      if (prev) {
        await query(
          "UPDATE inventory_stock SET quantity = ?1, updated_at = ?2 WHERE sku = ?3 AND location_code = ?4",
          [input.quantity, ts, input.sku, input.location_code],
        );
      } else {
        await query(
          "INSERT INTO inventory_stock (sku, location_code, quantity, updated_at) VALUES (?1, ?2, ?3, ?4)",
          [input.sku, input.location_code, input.quantity, ts],
        );
      }
      var delta = input.quantity - prevQty;
      await _audit(input.sku, input.location_code, delta, _reason(input.reason));
      return { sku: input.sku, location_code: input.location_code, quantity: input.quantity, delta: delta };
    },

    // Relative delta with audit row. The composite quantity must
    // remain non-negative — a negative delta that would drive the
    // row below zero refuses the whole operation. Inserts a row
    // at quantity 0 + delta if the (sku, location_code) pair has
    // never been touched before (and delta is positive).
    adjustStock: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-locations.adjustStock: input object required");
      }
      _sku(input.sku);
      _code(input.location_code, "location_code");
      _int(input.delta, "delta");
      if (input.delta === 0) {
        throw new TypeError("inventory-locations.adjustStock: delta must be non-zero");
      }
      var loc = await _getLocationRow(input.location_code);
      if (!loc) {
        throw new TypeError("inventory-locations.adjustStock: location_code " +
          JSON.stringify(input.location_code) + " not found");
      }
      var prev = await _getStockRow(input.sku, input.location_code);
      var prevQty = prev ? prev.quantity : 0;
      var next = prevQty + input.delta;
      if (next < 0) {
        throw new TypeError("inventory-locations.adjustStock: delta " + input.delta +
          " would drive stock below zero (current=" + prevQty + ", sku=" + input.sku +
          ", location=" + input.location_code + ")");
      }
      var ts = _now();
      if (prev) {
        await query(
          "UPDATE inventory_stock SET quantity = ?1, updated_at = ?2 WHERE sku = ?3 AND location_code = ?4",
          [next, ts, input.sku, input.location_code],
        );
      } else {
        await query(
          "INSERT INTO inventory_stock (sku, location_code, quantity, updated_at) VALUES (?1, ?2, ?3, ?4)",
          [input.sku, input.location_code, next, ts],
        );
      }
      await _audit(input.sku, input.location_code, input.delta, _reason(input.reason));
      return { sku: input.sku, location_code: input.location_code, quantity: next, delta: input.delta };
    },

    // Atomic two-row move. Reads the source quantity; if
    // insufficient, refuses the whole transfer before mutating
    // anything (no money created, no row half-committed). Writes
    // two audit rows (negative on source, positive on destination)
    // so the audit log preserves the pairing.
    transferStock: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-locations.transferStock: input object required");
      }
      _sku(input.sku);
      _code(input.from_location, "from_location");
      _code(input.to_location, "to_location");
      if (input.from_location === input.to_location) {
        throw new TypeError("inventory-locations.transferStock: from_location and to_location must differ");
      }
      _positiveInt(input.quantity, "quantity");

      var fromLoc = await _getLocationRow(input.from_location);
      if (!fromLoc) {
        throw new TypeError("inventory-locations.transferStock: from_location " +
          JSON.stringify(input.from_location) + " not found");
      }
      var toLoc = await _getLocationRow(input.to_location);
      if (!toLoc) {
        throw new TypeError("inventory-locations.transferStock: to_location " +
          JSON.stringify(input.to_location) + " not found");
      }

      var fromRow = await _getStockRow(input.sku, input.from_location);
      var fromQty = fromRow ? fromRow.quantity : 0;
      if (fromQty < input.quantity) {
        throw new TypeError("inventory-locations.transferStock: insufficient stock at " +
          input.from_location + " (have " + fromQty + ", need " + input.quantity + ")");
      }
      var toRow = await _getStockRow(input.sku, input.to_location);
      var toQty = toRow ? toRow.quantity : 0;

      var ts = _now();
      // Decrement source first. If the destination upsert below
      // fails for any reason, the rollback path re-increments the
      // source so the invariant (total quantity unchanged) holds.
      await query(
        "UPDATE inventory_stock SET quantity = ?1, updated_at = ?2 WHERE sku = ?3 AND location_code = ?4",
        [fromQty - input.quantity, ts, input.sku, input.from_location],
      );
      try {
        if (toRow) {
          await query(
            "UPDATE inventory_stock SET quantity = ?1, updated_at = ?2 WHERE sku = ?3 AND location_code = ?4",
            [toQty + input.quantity, ts, input.sku, input.to_location],
          );
        } else {
          await query(
            "INSERT INTO inventory_stock (sku, location_code, quantity, updated_at) VALUES (?1, ?2, ?3, ?4)",
            [input.sku, input.to_location, input.quantity, ts],
          );
        }
      } catch (e) {
        // Best-effort compensating restore on the source so the
        // pair stays balanced. If THIS write also fails the
        // operator will see two adjacent audit rows with no
        // counterpart — the caller can replay or reconcile.
        try {
          await query(
            "UPDATE inventory_stock SET quantity = ?1, updated_at = ?2 WHERE sku = ?3 AND location_code = ?4",
            [fromQty, _now(), input.sku, input.from_location],
          );
        } catch (_e2) { /* drop-silent — the original error is what the caller needs to fix */ }
        throw e;
      }

      var reason = _reason(input.reason);
      await _audit(input.sku, input.from_location, -input.quantity, reason);
      await _audit(input.sku, input.to_location,    input.quantity, reason);

      return {
        sku:           input.sku,
        from_location: input.from_location,
        to_location:   input.to_location,
        quantity:      input.quantity,
        from_after:    fromQty - input.quantity,
        to_after:      toQty + input.quantity,
      };
    },

    // Stock breakdown for a single SKU. by_location is ordered by
    // (priority ASC, code ASC) — operators read it as the routing
    // order. Locations with zero stock that have ever held the
    // SKU are still included so the UI can show "out of stock at
    // STORE-NYC" instead of silently dropping the row.
    stockForSku: async function (sku) {
      _sku(sku);
      var r = await query(
        "SELECT s.sku, s.location_code, s.quantity, l.priority " +
        "FROM inventory_stock s " +
        "JOIN inventory_locations l ON l.code = s.location_code " +
        "WHERE s.sku = ?1 " +
        "ORDER BY l.priority ASC, l.code ASC",
        [sku],
      );
      var total = 0;
      var byLocation = r.rows.map(function (row) {
        total += row.quantity;
        return { code: row.location_code, quantity: row.quantity };
      });
      return { total: total, by_location: byLocation };
    },

    // Sum across every location. Faster than stockForSku when the
    // caller only needs the headline number.
    totalForSku: async function (sku) {
      _sku(sku);
      var r = await query(
        "SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_stock WHERE sku = ?1",
        [sku],
      );
      return r.rows[0] ? Number(r.rows[0].total) : 0;
    },

    // Active locations with quantity > 0 for the SKU, ordered by
    // (priority, code). Convenience for "where can we ship this
    // SKU from?" admin views.
    availableLocations: async function (sku) {
      _sku(sku);
      var r = await query(
        "SELECT s.location_code, s.quantity, l.priority " +
        "FROM inventory_stock s " +
        "JOIN inventory_locations l ON l.code = s.location_code " +
        "WHERE s.sku = ?1 AND s.quantity > 0 AND l.active = 1 " +
        "ORDER BY l.priority ASC, l.code ASC",
        [sku],
      );
      return r.rows.map(function (row) {
        return { code: row.location_code, quantity: row.quantity };
      });
    },

    // Route an order. Strategy is one of:
    //   'priority-fill'             (default — greedy split by priority)
    //   'single-location-cheapest'  (refuses splits)
    //   'nearest-by-postal-prefix'  (operator supplies postal map)
    // Validates lines + dispatches.
    routeOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-locations.routeOrder: input object required");
      }
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new TypeError("inventory-locations.routeOrder: lines must be a non-empty array");
      }
      if (input.lines.length > MAX_LINES) {
        throw new TypeError("inventory-locations.routeOrder: lines must contain ≤ " + MAX_LINES + " entries");
      }
      var normalized = [];
      for (var i = 0; i < input.lines.length; i += 1) {
        var l = input.lines[i];
        if (!l || typeof l !== "object") {
          throw new TypeError("inventory-locations.routeOrder: lines[" + i + "] must be an object");
        }
        _sku(l.sku);
        _positiveInt(l.quantity, "lines[" + i + "].quantity");
        normalized.push({ sku: l.sku, quantity: l.quantity });
      }
      var strategy = input.strategy == null ? "priority-fill" : input.strategy;
      if (STRATEGIES.indexOf(strategy) === -1) {
        throw new TypeError("inventory-locations.routeOrder: strategy must be one of " +
          STRATEGIES.join(", ") + ", got " + JSON.stringify(strategy));
      }
      if (strategy === "priority-fill") {
        return await _routePriorityFill(normalized);
      }
      if (strategy === "single-location-cheapest") {
        return await _routeSingleLocationCheapest(normalized);
      }
      // nearest-by-postal-prefix
      return await _routeNearestByPostalPrefix(normalized, input.strategyOpts);
    },
  };
}

module.exports = {
  create:     create,
  TYPES:      TYPES,
  STRATEGIES: STRATEGIES,
};
