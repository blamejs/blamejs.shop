"use strict";
/**
 * @module shop.recentlyViewed
 * @title  Recently-viewed — per-customer / per-session browse log
 *
 * @intro
 *   The storefront logs every product-detail-page open into a
 *   per-subject sliding window so the account page can render a
 *   "Recently viewed" rail, the cart can suggest "you might also
 *   like" picks seeded by recent browse, and the merge-on-login
 *   flow carries an anonymous shopper's pre-auth history into
 *   their account without re-asking.
 *
 *   Subject model: a row is anchored EITHER to a known customer
 *   (`customer_id`, post-login browse) OR to a hashed session id
 *   (`session_id_hash`, anonymous browse). At least one is
 *   required at write time; the schema's CHECK enforces it. The
 *   session id is namespace-hashed before write — the raw cookie
 *   value never lands in this table, so a dump can't be replayed
 *   to impersonate a still-active session.
 *
 *   Composes:
 *     - `b.guardUuid` — every customer / product id is UUID-shape-
 *       validated at the entry point; bad shape throws a TypeError
 *       the calling route handler translates to HTTP 400.
 *     - `b.crypto.namespaceHash` — session ids are hashed under the
 *       `recently-viewed-session` namespace so the log column is
 *       opaque to operator-side dumps.
 *     - `b.uuid.v7` — row id (lexicographically sortable as a
 *       tiebreak alongside last_viewed_at).
 *
 *   Sliding-window discipline:
 *     - Per-subject cap (default 20). When a write would push the
 *       row count past the cap, the oldest rows for that subject
 *       are trimmed in-line so the table never accumulates an
 *       unbounded per-customer history.
 *     - 5-minute dedup window: a repeat view of the same product
 *       within that window bumps `last_viewed_at` + `view_count`
 *       on the existing row instead of writing a new one. Beyond
 *       that window the existing row is still updated (UNIQUE on
 *       the subject + product tuple) — the dedup window only
 *       governs the operator-facing "viewed N times" badge.
 *
 *   Surface:
 *     - `recordView({ customer_id?, session_id?, product_id,
 *                     occurred_at? })` — at least one of
 *       customer_id / session_id required. Session id is namespace-
 *       hashed; raw value never persisted. Returns
 *       `{ id, status: "inserted" | "updated", view_count }`.
 *     - `forCustomer(customer_id, { limit?, exclude_purchased? })` —
 *       newest-first. `exclude_purchased` filters out products the
 *       customer has already bought (joined via order_lines →
 *       variants).
 *     - `forSession(session_id, { limit? })` — anonymous-browse
 *       lookup; hashes the supplied session id and matches.
 *     - `merge({ session_id, customer_id })` — on login, fold the
 *       session's anonymous history into the customer's record.
 *       Per-product UNIQUE means matching rows are merged (max
 *       last_viewed_at + sum of view_counts) rather than duplicated.
 *     - `recommend(customer_id, { limit? })` — combines the
 *       customer's recently-viewed list with a co-viewed-by-other-
 *       customers signal to produce a "you might also like" list.
 *       Returns `[ { product_id, score } ]` sorted by score desc;
 *       products the customer has already viewed OR purchased are
 *       excluded.
 *     - `cleanupOlderThan(days)` — operator scheduler entry point
 *       that prunes rows whose `last_viewed_at` is older than the
 *       supplied age. Returns the count of removed rows.
 *     - `purgeCustomer(customer_id)` — GDPR / right-to-erasure
 *       hook: drops every row for the customer.
 *
 *   Storage:
 *     - `recently_viewed` (migration `0050_recently_viewed.sql`).
 *
 * @primitive recentlyViewed
 * @related   b.guardUuid, b.crypto.namespaceHash, b.uuid
 */

// `_b()` is a hoisted function declaration (defined below); resolving the
// framework constants here at module-eval is safe — the index entry point
// exposes `framework` before the require cascade.
var C = _b().constants;

