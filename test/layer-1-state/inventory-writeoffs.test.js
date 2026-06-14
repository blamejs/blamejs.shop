"use strict";
/**
 * inventory-writeoffs — operator-recorded stock removal for damage /
 * loss / shrinkage / expiry / recall / sample / QC / theft.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0034
 * (inventory locations + stock + adjustments) and migration 0138
 * (inventory_writeoffs).
 *
 * Coverage:
 *   - recordWriteoff per reason: every enum value lands a row,
 *     status='recorded', actor + notes captured
 *   - debits stock via the wired inventoryLocations stub
 *   - costLayers integration via stub: cost_impact_minor + currency
 *     populated when wired; consumeForSale receives synthetic order_id
 *   - costLayers refusal at recordWriteoff rolls back the shelf debit
 *   - listWriteoffs filters: from/to / reason / location_code
 *   - costImpactForPeriod aggregates per reason + grand total;
 *     excludes reversed rows; refuses mixed currencies
 *   - reverseWriteoff restores stock + calls costLayers.recordReversal;
 *     refuses double-reverse
 *   - factory refusals: missing inventoryLocations; partial costLayers
 *   - strict-monotonic occurred_at per SKU
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var inventoryWriteoffs = require("../../lib/inventory-writeoffs");
var inventoryLocations = require("../../lib/inventory-locations");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0034_inventory_locations.sql",
  "0138_inventory_writeoffs.sql",
  // recordWriteoff debits the shelf with respect_holds, which reads
  // inventory_holds to refuse over-debiting below the paid-hold sum.
  "0152_inventory_allocations.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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

function _stubCatalog() { return {}; }

// Build a fully-wired svc + locations pair. Optionally inject a
// costLayers stub.
async function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var locSvc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await locSvc.defineLocation({ code: "WH-EAST",   name: "East WH",  type: "warehouse", priority: 1 });
  await locSvc.defineLocation({ code: "WH-WEST",   name: "West WH",  type: "warehouse", priority: 5 });
  await locSvc.defineLocation({ code: "STORE-NYC", name: "NYC",      type: "retail",    priority: 10 });
  var svcOpts = { query: q, inventoryLocations: locSvc };
  if (opts.costLayers !== undefined) svcOpts.costLayers = opts.costLayers;
  var svc = inventoryWriteoffs.create(svcOpts);
  return { q: q, locSvc: locSvc, svc: svc };
}

// Build a costLayers stub that records every consumeForSale /
// recordReversal call into an in-test buffer. `cogsByQty` controls
// the per-unit cost the stub returns so the test can assert the
// rolled-up cost_impact_minor.
function _stubCostLayers(opts) {
  opts = opts || {};
  var cogsPerUnit  = opts.cogsPerUnit  == null ? 1234 : opts.cogsPerUnit;
  var currency     = opts.currency     == null ? "USD" : opts.currency;
  var rejectNext   = false;
  var rejectError  = null;
  var consumed     = [];
  var reversed     = [];
  return {
    consumeForSale: async function (in_) {
      if (rejectNext) {
        rejectNext = false;
        throw rejectError;
      }
      consumed.push(in_);
      return {
        consumed_layers:   [{ layer_id: "stub-layer", qty: in_.quantity, unit_cost_minor: cogsPerUnit, currency: currency }],
        total_cogs_minor:  in_.quantity * cogsPerUnit,
        currency:          currency,
      };
    },
    recordReversal: async function (in_) {
      reversed.push(in_);
      return {
        restored_layers: [{
          sku:             in_.sku || "(unknown)",
          qty:             1,
          unit_cost_minor: cogsPerUnit,
          currency:        currency,
        }],
        reason: in_.reason,
      };
    },
    _consumed:  consumed,
    _reversed:  reversed,
    _rejectOnce: function (err) { rejectNext = true; rejectError = err; },
  };
}

async function _recordWriteoffPerReason() {
  var wired = await _wire();
  var locSvc = wired.locSvc, svc = wired.svc;

  // Seed enough stock on the shelf to cover every reason.
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 200 });

  var REASONS = ["damaged", "lost", "shrinkage", "expired",
    "recall", "sample", "quality_control", "theft"];
  for (var i = 0; i < REASONS.length; i += 1) {
    var w = await svc.recordWriteoff({
      sku:           "WDG-1",
      location_code: "WH-EAST",
      quantity:      2,
      reason:        REASONS[i],
      actor:         "alice@example.com",
      notes:         "test " + REASONS[i],
    });
    check("recordWriteoff[" + REASONS[i] + "] returns id",   typeof w.id === "string" && w.id.length > 0);
    check("recordWriteoff[" + REASONS[i] + "] reason",       w.reason === REASONS[i]);
    check("recordWriteoff[" + REASONS[i] + "] status",       w.status === "recorded");
    check("recordWriteoff[" + REASONS[i] + "] actor",        w.actor === "alice@example.com");
    check("recordWriteoff[" + REASONS[i] + "] qty",          w.quantity === 2);
    check("recordWriteoff[" + REASONS[i] + "] occurred_at",  typeof w.occurred_at === "number" && w.occurred_at > 0);
    check("recordWriteoff[" + REASONS[i] + "] cost_impact",  w.cost_impact_minor == null);   // no costLayers wired
  }
  // Stock debited by 8 reasons * 2 qty = 16
  var s = await locSvc.stockForSku("WDG-1");
  var atEast = s.by_location.find(function (l) { return l.code === "WH-EAST"; });
  check("recordWriteoff debits cumulative",                  atEast && atEast.quantity === 200 - REASONS.length * 2);

  // Refusals
  await assert.rejects(svc.recordWriteoff(),                                                       /input object required/);
  await assert.rejects(svc.recordWriteoff({}),                                                     /sku/);
  await assert.rejects(svc.recordWriteoff({ sku: "WDG-1", quantity: 1, reason: "bogus",
    actor: "a@b.com" }),                                                                           /reason/);
  await assert.rejects(svc.recordWriteoff({ sku: "WDG-1", quantity: 0, reason: "damaged",
    actor: "a@b.com" }),                                                                           /quantity/);
  await assert.rejects(svc.recordWriteoff({ sku: "WDG-1", quantity: 1, reason: "damaged",
    actor: "" }),                                                                                  /actor/);
  // Insufficient stock at the shelf — adjustStock refuses, no row written
  await assert.rejects(svc.recordWriteoff({ sku: "WDG-1", location_code: "WH-EAST",
    quantity: 9999, reason: "damaged", actor: "a@b.com" }),                                        /below zero/);
}

async function _debitsStockViaInventoryLocations() {
  // Use a stub inventoryLocations so we can assert the exact call
  // shape (delta sign, reason string format).
  var calls = [];
  var stubLocs = {
    adjustStock: async function (in_) {
      calls.push(Object.assign({}, in_));
      return { sku: in_.sku, location_code: in_.location_code, quantity: 0, delta: in_.delta };
    },
  };
  var q = _makeQuery();
  var svc = inventoryWriteoffs.create({ query: q, inventoryLocations: stubLocs });

  var w = await svc.recordWriteoff({
    sku:           "WDG-1",
    location_code: "WH-EAST",
    quantity:      5,
    reason:        "damaged",
    actor:         "alice@example.com",
  });
  check("adjustStock called once",        calls.length === 1);
  check("adjustStock sku",                calls[0].sku === "WDG-1");
  check("adjustStock location",           calls[0].location_code === "WH-EAST");
  check("adjustStock delta negative",     calls[0].delta === -5);
  check("adjustStock reason embeds id",   calls[0].reason === "writeoff:damaged:" + w.id);

  // Null location_code: no adjustStock call
  calls.length = 0;
  var w2 = await svc.recordWriteoff({
    sku:      "WDG-2",
    quantity: 1,
    reason:   "shrinkage",
    actor:    "alice@example.com",
  });
  check("null location skips adjustStock", calls.length === 0);
  check("null location persists row",      w2 && w2.location_code == null);
}

async function _costLayersIntegration() {
  var stub = _stubCostLayers({ cogsPerUnit: 500, currency: "EUR" });
  var wired = await _wire({ costLayers: stub });
  var locSvc = wired.locSvc, svc = wired.svc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 100 });

  var w = await svc.recordWriteoff({
    sku:           "WDG-1",
    location_code: "WH-EAST",
    quantity:      4,
    reason:        "expired",
    actor:         "bob@example.com",
  });
  check("cost_impact_minor populated",    w.cost_impact_minor === 4 * 500);
  check("currency populated",             w.currency === "EUR");
  check("consumeForSale called",          stub._consumed.length === 1);
  check("consumeForSale sku",             stub._consumed[0].sku === "WDG-1");
  check("consumeForSale qty",             stub._consumed[0].quantity === 4);
  check("consumeForSale synthetic order", stub._consumed[0].order_id === "writeoff:" + w.id);
  check("consumeForSale line_id=1",       stub._consumed[0].line_id === "1");

  // costLayers refusal rolls back the shelf debit + does not write a row
  var stub2 = _stubCostLayers();
  var wired2 = await _wire({ costLayers: stub2 });
  await wired2.locSvc.setStock({ sku: "WDG-X", location_code: "WH-EAST", quantity: 10 });
  stub2._rejectOnce(new TypeError("cost-layers.consumeForSale: insufficient on-hand for sku \"WDG-X\""));
  await assert.rejects(wired2.svc.recordWriteoff({
    sku:           "WDG-X",
    location_code: "WH-EAST",
    quantity:      3,
    reason:        "damaged",
    actor:         "alice@example.com",
  }), /insufficient on-hand/);
  var s = await wired2.locSvc.stockForSku("WDG-X");
  check("costLayers refusal: shelf restored", s.by_location[0].quantity === 10);
  var rows = (await wired2.q("SELECT COUNT(*) AS n FROM inventory_writeoffs", [])).rows[0];
  check("costLayers refusal: no header row",  Number(rows.n) === 0);
}

async function _listWriteoffsFilters() {
  var stub = _stubCostLayers({ cogsPerUnit: 100, currency: "USD" });
  var wired = await _wire({ costLayers: stub });
  var locSvc = wired.locSvc, svc = wired.svc;
  await locSvc.setStock({ sku: "WDG-A", location_code: "WH-EAST", quantity: 100 });
  await locSvc.setStock({ sku: "WDG-A", location_code: "WH-WEST", quantity: 100 });
  await locSvc.setStock({ sku: "WDG-B", location_code: "WH-EAST", quantity: 100 });

  var t0 = Date.now();
  await svc.recordWriteoff({ sku: "WDG-A", location_code: "WH-EAST", quantity: 2,
    reason: "damaged",  actor: "a", occurred_at: t0 + 100 });
  await svc.recordWriteoff({ sku: "WDG-A", location_code: "WH-WEST", quantity: 3,
    reason: "shrinkage", actor: "a", occurred_at: t0 + 200 });
  await svc.recordWriteoff({ sku: "WDG-B", location_code: "WH-EAST", quantity: 5,
    reason: "damaged",  actor: "a", occurred_at: t0 + 300 });
  await svc.recordWriteoff({ sku: "WDG-A", location_code: "WH-EAST", quantity: 1,
    reason: "expired",  actor: "a", occurred_at: t0 + 400 });

  // No filters — every row, newest first
  var all = await svc.listWriteoffs();
  check("listWriteoffs all rows",             all.rows.length === 4);
  check("listWriteoffs DESC order",
    all.rows[0].occurred_at > all.rows[1].occurred_at &&
    all.rows[1].occurred_at > all.rows[2].occurred_at &&
    all.rows[2].occurred_at > all.rows[3].occurred_at);

  // by reason
  var dmg = await svc.listWriteoffs({ reason: "damaged" });
  check("listWriteoffs reason filter",        dmg.rows.length === 2 &&
    dmg.rows.every(function (r) { return r.reason === "damaged"; }));

  // by location_code
  var east = await svc.listWriteoffs({ location_code: "WH-EAST" });
  check("listWriteoffs location filter",      east.rows.length === 3 &&
    east.rows.every(function (r) { return r.location_code === "WH-EAST"; }));

  // by period
  var mid = await svc.listWriteoffs({ from: t0 + 150, to: t0 + 350 });
  check("listWriteoffs period filter",        mid.rows.length === 2);

  // Combined: reason + location
  var both = await svc.listWriteoffs({ reason: "damaged", location_code: "WH-EAST" });
  check("listWriteoffs combined filter",      both.rows.length === 2 &&
    both.rows.every(function (r) { return r.reason === "damaged" && r.location_code === "WH-EAST"; }));

  // Limit + cursor pagination
  var page1 = await svc.listWriteoffs({ limit: 2 });
  check("listWriteoffs limit",                page1.rows.length === 2);
  check("listWriteoffs next cursor present",  typeof page1.next_cursor === "string");
  var page2 = await svc.listWriteoffs({ limit: 2, cursor: page1.next_cursor });
  check("listWriteoffs cursor page",          page2.rows.length === 2);
  check("listWriteoffs cursor disjoint",
    page1.rows[0].id !== page2.rows[0].id &&
    page1.rows[1].id !== page2.rows[1].id);

  // Refusals
  await assert.rejects(svc.listWriteoffs({ reason: "bogus" }),                                     /reason/);
  await assert.rejects(svc.listWriteoffs({ location_code: "!!!" }),                                /location_code/);
  await assert.rejects(svc.listWriteoffs({ limit: 9999 }),                                         /limit/);
  await assert.rejects(svc.listWriteoffs({ cursor: "garbage" }),                                   /cursor/);
}

async function _costImpactForPeriod() {
  var stub = _stubCostLayers({ cogsPerUnit: 1000, currency: "USD" });
  var wired = await _wire({ costLayers: stub });
  var locSvc = wired.locSvc, svc = wired.svc;
  await locSvc.setStock({ sku: "WDG-A", location_code: "WH-EAST", quantity: 100 });

  var t0 = Date.now();
  await svc.recordWriteoff({ sku: "WDG-A", location_code: "WH-EAST", quantity: 2,
    reason: "damaged",  actor: "a", occurred_at: t0 + 100 });   // 2000
  await svc.recordWriteoff({ sku: "WDG-A", location_code: "WH-EAST", quantity: 3,
    reason: "damaged",  actor: "a", occurred_at: t0 + 200 });   // 3000
  await svc.recordWriteoff({ sku: "WDG-A", location_code: "WH-EAST", quantity: 5,
    reason: "shrinkage", actor: "a", occurred_at: t0 + 300 });  // 5000
  await svc.recordWriteoff({ sku: "WDG-A", location_code: "WH-EAST", quantity: 1,
    reason: "expired",  actor: "a", occurred_at: t0 + 400 });   // 1000

  // Whole-period aggregation
  var all = await svc.costImpactForPeriod({ from: t0, to: t0 + 1000 });
  check("costImpactForPeriod grand total",    all.total_cost_impact_minor === 2000 + 3000 + 5000 + 1000);
  check("costImpactForPeriod currency",       all.currency === "USD");
  var byReason = {};
  all.by_reason.forEach(function (r) { byReason[r.reason] = r.total_cogs_minor; });
  check("costImpactForPeriod damaged sum",    byReason.damaged === 5000);
  check("costImpactForPeriod shrinkage sum",  byReason.shrinkage === 5000);
  check("costImpactForPeriod expired sum",    byReason.expired === 1000);

  // Filtered by reason
  var dmg = await svc.costImpactForPeriod({ from: t0, to: t0 + 1000, reason: "damaged" });
  check("costImpactForPeriod reason filter",  dmg.total_cost_impact_minor === 5000);

  // Narrowed window
  var narrow = await svc.costImpactForPeriod({ from: t0 + 250, to: t0 + 500 });
  check("costImpactForPeriod narrow window",  narrow.total_cost_impact_minor === 5000 + 1000);

  // Refusals
  await assert.rejects(svc.costImpactForPeriod(),                                                  /input object required/);
  await assert.rejects(svc.costImpactForPeriod({ from: t0 }),                                      /from and to are required/);
  await assert.rejects(svc.costImpactForPeriod({ from: t0 + 500, to: t0 + 100 }),                  /to must be > from/);

  // Empty period
  var empty = await svc.costImpactForPeriod({ from: t0 + 5000, to: t0 + 6000 });
  check("costImpactForPeriod empty period",   empty.total_cost_impact_minor === 0 && empty.currency === null);

  // Mixed-currency refusal: hand-insert a row with EUR
  await wired.q(
    "INSERT INTO inventory_writeoffs (id, sku, quantity, reason, actor, " +
    "cost_impact_minor, currency, status, occurred_at) " +
    "VALUES ('01999999-9999-7999-8999-000000000001', 'WDG-Z', 1, 'damaged', 'a', " +
    "999, 'EUR', 'recorded', ?1)",
    [t0 + 150],
  );
  await assert.rejects(svc.costImpactForPeriod({ from: t0, to: t0 + 1000 }),                       /multiple currencies/);
}

async function _reverseWriteoffRestores() {
  var stub = _stubCostLayers({ cogsPerUnit: 700, currency: "USD" });
  var wired = await _wire({ costLayers: stub });
  var locSvc = wired.locSvc, svc = wired.svc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });

  var w = await svc.recordWriteoff({
    sku:           "WDG-1",
    location_code: "WH-EAST",
    quantity:      6,
    reason:        "damaged",
    actor:         "alice@example.com",
  });
  // Pre-reverse: shelf at 44
  var s1 = await locSvc.stockForSku("WDG-1");
  check("pre-reverse shelf debited",          s1.by_location[0].quantity === 44);

  var r = await svc.reverseWriteoff({ id: w.id, reason: "miscounted; unit was found" });
  check("reverseWriteoff status reversed",    r.status === "reversed");
  check("reverseWriteoff reason captured",    r.reverse_reason === "miscounted; unit was found");
  check("reverseWriteoff reversed_at set",    typeof r.reversed_at === "number" && r.reversed_at > 0);

  // Post-reverse: shelf restored to 50
  var s2 = await locSvc.stockForSku("WDG-1");
  check("post-reverse shelf restored",        s2.by_location[0].quantity === 50);

  // recordReversal called on costLayers
  check("recordReversal called once",         stub._reversed.length === 1);
  check("recordReversal order_id",            stub._reversed[0].order_id === "writeoff:" + w.id);
  check("recordReversal line_id",             stub._reversed[0].line_id === "1");
  check("recordReversal reason",              stub._reversed[0].reason === "miscounted; unit was found");

  // Cannot double-reverse
  await assert.rejects(svc.reverseWriteoff({ id: w.id, reason: "again" }),                         /only recorded writeoffs/);

  // Reverse a write-off without costLayers attribution: still
  // restores the shelf and marks reversed, recordReversal NOT called.
  var stub2 = _stubCostLayers();
  // Don't wire costLayers — cost_impact stays NULL
  var bare = await _wire();
  await bare.locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 20 });
  var w2 = await bare.svc.recordWriteoff({
    sku:           "WDG-2",
    location_code: "WH-EAST",
    quantity:      3,
    reason:        "lost",
    actor:         "a@b.com",
  });
  check("bare writeoff cost_impact null",     w2.cost_impact_minor == null);
  var rev2 = await bare.svc.reverseWriteoff({ id: w2.id, reason: "found in storeroom" });
  check("bare reverseWriteoff status",        rev2.status === "reversed");
  var s3 = await bare.locSvc.stockForSku("WDG-2");
  check("bare reverseWriteoff restores",      s3.by_location[0].quantity === 20);
  check("bare reverseWriteoff no costLayers", stub2._reversed.length === 0);

  // Null-location writeoff: reverse does not call adjustStock
  var locCalls = [];
  var trackingLocs = {
    adjustStock: async function (in_) {
      locCalls.push(in_);
      // delegate to real svc to keep state consistent
      return await bare.locSvc.adjustStock(in_);
    },
  };
  var svc3 = inventoryWriteoffs.create({
    query: bare.q,
    inventoryLocations: trackingLocs,
  });
  var w3 = await svc3.recordWriteoff({
    sku:      "WDG-3",
    quantity: 1,
    reason:   "sample",
    actor:    "a",
  });
  check("null-loc record skips adjustStock",  locCalls.length === 0);
  await svc3.reverseWriteoff({ id: w3.id, reason: "returned" });
  check("null-loc reverse skips adjustStock", locCalls.length === 0);

  // Refusals
  await assert.rejects(svc.reverseWriteoff(),                                                      /input object required/);
  await assert.rejects(svc.reverseWriteoff({ id: w.id }),                                          /reason/);
  await assert.rejects(svc.reverseWriteoff({ id: "01999999-9999-7999-8999-999999999999",
    reason: "test" }),                                                                             /not found/);
}

async function _factoryRefusals() {
  // Missing inventoryLocations
  assert.throws(function () { inventoryWriteoffs.create({}); },                                    /inventoryLocations/);
  assert.throws(function () { inventoryWriteoffs.create({ inventoryLocations: null }); },          /inventoryLocations/);
  assert.throws(function () { inventoryWriteoffs.create({
    inventoryLocations: { /* no adjustStock */ },
  }); },                                                                                            /adjustStock/);

  // Partial costLayers
  assert.throws(function () {
    inventoryWriteoffs.create({
      inventoryLocations: { adjustStock: function () {} },
      costLayers:         { consumeForSale: function () {} /* missing recordReversal */ },
    });
  }, /recordReversal/);

  // cursorSecret required in production
  var origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(function () {
      inventoryWriteoffs.create({
        inventoryLocations: { adjustStock: function () {} },
      });
    }, /cursorSecret is required/);
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
  }
}

