"use strict";
/**
 * @module shop.smartRestocking
 * @title  Smart restocking — EOQ-style reorder quantity that composes
 *         demand forecast, reorder thresholds, cost layers and vendor
 *         lead-time signals
 *
 * @intro
 *   `reorderThresholds.evaluate` answers "should I order, and how
 *   much to refill the shelf?" with a velocity-times-lead-time gap
 *   calc. That's the right answer for the dashboard's "reorder queue"
 *   view — it's deterministic, cheap, and matches the operator's
 *   intuition for fast-moving SKUs.
 *
 *   This primitive answers a related but distinct question: "what's
 *   the COST-OPTIMAL order quantity given my holding-cost rate,
 *   per-PO ordering overhead, supplier lead time variance, and target
 *   stockout protection?" The answer is the textbook Economic Order
 *   Quantity (EOQ) formula:
 *
 *     EOQ = sqrt((2 * D * S) / H)
 *
 *     where  D = annual demand in units (predicted_units * 365 / horizon_days)
 *            S = ordering cost per PO in minor currency units
 *            H = holding cost per unit per year in minor currency
 *                  units (unit_cost_minor * holding_cost_bps / 10000)
 *
 *   Safety stock is added on top so the operator hits their target
 *   service level (probability of not stocking out during the lead
 *   time):
 *
 *     safety_stock = z * sigma_lead_time_demand
 *
 *     where  z is the inverse-normal CDF at the requested service
 *              level (0.90 -> 1.2816, 0.95 -> 1.6449, 0.99 -> 2.3263)
 *            sigma_lead_time_demand approximates as
 *              sqrt(lead_time_days) * daily_demand_std
 *            and daily_demand_std uses the predicted_units' confidence
 *              band width as the proxy: (confidence_high -
 *              confidence_low) / (2 * z_for_band). When no band is
 *              available, falls back to 25% of mean (typical retail
 *              CV for moderately variable demand).
 *
 *   The recommended order quantity is the sum:
 *
 *     recommended_qty = eoq_qty + safety_stock_qty
 *
 *   The reorder point (the inventory level at which the operator
 *   should place the next order) is:
 *
 *     reorder_point = (daily_demand * lead_time_days) + safety_stock
 *
 *   Cost estimate sums the unit-cost portion (recommended_qty *
 *   unit_cost_minor) plus the per-PO ordering overhead. Currency
 *   follows the cost-layer currency for the SKU; if no cost layer
 *   exists, defaults to "USD" with a zero unit-cost — the operator
 *   sees a "no-cost-data" entry in the reasoning so the gap is
 *   visible.
 *
 *   Verbs:
 *     definePolicy({ slug, holding_cost_bps, ordering_cost_minor,
 *                   default_service_level }) — register / patch a
 *         restocking policy. Re-defining the same slug patches every
 *         field in place. Operators that want one global policy
 *         define a slug like "default" and assign every SKU to it;
 *         operators that segment by velocity-class define multiple.
 *
 *     getPolicy(slug) / listPolicies({ include_archived? })
 *         — operator dashboard reads.
 *
 *     archivePolicy(slug) — soft-delete. SKUs already assigned to
 *         the policy keep resolving (the assignment row outlives
 *         the policy archival); operators re-assigning a SKU pick a
 *         non-archived target.
 *
 *     applyPolicy({ slug, sku }) — bind a SKU to a policy. Idempotent
 *         re-bind for the same (slug, sku) refreshes `assigned_at`;
 *         re-binding to a different slug replaces the existing
 *         assignment.
 *
 *     unassignPolicy({ sku }) — remove the SKU's policy binding.
 *         `recommendOrderQty` falls back to the default policy
 *         (holding_cost_bps = 0, ordering_cost_minor = 0,
 *         default_service_level = 0.95) when no binding exists.
 *
 *     policyForSku(sku) — read the (sku, policy) row + the resolved
 *         policy shape. Returns null when no assignment exists.
 *
 *     recommendOrderQty({ sku, location_code?, service_level?,
 *                         horizon_days? }) — the core verb. Composes:
 *         - demandForecast.forecastForSku to get predicted_units +
 *           confidence band
 *         - reorderThresholds (via `evaluate` or `getThreshold`) to
 *           read lead_time_days + current_stock
 *         - costLayers.currentLayers to derive unit_cost_minor +
 *           currency (volume-weighted average of active FIFO layers)
 *         - vendors.getVendor (optional) for vendor-level lead-time
 *           hints when reorderThresholds doesn't carry one
 *         Returns { recommended_qty, eoq_qty, safety_stock_qty,
 *         reorder_point, days_of_supply, cost_estimate_minor,
 *         currency, reasoning } and persists a recommendation row.
 *
 *     bulkRecommend({ skus, service_level?, horizon_days?,
 *                    location_code? }) — fan-out `recommendOrderQty`
 *         over an array of SKUs at one service level. Returns one
 *         entry per SKU including any { sku, error } shape when a
 *         single recommendation fails (one bad SKU doesn't block the
 *         batch).
 *
 *     metricsForSku({ sku, from, to }) — windowed read of every
 *         recommendation row in [from, to] for the SKU, with the
 *         summary shape { count, avg_recommended_qty, avg_eoq_qty,
 *         avg_safety_stock_qty, total_cost_estimate_minor, currency,
 *         rows: [...] }. Mixed-currency windows return currency=null
 *         and total_cost_estimate_minor=null with the per-row breakdown
 *         intact (the operator's FX policy decides combination).
 *
 *   Composition shape (every dep injected at the factory; the verbs
 *   degrade gracefully — a missing demandForecast collapses the
 *   primitive to a "no-forecast" reasoning row with the bare gap;
 *   a missing costLayers collapses cost_estimate_minor to 0 with a
 *   "no-cost-data" tag):
 *
 *     - query              — D1 handle for the three tables
 *     - demandForecast     — `forecastForSku(...)` for predicted_units
 *     - reorderThresholds  — `evaluate(...)` for current_stock + lead_time
 *     - costLayers         — `currentLayers({ sku })` for unit cost
 *     - vendors            — optional fallback lead-time when the
 *                            threshold's value is missing
 *     - b.uuid.v7          — recommendation row ids
 *
 *   Three-tier input validation: every verb is a config-time entry
 *   point (definePolicy, archivePolicy, applyPolicy, unassignPolicy)
 *   or a defensive request-shape reader (recommendOrderQty,
 *   bulkRecommend, metricsForSku, getPolicy, listPolicies,
 *   policyForSku) — bad input throws a typed TypeError. There are
 *   no drop-silent hot-path sinks; restocking is an operator-driven
 *   analytical surface, not an observability pipeline.
 *
 * @primitive smartRestocking
 * @related    shop.demandForecast, shop.reorderThresholds,
 *             shop.costLayers, shop.vendors, shop.autoReplenish,
 *             b.uuid.v7
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var SLUG_RE          = /^[a-z0-9][a-z0-9-]{0,63}$/;
var SKU_RE           = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var LOCATION_RE      = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

var MAX_HOLDING_BPS  = 100000;          // 1000% / yr — operator's upper bound; the migration CHECK enforces too
var MAX_ORDERING_COST_MINOR = 1000000000; // 1e9 minor units — sanity ceiling
var MAX_BULK_SKUS    = 500;
var MIN_HORIZON_DAYS = 1;
var MAX_HORIZON_DAYS = 365;
var DEFAULT_HORIZON_DAYS = 30;

var SERVICE_LEVELS   = Object.freeze([0.90, 0.95, 0.99]);

// Inverse-normal CDF (z-score) at the three supported service levels.
// These are the textbook one-tailed values; the safety-stock formula
// scales daily-demand sigma by sqrt(lead_time_days) and multiplies by
// the chosen z.
var Z_SCORE = Object.freeze({
  0.90: 1.2816,
  0.95: 1.6449,
  0.99: 2.3263,
});

// z-score used inside demandForecast to derive confidence_low /
// confidence_high. The forecast primitive's simple_moving_average
// model ships a ±1σ band, but other models use 1.5σ / 1.96σ. The
// safer default for the band-to-sigma conversion is the SMA's 1.0σ
// because (high - low) / 2 already equals 1σ in that shape. Operators
// surfacing a different model accept the small over-estimate; tests
// pin the value so changes are visible.
var FORECAST_BAND_Z = 1.0;

// Fallback coefficient of variation when the forecast doesn't carry
// a confidence band (e.g. cold-start SKU with one observation).
// 0.25 = 25% — typical retail SKU.
var FALLBACK_CV = 0.25;

var FALLBACK_LEAD_TIME_DAYS = 7;
var FALLBACK_CURRENCY = "USD";

// Default policy used when a SKU has no assignment. Picks a service
// level that matches industry norms (95% — the typical retail SLA)
// and zeroes out the holding/ordering costs so the EOQ collapses to
// "just buy the gap" — the operator's signal to define a real policy.
var DEFAULT_POLICY = Object.freeze({
  slug:                  "__default__",
  holding_cost_bps:      0,
  ordering_cost_minor:   0,
  default_service_level: 0.95,
});

// ---- monotonic clock ----------------------------------------------------
//
// `recommendOrderQty` is invoked from operator dashboards + batch
// jobs; the per-process monotonic clock guarantees recommendation rows
// emitted in the same millisecond carry strictly-increasing
// `computed_at` values so the (sku, computed_at DESC) history sort is
// deterministic across replays.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("smart-restocking: " + label + " must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + dash, 1..64 chars)");
  }
  return s;
}

function _sku(s, label) {
  label = label || "sku";
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("smart-restocking: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (1..128 chars)");
  }
  return s;
}

function _locationOrNull(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !LOCATION_RE.test(s)) {
    throw new TypeError("smart-restocking: location_code must match /^[A-Z0-9][A-Z0-9_-]*$/ (1..64 chars)");
  }
  return s;
}

function _holdingBps(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_HOLDING_BPS) {
    throw new TypeError("smart-restocking: holding_cost_bps must be a non-negative integer ≤ " + MAX_HOLDING_BPS);
  }
  return n;
}

function _orderingCost(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_ORDERING_COST_MINOR) {
    throw new TypeError("smart-restocking: ordering_cost_minor must be a non-negative integer ≤ " + MAX_ORDERING_COST_MINOR);
  }
  return n;
}

function _serviceLevel(n) {
  if (typeof n !== "number" || SERVICE_LEVELS.indexOf(n) === -1) {
    throw new TypeError("smart-restocking: service_level must be one of " +
      SERVICE_LEVELS.map(function (v) { return v.toFixed(2); }).join(", "));
  }
  return n;
}

function _horizonDays(n) {
  if (n == null) return DEFAULT_HORIZON_DAYS;
  if (!Number.isInteger(n) || n < MIN_HORIZON_DAYS || n > MAX_HORIZON_DAYS) {
    throw new TypeError("smart-restocking: horizon_days must be an integer in " +
      MIN_HORIZON_DAYS + ".." + MAX_HORIZON_DAYS);
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("smart-restocking: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

// ---- row hydration ------------------------------------------------------

function _shapePolicy(row) {
  if (!row) return null;
  return {
    slug:                  row.slug,
    holding_cost_bps:      Number(row.holding_cost_bps),
    ordering_cost_minor:   Number(row.ordering_cost_minor),
    default_service_level: Number(row.default_service_level),
    archived_at:           row.archived_at == null ? null : Number(row.archived_at),
    created_at:            Number(row.created_at),
    updated_at:            Number(row.updated_at),
  };
}

function _shapeRec(row) {
  if (!row) return null;
  var reasoning;
  try { reasoning = JSON.parse(row.reasoning_json || "{}"); }
  catch (_e) { reasoning = {}; }
  return {
    id:                   row.id,
    sku:                  row.sku,
    location_code:        row.location_code == null ? null : row.location_code,
    recommended_qty:      Number(row.recommended_qty),
    eoq_qty:              Number(row.eoq_qty),
    safety_stock_qty:     Number(row.safety_stock_qty),
    reorder_point:        Number(row.reorder_point),
    cost_estimate_minor:  Number(row.cost_estimate_minor),
    currency:             row.currency,
    reasoning:            reasoning,
    computed_at:          Number(row.computed_at),
  };
}

// ---- math helpers -------------------------------------------------------

// Weighted average unit cost across active FIFO layers. Returns
// { unit_cost_minor: number, currency: string } when at least one
// layer has positive remaining quantity; { unit_cost_minor: 0,
// currency: FALLBACK_CURRENCY } when no layers exist or all are
// exhausted. Mixed-currency layers throw — the operator's FX policy
// decides how to combine them and the primitive refuses to guess.
function _weightedAvgCost(layers) {
  if (!layers || !layers.length) {
    return { unit_cost_minor: 0, currency: FALLBACK_CURRENCY, has_data: false };
  }
  var totalQty = 0;
  var totalCost = 0;
  var currency = null;
  for (var i = 0; i < layers.length; i += 1) {
    var lay = layers[i];
    var qty = Number(lay.quantity_remaining || lay.quantity || 0);
    if (qty <= 0) continue;
    if (currency == null) currency = lay.currency || FALLBACK_CURRENCY;
    else if (lay.currency && lay.currency !== currency) {
      throw new TypeError("smart-restocking: cost layers for sku span multiple currencies (" +
        currency + ", " + lay.currency + ") — operator FX policy must reconcile before recommend");
    }
    totalQty += qty;
    totalCost += qty * Number(lay.unit_cost_minor || 0);
  }
  if (totalQty <= 0) {
    return { unit_cost_minor: 0, currency: FALLBACK_CURRENCY, has_data: false };
  }
  return {
    unit_cost_minor: Math.round(totalCost / totalQty),
    currency:        currency || FALLBACK_CURRENCY,
    has_data:        true,
  };
}

// EOQ formula: sqrt((2 * annualDemand * orderingCost) / holdingCost).
// `annualDemand` in units; `orderingCostMinor` per-PO overhead in
// minor units; `holdingCostMinor` per-unit-per-year in minor units.
// Returns 0 when any input is non-positive (the cost-optimum
// collapses to "just buy the gap" — the safety stock layer + the
// reorder-point gap then carry the answer).
function _eoq(annualDemand, orderingCostMinor, holdingCostMinor) {
  if (!(annualDemand > 0) || !(orderingCostMinor > 0) || !(holdingCostMinor > 0)) {
    return 0;
  }
  var raw = Math.sqrt((2 * annualDemand * orderingCostMinor) / holdingCostMinor);
  if (!isFinite(raw) || raw <= 0) return 0;
  return Math.round(raw);
}

// Daily-demand standard deviation derived from the forecast's
// confidence band. The forecast primitive ships predicted_units ±
// confidence band at the FORECAST_BAND_Z multiplier (1σ for SMA).
// Convert band width → 1σ, then scale to daily by dividing by
// horizon_days. Falls back to FALLBACK_CV * mean when no band exists.
function _dailyDemandStd(forecast, horizonDays) {
  var pred = Number(forecast && forecast.predicted_units) || 0;
  if (forecast && Number.isFinite(forecast.confidence_low) && Number.isFinite(forecast.confidence_high)) {
    var bandHalf = (Number(forecast.confidence_high) - Number(forecast.confidence_low)) / 2;
    if (bandHalf > 0) {
      var oneSigma = bandHalf / FORECAST_BAND_Z;
      return oneSigma / Math.max(horizonDays, 1);
    }
  }
  // Cold-start fallback: assume CV = FALLBACK_CV.
  var dailyMean = pred / Math.max(horizonDays, 1);
  return dailyMean * FALLBACK_CV;
}

// Safety stock: z * sqrt(lead_time_days) * daily_demand_std.
function _safetyStock(serviceLevel, leadTimeDays, dailyDemandStd) {
  var z = Z_SCORE[serviceLevel];
  if (z == null) z = Z_SCORE[0.95];
  if (!(leadTimeDays > 0) || !(dailyDemandStd > 0)) return 0;
  var raw = z * Math.sqrt(leadTimeDays) * dailyDemandStd;
  if (!isFinite(raw) || raw <= 0) return 0;
  return Math.ceil(raw);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var demandForecast = opts.demandForecast || null;
  if (demandForecast != null && typeof demandForecast !== "object") {
    throw new TypeError("smart-restocking.create: opts.demandForecast must be an object or null");
  }
  if (demandForecast != null && typeof demandForecast.forecastForSku !== "function") {
    throw new TypeError("smart-restocking.create: opts.demandForecast must expose forecastForSku(...) when provided");
  }

  var reorderThresholds = opts.reorderThresholds || null;
  if (reorderThresholds != null && typeof reorderThresholds !== "object") {
    throw new TypeError("smart-restocking.create: opts.reorderThresholds must be an object or null");
  }
  if (reorderThresholds != null && typeof reorderThresholds.evaluate !== "function") {
    throw new TypeError("smart-restocking.create: opts.reorderThresholds must expose evaluate(...) when provided");
  }

  var costLayers = opts.costLayers || null;
  if (costLayers != null && typeof costLayers !== "object") {
    throw new TypeError("smart-restocking.create: opts.costLayers must be an object or null");
  }
  if (costLayers != null && typeof costLayers.currentLayers !== "function") {
    throw new TypeError("smart-restocking.create: opts.costLayers must expose currentLayers(...) when provided");
  }

  var vendors = opts.vendors || null;
  if (vendors != null && typeof vendors !== "object") {
    throw new TypeError("smart-restocking.create: opts.vendors must be an object or null");
  }

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getPolicyRaw(slug) {
    var r = await query(
      "SELECT * FROM smart_restocking_policies WHERE slug = ?1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function _getAssignmentRaw(sku) {
    var r = await query(
      "SELECT * FROM smart_restocking_policy_assignments WHERE sku = ?1",
      [sku],
    );
    return r.rows[0] || null;
  }

  // Resolve the effective policy for a SKU. Falls back to DEFAULT_POLICY
  // when no assignment exists OR the assigned policy is archived
  // (the assignment outlives the policy, but the resolver picks the
  // safer fallback when the binding is stale).
  async function _resolvePolicy(sku) {
    var assignment = await _getAssignmentRaw(sku);
    if (!assignment) return { policy: DEFAULT_POLICY, source: "default" };
    var row = await _getPolicyRaw(assignment.policy_slug);
    if (!row || row.archived_at != null) {
      return { policy: DEFAULT_POLICY, source: "default-archived-fallback" };
    }
    return { policy: _shapePolicy(row), source: "assigned" };
  }

  async function _composeForecast(sku, locationCode, horizonDays) {
    if (!demandForecast) {
      return { forecast: null, reason: "forecast-dep-missing" };
    }
    try {
      var input = { sku: sku, horizon_days: horizonDays };
      if (locationCode != null) input.location_code = locationCode;
      var f = await demandForecast.forecastForSku(input);
      return { forecast: f, reason: null };
    } catch (e) {
      return { forecast: null, reason: "forecast-failed:" + ((e && e.message) || "unknown") };
    }
  }

  async function _composeThreshold(sku, locationCode) {
    if (!reorderThresholds) {
      return { evalRow: null, reason: "threshold-dep-missing" };
    }
    try {
      var input = { sku: sku };
      if (locationCode != null) input.location_code = locationCode;
      var ev = await reorderThresholds.evaluate(input);
      return { evalRow: ev, reason: null };
    } catch (e) {
      return { evalRow: null, reason: "threshold-failed:" + ((e && e.message) || "unknown") };
    }
  }

  async function _composeCost(sku) {
    if (!costLayers) {
      return { cost: { unit_cost_minor: 0, currency: FALLBACK_CURRENCY, has_data: false }, reason: "cost-dep-missing" };
    }
    try {
      var layers = await costLayers.currentLayers({ sku: sku });
      return { cost: _weightedAvgCost(layers), reason: null };
    } catch (e) {
      return {
        cost:   { unit_cost_minor: 0, currency: FALLBACK_CURRENCY, has_data: false },
        reason: "cost-failed:" + ((e && e.message) || "unknown"),
      };
    }
  }

  // Resolve a lead-time-days signal. Priority:
  //   1. reorderThresholds.evaluate's lead_time_days
  //   2. vendors.getVendor's lead_time_days (when supplied by the
  //      composed vendor primitive)
  //   3. FALLBACK_LEAD_TIME_DAYS
  async function _resolveLeadTime(evalRow) {
    if (evalRow && Number.isInteger(evalRow.lead_time_days) && evalRow.lead_time_days >= 0) {
      return { days: evalRow.lead_time_days, source: "threshold" };
    }
    // The threshold primitive carries the vendor_slug on its evalRow
    // when bound; fall back to vendor-level lead-time when the
    // composed vendor handle supplies it.
    if (vendors && evalRow && evalRow.vendor_slug && typeof vendors.getVendor === "function") {
      try {
        var v = await vendors.getVendor(evalRow.vendor_slug);
        if (v && Number.isInteger(v.lead_time_days) && v.lead_time_days >= 0) {
          return { days: v.lead_time_days, source: "vendor" };
        }
      } catch (_e) {
        // Fall through to the default — vendor read failures are
        // not fatal to a restocking recommendation.
      }
    }
    return { days: FALLBACK_LEAD_TIME_DAYS, source: "default" };
  }

  // Core recommendation engine — pure given inputs; the surrounding
  // verbs handle composition + persistence.
  function _recommend(inputs) {
    var policy        = inputs.policy;
    var serviceLevel  = inputs.serviceLevel;
    var horizonDays   = inputs.horizonDays;
    var forecast      = inputs.forecast;        // may be null
    var leadTimeDays  = inputs.leadTimeDays;
    var currentStock  = inputs.currentStock;    // may be null
    var unitCostMinor = inputs.unitCostMinor;
    var currency      = inputs.currency;

    var predictedUnits = forecast ? Number(forecast.predicted_units) || 0 : 0;
    var dailyDemand    = predictedUnits / Math.max(horizonDays, 1);
    var annualDemand   = dailyDemand * 365;

    // Holding cost per unit per year (minor units). bps is annual.
    var holdingPerUnitYear = (unitCostMinor * policy.holding_cost_bps) / 10000;

    var eoqQty = _eoq(annualDemand, policy.ordering_cost_minor, holdingPerUnitYear);

    var dailyStd = _dailyDemandStd(forecast, horizonDays);
    var safetyStockQty = _safetyStock(serviceLevel, leadTimeDays, dailyStd);

    var recommendedQty = eoqQty + safetyStockQty;

    // When EOQ collapsed to 0 (no holding-cost data) but the
    // operator still needs to refill the gap, fall back to the
    // velocity-times-horizon estimate so the recommendation isn't
    // zero for a SKU that's selling.
    if (eoqQty === 0 && predictedUnits > 0) {
      recommendedQty = Math.max(recommendedQty, Math.ceil(predictedUnits));
    }

    var reorderPoint = Math.ceil(dailyDemand * leadTimeDays) + safetyStockQty;

    var daysOfSupply = null;
    if (currentStock != null && dailyDemand > 0) {
      daysOfSupply = Math.floor(Number(currentStock) / dailyDemand);
    }

    var unitsCost = recommendedQty * unitCostMinor;
    var costEstimateMinor = unitsCost + policy.ordering_cost_minor;

    return {
      recommended_qty:     recommendedQty,
      eoq_qty:             eoqQty,
      safety_stock_qty:    safetyStockQty,
      reorder_point:       reorderPoint,
      days_of_supply:      daysOfSupply,
      cost_estimate_minor: costEstimateMinor,
      currency:            currency,
      _daily_demand:       dailyDemand,
      _annual_demand:      annualDemand,
      _daily_std:          dailyStd,
      _holding_per_unit_year: holdingPerUnitYear,
    };
  }

  return {
    SERVICE_LEVELS:           SERVICE_LEVELS.slice(),
    Z_SCORE:                  Object.assign({}, Z_SCORE),
    DEFAULT_POLICY:           Object.assign({}, DEFAULT_POLICY),
    FALLBACK_LEAD_TIME_DAYS:  FALLBACK_LEAD_TIME_DAYS,
    FALLBACK_CURRENCY:        FALLBACK_CURRENCY,
    DEFAULT_HORIZON_DAYS:     DEFAULT_HORIZON_DAYS,

    // Register / patch a smart-restocking policy. Re-defining the
    // same slug patches every field in place (operators surfacing
    // this through an admin UI write the same slug repeatedly on
    // each "save").
    definePolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smart-restocking.definePolicy: input object required");
      }
      var slug             = _slug(input.slug, "slug");
      var holdingBps       = _holdingBps(input.holding_cost_bps);
      var orderingCost     = _orderingCost(input.ordering_cost_minor);
      var defaultService   = _serviceLevel(input.default_service_level);
      var ts               = _now();

      var existing = await _getPolicyRaw(slug);
      if (existing) {
        await query(
          "UPDATE smart_restocking_policies SET holding_cost_bps = ?1, " +
          "ordering_cost_minor = ?2, default_service_level = ?3, " +
          "archived_at = NULL, updated_at = ?4 WHERE slug = ?5",
          [holdingBps, orderingCost, defaultService, ts, slug],
        );
        return _shapePolicy(await _getPolicyRaw(slug));
      }

      await query(
        "INSERT INTO smart_restocking_policies " +
        "(slug, holding_cost_bps, ordering_cost_minor, default_service_level, " +
        " archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
        [slug, holdingBps, orderingCost, defaultService, ts],
      );
      return _shapePolicy(await _getPolicyRaw(slug));
    },

    getPolicy: async function (slug) {
      _slug(slug, "slug");
      return _shapePolicy(await _getPolicyRaw(slug));
    },

    listPolicies: async function (listOpts) {
      listOpts = listOpts || {};
      var where = listOpts.include_archived ? "" : "WHERE archived_at IS NULL";
      var r = await query(
        "SELECT * FROM smart_restocking_policies " + where + " ORDER BY slug ASC",
        [],
      );
      return r.rows.map(_shapePolicy);
    },

    archivePolicy: async function (slug) {
      _slug(slug, "slug");
      var existing = await _getPolicyRaw(slug);
      if (!existing) {
        throw new TypeError("smart-restocking.archivePolicy: policy " +
          JSON.stringify(slug) + " not found");
      }
      if (existing.archived_at != null) return _shapePolicy(existing);
      var ts = _now();
      await query(
        "UPDATE smart_restocking_policies SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return _shapePolicy(await _getPolicyRaw(slug));
    },

    applyPolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smart-restocking.applyPolicy: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var sku  = _sku(input.sku);
      var existingPolicy = await _getPolicyRaw(slug);
      if (!existingPolicy) {
        throw new TypeError("smart-restocking.applyPolicy: policy " +
          JSON.stringify(slug) + " not found");
      }
      if (existingPolicy.archived_at != null) {
        throw new TypeError("smart-restocking.applyPolicy: policy " +
          JSON.stringify(slug) + " is archived — assign to an active policy");
      }
      var ts = _now();
      var existingAssignment = await _getAssignmentRaw(sku);
      if (existingAssignment) {
        await query(
          "UPDATE smart_restocking_policy_assignments SET policy_slug = ?1, assigned_at = ?2 WHERE sku = ?3",
          [slug, ts, sku],
        );
      } else {
        await query(
          "INSERT INTO smart_restocking_policy_assignments (sku, policy_slug, assigned_at) VALUES (?1, ?2, ?3)",
          [sku, slug, ts],
        );
      }
      return {
        sku:          sku,
        policy_slug:  slug,
        assigned_at:  ts,
      };
    },

    unassignPolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smart-restocking.unassignPolicy: input object required");
      }
      var sku = _sku(input.sku);
      var r = await query(
        "DELETE FROM smart_restocking_policy_assignments WHERE sku = ?1",
        [sku],
      );
      return { sku: sku, removed: Number(r.rowCount) > 0 };
    },

    policyForSku: async function (sku) {
      _sku(sku);
      var assignment = await _getAssignmentRaw(sku);
      if (!assignment) return null;
      var policy = _shapePolicy(await _getPolicyRaw(assignment.policy_slug));
      return {
        sku:           sku,
        policy_slug:   assignment.policy_slug,
        assigned_at:   Number(assignment.assigned_at),
        policy:        policy,
      };
    },

    // The core verb. Composes forecast + threshold + cost-layer
    // signals, runs the EOQ + safety-stock math, persists a
    // recommendation row, returns the result.
    recommendOrderQty: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smart-restocking.recommendOrderQty: input object required");
      }
      var sku          = _sku(input.sku);
      var locationCode = _locationOrNull(input.location_code);
      var horizonDays  = _horizonDays(input.horizon_days);

      var resolved = await _resolvePolicy(sku);
      var policy   = resolved.policy;

      var serviceLevel = input.service_level == null
        ? policy.default_service_level
        : _serviceLevel(input.service_level);

      var forecastResult  = await _composeForecast(sku, locationCode, horizonDays);
      var thresholdResult = await _composeThreshold(sku, locationCode);
      var costResult      = await _composeCost(sku);
      var leadTimeResult  = await _resolveLeadTime(thresholdResult.evalRow);

      var currentStock = thresholdResult.evalRow
        ? Number(thresholdResult.evalRow.current_stock)
        : null;

      var rec = _recommend({
        policy:          policy,
        serviceLevel:    serviceLevel,
        horizonDays:     horizonDays,
        forecast:        forecastResult.forecast,
        leadTimeDays:    leadTimeResult.days,
        currentStock:    currentStock,
        unitCostMinor:   costResult.cost.unit_cost_minor,
        currency:        costResult.cost.currency,
      });

      var tags = [];
      if (forecastResult.reason)  tags.push(forecastResult.reason);
      if (thresholdResult.reason) tags.push(thresholdResult.reason);
      if (costResult.reason)      tags.push(costResult.reason);
      if (!costResult.cost.has_data) tags.push("no-cost-data");

      var reasoning = {
        policy_slug:           policy.slug,
        policy_source:         resolved.source,
        service_level:         serviceLevel,
        z_score:               Z_SCORE[serviceLevel] || null,
        horizon_days:          horizonDays,
        predicted_units:       forecastResult.forecast ? Number(forecastResult.forecast.predicted_units) || 0 : null,
        confidence_low:        forecastResult.forecast ? forecastResult.forecast.confidence_low : null,
        confidence_high:       forecastResult.forecast ? forecastResult.forecast.confidence_high : null,
        daily_demand:          rec._daily_demand,
        daily_demand_std:      rec._daily_std,
        annual_demand:         rec._annual_demand,
        unit_cost_minor:       costResult.cost.unit_cost_minor,
        holding_per_unit_year: rec._holding_per_unit_year,
        ordering_cost_minor:   policy.ordering_cost_minor,
        holding_cost_bps:      policy.holding_cost_bps,
        lead_time_days:        leadTimeResult.days,
        lead_time_source:      leadTimeResult.source,
        current_stock:         currentStock,
        tags:                  tags,
      };

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO smart_restocking_recommendations " +
        "(id, sku, location_code, recommended_qty, eoq_qty, safety_stock_qty, " +
        " reorder_point, cost_estimate_minor, currency, reasoning_json, computed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        [id, sku, locationCode, rec.recommended_qty, rec.eoq_qty, rec.safety_stock_qty,
         rec.reorder_point, rec.cost_estimate_minor, rec.currency,
         JSON.stringify(reasoning), ts],
      );

      return {
        recommended_qty:     rec.recommended_qty,
        eoq_qty:             rec.eoq_qty,
        safety_stock_qty:    rec.safety_stock_qty,
        reorder_point:       rec.reorder_point,
        days_of_supply:      rec.days_of_supply,
        cost_estimate_minor: rec.cost_estimate_minor,
        currency:            rec.currency,
        reasoning:           reasoning,
      };
    },

    bulkRecommend: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smart-restocking.bulkRecommend: input object required");
      }
      if (!Array.isArray(input.skus)) {
        throw new TypeError("smart-restocking.bulkRecommend: skus must be an array");
      }
      if (input.skus.length === 0) {
        throw new TypeError("smart-restocking.bulkRecommend: skus must contain at least one entry");
      }
      if (input.skus.length > MAX_BULK_SKUS) {
        throw new TypeError("smart-restocking.bulkRecommend: skus may not exceed " + MAX_BULK_SKUS + " entries");
      }
      // Service level + horizon validated once up front when present.
      var serviceLevelOpt = input.service_level == null ? null : _serviceLevel(input.service_level);
      var horizonOpt = input.horizon_days == null ? null : _horizonDays(input.horizon_days);
      var locationCode = _locationOrNull(input.location_code);

      var out = [];
      for (var i = 0; i < input.skus.length; i += 1) {
        var sku = input.skus[i];
        try {
          _sku(sku, "skus[" + i + "]");
        } catch (e) {
          out.push({ sku: sku, error: (e && e.message) || "invalid sku" });
          continue;
        }
        try {
          var perInput = { sku: sku };
          if (locationCode != null)    perInput.location_code = locationCode;
          if (serviceLevelOpt != null) perInput.service_level = serviceLevelOpt;
          if (horizonOpt != null)      perInput.horizon_days  = horizonOpt;
          var rec = await this.recommendOrderQty(perInput);
          out.push({
            sku:                 sku,
            recommended_qty:     rec.recommended_qty,
            eoq_qty:             rec.eoq_qty,
            safety_stock_qty:    rec.safety_stock_qty,
            reorder_point:       rec.reorder_point,
            days_of_supply:      rec.days_of_supply,
            cost_estimate_minor: rec.cost_estimate_minor,
            currency:            rec.currency,
            reasoning:           rec.reasoning,
          });
        } catch (e) {
          out.push({ sku: sku, error: (e && e.message) || "recommend failed" });
        }
      }
      return out;
    },

    metricsForSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smart-restocking.metricsForSku: input object required");
      }
      var sku  = _sku(input.sku);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to, "to");
      if (to < from) {
        throw new TypeError("smart-restocking.metricsForSku: to (" + to + ") must be ≥ from (" + from + ")");
      }
      var r = await query(
        "SELECT * FROM smart_restocking_recommendations " +
        "WHERE sku = ?1 AND computed_at >= ?2 AND computed_at <= ?3 " +
        "ORDER BY computed_at DESC, id DESC",
        [sku, from, to],
      );
      var rows = r.rows.map(_shapeRec);
      var count = rows.length;
      if (count === 0) {
        return {
          sku:                       sku,
          count:                     0,
          avg_recommended_qty:       0,
          avg_eoq_qty:               0,
          avg_safety_stock_qty:      0,
          total_cost_estimate_minor: 0,
          currency:                  null,
          rows:                      [],
        };
      }
      var sumRec = 0;
      var sumEoq = 0;
      var sumSafety = 0;
      var sumCost = 0;
      var currency = rows[0].currency;
      var mixed = false;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        sumRec    += row.recommended_qty;
        sumEoq    += row.eoq_qty;
        sumSafety += row.safety_stock_qty;
        if (row.currency !== currency) mixed = true;
        if (!mixed) sumCost += row.cost_estimate_minor;
      }
      return {
        sku:                       sku,
        count:                     count,
        avg_recommended_qty:       sumRec / count,
        avg_eoq_qty:               sumEoq / count,
        avg_safety_stock_qty:      sumSafety / count,
        total_cost_estimate_minor: mixed ? null : sumCost,
        currency:                  mixed ? null : currency,
        rows:                      rows,
      };
    },
  };
}

// Smoke-callable run() — exercises the factory shape + the
// recommendOrderQty math against an in-memory query stub + stubbed
// composed primitives. The full coverage (composition against the
// real demandForecast / reorderThresholds / costLayers + EOQ math
// across service levels) lives in the layer-1 state test where the
// sqlite migration + dep graph is wired end-to-end.
async function run() {
  var policies = {};
  var assignments = {};
  var recs = [];
  var q = async function (sql, params) {
    params = params || [];
    var verb = sql.replace(/^\s+/, "").split(/\s+/)[0].toUpperCase();
    if (verb === "SELECT" && /FROM smart_restocking_policies/.test(sql) && /slug\s*=\s*\?1/.test(sql)) {
      var p = policies[params[0]];
      return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
    }
    if (verb === "SELECT" && /FROM smart_restocking_policies/.test(sql)) {
      var out = [];
      var keys = Object.keys(policies);
      for (var k = 0; k < keys.length; k += 1) {
        if (policies[keys[k]].archived_at == null) out.push(policies[keys[k]]);
      }
      return { rows: out, rowCount: out.length };
    }
    if (verb === "SELECT" && /FROM smart_restocking_policy_assignments/.test(sql)) {
      var a = assignments[params[0]];
      return { rows: a ? [a] : [], rowCount: a ? 1 : 0 };
    }
    if (verb === "SELECT" && /FROM smart_restocking_recommendations/.test(sql)) {
      return { rows: recs.slice(), rowCount: recs.length };
    }
    if (verb === "INSERT" && /smart_restocking_policies/.test(sql)) {
      policies[params[0]] = {
        slug:                  params[0],
        holding_cost_bps:      params[1],
        ordering_cost_minor:   params[2],
        default_service_level: params[3],
        archived_at:           null,
        created_at:            params[4],
        updated_at:            params[4],
      };
      return { rows: [], rowCount: 1 };
    }
    if (verb === "UPDATE" && /smart_restocking_policies/.test(sql)) {
      var slug = params[params.length - 1];
      var ex = policies[slug];
      if (ex) ex.updated_at = params[params.length - 2];
      return { rows: [], rowCount: ex ? 1 : 0 };
    }
    if (verb === "INSERT" && /smart_restocking_policy_assignments/.test(sql)) {
      assignments[params[0]] = {
        sku:          params[0],
        policy_slug:  params[1],
        assigned_at:  params[2],
      };
      return { rows: [], rowCount: 1 };
    }
    if (verb === "UPDATE" && /smart_restocking_policy_assignments/.test(sql)) {
      var sku = params[params.length - 1];
      var aex = assignments[sku];
      if (aex) {
        aex.policy_slug = params[0];
        aex.assigned_at = params[1];
      }
      return { rows: [], rowCount: aex ? 1 : 0 };
    }
    if (verb === "DELETE" && /smart_restocking_policy_assignments/.test(sql)) {
      var existed = assignments[params[0]] != null;
      delete assignments[params[0]];
      return { rows: [], rowCount: existed ? 1 : 0 };
    }
    if (verb === "INSERT" && /smart_restocking_recommendations/.test(sql)) {
      recs.push({
        id:                  params[0],
        sku:                 params[1],
        location_code:       params[2],
        recommended_qty:     params[3],
        eoq_qty:             params[4],
        safety_stock_qty:    params[5],
        reorder_point:       params[6],
        cost_estimate_minor: params[7],
        currency:            params[8],
        reasoning_json:      params[9],
        computed_at:         params[10],
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  var sr = create({ query: q });
  await sr.definePolicy({
    slug:                  "smoke-policy",
    holding_cost_bps:      2500,
    ordering_cost_minor:   5000,
    default_service_level: 0.95,
  });
  var p = await sr.getPolicy("smoke-policy");
  if (!p || p.slug !== "smoke-policy") {
    throw new Error("smart-restocking.run: smoke definePolicy round-trip failed");
  }
  await sr.applyPolicy({ slug: "smoke-policy", sku: "SMOKE-1" });
  var rec = await sr.recommendOrderQty({ sku: "SMOKE-1" });
  if (!rec || !Number.isInteger(rec.recommended_qty)) {
    throw new Error("smart-restocking.run: smoke recommendOrderQty round-trip failed");
  }
  return { ok: true };
}

module.exports = {
  create:                   create,
  run:                      run,
  SERVICE_LEVELS:           SERVICE_LEVELS,
  Z_SCORE:                  Z_SCORE,
  DEFAULT_POLICY:           DEFAULT_POLICY,
  FALLBACK_LEAD_TIME_DAYS:  FALLBACK_LEAD_TIME_DAYS,
  FALLBACK_CURRENCY:        FALLBACK_CURRENCY,
  DEFAULT_HORIZON_DAYS:     DEFAULT_HORIZON_DAYS,
};
