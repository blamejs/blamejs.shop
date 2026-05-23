"use strict";
/**
 * demand-forecast — per-SKU forward-looking demand prediction via
 * moving average + seasonal adjustment.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0179
 * (demand_history + demand_forecasts + forecast_models). No external
 * deps composed — the math is pure.
 *
 * Coverage:
 *   - recordHistoricalDemand insert + idempotent overwrite + refusals
 *   - forecastForSku math: simple_moving_average point estimate +
 *     confidence band shape
 *   - seasonalPattern: weekly detection threshold, multipliers shape
 *   - topGrowingSkus / topDecliningSkus windowed ranking
 *   - defineForecastModel insert + patch-in-place + kind enum refusal
 *   - bulkForecast fan-out + per-SKU shape
 *   - recomputeAllForecasts sweep
 *   - factory shape + run() smoke
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var demandForecast = require("../../lib/demand-forecast");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0179_demand_forecast.sql");

var DAY_MS = 24 * 60 * 60 * 1000;

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

// ---- 1. recordHistoricalDemand insert + idempotent overwrite + refusals

async function _testRecordHistory() {
  var query = _makeQuery();
  var df = demandForecast.create({ query: query });
  var nowMs = Date.now();
  var weekMs = 7 * DAY_MS;

  var rec = await df.recordHistoricalDemand({
    sku:          "ALPHA-001",
    period_start: nowMs - weekMs,
    period_end:   nowMs,
    units_sold:   140,
  });
  check("recordHistoricalDemand returns shaped row",  rec && rec.sku === "ALPHA-001");
  check("location_code defaults to null",             rec.location_code === null);
  check("units_sold echoed",                          rec.units_sold === 140);
  check("period_start echoed",                        rec.period_start === nowMs - weekMs);
  check("period_end echoed",                          rec.period_end === nowMs);
  check("occurred_at integer",                        Number.isInteger(rec.occurred_at));
  check("id stamped",                                 typeof rec.id === "string" && rec.id.length > 0);

  // Same window overwrites units_sold.
  var rec2 = await df.recordHistoricalDemand({
    sku:          "ALPHA-001",
    period_start: nowMs - weekMs,
    period_end:   nowMs,
    units_sold:   200,
  });
  check("idempotent overwrite returns same id",       rec2.id === rec.id);
  check("units_sold patched",                         rec2.units_sold === 200);
  check("occurred_at advanced",                       rec2.occurred_at >= rec.occurred_at);

  // location_code-bound row is a separate slot.
  var locRec = await df.recordHistoricalDemand({
    sku:           "ALPHA-001",
    location_code: "WH-EAST",
    period_start:  nowMs - weekMs,
    period_end:    nowMs,
    units_sold:    80,
  });
  check("location-bound row gets separate id",        locRec.id !== rec.id);
  check("location_code persisted",                    locRec.location_code === "WH-EAST");

  // Refusals.
  await assert.rejects(df.recordHistoricalDemand({
    sku: "BAD SKU WITH SPACES", period_start: 0, period_end: 1, units_sold: 1,
  }), /sku must match/);
  await assert.rejects(df.recordHistoricalDemand({
    sku: "OK-SKU", period_start: 1000, period_end: 500, units_sold: 1,
  }), /period_end.*must be ≥ period_start/);
  await assert.rejects(df.recordHistoricalDemand({
    sku: "OK-SKU", period_start: 0, period_end: 1, units_sold: -1,
  }), /units_sold/);
  await assert.rejects(df.recordHistoricalDemand(),
    /input object required/);
}

// ---- 2. forecastForSku simple_moving_average math + band shape ---------

async function _testForecastMath() {
  var query = _makeQuery();
  var df = demandForecast.create({ query: query });

  // Seed 4 weeks of history: 100, 110, 90, 100 units per 7-day window.
  // Mean units/day = (100/7 + 110/7 + 90/7 + 100/7) / 4 = 14.285...
  // Forecast horizon = 7 days → 7 * 14.285 ≈ 100 units (point estimate).
  var nowMs = Date.now();
  var weekMs = 7 * DAY_MS;
  var sales = [100, 110, 90, 100];
  for (var i = 0; i < sales.length; i += 1) {
    var end = nowMs - (i * weekMs);
    var start = end - weekMs + DAY_MS;
    await df.recordHistoricalDemand({
      sku:          "BETA-100",
      period_start: start,
      period_end:   end,
      units_sold:   sales[i],
    });
  }

  var fcst = await df.forecastForSku({
    sku:          "BETA-100",
    horizon_days: 7,
    as_of:        nowMs,
  });
  check("forecast returns predicted_units",            typeof fcst.predicted_units === "number");
  check("forecast returns confidence_low",             typeof fcst.confidence_low === "number");
  check("forecast returns confidence_high",            typeof fcst.confidence_high === "number");
  check("baseline_method present",                     typeof fcst.baseline_method === "string");
  check("seasonal_factor present",                     typeof fcst.seasonal_factor === "number");

  check("predicted_units integer",                     Number.isInteger(fcst.predicted_units));
  check("predicted_units roughly 100 (±5)",            fcst.predicted_units >= 95 && fcst.predicted_units <= 105);
  check("confidence_low ≤ predicted_units",            fcst.confidence_low <= fcst.predicted_units);
  check("confidence_high ≥ predicted_units",           fcst.confidence_high >= fcst.predicted_units);
  check("confidence_low ≥ 0",                          fcst.confidence_low >= 0);
  check("default baseline simple_moving_average",      fcst.baseline_method === "simple_moving_average");

  // Empty-history SKU returns zero / placeholder.
  var emptyFcst = await df.forecastForSku({
    sku:          "GHOST-SKU",
    horizon_days: 7,
    as_of:        nowMs,
  });
  check("empty history: predicted_units 0",            emptyFcst.predicted_units === 0);
  check("empty history: confidence_low 0",             emptyFcst.confidence_low === 0);
  check("empty history: confidence_high 0",            emptyFcst.confidence_high === 0);
  check("empty history: seasonal_factor 1",            emptyFcst.seasonal_factor === 1);

  // Refusals.
  await assert.rejects(df.forecastForSku({
    sku: "X", horizon_days: 0,
  }), /horizon_days/);
  await assert.rejects(df.forecastForSku({
    sku: "X", horizon_days: 5000,
  }), /horizon_days/);
  await assert.rejects(df.forecastForSku(),
    /input object required/);
}

// ---- 3. seasonalPattern weekly detection -------------------------------

async function _testSeasonalPattern() {
  var query = _makeQuery();
  var df = demandForecast.create({ query: query });

  // Single-day periods over 21 days — span ≥ WEEKLY_MIN_DAYS so the
  // primitive detects weekly seasonality but not monthly.
  var baseDate = Date.UTC(2026, 0, 4); // Sunday 2026-01-04
  for (var i = 0; i < 21; i += 1) {
    var dayMs = baseDate + i * DAY_MS;
    var dow = new Date(dayMs).getUTCDay();
    // Weekend spike: 50 units on Sat/Sun, 10 on weekdays.
    var units = (dow === 0 || dow === 6) ? 50 : 10;
    await df.recordHistoricalDemand({
      sku:          "SEASONAL-100",
      period_start: dayMs,
      period_end:   dayMs,
      units_sold:   units,
    });
  }

  var pattern = await df.seasonalPattern({ sku: "SEASONAL-100" });
  check("seasonalPattern returns weekly array",        Array.isArray(pattern.weekly) && pattern.weekly.length === 7);
  check("seasonalPattern returns monthly array",       Array.isArray(pattern.monthly) && pattern.monthly.length === 12);
  check("span_days reflects 21 days of history",       pattern.span_days >= 21);
  check("weekly_detected true (span ≥ 14 days)",       pattern.weekly_detected === true);
  check("monthly_detected false (span < 60 days)",     pattern.monthly_detected === false);
  // Sunday (index 0) multiplier should be > 1 (weekend spike).
  check("Sunday multiplier > 1",                       pattern.weekly[0] > 1);
  // Saturday (index 6) multiplier should be > 1.
  check("Saturday multiplier > 1",                     pattern.weekly[6] > 1);
  // Weekday multipliers (Mon-Fri) should be < 1.
  check("Monday multiplier < 1",                       pattern.weekly[1] < 1);
  check("Wednesday multiplier < 1",                    pattern.weekly[3] < 1);

  // Empty-history SKU returns placeholder multipliers.
  var ghostPattern = await df.seasonalPattern({ sku: "GHOST-PATTERN" });
  check("empty SKU: every weekly multiplier 1",
    ghostPattern.weekly.every(function (m) { return m === 1; }));
  check("empty SKU: weekly_detected false",            ghostPattern.weekly_detected === false);

  await assert.rejects(df.seasonalPattern(),
    /input object required/);
}

// ---- 4. topGrowingSkus / topDecliningSkus ------------------------------

async function _testTopGrowingDeclining() {
  var query = _makeQuery();
  var df = demandForecast.create({ query: query });

  var nowMs = Date.now();
  var monthMs = 30 * DAY_MS;
  var fromMs = nowMs - monthMs;
  var midMs  = fromMs + Math.floor(monthMs / 2);

  // GROW-SKU: first-half 10 units/period, second-half 50 units/period.
  await df.recordHistoricalDemand({
    sku: "GROW-SKU", period_start: fromMs, period_end: midMs - DAY_MS, units_sold: 10,
  });
  await df.recordHistoricalDemand({
    sku: "GROW-SKU", period_start: midMs + DAY_MS, period_end: nowMs, units_sold: 50,
  });

  // DECLINE-SKU: first-half 80 units/period, second-half 20 units/period.
  await df.recordHistoricalDemand({
    sku: "DECLINE-SKU", period_start: fromMs, period_end: midMs - DAY_MS, units_sold: 80,
  });
  await df.recordHistoricalDemand({
    sku: "DECLINE-SKU", period_start: midMs + DAY_MS, period_end: nowMs, units_sold: 20,
  });

  // STABLE-SKU: same in both halves.
  await df.recordHistoricalDemand({
    sku: "STABLE-SKU", period_start: fromMs, period_end: midMs - DAY_MS, units_sold: 30,
  });
  await df.recordHistoricalDemand({
    sku: "STABLE-SKU", period_start: midMs + DAY_MS, period_end: nowMs, units_sold: 30,
  });

  var growing = await df.topGrowingSkus({ from: fromMs, to: nowMs, limit: 10 });
  check("topGrowingSkus returns array",                Array.isArray(growing));
  check("topGrowingSkus includes GROW-SKU first",      growing[0] && growing[0].sku === "GROW-SKU");
  check("GROW-SKU growth_pct > 0",                     growing[0].growth_pct > 0);

  var declining = await df.topDecliningSkus({ from: fromMs, to: nowMs, limit: 10 });
  check("topDecliningSkus returns array",              Array.isArray(declining));
  check("topDecliningSkus includes DECLINE-SKU first", declining[0] && declining[0].sku === "DECLINE-SKU");
  check("DECLINE-SKU decline_pct < 0",                 declining[0].decline_pct < 0);

  // Stable SKU should NOT appear in either ranking (growth ≈ 0).
  var stableInGrow = growing.some(function (r) { return r.sku === "STABLE-SKU" && r.growth_pct > 0; });
  check("STABLE-SKU not in growing (growth_pct > 0)",  !stableInGrow);

  // Refusals.
  await assert.rejects(df.topGrowingSkus({ from: 1000, to: 500 }),
    /to .* must be > from/);
  await assert.rejects(df.topDecliningSkus({ from: 1000, to: 500 }),
    /to .* must be > from/);
  await assert.rejects(df.topGrowingSkus(), /input object required/);
}

// ---- 5. defineForecastModel insert + patch + refusals ------------------

async function _testDefineModel() {
  var query = _makeQuery();
  var df = demandForecast.create({ query: query });

  var m = await df.defineForecastModel({
    slug:        "wma-30",
    kind:        "weighted_moving_average",
    parameters:  { window_days: 30 },
  });
  check("defineForecastModel returns shaped row",      m && m.slug === "wma-30");
  check("kind echoed",                                 m.kind === "weighted_moving_average");
  check("parameters echoed",                           m.parameters.window_days === 30);
  check("active true on new",                          m.active === true);
  check("archived_at null on new",                     m.archived_at === null);

  // Re-define patches in place.
  var m2 = await df.defineForecastModel({
    slug:        "wma-30",
    kind:        "exponential_smoothing",
    parameters:  { alpha: 0.5 },
  });
  check("re-define patches kind",                      m2.kind === "exponential_smoothing");
  check("re-define patches parameters",                m2.parameters.alpha === 0.5);
  check("created_at preserved across patch",           m2.created_at === m.created_at);
  check("updated_at advanced",                         m2.updated_at >= m.updated_at);

  // Kind enum refusal.
  await assert.rejects(df.defineForecastModel({
    slug: "bad-kind", kind: "neural_net", parameters: {},
  }), /kind must be one of/);

  // Slug refusal.
  await assert.rejects(df.defineForecastModel({
    slug: "BAD-UPPER", kind: "simple_moving_average", parameters: {},
  }), /slug must match/);

  // Parameter refusals.
  await assert.rejects(df.defineForecastModel({
    slug: "bad-window", kind: "simple_moving_average",
    parameters: { window_days: 0 },
  }), /window_days/);
  await assert.rejects(df.defineForecastModel({
    slug: "bad-alpha", kind: "exponential_smoothing",
    parameters: { alpha: 1.5 },
  }), /alpha/);

  // Active model is read by forecastForSku — wire up some history
  // and confirm the baseline_method reflects the registered kind.
  var nowMs = Date.now();
  var weekMs = 7 * DAY_MS;
  for (var i = 0; i < 4; i += 1) {
    var end = nowMs - (i * weekMs);
    var start = end - weekMs + DAY_MS;
    await df.recordHistoricalDemand({
      sku: "WMA-TEST", period_start: start, period_end: end, units_sold: 100,
    });
  }
  var fcst = await df.forecastForSku({
    sku: "WMA-TEST", horizon_days: 7, as_of: nowMs,
  });
  check("active model picked by forecastForSku",       fcst.baseline_method === "exponential_smoothing");
}

// ---- 6. bulkForecast fan-out + per-SKU shape ---------------------------

async function _testBulkForecast() {
  var query = _makeQuery();
  var df = demandForecast.create({ query: query });

  var nowMs = Date.now();
  var weekMs = 7 * DAY_MS;
  var skus = ["BULK-A", "BULK-B", "BULK-C"];
  for (var i = 0; i < skus.length; i += 1) {
    await df.recordHistoricalDemand({
      sku: skus[i], period_start: nowMs - weekMs, period_end: nowMs, units_sold: 70,
    });
  }
  var results = await df.bulkForecast({
    skus:          skus,
    horizon_days:  7,
    as_of:         nowMs,
  });
  check("bulkForecast returns array",                  Array.isArray(results));
  check("bulkForecast returns one entry per sku",      results.length === 3);
  check("bulkForecast entry carries sku",              results[0].sku === "BULK-A");
  check("bulkForecast entry carries predicted_units",  Number.isInteger(results[0].predicted_units));
  check("bulkForecast entry carries seasonal_factor",  typeof results[0].seasonal_factor === "number");

  // Refusals.
  await assert.rejects(df.bulkForecast({ skus: [], horizon_days: 7 }),
    /at least one entry/);
  await assert.rejects(df.bulkForecast({ horizon_days: 7 }),
    /skus must be an array/);
  await assert.rejects(df.bulkForecast(), /input object required/);
}

// ---- 7. recomputeAllForecasts sweep ------------------------------------

async function _testRecomputeAllForecasts() {
  var query = _makeQuery();
  var df = demandForecast.create({ query: query });

  var nowMs = Date.now();
  var weekMs = 7 * DAY_MS;
  await df.recordHistoricalDemand({
    sku: "RECOMP-A", period_start: nowMs - weekMs, period_end: nowMs, units_sold: 100,
  });
  await df.recordHistoricalDemand({
    sku: "RECOMP-B", period_start: nowMs - weekMs, period_end: nowMs, units_sold: 200,
  });

  // Seed two forecast tuples.
  await df.forecastForSku({ sku: "RECOMP-A", horizon_days: 7, as_of: nowMs });
  await df.forecastForSku({ sku: "RECOMP-B", horizon_days: 14, as_of: nowMs });

  var summary = await df.recomputeAllForecasts({ as_of: nowMs });
  check("recomputeAllForecasts returns summary",       summary && typeof summary.recomputed === "number");
  check("recomputeAllForecasts sweeps both tuples",    summary.recomputed === 2);
}

// ---- 8. factory shape + module exports + smoke ------------------------

async function _testFactoryShapeAndSmoke() {
  // Factory: bad opts shape refused.
  assert.throws(function () {
    demandForecast.create({ order: "nope" });
  }, /order must be/);

  // Module exports.
  check("module exports run()",
    typeof demandForecast.run === "function");
  check("module exports MODEL_KINDS",
    Array.isArray(demandForecast.MODEL_KINDS) && demandForecast.MODEL_KINDS.length === 4);
  check("module exports MAX_HORIZON_DAYS",
    typeof demandForecast.MAX_HORIZON_DAYS === "number");
  check("module exports DEFAULT_WINDOW_DAYS",
    typeof demandForecast.DEFAULT_WINDOW_DAYS === "number");

  // Smoke.
  var res = await demandForecast.run();
  check("module.run() returns ok",                     res && res.ok === true);
}

async function run() {
  await _testRecordHistory();
  await _testForecastMath();
  await _testSeasonalPattern();
  await _testTopGrowingDeclining();
  await _testDefineModel();
  await _testBulkForecast();
  await _testRecomputeAllForecasts();
  await _testFactoryShapeAndSmoke();
  console.log("demand-forecast.test.js: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: run };

if (require.main === module) {
  run().catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
