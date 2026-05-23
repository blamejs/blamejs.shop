"use strict";
/**
 * cost-layers — FIFO / LIFO / weighted-average inventory cost
 * accounting for COGS reporting.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0121
 * (sku_costing_methods + cost_layers + cogs_attributions). The
 * primitive composes only b.uuid.v7 from the vendored blamejs
 * surface, so this test does not wire any sibling primitives.
 *
 * Coverage:
 *   - FIFO consumption picks the OLDEST layer first; partial layer
 *     consumption leaves the residual on the source layer.
 *   - LIFO consumption picks the NEWEST layer first.
 *   - weighted_average computes the on-hand weighted-average cost
 *     and debits every layer proportionally; per-unit cost matches
 *     the average regardless of source layer.
 *   - Overdraft refusal: consuming more than the on-hand quantity
 *     throws and writes no rows.
 *   - cogsForOrder aggregates every non-reversed attribution row
 *     for the order; cogsForPeriod windows by occurred_at and
 *     breaks down per-SKU.
 *   - recordReversal restores layers at the original unit cost and
 *     flags the attribution rows as reversed.
 *   - setMethod / getMethod round-trip; the unset default is
 *     weighted_average.
 *   - Currency-coherence refusal: mixed currencies across on-hand
 *     layers refuse the sale; per-order / per-period reports refuse
 *     mixed-currency aggregation.
 *   - currentLayers returns only layers with quantity_remaining > 0,
 *     ordered oldest first.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// Require the module directly so this test stays independent of
// lib/index.js export ordering (the operator wires the primitive
// into the package surface manually after the patch lands).
var costLayers = require("../../lib/cost-layers");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0121_cost_layers.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _wire() {
  var q = _makeQuery();
  var svc = costLayers.create({ query: q });
  return { q: q, svc: svc };
}

// 1) FIFO consumption picks the oldest layer first; partial draw
//    leaves a residual on the source.
async function _fifoConsumption() {
  var w = _wire();
  await w.svc.setMethod({ sku: "WDG-1", method: "fifo" });
  // Receipt at t=1000: 10 units @ 500 minor
  await w.svc.recordReceipt({
    sku: "WDG-1", quantity: 10, unit_cost_minor: 500, currency: "USD",
    source: "receipt", occurred_at: 1000,
  });
  // Receipt at t=2000: 5 units @ 700 minor (newer / pricier)
  await w.svc.recordReceipt({
    sku: "WDG-1", quantity: 5, unit_cost_minor: 700, currency: "USD",
    source: "receipt", occurred_at: 2000,
  });

  // Sell 8 units — should consume entirely from the t=1000 layer
  // (FIFO picks oldest first), 2 units left on it; the t=2000 layer
  // untouched.
  var res = await w.svc.consumeForSale({
    sku: "WDG-1", quantity: 8, order_id: "ord-1", line_id: "ln-1",
  });
  check("fifo consumed single layer",        res.consumed_layers.length === 1);
  check("fifo per-unit cost = oldest",       res.consumed_layers[0].unit_cost_minor === 500);
  check("fifo total_cogs = qty * unit",      res.total_cogs_minor === 8 * 500);
  check("fifo currency surfaced",            res.currency === "USD");

  var layers = await w.svc.currentLayers({ sku: "WDG-1" });
  check("fifo two layers still active",      layers.length === 2);
  // Layers are returned oldest-first
  check("fifo oldest residual on layer 1",   layers[0].quantity_remaining === 2 && layers[0].unit_cost_minor === 500);
  check("fifo newest layer untouched",       layers[1].quantity_remaining === 5 && layers[1].unit_cost_minor === 700);

  // Sell 4 more — drains the remaining 2 from layer-1 and 2 from layer-2
  var res2 = await w.svc.consumeForSale({
    sku: "WDG-1", quantity: 4, order_id: "ord-2", line_id: "ln-1",
  });
  check("fifo cross-layer count",            res2.consumed_layers.length === 2);
  check("fifo cross-layer first =500",       res2.consumed_layers[0].unit_cost_minor === 500);
  check("fifo cross-layer second =700",      res2.consumed_layers[1].unit_cost_minor === 700);
  check("fifo cross-layer total cogs",       res2.total_cogs_minor === 2 * 500 + 2 * 700);
}

// 2) LIFO consumption picks the newest layer first.
async function _lifoConsumption() {
  var w = _wire();
  await w.svc.setMethod({ sku: "WDG-2", method: "lifo" });
  await w.svc.recordReceipt({
    sku: "WDG-2", quantity: 10, unit_cost_minor: 500, currency: "USD",
    source: "receipt", occurred_at: 1000,
  });
  await w.svc.recordReceipt({
    sku: "WDG-2", quantity: 5, unit_cost_minor: 700, currency: "USD",
    source: "receipt", occurred_at: 2000,
  });

  // Sell 3 — LIFO drains the newest layer first (the t=2000 / 700-cost)
  var res = await w.svc.consumeForSale({
    sku: "WDG-2", quantity: 3, order_id: "ord-3", line_id: "ln-1",
  });
  check("lifo single layer",                 res.consumed_layers.length === 1);
  check("lifo per-unit cost = newest",       res.consumed_layers[0].unit_cost_minor === 700);
  check("lifo total cogs",                   res.total_cogs_minor === 3 * 700);

  // Sell 7 more — drains the rest of the newer layer (2 left) + 5 from older
  var res2 = await w.svc.consumeForSale({
    sku: "WDG-2", quantity: 7, order_id: "ord-3", line_id: "ln-2",
  });
  check("lifo cross-layer count",            res2.consumed_layers.length === 2);
  check("lifo cross-layer first=newest",     res2.consumed_layers[0].unit_cost_minor === 700);
  check("lifo cross-layer second=oldest",    res2.consumed_layers[1].unit_cost_minor === 500);
  check("lifo cross-layer total",            res2.total_cogs_minor === 2 * 700 + 5 * 500);

  var layers = await w.svc.currentLayers({ sku: "WDG-2" });
  check("lifo only oldest residual left",    layers.length === 1 && layers[0].unit_cost_minor === 500 && layers[0].quantity_remaining === 5);
}

// 3) weighted_average uses the on-hand weighted average; layers
//    debited proportionally.
async function _weightedAverageConsumption() {
  var w = _wire();
  await w.svc.setMethod({ sku: "WDG-3", method: "weighted_average" });
  // 10 @ 500 + 10 @ 700 → on-hand 20 @ avg 600
  await w.svc.recordReceipt({
    sku: "WDG-3", quantity: 10, unit_cost_minor: 500, currency: "USD",
    source: "receipt", occurred_at: 1000,
  });
  await w.svc.recordReceipt({
    sku: "WDG-3", quantity: 10, unit_cost_minor: 700, currency: "USD",
    source: "receipt", occurred_at: 2000,
  });

  var res = await w.svc.consumeForSale({
    sku: "WDG-3", quantity: 4, order_id: "ord-4", line_id: "ln-1",
  });
  // Total COGS for the line = floor(20*500 + 10*700 ... wait
  //   sumValue = 10*500 + 10*700 = 12000; sumQty = 20
  //   line_cogs = floor(12000 * 4 / 20) = 2400
  check("wavg line cogs = sumValue*qty/sumQty", res.total_cogs_minor === 2400);
  check("wavg currency surfaced",               res.currency === "USD");
  // Layers debited proportionally — 10/20 * 4 = 2 from each layer
  check("wavg debits two layers",               res.consumed_layers.length === 2);
  var byLayer = {};
  res.consumed_layers.forEach(function (c) { byLayer[c.layer_id] = c; });
  var sumDebit = 0;
  Object.keys(byLayer).forEach(function (k) { sumDebit += byLayer[k].qty; });
  check("wavg total debited = qty",             sumDebit === 4);

  // Per-unit cost should be the avg (600) on every attribution
  res.consumed_layers.forEach(function (c) {
    check("wavg per-unit = avg(600)",           c.unit_cost_minor === 600);
  });

  var layers = await w.svc.currentLayers({ sku: "WDG-3" });
  var totalRemaining = 0;
  layers.forEach(function (l) { totalRemaining += l.quantity_remaining; });
  check("wavg total on-hand after sale",        totalRemaining === 16);
}

// 4) Overdraft refusal: requested qty > on-hand throws and writes
//    no rows.
async function _overdraftRefusal() {
  var w = _wire();
  await w.svc.setMethod({ sku: "WDG-4", method: "fifo" });
  await w.svc.recordReceipt({
    sku: "WDG-4", quantity: 5, unit_cost_minor: 100, currency: "USD",
    source: "receipt",
  });
  await assert.rejects(
    w.svc.consumeForSale({ sku: "WDG-4", quantity: 10, order_id: "ord-5", line_id: "ln-1" }),
    /insufficient on-hand/,
  );
  // Layer untouched
  var layers = await w.svc.currentLayers({ sku: "WDG-4" });
  check("overdraft leaves layer intact",        layers.length === 1 && layers[0].quantity_remaining === 5);
  // No attribution row was written
  var attrs = (await w.q("SELECT COUNT(*) AS n FROM cogs_attributions", [])).rows[0].n;
  check("overdraft writes no attribution",      Number(attrs) === 0);

  // Overdraft against an SKU with NO receipts
  await assert.rejects(
    w.svc.consumeForSale({ sku: "NO-RECEIPTS", quantity: 1, order_id: "ord-6", line_id: "ln-1" }),
    /insufficient on-hand/,
  );

  // Input refusals
  await assert.rejects(w.svc.consumeForSale(),                                                /input object required/);
  await assert.rejects(w.svc.consumeForSale({}),                                              /sku/);
  await assert.rejects(w.svc.consumeForSale({ sku: "WDG-4" }),                                /quantity/);
  await assert.rejects(
    w.svc.consumeForSale({ sku: "WDG-4", quantity: 1 }),                                      /order_id/,
  );
  await assert.rejects(
    w.svc.consumeForSale({ sku: "WDG-4", quantity: 1, order_id: "ord-7" }),                   /line_id/,
  );

  // recordReceipt refusals
  await assert.rejects(w.svc.recordReceipt(),                                                 /input object required/);
  await assert.rejects(
    w.svc.recordReceipt({ sku: "WDG-4", quantity: -1, unit_cost_minor: 1, currency: "USD", source: "receipt" }),
    /quantity/,
  );
  await assert.rejects(
    w.svc.recordReceipt({ sku: "WDG-4", quantity: 1, unit_cost_minor: -1, currency: "USD", source: "receipt" }),
    /unit_cost_minor/,
  );
  await assert.rejects(
    w.svc.recordReceipt({ sku: "WDG-4", quantity: 1, unit_cost_minor: 1, currency: "usd", source: "receipt" }),
    /currency/,
  );
  await assert.rejects(
    w.svc.recordReceipt({ sku: "WDG-4", quantity: 1, unit_cost_minor: 1, currency: "USD", source: "bogus" }),
    /source/,
  );
  // Operator may not pass the internal "reversal" source through recordReceipt
  await assert.rejects(
    w.svc.recordReceipt({ sku: "WDG-4", quantity: 1, unit_cost_minor: 1, currency: "USD", source: "reversal" }),
    /source/,
  );

  // setMethod refusals
  await assert.rejects(w.svc.setMethod({ sku: "WDG-4", method: "bogus" }),                    /method/);
  await assert.rejects(w.svc.setMethod({ sku: "", method: "fifo" }),                          /sku/);
}

// 5) cogsForOrder aggregates non-reversed attributions across lines;
//    cogsForPeriod windows by occurred_at and breaks down per-SKU.
async function _cogsAggregations() {
  var w = _wire();
  await w.svc.setMethod({ sku: "AGG-1", method: "fifo" });
  await w.svc.setMethod({ sku: "AGG-2", method: "fifo" });
  await w.svc.recordReceipt({
    sku: "AGG-1", quantity: 100, unit_cost_minor: 250, currency: "USD",
    source: "receipt", occurred_at: 10_000,
  });
  await w.svc.recordReceipt({
    sku: "AGG-2", quantity: 100, unit_cost_minor: 300, currency: "USD",
    source: "receipt", occurred_at: 10_000,
  });

  // Two lines on the same order
  await w.svc.consumeForSale({
    sku: "AGG-1", quantity: 4, order_id: "ORD-AGG", line_id: "LN-A",
    occurred_at: 20_000,
  });
  await w.svc.consumeForSale({
    sku: "AGG-2", quantity: 3, order_id: "ORD-AGG", line_id: "LN-B",
    occurred_at: 20_001,
  });

  var roll = await w.svc.cogsForOrder("ORD-AGG");
  check("cogsForOrder order_id echo",         roll.order_id === "ORD-AGG");
  check("cogsForOrder total",                 roll.total_cogs_minor === 4 * 250 + 3 * 300);
  check("cogsForOrder lines count",           roll.lines.length === 2);
  check("cogsForOrder currency",              roll.currency === "USD");
  var byLine = {};
  roll.lines.forEach(function (l) { byLine[l.line_id] = l; });
  check("cogsForOrder LN-A cogs",             byLine["LN-A"].total_cogs_minor === 4 * 250);
  check("cogsForOrder LN-A qty",              byLine["LN-A"].qty === 4);
  check("cogsForOrder LN-A sku",              byLine["LN-A"].sku === "AGG-1");
  check("cogsForOrder LN-B cogs",             byLine["LN-B"].total_cogs_minor === 3 * 300);

  // Unknown order — empty roll
  var miss = await w.svc.cogsForOrder("NO-SUCH-ORDER");
  check("cogsForOrder unknown empty",         miss.lines.length === 0 && miss.total_cogs_minor === 0);

  // cogsForPeriod over the window [15_000, 25_000) catches both
  var period = await w.svc.cogsForPeriod({ from: 15_000, to: 25_000 });
  check("cogsForPeriod total",                period.total_cogs_minor === 4 * 250 + 3 * 300);
  check("cogsForPeriod by_sku count",         period.by_sku.length === 2);
  var bySku = {};
  period.by_sku.forEach(function (r) { bySku[r.sku] = r; });
  check("cogsForPeriod AGG-1 cogs",           bySku["AGG-1"].total_cogs_minor === 4 * 250);
  check("cogsForPeriod AGG-2 cogs",           bySku["AGG-2"].total_cogs_minor === 3 * 300);

  // cogsForPeriod with sku filter
  var only1 = await w.svc.cogsForPeriod({ from: 15_000, to: 25_000, sku: "AGG-1" });
  check("cogsForPeriod sku filter",           only1.by_sku.length === 1 && only1.by_sku[0].sku === "AGG-1");
  check("cogsForPeriod sku filter total",     only1.total_cogs_minor === 4 * 250);

  // cogsForPeriod with no matches — empty roll
  var none = await w.svc.cogsForPeriod({ from: 100_000, to: 200_000 });
  check("cogsForPeriod empty window",         none.total_cogs_minor === 0 && none.by_sku.length === 0);

  // cogsForPeriod refusals
  await assert.rejects(w.svc.cogsForPeriod(),                                                 /input object required/);
  await assert.rejects(w.svc.cogsForPeriod({ from: 0 }),                                      /from and to/);
  await assert.rejects(w.svc.cogsForPeriod({ from: 100, to: 50 }),                            /to must be/);
}

// 6) recordReversal restores layers at the original unit cost and
//    flags the attribution rows as reversed.
async function _reversalRestores() {
  var w = _wire();
  await w.svc.setMethod({ sku: "REV-1", method: "fifo" });
  await w.svc.recordReceipt({
    sku: "REV-1", quantity: 10, unit_cost_minor: 400, currency: "USD",
    source: "receipt", occurred_at: 5_000,
  });
  await w.svc.consumeForSale({
    sku: "REV-1", quantity: 6, order_id: "ORD-RET", line_id: "LN-1",
    occurred_at: 6_000,
  });

  // Confirm pre-reversal on-hand = 4
  var pre = await w.svc.currentLayers({ sku: "REV-1" });
  var preRem = 0;
  pre.forEach(function (l) { preRem += l.quantity_remaining; });
  check("reversal pre-state on-hand",         preRem === 4);

  // Pre-reversal cogsForOrder = 6 * 400
  var preRoll = await w.svc.cogsForOrder("ORD-RET");
  check("reversal pre-roll total",            preRoll.total_cogs_minor === 6 * 400);

  // Reverse the line
  var rev = await w.svc.recordReversal({
    order_id: "ORD-RET", line_id: "LN-1", reason: "customer return — opened box",
  });
  check("reversal restored layer count",      rev.restored_layers.length === 1);
  check("reversal restored qty",              rev.restored_layers[0].qty === 6);
  check("reversal restored unit_cost",        rev.restored_layers[0].unit_cost_minor === 400);
  check("reversal echoes reason",             rev.reason === "customer return — opened box");

  // Post-reversal on-hand: 4 (residual on the original layer) + 6
  // (returned units) = 10
  var post = await w.svc.currentLayers({ sku: "REV-1" });
  var postRem = 0;
  post.forEach(function (l) { postRem += l.quantity_remaining; });
  check("reversal post-state on-hand",        postRem === 10);
  check("reversal added new layer",           post.length === 2);

  // The new layer carries source='reversal' so the audit query can
  // distinguish returns from supplier receipts.
  var newLayerRow = (await w.q(
    "SELECT * FROM cost_layers WHERE source = 'reversal' AND sku = 'REV-1'",
    [],
  )).rows;
  check("reversal layer marked",              newLayerRow.length === 1);

  // cogsForOrder after reversal — zero (every attribution reversed)
  var postRoll = await w.svc.cogsForOrder("ORD-RET");
  check("reversal post-roll empty",           postRoll.total_cogs_minor === 0);

  // Re-reversal of the same line is refused
  await assert.rejects(
    w.svc.recordReversal({ order_id: "ORD-RET", line_id: "LN-1", reason: "again" }),
    /already reversed/,
  );

  // Reversal of an unconsumed line is refused
  await assert.rejects(
    w.svc.recordReversal({ order_id: "NEVER", line_id: "LN-1", reason: "nope" }),
    /no attributions found/,
  );

  // Refusals
  await assert.rejects(w.svc.recordReversal(),                                                /input object required/);
  await assert.rejects(w.svc.recordReversal({ order_id: "ORD-RET", line_id: "LN-1" }),        /reason/);
  await assert.rejects(w.svc.recordReversal({ order_id: "ORD-RET", line_id: "LN-1", reason: "" }), /reason/);
}

// 7) setMethod / getMethod round-trip + default; currency-coherence
//    refusal; currentLayers shape.
async function _methodRoundtripAndCurrencyCoherence() {
  var w = _wire();

  // Default method when none set is weighted_average
  var def = await w.svc.getMethod("NEW-SKU");
  check("default method = weighted_average",  def.method === "weighted_average");

  // setMethod round-trip
  await w.svc.setMethod({ sku: "POL-1", method: "lifo" });
  var got = await w.svc.getMethod("POL-1");
  check("setMethod persists",                 got.method === "lifo");

  // Update method
  await w.svc.setMethod({ sku: "POL-1", method: "fifo" });
  var got2 = await w.svc.getMethod("POL-1");
  check("setMethod updates",                  got2.method === "fifo");

  // Mixed currencies refused at consumeForSale
  await w.svc.recordReceipt({
    sku: "MIX-1", quantity: 5, unit_cost_minor: 500, currency: "USD",
    source: "receipt", occurred_at: 1000,
  });
  await w.svc.recordReceipt({
    sku: "MIX-1", quantity: 5, unit_cost_minor: 450, currency: "EUR",
    source: "receipt", occurred_at: 2000,
  });
  await assert.rejects(
    w.svc.consumeForSale({ sku: "MIX-1", quantity: 3, order_id: "ord-mix", line_id: "ln" }),
    /multiple currencies/,
  );

  // currentLayers returns oldest-first and excludes drained layers
  await w.svc.setMethod({ sku: "LAY-1", method: "fifo" });
  await w.svc.recordReceipt({
    sku: "LAY-1", quantity: 3, unit_cost_minor: 100, currency: "USD",
    source: "receipt", occurred_at: 1000,
  });
  await w.svc.recordReceipt({
    sku: "LAY-1", quantity: 5, unit_cost_minor: 200, currency: "USD",
    source: "receipt", occurred_at: 2000,
  });
  // Drain the first layer fully
  await w.svc.consumeForSale({ sku: "LAY-1", quantity: 3, order_id: "ord-lay", line_id: "ln" });
  var lay = await w.svc.currentLayers({ sku: "LAY-1" });
  check("currentLayers excludes drained",     lay.length === 1);
  check("currentLayers carries remainder",    lay[0].quantity_remaining === 5);
  check("currentLayers exposes occurred_at",  lay[0].occurred_at === 2000);

  // currentLayers refusal shape
  await assert.rejects(w.svc.currentLayers(),                                                 /input object required/);
  await assert.rejects(w.svc.currentLayers({ sku: "" }),                                      /sku/);
}

// 8) Monotonic clock for receipts: two receipts in the same
//    millisecond don't tie on the FIFO ordering key, so the second
//    receipt is consumed after the first under FIFO.
async function _monotonicClockForReceipts() {
  var w = _wire();
  await w.svc.setMethod({ sku: "MON-1", method: "fifo" });
  // Three receipts with explicit identical timestamps
  await w.svc.recordReceipt({
    sku: "MON-1", quantity: 1, unit_cost_minor: 100, currency: "USD",
    source: "receipt", occurred_at: 50_000,
  });
  await w.svc.recordReceipt({
    sku: "MON-1", quantity: 1, unit_cost_minor: 200, currency: "USD",
    source: "receipt", occurred_at: 50_000,
  });
  await w.svc.recordReceipt({
    sku: "MON-1", quantity: 1, unit_cost_minor: 300, currency: "USD",
    source: "receipt", occurred_at: 50_000,
  });
  // FIFO consume one at a time should produce 100 then 200 then 300
  var r1 = await w.svc.consumeForSale({ sku: "MON-1", quantity: 1, order_id: "o1", line_id: "L" });
  var r2 = await w.svc.consumeForSale({ sku: "MON-1", quantity: 1, order_id: "o2", line_id: "L" });
  var r3 = await w.svc.consumeForSale({ sku: "MON-1", quantity: 1, order_id: "o3", line_id: "L" });
  check("monotonic FIFO 1st = 100",           r1.total_cogs_minor === 100);
  check("monotonic FIFO 2nd = 200",           r2.total_cogs_minor === 200);
  check("monotonic FIFO 3rd = 300",           r3.total_cogs_minor === 300);
}

// 9) Factory refusals
async function _factoryRefusals() {
  // Bad catalog handle
  assert.throws(function () { costLayers.create({ catalog: 42 }); },                          /catalog/);
  // No opts is allowed (query falls back to externalDb at call time)
  var svc = costLayers.create();
  check("factory: METHODS exposed",           Array.isArray(svc.METHODS) && svc.METHODS.length === 3);
  check("factory: RECEIPT_SOURCES exposed",   Array.isArray(svc.RECEIPT_SOURCES));
}

async function run() {
  await _fifoConsumption();
  await _lifoConsumption();
  await _weightedAverageConsumption();
  await _overdraftRefusal();
  await _cogsAggregations();
  await _reversalRestores();
  await _methodRoundtripAndCurrencyCoherence();
  await _monotonicClockForReceipts();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("cost-layers: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
