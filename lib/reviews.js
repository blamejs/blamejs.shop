"use strict";
/**
 * @module shop.reviews
 * @title  Reviews primitive — operator-moderated product ratings
 *
 * @intro
 *   Customer-submitted star rating + body per product. Every review
 *   lands in `pending` state and requires an explicit `publish` (or
 *   `reject`) call before it surfaces on the storefront — operators
 *   own the moderation policy; the primitive only guards the row
 *   shape and the transitions.
 *
 *   Author identity is always stored as `customer_id_hash`:
 *     - authenticated submissions hash the customer id via
 *       `b.crypto.namespaceHash("review-customer", customer_id)` and
 *       keep the raw id alongside so "my reviews" reads stay cheap.
 *     - anonymous submissions hash the normalised email (`b.guardEmail`
 *       at the strict profile, then `toLowerCase().trim()`); the raw
 *       address is NEVER persisted.
 *
 *   Composes:
 *     - `b.guardUuid`  — UUID-shape validation for ids
 *     - `b.guardEmail` — strict-profile email shape check
 *     - `b.crypto.namespaceHash` — deterministic customer hash
 *     - `b.uuid.v7`    — row id
 *     - `b.pagination` — HMAC-tagged tuple cursors for the list APIs
 *
 *   Surface:
 *     submit({ product_id, customer_id?, customer_email?, rating,
 *              title, body, verified_purchase? })
 *       → { id, status: "pending" }
 *     publish(id)                     → moderation pass
 *     reject(id, reason?)             → moderation deny
 *     listForProduct(product_id, opts)→ { rows, next_cursor } (published default)
 *     summaryForProduct(product_id)   → { count, avg_rating, distribution }
 *     byCustomer(customer_id_hash, opts) → { rows, next_cursor }
 *
 *   Storage:
 *     - `reviews` (migration `0011_reviews.sql`).
 */

var CUSTOMER_NAMESPACE = "review-customer";
var MAX_TITLE_LEN      = 120;
var MAX_BODY_LEN       = 4000;
var MAX_LIST_LIMIT     = 100;
var DEFAULT_LIMIT      = 50;
var MAX_REJECT_REASON_LEN = 500;

var REVIEW_ORDER_KEY   = ["created_at:desc", "id:desc"];
var CUSTOMER_ORDER_KEY = ["created_at:desc", "id:desc"];

var ALLOWED_STATUSES   = ["pending", "published", "rejected"];

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("reviews: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _rating(n) {
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new TypeError("reviews: rating must be an integer between 1 and 5");
  }
  return n;
}

function _title(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("reviews: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("reviews: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  textGuard.freeText(s, "reviews: title", { bidiMarks: "allow" });
  return s;
}

function _body(s) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("reviews: body must be a string");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("reviews: body must be <= " + MAX_BODY_LEN + " characters");
  }
  textGuard.freeText(s, "reviews: body", { bidiMarks: "allow" });
  return s;
}

function _verifiedPurchase(n) {
  if (n == null) return 0;
  if (n === 0 || n === 1)         return n;
  if (n === true)                  return 1;
  if (n === false)                 return 0;
  throw new TypeError("reviews: verified_purchase must be 0 or 1");
}

