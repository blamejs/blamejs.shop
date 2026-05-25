"use strict";
/**
 * @module shop.demandForecast
 * @title  Demand forecast — per-SKU forward-looking demand prediction
 *
 * @intro
 *   `reorderThresholds` derives a rolling-window units/day average
 *   from the operator's velocity log; `autoReplenish` consumes that
 *   signal to size POs. Both layers answer "how much should I order
 *   right now?" with a backward-looking velocity number. This
 *   primitive answers a related but distinct question: "given the
 *   SKU's history and any seasonal pattern, what's the EXPECTED
 *   demand over the next N days, with a confidence band?"
 *
 *   The split matters because:
 *     - reorderThresholds wants a single scalar (units/day) to feed
 *       the lead-time padding calc; it doesn't care about variance.
 *     - autoReplenish wants the SAME scalar but multiplied by a
 *       horizon to size a PO; again, point estimate is enough.
 *     - Operators planning seasonal inventory, warehouse capacity,
 *       or cash-flow want { point, low, high, seasonal multiplier }
 *       — a forecast SHAPE, not a scalar.
 *
 *   This primitive owns the forecast shape. It is intentionally
 *   composable into the two consumer primitives — when wired,
 *   reorderThresholds + autoReplenish can read `predicted_units` to
 *   replace their internal rolling-window math.
 *
 *   Four model kinds ship in v1:
 *
 *     simple_moving_average     — arithmetic mean over the last
 *                                 `window_days` of history. Default
 *                                 model when no model is registered.
 *                                 Confidence band: ±1σ.
 *     weighted_moving_average   — linearly weighted mean (most-recent
 *                                 period weight `window_days`, oldest
 *                                 weight 1). Heavier recency bias.
 *                                 Confidence band: ±1.5σ.
 *     exponential_smoothing     — Holt-style single exponential
 *                                 smoothing with operator-supplied
 *                                 alpha (0..1). Confidence band: ±
 *                                 residual standard error.
 *     linear_regression         — ordinary least squares on
 *                                 (period_start, units_sold). The
 *                                 forecast extrapolates the trend
 *                                 line `horizon_days` forward.
 *                                 Confidence band: ±1.96 * residual σ.
 *
 *   Seasonal pattern: every model multiplies its point estimate by
 *   the SKU's seasonal factor for the forecast horizon's day-of-week
 *   and month, computed by `seasonalPattern` from the history. When
 *   the SKU has fewer than two cycles of history (< 14 days for
 *   weekly seasonality, < 60 days for monthly), the factor falls
 *   back to 1.0 — no seasonality is detected.
 *
 *   Verbs:
 *     recordHistoricalDemand    — append-only write of one (sku,
 *                                 location_code?, period_start,
 *                                 period_end, units_sold)
 *                                 observation. Idempotent on
 *                                 (sku, location, period_start,
 *                                 period_end) — re-recording the same
 *                                 window overwrites units_sold.
 *     forecastForSku            — compute + persist a forecast for
 *                                 one (sku, location_code?,
 *                                 horizon_days) tuple. Returns the
 *                                 shape { predicted_units,
 *                                 confidence_low, confidence_high,
 *                                 baseline_method, seasonal_factor }.
 *     bulkForecast              — fan `forecastForSku` over an array
 *                                 of SKUs at one horizon. Returns
 *                                 one entry per SKU including the
 *                                 fallback row when history is empty.
 *     topGrowingSkus            — windowed read of the SKUs whose
 *                                 demand grew the most between two
 *                                 sub-windows (first-half vs
 *                                 second-half of [from, to]).
 *     topDecliningSkus          — same shape, reversed sign.
 *     seasonalPattern           — returns the weekly multipliers
 *                                 (7 entries indexed 0=Sunday..6=
 *                                 Saturday) and monthly multipliers
 *                                 (12 entries indexed 0=Jan..11=Dec)
 *                                 the SKU's history produces.
 *     defineForecastModel       — register / patch a model. `slug`
 *                                 is the primary key; `kind` picks
 *                                 the algorithm; `parameters` is a
 *                                 plain object the kind interprets.
 *     recomputeAllForecasts     — sweep every (sku, horizon) tuple
 *                                 that has at least one persisted
 *                                 forecast row and recompute it
 *                                 against the current history.
 *                                 Returns a summary of how many rows
 *                                 were updated.
 *
 *   Three-tier input validation: every public verb is a defensive
 *   config-time or request-shape reader — bad input throws a typed
 *   TypeError. There are no drop-silent hot-path sinks; demand
 *   forecasting is a SELECT-heavy analytical surface, not an
 *   observability pipeline.
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SKU_RE              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CODE_RE             = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SLUG_RE             = /^[a-z0-9][a-z0-9-]{0,63}$/;

var MODEL_KINDS         = Object.freeze([
  "simple_moving_average",
  "weighted_moving_average",
  "exponential_smoothing",
  "linear_regression",
]);

var MAX_HORIZON_DAYS    = 365;
var MAX_WINDOW_DAYS     = 365;
var MAX_LIMIT           = 500;
var MAX_BULK_SKUS       = 500;
var MAX_UNITS_SOLD      = 1000000000;

var DEFAULT_WINDOW_DAYS = 30;
var DEFAULT_ALPHA       = 0.3;

var DAY_MS              = C.TIME.days(1);

// Weekly-seasonality needs at least two full weeks of history to
// avoid claiming a pattern from one cycle. Monthly-seasonality needs
// two months.
var WEEKLY_MIN_DAYS     = 14;
var MONTHLY_MIN_DAYS    = 60;

// ---- monotonic clock ----------------------------------------------------
//
// `recordHistoricalDemand` and `forecastForSku` can stamp multiple
// rows in the same wall-clock millisecond (bulk operations,
// recomputeAllForecasts sweep). The history-window reads order by
// `occurred_at` / `computed_at` and tie on id; the monotonic step
// guarantees the timestamps strictly increase so the per-row
// ordering is deterministic across replays.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("demand-forecast: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _locationOrNull(s, label) {
  if (s == null) return null;
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("demand-forecast: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars) or null");
  }
  return s;
}

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("demand-forecast: " + label + " must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + dash, 1..64 chars)");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("demand-forecast: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _unitsSold(n, label) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_UNITS_SOLD) {
    throw new TypeError("demand-forecast: " + label + " must be a non-negative integer ≤ " + MAX_UNITS_SOLD);
  }
  return n;
}

function _horizonDays(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_HORIZON_DAYS) {
    throw new TypeError("demand-forecast: horizon_days must be an integer in 1.." + MAX_HORIZON_DAYS);
  }
  return n;
}

function _limit(n) {
  if (n == null) return MAX_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("demand-forecast: limit must be an integer in 1.." + MAX_LIMIT);
  }
  return n;
}

function _modelKind(s) {
  if (typeof s !== "string" || MODEL_KINDS.indexOf(s) === -1) {
    throw new TypeError("demand-forecast: kind must be one of " + MODEL_KINDS.join(", "));
  }
  return s;
}

function _parameters(p) {
  if (p == null) return {};
  if (typeof p !== "object" || Array.isArray(p)) {
    throw new TypeError("demand-forecast: parameters must be a plain object");
  }
  // Pull the knobs that any model kind might read; refuse garbage so
  // the operator catches the typo at definition time.
  var out = {};
  if (Object.prototype.hasOwnProperty.call(p, "window_days")) {
    var w = p.window_days;
    if (!Number.isInteger(w) || w <= 0 || w > MAX_WINDOW_DAYS) {
      throw new TypeError("demand-forecast: parameters.window_days must be an integer in 1.." + MAX_WINDOW_DAYS);
    }
    out.window_days = w;
  }
  if (Object.prototype.hasOwnProperty.call(p, "alpha")) {
    var a = p.alpha;
    if (typeof a !== "number" || !isFinite(a) || a <= 0 || a >= 1) {
      throw new TypeError("demand-forecast: parameters.alpha must be a number in (0, 1)");
    }
    out.alpha = a;
  }
  return out;
}

// ---- row hydration ------------------------------------------------------

function _shapeHistory(row) {
  if (!row) return null;
  return {
    id:             row.id,
    sku:            row.sku,
    location_code:  row.location_code == null ? null : row.location_code,
    period_start:   Number(row.period_start),
    period_end:     Number(row.period_end),
    units_sold:     Number(row.units_sold),
    occurred_at:    Number(row.occurred_at),
  };
}

function _shapeForecast(row) {
  if (!row) return null;
  return {
    id:               row.id,
    sku:              row.sku,
    location_code:    row.location_code == null ? null : row.location_code,
    horizon_days:     Number(row.horizon_days),
    predicted_units:  Number(row.predicted_units),
    confidence_low:   Number(row.confidence_low),
    confidence_high:  Number(row.confidence_high),
    model_slug:       row.model_slug,
    seasonal_factor:  Number(row.seasonal_factor),
    computed_at:      Number(row.computed_at),
  };
}

function _shapeModel(row) {
  if (!row) return null;
  var params = {};
  try {
    params = JSON.parse(row.parameters_json) || {};
  } catch (_e) {
    params = {};
  }
  return {
    slug:        row.slug,
    kind:        row.kind,
    parameters:  params,
    active:      row.active ? true : false,
    archived_at: row.archived_at == null ? null : Number(row.archived_at),
    created_at:  Number(row.created_at),
    updated_at:  Number(row.updated_at),
  };
}

// ---- math primitives ----------------------------------------------------
//
// Each model produces { units_per_day, residual_sigma }. Callers
// multiply by horizon_days * seasonal_factor and apply the model's
// band multiplier to derive predicted_units / confidence_low /
// confidence_high.

function _periodDays(row) {
  // Period length in days; clamp to 1 to avoid divide-by-zero when
  // the operator records a same-day observation.
  var span = Math.max(1, Math.round((row.period_end - row.period_start) / DAY_MS) + 1);
  return span;
}

function _unitsPerDay(row) {
  return row.units_sold / _periodDays(row);
}

function _simpleMovingAverage(rows) {
  if (!rows.length) return { units_per_day: 0, residual_sigma: 0 };
  var sum = 0;
  for (var i = 0; i < rows.length; i += 1) sum += _unitsPerDay(rows[i]);
  var mean = sum / rows.length;
  var varSum = 0;
  for (var j = 0; j < rows.length; j += 1) {
    var d = _unitsPerDay(rows[j]) - mean;
    varSum += d * d;
  }
  var sigma = Math.sqrt(varSum / rows.length);
  return { units_per_day: mean, residual_sigma: sigma };
}

function _weightedMovingAverage(rows) {
  if (!rows.length) return { units_per_day: 0, residual_sigma: 0 };
  // rows are ordered period_end DESC (most-recent first); assign
  // weight = rows.length to index 0, weight = 1 to index rows.length-1.
  var totalWeight = 0;
  var weightedSum = 0;
  for (var i = 0; i < rows.length; i += 1) {
    var w = rows.length - i;
    totalWeight += w;
    weightedSum += w * _unitsPerDay(rows[i]);
  }
  var mean = weightedSum / totalWeight;
  var varSum = 0;
  for (var j = 0; j < rows.length; j += 1) {
    var d = _unitsPerDay(rows[j]) - mean;
    varSum += d * d;
  }
  var sigma = Math.sqrt(varSum / rows.length);
  return { units_per_day: mean, residual_sigma: sigma };
}

function _exponentialSmoothing(rows, alpha) {
  if (!rows.length) return { units_per_day: 0, residual_sigma: 0 };
  // rows are period_end DESC; walk oldest -> newest so the smoothed
  // level reflects the most-recent observation.
  var ordered = rows.slice().reverse();
  var level = _unitsPerDay(ordered[0]);
  var residuals = [];
  for (var i = 1; i < ordered.length; i += 1) {
    var obs = _unitsPerDay(ordered[i]);
    residuals.push(obs - level);
    level = alpha * obs + (1 - alpha) * level;
  }
  var varSum = 0;
  for (var j = 0; j < residuals.length; j += 1) {
    varSum += residuals[j] * residuals[j];
  }
  var sigma = residuals.length ? Math.sqrt(varSum / residuals.length) : 0;
  return { units_per_day: level, residual_sigma: sigma };
}

function _linearRegression(rows) {
  if (!rows.length) return { units_per_day: 0, residual_sigma: 0 };
  if (rows.length === 1) {
    return { units_per_day: _unitsPerDay(rows[0]), residual_sigma: 0 };
  }
  // OLS on (x = period_start in days from epoch, y = units_per_day).
  var n = rows.length;
  var sx = 0;
  var sy = 0;
  var sxy = 0;
  var sxx = 0;
  for (var i = 0; i < n; i += 1) {
    var x = rows[i].period_start / DAY_MS;
    var y = _unitsPerDay(rows[i]);
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  var denom = (n * sxx) - (sx * sx);
  if (denom === 0) {
    return { units_per_day: sy / n, residual_sigma: 0 };
  }
  var slope = ((n * sxy) - (sx * sy)) / denom;
  var intercept = (sy - slope * sx) / n;
  // Project to the most-recent observation's x — that's the
  // "current" point on the trend line. (Caller multiplies by horizon
  // for the projection.)
  var mostRecentX = rows[0].period_start / DAY_MS;
  var projected = intercept + slope * mostRecentX;
  // Residual standard error.
  var resSum = 0;
  for (var j = 0; j < n; j += 1) {
    var xj = rows[j].period_start / DAY_MS;
    var yj = _unitsPerDay(rows[j]);
    var pred = intercept + slope * xj;
    resSum += (yj - pred) * (yj - pred);
  }
  var sigma = Math.sqrt(resSum / n);
  return { units_per_day: Math.max(0, projected), residual_sigma: sigma };
}

function _runModel(kind, parameters, rows) {
  if (kind === "weighted_moving_average") return _weightedMovingAverage(rows);
  if (kind === "exponential_smoothing")   return _exponentialSmoothing(rows, parameters.alpha || DEFAULT_ALPHA);
  if (kind === "linear_regression")       return _linearRegression(rows);
  // Default — simple_moving_average.
  return _simpleMovingAverage(rows);
}

function _bandMultiplier(kind) {
  if (kind === "weighted_moving_average") return 1.5;
  if (kind === "exponential_smoothing")   return 1.0;
  if (kind === "linear_regression")       return 1.96;
  return 1.0;
}

// Compute weekly + monthly seasonal multipliers from the SKU's
// history. The factor at index `i` is (mean units/day for periods
// overlapping day-of-week / month `i`) / (overall mean units/day).
// When the SKU has too little history for stable estimates, every
// entry is 1.0.
function _seasonalPattern(rows) {
  var weekly  = [1, 1, 1, 1, 1, 1, 1];
  var monthly = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  if (!rows.length) return { weekly: weekly, monthly: monthly };

  // Total span in days.
  var minStart = rows[0].period_start;
  var maxEnd   = rows[0].period_end;
  for (var i = 1; i < rows.length; i += 1) {
    if (rows[i].period_start < minStart) minStart = rows[i].period_start;
    if (rows[i].period_end   > maxEnd)   maxEnd   = rows[i].period_end;
  }
  var spanDays = Math.round((maxEnd - minStart) / DAY_MS) + 1;

  var totalSum   = 0;
  var totalCount = 0;
  var dayOfWeekSums   = [0, 0, 0, 0, 0, 0, 0];
  var dayOfWeekCounts = [0, 0, 0, 0, 0, 0, 0];
  var monthSums       = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var monthCounts     = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  for (var j = 0; j < rows.length; j += 1) {
    var row = rows[j];
    var perDay = _unitsPerDay(row);
    // Distribute the period's units/day across each day in the period.
    var d = row.period_start;
    while (d <= row.period_end) {
      var dt = new Date(d);
      var dow = dt.getUTCDay();
      var mon = dt.getUTCMonth();
      dayOfWeekSums[dow]   += perDay;
      dayOfWeekCounts[dow] += 1;
      monthSums[mon]       += perDay;
      monthCounts[mon]     += 1;
      totalSum   += perDay;
      totalCount += 1;
      d += DAY_MS;
    }
  }

  if (totalCount === 0) return { weekly: weekly, monthly: monthly };
  var overallMean = totalSum / totalCount;
  if (overallMean <= 0) return { weekly: weekly, monthly: monthly };

  if (spanDays >= WEEKLY_MIN_DAYS) {
    for (var w = 0; w < 7; w += 1) {
      if (dayOfWeekCounts[w] > 0) {
        var dayMean = dayOfWeekSums[w] / dayOfWeekCounts[w];
        weekly[w] = dayMean / overallMean;
      }
    }
  }
  if (spanDays >= MONTHLY_MIN_DAYS) {
    for (var m = 0; m < 12; m += 1) {
      if (monthCounts[m] > 0) {
        var monMean = monthSums[m] / monthCounts[m];
        monthly[m] = monMean / overallMean;
      }
    }
  }
  return { weekly: weekly, monthly: monthly };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  var order = opts.order || null;
  if (order != null && typeof order !== "object") {
    throw new TypeError("demand-forecast.create: opts.order must be an object or null");
  }

  async function _historyFor(sku, locationCode, windowDays) {
    var sinceMs = _now() - (windowDays * DAY_MS);
    var clauses = ["sku = ?1", "period_end >= ?2"];
    var params  = [sku, sinceMs];
    var idx     = 3;
    if (locationCode == null) {
      clauses.push("location_code IS NULL");
    } else {
      clauses.push("location_code = ?" + idx);
      params.push(locationCode);
      idx += 1;
    }
    var r = await query(
      "SELECT * FROM demand_history WHERE " + clauses.join(" AND ") +
      " ORDER BY period_end DESC, id DESC",
      params,
    );
    return r.rows.map(_shapeHistory);
  }

  async function _allHistoryFor(sku, locationCode) {
    var clauses = ["sku = ?1"];
    var params  = [sku];
    var idx     = 2;
    if (locationCode == null) {
      clauses.push("location_code IS NULL");
    } else {
      clauses.push("location_code = ?" + idx);
      params.push(locationCode);
      idx += 1;
    }
    var r = await query(
      "SELECT * FROM demand_history WHERE " + clauses.join(" AND ") +
      " ORDER BY period_end DESC, id DESC",
      params,
    );
    return r.rows.map(_shapeHistory);
  }

  async function _activeModel() {
    var r = await query(
      "SELECT * FROM forecast_models WHERE active = 1 AND archived_at IS NULL " +
      "ORDER BY updated_at DESC LIMIT 1",
      [],
    );
    return r.rows.length ? _shapeModel(r.rows[0]) : null;
  }

  async function _findHistoryRow(sku, locationCode, periodStart, periodEnd) {
    var clauses = ["sku = ?1", "period_start = ?2", "period_end = ?3"];
    var params  = [sku, periodStart, periodEnd];
    var idx     = 4;
    if (locationCode == null) {
      clauses.push("location_code IS NULL");
    } else {
      clauses.push("location_code = ?" + idx);
      params.push(locationCode);
      idx += 1;
    }
    var r = await query(
      "SELECT * FROM demand_history WHERE " + clauses.join(" AND ") + " LIMIT 1",
      params,
    );
    return r.rows[0] || null;
  }

  // Compute the seasonal factor that applies to a forecast horizon
  // starting `from` for `horizonDays`. Average the per-day weekly +
  // monthly multipliers across the forecast window so the band
  // reflects the average seasonal lift over the horizon, not the
  // start day alone.
  function _horizonSeasonalFactor(pattern, fromMs, horizonDays) {
    var sum = 0;
    var count = 0;
    var d = fromMs;
    for (var i = 0; i < horizonDays; i += 1) {
      var dt = new Date(d);
      var w  = pattern.weekly[dt.getUTCDay()] || 1;
      var m  = pattern.monthly[dt.getUTCMonth()] || 1;
      sum += w * m;
      count += 1;
      d += DAY_MS;
    }
    if (count === 0) return 1;
    return sum / count;
  }

  function _resolveModelFromInput(input, fallbackKind) {
    var kind = fallbackKind || "simple_moving_average";
    var parameters = {};
    if (input && input.model) {
      var m = input.model;
      if (m.kind != null)       kind = _modelKind(m.kind);
      if (m.parameters != null) parameters = _parameters(m.parameters);
    }
    return { kind: kind, parameters: parameters };
  }

  async function _forecastOne(sku, locationCode, horizonDays, asOfMs, modelOverride) {
    // Resolve the active model (or the override the verb passed).
    var modelSlug = "default";
    var kind      = "simple_moving_average";
    var parameters = {};
    if (modelOverride) {
      kind = modelOverride.kind;
      parameters = modelOverride.parameters || {};
    } else {
      var active = await _activeModel();
      if (active) {
        modelSlug  = active.slug;
        kind       = active.kind;
        parameters = active.parameters || {};
      }
    }

    var windowDays = parameters.window_days || DEFAULT_WINDOW_DAYS;
    var rows = await _historyFor(sku, locationCode, windowDays);
    var allRows = rows.length ? rows : await _allHistoryFor(sku, locationCode);

    var pattern = _seasonalPattern(allRows);
    var seasonalFactor = _horizonSeasonalFactor(pattern, asOfMs, horizonDays);

    var modelResult = _runModel(kind, parameters, rows);
    var unitsPerDay = modelResult.units_per_day;
    var sigma       = modelResult.residual_sigma;

    var pointEstimate = Math.max(0, unitsPerDay * horizonDays * seasonalFactor);
    var bandMult      = _bandMultiplier(kind);
    var bandWidth     = bandMult * sigma * horizonDays * seasonalFactor;

    var predicted = Math.round(pointEstimate);
    var low       = Math.max(0, Math.round(pointEstimate - bandWidth));
    var high      = Math.max(predicted, Math.round(pointEstimate + bandWidth));
    if (low > predicted) low = predicted;

    return {
      sku:              sku,
      location_code:    locationCode,
      horizon_days:     horizonDays,
      predicted_units:  predicted,
      confidence_low:   low,
      confidence_high:  high,
      baseline_method:  kind,
      model_slug:       modelSlug,
      seasonal_factor:  seasonalFactor,
    };
  }

  return {
    MODEL_KINDS:          MODEL_KINDS.slice(),
    MAX_HORIZON_DAYS:     MAX_HORIZON_DAYS,
    MAX_WINDOW_DAYS:      MAX_WINDOW_DAYS,
    DEFAULT_WINDOW_DAYS:  DEFAULT_WINDOW_DAYS,

    // Append-only (with idempotent overwrite on same window).
    recordHistoricalDemand: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("demand-forecast.recordHistoricalDemand: input object required");
      }
      var sku          = _sku(input.sku, "sku");
      var locationCode = _locationOrNull(input.location_code, "location_code");
      var periodStart  = _epochMs(input.period_start, "period_start");
      var periodEnd    = _epochMs(input.period_end,   "period_end");
      if (periodEnd < periodStart) {
        throw new TypeError("demand-forecast.recordHistoricalDemand: period_end (" +
          periodEnd + ") must be ≥ period_start (" + periodStart + ")");
      }
      var unitsSold    = _unitsSold(input.units_sold, "units_sold");

      var existing = await _findHistoryRow(sku, locationCode, periodStart, periodEnd);
      var ts = _now();
      if (existing) {
        await query(
          "UPDATE demand_history SET units_sold = ?1, occurred_at = ?2 WHERE id = ?3",
          [unitsSold, ts, existing.id],
        );
        return _shapeHistory({
          id:            existing.id,
          sku:           sku,
          location_code: locationCode,
          period_start:  periodStart,
          period_end:    periodEnd,
          units_sold:    unitsSold,
          occurred_at:   ts,
        });
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO demand_history " +
        "(id, sku, location_code, period_start, period_end, units_sold, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, sku, locationCode, periodStart, periodEnd, unitsSold, ts],
      );
      return _shapeHistory({
        id:            id,
        sku:           sku,
        location_code: locationCode,
        period_start:  periodStart,
        period_end:    periodEnd,
        units_sold:    unitsSold,
        occurred_at:   ts,
      });
    },

    forecastForSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("demand-forecast.forecastForSku: input object required");
      }
      var sku          = _sku(input.sku, "sku");
      var locationCode = _locationOrNull(input.location_code, "location_code");
      var horizonDays  = _horizonDays(input.horizon_days);
      var asOf         = input.as_of == null ? _now() : _epochMs(input.as_of, "as_of");
      var modelOverride = null;
      if (input.model != null) {
        if (typeof input.model !== "object") {
          throw new TypeError("demand-forecast.forecastForSku: model must be an object");
        }
        modelOverride = _resolveModelFromInput(input);
      }

      var forecast = await _forecastOne(sku, locationCode, horizonDays, asOf, modelOverride);

      // Persist the forecast row so the recompute sweep + the
      // consumer-side reads can find it later.
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO demand_forecasts " +
        "(id, sku, location_code, horizon_days, predicted_units, confidence_low, " +
        " confidence_high, model_slug, seasonal_factor, computed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [id, sku, locationCode, horizonDays, forecast.predicted_units,
         forecast.confidence_low, forecast.confidence_high,
         forecast.model_slug, forecast.seasonal_factor, ts],
      );
      return {
        predicted_units:  forecast.predicted_units,
        confidence_low:   forecast.confidence_low,
        confidence_high:  forecast.confidence_high,
        baseline_method:  forecast.baseline_method,
        seasonal_factor:  forecast.seasonal_factor,
      };
    },

    bulkForecast: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("demand-forecast.bulkForecast: input object required");
      }
      if (!Array.isArray(input.skus)) {
        throw new TypeError("demand-forecast.bulkForecast: skus must be an array");
      }
      if (input.skus.length === 0) {
        throw new TypeError("demand-forecast.bulkForecast: skus must contain at least one entry");
      }
      if (input.skus.length > MAX_BULK_SKUS) {
        throw new TypeError("demand-forecast.bulkForecast: skus may not exceed " + MAX_BULK_SKUS + " entries");
      }
      var horizonDays = _horizonDays(input.horizon_days);
      var asOf = input.as_of == null ? _now() : _epochMs(input.as_of, "as_of");
      var locationCode = _locationOrNull(input.location_code, "location_code");

      var out = [];
      for (var i = 0; i < input.skus.length; i += 1) {
        var sku = _sku(input.skus[i], "skus[" + i + "]");
        var forecast = await _forecastOne(sku, locationCode, horizonDays, asOf, null);
        var id = b.uuid.v7();
        var ts = _now();
        await query(
          "INSERT INTO demand_forecasts " +
          "(id, sku, location_code, horizon_days, predicted_units, confidence_low, " +
          " confidence_high, model_slug, seasonal_factor, computed_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
          [id, sku, locationCode, horizonDays, forecast.predicted_units,
           forecast.confidence_low, forecast.confidence_high,
           forecast.model_slug, forecast.seasonal_factor, ts],
        );
        out.push({
          sku:              sku,
          predicted_units:  forecast.predicted_units,
          confidence_low:   forecast.confidence_low,
          confidence_high:  forecast.confidence_high,
          baseline_method:  forecast.baseline_method,
          seasonal_factor:  forecast.seasonal_factor,
        });
      }
      return out;
    },

    // Top N SKUs by demand growth between two halves of [from, to].
    // The growth metric is the relative change in mean units/day
    // between the first-half window and the second-half window. SKUs
    // with no first-half observations are excluded so divide-by-zero
    // doesn't produce a sentinel "infinite growth" winner.
    topGrowingSkus: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("demand-forecast.topGrowingSkus: input object required");
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (to <= from) {
        throw new TypeError("demand-forecast.topGrowingSkus: to (" + to + ") must be > from (" + from + ")");
      }
      var limit = _limit(input.limit);
      var mid   = from + Math.floor((to - from) / 2);

      var r = await query(
        "SELECT sku, period_start, period_end, units_sold FROM demand_history " +
        "WHERE period_end >= ?1 AND period_start <= ?2 " +
        "ORDER BY sku ASC, period_end ASC",
        [from, to],
      );

      var byFirst  = {};
      var byFirstC = {};
      var bySecond = {};
      var bySecondC = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var perDay = Number(row.units_sold) / Math.max(1, Math.round((Number(row.period_end) - Number(row.period_start)) / DAY_MS) + 1);
        if (Number(row.period_end) <= mid) {
          byFirst[row.sku]  = (byFirst[row.sku]  || 0) + perDay;
          byFirstC[row.sku] = (byFirstC[row.sku] || 0) + 1;
        } else {
          bySecond[row.sku]  = (bySecond[row.sku]  || 0) + perDay;
          bySecondC[row.sku] = (bySecondC[row.sku] || 0) + 1;
        }
      }
      var out = [];
      var keys = Object.keys(bySecond);
      for (var j = 0; j < keys.length; j += 1) {
        var sku = keys[j];
        if (!byFirst[sku] || byFirstC[sku] === 0) continue;
        var firstMean  = byFirst[sku]  / byFirstC[sku];
        var secondMean = bySecond[sku] / bySecondC[sku];
        if (firstMean <= 0) continue;
        var growth = (secondMean - firstMean) / firstMean;
        out.push({
          sku:              sku,
          growth_pct:       growth,
          first_period_avg: firstMean,
          second_period_avg: secondMean,
        });
      }
      out.sort(function (a, b) { return b.growth_pct - a.growth_pct; });
      return out.slice(0, limit);
    },

    topDecliningSkus: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("demand-forecast.topDecliningSkus: input object required");
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (to <= from) {
        throw new TypeError("demand-forecast.topDecliningSkus: to (" + to + ") must be > from (" + from + ")");
      }
      var limit = _limit(input.limit);
      var mid   = from + Math.floor((to - from) / 2);

      var r = await query(
        "SELECT sku, period_start, period_end, units_sold FROM demand_history " +
        "WHERE period_end >= ?1 AND period_start <= ?2 " +
        "ORDER BY sku ASC, period_end ASC",
        [from, to],
      );

      var byFirst  = {};
      var byFirstC = {};
      var bySecond = {};
      var bySecondC = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var perDay = Number(row.units_sold) / Math.max(1, Math.round((Number(row.period_end) - Number(row.period_start)) / DAY_MS) + 1);
        if (Number(row.period_end) <= mid) {
          byFirst[row.sku]  = (byFirst[row.sku]  || 0) + perDay;
          byFirstC[row.sku] = (byFirstC[row.sku] || 0) + 1;
        } else {
          bySecond[row.sku]  = (bySecond[row.sku]  || 0) + perDay;
          bySecondC[row.sku] = (bySecondC[row.sku] || 0) + 1;
        }
      }
      var out = [];
      var keys = Object.keys(byFirst);
      for (var j = 0; j < keys.length; j += 1) {
        var sku = keys[j];
        if (byFirstC[sku] === 0) continue;
        var firstMean = byFirst[sku] / byFirstC[sku];
        if (firstMean <= 0) continue;
        var secondMean = (bySecond[sku] && bySecondC[sku] > 0)
          ? bySecond[sku] / bySecondC[sku]
          : 0;
        var decline = (secondMean - firstMean) / firstMean;
        if (decline >= 0) continue;
        out.push({
          sku:               sku,
          decline_pct:       decline,
          first_period_avg:  firstMean,
          second_period_avg: secondMean,
        });
      }
      out.sort(function (a, b) { return a.decline_pct - b.decline_pct; });
      return out.slice(0, limit);
    },

    seasonalPattern: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("demand-forecast.seasonalPattern: input object required");
      }
      var sku          = _sku(input.sku, "sku");
      var locationCode = _locationOrNull(input.location_code, "location_code");
      var rows = await _allHistoryFor(sku, locationCode);
      var pattern = _seasonalPattern(rows);
      // Span in days — derived from the rows themselves, so the
      // caller can tell whether the multipliers are placeholders
      // (span too short for the corresponding cycle) or computed.
      var spanDays = 0;
      if (rows.length) {
        var minS = rows[0].period_start;
        var maxE = rows[0].period_end;
        for (var i = 1; i < rows.length; i += 1) {
          if (rows[i].period_start < minS) minS = rows[i].period_start;
          if (rows[i].period_end   > maxE) maxE = rows[i].period_end;
        }
        spanDays = Math.round((maxE - minS) / DAY_MS) + 1;
      }
      return {
        weekly:                pattern.weekly,
        monthly:               pattern.monthly,
        span_days:             spanDays,
        weekly_detected:       spanDays >= WEEKLY_MIN_DAYS,
        monthly_detected:      spanDays >= MONTHLY_MIN_DAYS,
      };
    },

    defineForecastModel: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("demand-forecast.defineForecastModel: input object required");
      }
      var slug       = _slug(input.slug, "slug");
      var kind       = _modelKind(input.kind);
      var parameters = _parameters(input.parameters);
      var ts         = _now();
      var existingR = await query(
        "SELECT * FROM forecast_models WHERE slug = ?1",
        [slug],
      );
      var paramsJson = JSON.stringify(parameters);
      if (existingR.rows.length) {
        await query(
          "UPDATE forecast_models SET kind = ?1, parameters_json = ?2, " +
          "active = 1, archived_at = NULL, updated_at = ?3 WHERE slug = ?4",
          [kind, paramsJson, ts, slug],
        );
      } else {
        await query(
          "INSERT INTO forecast_models " +
          "(slug, kind, parameters_json, active, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, 1, NULL, ?4, ?4)",
          [slug, kind, paramsJson, ts],
        );
      }
      var r = await query(
        "SELECT * FROM forecast_models WHERE slug = ?1",
        [slug],
      );
      return _shapeModel(r.rows[0]);
    },

    recomputeAllForecasts: async function (input) {
      input = input || {};
      var asOf = input.as_of == null ? _now() : _epochMs(input.as_of, "as_of");
      // Pull the distinct (sku, location_code, horizon_days) tuples
      // that already have a persisted forecast. The sweep recomputes
      // each tuple's forecast against the current history.
      var r = await query(
        "SELECT DISTINCT sku, location_code, horizon_days FROM demand_forecasts " +
        "ORDER BY sku ASC, horizon_days ASC",
        [],
      );
      var updated = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var forecast = await _forecastOne(
          row.sku,
          row.location_code == null ? null : row.location_code,
          Number(row.horizon_days),
          asOf,
          null,
        );
        var id = b.uuid.v7();
        var ts = _now();
        await query(
          "INSERT INTO demand_forecasts " +
          "(id, sku, location_code, horizon_days, predicted_units, confidence_low, " +
          " confidence_high, model_slug, seasonal_factor, computed_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
          [id, forecast.sku, forecast.location_code, forecast.horizon_days,
           forecast.predicted_units, forecast.confidence_low, forecast.confidence_high,
           forecast.model_slug, forecast.seasonal_factor, ts],
        );
        updated += 1;
      }
      return { recomputed: updated };
    },
  };
}

// Smoke-callable run() — exercises the factory shape against an
// in-memory query stub so the release pipeline can confirm the module
// loads + composes without a live D1 or migration. The stub round-
// trips recordHistoricalDemand → forecastForSku → defineForecastModel;
// the actual analytical math lives in the layer-1 state test where
// the full sqlite is wired.
async function run() {
  var history  = [];
  var forecasts = [];
  var models   = {};
  var q = async function (sql, params) {
    params = params || [];
    var verb = sql.replace(/^\s+/, "").split(/\s+/)[0].toUpperCase();
    if (verb === "SELECT" && /FROM demand_history/.test(sql)) {
      var out = history.slice();
      if (/sku\s*=\s*\?1/.test(sql)) {
        out = out.filter(function (h) { return h.sku === params[0]; });
      }
      return { rows: out, rowCount: out.length };
    }
    if (verb === "INSERT" && /demand_history/.test(sql)) {
      history.push({
        id: params[0], sku: params[1], location_code: params[2],
        period_start: params[3], period_end: params[4],
        units_sold: params[5], occurred_at: params[6],
      });
      return { rows: [], rowCount: 1 };
    }
    if (verb === "UPDATE" && /demand_history/.test(sql)) {
      var rowId = params[params.length - 1];
      for (var i = 0; i < history.length; i += 1) {
        if (history[i].id === rowId) {
          history[i].units_sold  = params[0];
          history[i].occurred_at = params[1];
          return { rows: [], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (verb === "SELECT" && /FROM demand_forecasts/.test(sql)) {
      return { rows: forecasts.slice(), rowCount: forecasts.length };
    }
    if (verb === "INSERT" && /demand_forecasts/.test(sql)) {
      forecasts.push({
        id: params[0], sku: params[1], location_code: params[2],
        horizon_days: params[3], predicted_units: params[4],
        confidence_low: params[5], confidence_high: params[6],
        model_slug: params[7], seasonal_factor: params[8], computed_at: params[9],
      });
      return { rows: [], rowCount: 1 };
    }
    if (verb === "SELECT" && /FROM forecast_models/.test(sql) && /slug\s*=\s*\?1/.test(sql)) {
      var m = models[params[0]];
      return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
    }
    if (verb === "SELECT" && /FROM forecast_models/.test(sql)) {
      var arr = Object.keys(models).map(function (k) { return models[k]; });
      arr = arr.filter(function (mm) { return mm.active && mm.archived_at == null; });
      return { rows: arr, rowCount: arr.length };
    }
    if (verb === "INSERT" && /forecast_models/.test(sql)) {
      models[params[0]] = {
        slug: params[0], kind: params[1], parameters_json: params[2],
        active: 1, archived_at: null, created_at: params[3], updated_at: params[3],
      };
      return { rows: [], rowCount: 1 };
    }
    if (verb === "UPDATE" && /forecast_models/.test(sql)) {
      var slug = params[params.length - 1];
      var ex = models[slug];
      if (ex) {
        ex.kind            = params[0];
        ex.parameters_json = params[1];
        ex.active          = 1;
        ex.archived_at     = null;
        ex.updated_at      = params[2];
      }
      return { rows: [], rowCount: ex ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  var df = create({ query: q });
  var nowMs   = Date.now();
  var weekMs  = 7 * DAY_MS;
  await df.recordHistoricalDemand({
    sku:          "SMOKE-SKU",
    period_start: nowMs - weekMs,
    period_end:   nowMs,
    units_sold:   140,
  });
  var f = await df.forecastForSku({
    sku:          "SMOKE-SKU",
    horizon_days: 7,
  });
  if (!f || typeof f.predicted_units !== "number") {
    throw new Error("demand-forecast.run: smoke forecastForSku round-trip failed");
  }
  await df.defineForecastModel({
    slug:        "smoke-model",
    kind:        "simple_moving_average",
    parameters:  { window_days: 14 },
  });
  return { ok: true };
}

module.exports = {
  create:               create,
  run:                  run,
  MODEL_KINDS:          MODEL_KINDS,
  MAX_HORIZON_DAYS:     MAX_HORIZON_DAYS,
  MAX_WINDOW_DAYS:      MAX_WINDOW_DAYS,
  DEFAULT_WINDOW_DAYS:  DEFAULT_WINDOW_DAYS,
};
