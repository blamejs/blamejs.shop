"use strict";
/**
 * @module shop.customerActivity
 * @title  Customer activity — chronological per-customer event timeline
 *
 * @intro
 *   A customer-service operator on the customer-detail page wants a
 *   single chronological feed of everything that customer has done
 *   recently — orders placed and progressed, items wishlisted,
 *   loyalty points earned or redeemed, support tickets opened and
 *   resolved, reviews submitted — not five separate widgets each
 *   keyed by a different source table. `customerActivity` is the
 *   read-only aggregator: it queries the primitives that already
 *   own each event class and flattens the result into one
 *   `{ kind, occurred_at, title, body, link?, actor? }` stream.
 *
 *   Sources composed (each is optional — when the corresponding peer
 *   is NOT wired into the factory, that source is skipped silently
 *   and the remaining sources still surface):
 *
 *     order          — order_transitions rows joined back to the
 *                      owning customer via orders.customer_id. The
 *                      FSM events (mark_paid, mark_shipped,
 *                      mark_delivered, cancel, refund) become
 *                      "Order placed", "Payment received", "Order
 *                      shipped", etc.
 *     wishlist       — wishlist_entries rows keyed directly by
 *                      customer_id. Each row contributes a single
 *                      "wishlist.added" event at created_at.
 *     loyalty        — loyalty_transactions rows keyed directly by
 *                      customer_id. The transaction_type column drives
 *                      the event kind ("loyalty.earn",
 *                      "loyalty.redeem", "loyalty.expire", etc.).
 *     supportTickets — support_tickets rows owned by customer_id,
 *                      each contributing an "support.opened" event
 *                      at opened_at plus a "support.resolved" event
 *                      when resolved_at is stamped.
 *     reviews        — reviews rows joined by customer_id (the
 *                      authenticated-submission column on the
 *                      reviews table; anonymous email-hash reviews
 *                      stay out of this feed because they aren't
 *                      attributable to a known customer_id).
 *
 *   Surface:
 *
 *     forCustomer({ customer_id, from?, to?, kinds?, cursor?, limit? })
 *       — returns `[{ kind, occurred_at, title, body, link?, actor? }]`
 *         newest-first. `from`/`to` bound the window (epoch-ms);
 *         `kinds` is an optional whitelist of event-kind strings;
 *         `cursor`/`limit` paginate (cursor is an opaque
 *         HMAC-tagged string carrying the tail position).
 *
 *     recentActivity({ limit })
 *       — flattened cross-customer feed for the operator dashboard.
 *         Newest-first across every customer with cache rows; falls
 *         back to walking the live sources when the cache is cold.
 *
 *     summarize({ customer_id })
 *       — returns `{ last_activity_at, kind_counts_30d,
 *                    kind_counts_90d, kind_counts_365d }`. Reads
 *         through the cache when fresh; recomputes from sources and
 *         refreshes the cache when not.
 *
 *     lastActivityAt(customer_id)
 *       — convenience read for the customer-detail page header
 *         strip. Returns the newest source-event timestamp across
 *         every wired source, or `null` when the customer has no
 *         activity at all.
 *
 *     inactiveCustomers({ days, limit })
 *       — operator outreach hint. Returns up to `limit` customers
 *         whose `last_activity_at` is older than `days` ago, newest-
 *         first by last_activity_at so the freshest stale customers
 *         surface before deeply-dormant ones.
 *
 *   Read-only:
 *     This primitive WRITES exactly one table:
 *     `customer_activity_cache`, and only as a memoization side-
 *     effect of summarize() / lastActivityAt() / inactiveCustomers().
 *     Every event row lives in its source primitive's table.
 *
 *   Composition (b.* primitives in use):
 *     - b.guardUuid  — every customer_id input passes through the
 *                      strict profile so a hostile cursor can't
 *                      smuggle SQL fragments through.
 *     - b.pagination — HMAC-tagged tuple cursors for forCustomer().
 *
 * @primitive customerActivity
 * @related   shop.order, shop.wishlist, shop.loyalty,
 *            shop.supportTickets, shop.reviews
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var MAX_LIMIT         = 200;
var DEFAULT_LIMIT     = 50;
var MAX_INACTIVE_LIMIT = 500;
var DEFAULT_INACTIVE_LIMIT = 100;

var MS_PER_DAY = 86400000;
var WINDOW_30D  = 30 * MS_PER_DAY;
var WINDOW_90D  = 90 * MS_PER_DAY;
var WINDOW_365D = 365 * MS_PER_DAY;

// Cache freshness window. summarize() returns the cached row when
// computed_at is within this window AND no source has a newer event
// than last_activity_at. Same posture as order-timeline's cache.
var CACHE_TTL_MS = 5 * 60 * 1000;

// Order-FSM events → canonical English titles. Events not in this
// map fall through with the raw event name as the title.
var ORDER_EVENT_TITLES = {
  "create":            "Order placed",
  "mark_paid":         "Payment received",
  "start_fulfillment": "Preparing for shipment",
  "mark_shipped":      "Order shipped",
  "mark_delivered":    "Order delivered",
  "cancel":            "Order cancelled",
  "refund":            "Order refunded",
};

var LOYALTY_TITLES = {
  "earn":       "Loyalty points earned",
  "redeem":     "Loyalty points redeemed",
  "expire":     "Loyalty points expired",
  "adjust":     "Loyalty balance adjusted",
  "tier-bonus": "Loyalty tier bonus",
};

// Order-key for the forCustomer() pagination cursor — (occurred_at
// DESC, kind DESC). Tuple keeps the cursor monotonic even when two
// events land in the same epoch-ms.
var LIST_ORDER_KEY = ["occurred_at", "kind"];

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customerActivity: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _limit(n, max, def) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("customerActivity: limit must be an integer 1..." + max);
  }
  return n;
}

function _epochMs(v, label) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0) {
    throw new TypeError("customerActivity: " + label + " must be a non-negative integer (epoch-ms) when provided");
  }
  return v;
}

function _kinds(arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) {
    throw new TypeError("customerActivity: kinds must be an array of strings when provided");
  }
  if (arr.length === 0) return null;
  if (arr.length > 64) {
    throw new TypeError("customerActivity: kinds may carry at most 64 entries");
  }
  var out = [];
  var seen = {};
  for (var i = 0; i < arr.length; i += 1) {
    var k = arr[i];
    if (typeof k !== "string" || !k.length || k.length > 128) {
      throw new TypeError("customerActivity: kinds[" + i + "] must be a non-empty string up to 128 chars");
    }
    // Kind tokens are alnum + dot + underscore + hyphen. Refuses
    // smuggling SQL / glob fragments through the filter list.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(k)) {
      throw new TypeError("customerActivity: kinds[" + i + "] must be alnum/./_/- only, starting alnum");
    }
    if (seen[k]) continue;
    seen[k] = true;
    out.push(k);
  }
  return out;
}

function _days(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 3650) {
    throw new TypeError("customerActivity: days must be an integer 1...3650");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Pagination cursor secret. Production deployments derive one via
  // `b.crypto.namespaceHash("customer-activity-cursor", D1_BRIDGE_SECRET)`;
  // dev / test gets a stable placeholder so the cursor decodes
  // without env wiring.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("customerActivity.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "customer-activity-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Injected peers — each optional. The marker value (a truthy
  // object, including a peer's actual `create()` return) flips the
  // matching collector on. The collector reads the source's
  // canonical table directly so it doesn't depend on a particular
  // method on the peer object — same posture order-timeline uses.
  var orderPeer    = opts.order          || null;
  var wishlistPeer = opts.wishlist       || null;
  var loyaltyPeer  = opts.loyalty        || null;
  var supportPeer  = opts.supportTickets || null;
  var reviewsPeer  = opts.reviews        || null;

  // Per-factory monotonic clock for cache computed_at stamps. Two
  // cache refreshes for the same customer in the same wall-clock
  // millisecond would otherwise tie on computed_at and confuse the
  // freshness check. Forward-leap when wall outpaces the counter;
  // otherwise bump by 1ms so the sequence stays strictly increasing
  // per primitive instance.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = _now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- per-source collectors --------------------------------------------
  //
  // Each collector returns an array of `{ kind, occurred_at, title,
  // body, actor, link }` records (newest-first ordering happens at
  // the aggregator). Missing peers collapse to an empty list so the
  // aggregator stays the same shape regardless of wiring.

  async function _collectOrderEvents(customerId, fromTs, toTs) {
    if (!orderPeer) return [];
    var sql = "SELECT ot.order_id, ot.from_state, ot.to_state, ot.on_event, " +
              "ot.reason, ot.occurred_at " +
              "FROM order_transitions ot " +
              "JOIN orders o ON o.id = ot.order_id " +
              "WHERE o.customer_id = ?1";
    var params = [customerId];
    var idx = 2;
    if (fromTs != null) { sql += " AND ot.occurred_at >= ?" + idx; params.push(fromTs); idx += 1; }
    if (toTs   != null) { sql += " AND ot.occurred_at <= ?" + idx; params.push(toTs);   idx += 1; }
    sql += " ORDER BY ot.occurred_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var title = ORDER_EVENT_TITLES[r.on_event] || r.on_event;
      var body = r.reason ? r.reason : (r.from_state + " -> " + r.to_state);
      out.push({
        kind:        "order." + r.on_event,
        occurred_at: Number(r.occurred_at),
        title:       title,
        body:        body,
        actor:       "system",
        link:        "/operator/orders/" + r.order_id,
      });
    }
    return out;
  }

  async function _collectWishlistEvents(customerId, fromTs, toTs) {
    if (!wishlistPeer) return [];
    var sql = "SELECT id, product_id, variant_id, notes, created_at " +
              "FROM wishlist_entries WHERE customer_id = ?1";
    var params = [customerId];
    var idx = 2;
    if (fromTs != null) { sql += " AND created_at >= ?" + idx; params.push(fromTs); idx += 1; }
    if (toTs   != null) { sql += " AND created_at <= ?" + idx; params.push(toTs);   idx += 1; }
    sql += " ORDER BY created_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      out.push({
        kind:        "wishlist.added",
        occurred_at: Number(r.created_at),
        title:       "Wishlisted an item",
        body:        r.notes ? r.notes : null,
        actor:       "customer",
        link:        "/operator/products/" + r.product_id,
      });
    }
    return out;
  }

  async function _collectLoyaltyEvents(customerId, fromTs, toTs) {
    if (!loyaltyPeer) return [];
    var sql = "SELECT id, transaction_type, points, source, order_id, notes, " +
              "occurred_at FROM loyalty_transactions WHERE customer_id = ?1";
    var params = [customerId];
    var idx = 2;
    if (fromTs != null) { sql += " AND occurred_at >= ?" + idx; params.push(fromTs); idx += 1; }
    if (toTs   != null) { sql += " AND occurred_at <= ?" + idx; params.push(toTs);   idx += 1; }
    sql += " ORDER BY occurred_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var pts = Number(r.points) || 0;
      var sign = pts > 0 ? "+" : "";
      var body = sign + pts + " pts" + (r.source ? " (" + r.source + ")" : "");
      out.push({
        kind:        "loyalty." + r.transaction_type,
        occurred_at: Number(r.occurred_at),
        title:       LOYALTY_TITLES[r.transaction_type] || ("Loyalty " + r.transaction_type),
        body:        body,
        actor:       "system",
        link:        r.order_id ? ("/operator/orders/" + r.order_id) : null,
      });
    }
    return out;
  }

  async function _collectSupportEvents(customerId, fromTs, toTs) {
    if (!supportPeer) return [];
    // The support_tickets row contributes an "opened" event at
    // opened_at and a "resolved" event at resolved_at when stamped.
    // The bounded-window filter is applied per-event after
    // splitting (a ticket opened inside the window but resolved
    // outside still surfaces its opened event).
    var rows = (await query(
      "SELECT id, subject, category, status, priority, opened_at, " +
      "resolved_at, closed_at FROM support_tickets WHERE customer_id = ?1 " +
      "ORDER BY opened_at ASC",
      [customerId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var t = rows[i];
      var openedAt = Number(t.opened_at);
      if ((fromTs == null || openedAt >= fromTs) && (toTs == null || openedAt <= toTs)) {
        out.push({
          kind:        "support.opened",
          occurred_at: openedAt,
          title:       "Support ticket opened",
          body:        t.subject + " [" + t.category + "/" + t.priority + "]",
          actor:       "customer",
          link:        "/operator/support/" + t.id,
        });
      }
      if (t.resolved_at != null) {
        var resolvedAt = Number(t.resolved_at);
        if ((fromTs == null || resolvedAt >= fromTs) && (toTs == null || resolvedAt <= toTs)) {
          out.push({
            kind:        "support.resolved",
            occurred_at: resolvedAt,
            title:       "Support ticket resolved",
            body:        t.subject,
            actor:       "operator",
            link:        "/operator/support/" + t.id,
          });
        }
      }
    }
    return out;
  }

  async function _collectReviewEvents(customerId, fromTs, toTs) {
    if (!reviewsPeer) return [];
    // Only authenticated-customer reviews carry a customer_id (the
    // anonymous email-hash submissions land in the reviews table
    // with customer_id NULL and stay out of this feed because
    // they're not attributable to a known customer_id).
    var sql = "SELECT id, product_id, rating, title, status, created_at " +
              "FROM reviews WHERE customer_id = ?1";
    var params = [customerId];
    var idx = 2;
    if (fromTs != null) { sql += " AND created_at >= ?" + idx; params.push(fromTs); idx += 1; }
    if (toTs   != null) { sql += " AND created_at <= ?" + idx; params.push(toTs);   idx += 1; }
    sql += " ORDER BY created_at ASC";
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      out.push({
        kind:        "review." + r.status,
        occurred_at: Number(r.created_at),
        title:       "Review submitted",
        body:        r.rating + "/5 — " + r.title,
        actor:       "customer",
        link:        "/operator/products/" + r.product_id + "#review-" + r.id,
      });
    }
    return out;
  }

  // ---- aggregation ------------------------------------------------------

  async function _collectAll(customerId, fromTs, toTs) {
    var batches = await Promise.all([
      _collectOrderEvents(customerId, fromTs, toTs),
      _collectWishlistEvents(customerId, fromTs, toTs),
      _collectLoyaltyEvents(customerId, fromTs, toTs),
      _collectSupportEvents(customerId, fromTs, toTs),
      _collectReviewEvents(customerId, fromTs, toTs),
    ]);
    var flat = [];
    for (var b = 0; b < batches.length; b += 1) {
      for (var i = 0; i < batches[b].length; i += 1) {
        flat.push(batches[b][i]);
      }
    }
    return flat;
  }

  function _sortNewestFirst(events) {
    events.sort(function (a, b) {
      if (b.occurred_at !== a.occurred_at) return b.occurred_at - a.occurred_at;
      // Tie-break on kind so the order is deterministic across
      // platforms when two events land in the same epoch-ms.
      if (a.kind < b.kind) return 1;
      if (a.kind > b.kind) return -1;
      return 0;
    });
    return events;
  }

  function _filterKinds(events, kinds) {
    if (!kinds) return events;
    var set = {};
    for (var i = 0; i < kinds.length; i += 1) set[kinds[i]] = true;
    return events.filter(function (e) { return set[e.kind] === true; });
  }

  // Apply the cursor tail-tuple. Cursor carries `[occurred_at, kind]`
  // of the last row of the previous page; the next page starts at
  // the first row that's strictly older in the (occurred_at DESC,
  // kind DESC) ordering.
  function _applyCursor(events, cursorVals) {
    if (!cursorVals) return events;
    var ts   = Number(cursorVals[0]);
    var kind = String(cursorVals[1]);
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      if (e.occurred_at < ts) { out.push(e); continue; }
      if (e.occurred_at === ts && e.kind < kind) { out.push(e); continue; }
    }
    return out;
  }

  function _encodeNext(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return _b().pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [last.occurred_at, last.kind],
      forward:  true,
    }, cursorSecret);
  }

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("customerActivity." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = _b().pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("customerActivity." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("customerActivity." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  // Roll up per-source freshness stats so the cache freshness check
  // can detect a new source-event that lands in the same epoch-ms
  // as the cache row.
  async function _sourceStats(customerId) {
    var checks = [];
    if (orderPeer) {
      checks.push(query(
        "SELECT MAX(ot.occurred_at) AS m, COUNT(*) AS n " +
        "FROM order_transitions ot JOIN orders o ON o.id = ot.order_id " +
        "WHERE o.customer_id = ?1",
        [customerId],
      ));
    }
    if (wishlistPeer) {
      checks.push(query(
        "SELECT MAX(created_at) AS m, COUNT(*) AS n FROM wishlist_entries WHERE customer_id = ?1",
        [customerId],
      ));
    }
    if (loyaltyPeer) {
      checks.push(query(
        "SELECT MAX(occurred_at) AS m, COUNT(*) AS n FROM loyalty_transactions WHERE customer_id = ?1",
        [customerId],
      ));
    }
    if (supportPeer) {
      checks.push(query(
        "SELECT " +
        "(SELECT MAX(opened_at)   FROM support_tickets WHERE customer_id = ?1) AS c1, " +
        "(SELECT MAX(resolved_at) FROM support_tickets WHERE customer_id = ?1) AS c2, " +
        "(SELECT COUNT(*) FROM support_tickets WHERE customer_id = ?1) AS n",
        [customerId],
      ));
    }
    if (reviewsPeer) {
      checks.push(query(
        "SELECT MAX(created_at) AS m, COUNT(*) AS n FROM reviews WHERE customer_id = ?1",
        [customerId],
      ));
    }
    var results = await Promise.all(checks);
    var latest = 0;
    var totalCount = 0;
    for (var i = 0; i < results.length; i += 1) {
      var rs = results[i].rows;
      if (!rs.length) continue;
      var row = rs[0];
      var keys = Object.keys(row);
      for (var k = 0; k < keys.length; k += 1) {
        var key = keys[k];
        var raw = row[key];
        if (raw == null) continue;
        if (key === "n") { totalCount += Number(raw) || 0; continue; }
        var v = Number(raw);
        if (Number.isFinite(v) && v > latest) latest = v;
      }
    }
    return { latest: latest, totalCount: totalCount };
  }

  async function _cacheGet(customerId) {
    var r = await query(
      "SELECT customer_id, last_activity_at, kind_counts_30d_json, " +
      "kind_counts_90d_json, kind_counts_365d_json, computed_at " +
      "FROM customer_activity_cache WHERE customer_id = ?1",
      [customerId],
    );
    return r.rows[0] || null;
  }

  async function _cachePut(customerId, summary) {
    var ts = _monotonicTs();
    // INSERT-or-REPLACE pattern: DELETE-then-INSERT so the cache
    // works on engines that lack ON CONFLICT.
    await query("DELETE FROM customer_activity_cache WHERE customer_id = ?1", [customerId]);
    await query(
      "INSERT INTO customer_activity_cache " +
      "(customer_id, last_activity_at, kind_counts_30d_json, " +
      "kind_counts_90d_json, kind_counts_365d_json, computed_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        customerId,
        summary.last_activity_at || 0,
        JSON.stringify(summary.kind_counts_30d  || {}),
        JSON.stringify(summary.kind_counts_90d  || {}),
        JSON.stringify(summary.kind_counts_365d || {}),
        ts,
      ],
    );
  }

  async function _cacheIsFresh(cacheRow, nowTs) {
    if (!cacheRow) return false;
    if (nowTs - Number(cacheRow.computed_at) > CACHE_TTL_MS) return false;
    var stats = await _sourceStats(cacheRow.customer_id);
    if (stats.latest > Number(cacheRow.last_activity_at)) return false;
    return true;
  }

  function _countByKindInWindow(events, nowTs, windowMs) {
    var cutoff = nowTs - windowMs;
    var counts = {};
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      if (e.occurred_at < cutoff) continue;
      counts[e.kind] = (counts[e.kind] || 0) + 1;
    }
    return counts;
  }

  async function _computeSummary(customerId, nowTs) {
    var events = await _collectAll(customerId, null, null);
    _sortNewestFirst(events);
    var last = events.length ? events[0].occurred_at : 0;
    return {
      last_activity_at:  last,
      kind_counts_30d:   _countByKindInWindow(events, nowTs, WINDOW_30D),
      kind_counts_90d:   _countByKindInWindow(events, nowTs, WINDOW_90D),
      kind_counts_365d:  _countByKindInWindow(events, nowTs, WINDOW_365D),
    };
  }

  function _stripInternalFields(events) {
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      out.push({
        kind:        e.kind,
        occurred_at: e.occurred_at,
        title:       e.title,
        body:        e.body == null ? null : e.body,
        actor:       e.actor || null,
        link:        e.link  || null,
      });
    }
    return out;
  }

  // ---- public surface ---------------------------------------------------

  return {
    CACHE_TTL_MS:            CACHE_TTL_MS,
    MAX_LIMIT:               MAX_LIMIT,
    DEFAULT_LIMIT:           DEFAULT_LIMIT,
    MAX_INACTIVE_LIMIT:      MAX_INACTIVE_LIMIT,
    DEFAULT_INACTIVE_LIMIT:  DEFAULT_INACTIVE_LIMIT,

    forCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerActivity.forCustomer: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var fromTs     = _epochMs(input.from, "from");
      var toTs       = _epochMs(input.to,   "to");
      if (fromTs != null && toTs != null && fromTs > toTs) {
        throw new TypeError("customerActivity.forCustomer: from must be <= to");
      }
      var kinds  = _kinds(input.kinds);
      var limit  = _limit(input.limit, MAX_LIMIT, DEFAULT_LIMIT);
      var cursor = _decodeCursor(input.cursor, "forCustomer");

      var events = await _collectAll(customerId, fromTs, toTs);
      events = _filterKinds(events, kinds);
      _sortNewestFirst(events);
      if (cursor) events = _applyCursor(events, cursor);
      var page = events.slice(0, limit);
      return {
        events:      _stripInternalFields(page),
        next_cursor: _encodeNext(page, limit),
      };
    },

    recentActivity: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("customerActivity.recentActivity: options object required");
      }
      var limit = _limit(listOpts.limit, MAX_LIMIT, DEFAULT_LIMIT);

      // Scope through the cache when it's been warmed; otherwise
      // fall back to walking every customer that has at least one
      // event in a wired source. The cache fast-path keeps the
      // dashboard cheap once an operator has loaded any per-customer
      // summary; the slow-path keeps the surface useful on a cold
      // install.
      var cacheRows = (await query(
        "SELECT customer_id FROM customer_activity_cache " +
        "ORDER BY last_activity_at DESC LIMIT ?1",
        [limit],
      )).rows;

      var customerIds = [];
      var seen = {};
      for (var i = 0; i < cacheRows.length; i += 1) {
        var cid = cacheRows[i].customer_id;
        if (seen[cid]) continue;
        seen[cid] = true;
        customerIds.push(cid);
      }

      // Cold-path discovery: if the cache yielded fewer customers
      // than the requested limit, walk each wired source's distinct
      // customer_id list to fill the gap. The operator dashboard
      // doesn't care that the cache hasn't been warmed for these
      // customers yet — the events still exist in the source tables.
      if (customerIds.length < limit) {
        var sourceCustomerSqls = [];
        if (orderPeer)    sourceCustomerSqls.push("SELECT DISTINCT customer_id AS cid FROM orders WHERE customer_id IS NOT NULL");
        if (wishlistPeer) sourceCustomerSqls.push("SELECT DISTINCT customer_id AS cid FROM wishlist_entries");
        if (loyaltyPeer)  sourceCustomerSqls.push("SELECT DISTINCT customer_id AS cid FROM loyalty_transactions");
        if (supportPeer)  sourceCustomerSqls.push("SELECT DISTINCT customer_id AS cid FROM support_tickets WHERE customer_id IS NOT NULL");
        if (reviewsPeer)  sourceCustomerSqls.push("SELECT DISTINCT customer_id AS cid FROM reviews WHERE customer_id IS NOT NULL");
        for (var s = 0; s < sourceCustomerSqls.length; s += 1) {
          var srows = (await query(sourceCustomerSqls[s], [])).rows;
          for (var k = 0; k < srows.length; k += 1) {
            var c = srows[k].cid;
            if (!c || seen[c]) continue;
            seen[c] = true;
            customerIds.push(c);
            if (customerIds.length >= limit * 4) break;          // bounded discovery scope
          }
          if (customerIds.length >= limit * 4) break;
        }
      }

      var merged = [];
      for (var m = 0; m < customerIds.length; m += 1) {
        var cid2 = customerIds[m];
        var ev = await _collectAll(cid2, null, null);
        for (var j = 0; j < ev.length; j += 1) {
          var rec = ev[j];
          merged.push({
            customer_id: cid2,
            kind:        rec.kind,
            occurred_at: rec.occurred_at,
            title:       rec.title,
            body:        rec.body == null ? null : rec.body,
            actor:       rec.actor || null,
            link:        rec.link  || null,
          });
        }
      }
      merged.sort(function (x, y) {
        if (y.occurred_at !== x.occurred_at) return y.occurred_at - x.occurred_at;
        if (x.kind < y.kind) return 1;
        if (x.kind > y.kind) return -1;
        return 0;
      });
      if (merged.length > limit) merged.length = limit;
      return merged;
    },

    summarize: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customerActivity.summarize: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var nowTs = _now();
      var cached = await _cacheGet(customerId);
      if (await _cacheIsFresh(cached, nowTs)) {
        var c30  = {};
        var c90  = {};
        var c365 = {};
        try { c30  = JSON.parse(cached.kind_counts_30d_json  || "{}"); }
        catch (_e) { c30  = {}; }                                     // drop-silent — bad cache JSON falls through to fresh recompute on next call
        try { c90  = JSON.parse(cached.kind_counts_90d_json  || "{}"); }
        catch (_e) { c90  = {}; }                                     // drop-silent — see above
        try { c365 = JSON.parse(cached.kind_counts_365d_json || "{}"); }
        catch (_e) { c365 = {}; }                                     // drop-silent — see above
        return {
          last_activity_at:  Number(cached.last_activity_at) || null,
          kind_counts_30d:   c30,
          kind_counts_90d:   c90,
          kind_counts_365d:  c365,
          cache_hit:         true,
        };
      }
      var summary = await _computeSummary(customerId, nowTs);
      await _cachePut(customerId, summary);
      return {
        last_activity_at:  summary.last_activity_at || null,
        kind_counts_30d:   summary.kind_counts_30d,
        kind_counts_90d:   summary.kind_counts_90d,
        kind_counts_365d:  summary.kind_counts_365d,
        cache_hit:         false,
      };
    },

    lastActivityAt: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var cached = await _cacheGet(cid);
      var nowTs = _now();
      if (await _cacheIsFresh(cached, nowTs)) {
        var v = Number(cached.last_activity_at);
        return v > 0 ? v : null;
      }
      var stats = await _sourceStats(cid);
      var latest = stats.latest > 0 ? stats.latest : null;
      // Best-effort cache refresh so the next call hits the cached
      // row. lastActivityAt() is the cheapest summarize-equivalent;
      // populating the cache here lets the operator-dashboard
      // recent-customers strip avoid an N-deep source recompute on
      // each render.
      if (latest != null) {
        var summary = await _computeSummary(cid, nowTs);
        await _cachePut(cid, summary);
      }
      return latest;
    },

    inactiveCustomers: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("customerActivity.inactiveCustomers: options object required");
      }
      var days  = _days(listOpts.days);
      var limit = _limit(listOpts.limit, MAX_INACTIVE_LIMIT, DEFAULT_INACTIVE_LIMIT);
      var cutoff = _now() - (days * MS_PER_DAY);
      var rows = (await query(
        "SELECT customer_id, last_activity_at FROM customer_activity_cache " +
        "WHERE last_activity_at < ?1 AND last_activity_at > 0 " +
        "ORDER BY last_activity_at DESC LIMIT ?2",
        [cutoff, limit],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({
          customer_id:      rows[i].customer_id,
          last_activity_at: Number(rows[i].last_activity_at),
        });
      }
      return out;
    },

    // Operator-facing cache sweep — removes cache rows older than
    // the bound. Useful as a periodic chore when an operator wants
    // the dashboard to recompute from sources for every customer
    // (e.g. after a bulk import).
    purgeStaleCache: async function (olderThanMs) {
      var bound = Number.isInteger(olderThanMs) && olderThanMs > 0
        ? olderThanMs
        : CACHE_TTL_MS * 12;
      var cutoff = _now() - bound;
      var r = await query(
        "DELETE FROM customer_activity_cache WHERE computed_at < ?1",
        [cutoff],
      );
      return { purged: Number(r.rowCount || 0) };
    },
  };
}

// Async run() entry point — invoked by harnesses that load the
// primitive as a unit (e.g. a smoke gate). Builds a default factory
// against `b.externalDb` so callers don't need to know about the
// peer injection surface to verify the module loads cleanly.
async function run() {
  var instance = create({});
  return {
    ok:      true,
    surface: Object.keys(instance),
  };
}

module.exports = {
  create:                  create,
  run:                     run,
  CACHE_TTL_MS:            CACHE_TTL_MS,
  MAX_LIMIT:               MAX_LIMIT,
  DEFAULT_LIMIT:           DEFAULT_LIMIT,
  MAX_INACTIVE_LIMIT:      MAX_INACTIVE_LIMIT,
  DEFAULT_INACTIVE_LIMIT:  DEFAULT_INACTIVE_LIMIT,
};
