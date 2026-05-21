"use strict";
/**
 * @module shop.analytics
 * @title  Analytics — read-only aggregate queries over orders
 *
 * @intro
 *   Pure data-layer module. Every method reads from the `orders` +
 *   `order_lines` tables (written by the order primitive) and returns
 *   a plain JSON-shaped aggregate. No mutations, no caching, no
 *   external I/O beyond the injected `query` function.
 *
 *   Operator-supplied time windows are validated as epoch-millisecond
 *   integers with `since < until` and `until - since ≤ 1 year` (the
 *   primitive refuses to scan unbounded history in a single call —
 *   operators paginate by stepping the window). Default window when
 *   either bound is omitted: last 30 days from now.
 *
 *   Multi-currency note: every aggregate is grouped by currency so
 *   operators with multi-currency catalogs get one row per currency
 *   instead of an arithmetically-incoherent sum across exchange
 *   rates. Single-currency operators see a one-row-per-currency
 *   array of length 1.
 *
 *   v1 surface:
 *
 *     analytics.summary({ since, until })
 *       → { total_orders, total_revenue_minor, currency, by_status: {...} }
 *         (or array of {currency, total_orders, total_revenue_minor, by_status}
 *          when the window spans multiple currencies)
 *
 *     analytics.revenueByDay({ since, until })
 *       → [{ day, currency, revenue_minor }]   sorted by day ASC
 *
 *     analytics.topSKUs({ since, until, limit })
 *       → [{ sku, units_sold, revenue_minor, currency }]
 *         sorted by units_sold DESC
 *
 *     analytics.recentOrders({ limit })
 *       → [{ id, status, grand_total_minor, currency, created_at }]
 *         sorted by created_at DESC
 *
 *   Revenue counting policy: `cancelled` orders contribute zero
 *   (excluded from the SUM). `refunded` orders SUBTRACT their
 *   grand_total from revenue (operator preference — net revenue
 *   reflects what reached the bank, not what was charged-then-
 *   refunded). Every other status (pending / paid / fulfilling /
 *   shipped / delivered) counts at face value because the operator
 *   has either captured the funds or is committed to capturing them.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
var DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ---- validators ---------------------------------------------------------

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("analytics: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _resolveWindow(opts) {
  opts = opts || {};
  var now = Date.now();
  var since = opts.since == null ? (now - DEFAULT_WINDOW_MS) : opts.since;
  var until = opts.until == null ? now                       : opts.until;
  _epochMs(since, "since");
  _epochMs(until, "until");
  if (since >= until) {
    throw new TypeError("analytics: since must be strictly less than until");
  }
  if ((until - since) > ONE_YEAR_MS) {
    throw new TypeError("analytics: window (until - since) must be ≤ 1 year");
  }
  return { since: since, until: until };
}

function _limit(n, label, max) {
  max = max || 100;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new TypeError("analytics: " + label + " must be an integer in [1, " + max + "]");
  }
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Status buckets we always surface, even when zero. Aligned with
  // the order FSM's seven states so the operator dashboard renders a
  // consistent row set regardless of which buckets the window
  // touched.
  var ALL_STATUSES = ["pending", "paid", "fulfilling", "shipped", "delivered", "refunded", "cancelled"];

  return {
    // Aggregate counts + revenue across the window, grouped by
    // currency. Revenue policy: `cancelled` excluded entirely;
    // `refunded` subtracts; every other status adds. Status buckets
    // are zero-filled so the operator dashboard renders all seven
    // columns even when the window only touched a few.
    summary: async function (windowOpts) {
      var w = _resolveWindow(windowOpts);

      // Per-currency aggregate. Filter on `updated_at` so an order
      // that paid+refunded in the same window contributes to the
      // refund subtraction (status flipped on refund updates
      // updated_at).
      var r = await query(
        "SELECT currency, status, COUNT(*) AS n, " +
        "       SUM(grand_total_minor) AS gross_minor " +
        "  FROM orders " +
        " WHERE updated_at >= ?1 AND updated_at < ?2 " +
        " GROUP BY currency, status",
        [w.since, w.until],
      );

      // Fold the per-(currency, status) rows into the operator-
      // facing shape. Use a map keyed by currency so we can return
      // one row per currency, sorted alphabetically.
      var byCurrency = new Map();
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var cur = row.currency;
        if (!byCurrency.has(cur)) {
          var byStatus = {};
          for (var j = 0; j < ALL_STATUSES.length; j += 1) byStatus[ALL_STATUSES[j]] = 0;
          byCurrency.set(cur, {
            currency:            cur,
            total_orders:        0,
            total_revenue_minor: 0,
            by_status:           byStatus,
          });
        }
        var entry = byCurrency.get(cur);
        var n     = Number(row.n) || 0;
        var gross = Number(row.gross_minor) || 0;
        entry.by_status[row.status] = n;
        entry.total_orders += n;
        if (row.status === "cancelled") {
          // Excluded from revenue entirely.
        } else if (row.status === "refunded") {
          entry.total_revenue_minor -= gross;
        } else {
          entry.total_revenue_minor += gross;
        }
      }

      var currencies = Array.from(byCurrency.keys()).sort();
      if (currencies.length === 0) {
        // Empty window — return a single zero row in USD so the
        // dashboard has a shape to render. Operators can read the
        // total_orders === 0 signal to know nothing landed.
        var emptyByStatus = {};
        for (var k = 0; k < ALL_STATUSES.length; k += 1) emptyByStatus[ALL_STATUSES[k]] = 0;
        return {
          currency:            "USD",
          total_orders:        0,
          total_revenue_minor: 0,
          by_status:           emptyByStatus,
        };
      }
      if (currencies.length === 1) {
        return byCurrency.get(currencies[0]);
      }
      return currencies.map(function (c) { return byCurrency.get(c); });
    },

    // Revenue grouped by calendar day (UTC) within the window,
    // grouped by currency. `cancelled` orders are filtered out;
    // `refunded` orders contribute as a negative (subtract). Day
    // bucket is `date(updated_at/1000, 'unixepoch')` so the bin is
    // calendar-aligned and stable across timezones.
    revenueByDay: async function (windowOpts) {
      var w = _resolveWindow(windowOpts);
      var r = await query(
        "SELECT date(updated_at/1000, 'unixepoch') AS day, currency, " +
        "       SUM(CASE WHEN status = 'refunded' THEN -grand_total_minor " +
        "                ELSE grand_total_minor END) AS revenue_minor " +
        "  FROM orders " +
        " WHERE updated_at >= ?1 AND updated_at < ?2 " +
        "   AND status != 'cancelled' " +
        " GROUP BY day, currency " +
        " ORDER BY day ASC, currency ASC",
        [w.since, w.until],
      );
      return r.rows.map(function (row) {
        return {
          day:           row.day,
          currency:      row.currency,
          revenue_minor: Number(row.revenue_minor) || 0,
        };
      });
    },

    // Top-N SKUs by units_sold across the window. Join order_lines
    // onto orders so we can filter by `orders.updated_at` (the line
    // table has no own updated_at) AND exclude cancelled+refunded
    // orders from the units count (those units never landed with
    // the customer for revenue purposes).
    topSKUs: async function (windowOpts) {
      var w = _resolveWindow(windowOpts || {});
      var limit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
      _limit(limit, "limit");
      var r = await query(
        "SELECT ol.sku AS sku, ol.unit_currency AS currency, " +
        "       SUM(ol.qty) AS units_sold, " +
        "       SUM(ol.line_total_minor) AS revenue_minor " +
        "  FROM order_lines ol " +
        "  JOIN orders o ON o.id = ol.order_id " +
        " WHERE o.updated_at >= ?1 AND o.updated_at < ?2 " +
        "   AND o.status NOT IN ('cancelled', 'refunded') " +
        " GROUP BY ol.sku, ol.unit_currency " +
        " ORDER BY units_sold DESC, ol.sku ASC " +
        " LIMIT ?3",
        [w.since, w.until, limit],
      );
      return r.rows.map(function (row) {
        return {
          sku:           row.sku,
          units_sold:    Number(row.units_sold) || 0,
          revenue_minor: Number(row.revenue_minor) || 0,
          currency:      row.currency,
        };
      });
    },

    // Most-recent orders. No window — strictly most-recent-N. Used
    // by the dashboard's "Recent activity" sidebar.
    recentOrders: async function (recentOpts) {
      var limit = (recentOpts && recentOpts.limit) == null ? 20 : recentOpts.limit;
      _limit(limit, "limit");
      var r = await query(
        "SELECT id, status, grand_total_minor, currency, created_at " +
        "  FROM orders " +
        " ORDER BY created_at DESC " +
        " LIMIT ?1",
        [limit],
      );
      return r.rows.map(function (row) {
        return {
          id:                row.id,
          status:            row.status,
          grand_total_minor: Number(row.grand_total_minor) || 0,
          currency:          row.currency,
          created_at:        Number(row.created_at) || 0,
        };
      });
    },
  };
}

module.exports = {
  create:            create,
  ONE_YEAR_MS:       ONE_YEAR_MS,
  DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
};
