"use strict";
/**
 * reorder-thresholds — automated PO suggestion engine.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0098
 * (reorder_thresholds + sku_velocity). Catalog inventory + multi-
 * location inventory + vendors are stubbed at the dep boundary —
 * the primitive's contract with those neighbours is the narrow
 * verb set documented in its factory (catalog.inventory.get,
 * inventoryLocations.stockForSku) so a hand-rolled stub is the
 * tightest expression of the wiring this primitive depends on.
 *
 * Coverage:
 *   - defineThreshold: UNIQUE refusal on (sku, location_code)
 *     among active rows; archive frees the slot for redefinition
 *   - evaluate: at / above / below threshold returns the correct
 *     should_reorder flag, suggested_qty math, and days_of_supply
 *   - scanAll: filters to thresholds at-or-below their floor;
 *     vendor_slug + location_code narrowing
 *   - proposePurchaseOrder: aggregates scanAll candidates into a
 *     vendor-scoped draft, sums total_qty across lines
 *   - recordVelocity: appends rows; evaluate's windowed sum
 *     consumes them
 *   - velocity-driven suggested_qty: lead_time_days * units/day is
 *     added on top of the bare gap so the operator's restock
 *     survives the supplier lead
 *   - updateThreshold / archiveThreshold / listThresholds CRUD
 *     including refusal to drive reorder_to below min_stock
 *   - factory shape validation + per-verb input refusals
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// Require the module directly — this primitive is not yet wired
// into `lib/index.js`, and the test stays decoupled from export
// ordering either way.
var reorderThresholds = require("../../lib/reorder-thresholds");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0098_reorder_thresholds.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE" || verb === "ALTER") {
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
}

// Minimal catalog stub — the primitive only reads
// `catalog.inventory.get(sku)` and treats null as "no row → zero
// stock", and a present row's `stock_on_hand` as the global bucket.
function _stubCatalog(initial) {
  var byId = Object.assign({}, initial || {});
  return {
    inventory: {
      get: async function (sku) {
        var row = byId[sku];
        return row ? { sku: sku, stock_on_hand: row.stock_on_hand } : null;
      },
      set: function (sku, stockOnHand) { byId[sku] = { stock_on_hand: stockOnHand }; },
    },
  };
}

// Minimal inventoryLocations stub — the primitive only reads
// `stockForSku(sku)` and walks `by_location[].code / .quantity`.
function _stubInventoryLocations(map) {
  var stocks = Object.assign({}, map || {});
  return {
    stockForSku: async function (sku) {
      var byLoc = stocks[sku] || {};
      var locs = [];
      var total = 0;
      Object.keys(byLoc).forEach(function (code) {
        var qty = byLoc[code];
        locs.push({ code: code, quantity: qty });
        total += qty;
      });
      return { total: total, by_location: locs };
    },
    set: function (sku, code, qty) {
      if (!stocks[sku]) stocks[sku] = {};
      stocks[sku][code] = qty;
    },
  };
}

// Vendors are accepted purely for wiring; the primitive never reads
// from this stub. Shape only.
function _stubVendors() {
  return { list: async function () { return []; } };
}

// ---- 1. UNIQUE constraint refusal on (sku, location_code) --------------

async function _testDefineUniqueRefusal() {
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rt      = reorderThresholds.create({ catalog: catalog, query: query });

  var a = await rt.defineThreshold({
    sku: "SKU-ALPHA", min_stock: 5, reorder_to: 20, lead_time_days: 7,
    vendor_slug: "acme",
  });
  check("defineThreshold returns shaped row",        a && typeof a.id === "string");
  check("global row stored with null location_code", a.location_code === null);
  check("min_stock echoed",                          a.min_stock === 5);
  check("reorder_to echoed",                         a.reorder_to === 20);
  check("lead_time_days echoed",                     a.lead_time_days === 7);
  check("vendor_slug echoed",                        a.vendor_slug === "acme");
  check("created_at integer",                        Number.isInteger(a.created_at));
  check("updated_at integer",                        Number.isInteger(a.updated_at));
  check("archived_at null",                          a.archived_at === null);

  // Same (sku, NULL) — typed refusal up front.
  await assert.rejects(rt.defineThreshold({
    sku: "SKU-ALPHA", min_stock: 1, reorder_to: 2, lead_time_days: 1,
  }), /active threshold for sku/, "duplicate global pair refused");

  // Adding the SAME sku with a location_code is fine — different slot.
  var locA = await rt.defineThreshold({
    sku: "SKU-ALPHA", location_code: "WHSE-1",
    min_stock: 2, reorder_to: 10, lead_time_days: 3,
  });
  check("per-location row distinct from global", locA.id !== a.id);

  // Duplicate (sku, "WHSE-1") refused.
  await assert.rejects(rt.defineThreshold({
    sku: "SKU-ALPHA", location_code: "WHSE-1",
    min_stock: 1, reorder_to: 2, lead_time_days: 1,
  }), /active threshold for sku/, "duplicate per-location pair refused");

  // Archive the global → re-defining the global slot succeeds.
  await rt.archiveThreshold(a.id);
  var a2 = await rt.defineThreshold({
    sku: "SKU-ALPHA", min_stock: 9, reorder_to: 25, lead_time_days: 5,
  });
  check("archive frees the global slot for redefinition", a2.id !== a.id);
  check("new global row carries new min_stock",           a2.min_stock === 9);
}

// ---- 2. evaluate at / above / below threshold --------------------------

async function _testEvaluateAtAboveBelow() {
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rt      = reorderThresholds.create({ catalog: catalog, query: query });

  await rt.defineThreshold({
    sku: "SKU-EVAL", min_stock: 10, reorder_to: 50, lead_time_days: 0,
  });

  // ABOVE — current 100, min 10, no velocity → no reorder, qty 0.
  catalog.inventory.set("SKU-EVAL", 100);
  var above = await rt.evaluate({ sku: "SKU-EVAL" });
  check("above: current_stock 100",       above.current_stock === 100);
  check("above: should_reorder false",    above.should_reorder === false);
  check("above: suggested_qty 0",         above.suggested_qty === 0);
  check("above: days_of_supply null",     above.days_of_supply === null);
  check("above: lead_time_days echoed 0", above.lead_time_days === 0);
  check("above: min_stock echoed 10",     above.min_stock === 10);

  // AT — current 10, equals min → should_reorder true (<=).
  catalog.inventory.set("SKU-EVAL", 10);
  var at = await rt.evaluate({ sku: "SKU-EVAL" });
  check("at: should_reorder true (<=)", at.should_reorder === true);
  check("at: suggested_qty fills gap",  at.suggested_qty === 40); // reorder_to(50) - current(10)
  check("at: current_stock 10",         at.current_stock === 10);

  // BELOW — current 3, lead 0, no velocity → qty = gap (50 - 3 = 47).
  catalog.inventory.set("SKU-EVAL", 3);
  var below = await rt.evaluate({ sku: "SKU-EVAL" });
  check("below: should_reorder true",  below.should_reorder === true);
  check("below: suggested_qty = gap",  below.suggested_qty === 47);
  check("below: days_of_supply null (no velocity)", below.days_of_supply === null);

  // Unknown SKU → no threshold → typed refusal.
  await assert.rejects(rt.evaluate({ sku: "SKU-UNDEF" }), /no active threshold for sku/);
}

// ---- 3. scanAll narrows to at/below-threshold rows ---------------------

async function _testScanAllFilter() {
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rt      = reorderThresholds.create({ catalog: catalog, query: query });

  // Seed: 3 thresholds — A is below, B is above, C is below.
  await rt.defineThreshold({ sku: "SKU-A", min_stock: 5, reorder_to: 20, lead_time_days: 0, vendor_slug: "acme" });
  await rt.defineThreshold({ sku: "SKU-B", min_stock: 5, reorder_to: 20, lead_time_days: 0, vendor_slug: "acme" });
  await rt.defineThreshold({ sku: "SKU-C", min_stock: 5, reorder_to: 20, lead_time_days: 0, vendor_slug: "globex" });

  catalog.inventory.set("SKU-A", 1);   // below
  catalog.inventory.set("SKU-B", 100); // above
  catalog.inventory.set("SKU-C", 0);   // below

  var all = await rt.scanAll();
  check("scanAll returns only below-threshold rows", all.length === 2);
  var skus = all.map(function (r) { return r.sku; }).sort();
  check("scanAll skus = [A, C]", skus[0] === "SKU-A" && skus[1] === "SKU-C");
  // Each row carries the candidate shape.
  check("scanAll row has threshold_id",   typeof all[0].threshold_id === "string");
  check("scanAll row has suggested_qty",  Number.isInteger(all[0].suggested_qty));
  check("scanAll row has vendor_slug",    typeof all[0].vendor_slug === "string" || all[0].vendor_slug === null);

  // Vendor narrowing.
  var acme = await rt.scanAll({ vendor_slug: "acme" });
  check("scanAll vendor=acme → only SKU-A", acme.length === 1 && acme[0].sku === "SKU-A");

  var globex = await rt.scanAll({ vendor_slug: "globex" });
  check("scanAll vendor=globex → only SKU-C", globex.length === 1 && globex[0].sku === "SKU-C");

  // Archive → scanAll drops the row.
  var rows = await rt.listThresholds({ sku: "SKU-A" });
  await rt.archiveThreshold(rows[0].id);
  var afterArchive = await rt.scanAll();
  var stillThere = afterArchive.some(function (r) { return r.sku === "SKU-A"; });
  check("archived threshold dropped from scanAll", stillThere === false);
}

// ---- 4. proposePurchaseOrder aggregates per vendor ---------------------

async function _testProposePurchaseOrder() {
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rt      = reorderThresholds.create({ catalog: catalog, query: query });

  await rt.defineThreshold({ sku: "SKU-P1", min_stock: 5, reorder_to: 20, lead_time_days: 0, vendor_slug: "acme" });
  await rt.defineThreshold({ sku: "SKU-P2", min_stock: 5, reorder_to: 30, lead_time_days: 0, vendor_slug: "acme" });
  await rt.defineThreshold({ sku: "SKU-P3", min_stock: 5, reorder_to: 15, lead_time_days: 0, vendor_slug: "globex" });
  await rt.defineThreshold({ sku: "SKU-P4", min_stock: 5, reorder_to: 100, lead_time_days: 0, vendor_slug: "acme" });

  catalog.inventory.set("SKU-P1", 0);   // below — gap 20
  catalog.inventory.set("SKU-P2", 2);   // below — gap 28
  catalog.inventory.set("SKU-P3", 1);   // below — gap 14 — globex
  catalog.inventory.set("SKU-P4", 999); // above — skipped

  var po = await rt.proposePurchaseOrder({ vendor_slug: "acme" });
  check("PO vendor_slug echoed",          po.vendor_slug === "acme");
  check("PO line_count = 2",              po.line_count === 2);
  check("PO total_qty = 20 + 28 = 48",    po.total_qty === 48);
  check("PO lines length 2",              po.lines.length === 2);
  check("PO proposed_at integer",         Number.isInteger(po.proposed_at));
  // Lines carry the per-SKU breakdown.
  var byLine = {};
  po.lines.forEach(function (l) { byLine[l.sku] = l; });
  check("PO line P1 qty 20",              byLine["SKU-P1"].suggested_qty === 20);
  check("PO line P2 qty 28",              byLine["SKU-P2"].suggested_qty === 28);
  check("PO line P1 carries threshold_id", typeof byLine["SKU-P1"].threshold_id === "string");

  // Globex scope is a separate aggregate.
  var poGlobex = await rt.proposePurchaseOrder({ vendor_slug: "globex" });
  check("globex line_count = 1",          poGlobex.line_count === 1);
  check("globex total_qty = 14",          poGlobex.total_qty === 14);

  // Vendor with no candidates → empty draft, not an error.
  await rt.defineThreshold({ sku: "SKU-P5", min_stock: 0, reorder_to: 10, lead_time_days: 0, vendor_slug: "initech" });
  catalog.inventory.set("SKU-P5", 100); // above
  var empty = await rt.proposePurchaseOrder({ vendor_slug: "initech" });
  check("empty PO line_count 0",   empty.line_count === 0);
  check("empty PO total_qty 0",    empty.total_qty === 0);
  check("empty PO lines is array", Array.isArray(empty.lines) && empty.lines.length === 0);
}

// ---- 5. recordVelocity rolling-window sum ------------------------------

async function _testRecordVelocity() {
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rt      = reorderThresholds.create({ catalog: catalog, query: query });

  await rt.defineThreshold({
    sku: "SKU-VEL", min_stock: 5, reorder_to: 50, lead_time_days: 0,
  });

  // Fix an "as_of" so the window is deterministic.
  var DAY = 24 * 60 * 60 * 1000;
  var asOf = Date.now();

  // Record 60 units sold over the 10 days ending today → 6 units/day.
  var v = await rt.recordVelocity({
    sku:          "SKU-VEL",
    period_start: asOf - 10 * DAY,
    period_end:   asOf,
    units_sold:   60,
  });
  check("recordVelocity returns shaped row", v && typeof v.id === "string");
  check("recordVelocity echoes sku",         v.sku === "SKU-VEL");
  check("recordVelocity echoes units_sold",  v.units_sold === 60);
  check("recordVelocity null location_code", v.location_code === null);

  // Record an OLD row outside the 30d window — must be excluded.
  await rt.recordVelocity({
    sku:          "SKU-VEL",
    period_start: asOf - 200 * DAY,
    period_end:   asOf - 190 * DAY,
    units_sold:   9999,
  });

  // Make stock below threshold and check the velocity flows through.
  catalog.inventory.set("SKU-VEL", 4); // below min_stock(5)
  var ev = await rt.evaluate({ sku: "SKU-VEL", as_of: asOf });
  check("evaluate days_of_supply = floor(4/6) = 0", ev.days_of_supply === 0);
  // lead_time_days = 0 → buffer 0, so suggested_qty = gap = 50 - 4 = 46.
  check("evaluate suggested_qty = bare gap when lead 0", ev.suggested_qty === 46);
  check("evaluate should_reorder true",                  ev.should_reorder === true);

  // recordVelocity refusals.
  await assert.rejects(rt.recordVelocity({
    sku: "SKU-VEL", period_start: 100, period_end: 50, units_sold: 1,
  }), /period_end .* must be ≥ period_start/, "inverted window refused");
  await assert.rejects(rt.recordVelocity({
    sku: "SKU-VEL", period_start: 0, period_end: 10, units_sold: -1,
  }), /units_sold must be/, "negative units refused");
}

// ---- 6. velocity-driven suggested_qty math -----------------------------

async function _testVelocityDrivenSuggestedQty() {
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rt      = reorderThresholds.create({ catalog: catalog, query: query });

  await rt.defineThreshold({
    sku: "SKU-LEAD", min_stock: 10, reorder_to: 100, lead_time_days: 14,
  });

  var DAY = 24 * 60 * 60 * 1000;
  var asOf = Date.now();

  // 20 units sold over 10 days → 2 units/day.
  await rt.recordVelocity({
    sku:          "SKU-LEAD",
    period_start: asOf - 10 * DAY,
    period_end:   asOf,
    units_sold:   20,
  });

  catalog.inventory.set("SKU-LEAD", 4); // below min_stock(10)
  var ev = await rt.evaluate({ sku: "SKU-LEAD", as_of: asOf });

  // gap = reorder_to(100) - current(4) = 96
  // buffer = ceil(2 * 14) = 28
  // suggested = 96 + 28 = 124
  check("velocity-driven suggested_qty = gap + buffer", ev.suggested_qty === 124);
  // days_of_supply = floor(4 / 2) = 2
  check("velocity-driven days_of_supply",               ev.days_of_supply === 2);
  check("velocity-driven lead_time_days echoed",        ev.lead_time_days === 14);

  // Above threshold → buffer + gap are ignored entirely.
  catalog.inventory.set("SKU-LEAD", 500);
  var aboveEv = await rt.evaluate({ sku: "SKU-LEAD", as_of: asOf });
  check("above + velocity: suggested_qty 0", aboveEv.suggested_qty === 0);
  check("above + velocity: should_reorder false", aboveEv.should_reorder === false);
  check("above + velocity: days_of_supply 250",  aboveEv.days_of_supply === 250);
}

// ---- 7. updateThreshold / archiveThreshold / listThresholds ------------

async function _testCrud() {
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rt      = reorderThresholds.create({ catalog: catalog, query: query });

  var a = await rt.defineThreshold({
    sku: "SKU-CRUD-A", min_stock: 5, reorder_to: 20, lead_time_days: 3, vendor_slug: "acme",
  });
  var b = await rt.defineThreshold({
    sku: "SKU-CRUD-B", min_stock: 5, reorder_to: 20, lead_time_days: 3, vendor_slug: "globex",
  });
  var c = await rt.defineThreshold({
    sku: "SKU-CRUD-C", location_code: "WHSE-1",
    min_stock: 5, reorder_to: 20, lead_time_days: 3, vendor_slug: null,
  });

  // updateThreshold: patch min_stock + reorder_to + lead_time_days + vendor_slug.
  var updated = await rt.updateThreshold(a.id, {
    min_stock: 8, reorder_to: 30, lead_time_days: 10, vendor_slug: "initech",
  });
  check("updated min_stock",      updated.min_stock === 8);
  check("updated reorder_to",     updated.reorder_to === 30);
  check("updated lead_time_days", updated.lead_time_days === 10);
  check("updated vendor_slug",    updated.vendor_slug === "initech");
  check("updated_at moved",       updated.updated_at >= a.updated_at);

  // No-op patch returns the existing row.
  var noop = await rt.updateThreshold(a.id, {});
  check("no-op patch returns row", noop.id === a.id);

  // updateThreshold refuses reorder_to < min_stock.
  await assert.rejects(rt.updateThreshold(a.id, { reorder_to: 0 }),
    /reorder_to .* must be ≥ min_stock/, "patch refuses reorder_to below min_stock");

  // updateThreshold refuses unknown id.
  await assert.rejects(rt.updateThreshold("DOES-NOT-EXIST", { min_stock: 1 }),
    /not found/, "patch refuses unknown id");

  // archiveThreshold soft-deletes; idempotent re-archive.
  var arc = await rt.archiveThreshold(b.id);
  check("archived row archived_at integer", Number.isInteger(arc.archived_at));
  var arc2 = await rt.archiveThreshold(b.id);
  check("re-archive idempotent",            arc2.archived_at === arc.archived_at);

  // updateThreshold on an archived row refuses.
  await assert.rejects(rt.updateThreshold(b.id, { min_stock: 1 }),
    /archived/, "patch refuses archived row");

  // listThresholds: default excludes archived; include_archived=true brings it back.
  var live = await rt.listThresholds();
  var liveIds = live.map(function (r) { return r.id; });
  check("default list excludes archived",    liveIds.indexOf(b.id) === -1);
  check("default list includes a",           liveIds.indexOf(a.id) !== -1);
  check("default list includes c",           liveIds.indexOf(c.id) !== -1);

  var full = await rt.listThresholds({ include_archived: true });
  var fullIds = full.map(function (r) { return r.id; });
  check("include_archived restores b",       fullIds.indexOf(b.id) !== -1);

  // listThresholds filter by vendor_slug.
  var byVendor = await rt.listThresholds({ vendor_slug: "initech" });
  check("filter by vendor_slug",             byVendor.length === 1 && byVendor[0].id === a.id);

  // listThresholds filter by location_code: null = global rows only.
  var globals = await rt.listThresholds({ location_code: null });
  check("filter location_code=null → globals only",
    globals.every(function (r) { return r.location_code === null; }));

  // listThresholds filter by sku.
  var bySku = await rt.listThresholds({ sku: "SKU-CRUD-C" });
  check("filter by sku",                    bySku.length === 1 && bySku[0].id === c.id);
}

// ---- 8. factory shape + input validation refusals ----------------------

async function _testFactoryAndValidation() {
  var query   = _makeQuery();

  // Factory: catalog is required.
  assert.throws(function () { reorderThresholds.create({}); },                /catalog is required/);
  assert.throws(function () { reorderThresholds.create({ catalog: null }); }, /catalog is required/);
  // Factory: inventoryLocations + vendors must be objects when supplied.
  assert.throws(function () {
    reorderThresholds.create({ catalog: _stubCatalog(), inventoryLocations: "not-an-object" });
  }, /inventoryLocations must be/);
  assert.throws(function () {
    reorderThresholds.create({ catalog: _stubCatalog(), vendors: "not-an-object" });
  }, /vendors must be/);

  // Wired factories — confirm the deps land without throwing.
  var rt = reorderThresholds.create({
    catalog:            _stubCatalog(),
    inventoryLocations: _stubInventoryLocations(),
    vendors:            _stubVendors(),
    query:              query,
  });
  check("factory exposes VELOCITY_WINDOW_DAYS", rt.VELOCITY_WINDOW_DAYS === 30);
  check("module export carries the constant",   reorderThresholds.VELOCITY_WINDOW_DAYS === 30);

  // defineThreshold shape refusals.
  await assert.rejects(rt.defineThreshold(),           /input object required/);
  await assert.rejects(rt.defineThreshold(null),       /input object required/);
  await assert.rejects(rt.defineThreshold({ sku: "bad sku" }),
    /sku must match/);
  await assert.rejects(rt.defineThreshold({
    sku: "SKU-X", min_stock: -1, reorder_to: 0, lead_time_days: 0,
  }), /min_stock must be/);
  await assert.rejects(rt.defineThreshold({
    sku: "SKU-X", min_stock: 5, reorder_to: 2, lead_time_days: 0,
  }), /reorder_to .* must be ≥ min_stock/);
  await assert.rejects(rt.defineThreshold({
    sku: "SKU-X", min_stock: 0, reorder_to: 0, lead_time_days: -1,
  }), /lead_time_days must be/);
  await assert.rejects(rt.defineThreshold({
    sku: "SKU-X", min_stock: 0, reorder_to: 0, lead_time_days: 0, vendor_slug: "BAD UPPER",
  }), /vendor_slug must match/);
  await assert.rejects(rt.defineThreshold({
    sku: "SKU-X", location_code: "bad code with spaces",
    min_stock: 0, reorder_to: 0, lead_time_days: 0,
  }), /location_code must match/);

  // evaluate refusals.
  await assert.rejects(rt.evaluate(),                            /input object required/);
  await assert.rejects(rt.evaluate({ sku: "bad sku" }),           /sku must match/);
  // Seed a threshold so the as_of check is reached before the "no
  // active threshold" guard short-circuits.
  await rt.defineThreshold({ sku: "SKU-OK", min_stock: 0, reorder_to: 0, lead_time_days: 0 });
  await assert.rejects(rt.evaluate({ sku: "SKU-OK", as_of: -1 }), /as_of must be/);

  // scanAll refusals.
  await assert.rejects(rt.scanAll({ limit: 0 }),                     /limit must be/);
  await assert.rejects(rt.scanAll({ limit: 1001 }),                  /limit must be/);
  await assert.rejects(rt.scanAll({ as_of: -1 }),                    /as_of must be/);
  await assert.rejects(rt.scanAll({ vendor_slug: "BAD UPPER" }),     /vendor_slug must match/);
  await assert.rejects(rt.scanAll({ location_code: "bad code" }),    /location_code must match/);

  // proposePurchaseOrder refusals.
  await assert.rejects(rt.proposePurchaseOrder(),                   /input object required/);
  await assert.rejects(rt.proposePurchaseOrder({}),                 /vendor_slug must match/);
  await assert.rejects(rt.proposePurchaseOrder({ vendor_slug: "" }), /vendor_slug must match/);

  // recordVelocity refusals.
  await assert.rejects(rt.recordVelocity(),                                          /input object required/);
  await assert.rejects(rt.recordVelocity({ sku: "bad sku" }),                        /sku must match/);
  await assert.rejects(rt.recordVelocity({
    sku: "SKU-V", period_start: -1, period_end: 0, units_sold: 0,
  }), /period_start must be/);

  // updateThreshold / archiveThreshold id-shape refusals.
  await assert.rejects(rt.updateThreshold("bad id with spaces", {}), /threshold_id must match/);
  await assert.rejects(rt.archiveThreshold("bad id with spaces"),    /threshold_id must match/);
  await assert.rejects(rt.archiveThreshold("does-not-exist"),        /not found/);
}

// ---- 9. per-location stock + inventoryLocations wiring -----------------

async function _testPerLocationStock() {
  // The per-location path requires the inventoryLocations dep; the
  // primitive raises a typed error when an operator defines a per-
  // location threshold without wiring it.
  var query   = _makeQuery();
  var catalog = _stubCatalog();
  var rtNoLocs = reorderThresholds.create({ catalog: catalog, query: query });

  await rtNoLocs.defineThreshold({
    sku: "SKU-LOC", location_code: "WHSE-1",
    min_stock: 5, reorder_to: 20, lead_time_days: 0,
  });
  await assert.rejects(rtNoLocs.evaluate({ sku: "SKU-LOC", location_code: "WHSE-1" }),
    /opts\.inventoryLocations was not wired/);

  // Wired path resolves the per-location quantity.
  var query2   = _makeQuery();
  var catalog2 = _stubCatalog();
  var locs     = _stubInventoryLocations();
  var rt = reorderThresholds.create({ catalog: catalog2, inventoryLocations: locs, query: query2 });

  await rt.defineThreshold({
    sku: "SKU-LOC", location_code: "WHSE-1",
    min_stock: 5, reorder_to: 20, lead_time_days: 0,
  });
  locs.set("SKU-LOC", "WHSE-1", 2);
  locs.set("SKU-LOC", "WHSE-2", 999);

  var ev = await rt.evaluate({ sku: "SKU-LOC", location_code: "WHSE-1" });
  check("per-location read picks the WHSE-1 row", ev.current_stock === 2);
  check("per-location should_reorder true",        ev.should_reorder === true);
  check("per-location suggested_qty = gap",        ev.suggested_qty === 18);

  // Unknown location_code on the SKU → quantity treated as zero.
  await rt.defineThreshold({
    sku: "SKU-LOC", location_code: "WHSE-2",
    min_stock: 5, reorder_to: 20, lead_time_days: 0,
  });
  // Set WHSE-2 to be above the threshold so this row is not below.
  // (Already 999 above.) Verify evaluation is above.
  var ev2 = await rt.evaluate({ sku: "SKU-LOC", location_code: "WHSE-2" });
  check("WHSE-2 above threshold", ev2.should_reorder === false);
}

async function run() {
  await _testDefineUniqueRefusal();
  await _testEvaluateAtAboveBelow();
  await _testScanAllFilter();
  await _testProposePurchaseOrder();
  await _testRecordVelocity();
  await _testVelocityDrivenSuggestedQty();
  await _testCrud();
  await _testFactoryAndValidation();
  await _testPerLocationStock();
  console.log("reorder-thresholds.test.js: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: run };

if (require.main === module) {
  run().catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
