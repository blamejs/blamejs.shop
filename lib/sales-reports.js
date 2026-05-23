"use strict";
/**
 * @module shop.salesReports
 * @title  Sales reports — operator-dashboard aggregations over orders
 *
 * @intro
 *   Read-only aggregate primitive. Every method composes a SQL
 *   aggregation against the `orders` / `order_lines` /
 *   `return_authorizations` tables and returns a JSON-shaped result
 *   suited for an operator dashboard.
 *
 *   v1 surface:
 *
 *     revenueByDay({ from, to, currency? })
 *     revenueByWeek({ from, to, currency? })
 *     revenueByMonth({ from, to, currency? })
 *       → [{ bucket_start, order_count, gross_revenue_minor,
 *            net_revenue_minor, refund_total_minor, currency }]
 *
 *     topProducts({ from, to, limit, currency? })
 *       → [{ sku, order_count, units_sold, gross_revenue_minor,
 *            average_unit_price_minor, currency }]
 *
 *     topCustomers({ from, to, limit })
 *       → [{ customer_id, order_count, gross_revenue_minor,
 *            average_order_minor, currency }]
 *         Customer ids only — no PII.
 *
 *     revenueByCountry({ from, to })
 *       → [{ country, order_count, gross_revenue_minor, currency }]
 *
 *     revenueByPaymentMethod({ from, to })
 *       → [{ payment_method, order_count, gross_revenue_minor,
 *            currency }]
 *         Method is derived from the processor-token prefix on the
 *         order (Stripe `pi_…` / `ch_…` → "stripe"; PayPal `PAY-…`
 *         / `EC-…` → "paypal"; "B-…" → "braintree"; "sq_…" →
 *         "square"; anything else with a non-null token → "other";
 *         NULL token → "unknown").
 *
 *     customerCohort({ cohort_month })
 *       → { cohort_month, cohort_size,
 *           retention: [{ month_offset, returning_customers,
 *                         retention_rate, gross_revenue_minor,
 *                         currency }] }
 *         `cohort_month` is "YYYY-MM" (UTC). The cohort is every
 *         customer_id whose first-ever order landed in that month;
 *         retention is reported per subsequent calendar month up to
 *         12 months out.
 *
 *     aov({ from, to, currency? })
 *       → { count, gross_revenue_minor, aov_minor, currency }
 *
 *     refundRate({ from, to })
 *       → { order_count, refunded_count, refund_rate_bps }
 *         Rate is integer basis-points (0–10000) — operator UIs
 *         render `bps / 100` as a percentage.
 *
 *     funnel({ from, to })
 *       → { checkout_started, payment_intent_created, paid,
 *           fulfilled, refunded }
 *         Counts of orders that reached each milestone within the
 *         window. `checkout_started` counts every order row;
 *         `payment_intent_created` counts orders with a non-null
 *         `payment_intent_id`; `paid` is the FSM-reached count
 *         (status >= 'paid'); `fulfilled` is status IN
 *         ('shipped','delivered'); `refunded` is status =
 *         'refunded'.
 *
 *   Revenue counting policy (matches the analytics primitive):
 *
 *     - `cancelled` orders contribute zero (excluded entirely).
 *     - `refunded` orders subtract `grand_total_minor` from
 *       net revenue but contribute their full amount to gross.
 *     - Every other status (pending / paid / fulfilling / shipped /
 *       delivered) contributes at face value to both gross + net.
 *
 *   Multi-currency: every aggregate is grouped by currency. The
 *   optional `currency?` argument on the per-day/week/month + top-
 *   products + AOV reports filters to a single currency so dashboards
 *   render one chart per currency.
 *
 *   Big-result safety: detail surfaces (`topProducts`,
 *   `topCustomers`) cap `limit` at 100; the SQL `LIMIT` is bound at
 *   the parameter, not interpolated. The cache table memoizes the
 *   expensive reports — a `cache?` opt on each call enables hit-
 *   then-recompute. Cursor pagination is exposed on the detail
 *   reports via the `cursor?` / `next_cursor` pair; the HMAC
 *   envelope is the same `b.pagination` shape every other primitive
 *   uses.
 *
 *   Composition:
 *
 *     - `b.crypto.namespaceHash` — params_hash on cache rows.
 *     - `b.uuid.v7`              — cache-row ids.
 *     - `b.pagination`           — cursor envelopes on detail surfaces.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var ONE_YEAR_MS  = 365 * 24 * 60 * 60 * 1000;
var DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
var DAY_MS       = 24 * 60 * 60 * 1000;

// Cache TTL by report key. Operator can override per-call via
// `cache_ttl_ms`; these are the safe defaults — short enough that a
// new order shows up on a refresh, long enough that an operator
// hammering the dashboard doesn't re-scan the orders table on every
// keystroke.
var DEFAULT_CACHE_TTL_MS = {
  revenue_by_day:           60 * 1000,
  revenue_by_week:          5 * 60 * 1000,
  revenue_by_month:         10 * 60 * 1000,
  top_products:             5 * 60 * 1000,
  top_customers:            5 * 60 * 1000,
  revenue_by_country:       5 * 60 * 1000,
  revenue_by_payment:       5 * 60 * 1000,
  customer_cohort:          15 * 60 * 1000,
  aov:                      60 * 1000,
  refund_rate:              60 * 1000,
  funnel:                   60 * 1000,
};

var CACHE_NAMESPACE = "sales-report-cache";

// Top-N cursor order keys. Detail surfaces expose cursor pagination
// for big-result safety; the keyset is descending across the sort
// columns + the tie-breaker (sku / customer_id).
var TOP_PRODUCTS_ORDER_KEY  = ["gross_revenue_minor:desc", "sku:asc"];
var TOP_CUSTOMERS_ORDER_KEY = ["gross_revenue_minor:desc", "customer_id:asc"];

// ---- validators ---------------------------------------------------------

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("salesReports: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _resolveWindow(opts) {
  opts = opts || {};
  var now = Date.now();
  var from = opts.from == null ? (now - DEFAULT_WINDOW_MS) : opts.from;
  var to   = opts.to   == null ? now                       : opts.to;
  _epochMs(from, "from");
  _epochMs(to,   "to");
  if (from >= to) {
    throw new TypeError("salesReports: from must be strictly less than to");
  }
  if ((to - from) > ONE_YEAR_MS) {
    throw new TypeError("salesReports: window (to - from) must be ≤ 1 year");
  }
  return { from: from, to: to };
}

function _limit(n, label, max) {
  max = max || 100;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new TypeError("salesReports: " + label + " must be an integer in [1, " + max + "]");
  }
}

function _currency(value) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length !== 3) {
    throw new TypeError("salesReports: currency must be a 3-letter code");
  }
  return value;
}

function _cohortMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError("salesReports: cohort_month must be \"YYYY-MM\"");
  }
  return value;
}

// Canonical JSON for cache key — sorted keys, stable across runs so
// the same input hashes the same way every time. Recursive over
// plain objects + arrays; primitives serialize as JSON's own rules.
function _canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(_canonicalJSON).join(",") + "]";
  }
  var keys = Object.keys(value).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i += 1) {
    parts.push(JSON.stringify(keys[i]) + ":" + _canonicalJSON(value[keys[i]]));
  }
  return "{" + parts.join(",") + "}";
}

// Derive the operator-facing payment-method label from a processor
// token. `payment_intent_id` carries the processor's token prefix
// (Stripe `pi_…`, PayPal `PAY-…` / `EC-…`, Braintree `B-…`, Square
// `sq_…`); anything else with a non-null token is "other" and a
// NULL token is "unknown". The mapping lives in SQL inside each
// report so the GROUP BY can use it; this constant mirrors the same
// logic for the SQL CASE.
var PAYMENT_METHOD_CASE_SQL =
  "CASE " +
  "WHEN payment_intent_id IS NULL THEN 'unknown' " +
  "WHEN payment_intent_id LIKE 'pi_%' OR payment_intent_id LIKE 'ch_%' OR payment_intent_id LIKE 'pm_%' THEN 'stripe' " +
  "WHEN payment_intent_id LIKE 'PAY-%' OR payment_intent_id LIKE 'EC-%' OR payment_intent_id LIKE 'PAYID-%' THEN 'paypal' " +
  "WHEN payment_intent_id LIKE 'B-%' THEN 'braintree' " +
  "WHEN payment_intent_id LIKE 'sq_%' OR payment_intent_id LIKE 'sqpmt_%' THEN 'square' " +
  "ELSE 'other' END";

// Week-bucket SQL — ISO-week-monday start, expressed as the
// `date()` of the Monday on or before `updated_at`. SQLite's
// `strftime('%w', ...)` returns Sunday=0..Saturday=6, so the
// Monday offset is `(strftime('%w') + 6) % 7` days back.
var WEEK_BUCKET_SQL =
  "date(updated_at/1000, 'unixepoch', " +
  "'-' || ((CAST(strftime('%w', updated_at/1000, 'unixepoch') AS INTEGER) + 6) % 7) || ' days')";

// Month-bucket SQL — first day of the calendar month containing
// `updated_at`, UTC.
var MONTH_BUCKET_SQL =
  "date(updated_at/1000, 'unixepoch', 'start of month')";

// Day-bucket SQL — calendar day in UTC.
var DAY_BUCKET_SQL =
  "date(updated_at/1000, 'unixepoch')";

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Cursors are HMAC-tagged via b.pagination so an operator can't
  // hand-craft one to skip past rows or replay across deployments.
  // The secret defaults to a dev-only placeholder so the primitive
  // boots in tests; production deployments must supply a derived
  // value (typically b.crypto.namespaceHash("sales-reports-cursor",
  // D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("salesReports.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "sales-reports-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label, expectedOrderKey) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("salesReports." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = _b().pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(expectedOrderKey)) {
        throw new TypeError("salesReports." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("salesReports." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit, orderKey, valExtractor) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return _b().pagination.encodeCursor({
      orderKey: orderKey,
      vals:     valExtractor(last),
      forward:  true,
    }, cursorSecret);
  }

  // ---- cache helpers --------------------------------------------------
  //
  // Memoization layer over the expensive aggregates. Every cache
  // entry is keyed by `(report_key, params_hash)`. The hash includes
  // the canonical-JSON of the operator's inputs domain-separated by
  // the report key so two reports with the same params hash to
  // different rows.

  function _paramsHash(reportKey, params) {
    // `:` separator (not `\n`) — namespaceHash refuses CR/LF in
    // string-typed inputs. The colon is safe because the report
    // key is a known short identifier from this module, never
    // operator-controlled, and the canonical-JSON of the params
    // is a JSON string with `:` already inside.
    var payload = reportKey + "::" + _canonicalJSON(params);
    return _b().crypto.namespaceHash(CACHE_NAMESPACE, payload);
  }

  async function _cacheLookup(reportKey, paramsHash, nowTs) {
    var r = await query(
      "SELECT result_json, expires_at FROM sales_report_cache " +
      " WHERE report_key = ?1 AND params_hash = ?2",
      [reportKey, paramsHash],
    );
    if (!r.rows.length) return null;
    if (Number(r.rows[0].expires_at) <= nowTs) return null;
    try { return JSON.parse(r.rows[0].result_json); }
    catch (_e) { return null; }                                              // drop-silent — bad JSON falls through to recompute
  }

  async function _cacheStore(reportKey, paramsHash, result, ttlMs, nowTs) {
    var id = _b().uuid.v7();
    // REPLACE on the unique (report_key, params_hash) — keeps the
    // index clean without leaving stale rows.
    await query(
      "DELETE FROM sales_report_cache WHERE report_key = ?1 AND params_hash = ?2",
      [reportKey, paramsHash],
    );
    await query(
      "INSERT INTO sales_report_cache " +
      "(id, report_key, params_hash, result_json, computed_at, expires_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, reportKey, paramsHash, JSON.stringify(result), nowTs, nowTs + ttlMs],
    );
  }

  // Wrap a recompute function with the cache. `enabled` defaults
  // off; opt-in per call via `opts.cache === true` so test fixtures
  // see fresh data and dashboards opt in explicitly.
  async function _withCache(reportKey, params, cacheOpts, recompute) {
    if (!cacheOpts || cacheOpts.cache !== true) return recompute();
    var ttl = cacheOpts.cache_ttl_ms == null
      ? DEFAULT_CACHE_TTL_MS[reportKey]
      : cacheOpts.cache_ttl_ms;
    if (!Number.isInteger(ttl) || ttl < 0) {
      throw new TypeError("salesReports: cache_ttl_ms must be a non-negative integer");
    }
    var nowTs = Date.now();
    var paramsHash = _paramsHash(reportKey, params);
    var hit = await _cacheLookup(reportKey, paramsHash, nowTs);
    if (hit) return hit;
    var fresh = await recompute();
    if (ttl > 0) await _cacheStore(reportKey, paramsHash, fresh, ttl, nowTs);
    return fresh;
  }

  // ---- core revenue-by-bucket -----------------------------------------
  //
  // The day / week / month surfaces share an implementation —
  // identical aggregation, different bucket-expression. Factored so
  // the bucket logic lives in one place and a fix lands in all
  // three at once.

  function _revenueByBucket(reportKey, bucketSql, windowOpts) {
    return _withCache(reportKey, windowOpts || {}, windowOpts || {}, async function () {
      var w = _resolveWindow(windowOpts);
      var cur = _currency(windowOpts && windowOpts.currency);
      var params = [w.from, w.to];
      var currencyFilter = "";
      if (cur) {
        currencyFilter = " AND currency = ?3";
        params.push(cur);
      }
      var sql =
        "SELECT " + bucketSql + " AS bucket_start, currency, " +
        "       COUNT(*) AS order_count, " +
        "       SUM(grand_total_minor) AS gross_revenue_minor, " +
        "       SUM(CASE WHEN status = 'refunded' THEN -grand_total_minor " +
        "                ELSE grand_total_minor END) AS net_revenue_minor, " +
        "       SUM(CASE WHEN status = 'refunded' THEN grand_total_minor " +
        "                ELSE 0 END) AS refund_total_minor " +
        "  FROM orders " +
        " WHERE updated_at >= ?1 AND updated_at < ?2 " +
        "   AND status != 'cancelled' " +
        currencyFilter +
        " GROUP BY bucket_start, currency " +
        " ORDER BY bucket_start ASC, currency ASC";
      return query(sql, params).then(function (r) {
        return r.rows.map(function (row) {
          return {
            bucket_start:        row.bucket_start,
            currency:            row.currency,
            order_count:         Number(row.order_count) || 0,
            gross_revenue_minor: Number(row.gross_revenue_minor) || 0,
            net_revenue_minor:   Number(row.net_revenue_minor) || 0,
            refund_total_minor:  Number(row.refund_total_minor) || 0,
          };
        });
      });
    });
  }

  return {
    DEFAULT_WINDOW_MS:    DEFAULT_WINDOW_MS,
    ONE_YEAR_MS:          ONE_YEAR_MS,
    DEFAULT_CACHE_TTL_MS: DEFAULT_CACHE_TTL_MS,

    // Revenue grouped by calendar day (UTC). Excludes `cancelled`;
    // `refunded` rows subtract from `net_revenue_minor` and
    // contribute their gross to `refund_total_minor`. Gross stays
    // additive across every non-cancelled status so the operator
    // can read "what was charged" vs "what stuck" side-by-side.
    revenueByDay: function (windowOpts) {
      return _revenueByBucket("revenue_by_day", DAY_BUCKET_SQL, windowOpts);
    },

    // Revenue grouped by ISO-week (Monday-aligned, UTC). Same
    // policy + shape as `revenueByDay` — only the bucket expression
    // changes.
    revenueByWeek: function (windowOpts) {
      return _revenueByBucket("revenue_by_week", WEEK_BUCKET_SQL, windowOpts);
    },

    // Revenue grouped by calendar month (UTC). Same policy + shape
    // as `revenueByDay`.
    revenueByMonth: function (windowOpts) {
      return _revenueByBucket("revenue_by_month", MONTH_BUCKET_SQL, windowOpts);
    },

    // Top-N products (SKU) by gross revenue across the window.
    // `cancelled` + `refunded` orders are excluded from the SKU
    // aggregation entirely — those units never landed with the
    // customer for revenue purposes. Average unit price is the
    // gross revenue divided by units_sold, rounded to the nearest
    // integer minor unit.
    topProducts: function (windowOpts) {
      var self = this;
      return _withCache("top_products", windowOpts || {}, windowOpts || {}, async function () {
        var w = _resolveWindow(windowOpts);
        var rawLimit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
        _limit(rawLimit, "limit");
        var cur = _currency(windowOpts && windowOpts.currency);
        var cursorVals = _decodeCursor(
          windowOpts && windowOpts.cursor, "topProducts", TOP_PRODUCTS_ORDER_KEY,
        );

        var params = [w.from, w.to];
        var currencyFilter = "";
        var idx = 3;
        if (cur) {
          currencyFilter = " AND ol.unit_currency = ?" + idx;
          params.push(cur);
          idx += 1;
        }
        // The cursor-keyset HAVING — applied post-GROUP BY because
        // the sort columns are aggregates. `(gross < cv0) OR
        // (gross = cv0 AND sku > cv1)`.
        var havingClause = "";
        if (cursorVals) {
          havingClause =
            " HAVING (gross_revenue_minor < ?" + idx + ") OR " +
            "        (gross_revenue_minor = ?" + idx + " AND sku > ?" + (idx + 1) + ")";
          params.push(cursorVals[0], cursorVals[1]);
          idx += 2;
        }
        params.push(rawLimit);
        var sql =
          "SELECT ol.sku AS sku, ol.unit_currency AS currency, " +
          "       COUNT(DISTINCT o.id) AS order_count, " +
          "       SUM(ol.qty) AS units_sold, " +
          "       SUM(ol.line_total_minor) AS gross_revenue_minor " +
          "  FROM order_lines ol " +
          "  JOIN orders o ON o.id = ol.order_id " +
          " WHERE o.updated_at >= ?1 AND o.updated_at < ?2 " +
          "   AND o.status NOT IN ('cancelled', 'refunded') " +
          currencyFilter +
          " GROUP BY ol.sku, ol.unit_currency " +
          havingClause +
          " ORDER BY gross_revenue_minor DESC, ol.sku ASC " +
          " LIMIT ?" + idx;
        var r = await query(sql, params);
        var rows = r.rows.map(function (row) {
          var units = Number(row.units_sold) || 0;
          var gross = Number(row.gross_revenue_minor) || 0;
          return {
            sku:                       row.sku,
            currency:                  row.currency,
            order_count:               Number(row.order_count) || 0,
            units_sold:                units,
            gross_revenue_minor:       gross,
            average_unit_price_minor:  units > 0 ? Math.round(gross / units) : 0,
          };
        });
        var nextCursor = _encodeNext(rows, rawLimit, TOP_PRODUCTS_ORDER_KEY, function (r) {
          return [r.gross_revenue_minor, r.sku];
        });
        void self;
        return { rows: rows, next_cursor: nextCursor };
      });
    },

    // Top-N customers by lifetime gross across the window. Returns
    // customer_id only — no PII reaches the caller. Average-order
    // is gross / order_count, rounded. Anonymous orders (NULL
    // customer_id) are excluded — there's nothing to rank without a
    // join key.
    topCustomers: function (windowOpts) {
      return _withCache("top_customers", windowOpts || {}, windowOpts || {}, async function () {
        var w = _resolveWindow(windowOpts);
        var rawLimit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
        _limit(rawLimit, "limit");
        var cursorVals = _decodeCursor(
          windowOpts && windowOpts.cursor, "topCustomers", TOP_CUSTOMERS_ORDER_KEY,
        );

        var params = [w.from, w.to];
        var idx = 3;
        var havingClause = "";
        if (cursorVals) {
          havingClause =
            " HAVING (gross_revenue_minor < ?" + idx + ") OR " +
            "        (gross_revenue_minor = ?" + idx + " AND customer_id > ?" + (idx + 1) + ")";
          params.push(cursorVals[0], cursorVals[1]);
          idx += 2;
        }
        params.push(rawLimit);
        var sql =
          "SELECT customer_id, currency, COUNT(*) AS order_count, " +
          "       SUM(grand_total_minor) AS gross_revenue_minor " +
          "  FROM orders " +
          " WHERE updated_at >= ?1 AND updated_at < ?2 " +
          "   AND status NOT IN ('cancelled', 'refunded') " +
          "   AND customer_id IS NOT NULL " +
          " GROUP BY customer_id, currency " +
          havingClause +
          " ORDER BY gross_revenue_minor DESC, customer_id ASC " +
          " LIMIT ?" + idx;
        var r = await query(sql, params);
        var rows = r.rows.map(function (row) {
          var count = Number(row.order_count) || 0;
          var gross = Number(row.gross_revenue_minor) || 0;
          return {
            customer_id:          row.customer_id,
            currency:             row.currency,
            order_count:          count,
            gross_revenue_minor:  gross,
            average_order_minor:  count > 0 ? Math.round(gross / count) : 0,
          };
        });
        var nextCursor = _encodeNext(rows, rawLimit, TOP_CUSTOMERS_ORDER_KEY, function (r) {
          return [r.gross_revenue_minor, r.customer_id];
        });
        return { rows: rows, next_cursor: nextCursor };
      });
    },

    // Revenue grouped by ship-to country. Country is extracted from
    // `ship_to_json` via SQLite `json_extract`. Orders with no
    // discernible country (malformed JSON / missing field) bucket
    // into "UNKNOWN" so the sum still equals the totals on other
    // reports.
    revenueByCountry: function (windowOpts) {
      return _withCache("revenue_by_country", windowOpts || {}, windowOpts || {}, async function () {
        var w = _resolveWindow(windowOpts);
        var r = await query(
          "SELECT COALESCE(json_extract(ship_to_json, '$.country'), 'UNKNOWN') AS country, " +
          "       currency, COUNT(*) AS order_count, " +
          "       SUM(grand_total_minor) AS gross_revenue_minor " +
          "  FROM orders " +
          " WHERE updated_at >= ?1 AND updated_at < ?2 " +
          "   AND status NOT IN ('cancelled', 'refunded') " +
          " GROUP BY country, currency " +
          " ORDER BY gross_revenue_minor DESC, country ASC",
          [w.from, w.to],
        );
        return r.rows.map(function (row) {
          return {
            country:              row.country,
            currency:             row.currency,
            order_count:          Number(row.order_count) || 0,
            gross_revenue_minor:  Number(row.gross_revenue_minor) || 0,
          };
        });
      });
    },

    // Revenue grouped by derived payment method. The `CASE`
    // expression on `payment_intent_id` maps processor-token
    // prefixes to operator-facing labels (stripe / paypal /
    // braintree / square / other / unknown).
    revenueByPaymentMethod: function (windowOpts) {
      return _withCache("revenue_by_payment", windowOpts || {}, windowOpts || {}, async function () {
        var w = _resolveWindow(windowOpts);
        var r = await query(
          "SELECT " + PAYMENT_METHOD_CASE_SQL + " AS payment_method, " +
          "       currency, COUNT(*) AS order_count, " +
          "       SUM(grand_total_minor) AS gross_revenue_minor " +
          "  FROM orders " +
          " WHERE updated_at >= ?1 AND updated_at < ?2 " +
          "   AND status NOT IN ('cancelled', 'refunded') " +
          " GROUP BY payment_method, currency " +
          " ORDER BY gross_revenue_minor DESC, payment_method ASC",
          [w.from, w.to],
        );
        return r.rows.map(function (row) {
          return {
            payment_method:       row.payment_method,
            currency:             row.currency,
            order_count:          Number(row.order_count) || 0,
            gross_revenue_minor:  Number(row.gross_revenue_minor) || 0,
          };
        });
      });
    },

    // Per-month retention for the cohort whose first-ever order
    // landed in `cohort_month`. Returns 12 monthly retention buckets
    // (month_offset 0..11) — offset 0 is the cohort itself (every
    // customer "returned" in month 0 by definition). Customers
    // without an id are excluded — anonymous orders can't be
    // tracked across months.
    customerCohort: function (cohortOpts) {
      return _withCache("customer_cohort", cohortOpts || {}, cohortOpts || {}, async function () {
        if (!cohortOpts || typeof cohortOpts !== "object") {
          throw new TypeError("salesReports.customerCohort: input object required");
        }
        var cohort = _cohortMonth(cohortOpts.cohort_month);
        var months = cohortOpts.months == null ? 12 : cohortOpts.months;
        if (!Number.isInteger(months) || months < 1 || months > 24) {
          throw new TypeError("salesReports.customerCohort: months must be an integer in [1, 24]");
        }

        // First-ever order per customer — the cohort is every
        // customer whose MIN(updated_at) lands inside `cohort_month`.
        var cohortRows = await query(
          "SELECT customer_id, MIN(updated_at) AS first_order_at " +
          "  FROM orders " +
          " WHERE customer_id IS NOT NULL " +
          "   AND status NOT IN ('cancelled') " +
          " GROUP BY customer_id " +
          " HAVING strftime('%Y-%m', first_order_at/1000, 'unixepoch') = ?1",
          [cohort],
        );
        var cohortIds = cohortRows.rows.map(function (r) { return r.customer_id; });
        var cohortSize = cohortIds.length;

        // For every month-offset 0..months-1, count distinct
        // returning customers from the cohort + sum their revenue.
        // Loop in JS rather than a single window function — keeps
        // the SQL portable across the in-memory sqlite test backend
        // and the production D1 backend without depending on the
        // window-function support tier.
        var retention = [];
        for (var offset = 0; offset < months; offset += 1) {
          retention.push({
            month_offset:        offset,
            returning_customers: 0,
            retention_rate:      0,
            gross_revenue_minor: 0,
            currency:            null,
          });
        }
        if (cohortSize === 0) {
          return { cohort_month: cohort, cohort_size: 0, retention: retention };
        }

        // Bound the per-offset query by the cohort-id list. Build
        // the placeholder string in JS — sqlite parameter limits
        // are well above any realistic single-month cohort.
        var idPlaceholders = cohortIds.map(function (_v, i) { return "?" + (i + 3); }).join(",");
        var idParams = cohortIds;

        for (var off = 0; off < months; off += 1) {
          // Calendar-month arithmetic on the cohort string. SQLite
          // can do this natively via the modifier shape
          // `'YYYY-MM-01', '+N months'`.
          var rangeStartSql = "strftime('%s', ?1 || '-01', '+' || ?2 || ' months') * 1000";
          var rangeEndSql   = "strftime('%s', ?1 || '-01', '+' || (?2 + 1) || ' months') * 1000";
          var rangeRow = await query(
            "SELECT " + rangeStartSql + " AS rs, " + rangeEndSql + " AS re",
            [cohort, off],
          );
          var rs = Number(rangeRow.rows[0].rs) || 0;
          var re = Number(rangeRow.rows[0].re) || 0;
          var sql =
            "SELECT COUNT(DISTINCT customer_id) AS returning_count, " +
            "       SUM(grand_total_minor) AS gross_revenue_minor, " +
            "       currency " +
            "  FROM orders " +
            " WHERE updated_at >= ?1 AND updated_at < ?2 " +
            "   AND status NOT IN ('cancelled') " +
            "   AND customer_id IN (" + idPlaceholders + ") " +
            " GROUP BY currency";
          var rrows = await query(sql, [rs, re].concat(idParams));
          // Sum across currencies for the headline retention rate,
          // surface the per-currency revenue on the row.
          var returning = 0;
          var grossSum = 0;
          var firstCurrency = null;
          for (var k = 0; k < rrows.rows.length; k += 1) {
            var rr = rrows.rows[k];
            // COUNT(DISTINCT) per currency double-counts customers
            // who paid in multiple currencies. Take the max as the
            // honest lower bound.
            var thisReturning = Number(rr.returning_count) || 0;
            if (thisReturning > returning) returning = thisReturning;
            grossSum += Number(rr.gross_revenue_minor) || 0;
            if (firstCurrency == null) firstCurrency = rr.currency;
          }
          retention[off] = {
            month_offset:        off,
            returning_customers: returning,
            retention_rate:      cohortSize > 0 ? returning / cohortSize : 0,
            gross_revenue_minor: grossSum,
            currency:            firstCurrency,
          };
        }
        return { cohort_month: cohort, cohort_size: cohortSize, retention: retention };
      });
    },

    // Average order value across the window. Single number per
    // currency by default; the optional `currency?` filter narrows
    // to one currency. Returns `{ count, gross_revenue_minor,
    // aov_minor, currency }` for the single-currency path or an
    // array for the multi-currency path.
    aov: function (windowOpts) {
      return _withCache("aov", windowOpts || {}, windowOpts || {}, async function () {
        var w = _resolveWindow(windowOpts);
        var cur = _currency(windowOpts && windowOpts.currency);
        var params = [w.from, w.to];
        var currencyFilter = "";
        if (cur) {
          currencyFilter = " AND currency = ?3";
          params.push(cur);
        }
        var r = await query(
          "SELECT currency, COUNT(*) AS count, " +
          "       SUM(grand_total_minor) AS gross_revenue_minor " +
          "  FROM orders " +
          " WHERE updated_at >= ?1 AND updated_at < ?2 " +
          "   AND status NOT IN ('cancelled', 'refunded') " +
          currencyFilter +
          " GROUP BY currency " +
          " ORDER BY currency ASC",
          params,
        );
        var rows = r.rows.map(function (row) {
          var count = Number(row.count) || 0;
          var gross = Number(row.gross_revenue_minor) || 0;
          return {
            currency:            row.currency,
            count:               count,
            gross_revenue_minor: gross,
            aov_minor:           count > 0 ? Math.round(gross / count) : 0,
          };
        });
        if (cur) {
          // Single-currency call — return the one row or a zero
          // shape so the dashboard always has something to render.
          if (rows.length) return rows[0];
          return { currency: cur, count: 0, gross_revenue_minor: 0, aov_minor: 0 };
        }
        if (rows.length === 0) {
          return { currency: "USD", count: 0, gross_revenue_minor: 0, aov_minor: 0 };
        }
        if (rows.length === 1) return rows[0];
        return rows;
      });
    },

    // Refund rate over the window, expressed in basis points
    // (0..10000). `refunded_count` is the orders whose status =
    // 'refunded' AND whose updated_at falls in the window;
    // `order_count` is every non-cancelled order in the window.
    // bps avoids a float in the operator dashboard — operators
    // render `bps / 100` as a percentage.
    refundRate: function (windowOpts) {
      return _withCache("refund_rate", windowOpts || {}, windowOpts || {}, async function () {
        var w = _resolveWindow(windowOpts);
        var r = await query(
          "SELECT " +
          "  SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS order_count, " +
          "  SUM(CASE WHEN status = 'refunded'   THEN 1 ELSE 0 END) AS refunded_count " +
          "  FROM orders " +
          " WHERE updated_at >= ?1 AND updated_at < ?2",
          [w.from, w.to],
        );
        var row = r.rows[0] || {};
        var orderCount    = Number(row.order_count) || 0;
        var refundedCount = Number(row.refunded_count) || 0;
        var bps = orderCount > 0 ? Math.round((refundedCount / orderCount) * 10000) : 0;
        return {
          order_count:     orderCount,
          refunded_count:  refundedCount,
          refund_rate_bps: bps,
        };
      });
    },

    // Order-status funnel across the window. Counts every milestone
    // independently — an order that reaches `delivered` counts in
    // `paid` + `fulfilled` too, so each bucket reads as "orders
    // that reached at least this stage." `payment_intent_created`
    // is the orders with a non-null processor token.
    funnel: function (windowOpts) {
      return _withCache("funnel", windowOpts || {}, windowOpts || {}, async function () {
        var w = _resolveWindow(windowOpts);
        var r = await query(
          "SELECT " +
          "  COUNT(*) AS checkout_started, " +
          "  SUM(CASE WHEN payment_intent_id IS NOT NULL THEN 1 ELSE 0 END) AS payment_intent_created, " +
          "  SUM(CASE WHEN status IN ('paid','fulfilling','shipped','delivered','refunded') THEN 1 ELSE 0 END) AS paid, " +
          "  SUM(CASE WHEN status IN ('shipped','delivered') THEN 1 ELSE 0 END) AS fulfilled, " +
          "  SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded " +
          "  FROM orders " +
          " WHERE updated_at >= ?1 AND updated_at < ?2",
          [w.from, w.to],
        );
        var row = r.rows[0] || {};
        return {
          checkout_started:        Number(row.checkout_started) || 0,
          payment_intent_created:  Number(row.payment_intent_created) || 0,
          paid:                    Number(row.paid) || 0,
          fulfilled:               Number(row.fulfilled) || 0,
          refunded:                Number(row.refunded) || 0,
        };
      });
    },

    // Cache-sweep — DELETE every cache row whose `expires_at <=
    // now`. Operators run this on a schedule (cron, queue worker)
    // to keep the cache table from accreting unbounded stale rows.
    // Returns `{ deleted }` so the caller can log the size of each
    // sweep.
    purgeExpired: async function (nowTs) {
      var ts = nowTs == null ? Date.now() : nowTs;
      _epochMs(ts, "nowTs");
      var r = await query(
        "DELETE FROM sales_report_cache WHERE expires_at <= ?1",
        [ts],
      );
      return { deleted: Number(r.rowCount) || 0 };
    },
  };
}

module.exports = {
  create:                create,
  ONE_YEAR_MS:           ONE_YEAR_MS,
  DEFAULT_WINDOW_MS:     DEFAULT_WINDOW_MS,
  DAY_MS:                DAY_MS,
  DEFAULT_CACHE_TTL_MS:  DEFAULT_CACHE_TTL_MS,
};
