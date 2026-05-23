"use strict";
/**
 * smart-restocking — EOQ-style reorder-quantity recommendation that
 * composes demandForecast (predicted_units + confidence band),
 * reorderThresholds (current_stock + lead_time_days) and costLayers
 * (unit cost) into a recommended order quantity, safety stock and
 * reorder point.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0203
 * (smart_restocking_policies + smart_restocking_policy_assignments +
 * smart_restocking_recommendations). The composed deps are stubbed at
 * the factory boundary — the primitive's contract with each is the
 * narrow verb set the factory checks (forecastForSku, evaluate,
 * currentLayers, getVendor).
 *
 * Coverage:
 *   - definePolicy: insert + patch-in-place + refusals (slug, bps,
 *     ordering_cost, service_level enum)
 *   - applyPolicy: bind + rebind + refuse on archived
 *   - recommendOrderQty composes forecast + threshold + cost and
 *     produces an EOQ that matches the closed-form sqrt(2DS/H)
 *   - safety_stock derived from service_level: 0.90 < 0.95 < 0.99
 *   - bulkRecommend fans out, mixed-success batches return error rows
 *   - metricsForSku windowed read + averages
 *   - module-level run() smoke + factory exports
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var smartRestocking = require("../../lib/smart-restocking");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0203_smart_restocking.sql");

var DAY_MS  = 24 * 60 * 60 * 1000;

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

// Stub for demandForecast — returns a configurable forecast keyed by
// SKU. Operators that want a "no forecast available" branch pass an
// empty map.
function _stubDemandForecast(byKey) {
  byKey = byKey || {};
  var calls = [];
  return {
    calls: calls,
    forecastForSku: async function (input) {
      calls.push(input);
      var key = input.sku;
      var f = byKey[key];
      if (!f) {
        return {
          predicted_units:  0,
          confidence_low:   0,
          confidence_high:  0,
          baseline_method:  "simple_moving_average",
          seasonal_factor:  1,
        };
      }
      return f;
    },
  };
}

// Stub for reorderThresholds. Returns a configurable evaluation per
// SKU; an unknown SKU yields a "no threshold defined" evaluation
// (current_stock = 0, lead_time_days = 0).
function _stubReorderThresholds(byKey) {
  byKey = byKey || {};
  var calls = [];
  return {
    calls: calls,
    evaluate: async function (input) {
      calls.push(input);
      var ev = byKey[input.sku];
      if (!ev) {
        return {
          current_stock:   0,
          min_stock:       0,
          should_reorder:  false,
          suggested_qty:   0,
          days_of_supply:  null,
          lead_time_days:  0,
        };
      }
      return ev;
    },
  };
}

// Stub for costLayers. Returns a configurable layer set per SKU; an
// unknown SKU yields an empty layer set (drives the no-cost-data tag).
function _stubCostLayers(byKey) {
  byKey = byKey || {};
  var calls = [];
  return {
    calls: calls,
    currentLayers: async function (input) {
      calls.push(input);
      return byKey[input.sku] || [];
    },
  };
}

// ---- 1. definePolicy insert + patch + refusals ------------------------

async function _testDefinePolicy() {
  var query = _makeQuery();
  var sr = smartRestocking.create({ query: query });

  var p = await sr.definePolicy({
    slug:                  "house-default",
    holding_cost_bps:      2500,
    ordering_cost_minor:   5000,
    default_service_level: 0.95,
  });
  check("definePolicy returns shaped row",        p && p.slug === "house-default");
  check("holding_cost_bps echoed",                p.holding_cost_bps === 2500);
  check("ordering_cost_minor echoed",             p.ordering_cost_minor === 5000);
  check("default_service_level echoed",           p.default_service_level === 0.95);
  check("archived_at null on new policy",         p.archived_at === null);
  check("created_at integer",                     Number.isInteger(p.created_at));

  // Re-definePolicy on the same slug patches in place.
  var p2 = await sr.definePolicy({
    slug:                  "house-default",
    holding_cost_bps:      3000,
    ordering_cost_minor:   7500,
    default_service_level: 0.99,
  });
  check("redefining same slug patches in place",  p2.slug === "house-default");
  check("patched bps",                            p2.holding_cost_bps === 3000);
  check("patched ordering cost",                  p2.ordering_cost_minor === 7500);
  check("patched service level",                  p2.default_service_level === 0.99);
  check("created_at preserved across patch",      p2.created_at === p.created_at);
  check("updated_at advanced",                    p2.updated_at >= p.updated_at);

  // Slug refusal.
  await assert.rejects(sr.definePolicy({
    slug: "BAD-UPPER", holding_cost_bps: 0,
    ordering_cost_minor: 0, default_service_level: 0.95,
  }), /slug must match/);

  // Negative bps refusal.
  await assert.rejects(sr.definePolicy({
    slug: "x", holding_cost_bps: -1,
    ordering_cost_minor: 0, default_service_level: 0.95,
  }), /holding_cost_bps/);

  // Service-level enum refusal (only 0.90 / 0.95 / 0.99 supported).
  await assert.rejects(sr.definePolicy({
    slug: "x", holding_cost_bps: 0,
    ordering_cost_minor: 0, default_service_level: 0.80,
  }), /service_level must be one of/);

  // Non-integer ordering cost refusal.
  await assert.rejects(sr.definePolicy({
    slug: "x", holding_cost_bps: 0,
    ordering_cost_minor: 1.5, default_service_level: 0.95,
  }), /ordering_cost_minor/);

  // Round-trip getPolicy + listPolicies.
  var got = await sr.getPolicy("house-default");
  check("getPolicy returns the patched row",      got && got.ordering_cost_minor === 7500);

  await sr.definePolicy({
    slug: "fast-movers", holding_cost_bps: 1500,
    ordering_cost_minor: 2000, default_service_level: 0.90,
  });
  var listed = await sr.listPolicies({});
  check("listPolicies returns two rows",          listed.length === 2);

  // archivePolicy soft-deletes; listPolicies hides archived by default.
  var arc = await sr.archivePolicy("fast-movers");
  check("archivePolicy stamps archived_at",       Number.isInteger(arc.archived_at));
  var activeOnly = await sr.listPolicies({});
  check("archived policy hidden by default",      activeOnly.length === 1);
  var withArchived = await sr.listPolicies({ include_archived: true });
  check("include_archived returns both",          withArchived.length === 2);
  // Re-archiving is idempotent.
  var arc2 = await sr.archivePolicy("fast-movers");
  check("re-archive preserves stamp",             arc2.archived_at === arc.archived_at);

  await assert.rejects(sr.archivePolicy("does-not-exist"), /not found/);
}

// ---- 2. applyPolicy + policyForSku ------------------------------------

async function _testApplyPolicy() {
  var query = _makeQuery();
  var sr = smartRestocking.create({ query: query });

  await sr.definePolicy({
    slug: "default", holding_cost_bps: 2500,
    ordering_cost_minor: 5000, default_service_level: 0.95,
  });
  await sr.definePolicy({
    slug: "premium", holding_cost_bps: 1000,
    ordering_cost_minor: 10000, default_service_level: 0.99,
  });

  var a = await sr.applyPolicy({ slug: "default", sku: "WIDGET-A" });
  check("applyPolicy returns assignment row",     a && a.sku === "WIDGET-A");
  check("policy_slug echoed",                     a.policy_slug === "default");
  check("assigned_at integer",                    Number.isInteger(a.assigned_at));

  var resolved = await sr.policyForSku("WIDGET-A");
  check("policyForSku returns assignment",        resolved && resolved.sku === "WIDGET-A");
  check("policyForSku resolves policy shape",     resolved.policy && resolved.policy.slug === "default");
  check("policyForSku assigned_at echoed",        resolved.assigned_at === a.assigned_at);

  // Re-binding to the same policy refreshes assigned_at.
  var a2 = await sr.applyPolicy({ slug: "default", sku: "WIDGET-A" });
  check("rebind same slug ok",                    a2.policy_slug === "default");
  check("rebind refreshes assigned_at",           a2.assigned_at >= a.assigned_at);

  // Switching to a different policy overwrites the binding.
  var a3 = await sr.applyPolicy({ slug: "premium", sku: "WIDGET-A" });
  check("rebind switches policy",                 a3.policy_slug === "premium");
  var resolved2 = await sr.policyForSku("WIDGET-A");
  check("policyForSku reflects switch",           resolved2.policy.slug === "premium");

  // Unknown SKU has null assignment.
  var nullAssign = await sr.policyForSku("UNKNOWN-SKU");
  check("policyForSku null for unknown sku",      nullAssign === null);

  // Refusals.
  await assert.rejects(sr.applyPolicy({ slug: "does-not-exist", sku: "X" }), /not found/);
  await sr.archivePolicy("default");
  await assert.rejects(sr.applyPolicy({ slug: "default", sku: "Y" }), /archived/);

  // unassignPolicy removes the binding.
  var removed = await sr.unassignPolicy({ sku: "WIDGET-A" });
  check("unassignPolicy returns removed=true",    removed.removed === true);
  var afterUnassign = await sr.policyForSku("WIDGET-A");
  check("policyForSku null after unassign",       afterUnassign === null);
  // Idempotent: unassign on a SKU without a binding returns removed=false.
  var removed2 = await sr.unassignPolicy({ sku: "WIDGET-A" });
  check("unassign no-op returns removed=false",   removed2.removed === false);
}

// ---- 3. recommendOrderQty EOQ math + reasoning ------------------------

async function _testRecommendOrderQtyMath() {
  var query = _makeQuery();

  // Pin the inputs so the EOQ math is exact:
  //   horizon_days = 30
  //   predicted_units = 90   -> daily = 3, annual = 1095
  //   confidence_low = 60, confidence_high = 120
  //     band_half = 30; 1σ = 30 / 1.0 = 30; daily_std = 30 / 30 = 1.0
  //   lead_time_days = 7
  //   unit_cost_minor = 100
  //   holding_cost_bps = 2500 (25% / yr)
  //   ordering_cost_minor = 5000
  //   holdingPerUnitYear = 100 * 2500 / 10000 = 25
  //   EOQ = sqrt((2 * 1095 * 5000) / 25) = sqrt(438000) ≈ 661.81 → 662
  //   z_95 = 1.6449; safety = ceil(1.6449 * sqrt(7) * 1.0)
  //                        = ceil(1.6449 * 2.6458) = ceil(4.3522) = 5
  //   reorder_point = ceil(3 * 7) + 5 = 21 + 5 = 26
  //   recommended = 662 + 5 = 667
  //   cost_estimate = 667 * 100 + 5000 = 71700

  var df = _stubDemandForecast({
    "MATH-1": {
      predicted_units:  90,
      confidence_low:   60,
      confidence_high:  120,
      baseline_method:  "simple_moving_average",
      seasonal_factor:  1,
    },
  });
  var rt = _stubReorderThresholds({
    "MATH-1": {
      current_stock:   50,
      min_stock:       30,
      should_reorder:  false,
      suggested_qty:   0,
      days_of_supply:  16,
      lead_time_days:  7,
    },
  });
  var cl = _stubCostLayers({
    "MATH-1": [
      { quantity_remaining: 100, unit_cost_minor: 100, currency: "USD" },
    ],
  });

  var sr = smartRestocking.create({
    query:             query,
    demandForecast:    df,
    reorderThresholds: rt,
    costLayers:        cl,
  });

  await sr.definePolicy({
    slug: "math-policy", holding_cost_bps: 2500,
    ordering_cost_minor: 5000, default_service_level: 0.95,
  });
  await sr.applyPolicy({ slug: "math-policy", sku: "MATH-1" });

  var rec = await sr.recommendOrderQty({ sku: "MATH-1", horizon_days: 30 });
  check("EOQ exact math: 662",                     rec.eoq_qty === 662);
  check("safety stock exact: 5",                   rec.safety_stock_qty === 5);
  check("reorder_point exact: 26",                 rec.reorder_point === 26);
  check("recommended exact: 667",                  rec.recommended_qty === 667);
  check("cost_estimate exact: 71700",              rec.cost_estimate_minor === 71700);
  check("currency follows cost layer",             rec.currency === "USD");
  check("days_of_supply uses daily demand",        rec.days_of_supply === 16);

  // Reasoning carries every composed input.
  check("reasoning policy_slug",                   rec.reasoning.policy_slug === "math-policy");
  check("reasoning service_level",                 rec.reasoning.service_level === 0.95);
  check("reasoning z_score",                       Math.abs(rec.reasoning.z_score - 1.6449) < 1e-6);
  check("reasoning predicted_units",               rec.reasoning.predicted_units === 90);
  check("reasoning daily_demand",                  Math.abs(rec.reasoning.daily_demand - 3) < 1e-9);
  check("reasoning unit_cost_minor",               rec.reasoning.unit_cost_minor === 100);
  check("reasoning lead_time_days",                rec.reasoning.lead_time_days === 7);
  check("reasoning lead_time source threshold",    rec.reasoning.lead_time_source === "threshold");
  check("reasoning policy_source assigned",        rec.reasoning.policy_source === "assigned");
  check("reasoning tags empty (full data)",        Array.isArray(rec.reasoning.tags) && rec.reasoning.tags.length === 0);

  // Composed deps were each called once.
  check("forecastForSku called once",              df.calls.length === 1);
  check("evaluate called once",                    rt.calls.length === 1);
  check("currentLayers called once",               cl.calls.length === 1);
}

// ---- 4. service_level changes safety stock monotonically --------------

async function _testServiceLevelMonotonic() {
  var query = _makeQuery();
  // Use a 100-unit band → 1σ = 50; over 30 days, daily_std ≈ 1.6667.
  // lead_time_days = 14 → sqrt(14) ≈ 3.7417.
  // Safety stock @ z = 1.2816 (0.90): ceil(1.2816 * 3.7417 * 1.6667) = ceil(7.9923) = 8
  // Safety stock @ z = 1.6449 (0.95): ceil(1.6449 * 3.7417 * 1.6667) = ceil(10.2585) = 11
  // Safety stock @ z = 2.3263 (0.99): ceil(2.3263 * 3.7417 * 1.6667) = ceil(14.5076) = 15

  var df = _stubDemandForecast({
    "SL-1": {
      predicted_units:  90,
      confidence_low:   40,
      confidence_high:  140,
      baseline_method:  "simple_moving_average",
      seasonal_factor:  1,
    },
  });
  var rt = _stubReorderThresholds({
    "SL-1": {
      current_stock:  100,
      min_stock:      0,
      should_reorder: false,
      suggested_qty:  0,
      days_of_supply: null,
      lead_time_days: 14,
    },
  });
  var cl = _stubCostLayers({
    "SL-1": [{ quantity_remaining: 100, unit_cost_minor: 200, currency: "USD" }],
  });

  var sr = smartRestocking.create({
    query:             query,
    demandForecast:    df,
    reorderThresholds: rt,
    costLayers:        cl,
  });

  await sr.definePolicy({
    slug: "sl-policy", holding_cost_bps: 2500,
    ordering_cost_minor: 5000, default_service_level: 0.95,
  });
  await sr.applyPolicy({ slug: "sl-policy", sku: "SL-1" });

  var recLow  = await sr.recommendOrderQty({ sku: "SL-1", horizon_days: 30, service_level: 0.90 });
  var recMid  = await sr.recommendOrderQty({ sku: "SL-1", horizon_days: 30, service_level: 0.95 });
  var recHigh = await sr.recommendOrderQty({ sku: "SL-1", horizon_days: 30, service_level: 0.99 });

  check("safety_stock @ 0.90 = 8",                 recLow.safety_stock_qty === 8);
  check("safety_stock @ 0.95 = 11",                recMid.safety_stock_qty === 11);
  check("safety_stock @ 0.99 = 15",                recHigh.safety_stock_qty === 15);
  check("monotonic 0.90 < 0.95",                   recLow.safety_stock_qty < recMid.safety_stock_qty);
  check("monotonic 0.95 < 0.99",                   recMid.safety_stock_qty < recHigh.safety_stock_qty);

  // EOQ is invariant across service levels (only safety stock moves).
  check("EOQ invariant across SL: low == mid",     recLow.eoq_qty === recMid.eoq_qty);
  check("EOQ invariant across SL: mid == high",    recMid.eoq_qty === recHigh.eoq_qty);
  check("recommended_qty = eoq + safety",
    recLow.recommended_qty === recLow.eoq_qty + recLow.safety_stock_qty);
}

// ---- 5. graceful degradation when composed deps missing ---------------

async function _testDegradedComposition() {
  var query = _makeQuery();
  // No demandForecast / reorderThresholds / costLayers wired.
  var sr = smartRestocking.create({ query: query });

  var rec = await sr.recommendOrderQty({ sku: "BARE-1" });
  check("degraded: recommended_qty integer",       Number.isInteger(rec.recommended_qty));
  check("degraded: recommended_qty zero",          rec.recommended_qty === 0);
  check("degraded: eoq zero",                      rec.eoq_qty === 0);
  check("degraded: safety zero",                   rec.safety_stock_qty === 0);
  check("degraded: cost zero",                     rec.cost_estimate_minor === 0);
  check("degraded: currency USD fallback",         rec.currency === "USD");
  check("degraded: reasoning forecast-dep-missing",
    rec.reasoning.tags.indexOf("forecast-dep-missing") !== -1);
  check("degraded: reasoning threshold-dep-missing",
    rec.reasoning.tags.indexOf("threshold-dep-missing") !== -1);
  check("degraded: reasoning cost-dep-missing",
    rec.reasoning.tags.indexOf("cost-dep-missing") !== -1);
  check("degraded: reasoning no-cost-data tag",
    rec.reasoning.tags.indexOf("no-cost-data") !== -1);
  check("degraded: lead_time source default",      rec.reasoning.lead_time_source === "default");
  check("degraded: lead_time_days = 7",            rec.reasoning.lead_time_days === 7);
  check("degraded: policy_source default",         rec.reasoning.policy_source === "default");
}

// ---- 6. bulkRecommend fans out + handles failure rows -----------------

async function _testBulkRecommend() {
  var query = _makeQuery();
  var df = _stubDemandForecast({
    "BULK-A": { predicted_units: 60, confidence_low: 40, confidence_high: 80, baseline_method: "sma", seasonal_factor: 1 },
    "BULK-B": { predicted_units: 30, confidence_low: 20, confidence_high: 40, baseline_method: "sma", seasonal_factor: 1 },
  });
  var rt = _stubReorderThresholds({
    "BULK-A": { current_stock: 50, min_stock: 10, should_reorder: false, suggested_qty: 0, days_of_supply: null, lead_time_days: 5 },
    "BULK-B": { current_stock: 20, min_stock: 5,  should_reorder: false, suggested_qty: 0, days_of_supply: null, lead_time_days: 7 },
  });
  var cl = _stubCostLayers({
    "BULK-A": [{ quantity_remaining: 50, unit_cost_minor: 150, currency: "USD" }],
    "BULK-B": [{ quantity_remaining: 20, unit_cost_minor: 300, currency: "USD" }],
  });
  var sr = smartRestocking.create({
    query: query, demandForecast: df, reorderThresholds: rt, costLayers: cl,
  });

  await sr.definePolicy({
    slug: "bulk-policy", holding_cost_bps: 2000,
    ordering_cost_minor: 3000, default_service_level: 0.95,
  });
  await sr.applyPolicy({ slug: "bulk-policy", sku: "BULK-A" });
  await sr.applyPolicy({ slug: "bulk-policy", sku: "BULK-B" });

  var results = await sr.bulkRecommend({
    skus:         ["BULK-A", "BULK-B"],
    horizon_days: 30,
  });
  check("bulkRecommend returned 2 entries",         results.length === 2);
  check("first entry sku BULK-A",                   results[0].sku === "BULK-A");
  check("first entry has recommended_qty",          Number.isInteger(results[0].recommended_qty));
  check("first entry has reasoning",                results[0].reasoning && results[0].reasoning.policy_slug === "bulk-policy");
  check("second entry sku BULK-B",                  results[1].sku === "BULK-B");
  check("second entry has recommended_qty",         Number.isInteger(results[1].recommended_qty));

  // Mixed-success batch: one invalid SKU surfaces an error row but
  // doesn't block the others.
  var mixed = await sr.bulkRecommend({
    skus:         ["BULK-A", "!! invalid !!", "BULK-B"],
    horizon_days: 30,
  });
  check("mixed batch returned 3 entries",           mixed.length === 3);
  check("mixed batch first ok",                     mixed[0].recommended_qty != null);
  check("mixed batch middle has error",             typeof mixed[1].error === "string");
  check("mixed batch error mentions sku shape",     /must match/.test(mixed[1].error));
  check("mixed batch third ok",                     mixed[2].recommended_qty != null);

  // Refusals.
  await assert.rejects(sr.bulkRecommend(),                      /input object required/);
  await assert.rejects(sr.bulkRecommend({ skus: "x" }),         /skus must be an array/);
  await assert.rejects(sr.bulkRecommend({ skus: [] }),          /at least one entry/);
  // Service-level enum refusal up front.
  await assert.rejects(sr.bulkRecommend({ skus: ["X"], service_level: 0.50 }),
    /service_level must be one of/);
}

// ---- 7. metricsForSku windowed read + averages ------------------------

async function _testMetricsForSku() {
  var query = _makeQuery();
  var df = _stubDemandForecast({
    "METRIC-1": { predicted_units: 60, confidence_low: 40, confidence_high: 80, baseline_method: "sma", seasonal_factor: 1 },
  });
  var rt = _stubReorderThresholds({
    "METRIC-1": { current_stock: 50, min_stock: 10, should_reorder: false, suggested_qty: 0, days_of_supply: null, lead_time_days: 5 },
  });
  var cl = _stubCostLayers({
    "METRIC-1": [{ quantity_remaining: 50, unit_cost_minor: 200, currency: "USD" }],
  });
  var sr = smartRestocking.create({
    query: query, demandForecast: df, reorderThresholds: rt, costLayers: cl,
  });
  await sr.definePolicy({
    slug: "metric-policy", holding_cost_bps: 2500,
    ordering_cost_minor: 5000, default_service_level: 0.95,
  });
  await sr.applyPolicy({ slug: "metric-policy", sku: "METRIC-1" });

  // No history → empty window.
  var empty = await sr.metricsForSku({
    sku: "METRIC-1", from: 0, to: Date.now() + DAY_MS,
  });
  check("empty window count = 0",                  empty.count === 0);
  check("empty window avg_recommended_qty = 0",    empty.avg_recommended_qty === 0);
  check("empty window total_cost_estimate = 0",    empty.total_cost_estimate_minor === 0);
  check("empty window currency null",              empty.currency === null);
  check("empty window rows = []",                  Array.isArray(empty.rows) && empty.rows.length === 0);

  // Run three recommendations; the monotonic clock guarantees each
  // computed_at strictly increases.
  var r1 = await sr.recommendOrderQty({ sku: "METRIC-1", horizon_days: 30 });
  var r2 = await sr.recommendOrderQty({ sku: "METRIC-1", horizon_days: 30 });
  var r3 = await sr.recommendOrderQty({ sku: "METRIC-1", horizon_days: 30 });
  check("three runs share recommended_qty",        r1.recommended_qty === r2.recommended_qty &&
                                                   r2.recommended_qty === r3.recommended_qty);

  var window = await sr.metricsForSku({
    sku: "METRIC-1", from: 0, to: Date.now() + DAY_MS,
  });
  check("three-row window count = 3",              window.count === 3);
  check("avg_recommended_qty = single value",      window.avg_recommended_qty === r1.recommended_qty);
  check("avg_eoq_qty = single value",              window.avg_eoq_qty === r1.eoq_qty);
  check("total_cost = 3 * single value",           window.total_cost_estimate_minor === 3 * r1.cost_estimate_minor);
  check("currency = USD",                          window.currency === "USD");
  check("rows length = 3",                         window.rows.length === 3);
  check("rows sorted DESC by computed_at",
    window.rows[0].computed_at >= window.rows[1].computed_at &&
    window.rows[1].computed_at >= window.rows[2].computed_at);
  check("row reasoning hydrated",
    window.rows[0].reasoning && window.rows[0].reasoning.policy_slug === "metric-policy");

  // Refusals.
  await assert.rejects(sr.metricsForSku(),                              /input object required/);
  await assert.rejects(sr.metricsForSku({ sku: "X", from: 100, to: 50 }), /must be ≥ from/);
  await assert.rejects(sr.metricsForSku({ sku: "X", from: -1, to: 0 }),  /from/);
}

// ---- 8. mixed-currency window collapses combined fields ---------------

async function _testMetricsMixedCurrency() {
  var query = _makeQuery();
  // First recommendation in USD, second in EUR — the window read
  // exposes both rows but refuses to combine the totals.
  var df = _stubDemandForecast({
    "MIX-1": { predicted_units: 30, confidence_low: 20, confidence_high: 40, baseline_method: "sma", seasonal_factor: 1 },
  });
  var rt = _stubReorderThresholds({
    "MIX-1": { current_stock: 10, min_stock: 5, should_reorder: false, suggested_qty: 0, days_of_supply: null, lead_time_days: 7 },
  });

  var costLayersFlip = {
    calls:    [],
    nextCall: 0,
    currentLayers: async function (input) {
      this.calls.push(input);
      this.nextCall += 1;
      if (this.nextCall === 1) {
        return [{ quantity_remaining: 100, unit_cost_minor: 200, currency: "USD" }];
      }
      return [{ quantity_remaining: 100, unit_cost_minor: 180, currency: "EUR" }];
    },
  };

  var sr = smartRestocking.create({
    query: query, demandForecast: df, reorderThresholds: rt, costLayers: costLayersFlip,
  });
  await sr.definePolicy({
    slug: "mix", holding_cost_bps: 2500,
    ordering_cost_minor: 5000, default_service_level: 0.95,
  });
  await sr.applyPolicy({ slug: "mix", sku: "MIX-1" });

  await sr.recommendOrderQty({ sku: "MIX-1", horizon_days: 30 });
  await sr.recommendOrderQty({ sku: "MIX-1", horizon_days: 30 });

  var window = await sr.metricsForSku({
    sku: "MIX-1", from: 0, to: Date.now() + DAY_MS,
  });
  check("mixed window count = 2",                  window.count === 2);
  check("mixed window total_cost null",            window.total_cost_estimate_minor === null);
  check("mixed window currency null",              window.currency === null);
  check("mixed window per-row currencies preserved",
    window.rows[0].currency !== window.rows[1].currency);
}

// ---- 9. factory shape + run() smoke + edge refusals -------------------

async function _testFactoryShapeAndSmoke() {
  // Module-level exports.
  check("module exports create",                   typeof smartRestocking.create === "function");
  check("module exports run()",                    typeof smartRestocking.run === "function");
  check("module exports SERVICE_LEVELS",
    Array.isArray(smartRestocking.SERVICE_LEVELS) && smartRestocking.SERVICE_LEVELS.length === 3);
  check("module exports Z_SCORE",                  typeof smartRestocking.Z_SCORE === "object" &&
                                                   Math.abs(smartRestocking.Z_SCORE[0.95] - 1.6449) < 1e-6);
  check("module exports DEFAULT_POLICY",           typeof smartRestocking.DEFAULT_POLICY === "object" &&
                                                   smartRestocking.DEFAULT_POLICY.default_service_level === 0.95);
  check("module exports FALLBACK_LEAD_TIME_DAYS",  smartRestocking.FALLBACK_LEAD_TIME_DAYS === 7);
  check("module exports DEFAULT_HORIZON_DAYS",     smartRestocking.DEFAULT_HORIZON_DAYS === 30);

  // Bad factory wiring refusals.
  assert.throws(function () { smartRestocking.create({ demandForecast: {} }); },
    /demandForecast must expose forecastForSku/);
  assert.throws(function () { smartRestocking.create({ reorderThresholds: {} }); },
    /reorderThresholds must expose evaluate/);
  assert.throws(function () { smartRestocking.create({ costLayers: {} }); },
    /costLayers must expose currentLayers/);

  // Request-shape refusals on the request-time verbs.
  var sr = smartRestocking.create({ query: _makeQuery() });
  await assert.rejects(sr.definePolicy(),                                /input object required/);
  await assert.rejects(sr.applyPolicy(),                                 /input object required/);
  await assert.rejects(sr.unassignPolicy(),                              /input object required/);
  await assert.rejects(sr.recommendOrderQty(),                           /input object required/);
  await assert.rejects(sr.recommendOrderQty({ sku: "X", service_level: 0.50 }),
    /service_level must be one of/);
  await assert.rejects(sr.recommendOrderQty({ sku: "X", horizon_days: 0 }),
    /horizon_days/);
  await assert.rejects(sr.recommendOrderQty({ sku: "X", horizon_days: 9999 }),
    /horizon_days/);

  // Module-level run() smoke.
  var res = await smartRestocking.run();
  check("module.run() returns ok",                 res && res.ok === true);
}

async function run() {
  await _testDefinePolicy();
  await _testApplyPolicy();
  await _testRecommendOrderQtyMath();
  await _testServiceLevelMonotonic();
  await _testDegradedComposition();
  await _testBulkRecommend();
  await _testMetricsForSku();
  await _testMetricsMixedCurrency();
  await _testFactoryShapeAndSmoke();
  console.log("smart-restocking.test.js: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: run };

if (require.main === module) {
  run().catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
