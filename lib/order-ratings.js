"use strict";
/**
 * @module shop.orderRatings
 * @title  Per-order rating primitive — shipping / packaging /
 *         recommend-to-friend feedback against a single order.
 *
 * @intro
 *   A focused feedback row tied to one order. Distinct from `reviews`
 *   (per-product star ratings) and from `customerSurveys` (NPS / CSAT
 *   / CES survey instruments with multi-question shapes). The
 *   primitive answers one question per order:
 *
 *     "How did the customer rate the shipping, packaging, and
 *      likelihood to recommend us — and did they leave a comment that
 *      needs moderation or a public operator reply?"
 *
 *   Surface:
 *     - `submitRating({ order_id, customer_id, shipping_rating,
 *                       packaging_rating, recommend_rating, comment? })`
 *         Creates the rating row. Refuses ratings outside [1, 5],
 *         refuses control bytes in the comment, refuses a duplicate
 *         submission for the same order_id (one rating per order;
 *         enforced both by the UNIQUE constraint and by a primitive-
 *         layer pre-insert check so the error surfaces with a stable
 *         shape).
 *     - `getRating({ order_id })`
 *         Returns the rating row keyed by order_id, or null when the
 *         order has no rating yet. Renders the comment HTML-escaped
 *         via `b.template.escapeHtml` so callers that splice the
 *         rendered field into a template can't introduce script
 *         content from the customer-supplied string.
 *     - `ratingsForCustomer({ customer_id })`
 *         Lists every rating a customer has left, newest first.
 *     - `aggregateForPeriod({ from, to })`
 *         Returns the per-rating-axis mean + count + distribution
 *         buckets across the [from, to] window. Empty window returns
 *         zeroed buckets so the operator can distinguish "no
 *         ratings" from "low ratings."
 *     - `flagComment({ rating_id, reason, flagged_by })`
 *         Operator-side moderation: marks a comment as flagged so
 *         storefront renderers can suppress it. Refused when the
 *         comment is already flagged (operators clear-and-re-flag
 *         when the reason changes; the primitive doesn't silently
 *         overwrite). Refused when the rating row has no comment in
 *         the first place — flagging an empty string is a smell.
 *     - `responseToCustomer({ rating_id, response, responded_by })`
 *         Operator's public reply to the rating. One reply per
 *         rating; refused on second call. The reply renders HTML-
 *         escaped alongside the comment.
 *     - `topPositiveRatings({ from, to, limit })`
 *         Highest-scoring ratings (sum of the three axes) in the
 *         window, ordered (score DESC, occurred_at DESC, id DESC).
 *     - `topNegativeRatings({ from, to, limit })`
 *         Inverse of topPositive — lowest-scoring ratings first.
 *
 *   Comment rendering: `getRating` exposes both the raw `comment`
 *   field and `comment_html` (the HTML-escaped form). Templates
 *   splicing the rendered field don't have to remember to escape;
 *   templates that need the raw text (export, analytics) read
 *   `comment`. Same shape for `response_text` / `response_html`.
 *
 *   Composes:
 *     - `b.guardUuid`             — UUID-shape validation for
 *                                   order_id / customer_id / actor /
 *                                   rating_id.
 *     - `b.uuid.v7`               — row id (lexicographic monotonic so
 *                                   audit reads sort cleanly).
 *     - `b.template.escapeHtml`   — comment + response render layer.
 *
 *   Storage: `migrations-d1/0151_order_ratings.sql`.
 *
 * @primitive orderRatings
 * @related   reviews, customerSurveys, b.template.escapeHtml
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var MIN_RATING            = 1;
var MAX_RATING            = 5;
var RATING_AXES           = Object.freeze(["shipping", "packaging", "recommend"]);
var MAX_COMMENT_LEN       = 2000;
var MAX_FLAG_REASON_LEN   = 500;
var MAX_RESPONSE_LEN      = 2000;
var DEFAULT_LIST_LIMIT    = 50;
var MAX_LIST_LIMIT        = 500;
var DEFAULT_TOP_LIMIT     = 10;
var MAX_TOP_LIMIT         = 100;

var CONTROL_BYTE_RE       = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// ---- monotonic clock ----------------------------------------------------
//
// Submissions persist epoch-ms timestamps. Two same-millisecond
// `_now()` calls produce distinct integers so the row-ordering on
// `occurred_at` is deterministic without an extra tiebreaker column.
// Tests that submit ratings in tight loops rely on this for ordering
// assertions (topPositive / topNegative tiebreakers fall back to
// occurred_at DESC, then id DESC).
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("orderRatings: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _rating(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_RATING || n > MAX_RATING) {
    throw new TypeError("orderRatings: " + label +
                        " must be an integer in [" + MIN_RATING + ", " + MAX_RATING + "]");
  }
  return n;
}

function _comment(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("orderRatings: comment must be a string when provided");
  }
  if (!s.length) return null;
  if (s.length > MAX_COMMENT_LEN) {
    throw new TypeError("orderRatings: comment must be <= " + MAX_COMMENT_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("orderRatings: comment must not contain control bytes");
  }
  return s;
}

function _flagReason(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_FLAG_REASON_LEN) {
    throw new TypeError("orderRatings: reason must be a non-empty string <= " + MAX_FLAG_REASON_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("orderRatings: reason must not contain control bytes");
  }
  return s;
}

function _responseText(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_RESPONSE_LEN) {
    throw new TypeError("orderRatings: response must be a non-empty string <= " + MAX_RESPONSE_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("orderRatings: response must not contain control bytes");
  }
  return s;
}

function _epoch(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("orderRatings: " + label + " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _limit(n, defaultN, maxN, label) {
  if (n == null) return defaultN;
  if (!Number.isInteger(n) || n <= 0 || n > maxN) {
    throw new TypeError("orderRatings: " + label + " must be an integer in [1, " + maxN + "]");
  }
  return n;
}

// ---- render helpers -----------------------------------------------------

function _esc(s) {
  if (s == null) return null;
  return b.template.escapeHtml(s);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  function _decode(row) {
    if (!row) return null;
    return {
      id:               row.id,
      order_id:         row.order_id,
      customer_id:      row.customer_id,
      shipping_rating:  Number(row.shipping_rating),
      packaging_rating: Number(row.packaging_rating),
      recommend_rating: Number(row.recommend_rating),
      comment:          row.comment == null ? null : row.comment,
      comment_html:     row.comment == null ? null : _esc(row.comment),
      comment_flagged:  row.comment_flagged === 1 || row.comment_flagged === true,
      flag_reason:      row.flag_reason == null ? null : row.flag_reason,
      flag_actor:       row.flag_actor  == null ? null : row.flag_actor,
      response_text:    row.response_text == null ? null : row.response_text,
      response_html:    row.response_text == null ? null : _esc(row.response_text),
      response_actor:   row.response_actor == null ? null : row.response_actor,
      response_at:      row.response_at   == null ? null : Number(row.response_at),
      occurred_at:      Number(row.occurred_at),
    };
  }

  async function _rowById(id) {
    var r = await query("SELECT * FROM order_ratings WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _rowByOrder(orderId) {
    var r = await query("SELECT * FROM order_ratings WHERE order_id = ?1", [orderId]);
    return r.rows[0] || null;
  }

  // ---- submitRating ----------------------------------------------------

  async function submitRating(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderRatings.submitRating: input object required");
    }
    var orderId    = _uuid(input.order_id,    "order_id");
    var customerId = _uuid(input.customer_id, "customer_id");
    var shipping   = _rating(input.shipping_rating,  "shipping_rating");
    var packaging  = _rating(input.packaging_rating, "packaging_rating");
    var recommend  = _rating(input.recommend_rating, "recommend_rating");
    var comment    = _comment(input.comment);

    // Pre-insert duplicate check so a second submission surfaces a
    // typed error with a stable code rather than a UNIQUE-constraint
    // SQLite error message that varies across drivers. The schema
    // UNIQUE is the second line of defense — a race that slips past
    // this check still trips the constraint and the caller gets the
    // driver-level error.
    var existing = await _rowByOrder(orderId);
    if (existing) {
      var dupe = new Error("orderRatings.submitRating: order " + JSON.stringify(orderId) +
                            " already has a rating");
      dupe.code = "ORDER_RATING_ALREADY_EXISTS";
      throw dupe;
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO order_ratings " +
      "(id, order_id, customer_id, shipping_rating, packaging_rating, recommend_rating, " +
      " comment, comment_flagged, flag_reason, flag_actor, " +
      " response_text, response_actor, response_at, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, NULL, NULL, NULL, NULL, ?8)",
      [id, orderId, customerId, shipping, packaging, recommend, comment, ts],
    );
    return _decode(await _rowById(id));
  }

  // ---- getRating -------------------------------------------------------

  async function getRating(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderRatings.getRating: input object required");
    }
    var orderId = _uuid(input.order_id, "order_id");
    return _decode(await _rowByOrder(orderId));
  }

  // ---- ratingsForCustomer ----------------------------------------------

  async function ratingsForCustomer(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderRatings.ratingsForCustomer: input object required");
    }
    var customerId = _uuid(input.customer_id, "customer_id");
    var limit      = _limit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, "limit");
    var r = await query(
      "SELECT * FROM order_ratings WHERE customer_id = ?1 " +
      "ORDER BY occurred_at DESC, id DESC LIMIT ?2",
      [customerId, limit],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decode(r.rows[i]));
    return out;
  }

  // ---- aggregateForPeriod ----------------------------------------------

  async function aggregateForPeriod(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderRatings.aggregateForPeriod: input object required");
    }
    var from = _epoch(input.from, "from");
    var to   = _epoch(input.to,   "to");
    if (from > to) {
      throw new TypeError("orderRatings.aggregateForPeriod: from must be <= to");
    }

    var r = await query(
      "SELECT shipping_rating, packaging_rating, recommend_rating " +
      "FROM order_ratings WHERE occurred_at >= ?1 AND occurred_at <= ?2",
      [from, to],
    );

    // Seed bucket shapes from RATING_AXES so the rollup always carries
    // every axis even when the window is empty — operators rendering
    // a dashboard get the same column list regardless of traffic.
    var axes = {};
    for (var a = 0; a < RATING_AXES.length; a += 1) {
      var axisLabel = RATING_AXES[a];
      var dist = {};
      for (var v = MIN_RATING; v <= MAX_RATING; v += 1) dist[String(v)] = 0;
      axes[axisLabel] = { count: 0, sum: 0, mean: 0, distribution: dist };
    }

    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      _accumulate(axes.shipping,  Number(row.shipping_rating));
      _accumulate(axes.packaging, Number(row.packaging_rating));
      _accumulate(axes.recommend, Number(row.recommend_rating));
    }

    for (var b = 0; b < RATING_AXES.length; b += 1) {
      var bucket = axes[RATING_AXES[b]];
      if (bucket.count > 0) {
        // Mean rounded to 2 decimals — operator-facing display
        // precision. Sum + count are also exposed so a caller that
        // wants more precision can recompute.
        bucket.mean = Math.round((bucket.sum / bucket.count) * 100) / 100;
      }
    }

    return {
      from:           from,
      to:             to,
      response_count: r.rows.length,
      shipping:       axes.shipping,
      packaging:      axes.packaging,
      recommend:      axes.recommend,
    };
  }

  // ---- flagComment -----------------------------------------------------

  async function flagComment(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderRatings.flagComment: input object required");
    }
    var ratingId  = _uuid(input.rating_id,  "rating_id");
    var reason    = _flagReason(input.reason);
    var flaggedBy = _uuid(input.flagged_by, "flagged_by");

    var row = await _rowById(ratingId);
    if (!row) {
      var miss = new Error("orderRatings.flagComment: rating not found");
      miss.code = "ORDER_RATING_NOT_FOUND";
      throw miss;
    }
    if (row.comment == null) {
      // Flagging an empty-comment rating is a smell — operators flag
      // text, not the absence of text. Refuse so a UI bug that calls
      // flagComment without checking the row first surfaces here.
      var noComment = new Error("orderRatings.flagComment: rating has no comment to flag");
      noComment.code = "ORDER_RATING_NO_COMMENT";
      throw noComment;
    }
    if (row.comment_flagged === 1 || row.comment_flagged === true) {
      var already = new Error("orderRatings.flagComment: comment already flagged");
      already.code = "ORDER_RATING_ALREADY_FLAGGED";
      throw already;
    }
    await query(
      "UPDATE order_ratings SET comment_flagged = 1, flag_reason = ?1, flag_actor = ?2 " +
      "WHERE id = ?3",
      [reason, flaggedBy, ratingId],
    );
    return _decode(await _rowById(ratingId));
  }

  // ---- responseToCustomer ----------------------------------------------

  async function responseToCustomer(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderRatings.responseToCustomer: input object required");
    }
    var ratingId    = _uuid(input.rating_id,    "rating_id");
    var response    = _responseText(input.response);
    var respondedBy = _uuid(input.responded_by, "responded_by");

    var row = await _rowById(ratingId);
    if (!row) {
      var miss = new Error("orderRatings.responseToCustomer: rating not found");
      miss.code = "ORDER_RATING_NOT_FOUND";
      throw miss;
    }
    if (row.response_text != null) {
      // One operator reply per rating. A second call could be an
      // edit; the primitive doesn't expose that path because the
      // public reply is part of the storefront-visible audit trail
      // and silent rewrites would obscure it. An operator who needs
      // to revise composes a clear-and-rewrite path through the
      // admin surface.
      var already = new Error("orderRatings.responseToCustomer: rating already has a response");
      already.code = "ORDER_RATING_ALREADY_RESPONDED";
      throw already;
    }
    var ts = _now();
    await query(
      "UPDATE order_ratings SET response_text = ?1, response_actor = ?2, response_at = ?3 " +
      "WHERE id = ?4",
      [response, respondedBy, ts, ratingId],
    );
    return _decode(await _rowById(ratingId));
  }

  // ---- topPositive / topNegative ---------------------------------------

  async function _topRatings(input, label, direction) {
    if (!input || typeof input !== "object") {
      throw new TypeError("orderRatings." + label + ": input object required");
    }
    var from  = _epoch(input.from, "from");
    var to    = _epoch(input.to,   "to");
    if (from > to) {
      throw new TypeError("orderRatings." + label + ": from must be <= to");
    }
    var limit = _limit(input.limit, DEFAULT_TOP_LIMIT, MAX_TOP_LIMIT, "limit");

    // Sum of the three axes is the score. DESC for top-positive,
    // ASC for top-negative. Secondary order on occurred_at DESC so
    // the most recent rating wins ties; tertiary on id DESC for total
    // ordering across same-millisecond submissions.
    var orderClause = direction === "positive"
      ? "ORDER BY (shipping_rating + packaging_rating + recommend_rating) DESC, occurred_at DESC, id DESC"
      : "ORDER BY (shipping_rating + packaging_rating + recommend_rating) ASC,  occurred_at DESC, id DESC";

    var r = await query(
      "SELECT * FROM order_ratings WHERE occurred_at >= ?1 AND occurred_at <= ?2 " +
      orderClause + " LIMIT ?3",
      [from, to, limit],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decode(r.rows[i]));
    return out;
  }

  async function topPositiveRatings(input) {
    return _topRatings(input, "topPositiveRatings", "positive");
  }

  async function topNegativeRatings(input) {
    return _topRatings(input, "topNegativeRatings", "negative");
  }

  // ---- listFlagged -----------------------------------------------------

  // The moderation queue: every rating whose comment an operator has
  // flagged, most-recent-first, backed by the (comment_flagged,
  // occurred_at) index. Unlike topNegativeRatings (score-ordered, capped
  // at MAX_TOP_LIMIT), this surfaces ALL flagged comments regardless of
  // their score — so a flagged comment on an otherwise high rating is
  // never hidden behind the score cap. The from/to window is optional and
  // applied only when supplied; the row count is capped by `limit`.
  async function listFlagged(input) {
    input = (input && typeof input === "object") ? input : {};
    var limit = _limit(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, "limit");

    var sql = "SELECT * FROM order_ratings WHERE comment_flagged = 1";
    var params = [];
    if (input.from != null || input.to != null) {
      var from = _epoch(input.from, "from");
      var to   = _epoch(input.to,   "to");
      if (from > to) {
        throw new TypeError("orderRatings.listFlagged: from must be <= to");
      }
      params.push(from);
      sql += " AND occurred_at >= ?" + params.length;
      params.push(to);
      sql += " AND occurred_at <= ?" + params.length;
    }
    params.push(limit);
    sql += " ORDER BY occurred_at DESC, id DESC LIMIT ?" + params.length;

    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decode(r.rows[i]));
    return out;
  }

  return {
    RATING_AXES:           RATING_AXES.slice(),
    MIN_RATING:            MIN_RATING,
    MAX_RATING:            MAX_RATING,
    MAX_COMMENT_LEN:       MAX_COMMENT_LEN,
    MAX_FLAG_REASON_LEN:   MAX_FLAG_REASON_LEN,
    MAX_RESPONSE_LEN:      MAX_RESPONSE_LEN,

    submitRating:          submitRating,
    getRating:             getRating,
    ratingsForCustomer:    ratingsForCustomer,
    aggregateForPeriod:    aggregateForPeriod,
    flagComment:           flagComment,
    responseToCustomer:    responseToCustomer,
    topPositiveRatings:    topPositiveRatings,
    topNegativeRatings:    topNegativeRatings,
    listFlagged:           listFlagged,
  };
}

function _accumulate(bucket, val) {
  bucket.count += 1;
  bucket.sum   += val;
  bucket.distribution[String(val)] = (bucket.distribution[String(val)] || 0) + 1;
}

module.exports = {
  create:                  create,
  RATING_AXES:             RATING_AXES,
  MIN_RATING:              MIN_RATING,
  MAX_RATING:              MAX_RATING,
  MAX_COMMENT_LEN:         MAX_COMMENT_LEN,
  MAX_FLAG_REASON_LEN:     MAX_FLAG_REASON_LEN,
  MAX_RESPONSE_LEN:        MAX_RESPONSE_LEN,
};
