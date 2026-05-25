"use strict";
/**
 * @module shop.discountAnalytics
 * @title  Discount analytics — per-coupon + per-tier-set redemption,
 *         impression, conversion, and revenue-impact aggregates.
 *
 * @intro
 *   Operator-dashboard read primitive backed by two append-only
 *   tables (`discount_impressions`, `discount_redemptions`).
 *   Storefront components record an impression each time a coupon
 *   bar / promo banner / cart-rail renders a code; the checkout
 *   pipeline records a redemption each time a code or quantity-
 *   discount tier set is accepted at checkout. This primitive then
 *   aggregates those rows into the surfaces an operator dashboard
 *   wants.
 *
 *   Distinct from `coupons` (which records the canonical
 *   redemption-on-order event tied to the order FSM) and from
 *   `quantityDiscounts` (which decides per-line price breaks
 *   automatically). The optional `coupons` / `quantityDiscounts`
 *   handles let the operator wire cross-checks ("does the redemption
 *   count match the coupons table?") without making either handle
 *   load-bearing — every aggregate runs against the locally-owned
 *   tables.
 *
 *   v1 surface:
 *
 *     - recordImpression({ coupon_code, session_id })
 *         Log a coupon-bar view. `session_id` is hashed via
 *         `b.crypto.namespaceHash("discount-analytics-session", ...)`
 *         at the boundary so the database never sees the raw
 *         identifier. Returns the row id. Append-only — re-rendering
 *         the bar 100 times produces 100 rows (the
 *         `COUNT(DISTINCT session_id_hash)` view collapses them).
 *
 *     - recordRedemption({ coupon_code, order_id, amount_minor,
 *                          currency? })
 *         Log a redemption. `amount_minor` is the discount amount in
 *         minor units (≥ 0); `currency` is the 3-letter ISO code and
 *         defaults to "USD" when omitted. Append-only. Quantity-
 *         discount tier-set redemptions use the convention
 *         `coupon_code = "tier:<tier_set_id>"` so the same table
 *         backs `tierPerformance`.
 *
 *     - topCoupons({ from, to, limit })
 *         Top-N coupons by redemption count across the window.
 *         Returns `[{ coupon_code, redemptions, gross_revenue_minor,
 *         currency }]` ordered by redemptions DESC, code ASC.
 *         `tier:` codes participate by default — operators who only
 *         want operator-typed codes filter the returned list.
 *
 *     - couponPerformance({ coupon_code, from, to })
 *         Per-coupon roll-up: `{ redemptions, gross_revenue_minor,
 *         average_discount_minor, conversion_rate, impressions,
 *         unique_sessions }`. `conversion_rate` is `redemptions /
 *         unique_sessions` as a float in [0, 1]; 0 when no
 *         impressions exist (rather than NaN). Multi-currency
 *         redemptions sum into `gross_revenue_minor` only when every
 *         redemption shares a currency; mixed-currency windows return
 *         a `currency: "MIXED"` shape so the operator UI knows to
 *         break the report out further.
 *
 *     - tierPerformance({ tier_set_id, from, to })
 *         Same shape as `couponPerformance` but keyed off the
 *         `tier:<tier_set_id>` synthetic code. When a
 *         `quantityDiscounts` handle is wired in, this method
 *         additionally returns the hydrated tier-set definition under
 *         `tier_set` (best-effort — a missing / archived set surfaces
 *         as `null`).
 *
 *     - revenueImpact({ from, to, currency? })
 *         Window-wide total discount given vs gross. Returns per-
 *         currency `[{ currency, total_discount_minor,
 *         redemption_count }]` — the dashboard composes the "gross
 *         revenue" side from the existing `salesReports` primitive
 *         and divides this row's `total_discount_minor` by that gross
 *         to get the impact percentage. Pre-computing the ratio here
 *         would force a join across two primitives' storage, which
 *         we deliberately avoid.
 *
 *     - redemptionFunnel({ coupon_code, from, to })
 *         Three-step funnel: `{ created, viewed, redeemed }`.
 *           created  — total impression rows (every bar render)
 *           viewed   — COUNT(DISTINCT session_id_hash) (unique
 *                      sessions that saw the bar)
 *           redeemed — total redemption rows
 *         The "shrinkage" between `created` -> `viewed` measures bar-
 *         dwell vs single-render-many-pageloads; between `viewed` ->
 *         `redeemed` measures the actual code-redemption conversion.
 *
 *   Composition:
 *
 *     - `b.crypto.namespaceHash("discount-analytics-session", id)`
 *       hashes every session id at the boundary. No raw session id
 *       reaches storage.
 *     - `b.uuid.v7` mints every row id.
 *     - Optional `coupons` handle — currently consulted only by
 *       cross-check hooks (none in v1 surface); reserved so an
 *       operator may pass it without behaviour change as soon as the
 *       coupons primitive lands.
 *     - Optional `quantityDiscounts` handle — when wired, exposes
 *       `tierBreakdown(tier_set_id)` or any of its read surfaces
 *       (`list`, `getTiersForLine`); the primitive only invokes the
 *       handle's read methods, never its mutating methods. Used by
 *       `tierPerformance` to hydrate the tier-set definition
 *       alongside the aggregate.
 *
 *   Storage:
 *
 *     - `discount_impressions`  (migration `0073_discount_analytics.sql`)
 *     - `discount_redemptions`  (migration `0073_discount_analytics.sql`)
 *
 * @primitive discountAnalytics
 * @related   coupons, quantityDiscounts, salesReports, promoBanners
 */