var DEFAULT_LIMIT       = 20;
var MAX_LIMIT           = 100;
var PER_SUBJECT_CAP     = 20;
var DEDUP_WINDOW_MS     = C.TIME.minutes(5);
var SESSION_NAMESPACE   = "recently-viewed-session";
var SESSION_ID_RE       = /^[A-Za-z0-9_-]{16,64}$/;
var RECOMMEND_LIMIT     = 10;
// Co-view fan-out cap. `recommend` walks "other customers who
// viewed the same products as me" and aggregates their other
// viewed products into a co-view score. The cap bounds the
// fan-out so a hot-product customer doesn't trigger an unbounded
// scan; operator-tuned via opts.recommendFanout on create.
var DEFAULT_RECOMMEND_FANOUT = 200;

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("recently-viewed: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _sessionId(s) {
  if (typeof s !== "string" || !SESSION_ID_RE.test(s)) {
    throw new TypeError("recently-viewed: session_id must be 16-64 chars of [A-Za-z0-9_-]");
  }
  return s;
}

function _hashSession(s) {
  return _b().crypto.namespaceHash(SESSION_NAMESPACE, s);
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("recently-viewed: " + label + " must be 1..." + MAX_LIMIT);
  }
  return n;
}

function _days(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("recently-viewed: days must be a non-negative integer");
  }
}

function _occurredAt(v) {
  if (v == null) return Date.now();
  if (!Number.isInteger(v) || v < 0) {
    throw new TypeError("recently-viewed: occurred_at must be a non-negative integer (epoch ms)");
  }
  return v;
}

