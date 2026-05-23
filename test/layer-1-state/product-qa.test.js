"use strict";
/**
 * productQA — PDP-attached customer questions + operator/customer
 * answers, distinct from the rating-based reviews primitive.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001_catalog.sql (products FK) + 0133_product_qa.sql.
 *
 * Direct require of `lib/product-qa.js` — the primitive isn't wired
 * into `lib/index.js` yet; the test gate exists ahead of the entry-
 * point edit (same posture as plan-changes.test.js and
 * storefront-dashboards.test.js).
 *
 * Coverage:
 *   - submitQuestion: persists pending row for customer_id branch
 *     and customer_email branch; email branch leaves customer_id
 *     NULL and stores only the namespace hash. Bad inputs refused
 *     (missing both ids, oversize body, control-byte body, bad
 *     UUID, bad email).
 *   - moderation FSM: approveQuestion + rejectQuestion + approveAnswer
 *     + rejectAnswer; rejected->approved transition refused; rejecting
 *     a pinned answer auto-clears its pin.
 *   - submitAnswer: enforces parent-question existence, author enum,
 *     and the (author, is_operator) consistency gate.
 *   - voteUpAnswer: first vote bumps vote_count + writes the dedup
 *     row; repeat tap from the same session is a no-op; distinct
 *     sessions each count.
 *   - pinAnswer: refuses non-operator answers, refuses non-approved
 *     answers, and auto-unpins a prior pin on the same question
 *     (partial unique index never trips).
 *   - questionsForProduct: defaults to approved-only, paginates via
 *     opaque cursor, returns newest-first.
 *   - metricsForProduct: counts pending / approved / rejected
 *     questions, answered questions, total answers + upvotes.
 *   - cleanupRejected: reclaims rejected questions + answers older
 *     than the retention window; non-rejected rows are untouched.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop     = require("../../lib");
var productQA = require("../../lib/product-qa");
var helpers   = require("../helpers");
var check     = helpers.check;
var assert    = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0133_product_qa.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
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
  };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

async function _seedProduct(query, opts) {
  opts = opts || {};
  var id = opts.id || _validUUID();
  var ts = Date.now();
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)",
    [id, opts.slug || "p-" + id.slice(0, 8), opts.title || "Test Product", "", ts],
  );
  return id;
}

async function _setup() {
  var query     = _makeQuery();
  var productId = await _seedProduct(query);
  var qa        = productQA.create({ query: query });
  return { query: query, productId: productId, qa: qa };
}

// ---- 1. submitQuestion: both author branches + validation ---------------

async function _submitQuestion() {
  var ctx = await _setup();

  // customer_id branch
  var custId = _validUUID();
  var q1 = await ctx.qa.submitQuestion({
    product_id:  ctx.productId,
    customer_id: custId,
    body:        "Does this run on Node 24?",
  });
  check("submitQuestion returns row",                q1 && q1.id);
  check("submitQuestion stamps pending",             q1.status === "pending");
  check("submitQuestion stamps product_id",          q1.product_id === ctx.productId);
  check("submitQuestion stores customer_id",         q1.customer_id === custId);
  check("submitQuestion no email hash on id branch", q1.customer_email_hash == null);

  // customer_email branch
  var q2 = await ctx.qa.submitQuestion({
    product_id:     ctx.productId,
    customer_email: "Buyer@Example.COM",
    body:           "What's the warranty?",
  });
  check("email branch leaves customer_id NULL",      q2.customer_id == null);
  check("email branch persists hash, not raw",
        typeof q2.customer_email_hash === "string" &&
        q2.customer_email_hash.length === 128 &&
        q2.customer_email_hash.indexOf("buyer") === -1);

  // Case-variant collapses to same hash.
  var q3 = await ctx.qa.submitQuestion({
    product_id:     ctx.productId,
    customer_email: "buyer@example.com",
    body:           "Asking again",
  });
  check("email casing variants share hash",
        q3.customer_email_hash === q2.customer_email_hash);

  // Validation failures.
  await assert.rejects(ctx.qa.submitQuestion(),                                          /input object required/);
  await assert.rejects(ctx.qa.submitQuestion({}),                                         /product_id/);
  await assert.rejects(ctx.qa.submitQuestion({ product_id: "not-a-uuid", body: "x" }),    /product_id/);
  await assert.rejects(ctx.qa.submitQuestion({
    product_id: ctx.productId, body: "x",
  }),                                                                                    /customer_id or customer_email/);
  await assert.rejects(ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_id: custId, body: "",
  }),                                                                                    /body/);
  await assert.rejects(ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_id: custId, body: "x".repeat(4001),
  }),                                                                                    /body/);
  await assert.rejects(ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_id: custId, body: "bad\x00body",
  }),                                                                                    /body/);
  await assert.rejects(ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "not-an-email", body: "x",
  }),                                                                                    /customer_email/);
}

// ---- 2. moderation FSM + reject clears pin ------------------------------

async function _moderation() {
  var ctx = await _setup();
  var custId = _validUUID();
  var q = await ctx.qa.submitQuestion({
    product_id:  ctx.productId,
    customer_id: custId,
    body:        "Is this in stock?",
  });
  var approved = await ctx.qa.approveQuestion(q.id);
  check("approveQuestion flips status",      approved.status === "approved");
  // Idempotent re-approve.
  var reApproved = await ctx.qa.approveQuestion(q.id);
  check("approveQuestion idempotent",        reApproved.status === "approved");

  var q2 = await ctx.qa.submitQuestion({
    product_id:  ctx.productId,
    customer_id: custId,
    body:        "Spam payload",
  });
  var rejected = await ctx.qa.rejectQuestion(q2.id, "off-topic");
  check("rejectQuestion flips status",       rejected.status === "rejected");

  // Rejected -> approved refused.
  await assert.rejects(ctx.qa.approveQuestion(q2.id), /cannot approve a rejected question/);

  // Not-found surface.
  await assert.rejects(ctx.qa.approveQuestion(_validUUID()), /not found/);
  await assert.rejects(ctx.qa.rejectQuestion(_validUUID()),  /not found/);
  await assert.rejects(ctx.qa.approveQuestion("not-a-uuid"), /question_id/);

  // Submit + approve an operator answer; pin it; reject -> pin clears.
  var a = await ctx.qa.submitAnswer({
    question_id: q.id,
    author:      "operator",
    body:        "Yes, in stock.",
  });
  await ctx.qa.approveAnswer(a.id);
  var pinned = await ctx.qa.pinAnswer(a.id);
  check("pinAnswer sets pinned=1",           pinned.pinned === 1);
  var unpinViaReject = await ctx.qa.rejectAnswer(a.id, "withdrawn");
  check("rejectAnswer flips status",         unpinViaReject.status === "rejected");
  check("rejectAnswer clears pin",           unpinViaReject.pinned === 0);

  // Reason length cap + control-byte guard.
  var q3 = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "x@example.com", body: "ok",
  });
  await assert.rejects(ctx.qa.rejectQuestion(q3.id, "x".repeat(501)), /reason/);
  await assert.rejects(ctx.qa.rejectQuestion(q3.id, "bad\x01reason"), /reason/);
}

// ---- 3. submitAnswer FSM + author/operator gate -------------------------

async function _submitAnswerFSM() {
  var ctx = await _setup();
  var q = await ctx.qa.submitQuestion({
    product_id:     ctx.productId,
    customer_email: "q@example.com",
    body:           "Does the box include cables?",
  });

  // Bare operator answer (defaults is_operator=1).
  var opAns = await ctx.qa.submitAnswer({
    question_id: q.id,
    author:      "operator",
    body:        "Yes, two cables ship with every box.",
  });
  check("operator answer defaults is_operator=1", opAns.is_operator === 1);
  check("operator answer starts pending",         opAns.status === "pending");

  // Customer answer with author_id.
  var customerAuthorId = _validUUID();
  var custAns = await ctx.qa.submitAnswer({
    question_id: q.id,
    author:      "customer",
    author_id:   customerAuthorId,
    body:        "Mine came with two cables.",
  });
  check("customer answer keeps is_operator=0",    custAns.is_operator === 0);
  check("customer answer stamps author_id",       custAns.author_id === customerAuthorId);

  // Inconsistent author / is_operator pair refused.
  await assert.rejects(ctx.qa.submitAnswer({
    question_id: q.id, author: "customer", is_operator: true, body: "claim",
  }), /is_operator=true requires author === 'operator'/);
  await assert.rejects(ctx.qa.submitAnswer({
    question_id: q.id, author: "operator", is_operator: false, body: "claim",
  }), /author === 'operator' requires is_operator=true/);

  // Bad author enum / parent question missing.
  await assert.rejects(ctx.qa.submitAnswer({
    question_id: q.id, author: "robot", body: "x",
  }), /author/);
  await assert.rejects(ctx.qa.submitAnswer({
    question_id: _validUUID(), author: "operator", body: "x",
  }), /question .* not found/);

  // Body validation.
  await assert.rejects(ctx.qa.submitAnswer({
    question_id: q.id, author: "operator", body: "",
  }), /body/);
  await assert.rejects(ctx.qa.submitAnswer({
    question_id: q.id, author: "operator", body: "x".repeat(4001),
  }), /body/);
}

// ---- 4. voteUpAnswer dedup + tally --------------------------------------

async function _voteUp() {
  var ctx = await _setup();
  var q = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "v@example.com", body: "Q?",
  });
  await ctx.qa.approveQuestion(q.id);
  var a = await ctx.qa.submitAnswer({
    question_id: q.id, author: "operator", body: "A.",
  });
  await ctx.qa.approveAnswer(a.id);

  var v1 = await ctx.qa.voteUpAnswer({ answer_id: a.id, session_id: "sess-aaa" });
  check("first vote new_vote=true",         v1.new_vote === true);
  check("first vote bumps count to 1",      v1.vote_count === 1);

  // Repeat from same session -> no-op.
  var v1b = await ctx.qa.voteUpAnswer({ answer_id: a.id, session_id: "sess-aaa" });
  check("repeat vote new_vote=false",       v1b.new_vote === false);
  check("repeat vote count stays at 1",     v1b.vote_count === 1);

  // Distinct session counts.
  var v2 = await ctx.qa.voteUpAnswer({ answer_id: a.id, session_id: "sess-bbb" });
  check("distinct session counts",          v2.vote_count === 2 && v2.new_vote === true);

  // Bad inputs.
  await assert.rejects(ctx.qa.voteUpAnswer(),                                /input object required/);
  await assert.rejects(ctx.qa.voteUpAnswer({ answer_id: "x", session_id: "s" }),  /answer_id/);
  await assert.rejects(ctx.qa.voteUpAnswer({ answer_id: a.id, session_id: "" }),  /session_id/);
  await assert.rejects(ctx.qa.voteUpAnswer({ answer_id: a.id, session_id: "x".repeat(257) }), /session_id/);
  await assert.rejects(ctx.qa.voteUpAnswer({ answer_id: _validUUID(), session_id: "s" }),     /not found/);
}

// ---- 5. pinAnswer + topAnswerForQuestion float-to-top -------------------

async function _pinAndTop() {
  var ctx = await _setup();
  var q = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "p@example.com", body: "Q?",
  });
  await ctx.qa.approveQuestion(q.id);

  // Three answers: operator A1 (low votes), customer A2 (high votes),
  // operator A3 (no votes). Pin A1 -> it should float above A2 even
  // with fewer upvotes.
  var a1 = await ctx.qa.submitAnswer({ question_id: q.id, author: "operator", body: "A1" });
  var a2 = await ctx.qa.submitAnswer({ question_id: q.id, author: "customer", body: "A2" });
  var a3 = await ctx.qa.submitAnswer({ question_id: q.id, author: "operator", body: "A3" });
  await ctx.qa.approveAnswer(a1.id);
  await ctx.qa.approveAnswer(a2.id);
  await ctx.qa.approveAnswer(a3.id);

  // Stack votes on A2.
  await ctx.qa.voteUpAnswer({ answer_id: a2.id, session_id: "s1" });
  await ctx.qa.voteUpAnswer({ answer_id: a2.id, session_id: "s2" });
  await ctx.qa.voteUpAnswer({ answer_id: a2.id, session_id: "s3" });
  await ctx.qa.voteUpAnswer({ answer_id: a1.id, session_id: "s4" });

  // Without a pin, A2 (3 votes) tops A1 (1 vote) and A3 (0 votes).
  var topBeforePin = await ctx.qa.topAnswerForQuestion(q.id);
  check("pre-pin top is highest-voted",       topBeforePin.id === a2.id);

  var pinned = await ctx.qa.pinAnswer(a1.id);
  check("pinAnswer sets pinned=1",            pinned.pinned === 1);

  var topAfterPin = await ctx.qa.topAnswerForQuestion(q.id);
  check("post-pin top is the pinned answer",  topAfterPin.id === a1.id);
  check("post-pin top still has its votes",   topAfterPin.vote_count === 1);

  // Pinning A3 auto-unpins A1 (partial unique index would otherwise
  // trip).
  var pinnedA3 = await ctx.qa.pinAnswer(a3.id);
  check("re-pin floats A3",                   pinnedA3.pinned === 1);
  var top3 = await ctx.qa.topAnswerForQuestion(q.id);
  check("top is now A3",                      top3.id === a3.id);
  var a1Fresh = await ctx.qa.topAnswerForQuestion.constructor === Function ? null : null;
  // Re-read A1 to confirm it lost its pin.
  var a1Reread = (await ctx.query("SELECT pinned FROM product_qa_answers WHERE id = ?1", [a1.id])).rows[0];
  check("prior pin cleared",                  Number(a1Reread.pinned) === 0);
  void a1Fresh;

  // Non-operator pin refused.
  await assert.rejects(ctx.qa.pinAnswer(a2.id), /only operator answers can be pinned/);

  // Pre-approval pin refused.
  var aPending = await ctx.qa.submitAnswer({ question_id: q.id, author: "operator", body: "A4" });
  await assert.rejects(ctx.qa.pinAnswer(aPending.id), /must be approved before pinning/);

  // Not-found surface.
  await assert.rejects(ctx.qa.pinAnswer(_validUUID()), /not found/);

  // Idempotent pin — re-pinning the already-pinned answer is a no-op.
  var pinnedA3Again = await ctx.qa.pinAnswer(a3.id);
  check("re-pinning same answer is idempotent", pinnedA3Again.pinned === 1);
}

// ---- 6. questionsForProduct pagination ---------------------------------

async function _pagination() {
  var ctx = await _setup();
  // Five approved questions plus one pending + one rejected. Default
  // list is approved-only and newest-first.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var sub = await ctx.qa.submitQuestion({
      product_id:     ctx.productId,
      customer_email: "p" + i + "@example.com",
      body:           "Q-" + i,
    });
    await ctx.qa.approveQuestion(sub.id);
    ids.push(sub.id);
  }
  var pending = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "pend@example.com", body: "still moderating",
  });
  void pending;
  var rej = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "rej@example.com", body: "spam",
  });
  await ctx.qa.rejectQuestion(rej.id, "spam");

  var listed = await ctx.qa.questionsForProduct({ product_id: ctx.productId });
  check("default list returns approved only",
        listed.rows.length === 5 && listed.rows.every(function (r) { return r.status === "approved"; }));
  // Newest-first: the last-submitted approved id lands first.
  check("default list newest-first",         listed.rows[0].id === ids[ids.length - 1]);

  // Cursor pagination — page of 2 + page of 2 + page of 1.
  var page1 = await ctx.qa.questionsForProduct({ product_id: ctx.productId, limit: 2 });
  check("page1 returns 2 rows",              page1.rows.length === 2);
  check("page1 cursor present",              typeof page1.next_cursor === "string");
  var page2 = await ctx.qa.questionsForProduct({
    product_id: ctx.productId, limit: 2, cursor: page1.next_cursor,
  });
  check("page2 returns 2 rows",              page2.rows.length === 2);
  check("page2 disjoint from page1",
        page1.rows.every(function (r) {
          return page2.rows.every(function (r2) { return r2.id !== r.id; });
        }));
  var page3 = await ctx.qa.questionsForProduct({
    product_id: ctx.productId, limit: 2, cursor: page2.next_cursor,
  });
  check("page3 returns last row",            page3.rows.length === 1);
  check("page3 no further cursor",           page3.next_cursor === null);

  // Status filter -> pending only.
  var pendingList = await ctx.qa.questionsForProduct({
    product_id: ctx.productId, status: "pending",
  });
  check("status=pending returns the one pending row",
        pendingList.rows.length === 1 && pendingList.rows[0].status === "pending");

  // Bad inputs.
  await assert.rejects(ctx.qa.questionsForProduct({ product_id: ctx.productId, status: "bogus" }),
                       /status/);
  await assert.rejects(ctx.qa.questionsForProduct({ product_id: ctx.productId, limit: 0 }),
                       /limit/);
  await assert.rejects(ctx.qa.questionsForProduct({ product_id: ctx.productId, cursor: "" }),
                       /cursor/);
}

// ---- 7. metricsForProduct ---------------------------------------------

async function _metrics() {
  var ctx = await _setup();
  // 3 approved questions, 1 pending, 1 rejected.
  var ids = [];
  for (var i = 0; i < 3; i += 1) {
    var s = await ctx.qa.submitQuestion({
      product_id: ctx.productId, customer_email: "m" + i + "@example.com", body: "Q" + i,
    });
    await ctx.qa.approveQuestion(s.id);
    ids.push(s.id);
  }
  var pendingQ = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "pq@example.com", body: "pending",
  });
  void pendingQ;
  var rejQ = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "rq@example.com", body: "rejected",
  });
  await ctx.qa.rejectQuestion(rejQ.id, "spam");

  // Two of the three approved questions get an approved answer; the
  // third stays unanswered. Stack votes on one answer.
  var a0 = await ctx.qa.submitAnswer({ question_id: ids[0], author: "operator", body: "A0" });
  await ctx.qa.approveAnswer(a0.id);
  var a1 = await ctx.qa.submitAnswer({ question_id: ids[1], author: "customer", body: "A1" });
  await ctx.qa.approveAnswer(a1.id);
  // Pending answer on the same question doesn't count.
  await ctx.qa.submitAnswer({ question_id: ids[1], author: "customer", body: "A1-pending" });
  await ctx.qa.voteUpAnswer({ answer_id: a0.id, session_id: "u1" });
  await ctx.qa.voteUpAnswer({ answer_id: a0.id, session_id: "u2" });
  await ctx.qa.voteUpAnswer({ answer_id: a1.id, session_id: "u3" });

  var m = await ctx.qa.metricsForProduct(ctx.productId);
  check("metrics: pending count",            m.pending_questions === 1);
  check("metrics: approved count",           m.approved_questions === 3);
  check("metrics: rejected count",           m.rejected_questions === 1);
  check("metrics: answered count",           m.answered_questions === 2);
  check("metrics: total approved answers",   m.total_answers === 2);
  check("metrics: total upvotes",            m.total_upvotes === 3);

  // Empty product -> all zeros.
  var emptyP = await _seedProduct(ctx.query, { slug: "empty-pdp" });
  var emptyM = await ctx.qa.metricsForProduct(emptyP);
  check("empty product all zeros",
        emptyM.pending_questions === 0 &&
        emptyM.approved_questions === 0 &&
        emptyM.answered_questions === 0 &&
        emptyM.total_answers === 0 &&
        emptyM.total_upvotes === 0);
}

// ---- 8. cleanupRejected reclaims aged rejected rows --------------------

async function _cleanup() {
  var ctx = await _setup();

  // Create a rejected question with a back-dated occurred_at by
  // writing directly through the query handle (the primitive's
  // monotonic clock would otherwise pin every row to "now").
  var oldRejected = _validUUID();
  await ctx.query(
    "INSERT INTO product_qa_questions " +
    "(id, product_id, customer_id, customer_email_hash, body, status, pinned, vote_count, occurred_at) " +
    "VALUES (?1, ?2, NULL, NULL, 'old-rejected', 'rejected', 0, 0, ?3)",
    [oldRejected, ctx.productId, Date.now() - 60 * 24 * 60 * 60 * 1000],   // 60 days ago
  );
  // Aged rejected answer attached to a fresh approved question.
  var freshQ = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "a@example.com", body: "Q",
  });
  await ctx.qa.approveQuestion(freshQ.id);
  var oldRejectedA = _validUUID();
  await ctx.query(
    "INSERT INTO product_qa_answers " +
    "(id, question_id, author, author_id, body, is_operator, status, pinned, vote_count, occurred_at) " +
    "VALUES (?1, ?2, 'customer', NULL, 'old-rej-answer', 0, 'rejected', 0, 0, ?3)",
    [oldRejectedA, freshQ.id, Date.now() - 60 * 24 * 60 * 60 * 1000],
  );
  // A recently-rejected question (today) — must NOT be reclaimed at
  // the 30-day window.
  var recentRej = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "r@example.com", body: "recent",
  });
  await ctx.qa.rejectQuestion(recentRej.id, "rejected today");
  // An approved question — must NOT be reclaimed.
  var keep = await ctx.qa.submitQuestion({
    product_id: ctx.productId, customer_email: "k@example.com", body: "keep me",
  });
  await ctx.qa.approveQuestion(keep.id);

  var result = await ctx.qa.cleanupRejected(30);
  check("cleanup deletes the aged rejected question", result.questions_deleted === 1);
  check("cleanup deletes the aged rejected answer",   result.answers_deleted === 1);

  // Validate: recent-rejected + approved still present.
  var stillRecent = await ctx.qa.getQuestion(recentRej.id);
  check("recent-rejected survives",          stillRecent && stillRecent.status === "rejected");
  var stillApproved = await ctx.qa.getQuestion(keep.id);
  check("approved survives",                 stillApproved && stillApproved.status === "approved");

  // Bad inputs.
  await assert.rejects(ctx.qa.cleanupRejected(0),                  /days/);
  await assert.rejects(ctx.qa.cleanupRejected(-1),                 /days/);
  await assert.rejects(ctx.qa.cleanupRejected("thirty"),           /days/);

  // Default cleanup window (30 days) is fine on a no-op pass.
  var noop = await ctx.qa.cleanupRejected();
  check("default cleanup yields a numeric result",
        Number.isInteger(noop.questions_deleted) &&
        Number.isInteger(noop.answers_deleted));
}

async function run() {
  await _submitQuestion();
  await _moderation();
  await _submitAnswerFSM();
  await _voteUp();
  await _pinAndTop();
  await _pagination();
  await _metrics();
  await _cleanup();
}

module.exports = { run: run };