// ---- constants ----------------------------------------------------------

var SESSION_NAMESPACE = "discount-analytics-session";

var MAX_CODE_LEN     = 96;
var MAX_ORDER_ID_LEN = 128;
var MAX_SESSION_LEN  = 256;
var MAX_TIER_ID_LEN  = 128;
var MAX_LIMIT        = 200;

var ONE_YEAR_MS       = _b().constants.TIME.days(365);
var DEFAULT_WINDOW_MS = _b().constants.TIME.days(30);

// Coupon-code shape — alnum + dot/dash/underscore plus a `:` to
// admit the `tier:<id>` convention. Length-capped so a giant string
// can't bloat the index.
var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

// Tier-set id shape — matches uuid.v7 + any alnum/dash/underscore
// the operator might pass. Same length cap as MAX_TIER_ID_LEN.
var TIER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Order id shape — loose at the boundary; the order primitive owns
// stricter rules for its own ids.
var ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _code(value, label) {
  if (typeof value !== "string" || !CODE_RE.test(value)) {
    throw new TypeError(
      "discountAnalytics: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ " +
      "(≤ " + MAX_CODE_LEN + " chars)"
    );
  }
  return value;
}

function _tierSetId(value) {
  if (typeof value !== "string" || !TIER_ID_RE.test(value)) {
    throw new TypeError(
      "discountAnalytics: tier_set_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ " +
      "(≤ " + MAX_TIER_ID_LEN + " chars)"
    );
  }
  return value;
}

function _orderId(value) {
  if (typeof value !== "string" || !ORDER_ID_RE.test(value)) {
    throw new TypeError(
      "discountAnalytics: order_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ " +
      "(≤ " + MAX_ORDER_ID_LEN + " chars)"
    );
  }
  return value;
}

var _lastTs = 0;
function _nowMs() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

function _sessionId(value) {
  if (typeof value !== "string" || !value.length || value.length > MAX_SESSION_LEN) {
    throw new TypeError(
      "discountAnalytics: session_id must be a non-empty string ≤ " + MAX_SESSION_LEN + " chars"
    );
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError("discountAnalytics: session_id must not contain control bytes");
  }
  return value;
}

function _amount(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("discountAnalytics: amount_minor must be a non-negative integer");
  }
  return value;
}