function _cap(n, label) {
  if (!Number.isInteger(n) || n <= 0 || n > 200) {
    throw new TypeError("recently-viewed: " + label + " must be 1..200");
  }
  return n;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // The catalog handle is composed by `recommend` (variant → product
  // resolution for the co-view signal goes through raw SQL against
  // the catalog tables, so the handle isn't strictly used at query
  // time, but the factory accepts it for parity with sibling
  // storefront primitives and so a forthcoming "boost in-stock
  // products" pass has an existing dependency to lean on).
  if (!opts.catalog) {
    throw new TypeError("recently-viewed.create: opts.catalog required (composes catalog for product / variant resolution)");
  }
  var perSubjectCap = opts.perSubjectCap == null ? PER_SUBJECT_CAP : _cap(opts.perSubjectCap, "perSubjectCap");
  var recommendFanout = opts.recommendFanout == null
    ? DEFAULT_RECOMMEND_FANOUT
    : _cap(opts.recommendFanout, "recommendFanout");

  // Trim the subject's rows down to the per-subject cap. Called
  // from recordView after every insert / update so the table never
  // grows unbounded for a single subject. The cap applies to the
  // (customer_id, session_id_hash) tuple — anonymous and post-
  // login histories each get their own cap.
  async function _trimSubject(customerId, sessionHash) {
    var sql, params;
    if (customerId) {
      sql = "DELETE FROM recently_viewed WHERE customer_id = ?1 AND id IN (" +
            "  SELECT id FROM recently_viewed WHERE customer_id = ?1 " +
            "  ORDER BY last_viewed_at DESC, id DESC LIMIT -1 OFFSET ?2" +
            ")";
      params = [customerId, perSubjectCap];
    } else {
      sql = "DELETE FROM recently_viewed WHERE session_id_hash = ?1 AND id IN (" +
            "  SELECT id FROM recently_viewed WHERE session_id_hash = ?1 " +
            "  ORDER BY last_viewed_at DESC, id DESC LIMIT -1 OFFSET ?2" +
            ")";
      params = [sessionHash, perSubjectCap];
    }
    await query(sql, params);
  }

  return {
    DEFAULT_LIMIT:    DEFAULT_LIMIT,
    PER_SUBJECT_CAP:  perSubjectCap,
    DEDUP_WINDOW_MS:  DEDUP_WINDOW_MS,

    // Log a product view. At least one of customer_id / session_id
    // is required — the schema's CHECK enforces it and the app
    // layer mirrors the gate so the error surface is consistent.
    //
    //   Dedup: if a row already exists for the (subject, product)
    //   tuple AND the prior last_viewed_at is within
    //   DEDUP_WINDOW_MS, bump last_viewed_at + view_count on the
    //   existing row. Outside the window, the existing row is
    //   still updated (the UNIQUE constraint enforces one row per
    //   subject+product) but `view_count` is reset to 1 to
    //   represent a fresh browsing session.
    recordView: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("recently-viewed.recordView: input object required");
      }
      var hasCustomer = input.customer_id != null && input.customer_id !== "";
      var hasSession  = input.session_id  != null && input.session_id  !== "";
      if (!hasCustomer && !hasSession) {
        throw new TypeError("recently-viewed.recordView: at least one of customer_id / session_id required");
      }
      var customerId  = hasCustomer ? _uuid(input.customer_id, "customer_id") : null;
      var sessionHash = hasSession  ? _hashSession(_sessionId(input.session_id)) : null;
      var productId   = _uuid(input.product_id, "product_id");
      var ts = _occurredAt(input.occurred_at);

      // Look up an existing row for the subject + product tuple.
      // The subject side of the lookup uses the same COALESCE
      // shape the UNIQUE index uses so SQLite picks the index.
      var existingSql, existingParams;
      if (customerId) {
        existingSql = "SELECT * FROM recently_viewed " +
                      "WHERE customer_id = ?1 AND product_id = ?2 LIMIT 1";
        existingParams = [customerId, productId];
      } else {
        existingSql = "SELECT * FROM recently_viewed " +
                      "WHERE session_id_hash = ?1 AND product_id = ?2 LIMIT 1";
        existingParams = [sessionHash, productId];
      }
      var existing = (await query(existingSql, existingParams)).rows[0];

      var result;
      if (existing) {
        // Within the dedup window — bump count + last_viewed_at.
        // Outside — reset count to 1 (fresh browsing session) but
        // still update last_viewed_at so the row floats to the top.
        var withinWindow = (ts - Number(existing.last_viewed_at || 0)) <= DEDUP_WINDOW_MS;
        var nextCount = withinWindow ? Number(existing.view_count || 0) + 1 : 1;
        await query(
          "UPDATE recently_viewed SET last_viewed_at = ?1, view_count = ?2 WHERE id = ?3",
          [ts, nextCount, existing.id],
        );
        result = { id: existing.id, status: "updated", view_count: nextCount };
      } else {
        var id = _b().uuid.v7();
        await query(
          "INSERT INTO recently_viewed " +
          "(id, customer_id, session_id_hash, product_id, viewed_at, last_viewed_at, view_count) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)",
          [id, customerId, sessionHash, productId, ts],
        );
        result = { id: id, status: "inserted", view_count: 1 };
      }

      await _trimSubject(customerId, sessionHash);
      return result;
    },

    // Newest-first listing for a known customer. The
    // exclude_purchased gate joins order_lines → variants to find
    // products this customer has already bought and filters them
    // out — useful for the "you've looked at these but haven't
    // bought" account widget that shouldn't surface already-owned
    // gear.
    forCustomer: async function (customerId, listOpts) {
      var cid = _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("recently-viewed.forCustomer: opts must be an object");
      }
      var limit = _limit(listOpts.limit, "limit");
      var excludePurchased = listOpts.exclude_purchased === true;

      var sql, params;
      if (excludePurchased) {
        sql = "SELECT rv.* FROM recently_viewed rv " +
              "WHERE rv.customer_id = ?1 " +
              "  AND rv.product_id NOT IN (" +
              "    SELECT DISTINCT v.product_id FROM order_lines ol " +
              "    JOIN orders o ON o.id = ol.order_id " +
              "    JOIN variants v ON v.id = ol.variant_id " +
              "    WHERE o.customer_id = ?1" +
              "  ) " +
              "ORDER BY rv.last_viewed_at DESC, rv.id DESC LIMIT ?2";
        params = [cid, limit];
      } else {
        sql = "SELECT * FROM recently_viewed WHERE customer_id = ?1 " +
              "ORDER BY last_viewed_at DESC, id DESC LIMIT ?2";
        params = [cid, limit];
      }
      var rows = (await query(sql, params)).rows;
      return rows;
    },

    // Anonymous-browse lookup. The session id is hashed identically
    // to the write path so the lookup hits the same row.
    forSession: async function (sessionId, listOpts) {
      var sid = _sessionId(sessionId);
      var hash = _hashSession(sid);
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("recently-viewed.forSession: opts must be an object");
      }
      var limit = _limit(listOpts.limit, "limit");
      var rows = (await query(
        "SELECT * FROM recently_viewed WHERE session_id_hash = ?1 " +
        "ORDER BY last_viewed_at DESC, id DESC LIMIT ?2",
        [hash, limit],
      )).rows;
      return rows;
    },

    // Login-time merge — the customer just authenticated, fold
    // their anonymous browse log into their customer record.
    //
    //   Algorithm:
    //     1. Read every session row for the supplied session id.
    //     2. For each, look up the customer's existing row for the
    //        same product:
    //          - If one exists, take max(last_viewed_at) +
    //            sum(view_count) so the merged row preserves both
    //            histories.
    //          - If not, claim the session row by rewriting its
    //            customer_id / session_id_hash columns in place.
    //            Cheaper than insert+delete and keeps the row id
    //            stable so any caller holding a reference still
    //            resolves.
    //     3. Drop any session rows that were collapsed into an
    //        existing customer row.
    //     4. Trim the merged subject down to the cap.
    //
    //   Returns { merged: <count of session rows folded in>,
    //             claimed: <count rewritten in place> }.
    merge: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("recently-viewed.merge: input object required");
      }
      var sid = _sessionId(input.session_id);
      var cid = _uuid(input.customer_id, "customer_id");
      var hash = _hashSession(sid);

      var sessionRows = (await query(
        "SELECT * FROM recently_viewed WHERE session_id_hash = ?1",
        [hash],
      )).rows;
      var merged = 0;
      var claimed = 0;
      for (var i = 0; i < sessionRows.length; i += 1) {
        var sRow = sessionRows[i];
        var existing = (await query(
          "SELECT * FROM recently_viewed WHERE customer_id = ?1 AND product_id = ?2 LIMIT 1",
          [cid, sRow.product_id],
        )).rows[0];
        if (existing) {
          // Customer already has a row for this product — fold the
          // session row's counters in and drop it.
          var nextLast = Math.max(
            Number(existing.last_viewed_at || 0),
            Number(sRow.last_viewed_at || 0)
          );
          var nextFirst = Math.min(
            Number(existing.viewed_at || existing.last_viewed_at || 0),
            Number(sRow.viewed_at || sRow.last_viewed_at || 0)
          );
          var nextCount = Number(existing.view_count || 0) + Number(sRow.view_count || 0);
          await query(
            "UPDATE recently_viewed SET viewed_at = ?1, last_viewed_at = ?2, view_count = ?3 WHERE id = ?4",
            [nextFirst, nextLast, nextCount, existing.id],
          );
          await query("DELETE FROM recently_viewed WHERE id = ?1", [sRow.id]);
          merged += 1;
        } else {
          // Rewrite the session row in place — cheaper than
          // insert+delete and keeps the row id stable.
          await query(
            "UPDATE recently_viewed SET customer_id = ?1, session_id_hash = NULL WHERE id = ?2",
            [cid, sRow.id],
          );
          claimed += 1;
        }
      }
      await _trimSubject(cid, null);
      return { merged: merged, claimed: claimed };
    },

    // "You might also like" — combines the customer's recently-
    // viewed list with a co-viewed-by-other-customers signal.
    //
    //   Algorithm:
    //     1. Read the customer's recently-viewed product ids
    //        (newest first, capped at the per-subject cap).
    //     2. For each, find other customers who also viewed the
    //        same product (capped at recommendFanout to keep the
    //        fan-out bounded).
    //     3. Aggregate THOSE customers' recently-viewed products,
    //        weighted by view_count, into a score map.
    //     4. Drop products the seed customer has already viewed OR
    //        purchased.
    //     5. Return the top-N by score.
    //
    //   The whole thing is a single read pass (no writes). When
    //   the customer has no recently-viewed history yet, returns
    //   an empty list — the caller decides whether to fall back to
    //   a global "popular" rail.
    recommend: async function (customerId, recOpts) {
      var cid = _uuid(customerId, "customer_id");
      recOpts = recOpts || {};
      if (typeof recOpts !== "object") {
        throw new TypeError("recently-viewed.recommend: opts must be an object");
      }
      var limit = recOpts.limit == null
        ? RECOMMEND_LIMIT
        : _limit(recOpts.limit, "limit");

      var seedRows = (await query(
        "SELECT product_id FROM recently_viewed WHERE customer_id = ?1 " +
        "ORDER BY last_viewed_at DESC, id DESC LIMIT ?2",
        [cid, perSubjectCap],
      )).rows;
      if (seedRows.length === 0) return [];

      var seedSet = {};
      for (var i = 0; i < seedRows.length; i += 1) seedSet[seedRows[i].product_id] = true;

      // Co-viewer set: other customers who viewed any of our seed
      // products. The fan-out cap bounds the scan; we order by
      // last_viewed_at so the most recent co-viewers dominate.
      var scores = {};
      for (var j = 0; j < seedRows.length; j += 1) {
        var pid = seedRows[j].product_id;
        var coViewers = (await query(
          "SELECT DISTINCT customer_id FROM recently_viewed " +
          "WHERE product_id = ?1 AND customer_id IS NOT NULL AND customer_id != ?2 " +
          "ORDER BY last_viewed_at DESC LIMIT ?3",
          [pid, cid, recommendFanout],
        )).rows;
        for (var k = 0; k < coViewers.length; k += 1) {
          var otherId = coViewers[k].customer_id;
          var theirs = (await query(
            "SELECT product_id, view_count FROM recently_viewed " +
            "WHERE customer_id = ?1 ORDER BY last_viewed_at DESC LIMIT ?2",
            [otherId, perSubjectCap],
          )).rows;
          for (var m = 0; m < theirs.length; m += 1) {
            var candidate = theirs[m].product_id;
            if (seedSet[candidate]) continue;        // already viewed by seed
            scores[candidate] = (scores[candidate] || 0) + Number(theirs[m].view_count || 1);
          }
        }
      }

      // Exclude products the seed customer has already purchased.
      var purchased = (await query(
        "SELECT DISTINCT v.product_id FROM order_lines ol " +
        "JOIN orders o ON o.id = ol.order_id " +
        "JOIN variants v ON v.id = ol.variant_id " +
        "WHERE o.customer_id = ?1",
        [cid],
      )).rows;
      for (var p = 0; p < purchased.length; p += 1) {
        delete scores[purchased[p].product_id];
      }

      var ranked = Object.keys(scores).map(function (k2) {
        return { product_id: k2, score: scores[k2] };
      });
      ranked.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return a.product_id < b.product_id ? -1 : (a.product_id > b.product_id ? 1 : 0);
      });
      return ranked.slice(0, limit);
    },

    // Operator scheduler: prune rows whose last_viewed_at is older
    // than the supplied age. Operators typically wire this to a
    // daily cron with `days=90` so the table stays bounded as the
    // shopper population grows.
    cleanupOlderThan: async function (days) {
      _days(days);
      var threshold = Date.now() - C.TIME.days(days);
      var r = await query(
        "DELETE FROM recently_viewed WHERE last_viewed_at < ?1",
        [threshold],
      );
      return { removed: Number(r.rowCount || 0) };
    },

    // GDPR / right-to-erasure: drop every row for the supplied
    // customer. Anonymous-session rows linked to the same physical
    // shopper are NOT swept here (the hash is one-way; the
    // operator has no way to enumerate them) — `cleanupOlderThan`
    // is the catch-all that eventually retires them.
    purgeCustomer: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var r = await query(
        "DELETE FROM recently_viewed WHERE customer_id = ?1",
        [cid],
      );
      return { removed: Number(r.rowCount || 0) };
    },
  };
}

module.exports = {
  create:           create,
  DEFAULT_LIMIT:    DEFAULT_LIMIT,
  PER_SUBJECT_CAP:  PER_SUBJECT_CAP,
  DEDUP_WINDOW_MS:  DEDUP_WINDOW_MS,
};
