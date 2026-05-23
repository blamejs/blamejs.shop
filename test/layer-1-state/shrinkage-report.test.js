"use strict";
/**
 * shrinkage-report — loss-prevention dashboard aggregating
 * inventory_writeoffs by reason / period / location / sku / category.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0034 (inventory locations + inventory_stock — for the on-hand
 * baseline used by `period_shrinkage_rate_bps`), 0138
 * (inventory_writeoffs — the source rowset), and 0170 (the
 * shrinkage_report_cache table). The primitive isn't wired through
 * `bShop` yet — the test requires `lib/shrinkage-report.js` directly
 * so the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - report({ from, to }) headline + four breakdowns (by_reason /
 *     by_location / by_sku / by_category) with share_bps + currency
 *     coherence
 *   - report() period_shrinkage_rate_bps math against the on-hand
 *     baseline in inventory_stock; null when baseline is zero
 *   - filter composition on report() (location_code / sku / reason)
 *   - topLossLocations() ranking: cost-impact desc, units tie-break,
 *     reason_top picked from most-units reason; limit honored
 *   - topShrinkageSkus() ranking: units desc, cost tie-break,
 *     location_top picked from most-units location
 *   - categoryComparison() reason → category mapping (operational /
 *     perishable / external / deliberate) + top_reason inside each
 *     category
 *   - monthlyTrend() per-month bucketing (UTC start-of-month)
 *   - reasonBreakdownPie() share_bps + color_hint stability
 *   - flagAnomalies() threshold math: 2.0-stddev default flags
 *     outliers; below-threshold locations excluded; <2 distinct
 *     locations returns []; zero-stddev returns []
 *   - reversed writeoffs excluded from every aggregation
 *   - cache memoization on report() — same params hit the cache;
 *     purgeExpired sweeps stale rows by scope-TTL
 *   - validation refusals on every public surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop           = require("../../lib");
var shrinkageReport = require("../../lib/shrinkage-report");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0034_inventory_locations.sql",
  "0138_inventory_writeoffs.sql",
  "0170_shrinkage_report_cache.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

var DAY = 24 * 60 * 60 * 1000;

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery(opts) {
  opts = opts || {};
  var db = new DatabaseSync(":memory:");
  // FK enforcement OFF — seeds bypass inventoryLocations and poke
  // the underlying tables directly so the test can pin
  // deterministic timestamps + per-SKU / per-reason / per-location
  // combinations without walking the inventoryLocations FSM.
  db.prepare("PRAGMA foreign_keys = OFF").run();
  var migs = opts.skipStock ? MIGS.filter(function (p) { return p.indexOf("0034_") === -1; }) : MIGS;
  migs.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  var query = async function (sql, params) {
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
  query.__db = db;
  return query;
}

// Per-SKU monotonic clock: seeds two writeoffs in the same wall-ms
// without violating the natural ordering that the inventory-writeoffs
// primitive enforces in production (strict-monotonic per SKU).
function _seedWriteoff(query, opts) {
  return query(
    "INSERT INTO inventory_writeoffs " +
    "(id, sku, location_code, quantity, reason, actor, notes, " +
    " cost_impact_minor, currency, status, reversed_at, reverse_reason, " +
    " occurred_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    [
      opts.id || bShop.framework.uuid.v7(),
      opts.sku,
      opts.location_code == null ? null : opts.location_code,
      opts.quantity,
      opts.reason,
      opts.actor || "tester",
      opts.notes == null ? null : opts.notes,
      opts.cost_impact_minor == null ? null : opts.cost_impact_minor,
      opts.currency == null ? null : opts.currency,
      opts.status || "recorded",
      opts.reversed_at == null ? null : opts.reversed_at,
      opts.reverse_reason == null ? null : opts.reverse_reason,
      opts.occurred_at,
    ],
  );
}

function _seedStock(query, sku, location_code, quantity) {
  return query(
    "INSERT INTO inventory_stock (sku, location_code, quantity, updated_at) VALUES (?1, ?2, ?3, ?4)",
    [sku, location_code, quantity, Date.now()],
  );
}

// ---------------------------------------------------------------------------
// 1. report() — headline rollup + four breakdowns + currency coherence
// ---------------------------------------------------------------------------

async function _reportRollup() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });
  var t0 = Date.UTC(2026, 3, 1);                                            // Apr 1 2026 UTC

  // Seed on-hand baseline so period_shrinkage_rate_bps has a non-
  // null answer. 1000 units across three locations.
  await _seedStock(query, "SKU-A", "WH-EAST", 400);
  await _seedStock(query, "SKU-A", "WH-WEST", 300);
  await _seedStock(query, "SKU-B", "STORE-NYC", 300);

  // Seed 100 units total across reasons + locations + SKUs.
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST",   quantity: 20, reason: "damaged",   cost_impact_minor: 2000, currency: "USD", occurred_at: t0 + 1 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST",   quantity: 15, reason: "theft",     cost_impact_minor: 1500, currency: "USD", occurred_at: t0 + 2 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-WEST",   quantity: 10, reason: "shrinkage", cost_impact_minor: 1000, currency: "USD", occurred_at: t0 + 3 });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "STORE-NYC", quantity: 25, reason: "theft",     cost_impact_minor: 2500, currency: "USD", occurred_at: t0 + 4 });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "STORE-NYC", quantity: 30, reason: "expired",   cost_impact_minor: 3000, currency: "USD", occurred_at: t0 + 5 });

  // A reversed row that MUST be excluded from every rollup.
  await _seedWriteoff(query, {
    sku: "SKU-A", location_code: "WH-EAST", quantity: 9999, reason: "damaged",
    cost_impact_minor: 999999, currency: "USD", status: "reversed",
    reversed_at: t0 + 100, reverse_reason: "miscounted", occurred_at: t0 + 6,
  });

  var rep = await svc.report({ from: t0, to: t0 + DAY });

  check("report.total_units sums non-reversed",       rep.total_units === 100);
  check("report.total_cost_impact_minor sums",        rep.total_cost_impact_minor === 10000);
  check("report.currency single USD",                 rep.currency === "USD");
  // 100 / 1000 * 10000 = 1000 bps = 10%
  check("report.period_shrinkage_rate_bps math",      rep.period_shrinkage_rate_bps === 1000);
  check("report.from echoes",                         rep.from === t0);
  check("report.to echoes",                           rep.to === t0 + DAY);

  // by_reason — sorted by units desc, ties alpha.
  var reasonUnits = {};
  rep.by_reason.forEach(function (r) { reasonUnits[r.reason] = r.units; });
  check("by_reason theft = 40",                       reasonUnits.theft === 40);
  check("by_reason expired = 30",                     reasonUnits.expired === 30);
  check("by_reason damaged = 20",                     reasonUnits.damaged === 20);
  check("by_reason shrinkage = 10",                   reasonUnits.shrinkage === 10);
  check("by_reason ordered units desc",               rep.by_reason[0].units >= rep.by_reason[1].units);
  // share_bps sums to ~10000
  var shareSum = rep.by_reason.reduce(function (s, r) { return s + r.share_bps; }, 0);
  check("by_reason share_bps sums ~10000",            shareSum >= 9998 && shareSum <= 10002);
  check("by_reason carries cost + currency",          rep.by_reason[0].cost_impact_minor != null && rep.by_reason[0].currency === "USD");

  // by_location.
  var locUnits = {};
  rep.by_location.forEach(function (r) { locUnits[r.location_code] = r.units; });
  check("by_location STORE-NYC = 55",                 locUnits["STORE-NYC"] === 55);
  check("by_location WH-EAST = 35",                   locUnits["WH-EAST"] === 35);
  check("by_location WH-WEST = 10",                   locUnits["WH-WEST"] === 10);

  // by_sku.
  var skuUnits = {};
  rep.by_sku.forEach(function (r) { skuUnits[r.sku] = r.units; });
  check("by_sku SKU-B = 55",                          skuUnits["SKU-B"] === 55);
  check("by_sku SKU-A = 45",                          skuUnits["SKU-A"] === 45);

  // by_category — operational / perishable / deliberate / external mapping.
  var catUnits = {};
  rep.by_category.forEach(function (r) { catUnits[r.category] = r.units; });
  check("by_category deliberate = 50 (theft 40 + shrinkage 10)", catUnits.deliberate === 50);
  check("by_category perishable = 30 (expired 30)",   catUnits.perishable === 30);
  check("by_category operational = 20 (damaged 20)",  catUnits.operational === 20);
  check("by_category no 'unknown' category",          catUnits.unknown == null);

  // Reversed-row exclusion check — total would be 10099 if the
  // reversed row leaked through.
  check("reversed writeoff excluded",                 rep.total_units === 100 && rep.total_cost_impact_minor === 10000);
}

// ---------------------------------------------------------------------------
// 2. report() filters + missing-baseline branch
// ---------------------------------------------------------------------------

async function _reportFiltersAndBaseline() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });
  var t0 = Date.UTC(2026, 4, 1);

  await _seedStock(query, "SKU-A", "WH-EAST", 100);
  await _seedStock(query, "SKU-B", "WH-WEST", 200);

  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST",  quantity: 5,  reason: "damaged", cost_impact_minor: 500, currency: "USD", occurred_at: t0 + 1 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST",  quantity: 3,  reason: "theft",   cost_impact_minor: 300, currency: "USD", occurred_at: t0 + 2 });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "WH-WEST",  quantity: 10, reason: "theft",   cost_impact_minor: 1000, currency: "USD", occurred_at: t0 + 3 });

  // Filter by location.
  var byLoc = await svc.report({ from: t0, to: t0 + DAY, location_code: "WH-EAST" });
  check("filter location_code totals 8",              byLoc.total_units === 8);
  check("filter location_code single location",       byLoc.by_location.length === 1 && byLoc.by_location[0].location_code === "WH-EAST");

  // Filter by sku.
  var bySku = await svc.report({ from: t0, to: t0 + DAY, sku: "SKU-B" });
  check("filter sku totals 10",                       bySku.total_units === 10);
  check("filter sku single sku",                      bySku.by_sku.length === 1 && bySku.by_sku[0].sku === "SKU-B");

  // Filter by reason.
  var byReason = await svc.report({ from: t0, to: t0 + DAY, reason: "theft" });
  check("filter reason totals 13",                    byReason.total_units === 13);
  check("filter reason single reason",                byReason.by_reason.length === 1 && byReason.by_reason[0].reason === "theft");

  // Out-of-window — zero totals.
  var empty = await svc.report({ from: t0 - 10 * DAY, to: t0 - 5 * DAY });
  check("out-of-window total_units 0",                empty.total_units === 0);
  check("out-of-window cost null",                    empty.total_cost_impact_minor == null);
  check("out-of-window currency null",                empty.currency == null);

  // Missing inventory_stock table: primitive returns null rate
  // rather than crashing the dashboard.
  var noStockQuery = _makeQuery({ skipStock: true });
  var t1 = Date.UTC(2026, 5, 1);
  await _seedWriteoff(noStockQuery, { sku: "SKU-X", location_code: "WH-ZZZ", quantity: 10, reason: "theft", cost_impact_minor: 500, currency: "USD", occurred_at: t1 });
  var noStockSvc = shrinkageReport.create({ query: noStockQuery });
  var noStockRep = await noStockSvc.report({ from: t1 - 1, to: t1 + DAY });
  check("missing inventory_stock yields null rate",   noStockRep.period_shrinkage_rate_bps === null);
  check("missing inventory_stock still totals units", noStockRep.total_units === 10);
}

// ---------------------------------------------------------------------------
// 3. topLossLocations + topShrinkageSkus ranking
// ---------------------------------------------------------------------------

async function _topRankings() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });
  var t0 = Date.UTC(2026, 6, 1);

  // Three locations, three SKUs. Loss profile chosen so the
  // ranking is unambiguous on both axes.
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST",   quantity: 5,  reason: "theft",     cost_impact_minor: 5000, currency: "USD", occurred_at: t0 + 1 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST",   quantity: 3,  reason: "damaged",   cost_impact_minor: 3000, currency: "USD", occurred_at: t0 + 2 });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "STORE-NYC", quantity: 8,  reason: "shrinkage", cost_impact_minor: 800,  currency: "USD", occurred_at: t0 + 3 });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "STORE-NYC", quantity: 4,  reason: "theft",     cost_impact_minor: 400,  currency: "USD", occurred_at: t0 + 4 });
  await _seedWriteoff(query, { sku: "SKU-C", location_code: "WH-WEST",   quantity: 2,  reason: "expired",   cost_impact_minor: 200,  currency: "USD", occurred_at: t0 + 5 });

  // Loss by location (cost): WH-EAST 8000, STORE-NYC 1200, WH-WEST 200
  var topLoc = await svc.topLossLocations({ from: t0, to: t0 + DAY, limit: 10 });
  check("topLossLocations returns 3 locations",       topLoc.length === 3);
  check("topLossLocations #1 = WH-EAST",              topLoc[0].location_code === "WH-EAST" && topLoc[0].cost_impact_minor === 8000);
  check("topLossLocations #2 = STORE-NYC",            topLoc[1].location_code === "STORE-NYC" && topLoc[1].cost_impact_minor === 1200);
  check("topLossLocations #3 = WH-WEST",              topLoc[2].location_code === "WH-WEST" && topLoc[2].cost_impact_minor === 200);

  // reason_top on WH-EAST: theft (5) vs damaged (3) → theft.
  check("topLossLocations reason_top WH-EAST=theft",  topLoc[0].reason_top === "theft" && topLoc[0].reason_top_units === 5);
  // reason_top on STORE-NYC: shrinkage (8) vs theft (4) → shrinkage.
  check("topLossLocations reason_top STORE-NYC=shrinkage", topLoc[1].reason_top === "shrinkage");

  // limit honored.
  var top1 = await svc.topLossLocations({ from: t0, to: t0 + DAY, limit: 1 });
  check("topLossLocations limit=1",                   top1.length === 1 && top1[0].location_code === "WH-EAST");

  // Top SKUs by units: SKU-B 12, SKU-A 8, SKU-C 2.
  var topSkus = await svc.topShrinkageSkus({ from: t0, to: t0 + DAY, limit: 10 });
  check("topShrinkageSkus returns 3 skus",            topSkus.length === 3);
  check("topShrinkageSkus #1 = SKU-B (units 12)",     topSkus[0].sku === "SKU-B" && topSkus[0].units === 12);
  check("topShrinkageSkus #2 = SKU-A (units 8)",      topSkus[1].sku === "SKU-A" && topSkus[1].units === 8);
  check("topShrinkageSkus #3 = SKU-C (units 2)",      topSkus[2].sku === "SKU-C" && topSkus[2].units === 2);
  check("topShrinkageSkus location_top SKU-B",        topSkus[0].location_top === "STORE-NYC");

  // limit honored.
  var top1Sku = await svc.topShrinkageSkus({ from: t0, to: t0 + DAY, limit: 1 });
  check("topShrinkageSkus limit=1",                   top1Sku.length === 1 && top1Sku[0].sku === "SKU-B");

  // Empty window.
  var empty = await svc.topLossLocations({ from: t0 - 10 * DAY, to: t0 - 5 * DAY });
  check("topLossLocations empty window []",           empty.length === 0);
  var emptySkus = await svc.topShrinkageSkus({ from: t0 - 10 * DAY, to: t0 - 5 * DAY });
  check("topShrinkageSkus empty window []",           emptySkus.length === 0);
}

// ---------------------------------------------------------------------------
// 4. categoryComparison + reasonBreakdownPie
// ---------------------------------------------------------------------------

async function _categoryAndPie() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });
  var t0 = Date.UTC(2026, 7, 1);

  // 10 + 5 = 15 operational, 8 perishable, 3 external, 20 + 7 = 27 deliberate
  // Total = 53. Shares: deliberate ~5094, operational ~2830, perishable ~1509, external ~566.
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 10, reason: "damaged",         cost_impact_minor: 1000, currency: "USD", occurred_at: t0 + 1 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 5,  reason: "quality_control", cost_impact_minor: 500,  currency: "USD", occurred_at: t0 + 2 });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "WH-WEST", quantity: 8,  reason: "expired",         cost_impact_minor: 800,  currency: "USD", occurred_at: t0 + 3 });
  await _seedWriteoff(query, { sku: "SKU-C", location_code: "WH-WEST", quantity: 3,  reason: "sample",          cost_impact_minor: 300,  currency: "USD", occurred_at: t0 + 4 });
  await _seedWriteoff(query, { sku: "SKU-D", location_code: "STORE-NYC", quantity: 20, reason: "theft",         cost_impact_minor: 2000, currency: "USD", occurred_at: t0 + 5 });
  await _seedWriteoff(query, { sku: "SKU-D", location_code: "STORE-NYC", quantity: 7,  reason: "shrinkage",     cost_impact_minor: 700,  currency: "USD", occurred_at: t0 + 6 });

  var cats = await svc.categoryComparison({ from: t0, to: t0 + DAY });
  var catByKey = {};
  cats.forEach(function (c) { catByKey[c.category] = c; });

  check("categoryComparison deliberate=27 units",     catByKey.deliberate.units === 27);
  check("categoryComparison operational=15 units",    catByKey.operational.units === 15);
  check("categoryComparison perishable=8 units",      catByKey.perishable.units === 8);
  check("categoryComparison external=3 units",        catByKey.external.units === 3);

  // top_reason within each category.
  check("categoryComparison deliberate top=theft",    catByKey.deliberate.top_reason === "theft");
  check("categoryComparison operational top=damaged", catByKey.operational.top_reason === "damaged");
  check("categoryComparison perishable top=expired",  catByKey.perishable.top_reason === "expired");
  check("categoryComparison external top=sample",     catByKey.external.top_reason === "sample");

  // Ordering — deliberate first (units desc).
  check("categoryComparison ordered units desc",      cats[0].category === "deliberate");

  // share_bps math — deliberate share = round(27/53 * 10000) = 5094
  check("categoryComparison deliberate share_bps",    catByKey.deliberate.share_bps === Math.round(27 / 53 * 10000));

  // Reason pie.
  var pie = await svc.reasonBreakdownPie({ from: t0, to: t0 + DAY });
  check("reasonBreakdownPie returns 6 reasons",       pie.length === 6);
  check("reasonBreakdownPie #1 = theft (units 20)",   pie[0].reason === "theft" && pie[0].units === 20);
  // color_hint stability — theft maps to a known value
  check("reasonBreakdownPie color_hint stable",       pie[0].color_hint === shrinkageReport.REASON_COLOR.theft);
  // share_bps adds to ~10000
  var pieShareSum = pie.reduce(function (s, p) { return s + p.share_bps; }, 0);
  check("reasonBreakdownPie share_bps sums ~10000",   pieShareSum >= 9998 && pieShareSum <= 10002);
}

// ---------------------------------------------------------------------------
// 5. monthlyTrend
// ---------------------------------------------------------------------------

async function _monthlyTrend() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });

  var jan = Date.UTC(2026, 0, 15);
  var feb = Date.UTC(2026, 1, 15);
  var mar = Date.UTC(2026, 2, 15);
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 10, reason: "damaged", cost_impact_minor: 1000, currency: "USD", occurred_at: jan });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 5,  reason: "theft",   cost_impact_minor: 500,  currency: "USD", occurred_at: jan + 1 });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "WH-WEST", quantity: 20, reason: "expired", cost_impact_minor: 2000, currency: "USD", occurred_at: feb });
  await _seedWriteoff(query, { sku: "SKU-B", location_code: "WH-WEST", quantity: 8,  reason: "theft",   cost_impact_minor: 800,  currency: "USD", occurred_at: mar });

  var trend = await svc.monthlyTrend({ from: Date.UTC(2025, 11, 1), to: Date.UTC(2026, 4, 1) });
  check("monthlyTrend returns 3 buckets",             trend.length === 3);
  check("monthlyTrend Jan bucket=2026-01-01",         trend[0].bucket_start === "2026-01-01" && trend[0].units === 15);
  check("monthlyTrend Feb bucket=2026-02-01",         trend[1].bucket_start === "2026-02-01" && trend[1].units === 20);
  check("monthlyTrend Mar bucket=2026-03-01",         trend[2].bucket_start === "2026-03-01" && trend[2].units === 8);
  check("monthlyTrend Jan cost=1500",                 trend[0].cost_impact_minor === 1500);
  check("monthlyTrend Jan currency=USD",              trend[0].currency === "USD");
}

// ---------------------------------------------------------------------------
// 6. flagAnomalies — threshold math + edge cases
// ---------------------------------------------------------------------------

async function _flagAnomalies() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });
  var t0 = Date.UTC(2026, 8, 1);

  // Four locations, one wildly above the others. Units: 5, 5, 5, 50.
  // mean = 16.25; stddev (sample, n=4 → denom 3) =
  // sqrt(((5-16.25)^2 + (5-16.25)^2 + (5-16.25)^2 + (50-16.25)^2) / 3)
  // = sqrt((126.5625 * 3 + 1139.0625) / 3) = sqrt(506.25) = ~22.5
  // threshold @ 2.0 stddev = 16.25 + 45 = 61.25 — STORE-50 (units 50)
  // sits BELOW that threshold at this multiplier; needs a tighter
  // multiplier to fire. We use 1.0 here to keep the test on a
  // generous flag (50 > 16.25 + 22.5 = 38.75).
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "LOC-1", quantity: 5,  reason: "theft", cost_impact_minor: 500,  currency: "USD", occurred_at: t0 + 1 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "LOC-2", quantity: 5,  reason: "theft", cost_impact_minor: 500,  currency: "USD", occurred_at: t0 + 2 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "LOC-3", quantity: 5,  reason: "theft", cost_impact_minor: 500,  currency: "USD", occurred_at: t0 + 3 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "LOC-OUTLIER", quantity: 50, reason: "theft", cost_impact_minor: 5000, currency: "USD", occurred_at: t0 + 4 });

  var flagsAt1 = await svc.flagAnomalies({ from: t0, to: t0 + DAY, threshold_multiplier: 1.0 });
  check("flagAnomalies at 1.0σ flags LOC-OUTLIER",    flagsAt1.length === 1 && flagsAt1[0].location_code === "LOC-OUTLIER");
  check("flagAnomalies units carried through",        flagsAt1[0].units === 50);
  check("flagAnomalies z_score > 1",                  flagsAt1[0].z_score > 1);
  check("flagAnomalies carries mean+stddev+threshold", typeof flagsAt1[0].mean === "number" && typeof flagsAt1[0].stddev === "number" && typeof flagsAt1[0].threshold === "number");

  // At 3.0σ the threshold is 16.25 + 67.5 = 83.75 — nothing fires.
  var flagsAt3 = await svc.flagAnomalies({ from: t0, to: t0 + DAY, threshold_multiplier: 3.0 });
  check("flagAnomalies at 3.0σ no flags",             flagsAt3.length === 0);

  // <2 locations → [].
  var query2 = _makeQuery();
  var svc2 = shrinkageReport.create({ query: query2 });
  var t1 = Date.UTC(2026, 9, 1);
  await _seedWriteoff(query2, { sku: "SKU-A", location_code: "ONLY-ONE", quantity: 100, reason: "theft", cost_impact_minor: 1000, currency: "USD", occurred_at: t1 });
  var flagsSingle = await svc2.flagAnomalies({ from: t1, to: t1 + DAY });
  check("flagAnomalies <2 locations → []",            flagsSingle.length === 0);

  // Zero stddev (every location identical) → [].
  var query3 = _makeQuery();
  var svc3 = shrinkageReport.create({ query: query3 });
  var t2 = Date.UTC(2026, 10, 1);
  await _seedWriteoff(query3, { sku: "SKU-A", location_code: "A", quantity: 10, reason: "theft", cost_impact_minor: 100, currency: "USD", occurred_at: t2 + 1 });
  await _seedWriteoff(query3, { sku: "SKU-A", location_code: "B", quantity: 10, reason: "theft", cost_impact_minor: 100, currency: "USD", occurred_at: t2 + 2 });
  await _seedWriteoff(query3, { sku: "SKU-A", location_code: "C", quantity: 10, reason: "theft", cost_impact_minor: 100, currency: "USD", occurred_at: t2 + 3 });
  var flagsFlat = await svc3.flagAnomalies({ from: t2, to: t2 + DAY });
  check("flagAnomalies zero-stddev → []",             flagsFlat.length === 0);

  // min_units filter — only LOC-OUTLIER passes a min_units=20 floor.
  // After filter, only one location remains so the result is [].
  var flagsFiltered = await svc.flagAnomalies({ from: t0, to: t0 + DAY, min_units: 20 });
  check("flagAnomalies min_units floor → [] (n<2)",   flagsFiltered.length === 0);
}

// ---------------------------------------------------------------------------
// 7. Cache hit + purgeExpired
// ---------------------------------------------------------------------------

async function _cacheAndPurge() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });
  var t0 = Date.UTC(2026, 11, 1);

  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 10, reason: "theft", cost_impact_minor: 1000, currency: "USD", occurred_at: t0 + 1 });

  // First call with cache: true populates the cache.
  var first = await svc.report({ from: t0, to: t0 + DAY, cache: true });
  check("first cached report.total_units = 10",       first.total_units === 10);

  // The cache row should exist.
  var rowsAfter = (await query("SELECT * FROM shrinkage_report_cache", [])).rows;
  check("cache row written",                          rowsAfter.length === 1 && rowsAfter[0].scope_key === "report");
  check("cache row period stamps echo",               Number(rowsAfter[0].period_from) === t0 && Number(rowsAfter[0].period_to) === t0 + DAY);
  check("cache row total_units echoes",               Number(rowsAfter[0].total_units) === 10);
  check("cache row total_cost_impact_minor echoes",   Number(rowsAfter[0].total_cost_impact_minor) === 1000);

  // Mutate the writeoffs table directly — a cached call should
  // return the OLD result, proving the cache is hit.
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 999, reason: "theft", cost_impact_minor: 99999, currency: "USD", occurred_at: t0 + 2 });
  var hit = await svc.report({ from: t0, to: t0 + DAY, cache: true });
  check("cache hit returns old total_units = 10",     hit.total_units === 10);

  // No-cache call sees the fresh row.
  var fresh = await svc.report({ from: t0, to: t0 + DAY });
  check("no-cache call sees fresh total_units = 1009", fresh.total_units === 1009);

  // purgeExpired with a future timestamp clears every scope's cache.
  var futureTs = Date.now() + 100 * 365 * DAY;
  var sweep = await svc.purgeExpired(futureTs);
  check("purgeExpired returns deleted count >= 1",    sweep.deleted >= 1);
  var rowsAfterSweep = (await query("SELECT * FROM shrinkage_report_cache", [])).rows;
  check("cache empty after purgeExpired",             rowsAfterSweep.length === 0);
}

// ---------------------------------------------------------------------------
// 8. Validation refusals
// ---------------------------------------------------------------------------

async function _validationRefusals() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });

  // report() refusals.
  await assert.rejects(svc.report(),                                      /input object required/);
  await assert.rejects(svc.report({}),                                    /from and to/);
  await assert.rejects(svc.report({ from: 100 }),                         /from and to/);
  await assert.rejects(svc.report({ from: -1, to: 100 }),                 /from/);
  await assert.rejects(svc.report({ from: 100, to: 100 }),                /from must be strictly less/);
  await assert.rejects(svc.report({ from: 200, to: 100 }),                /from must be strictly less/);
  await assert.rejects(svc.report({ from: 1, to: 1 + 10 * 365 * DAY }),   /window/);
  await assert.rejects(svc.report({ from: 1, to: 100, location_code: "BAD CAPS!" }), /location_code/);
  await assert.rejects(svc.report({ from: 1, to: 100, sku:  "BAD CAPS!" }), /sku/);
  await assert.rejects(svc.report({ from: 1, to: 100, reason: "fictional" }), /reason/);
  await assert.rejects(svc.report({ from: 1, to: 100, cache: true, cache_ttl_ms: -1 }), /cache_ttl_ms/);

  // topLossLocations refusals.
  await assert.rejects(svc.topLossLocations(),                            /input object required/);
  await assert.rejects(svc.topLossLocations({ from: 1, to: 100, limit: 0 }), /limit/);
  await assert.rejects(svc.topLossLocations({ from: 1, to: 100, limit: 999 }), /limit/);

  // topShrinkageSkus refusals.
  await assert.rejects(svc.topShrinkageSkus({ from: 1, to: 100, limit: 0 }), /limit/);
  await assert.rejects(svc.topShrinkageSkus({ from: 1, to: 100, limit: 999 }), /limit/);

  // monthlyTrend / categoryComparison / reasonBreakdownPie refusals.
  await assert.rejects(svc.monthlyTrend(),                                /input object required/);
  await assert.rejects(svc.categoryComparison(),                          /input object required/);
  await assert.rejects(svc.reasonBreakdownPie(),                          /input object required/);

  // flagAnomalies refusals.
  await assert.rejects(svc.flagAnomalies(),                                       /input object required/);
  await assert.rejects(svc.flagAnomalies({ from: 1, to: 100, threshold_multiplier: 0 }), /threshold_multiplier/);
  await assert.rejects(svc.flagAnomalies({ from: 1, to: 100, threshold_multiplier: -1 }), /threshold_multiplier/);
  await assert.rejects(svc.flagAnomalies({ from: 1, to: 100, threshold_multiplier: "x" }), /threshold_multiplier/);
  await assert.rejects(svc.flagAnomalies({ from: 1, to: 100, min_units: -1 }),     /min_units/);
  await assert.rejects(svc.flagAnomalies({ from: 1, to: 100, min_units: 1.5 }),    /min_units/);

  // purgeExpired refusals.
  await assert.rejects(svc.purgeExpired(-1),                              /nowTs/);
  await assert.rejects(svc.purgeExpired("x"),                             /nowTs/);
}

// ---------------------------------------------------------------------------
// 9. Mixed-currency refusal
// ---------------------------------------------------------------------------

async function _mixedCurrencyRefusal() {
  var query = _makeQuery();
  var svc = shrinkageReport.create({ query: query });
  var t0 = Date.UTC(2027, 0, 1);

  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 5, reason: "theft", cost_impact_minor: 500, currency: "USD", occurred_at: t0 + 1 });
  await _seedWriteoff(query, { sku: "SKU-A", location_code: "WH-EAST", quantity: 3, reason: "theft", cost_impact_minor: 300, currency: "EUR", occurred_at: t0 + 2 });

  await assert.rejects(svc.report({ from: t0, to: t0 + DAY }), /multiple currencies/);
}

async function run() {
  await _reportRollup();
  await _reportFiltersAndBaseline();
  await _topRankings();
  await _categoryAndPie();
  await _monthlyTrend();
  await _flagAnomalies();
  await _cacheAndPurge();
  await _validationRefusals();
  await _mixedCurrencyRefusal();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/shrinkage-report.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — shrinkage-report (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — shrinkage-report: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