function _currency(value, allowDefault) {
  if (value == null) {
    if (allowDefault) return "USD";
    throw new TypeError("discountAnalytics: currency must be a 3-letter ISO code");
  }
  if (typeof value !== "string" || value.length !== 3 || !/^[A-Z]{3}$/.test(value)) {
    throw new TypeError("discountAnalytics: currency must be a 3-letter uppercase ISO code");
  }
  return value;
}

function _epochMs(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("discountAnalytics: " + label + " must be a non-negative integer (epoch ms)");
  }
  return value;
}

function _resolveWindow(opts) {
  opts = opts || {};
  var now = Date.now();
  var from = opts.from == null ? (now - DEFAULT_WINDOW_MS) : opts.from;
  var to   = opts.to   == null ? now                       : opts.to;
  _epochMs(from, "from");
  _epochMs(to,   "to");
  if (from >= to) {
    throw new TypeError("discountAnalytics: from must be strictly less than to");
  }
  if ((to - from) > ONE_YEAR_MS) {
    throw new TypeError("discountAnalytics: window (to - from) must be ≤ 1 year");
  }
  return { from: from, to: to };
}

function _limit(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new TypeError("discountAnalytics: " + label + " must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return value;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional cross-check handles. Neither is load-bearing for any v1
  // aggregate — the locally-owned tables are the source of truth.
  // `coupons` is reserved for future cross-checks once that primitive
  // lands; `quantityDiscounts` is consulted by `tierPerformance` to
  // hydrate the tier-set definition next to the aggregate.
  var coupons           = opts.coupons || null;
  var quantityDiscounts = opts.quantityDiscounts || null;

  function _hashSession(sessionId) {
    return _b().crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
  }

  // ---- recordImpression ------------------------------------------------

  async function recordImpression(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAnalytics.recordImpression: input object required");
    }
    var code      = _code(input.coupon_code, "coupon_code");
    var sessionId = _sessionId(input.session_id);
    var occurredAt = input.occurred_at == null ? _nowMs() : _epochMs(input.occurred_at, "occurred_at");

    var id   = _b().uuid.v7();
    var hash = _hashSession(sessionId);
    await query(
      "INSERT INTO discount_impressions " +
      "(id, coupon_code, session_id_hash, occurred_at) VALUES (?1, ?2, ?3, ?4)",
      [id, code, hash, occurredAt],
    );
    return { id: id, coupon_code: code, occurred_at: occurredAt };
  }

  // ---- recordRedemption ------------------------------------------------

  async function recordRedemption(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAnalytics.recordRedemption: input object required");
    }
    var code     = _code(input.coupon_code, "coupon_code");
    var orderId  = _orderId(input.order_id);
    var amount   = _amount(input.amount_minor);
    var currency = _currency(input.currency, true);
    var occurredAt = input.occurred_at == null ? _nowMs() : _epochMs(input.occurred_at, "occurred_at");

    var id = _b().uuid.v7();
    await query(
      "INSERT INTO discount_redemptions " +
      "(id, coupon_code, order_id, amount_minor, currency, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, code, orderId, amount, currency, occurredAt],
    );
    return {
      id:           id,
      coupon_code:  code,
      order_id:     orderId,
      amount_minor: amount,
      currency:     currency,
      occurred_at:  occurredAt,
    };
  }

  // ---- topCoupons ------------------------------------------------------

  async function topCoupons(windowOpts) {
    var w = _resolveWindow(windowOpts);
    var rawLimit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
    _limit(rawLimit, "limit");

    // GROUP BY coupon_code first; the per-currency split is folded
    // into a single currency string when every redemption for the
    // code shares one (the common case), or "MIXED" otherwise.
    var r = await query(
      "SELECT coupon_code, " +
      "       COUNT(*) AS redemptions, " +
      "       SUM(amount_minor) AS gross_revenue_minor, " +
      "       COUNT(DISTINCT currency) AS currency_variants, " +
      "       MIN(currency) AS first_currency " +
      "  FROM discount_redemptions " +
      " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
      " GROUP BY coupon_code " +
      " ORDER BY redemptions DESC, coupon_code ASC " +
      " LIMIT ?3",
      [w.from, w.to, rawLimit],
    );
    return r.rows.map(function (row) {
      var variants = Number(row.currency_variants) || 0;
      return {
        coupon_code:         row.coupon_code,
        redemptions:         Number(row.redemptions) || 0,
        gross_revenue_minor: Number(row.gross_revenue_minor) || 0,
        currency:            variants > 1 ? "MIXED" : (row.first_currency || "USD"),
      };
    });
  }

  // ---- couponPerformance ----------------------------------------------

  async function _perCodePerformance(code, windowOpts) {
    var w = _resolveWindow(windowOpts);
    // Redemptions aggregate.
    var redRow = (await query(
      "SELECT COUNT(*) AS redemptions, " +
      "       SUM(amount_minor) AS gross_revenue_minor, " +
      "       COUNT(DISTINCT currency) AS currency_variants, " +
      "       MIN(currency) AS first_currency " +
      "  FROM discount_redemptions " +
      " WHERE coupon_code = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
      [code, w.from, w.to],
    )).rows[0] || {};

    // Impression aggregate.
    var impRow = (await query(
      "SELECT COUNT(*) AS impressions, " +
      "       COUNT(DISTINCT session_id_hash) AS unique_sessions " +
      "  FROM discount_impressions " +
      " WHERE coupon_code = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
      [code, w.from, w.to],
    )).rows[0] || {};

    var redemptions     = Number(redRow.redemptions) || 0;
    var gross           = Number(redRow.gross_revenue_minor) || 0;
    var variants        = Number(redRow.currency_variants) || 0;
    var impressions     = Number(impRow.impressions) || 0;
    var uniqueSessions  = Number(impRow.unique_sessions) || 0;
    var averageDiscount = redemptions > 0 ? Math.round(gross / redemptions) : 0;
    // Conversion rate keyed off unique sessions — total-impressions
    // double-counts a bar that re-renders in the same session, which
    // would understate the rate. uniqueSessions = 0 collapses to 0.
    var conversionRate = uniqueSessions > 0 ? redemptions / uniqueSessions : 0;

    return {
      coupon_code:             code,
      redemptions:             redemptions,
      gross_revenue_minor:     gross,
      average_discount_minor:  averageDiscount,
      conversion_rate:         conversionRate,
      impressions:             impressions,
      unique_sessions:         uniqueSessions,
      currency:                variants > 1 ? "MIXED" : (redRow.first_currency || null),
    };
  }

  async function couponPerformance(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAnalytics.couponPerformance: input object required");
    }
    var code = _code(input.coupon_code, "coupon_code");
    return await _perCodePerformance(code, input);
  }

  // ---- tierPerformance ------------------------------------------------

  async function tierPerformance(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAnalytics.tierPerformance: input object required");
    }
    var tierSetId = _tierSetId(input.tier_set_id);
    var syntheticCode = "tier:" + tierSetId;
    if (syntheticCode.length > MAX_CODE_LEN) {
      throw new TypeError(
        "discountAnalytics.tierPerformance: derived coupon_code (" + syntheticCode.length +
        " chars) exceeds " + MAX_CODE_LEN
      );
    }
    var perf = await _perCodePerformance(syntheticCode, input);

    // Optional tier-set hydration. The `quantityDiscounts` handle is
    // best-effort — a missing handle / archived set / handle without
    // the expected method all collapse to `tier_set: null` so the
    // dashboard always has SOMETHING to render.
    var tierSet = null;
    if (quantityDiscounts && typeof quantityDiscounts.tierBreakdown === "function") {
      try {
        var breakdown = await quantityDiscounts.tierBreakdown({ tier_set_id: tierSetId });
        if (breakdown && typeof breakdown === "object") tierSet = breakdown;
      } catch (_e) {
        tierSet = null;                                                          // drop-silent — best-effort hydration, real aggregate already returned
      }
    } else if (quantityDiscounts && typeof quantityDiscounts.list === "function") {
      try {
        // Fall back to `list` when the operator didn't wire a
        // `tierBreakdown` shorthand. Filter to the matching id.
        var listed = await quantityDiscounts.list({ limit: MAX_LIMIT });
        if (Array.isArray(listed)) {
          for (var i = 0; i < listed.length; i += 1) {
            var entry = listed[i];
            var setId = entry && entry.tier_set && entry.tier_set.id;
            if (setId === tierSetId) { tierSet = entry; break; }
          }
        }
      } catch (_e) {
        tierSet = null;                                                          // drop-silent — best-effort hydration
      }
    }

    perf.tier_set_id = tierSetId;
    perf.tier_set    = tierSet;
    return perf;
  }

  // ---- revenueImpact --------------------------------------------------

  async function revenueImpact(windowOpts) {
    var w = _resolveWindow(windowOpts);
    var currencyFilter = "";
    var params = [w.from, w.to];
    if (windowOpts && windowOpts.currency != null) {
      var cur = _currency(windowOpts.currency, false);
      currencyFilter = " AND currency = ?3";
      params.push(cur);
    }
    var r = await query(
      "SELECT currency, " +
      "       COUNT(*) AS redemption_count, " +
      "       SUM(amount_minor) AS total_discount_minor " +
      "  FROM discount_redemptions " +
      " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
      currencyFilter +
      " GROUP BY currency " +
      " ORDER BY total_discount_minor DESC, currency ASC",
      params,
    );
    return r.rows.map(function (row) {
      return {
        currency:              row.currency,
        redemption_count:      Number(row.redemption_count) || 0,
        total_discount_minor:  Number(row.total_discount_minor) || 0,
      };
    });
  }

  // ---- redemptionFunnel -----------------------------------------------

  async function redemptionFunnel(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAnalytics.redemptionFunnel: input object required");
    }
    var code = _code(input.coupon_code, "coupon_code");
    var w = _resolveWindow(input);

    var impRow = (await query(
      "SELECT COUNT(*) AS created, " +
      "       COUNT(DISTINCT session_id_hash) AS viewed " +
      "  FROM discount_impressions " +
      " WHERE coupon_code = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
      [code, w.from, w.to],
    )).rows[0] || {};

    var redRow = (await query(
      "SELECT COUNT(*) AS redeemed " +
      "  FROM discount_redemptions " +
      " WHERE coupon_code = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
      [code, w.from, w.to],
    )).rows[0] || {};

    return {
      coupon_code: code,
      created:     Number(impRow.created)  || 0,
      viewed:      Number(impRow.viewed)   || 0,
      redeemed:    Number(redRow.redeemed) || 0,
    };
  }

  // Reference the optional handle so the lint pass doesn't flag the
  // accepted-but-currently-unused `coupons` constructor opt. The
  // hook is reserved for a near-future cross-check surface and the
  // primitive should accept the handle today without behaviour
  // change.
  void coupons;

  return {
    SESSION_NAMESPACE: SESSION_NAMESPACE,
    DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
    ONE_YEAR_MS:       ONE_YEAR_MS,

    recordImpression:  recordImpression,
    recordRedemption:  recordRedemption,
    topCoupons:        topCoupons,
    couponPerformance: couponPerformance,
    tierPerformance:   tierPerformance,
    revenueImpact:     revenueImpact,
    redemptionFunnel:  redemptionFunnel,
  };
}

module.exports = {
  create:            create,
  SESSION_NAMESPACE: SESSION_NAMESPACE,
  DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
  ONE_YEAR_MS:       ONE_YEAR_MS,
  MAX_LIMIT:         MAX_LIMIT,
};
