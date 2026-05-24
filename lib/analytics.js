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
 *
 *   Event-stream surface (writes against `analytics_events` from
 *   migration `0019_analytics_events.sql`):
 *
 *     analytics.recordEvent({ event_type, session_id?, customer_id?,
 *                             product_id?, search_q?, page_url?,
 *                             user_agent_class?, payload? })
 *       → { id, occurred_at }
 *
 *     analytics.topSearchTerms({ from?, to?, limit? })
 *       → [{ search_q, count }]
 *
 *     analytics.topViewedProducts({ from?, to?, limit? })
 *       → [{ product_id, count }]
 *
 *     analytics.funnel({ from?, to? })
 *       → { pdp_views, cart_adds, checkout_starts, checkout_completes,
 *           conversion_rate }
 *
 *     analytics.sessionFlow(session_id, { limit? })
 *       → [{ id, event_type, session_id_hash, customer_id_hash,
 *            product_id, search_q, page_url, user_agent_class,
 *            payload, occurred_at }]
 *
 *     analytics.dropAfter(ts)
 *       → { deleted }
 *
 *   Privacy posture: `session_id` and `customer_id` are hashed via
 *   `b.crypto.namespaceHash` (namespaces `"analytics-session"` /
 *   `"analytics-customer"`) before the row reaches the database. The
 *   primitive REFUSES — with a TypeError, at every write entry point
 *   — to accept a value that looks like a raw email (contains `@`
 *   between two non-whitespace runs) or a raw IP (dotted-quad or
 *   colon-delimited hextet). The same refusal applies to `search_q`
 *   and `page_url` so an operator who accidentally pipes a logged-in
 *   user's identifier into a search term hits a loud error instead
 *   of a quiet PII leak. `payload` is JSON-encoded and bounded to
 *   4 KiB; the primitive does not introspect its contents — operator
 *   discipline owns what goes inside.
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

// ---- event-stream validators -------------------------------------------
//
// Event-stream writes go through `recordEvent`; every other event-
// stream surface is read-only and reuses `_resolveWindow` /
// `_limit`. The validators below are the write-site gates.

var EVENT_TYPES = [
  "pdp_view", "collection_view", "search_query",
  "wishlist_add", "wishlist_remove", "cart_add", "cart_remove",
  "checkout_start", "checkout_complete", "newsletter_signup",
];

var UA_CLASSES = ["desktop", "mobile", "bot", "other"];

var SESSION_NAMESPACE  = "analytics-session";
var CUSTOMER_NAMESPACE = "analytics-customer";

// Payload size bound — operators put refinement filters / source
// attribution / variant ids here; 4 KiB is more than enough and
// caps the per-row footprint. Bigger payloads belong in a
// purpose-built table, not the event stream.
var MAX_PAYLOAD_BYTES = 4096;
// Bounded string lengths for the denormalised columns. The
// primitive surfaces a TypeError rather than silently truncating
// because a truncated identifier joins to nothing.
var MAX_SEARCH_Q     = 256;
var MAX_PAGE_URL     = 2048;
var MAX_PRODUCT_ID   = 128;
var MAX_SESSION_ID   = 512;
var MAX_CUSTOMER_ID  = 512;

// Resolve a `{ from, to }` window for the event-stream queries.
// Mirrors `_resolveWindow` but uses the `from` / `to` naming the
// operator-facing surface advertises so a typo here doesn't tie a
// `since` error message to a `from`-keyed call site.
function _resolveEventWindow(opts) {
  opts = opts || {};
  var now  = Date.now();
  var from = opts.from == null ? (now - DEFAULT_WINDOW_MS) : opts.from;
  var to   = opts.to   == null ? now                       : opts.to;
  _epochMs(from, "from");
  _epochMs(to,   "to");
  if (from >= to) {
    throw new TypeError("analytics: from must be strictly less than to");
  }
  if ((to - from) > ONE_YEAR_MS) {
    throw new TypeError("analytics: window (to - from) must be ≤ 1 year");
  }
  return { from: from, to: to };
}

