"use strict";
/**
 * inventory-locations — multi-warehouse stock + order routing.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0034
 * (the locations / stock / adjustments tables). The catalog handle
 * is a minimal stub — this primitive doesn't read from it, but the
 * factory still requires it so the boot wiring fails loud when a
 * caller forgets to thread the catalog through.
 *
 * Coverage:
 *   - defineLocation refusals: bad code, bad name, bad type, bad
 *     priority, bad active, duplicate code, missing input
 *   - defineLocation happy path: address JSON round-trip, default
 *     priority, default active
 *   - listLocations + active_only filter, getLocation, updateLocation,
 *     deactivateLocation
 *   - setStock arithmetic + audit row capture
 *   - adjustStock arithmetic, refuses delta=0, refuses negative
 *     drive
 *   - transferStock atomicity: no money created, insufficient-stock
 *     refusal leaves rows untouched
 *   - stockForSku aggregation across multiple locations, ordered by
 *     priority
 *   - totalForSku + availableLocations
 *   - routeOrder priority-fill: greedy split across 3 locations
 *     with correct allocation
 *   - routeOrder single-location-cheapest: picks the lowest-priority
 *     location that covers the whole order; refuses splits
 *   - routeOrder unfulfillable detection (priority-fill + single-
 *     location strategies)
 *   - routeOrder nearest-by-postal-prefix: prefers location whose
 *     postal prefix shares the longest run with the destination
 *   - factory refusals: missing catalog
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// The primitive is wired into the package surface manually by the
// operator after the patch lands. Require the module directly so
// this test file is independent of `lib/index.js` export ordering.
var inventoryLocations = require("../../lib/inventory-locations");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0034_inventory_locations.sql",
  "0233_inventory_adjustments_idempotency_key.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  // Split on statement terminators, but keep CREATE TRIGGER ... BEGIN ... END
  // blocks whole: a trigger body carries inner `;` that must NOT split it.
  var raw = noComments.split(/;\s*(?:\n|$)/);
  var stmts = [];
  var pending = null;
  for (var i = 0; i < raw.length; i += 1) {
    var part = raw[i];
    if (pending !== null) {
      pending += ";\n" + part;
      if (/\bEND\b/i.test(part)) { stmts.push(pending.trim()); pending = null; }
      continue;
    }
    if (/\bBEGIN\b/i.test(part) && !/\bEND\b/i.test(part)) { pending = part; continue; }
    var t = part.trim();
    if (t) stmts.push(t);
  }
  if (pending !== null) stmts.push(pending.trim());
  return stmts.filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  var queryFn = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  queryFn.__db = db;
  return queryFn;
}

// Minimal catalog stub. The factory only checks that it's an
// object — the primitive doesn't currently call into it.
function _stubCatalog() { return {}; }

async function _defineThreeLocations(svc) {
  // East (priority 1), West (priority 5), Store-NYC (priority 10).
  await svc.defineLocation({
    code: "WH-EAST", name: "East Warehouse", type: "warehouse", priority: 1,
    address: { postal: "10001", city: "New York" },
  });
  await svc.defineLocation({
    code: "WH-WEST", name: "West Warehouse", type: "warehouse", priority: 5,
    address: { postal: "94105", city: "San Francisco" },
  });
  await svc.defineLocation({
    code: "STORE-NYC", name: "Manhattan Store", type: "retail", priority: 10,
    address: { postal: "10003", city: "New York" },
  });
}

async function _defineLocationHappyPath() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });

  var loc = await svc.defineLocation({
    code: "WH-EAST", name: "East Warehouse", type: "warehouse", priority: 1,
    address: { postal: "10001", city: "New York" },
  });
  check("defineLocation returns code",            loc.code === "WH-EAST");
  check("defineLocation returns name",            loc.name === "East Warehouse");
  check("defineLocation returns type",            loc.type === "warehouse");
  check("defineLocation returns priority",        loc.priority === 1);
  check("defineLocation default active=true",     loc.active === true);
  check("defineLocation address round-trip",      loc.address && loc.address.postal === "10001");

  // Default priority when omitted = 100
  var loc2 = await svc.defineLocation({
    code: "DROP-1", name: "Drop Supplier", type: "dropship",
  });
  check("defineLocation default priority=100",    loc2.priority === 100);
  check("defineLocation default address=null",    loc2.address === null);

  // Explicit active=false
  var loc3 = await svc.defineLocation({
    code: "WH-OLD", name: "Old Warehouse", type: "warehouse", active: false,
  });
  check("defineLocation explicit active=false",   loc3.active === false);
}

async function _defineLocationRefusals() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });

  // Missing input
  await assert.rejects(svc.defineLocation(),                                                   /input object required/);
  await assert.rejects(svc.defineLocation(null),                                               /input object required/);
  // Bad code
  await assert.rejects(svc.defineLocation({ code: "", name: "X", type: "warehouse" }),         /code/);
  await assert.rejects(svc.defineLocation({ code: "  ", name: "X", type: "warehouse" }),       /code/);
  await assert.rejects(svc.defineLocation({ code: "BAD CODE", name: "X", type: "warehouse" }), /code/);
  // Bad name
  await assert.rejects(svc.defineLocation({ code: "A", name: "", type: "warehouse" }),         /name/);
  await assert.rejects(svc.defineLocation({ code: "A", name: 123, type: "warehouse" }),        /name/);
  // Bad type
  await assert.rejects(svc.defineLocation({ code: "A", name: "X", type: "factory" }),          /type/);
  await assert.rejects(svc.defineLocation({ code: "A", name: "X", type: null }),               /type/);
  // Bad priority
  await assert.rejects(svc.defineLocation({ code: "A", name: "X", type: "warehouse", priority: -1 }),  /priority/);
  await assert.rejects(svc.defineLocation({ code: "A", name: "X", type: "warehouse", priority: 1.5 }), /priority/);
  // Bad active
  await assert.rejects(svc.defineLocation({ code: "A", name: "X", type: "warehouse", active: "yes" }), /active/);
  // Bad address (non-object, non-string)
  await assert.rejects(svc.defineLocation({ code: "A", name: "X", type: "warehouse", address: 42 }),   /address/);
  // Address string that isn't JSON-parseable
  await assert.rejects(svc.defineLocation({ code: "A", name: "X", type: "warehouse", address: "{not json" }), /address/);

  // Duplicate code
  await svc.defineLocation({ code: "DUP", name: "X", type: "warehouse" });
  await assert.rejects(svc.defineLocation({ code: "DUP", name: "Y", type: "retail" }),         /already exists/);
}

async function _listGetUpdateDeactivate() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  var all = await svc.listLocations();
  check("listLocations returns three",          all.length === 3);
  check("listLocations ordered by priority",    all[0].code === "WH-EAST" && all[2].code === "STORE-NYC");

  // getLocation
  var east = await svc.getLocation("WH-EAST");
  check("getLocation returns shape",            east && east.code === "WH-EAST");
  var missing = await svc.getLocation("DOESNT-EXIST");
  check("getLocation miss returns null",        missing === null);
  await assert.rejects(svc.getLocation(""),                                                    /code/);

  // updateLocation — name + priority patch
  var patched = await svc.updateLocation("WH-EAST", { name: "East Warehouse v2", priority: 2 });
  check("updateLocation patches name",          patched.name === "East Warehouse v2");
  check("updateLocation patches priority",      patched.priority === 2);
  check("updateLocation preserves type",        patched.type === "warehouse");

  // updateLocation — refuse unknown
  await assert.rejects(svc.updateLocation("NO-SUCH", { name: "X" }),                           /not found/);
  // updateLocation — refuse bad patch
  await assert.rejects(svc.updateLocation("WH-EAST", { type: "factory" }),                     /type/);

  // updateLocation no-op patch returns the row unchanged
  var same = await svc.updateLocation("WH-EAST", {});
  check("updateLocation no-op returns row",     same.name === "East Warehouse v2");

  // active_only filter
  await svc.deactivateLocation("STORE-NYC");
  var active = await svc.listLocations({ active_only: true });
  check("active_only filters out deactivated",  active.length === 2);
  var hasNyc = active.some(function (l) { return l.code === "STORE-NYC"; });
  check("active_only excludes deactivated",     hasNyc === false);

  // deactivateLocation — refuse unknown
  await assert.rejects(svc.deactivateLocation("NO-SUCH"),                                      /not found/);

  // Deactivated location still resolves on getLocation
  var nyc = await svc.getLocation("STORE-NYC");
  check("deactivated row still resolves",       nyc && nyc.active === false);
}

async function _setStockArithmetic() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  // Initial set
  var r1 = await svc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  check("setStock initial quantity",            r1.quantity === 50);
  check("setStock initial delta vs 0",          r1.delta === 50);

  // Overwrite to a lower value
  var r2 = await svc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 30, reason: "shrinkage" });
  check("setStock overwrite quantity",          r2.quantity === 30);
  check("setStock overwrite delta is signed",   r2.delta === -20);

  // Audit log carries both rows
  var auditRows = (await q("SELECT * FROM inventory_adjustments WHERE sku = ?1 ORDER BY occurred_at ASC", ["WDG-1"])).rows;
  check("setStock writes audit row each call",  auditRows.length === 2);
  check("setStock audit captures initial delta", auditRows[0].delta === 50);
  check("setStock audit captures revised delta", auditRows[1].delta === -20);
  check("setStock audit captures reason",        auditRows[1].reason === "shrinkage");

  // Refusals
  await assert.rejects(svc.setStock(),                                                         /input object required/);
  await assert.rejects(svc.setStock({ sku: "", location_code: "WH-EAST", quantity: 5 }),       /sku/);
  await assert.rejects(svc.setStock({ sku: "WDG-1", location_code: "", quantity: 5 }),         /location_code/);
  await assert.rejects(svc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: -1 }), /quantity/);
  await assert.rejects(svc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 1.5 }),/quantity/);
  await assert.rejects(svc.setStock({ sku: "WDG-1", location_code: "NO-SUCH", quantity: 5 }),  /not found/);
}

async function _adjustStockArithmetic() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  // adjustStock from a zero row (no prior set) — delta becomes the
  // initial value.
  var r1 = await svc.adjustStock({ sku: "WDG-1", location_code: "WH-EAST", delta: 25 });
  check("adjustStock initial from zero",        r1.quantity === 25);
  // Add more
  var r2 = await svc.adjustStock({ sku: "WDG-1", location_code: "WH-EAST", delta: 10, reason: "received" });
  check("adjustStock additive",                 r2.quantity === 35);
  // Subtract
  var r3 = await svc.adjustStock({ sku: "WDG-1", location_code: "WH-EAST", delta: -15, reason: "sold" });
  check("adjustStock subtractive",              r3.quantity === 20);

  // Refuse delta=0
  await assert.rejects(svc.adjustStock({ sku: "WDG-1", location_code: "WH-EAST", delta: 0 }),  /non-zero/);
  // Refuse non-integer delta
  await assert.rejects(svc.adjustStock({ sku: "WDG-1", location_code: "WH-EAST", delta: 1.5 }), /delta/);
  // Refuse drive-negative
  await assert.rejects(svc.adjustStock({ sku: "WDG-1", location_code: "WH-EAST", delta: -100 }), /below zero/);
  // Stock unchanged after refusal
  var post = await svc.stockForSku("WDG-1");
  check("refused adjust leaves stock untouched", post.total === 20);
  // Unknown location
  await assert.rejects(svc.adjustStock({ sku: "WDG-1", location_code: "NO-SUCH", delta: 5 }),  /not found/);
}

async function _transferStockAtomicity() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  // Seed: 50 at WH-EAST, 10 at WH-WEST
  await svc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  await svc.setStock({ sku: "WDG-1", location_code: "WH-WEST", quantity: 10 });

  var preTotal = (await svc.stockForSku("WDG-1")).total;
  check("pre-transfer total",                    preTotal === 60);

  // Happy path: move 20 from EAST -> WEST
  var t = await svc.transferStock({
    sku: "WDG-1", from_location: "WH-EAST", to_location: "WH-WEST",
    quantity: 20, reason: "rebalance",
  });
  check("transferStock from_after",              t.from_after === 30);
  check("transferStock to_after",                t.to_after === 30);

  var postTotal = (await svc.stockForSku("WDG-1")).total;
  check("transfer preserves total (no money)",   postTotal === 60);

  // Audit pair
  var auditRows = (await q(
    "SELECT * FROM inventory_adjustments WHERE sku = ?1 AND reason = ?2 ORDER BY occurred_at ASC",
    ["WDG-1", "rebalance"],
  )).rows;
  check("transferStock writes audit pair",       auditRows.length === 2);
  var deltas = auditRows.map(function (r) { return r.delta; }).sort(function (a, b) { return a - b; });
  check("transferStock pair sums to zero",       deltas[0] + deltas[1] === 0);
  check("transferStock pair is signed",          deltas[0] === -20 && deltas[1] === 20);

  // Refuse insufficient stock — rows must be unchanged.
  var preWest = await svc.stockForSku("WDG-1");
  await assert.rejects(svc.transferStock({
    sku: "WDG-1", from_location: "WH-WEST", to_location: "WH-EAST", quantity: 9999,
  }), /insufficient stock/);
  var postWest = await svc.stockForSku("WDG-1");
  check("insufficient-stock leaves total",       preWest.total === postWest.total);

  // Refusals
  await assert.rejects(svc.transferStock(),                                                    /input object required/);
  await assert.rejects(svc.transferStock({
    sku: "WDG-1", from_location: "WH-EAST", to_location: "WH-EAST", quantity: 1,
  }), /must differ/);
  await assert.rejects(svc.transferStock({
    sku: "WDG-1", from_location: "WH-EAST", to_location: "WH-WEST", quantity: 0,
  }), /quantity/);
  await assert.rejects(svc.transferStock({
    sku: "WDG-1", from_location: "WH-EAST", to_location: "NO-SUCH", quantity: 1,
  }), /to_location/);
  await assert.rejects(svc.transferStock({
    sku: "WDG-1", from_location: "NO-SUCH", to_location: "WH-WEST", quantity: 1,
  }), /from_location/);
}

async function _stockAggregations() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  await svc.setStock({ sku: "WDG-1", location_code: "WH-EAST",   quantity: 50 });
  await svc.setStock({ sku: "WDG-1", location_code: "WH-WEST",   quantity: 25 });
  await svc.setStock({ sku: "WDG-1", location_code: "STORE-NYC", quantity:  3 });

  // stockForSku: total + by_location ordered by priority
  var sfs = await svc.stockForSku("WDG-1");
  check("stockForSku total",                     sfs.total === 78);
  check("stockForSku by_location count",         sfs.by_location.length === 3);
  check("stockForSku ordered by priority",
    sfs.by_location[0].code === "WH-EAST"  &&
    sfs.by_location[1].code === "WH-WEST"  &&
    sfs.by_location[2].code === "STORE-NYC",
  );

  // totalForSku
  var t = await svc.totalForSku("WDG-1");
  check("totalForSku scalar",                    t === 78);

  // Unknown SKU → empty
  var emptyT = await svc.totalForSku("DOESNT-EXIST");
  check("totalForSku unknown sku = 0",           emptyT === 0);
  var emptyS = await svc.stockForSku("DOESNT-EXIST");
  check("stockForSku unknown sku empty",         emptyS.total === 0 && emptyS.by_location.length === 0);

  // availableLocations excludes zero rows + inactive
  await svc.setStock({ sku: "WDG-1", location_code: "WH-WEST", quantity: 0 });
  await svc.deactivateLocation("STORE-NYC");
  var avail = await svc.availableLocations("WDG-1");
  check("availableLocations only nonzero+active", avail.length === 1 && avail[0].code === "WH-EAST");
}

async function _routePriorityFill() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  // Three SKUs spread across three locations.
  //   WDG-1: EAST=10, WEST=5, NYC=2 (total 17)
  //   WDG-2: EAST=0,  WEST=4, NYC=0 (total 4)
  //   WDG-3: EAST=0,  WEST=0, NYC=0 (out of stock)
  await svc.setStock({ sku: "WDG-1", location_code: "WH-EAST",   quantity: 10 });
  await svc.setStock({ sku: "WDG-1", location_code: "WH-WEST",   quantity:  5 });
  await svc.setStock({ sku: "WDG-1", location_code: "STORE-NYC", quantity:  2 });
  await svc.setStock({ sku: "WDG-2", location_code: "WH-WEST",   quantity:  4 });

  // Order: 15 WDG-1, 3 WDG-2, 1 WDG-3
  var r = await svc.routeOrder({
    lines: [
      { sku: "WDG-1", quantity: 15 },
      { sku: "WDG-2", quantity:  3 },
      { sku: "WDG-3", quantity:  1 },
    ],
  });

  // WDG-1 splits: EAST takes 10, WEST takes 5. NYC untouched.
  // WDG-2: WEST takes 3.
  // WDG-3: unfulfillable.
  var bySrcSku = {};
  for (var i = 0; i < r.allocation.length; i += 1) {
    var bucket = r.allocation[i];
    bySrcSku[bucket.location_code] = {};
    for (var j = 0; j < bucket.lines.length; j += 1) {
      bySrcSku[bucket.location_code][bucket.lines[j].sku] = bucket.lines[j].quantity;
    }
  }
  check("priority-fill WDG-1 EAST=10",            bySrcSku["WH-EAST"] && bySrcSku["WH-EAST"]["WDG-1"] === 10);
  check("priority-fill WDG-1 WEST=5",             bySrcSku["WH-WEST"] && bySrcSku["WH-WEST"]["WDG-1"] === 5);
  check("priority-fill WDG-2 WEST=3",             bySrcSku["WH-WEST"]["WDG-2"] === 3);
  check("priority-fill NYC untouched",            !bySrcSku["STORE-NYC"]);
  check("priority-fill unfulfillable count",      r.unfulfillable.length === 1);
  check("priority-fill unfulfillable WDG-3",
    r.unfulfillable[0].sku === "WDG-3" && r.unfulfillable[0].quantity === 1);

  // Allocation order: EAST (priority 1) before WEST (priority 5)
  check("priority-fill allocation ordered",       r.allocation[0].location_code === "WH-EAST" &&
                                                   r.allocation[1].location_code === "WH-WEST");

  // Inactive locations skipped: deactivate WEST, re-route → WDG-2 unfulfillable
  await svc.deactivateLocation("WH-WEST");
  var r2 = await svc.routeOrder({ lines: [{ sku: "WDG-2", quantity: 3 }] });
  check("priority-fill skips inactive",           r2.allocation.length === 0 && r2.unfulfillable[0].sku === "WDG-2");
}

async function _routeSingleLocationCheapest() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  // EAST has plenty, WEST has plenty, NYC has just barely.
  await svc.setStock({ sku: "WDG-1", location_code: "WH-EAST",   quantity: 100 });
  await svc.setStock({ sku: "WDG-1", location_code: "WH-WEST",   quantity:  50 });
  await svc.setStock({ sku: "WDG-1", location_code: "STORE-NYC", quantity:   8 });
  await svc.setStock({ sku: "WDG-2", location_code: "WH-EAST",   quantity:  10 });
  await svc.setStock({ sku: "WDG-2", location_code: "WH-WEST",   quantity:   2 });

  // Both lines fit at EAST (lowest priority). Picks EAST.
  var r = await svc.routeOrder({
    lines: [
      { sku: "WDG-1", quantity: 5 },
      { sku: "WDG-2", quantity: 5 },
    ],
    strategy: "single-location-cheapest",
  });
  check("single-location picks cheapest",         r.allocation.length === 1);
  check("single-location is WH-EAST",             r.allocation[0].location_code === "WH-EAST");
  check("single-location no unfulfillable",       r.unfulfillable.length === 0);
  check("single-location lines preserved",        r.allocation[0].lines.length === 2);

  // Now WDG-2 only has enough at WH-EAST; force a scenario where
  // ONLY one location fits both lines. WDG-1 at WEST=50 (fits 5);
  // WDG-2 at WEST=2 (doesn't fit 5). So EAST must win.
  // The above already covers it. Add a case where NO location can
  // fulfil both lines together.
  var r2 = await svc.routeOrder({
    lines: [
      { sku: "WDG-1", quantity: 9 },   // fits at EAST/WEST, not NYC (8)
      { sku: "WDG-2", quantity: 9 },   // fits only at EAST=10 (not WEST=2, NYC=0)
    ],
    strategy: "single-location-cheapest",
  });
  check("single-location still picks EAST",       r2.allocation.length === 1 && r2.allocation[0].location_code === "WH-EAST");

  // Drain EAST so no single location can cover both lines.
  await svc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 0 });
  var r3 = await svc.routeOrder({
    lines: [
      { sku: "WDG-1", quantity: 9 },
      { sku: "WDG-2", quantity: 9 },
    ],
    strategy: "single-location-cheapest",
  });
  check("single-location refuses splits",         r3.allocation.length === 0);
  check("single-location all unfulfillable",      r3.unfulfillable.length === 2);
}

async function _routeNearestByPostalPrefix() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  await svc.setStock({ sku: "WDG-1", location_code: "WH-EAST",   quantity: 10 });
  await svc.setStock({ sku: "WDG-1", location_code: "WH-WEST",   quantity: 10 });
  await svc.setStock({ sku: "WDG-1", location_code: "STORE-NYC", quantity: 10 });

  // Destination 10005 shares prefix "1000" with NYC (10003) and
  // EAST (10001) and nothing with WEST (94105). NYC and EAST tie
  // at 4 chars shared with "10005" → tiebreak goes to EAST
  // (priority 1 < NYC priority 10).
  var r = await svc.routeOrder({
    lines: [{ sku: "WDG-1", quantity: 5 }],
    strategy: "nearest-by-postal-prefix",
    strategyOpts: {
      destinationPostal: "10005",
      postalMap: { "WH-EAST": "10001", "WH-WEST": "94105", "STORE-NYC": "10003" },
    },
  });
  check("postal-prefix picks tied + lower priority", r.allocation[0].location_code === "WH-EAST");

  // Now route to 10003 → NYC shares full 5 chars; EAST only 4;
  // WEST 0. NYC wins.
  var r2 = await svc.routeOrder({
    lines: [{ sku: "WDG-1", quantity: 5 }],
    strategy: "nearest-by-postal-prefix",
    strategyOpts: {
      destinationPostal: "10003",
      postalMap: { "WH-EAST": "10001", "WH-WEST": "94105", "STORE-NYC": "10003" },
    },
  });
  check("postal-prefix picks longest shared prefix",  r2.allocation[0].location_code === "STORE-NYC");

  // Refusals
  await assert.rejects(svc.routeOrder({
    lines: [{ sku: "WDG-1", quantity: 1 }],
    strategy: "nearest-by-postal-prefix",
  }), /destinationPostal/);
  await assert.rejects(svc.routeOrder({
    lines: [{ sku: "WDG-1", quantity: 1 }],
    strategy: "nearest-by-postal-prefix",
    strategyOpts: { destinationPostal: "10005" },
  }), /postalMap/);
}

async function _routeRefusals() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  await assert.rejects(svc.routeOrder(),                                                       /input object required/);
  await assert.rejects(svc.routeOrder({ lines: [] }),                                          /lines must be a non-empty/);
  await assert.rejects(svc.routeOrder({ lines: [{ sku: "", quantity: 1 }] }),                  /sku/);
  await assert.rejects(svc.routeOrder({ lines: [{ sku: "WDG-1", quantity: 0 }] }),             /quantity/);
  await assert.rejects(svc.routeOrder({ lines: [{ sku: "WDG-1", quantity: 1 }], strategy: "weird" }), /strategy/);
}

async function _factoryRefusals() {
  // Missing catalog
  assert.throws(function () { inventoryLocations.create({}); },                                /catalog/);
  assert.throws(function () { inventoryLocations.create({ catalog: null }); },                 /catalog/);
}

async function _creditOnceIdempotent() {
  var q = _makeQuery();
  var svc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  // First credit applies; the audit row carries the key.
  var r1 = await svc.creditOnce({ sku: "WDG-1", location_code: "WH-EAST", delta: 12, idempotency_key: "k-1", reason: "transfer" });
  check("creditOnce applies the first credit",      r1.applied === true && r1.quantity === 12 && r1.delta === 12);

  // Replay with the same key is a no-op — no second credit, delta reported 0.
  var r2 = await svc.creditOnce({ sku: "WDG-1", location_code: "WH-EAST", delta: 12, idempotency_key: "k-1", reason: "transfer" });
  check("creditOnce replay is a no-op",             r2.applied === false && r2.delta === 0);
  var afterReplay = await svc.stockForSku("WDG-1");
  check("creditOnce replay leaves stock at 12",     afterReplay.total === 12);

  // A different key credits again.
  var r3 = await svc.creditOnce({ sku: "WDG-1", location_code: "WH-EAST", delta: 8, idempotency_key: "k-2" });
  check("creditOnce distinct key credits again",    r3.applied === true && r3.quantity === 20);

  // Exactly one audit row per key.
  var rows = (await q("SELECT COUNT(*) AS n FROM inventory_adjustments WHERE idempotency_key = ?1", ["k-1"])).rows[0];
  check("creditOnce writes one keyed audit row",    Number(rows.n) === 1);

  // Refusals: non-positive delta, missing/oversized key, unknown location.
  await assert.rejects(svc.creditOnce({ sku: "WDG-1", location_code: "WH-EAST", delta: 0, idempotency_key: "k-3" }),   /positive credit/);
  await assert.rejects(svc.creditOnce({ sku: "WDG-1", location_code: "WH-EAST", delta: -5, idempotency_key: "k-3" }),  /positive credit/);
  await assert.rejects(svc.creditOnce({ sku: "WDG-1", location_code: "WH-EAST", delta: 5 }),                            /idempotency_key/);
  await assert.rejects(svc.creditOnce({ sku: "WDG-1", location_code: "WH-EAST", delta: 5, idempotency_key: "" }),       /idempotency_key/);
  await assert.rejects(svc.creditOnce({ sku: "WDG-1", location_code: "NO-SUCH", delta: 5, idempotency_key: "k-4" }),    /not found/);
}

async function _creditOnceRollsBackClaimOnUpsertFailure() {
  // creditOnce claims by inserting the keyed audit row, then applies the stock
  // credit. If the upsert throws after the claim landed, the claim must be
  // rolled back so a retry re-applies the credit (rather than the key stranding
  // the credit at zero).
  var q = _makeQuery();
  var failNextUpsert = true;
  var qWrap = async function (sql, params) {
    if (failNextUpsert && /^\s*INSERT INTO inventory_stock/.test(sql)) {
      failNextUpsert = false;   // one-shot
      throw new Error("injected: stock upsert failed");
    }
    return q(sql, params);
  };
  var svc = inventoryLocations.create({ query: qWrap, catalog: _stubCatalog() });
  await _defineThreeLocations(svc);

  await assert.rejects(
    svc.creditOnce({ sku: "WDG-9", location_code: "WH-EAST", delta: 7, idempotency_key: "rb-1" }),
    /injected: stock upsert failed/);

  // The claim row was rolled back — no orphan key, no credit.
  var orphan = (await q("SELECT COUNT(*) AS n FROM inventory_adjustments WHERE idempotency_key = ?1", ["rb-1"])).rows[0];
  check("failed creditOnce leaves no orphan claim row", Number(orphan.n) === 0);
  var none = await svc.stockForSku("WDG-9");
  check("failed creditOnce credited nothing",           none.total === 0);

  // Retry now succeeds and credits exactly once.
  var ok = await svc.creditOnce({ sku: "WDG-9", location_code: "WH-EAST", delta: 7, idempotency_key: "rb-1" });
  check("retry after rollback credits once",            ok.applied === true && ok.quantity === 7);

  // A plain adjustStock (NULL key) and a keyed creditOnce never collide on the
  // idempotency index — different keys, independent credits.
  await svc.adjustStock({ sku: "WDG-9", location_code: "WH-EAST", delta: 3, reason: "manual" });
  var both = await svc.stockForSku("WDG-9");
  check("keyed credit + plain adjust coexist", both.total === 10);
}

async function run() {
  await _defineLocationHappyPath();
  await _defineLocationRefusals();
  await _listGetUpdateDeactivate();
  await _setStockArithmetic();
  await _adjustStockArithmetic();
  await _creditOnceIdempotent();
  await _creditOnceRollsBackClaimOnUpsertFailure();
  await _transferStockAtomicity();
  await _stockAggregations();
  await _routePriorityFill();
  await _routeSingleLocationCheapest();
  await _routeNearestByPostalPrefix();
  await _routeRefusals();
  await _factoryRefusals();
}

module.exports = { run: run };