function _statusFilter(s) {
  if (s == null) return undefined;
  if (typeof s !== "string" || ALLOWED_STATUSES.indexOf(s) === -1) {
    throw new TypeError("reviews: status filter must be one of " + ALLOWED_STATUSES.join(", "));
  }
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("reviews: limit must be an integer 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("reviews: customer_email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  // Validate first so a non-OK report surfaces a precise reason
  // instead of the sanitize-throw's catch-all message.
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("reviews: customer_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("reviews: customer_email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("reviews: customer_email — " + (e && e.message || "refused"));
  }
  // Lowercase the whole address before hashing — review identity is
  // derived from a single canonical form. RFC 5321 local-part case
  // sensitivity isn't a posture worth preserving here (the hash never
  // lands in an SMTP routing path).
  return canonical.toLowerCase().trim();
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged via b.pagination so an operator
  // can't hand-craft one to skip past a hidden review or replay across
  // deployments. The secret defaults to a dev-only placeholder so the
  // primitive boots in tests; production deployments must supply a
  // derived value (typically b.crypto.namespaceHash("review-cursor",
  // D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("reviews.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "review-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _hashCustomer(s) {
    return b.crypto.namespaceHash(CUSTOMER_NAMESPACE, s);
  }

  function _decodeCursor(cursor, orderKey, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("reviews." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(orderKey)) {
        throw new TypeError("reviews." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("reviews." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, orderKey, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return b.pagination.encodeCursor({
      orderKey: orderKey,
      vals:     [last.created_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  return {
    CUSTOMER_NAMESPACE: CUSTOMER_NAMESPACE,
    MAX_TITLE_LEN:      MAX_TITLE_LEN,
    MAX_BODY_LEN:       MAX_BODY_LEN,
    MAX_LIST_LIMIT:     MAX_LIST_LIMIT,

    // Hash an identifier (customer id or normalised email) without
    // writing. Operator-facing convenience for the storefront's
    // "have I already reviewed this?" lookup.
    hashCustomerId: function (customerId) {
      _uuid(customerId, "customer_id");
      return _hashCustomer(customerId);
    },
    hashCustomerEmail: function (email) {
      return _hashCustomer(_normalizeEmail(email));
    },

    submit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reviews.submit: input object required");
      }
      var productId = _uuid(input.product_id, "product_id");
      var rating    = _rating(input.rating);
      var title     = _title(input.title);
      var body      = _body(input.body);
      var verified  = _verifiedPurchase(input.verified_purchase);

      var hasId    = input.customer_id != null && input.customer_id !== "";
      var hasEmail = input.customer_email != null && input.customer_email !== "";
      if (!hasId && !hasEmail) {
        throw new TypeError("reviews.submit: either customer_id or customer_email is required");
      }
      var customerId = null;
      var customerHash;
      if (hasId) {
        customerId   = _uuid(input.customer_id, "customer_id");
        customerHash = _hashCustomer(customerId);
      } else {
        customerHash = _hashCustomer(_normalizeEmail(input.customer_email));
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO reviews " +
        "(id, product_id, customer_id, customer_id_hash, rating, title, body, verified_purchase, status, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9)",
        [id, productId, customerId, customerHash, rating, title, body, verified, ts],
      );
      return { id: id, status: "pending" };
    },

    get: async function (id) {
      _uuid(id, "review id");
      var r = await query("SELECT * FROM reviews WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    publish: async function (id) {
      _uuid(id, "review id");
      var ts = _now();
      var existing = (await query("SELECT id, status FROM reviews WHERE id = ?1", [id])).rows[0];
      if (!existing) {
        var err = new Error("reviews.publish: review " + id + " not found");
        err.code = "REVIEW_NOT_FOUND";
        throw err;
      }
      await query(
        "UPDATE reviews SET status = 'published', updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      var r = await query("SELECT * FROM reviews WHERE id = ?1", [id]);
      return r.rows[0];
    },

    reject: async function (id, reason) {
      _uuid(id, "review id");
      if (reason != null) {
        if (typeof reason !== "string") {
          throw new TypeError("reviews.reject: reason must be a string");
        }
        if (reason.length > MAX_REJECT_REASON_LEN) {
          throw new TypeError("reviews.reject: reason must be <= " + MAX_REJECT_REASON_LEN + " characters");
        }
        textGuard.freeText(reason, "reviews.reject: reason", { bidiMarks: "allow" });
      }
      var ts = _now();
      var existing = (await query("SELECT id, status FROM reviews WHERE id = ?1", [id])).rows[0];
      if (!existing) {
        var err = new Error("reviews.reject: review " + id + " not found");
        err.code = "REVIEW_NOT_FOUND";
        throw err;
      }
      await query(
        "UPDATE reviews SET status = 'rejected', updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      var r = await query("SELECT * FROM reviews WHERE id = ?1", [id]);
      return r.rows[0];
    },

    // Storefront-facing listing. Defaults to published-only so a
    // caller that forgets to pass status doesn't accidentally leak
    // pending / rejected rows. Tuple cursor on (created_at DESC, id
    // DESC) — newest reviews first.
    listForProduct: async function (productId, listOpts) {
      productId = _uuid(productId, "product_id");
      listOpts = listOpts || {};
      var status = listOpts.status === undefined ? "published" : _statusFilter(listOpts.status);
      var limit  = _limit(listOpts.limit);
      var cursorVals = _decodeCursor(listOpts.cursor, REVIEW_ORDER_KEY, "listForProduct");

      var sql, params;
      if (status !== undefined && cursorVals) {
        sql = "SELECT * FROM reviews WHERE product_id = ?1 AND status = ?2 " +
              "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?5";
        params = [productId, status, cursorVals[0], cursorVals[1], limit];
      } else if (status !== undefined) {
        sql = "SELECT * FROM reviews WHERE product_id = ?1 AND status = ?2 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?3";
        params = [productId, status, limit];
      } else if (cursorVals) {
        sql = "SELECT * FROM reviews WHERE product_id = ?1 " +
              "AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?4";
        params = [productId, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM reviews WHERE product_id = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [productId, limit];
      }
      var r = await query(sql, params);
      return { rows: r.rows, next_cursor: _encodeNext(r.rows, REVIEW_ORDER_KEY, limit) };
    },

    // Cross-product moderation listing — every review in one status
    // regardless of product. The moderation queue needs all `pending`
    // rows globally, which listForProduct (per-product) can't serve.
    // status is required here (the queue is always status-scoped). Same
    // (created_at DESC, id DESC) tuple cursor as listForProduct.
    listByStatus: async function (status, listOpts) {
      status = _statusFilter(status);
      if (status === undefined) {
        throw new TypeError("reviews.listByStatus: status is required (one of " + ALLOWED_STATUSES.join(", ") + ")");
      }
      listOpts = listOpts || {};
      var limit  = _limit(listOpts.limit);
      var cursorVals = _decodeCursor(listOpts.cursor, REVIEW_ORDER_KEY, "listByStatus");

      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM reviews WHERE status = ?1 " +
              "AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?4";
        params = [status, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM reviews WHERE status = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [status, limit];
      }
      var r = await query(sql, params);
      return { rows: r.rows, next_cursor: _encodeNext(r.rows, REVIEW_ORDER_KEY, limit) };
    },

    // Aggregate ratings — published-only by construction; counts
    // every star bucket so the storefront can draw the distribution
    // bar chart without a second query.
    summaryForProduct: async function (productId) {
      productId = _uuid(productId, "product_id");
      var r = await query(
        "SELECT rating, COUNT(*) AS n FROM reviews " +
        "WHERE product_id = ?1 AND status = 'published' GROUP BY rating",
        [productId],
      );
      var distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      var count = 0;
      var sum   = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var rating = Number(row.rating);
        var n      = Number(row.n);
        distribution[rating] = n;
        count += n;
        sum   += rating * n;
      }
      var avg = count === 0 ? 0 : sum / count;
      return { count: count, avg_rating: avg, distribution: distribution };
    },

    // Customer's review history, keyed by the hash (never the raw
    // id or email — the caller hashes whatever it has via
    // `hashCustomerId` / `hashCustomerEmail` before calling). Same
    // (created_at DESC, id DESC) cursor shape as listForProduct.
    byCustomer: async function (customerHash, listOpts) {
      if (typeof customerHash !== "string" || !customerHash.length) {
        throw new TypeError("reviews.byCustomer: customer_id_hash must be a non-empty string");
      }
      listOpts = listOpts || {};
      var limit = _limit(listOpts.limit);
      var cursorVals = _decodeCursor(listOpts.cursor, CUSTOMER_ORDER_KEY, "byCustomer");

      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM reviews WHERE customer_id_hash = ?1 " +
              "AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?4";
        params = [customerHash, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM reviews WHERE customer_id_hash = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [customerHash, limit];
      }
      var r = await query(sql, params);
      return { rows: r.rows, next_cursor: _encodeNext(r.rows, CUSTOMER_ORDER_KEY, limit) };
    },
  };
}

module.exports = {
  create:             create,
  CUSTOMER_NAMESPACE: CUSTOMER_NAMESPACE,
  MAX_TITLE_LEN:      MAX_TITLE_LEN,
  MAX_BODY_LEN:       MAX_BODY_LEN,
  MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
};