// PII guard — refuse a value that looks like a raw email or IP.
// Hashed identifiers (hex) never satisfy either shape, so the gate
// is a one-way "operator handed us raw PII" detector, not a typing
// constraint. The check is intentionally permissive on the email
// side (we'd rather reject a borderline string than ingest a real
// address) and uses the same dotted-quad / hextet shapes the
// vendored zod schemas exercise.
var RAW_EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// IPv4 dotted-quad or IPv6 with at least one colon-delimited
// hextet. The IPv6 shape catches the common forms ("::1",
// "2001:db8::1", full eight-group) without trying to be RFC-precise
// — anything with two-or-more colons separated by hex is enough to
// trigger the refusal.
var RAW_IPV4_RE  = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
var RAW_IPV6_RE  = /(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{0,4}/;

function _refuseRawPii(label, value) {
  if (typeof value !== "string" || value.length === 0) return;
  if (RAW_EMAIL_RE.test(value)) {
    throw new TypeError(
      "analytics: " + label + " looks like a raw email — hash via " +
      "b.crypto.namespaceHash before passing to recordEvent"
    );
  }
  if (RAW_IPV4_RE.test(value) || RAW_IPV6_RE.test(value)) {
    throw new TypeError(
      "analytics: " + label + " looks like a raw IP — IPs must not " +
      "reach the analytics_events table; hash or drop at the caller"
    );
  }
}

function _optString(value, label, max) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new TypeError("analytics: " + label + " must be a string when provided");
  }
  if (value.length === 0) {
    throw new TypeError("analytics: " + label + " must be non-empty when provided");
  }
  if (value.length > max) {
    throw new TypeError("analytics: " + label + " exceeds " + max + " chars");
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
        if (!byCurrency.has(cur)) { // allow:map-has-then-set-pre-node-26 — engines.node is `>=24` today; migrate to Map.prototype.getOrInsertComputed when the floor bumps to Node 26 (eligible Oct 2026 per LTS calendar)
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

    // Record a single event-stream row. `session_id` and
    // `customer_id` are hashed via `b.crypto.namespaceHash` before
    // the row reaches the database — raw identifiers never persist.
    // At least one of the two MUST be supplied; an anonymous row
    // with no join key is useless for funnel debugging and a sign
    // the caller forgot to wire the session middleware.
    //
    // Refusals (TypeError, before any I/O):
    //   - bad `event_type` (not in the allowed enum)
    //   - missing both `session_id` and `customer_id`
    //   - oversized `payload` (> 4 KiB after JSON-encode)
    //   - bad `occurred_at` (not a non-negative integer epoch-ms)
    //   - any string-typed field that looks like a raw email or IP
    //   - any string-typed field that exceeds its length bound
    recordEvent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("analytics.recordEvent: input object required");
      }
      var eventType = input.event_type;
      if (EVENT_TYPES.indexOf(eventType) === -1) {
        throw new TypeError(
          "analytics.recordEvent: event_type must be one of " +
          EVENT_TYPES.join(", ")
        );
      }
      // Both raw identifiers run through the PII guard first — an
      // email-shaped session_id is a tell that the caller wired the
      // wrong field. The guard runs before hashing because a
      // namespaceHash output is hex (no `@`, no dotted-quad) and
      // would slip past trivially.
      _refuseRawPii("session_id",  input.session_id);
      _refuseRawPii("customer_id", input.customer_id);

      var sessionId  = _optString(input.session_id,  "session_id",  MAX_SESSION_ID);
      var customerId = _optString(input.customer_id, "customer_id", MAX_CUSTOMER_ID);
      if (sessionId == null && customerId == null) {
        throw new TypeError(
          "analytics.recordEvent: at least one of session_id / " +
          "customer_id is required"
        );
      }

      // Denormalised columns — each is optional and bounded. The
      // PII guard runs on every string-typed value, so an operator
      // who pipes `?q=alice@example.com` straight into `search_q`
      // hits a loud refusal at the write site instead of leaking
      // the address into the aggregate table.
      _refuseRawPii("product_id",       input.product_id);
      _refuseRawPii("search_q",         input.search_q);
      _refuseRawPii("page_url",         input.page_url);
      var productId   = _optString(input.product_id, "product_id", MAX_PRODUCT_ID);
      var searchQ     = _optString(input.search_q,   "search_q",   MAX_SEARCH_Q);
      var pageUrl     = _optString(input.page_url,   "page_url",   MAX_PAGE_URL);
      var uaClass     = input.user_agent_class;
      if (uaClass != null && UA_CLASSES.indexOf(uaClass) === -1) {
        throw new TypeError(
          "analytics.recordEvent: user_agent_class must be one of " +
          UA_CLASSES.join(", ")
        );
      }

      // Payload — JSON-encode in-process so the size bound is
      // enforced on the encoded bytes (matches what the row will
      // hold). `undefined` → "{}" so the column NOT NULL default
      // covers operators that don't pass a payload.
      var payloadInput = input.payload == null ? {} : input.payload;
      if (typeof payloadInput !== "object" || Array.isArray(payloadInput)) {
        throw new TypeError(
          "analytics.recordEvent: payload must be a plain object when provided"
        );
      }
      var payloadJson;
      try {
        payloadJson = JSON.stringify(payloadInput);
      } catch (e) {
        throw new TypeError(
          "analytics.recordEvent: payload not JSON-serialisable (" +
          (e && e.message ? e.message : "unknown") + ")"
        );
      }
      if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new TypeError(
          "analytics.recordEvent: payload exceeds " + MAX_PAYLOAD_BYTES +
          " bytes (JSON-encoded)"
        );
      }

      // `occurred_at` — defaults to now. Operators can pin it for
      // backfills, but a NaN / float / string here is a typo and
      // throws.
      var occurredAt;
      if (input.occurred_at == null) {
        occurredAt = Date.now();
      } else {
        _epochMs(input.occurred_at, "occurred_at");
        occurredAt = input.occurred_at;
      }

      var b = _b();
      var sessionHash  = sessionId  == null ? null : b.crypto.namespaceHash(SESSION_NAMESPACE,  sessionId);
      var customerHash = customerId == null ? null : b.crypto.namespaceHash(CUSTOMER_NAMESPACE, customerId);
      // `session_id_hash` is NOT NULL in the schema — fall back to
      // a customer-scoped hash when only the customer is supplied
      // so the join key column always has a value. The customer
      // hash uses its own namespace so a session_id_hash composed
      // this way can't accidentally collide with a real session.
      if (sessionHash == null) sessionHash = customerHash;

      var id = b.uuid.v7();
      await query(
        "INSERT INTO analytics_events " +
        "(id, event_type, session_id_hash, customer_id_hash, payload_json, " +
        " product_id, search_q, page_url, user_agent_class, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [id, eventType, sessionHash, customerHash, payloadJson,
         productId, searchQ, pageUrl, uaClass == null ? null : uaClass, occurredAt],
      );
      return { id: id, occurred_at: occurredAt };
    },

    // Top-N search terms by event count across the window. Filters
    // out NULL `search_q` (other event types share the table) and
    // GROUPs by the denormalised column so the query never decodes
    // the JSON payload. Default limit 10; max 100 (same envelope as
    // `topSKUs`).
    topSearchTerms: async function (windowOpts) {
      var w = _resolveEventWindow(windowOpts);
      var limit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
      _limit(limit, "limit");
      var r = await query(
        "SELECT search_q AS search_q, COUNT(*) AS count " +
        "  FROM analytics_events " +
        " WHERE event_type = 'search_query' " +
        "   AND search_q IS NOT NULL " +
        "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
        " GROUP BY search_q " +
        " ORDER BY count DESC, search_q ASC " +
        " LIMIT ?3",
        [w.from, w.to, limit],
      );
      return r.rows.map(function (row) {
        return { search_q: row.search_q, count: Number(row.count) || 0 };
      });
    },

    // Top-N viewed products by PDP-view count across the window.
    // Same shape as `topSearchTerms` — different event_type +
    // group-by column.
    topViewedProducts: async function (windowOpts) {
      var w = _resolveEventWindow(windowOpts);
      var limit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
      _limit(limit, "limit");
      var r = await query(
        "SELECT product_id AS product_id, COUNT(*) AS count " +
        "  FROM analytics_events " +
        " WHERE event_type = 'pdp_view' " +
        "   AND product_id IS NOT NULL " +
        "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
        " GROUP BY product_id " +
        " ORDER BY count DESC, product_id ASC " +
        " LIMIT ?3",
        [w.from, w.to, limit],
      );
      return r.rows.map(function (row) {
        return { product_id: row.product_id, count: Number(row.count) || 0 };
      });
    },

    // PDP → cart → checkout-start → checkout-complete funnel for
    // the window. Conversion rate is `completes / pdp_views`,
    // clamped to [0, 1] — when there are zero PDP views the rate
    // is reported as 0 (operators read the absolute counts to
    // distinguish "no traffic" from "no conversion").
    funnel: async function (windowOpts) {
      var w = _resolveEventWindow(windowOpts);
      var r = await query(
        "SELECT event_type, COUNT(*) AS count " +
        "  FROM analytics_events " +
        " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
        "   AND event_type IN ('pdp_view','cart_add','checkout_start','checkout_complete') " +
        " GROUP BY event_type",
        [w.from, w.to],
      );
      var counts = { pdp_view: 0, cart_add: 0, checkout_start: 0, checkout_complete: 0 };
      for (var i = 0; i < r.rows.length; i += 1) {
        counts[r.rows[i].event_type] = Number(r.rows[i].count) || 0;
      }
      var pdp       = counts.pdp_view;
      var carts     = counts.cart_add;
      var starts    = counts.checkout_start;
      var completes = counts.checkout_complete;
      var rate = pdp > 0 ? (completes / pdp) : 0;
      if (rate < 0) rate = 0;
      if (rate > 1) rate = 1;
      return {
        pdp_views:           pdp,
        cart_adds:           carts,
        checkout_starts:     starts,
        checkout_completes:  completes,
        conversion_rate:     rate,
      };
    },

    // Per-session event sequence — operator hands the raw
    // session_id, the primitive hashes it (same namespace as on
    // write) and returns the chronological event list. Returning
    // the `session_id_hash` alongside lets the operator confirm
    // they're looking at the right session without ever seeing the
    // raw id again. Default limit 100; max 500 (sessions don't
    // legitimately emit more events than that in a single
    // debugging window).
    sessionFlow: async function (sessionId, opts) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new TypeError("analytics.sessionFlow: session_id required");
      }
      if (sessionId.length > MAX_SESSION_ID) {
        throw new TypeError("analytics.sessionFlow: session_id exceeds " + MAX_SESSION_ID + " chars");
      }
      _refuseRawPii("session_id", sessionId);
      var limit = (opts && opts.limit) == null ? 100 : opts.limit;
      _limit(limit, "limit", 500);
      var hash = _b().crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
      var r = await query(
        "SELECT id, event_type, session_id_hash, customer_id_hash, " +
        "       payload_json, product_id, search_q, page_url, " +
        "       user_agent_class, occurred_at " +
        "  FROM analytics_events " +
        " WHERE session_id_hash = ?1 " +
        " ORDER BY occurred_at ASC, id ASC " +
        " LIMIT ?2",
        [hash, limit],
      );
      return r.rows.map(function (row) {
        var payload;
        try { payload = JSON.parse(row.payload_json || "{}"); }
        catch (_e) { payload = {}; }
        return {
          id:                row.id,
          event_type:        row.event_type,
          session_id_hash:   row.session_id_hash,
          customer_id_hash:  row.customer_id_hash,
          product_id:        row.product_id,
          search_q:          row.search_q,
          page_url:          row.page_url,
          user_agent_class:  row.user_agent_class,
          payload:           payload,
          occurred_at:       Number(row.occurred_at) || 0,
        };
      });
    },

    // Retention sweep — DELETE every event older than `ts`.
    // Operators run this on a schedule (cron, queue worker) to
    // satisfy data-minimisation obligations. The primitive returns
    // the row count so the caller can log the size of each sweep.
    dropAfter: async function (ts) {
      _epochMs(ts, "ts");
      var r = await query(
        "DELETE FROM analytics_events WHERE occurred_at < ?1",
        [ts],
      );
      return { deleted: Number(r.rowCount) || 0 };
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
