"use strict";
/**
 * order-ratings — per-order shipping / packaging / recommend rating
 * primitive. Distinct from `reviews` (per-product star ratings) and
 * `customerSurveys` (NPS / CSAT / CES survey instruments).
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0151.
 *
 * Coverage:
 *   - submitRating shape: persists row, refuses out-of-range / non-
 *     integer ratings, refuses control bytes in comment, refuses
 *     missing fields
 *   - UNIQUE(order_id): second submitRating for the same order_id
 *     refused (primitive-layer code + schema constraint)
 *   - getRating round-trip + comment_html escaped
 *   - ratingsForCustomer ordering (newest first)
 *   - aggregateForPeriod math: mean, count, distribution buckets
 *     seeded for empty windows
 *   - flagComment FSM: refuses second flag, refuses flagging an
 *     empty-comment row, refuses unknown rating_id
 *   - responseToCustomer FSM: one reply per rating; second call refused;
 *     response_html escaped
 *   - topPositive / topNegative ordering across a mixed score set
 *   - listFlagged moderation queue: surfaces every flagged comment
 *     regardless of score (a flagged top-rated row is not hidden),
 *     excludes unflagged rows, honours the optional window + limit
 *   - validation surface: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var orderRatings  = require("../../lib/order-ratings");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_RATINGS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0151_order_ratings.sql");

function _splitSchema(text) {
  // Strip line comments before splitting on `;` so a `--` line
  // doesn't comment out the closing paren of a CREATE TABLE.
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_RATINGS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return {
          rows:      [],
          rowCount:  Number(info.changes),
          lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    rate:  orderRatings.create({ query: h.query }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- submitRating + getRating ------------------------------------------

async function _submitAndGet() {
  var f = _factory();
  var orderId    = _uuid();
  var customerId = _uuid();

  var r = await f.rate.submitRating({
    order_id:         orderId,
    customer_id:      customerId,
    shipping_rating:  5,
    packaging_rating: 4,
    recommend_rating: 5,
    comment:          "Box arrived fast. <script>alert(1)</script>",
  });
  check("submitRating id shape",         typeof r.id === "string" && r.id.length === 36);
  check("submitRating order persisted",  r.order_id === orderId);
  check("submitRating customer",         r.customer_id === customerId);
  check("submitRating shipping",         r.shipping_rating === 5);
  check("submitRating packaging",        r.packaging_rating === 4);
  check("submitRating recommend",        r.recommend_rating === 5);
  check("submitRating comment raw",      r.comment === "Box arrived fast. <script>alert(1)</script>");
  check("submitRating comment escaped",  r.comment_html.indexOf("<script>") === -1
                                          && r.comment_html.indexOf("&lt;script&gt;") !== -1);
  check("submitRating not flagged",      r.comment_flagged === false);
  check("submitRating no flag reason",   r.flag_reason === null);
  check("submitRating no response",      r.response_text === null);
  check("submitRating occurred_at",      typeof r.occurred_at === "number" && r.occurred_at > 0);

  // getRating round-trips.
  var fetched = await f.rate.getRating({ order_id: orderId });
  check("getRating round-trip id",       fetched.id === r.id);
  check("getRating round-trip escape",   fetched.comment_html === r.comment_html);

  // getRating on a missing order returns null (not an error).
  var miss = await f.rate.getRating({ order_id: _uuid() });
  check("getRating unknown order null",  miss === null);

  // Comment omitted is allowed.
  var noCommentOrder = _uuid();
  var rNoComment = await f.rate.submitRating({
    order_id:         noCommentOrder,
    customer_id:      _uuid(),
    shipping_rating:  3,
    packaging_rating: 3,
    recommend_rating: 3,
  });
  check("submitRating no-comment ok",    rNoComment.comment === null && rNoComment.comment_html === null);
}

// ---- rating range refusals + control bytes -----------------------------

async function _submitRefusals() {
  var f = _factory();
  var base = {
    order_id:         _uuid(),
    customer_id:      _uuid(),
    shipping_rating:  3,
    packaging_rating: 3,
    recommend_rating: 3,
  };

  // Rating 0 refused.
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { shipping_rating: 0 })),
    /shipping_rating must be an integer in \[1, 5\]/,
  );
  // Rating 6 refused.
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { packaging_rating: 6 })),
    /packaging_rating must be an integer in \[1, 5\]/,
  );
  // Non-integer refused.
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { recommend_rating: 3.5 })),
    /recommend_rating must be an integer in \[1, 5\]/,
  );
  // String rating refused.
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { shipping_rating: "5" })),
    /shipping_rating must be an integer/,
  );
  // Comment control byte refused.
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { comment: "badbyte" })),
    /comment must not contain control bytes/,
  );
  // Comment too long refused.
  var longStr = new Array(orderRatings.MAX_COMMENT_LEN + 2).join("x");
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { comment: longStr })),
    new RegExp("comment must be <= " + orderRatings.MAX_COMMENT_LEN + " chars"),
  );
  // Bad UUID refused.
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { order_id: "not-a-uuid" })),
    /order_id/,
  );
  await assert.rejects(
    f.rate.submitRating(Object.assign({}, base, { customer_id: "not-a-uuid" })),
    /customer_id/,
  );
}

// ---- UNIQUE(order_id): one rating per order ----------------------------

async function _uniqueOnOrderId() {
  var f = _factory();
  var orderId = _uuid();

  await f.rate.submitRating({
    order_id:         orderId,
    customer_id:      _uuid(),
    shipping_rating:  4,
    packaging_rating: 4,
    recommend_rating: 4,
  });

  // Second submission for the same order_id refused with a stable code.
  await assert.rejects(
    f.rate.submitRating({
      order_id:         orderId,
      customer_id:      _uuid(),
      shipping_rating:  2,
      packaging_rating: 2,
      recommend_rating: 2,
    }),
    function (err) { return err && err.code === "ORDER_RATING_ALREADY_EXISTS"; },
  );

  // Verify the schema UNIQUE is actually present — a direct INSERT
  // bypassing the primitive trips the constraint at the driver layer
  // (belt-and-braces over the primitive-layer pre-check).
  assert.throws(function () {
    f.db.prepare(
      "INSERT INTO order_ratings " +
      "(id, order_id, customer_id, shipping_rating, packaging_rating, recommend_rating, " +
      " comment, comment_flagged, flag_reason, flag_actor, " +
      " response_text, response_actor, response_at, occurred_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?)",
    ).run(_uuid(), orderId, _uuid(), 3, 3, 3, null, Date.now());
  }, /UNIQUE constraint failed/);
}

// ---- ratingsForCustomer ordering ---------------------------------------

async function _ratingsForCustomerOrdering() {
  var f = _factory();
  var customerId = _uuid();
  var ids = [];
  for (var i = 0; i < 4; i += 1) {
    var r = await f.rate.submitRating({
      order_id:         _uuid(),
      customer_id:      customerId,
      shipping_rating:  (i % 5) + 1,
      packaging_rating: ((i + 1) % 5) + 1,
      recommend_rating: ((i + 2) % 5) + 1,
    });
    ids.push(r.id);
  }

  // A rating for a different customer must NOT appear in the list.
  await f.rate.submitRating({
    order_id:         _uuid(),
    customer_id:      _uuid(),
    shipping_rating:  5,
    packaging_rating: 5,
    recommend_rating: 5,
  });

  var list = await f.rate.ratingsForCustomer({ customer_id: customerId });
  check("ratingsForCustomer length",     list.length === 4);
  check("ratingsForCustomer ordering",   list[0].id === ids[3]
                                          && list[1].id === ids[2]
                                          && list[2].id === ids[1]
                                          && list[3].id === ids[0]);

  // limit clamps the list.
  var clamped = await f.rate.ratingsForCustomer({ customer_id: customerId, limit: 2 });
  check("ratingsForCustomer limit",      clamped.length === 2);
}

// ---- aggregateForPeriod math -------------------------------------------

async function _aggregateMath() {
  var f = _factory();
  var fromTs = Date.now() - 1000;

  // Submit 4 ratings with known shape:
  //   shipping:  5, 5, 4, 1   -> sum 15, mean 3.75
  //   packaging: 4, 4, 4, 2   -> sum 14, mean 3.5
  //   recommend: 5, 3, 4, 1   -> sum 13, mean 3.25
  var rows = [
    { s: 5, p: 4, r: 5 },
    { s: 5, p: 4, r: 3 },
    { s: 4, p: 4, r: 4 },
    { s: 1, p: 2, r: 1 },
  ];
  for (var i = 0; i < rows.length; i += 1) {
    await f.rate.submitRating({
      order_id:         _uuid(),
      customer_id:      _uuid(),
      shipping_rating:  rows[i].s,
      packaging_rating: rows[i].p,
      recommend_rating: rows[i].r,
    });
  }

  var toTs = Date.now() + 1000;
  var agg = await f.rate.aggregateForPeriod({ from: fromTs, to: toTs });

  check("aggregate response_count",            agg.response_count === 4);
  check("aggregate shipping count",            agg.shipping.count === 4);
  check("aggregate shipping sum",              agg.shipping.sum === 15);
  check("aggregate shipping mean 3.75",        agg.shipping.mean === 3.75);
  check("aggregate packaging mean 3.5",        agg.packaging.mean === 3.5);
  check("aggregate recommend mean 3.25",       agg.recommend.mean === 3.25);
  check("aggregate shipping dist[5]=2",        agg.shipping.distribution["5"] === 2);
  check("aggregate shipping dist[4]=1",        agg.shipping.distribution["4"] === 1);
  check("aggregate shipping dist[1]=1",        agg.shipping.distribution["1"] === 1);
  check("aggregate shipping dist[3]=0",        agg.shipping.distribution["3"] === 0);

  // Empty window still seeds the per-axis buckets.
  var emptyAgg = await f.rate.aggregateForPeriod({ from: 1, to: 2 });
  check("empty aggregate count 0",             emptyAgg.response_count === 0);
  check("empty aggregate shipping count 0",    emptyAgg.shipping.count === 0);
  check("empty aggregate shipping mean 0",     emptyAgg.shipping.mean === 0);
  check("empty aggregate distribution seeded", emptyAgg.shipping.distribution["1"] === 0
                                                && emptyAgg.shipping.distribution["5"] === 0);
}

// ---- flagComment + responseToCustomer ----------------------------------

async function _flagAndRespond() {
  var f = _factory();
  var actorId = _uuid();
  var r = await f.rate.submitRating({
    order_id:         _uuid(),
    customer_id:      _uuid(),
    shipping_rating:  2,
    packaging_rating: 2,
    recommend_rating: 1,
    comment:          "Box smelled funny.",
  });

  // flagComment marks + persists the reason / actor.
  var flagged = await f.rate.flagComment({
    rating_id:   r.id,
    reason:      "Off-topic complaint about scent.",
    flagged_by:  actorId,
  });
  check("flagComment marks flagged",     flagged.comment_flagged === true);
  check("flagComment persists reason",   flagged.flag_reason === "Off-topic complaint about scent.");
  check("flagComment persists actor",    flagged.flag_actor === actorId);

  // Second flag refused.
  await assert.rejects(
    f.rate.flagComment({ rating_id: r.id, reason: "again", flagged_by: actorId }),
    function (err) { return err && err.code === "ORDER_RATING_ALREADY_FLAGGED"; },
  );

  // flagComment on an empty-comment row refused.
  var r2 = await f.rate.submitRating({
    order_id:         _uuid(),
    customer_id:      _uuid(),
    shipping_rating:  3,
    packaging_rating: 3,
    recommend_rating: 3,
  });
  await assert.rejects(
    f.rate.flagComment({ rating_id: r2.id, reason: "x", flagged_by: actorId }),
    function (err) { return err && err.code === "ORDER_RATING_NO_COMMENT"; },
  );

  // flagComment on unknown rating_id refused.
  await assert.rejects(
    f.rate.flagComment({ rating_id: _uuid(), reason: "x", flagged_by: actorId }),
    function (err) { return err && err.code === "ORDER_RATING_NOT_FOUND"; },
  );

  // responseToCustomer first call lands.
  var responded = await f.rate.responseToCustomer({
    rating_id:    r.id,
    response:     "Thanks — we'll talk to <our> packaging vendor.",
    responded_by: actorId,
  });
  check("responseToCustomer text raw",       responded.response_text === "Thanks — we'll talk to <our> packaging vendor.");
  check("responseToCustomer text escaped",   responded.response_html.indexOf("<our>") === -1
                                              && responded.response_html.indexOf("&lt;our&gt;") !== -1);
  check("responseToCustomer actor persisted", responded.response_actor === actorId);
  check("responseToCustomer ts set",         typeof responded.response_at === "number");

  // Second response refused.
  await assert.rejects(
    f.rate.responseToCustomer({ rating_id: r.id, response: "again", responded_by: actorId }),
    function (err) { return err && err.code === "ORDER_RATING_ALREADY_RESPONDED"; },
  );

  // responseToCustomer on unknown rating refused.
  await assert.rejects(
    f.rate.responseToCustomer({ rating_id: _uuid(), response: "x", responded_by: actorId }),
    function (err) { return err && err.code === "ORDER_RATING_NOT_FOUND"; },
  );
}

// ---- topPositive / topNegative ordering --------------------------------

async function _topRatings() {
  var f = _factory();
  var fromTs = Date.now() - 1000;

  // Submit five ratings with distinct sums:
  //   A: 5+5+5 = 15
  //   B: 4+5+4 = 13
  //   C: 3+3+3 = 9
  //   D: 2+1+2 = 5
  //   E: 1+1+1 = 3
  var rows = [
    { label: "A", s: 5, p: 5, r: 5 },
    { label: "B", s: 4, p: 5, r: 4 },
    { label: "C", s: 3, p: 3, r: 3 },
    { label: "D", s: 2, p: 1, r: 2 },
    { label: "E", s: 1, p: 1, r: 1 },
  ];
  var labelToId = {};
  for (var i = 0; i < rows.length; i += 1) {
    var r = await f.rate.submitRating({
      order_id:         _uuid(),
      customer_id:      _uuid(),
      shipping_rating:  rows[i].s,
      packaging_rating: rows[i].p,
      recommend_rating: rows[i].r,
    });
    labelToId[rows[i].label] = r.id;
  }
  var toTs = Date.now() + 1000;

  var top = await f.rate.topPositiveRatings({ from: fromTs, to: toTs, limit: 3 });
  check("topPositive length 3",                top.length === 3);
  check("topPositive[0] is A (sum 15)",        top[0].id === labelToId.A);
  check("topPositive[1] is B (sum 13)",        top[1].id === labelToId.B);
  check("topPositive[2] is C (sum 9)",         top[2].id === labelToId.C);

  var bottom = await f.rate.topNegativeRatings({ from: fromTs, to: toTs, limit: 3 });
  check("topNegative length 3",                bottom.length === 3);
  check("topNegative[0] is E (sum 3)",         bottom[0].id === labelToId.E);
  check("topNegative[1] is D (sum 5)",         bottom[1].id === labelToId.D);
  check("topNegative[2] is C (sum 9)",         bottom[2].id === labelToId.C);

  // Empty window — both top queries return [].
  var emptyTop = await f.rate.topPositiveRatings({ from: 1, to: 2, limit: 5 });
  check("topPositive empty window",            Array.isArray(emptyTop) && emptyTop.length === 0);
  var emptyBot = await f.rate.topNegativeRatings({ from: 1, to: 2, limit: 5 });
  check("topNegative empty window",            Array.isArray(emptyBot) && emptyBot.length === 0);
}

// ---- listFlagged (moderation queue) ------------------------------------

async function _listFlagged() {
  var f = _factory();
  var actorId = _uuid();

  // A flagged comment on a TOP-scoring rating (5/5/5) — exactly the case a
  // score-capped "lowest-scored" list would hide. listFlagged must surface
  // it so the moderation queue is never blind to a flagged high rating.
  var hi = await f.rate.submitRating({
    order_id: _uuid(), customer_id: _uuid(),
    shipping_rating: 5, packaging_rating: 5, recommend_rating: 5,
    comment: "Perfect delivery, but the note was abusive.",
  });
  await f.rate.flagComment({ rating_id: hi.id, reason: "Abusive note.", flagged_by: actorId });

  // A flagged comment on a low-scoring rating (carries an XSS payload).
  var lo = await f.rate.submitRating({
    order_id: _uuid(), customer_id: _uuid(),
    shipping_rating: 1, packaging_rating: 1, recommend_rating: 2,
    comment: "Terrible. <script>x</script>",
  });
  await f.rate.flagComment({ rating_id: lo.id, reason: "Spam.", flagged_by: actorId });

  // An UNFLAGGED rating with a comment — must NOT appear in the queue.
  await f.rate.submitRating({
    order_id: _uuid(), customer_id: _uuid(),
    shipping_rating: 3, packaging_rating: 3, recommend_rating: 3,
    comment: "It was fine.",
  });

  var flagged = await f.rate.listFlagged();
  var ids = flagged.map(function (r) { return r.id; });
  check("listFlagged returns both flagged",        flagged.length === 2);
  check("listFlagged includes the high-score row", ids.indexOf(hi.id) !== -1);
  check("listFlagged includes the low-score row",  ids.indexOf(lo.id) !== -1);
  check("listFlagged every row is flagged",        flagged.every(function (r) { return r.comment_flagged === true; }));
  check("listFlagged exposes escaped comment",     flagged.every(function (r) { return r.comment_html.indexOf("<script>") === -1; }));

  // Window filter: a window far in the past excludes everything; a window
  // covering now includes both flagged rows.
  var none = await f.rate.listFlagged({ from: 1, to: 2 });
  check("listFlagged past window empty",           Array.isArray(none) && none.length === 0);
  var now = Date.now();
  var inWin = await f.rate.listFlagged({ from: now - 60000, to: now + 60000 });
  check("listFlagged current window both",         inWin.length === 2);

  // limit clamps the queue.
  var one = await f.rate.listFlagged({ limit: 1 });
  check("listFlagged limit clamps",                one.length === 1);

  // Validation: inverted window + bad limit refused.
  await assert.rejects(f.rate.listFlagged({ from: 200, to: 100 }), /from must be <= to/);
  await assert.rejects(f.rate.listFlagged({ limit: 0 }),           /limit/);
}

// ---- validation surface ------------------------------------------------

async function _validationSurface() {
  var f = _factory();

  // submitRating
  await assert.rejects(f.rate.submitRating(),                                       /input object required/);
  await assert.rejects(f.rate.submitRating({}),                                     /order_id/);
  await assert.rejects(f.rate.submitRating({ order_id: _uuid() }),                  /customer_id/);
  await assert.rejects(f.rate.submitRating({
    order_id: _uuid(), customer_id: _uuid(),
  }), /shipping_rating/);

  // getRating
  await assert.rejects(f.rate.getRating(),                                          /input object required/);
  await assert.rejects(f.rate.getRating({ order_id: "not-a-uuid" }),                /order_id/);

  // ratingsForCustomer
  await assert.rejects(f.rate.ratingsForCustomer(),                                 /input object required/);
  await assert.rejects(f.rate.ratingsForCustomer({ customer_id: "x" }),             /customer_id/);
  await assert.rejects(f.rate.ratingsForCustomer({ customer_id: _uuid(), limit: 0 }), /limit/);

  // aggregateForPeriod
  await assert.rejects(f.rate.aggregateForPeriod(),                                 /input object required/);
  await assert.rejects(f.rate.aggregateForPeriod({ from: 100 }),                    /to/);
  await assert.rejects(f.rate.aggregateForPeriod({ from: 200, to: 100 }),           /from must be <= to/);

  // flagComment
  await assert.rejects(f.rate.flagComment(),                                        /input object required/);
  await assert.rejects(f.rate.flagComment({ rating_id: "x", reason: "r", flagged_by: _uuid() }), /rating_id/);
  await assert.rejects(f.rate.flagComment({ rating_id: _uuid(), reason: "", flagged_by: _uuid() }), /reason/);
  await assert.rejects(f.rate.flagComment({ rating_id: _uuid(), reason: "r", flagged_by: "x" }), /flagged_by/);

  // responseToCustomer
  await assert.rejects(f.rate.responseToCustomer(),                                 /input object required/);
  await assert.rejects(f.rate.responseToCustomer({ rating_id: "x", response: "r", responded_by: _uuid() }), /rating_id/);
  await assert.rejects(f.rate.responseToCustomer({ rating_id: _uuid(), response: "", responded_by: _uuid() }), /response/);
  await assert.rejects(f.rate.responseToCustomer({ rating_id: _uuid(), response: "r", responded_by: "x" }), /responded_by/);

  // topPositive / topNegative
  await assert.rejects(f.rate.topPositiveRatings(),                                 /input object required/);
  await assert.rejects(f.rate.topPositiveRatings({ from: 200, to: 100 }),           /from must be <= to/);
  await assert.rejects(f.rate.topPositiveRatings({ from: 1, to: 2, limit: 0 }),     /limit/);
  await assert.rejects(f.rate.topNegativeRatings(),                                 /input object required/);
  await assert.rejects(f.rate.topNegativeRatings({ from: 200, to: 100 }),           /from must be <= to/);
}

// ---- exported constants ------------------------------------------------

async function _exportedConstants() {
  check("RATING_AXES exported",          Array.isArray(orderRatings.RATING_AXES)
                                          && orderRatings.RATING_AXES.indexOf("shipping") !== -1
                                          && orderRatings.RATING_AXES.indexOf("packaging") !== -1
                                          && orderRatings.RATING_AXES.indexOf("recommend") !== -1);
  check("MIN_RATING exported",           orderRatings.MIN_RATING === 1);
  check("MAX_RATING exported",           orderRatings.MAX_RATING === 5);
  check("MAX_COMMENT_LEN exported",      orderRatings.MAX_COMMENT_LEN > 0);
  check("MAX_FLAG_REASON_LEN exported",  orderRatings.MAX_FLAG_REASON_LEN > 0);
  check("MAX_RESPONSE_LEN exported",     orderRatings.MAX_RESPONSE_LEN > 0);

  var inst = orderRatings.create({ query: _makeQuery().query });
  check("instance exposes RATING_AXES",  inst.RATING_AXES.length === orderRatings.RATING_AXES.length);
}

async function run() {
  await _submitAndGet();
  await _submitRefusals();
  await _uniqueOnOrderId();
  await _ratingsForCustomerOrdering();
  await _aggregateMath();
  await _flagAndRespond();
  await _topRatings();
  await _listFlagged();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - order-ratings (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