async function _monotonicClockPerSku() {
  var wired = await _wire();
  var locSvc = wired.locSvc, svc = wired.svc;
  await locSvc.setStock({ sku: "WDG-M", location_code: "WH-EAST", quantity: 100 });

  // Three writeoffs in the same millisecond — monotonic bump keeps
  // them strictly ordered.
  var ts = Date.now();
  var a = await svc.recordWriteoff({ sku: "WDG-M", location_code: "WH-EAST", quantity: 1,
    reason: "damaged", actor: "a", occurred_at: ts });
  var b = await svc.recordWriteoff({ sku: "WDG-M", location_code: "WH-EAST", quantity: 1,
    reason: "damaged", actor: "a", occurred_at: ts });
  var c = await svc.recordWriteoff({ sku: "WDG-M", location_code: "WH-EAST", quantity: 1,
    reason: "damaged", actor: "a", occurred_at: ts });
  check("monotonic: a < b",                   a.occurred_at < b.occurred_at);
  check("monotonic: b < c",                   b.occurred_at < c.occurred_at);
  check("monotonic: a == requested",          a.occurred_at === ts);

  // A different SKU gets its own monotonic stream — the timestamp on
  // WDG-N is not influenced by WDG-M's bumps.
  await locSvc.setStock({ sku: "WDG-N", location_code: "WH-EAST", quantity: 100 });
  var d = await svc.recordWriteoff({ sku: "WDG-N", location_code: "WH-EAST", quantity: 1,
    reason: "damaged", actor: "a", occurred_at: ts });
  check("monotonic per-sku independence",     d.occurred_at === ts);
}

// Seed a single live hold row directly so the test can assert
// recordWriteoff's respect_holds floor without standing up the full
// allocations primitive. Mirrors the inventory_holds schema from
// migration 0152.
async function _seedHeld(q, opts) {
  await q(
    "INSERT INTO inventory_holds (id, cart_id, sku, variant_id, location_code, " +
    "quantity, status, ttl_seconds, expires_at, created_at) " +
    "VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'held', 600, ?6, ?7)",
    [
      require("../../lib/vendor/blamejs").uuid.v7(),
      opts.cart_id || "cart-1",
      opts.sku,
      opts.location_code == null ? null : opts.location_code,
      opts.quantity,
      (opts.created_at || Date.now()) + 600000,
      opts.created_at || Date.now(),
    ],
  );
}

// A write-off (operator shrinkage) must not over-debit the shelf below
// the outstanding paid-hold sum for the SKU+location — a later
// commitHold would otherwise fail with the hold stranded.
async function _writeoffRespectsHolds() {
  var wired = await _wire();
  var q = wired.q, locSvc = wired.locSvc, svc = wired.svc;

  // Shelf=10 at WH-EAST, with a held row reserving 6 there.
  await locSvc.setStock({ sku: "WDG-H", location_code: "WH-EAST", quantity: 10 });
  await _seedHeld(q, { sku: "WDG-H", location_code: "WH-EAST", quantity: 6 });

  // A write-off of 5 would leave shelf=5 < held=6 → refused, shelf
  // untouched.
  await assert.rejects(svc.recordWriteoff({
    sku: "WDG-H", location_code: "WH-EAST", quantity: 5,
    reason: "damaged", actor: "a@b.com",
  }), /would strand 6 held units/);
  var s1 = await locSvc.stockForSku("WDG-H");
  var east1 = s1.by_location.find(function (l) { return l.code === "WH-EAST"; });
  check("respect_holds: over-debit refused, shelf untouched", east1 && east1.quantity === 10);
  var rows1 = (await q("SELECT COUNT(*) AS n FROM inventory_writeoffs", [])).rows[0];
  check("respect_holds: refusal writes no row",               Number(rows1.n) === 0);

  // A write-off of 4 leaves shelf=6 >= held=6 → allowed.
  var w = await svc.recordWriteoff({
    sku: "WDG-H", location_code: "WH-EAST", quantity: 4,
    reason: "damaged", actor: "a@b.com",
  });
  check("respect_holds: at-floor debit allowed",              w.status === "recorded");
  var s2 = await locSvc.stockForSku("WDG-H");
  var east2 = s2.by_location.find(function (l) { return l.code === "WH-EAST"; });
  check("respect_holds: shelf debited to held floor",         east2 && east2.quantity === 6);

  // An un-pinned hold (NULL location_code) counts against every
  // location's floor.
  await locSvc.setStock({ sku: "WDG-U", location_code: "WH-EAST", quantity: 8 });
  await _seedHeld(q, { sku: "WDG-U", location_code: null, quantity: 5 });
  await assert.rejects(svc.recordWriteoff({
    sku: "WDG-U", location_code: "WH-EAST", quantity: 4,
    reason: "lost", actor: "a@b.com",
  }), /would strand 5 held units/);

  // A normal commitHold-style debit (respect_holds OFF) is NOT blocked
  // by the held sum — commitHold flips held -> committed before
  // debiting, so its own qty is already out of the held total. Call
  // adjustStock directly without the flag and confirm it succeeds even
  // though held(6) > resulting shelf.
  var commitDebit = await locSvc.adjustStock({
    sku: "WDG-H", location_code: "WH-EAST", delta: -6,
    reason: "hold-commit:simulated",
  });
  check("commitHold-style debit (no flag) not hold-blocked",  commitDebit.quantity === 0);
}

async function _getWriteoff() {
  var wired = await _wire();
  var locSvc = wired.locSvc, svc = wired.svc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 10 });
  var w = await svc.recordWriteoff({
    sku: "WDG-1", location_code: "WH-EAST", quantity: 1,
    reason: "damaged", actor: "a@b.com",
  });
  var got = await svc.getWriteoff(w.id);
  check("getWriteoff hydrates",               got && got.id === w.id && got.sku === "WDG-1");
  var miss = await svc.getWriteoff("01999999-9999-7999-8999-999999999999");
  check("getWriteoff miss returns null",      miss === null);
}

async function run() {
  await _recordWriteoffPerReason();
  await _debitsStockViaInventoryLocations();
  await _costLayersIntegration();
  await _listWriteoffsFilters();
  await _costImpactForPeriod();
  await _reverseWriteoffRestores();
  await _factoryRefusals();
  await _monotonicClockPerSku();
  await _writeoffRespectsHolds();
  await _getWriteoff();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("inventory-writeoffs: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
