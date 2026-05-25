"use strict";
/**
 * @module shop.productQA
 * @title  Product Q&A — PDP-attached question + answer threads
 *
 * @intro
 *   Customer-submitted questions and operator/customer answers
 *   attached to a product detail page. Distinct from the rating-based
 *   reviews primitive (lib/reviews.js): there's no star rating, the
 *   payload is free-form text, and answer authorship is a three-way
 *   enum (operator / customer / system) so the storefront can render
 *   the "Answered by the seller" badge without a second lookup.
 *
 *   Author identity:
 *     - Authenticated questioners pass `customer_id` (UUID); the raw
 *       id persists alongside the hash so an operator can build a
 *       "my questions" page without leaking the hash space.
 *     - Anonymous questioners pass `customer_email`; the raw address
 *       is normalised via `b.guardEmail` (strict profile, lowered),
 *       hashed with `b.crypto.namespaceHash` under the
 *       `product-qa-customer-email` namespace, and ONLY the hash is
 *       persisted.
 *     - Authenticated answerers pass `author_id` (UUID) — operator
 *       staff ids or customer ids, with `is_operator` set on operator
 *       writes so `pinAnswer` can refuse to pin a non-operator
 *       answer.
 *
 *   Moderation FSM (shared by questions and answers):
 *     pending  -> approved   (approveQuestion / approveAnswer)
 *     pending  -> rejected   (rejectQuestion / rejectAnswer)
 *     approved -> rejected   (operator unpublish after publication)
 *     approved -> approved   (no-op — approvers are idempotent)
 *
 *   Vote-up signal:
 *     `voteUpAnswer({ answer_id, session_id })` records a thumbs-up
 *     from the visitor's session. The session id is hashed under the
 *     `product-qa-vote-session` namespace; the unique
 *     (answer_id, session_id_hash) constraint dedupes repeat taps
 *     from the same tab to a single vote. Successful inserts bump
 *     the denormalised `vote_count` on the answer row in the same
 *     pair of statements.
 *
 *   Top-answer pinning:
 *     `pinAnswer(answer_id)` floats an operator answer to the top of
 *     `topAnswerForQuestion`. The partial unique index in
 *     `0133_product_qa.sql` enforces at-most-one pinned answer per
 *     question — pinning a second answer auto-unpins the previous
 *     one in the same transaction. Customer / system answers can't
 *     be pinned (operators own the "definitive answer" surface).
 *
 *   Composes:
 *     - `b.guardUuid`            — UUID-shape validation for ids.
 *     - `b.guardEmail`           — strict-profile email validation +
 *                                  canonical lower-cased form.
 *     - `b.crypto.namespaceHash` — SHA3-512 namespace hash for email
 *                                  + session id.
 *     - `b.uuid.v7`              — monotonic-lexicographic row ids.
 *
 *   Storage: `migrations-d1/0133_product_qa.sql` —
 *     `product_qa_questions` + `product_qa_answers` (FK CASCADE) +
 *     `product_qa_votes` (FK CASCADE, UNIQUE(answer_id, session_id_hash)).
 *
 * @primitive productQA
 * @related   b.crypto, b.uuid, b.guardUuid, b.guardEmail
 */

var EMAIL_NAMESPACE       = "product-qa-customer-email";
var SESSION_NAMESPACE     = "product-qa-vote-session";

var MAX_BODY_LEN          = 4000;
var MAX_REASON_LEN        = 500;
var MAX_SESSION_ID_LEN    = 256;

var DEFAULT_LIMIT         = 50;
var MAX_LIST_LIMIT        = 200;

var DEFAULT_CLEANUP_DAYS  = 30;
var MAX_CLEANUP_DAYS      = 365 * 5;
var MIN_CLEANUP_DAYS      = 1;

var STATUSES              = Object.freeze(["pending", "approved", "rejected"]);
var AUTHORS               = Object.freeze(["operator", "customer", "system"]);

var CONTROL_BYTE_RE       = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- monotonic clock ---------------------------------------------------
//
// Q&A rows persist epoch-ms timestamps and the read paths order by
// occurred_at. The strict-monotonic clock here guarantees two same-
// millisecond _now() calls produce distinct integers so the ordering
// in topAnswerForQuestion + questionsForProduct stays deterministic
// without an extra tiebreaker column. The pagination test below
// submits questions in tight loops and relies on this.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("productQA: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _body(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("productQA: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("productQA: " + label + " must be <= " + MAX_BODY_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("productQA: " + label + " must not contain control bytes");
  }
  return s;
}

function _reason(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("productQA: reason must be a string");
  }
  if (!s.length) return null;
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("productQA: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("productQA: reason must not contain control bytes");
  }
  return s;
}

function _author(s) {
  if (typeof s !== "string" || AUTHORS.indexOf(s) < 0) {
    throw new TypeError("productQA: author must be one of " + AUTHORS.join(", "));
  }
  return s;
}

function _statusFilter(s) {
  if (s == null) return undefined;
  if (typeof s !== "string" || STATUSES.indexOf(s) < 0) {
    throw new TypeError("productQA: status filter must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("productQA: limit must be an integer 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _sessionId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("productQA: session_id must be a non-empty string");
  }
  if (s.length > MAX_SESSION_ID_LEN) {
    throw new TypeError("productQA: session_id must be <= " + MAX_SESSION_ID_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("productQA: session_id must not contain control bytes");
  }
  return s;
}

function _cleanupDays(n) {
  if (n == null) return DEFAULT_CLEANUP_DAYS;
  if (!Number.isInteger(n) || n < MIN_CLEANUP_DAYS || n > MAX_CLEANUP_DAYS) {
    throw new TypeError("productQA: cleanup days must be an integer in [" +
      MIN_CLEANUP_DAYS + ", " + MAX_CLEANUP_DAYS + "]");
  }
  return n;
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("productQA: customer_email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("productQA: customer_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("productQA: customer_email — " +
      (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("productQA: customer_email — " + (e && e.message || "refused"));
  }
  return canonical.toLowerCase().trim();
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // `customers` integration is optional — the primitive enforces UUID
  // shape on every customer_id parameter, but if the operator wires
  // the live `customers` primitive in we additionally verify the
  // referenced customer row exists before stamping. Tests can pass a
  // minimal fake or leave it null; production wires the real instance.
  var customers = opts.customers || null;

  function _hashEmail(canonical) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, canonical);
  }
  function _hashSession(sessionId) {
    return b.crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
  }

  async function _maybeRequireCustomer(id) {
    if (!customers || id == null) return;
    var row = await customers.get(id);
    if (!row) {
      throw new TypeError("productQA: customer " + JSON.stringify(id) + " not found");
    }
  }

  async function _questionRow(id) {
    var r = await query("SELECT * FROM product_qa_questions WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }
  async function _answerRow(id) {
    var r = await query("SELECT * FROM product_qa_answers WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // ---- submitQuestion --------------------------------------------------

  async function submitQuestion(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("productQA.submitQuestion: input object required");
    }
    var productId = _uuid(input.product_id, "product_id");
    var body      = _body(input.body, "body");

    var hasId    = input.customer_id != null && input.customer_id !== "";
    var hasEmail = input.customer_email != null && input.customer_email !== "";
    if (!hasId && !hasEmail) {
      throw new TypeError("productQA.submitQuestion: either customer_id or customer_email is required");
    }

    var customerId       = null;
    var customerEmailHash = null;
    if (hasId) {
      customerId = _uuid(input.customer_id, "customer_id");
      await _maybeRequireCustomer(customerId);
    }
    if (hasEmail) {
      customerEmailHash = _hashEmail(_normalizeEmail(input.customer_email));
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO product_qa_questions " +
      "(id, product_id, customer_id, customer_email_hash, body, status, pinned, vote_count, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, 0, ?6)",
      [id, productId, customerId, customerEmailHash, body, ts],
    );
    return await getQuestion(id);
  }

  // ---- submitAnswer ----------------------------------------------------

  async function submitAnswer(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("productQA.submitAnswer: input object required");
    }
    var questionId = _uuid(input.question_id, "question_id");
    var author     = _author(input.author);
    var body       = _body(input.body, "body");

    var authorId = null;
    if (input.author_id != null && input.author_id !== "") {
      authorId = _uuid(input.author_id, "author_id");
      if (author === "customer") {
        await _maybeRequireCustomer(authorId);
      }
    }

    // `is_operator` defaults to true when author === "operator" so
    // callers can omit the flag for the common case. Explicit values
    // override only when consistent — refusing the inconsistent pair
    // catches a caller that asserts "this is the staff answer" while
    // claiming customer authorship.
    var isOperator;
    if (input.is_operator == null) {
      isOperator = author === "operator" ? 1 : 0;
    } else {
      if (input.is_operator !== true && input.is_operator !== false &&
          input.is_operator !== 0    && input.is_operator !== 1) {
        throw new TypeError("productQA.submitAnswer: is_operator must be a boolean or 0/1");
      }
      isOperator = (input.is_operator === true || input.is_operator === 1) ? 1 : 0;
      if (isOperator === 1 && author !== "operator") {
        throw new TypeError("productQA.submitAnswer: is_operator=true requires author === 'operator'");
      }
      if (isOperator === 0 && author === "operator") {
        throw new TypeError("productQA.submitAnswer: author === 'operator' requires is_operator=true");
      }
    }

    // Parent question must exist — FK CASCADE handles the inverse
    // (delete question -> delete answers), but the insert itself
    // benefits from a clean app-layer error rather than a raw
    // foreign-key constraint message.
    var parent = await _questionRow(questionId);
    if (!parent) {
      var err = new Error("productQA.submitAnswer: question " + questionId + " not found");
      err.code = "PRODUCT_QA_QUESTION_NOT_FOUND";
      throw err;
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO product_qa_answers " +
      "(id, question_id, author, author_id, body, is_operator, status, pinned, vote_count, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, 0, ?7)",
      [id, questionId, author, authorId, body, isOperator, ts],
    );
    return _decodeAnswer(await _answerRow(id));
  }

  // ---- moderation verbs ------------------------------------------------

  async function _setQuestionStatus(id, toStatus, reason, verbLabel) {
    _uuid(id, "question_id");
    _reason(reason);
    var existing = await _questionRow(id);
    if (!existing) {
      var err = new Error("productQA." + verbLabel + ": question " + id + " not found");
      err.code = "PRODUCT_QA_QUESTION_NOT_FOUND";
      throw err;
    }
    if (existing.status === toStatus) {
      // Idempotent — re-approving an approved row is a no-op.
      return _decodeQuestion(existing);
    }
    if (existing.status === "rejected" && toStatus === "approved") {
      // Rejected rows are terminal for the approve path so operators
      // can't accidentally un-reject after a takedown audit. Use
      // submitQuestion to re-author if the customer re-asks.
      var bad = new Error("productQA." + verbLabel +
        ": cannot approve a rejected question");
      bad.code = "PRODUCT_QA_TRANSITION_REFUSED";
      throw bad;
    }
    await query(
      "UPDATE product_qa_questions SET status = ?1 WHERE id = ?2",
      [toStatus, id],
    );
    return _decodeQuestion(await _questionRow(id));
  }

  async function _setAnswerStatus(id, toStatus, reason, verbLabel) {
    _uuid(id, "answer_id");
    _reason(reason);
    var existing = await _answerRow(id);
    if (!existing) {
      var err = new Error("productQA." + verbLabel + ": answer " + id + " not found");
      err.code = "PRODUCT_QA_ANSWER_NOT_FOUND";
      throw err;
    }
    if (existing.status === toStatus) {
      return _decodeAnswer(existing);
    }
    if (existing.status === "rejected" && toStatus === "approved") {
      var bad = new Error("productQA." + verbLabel +
        ": cannot approve a rejected answer");
      bad.code = "PRODUCT_QA_TRANSITION_REFUSED";
      throw bad;
    }
    // Rejecting an answer also clears its pin — a takedown shouldn't
    // leave the pinned slot occupied by a since-removed answer.
    if (toStatus === "rejected" && Number(existing.pinned) === 1) {
      await query(
        "UPDATE product_qa_answers SET status = ?1, pinned = 0 WHERE id = ?2",
        [toStatus, id],
      );
    } else {
      await query(
        "UPDATE product_qa_answers SET status = ?1 WHERE id = ?2",
        [toStatus, id],
      );
    }
    return _decodeAnswer(await _answerRow(id));
  }

  function approveQuestion(id) { return _setQuestionStatus(id, "approved", null, "approveQuestion"); }
  function rejectQuestion(id, reason) { return _setQuestionStatus(id, "rejected", reason, "rejectQuestion"); }
  function approveAnswer(id)   { return _setAnswerStatus(id,   "approved", null, "approveAnswer"); }
  function rejectAnswer(id, reason)   { return _setAnswerStatus(id,   "rejected", reason, "rejectAnswer"); }

  // ---- pinAnswer -------------------------------------------------------

  async function pinAnswer(answerId) {
    _uuid(answerId, "answer_id");
    var existing = await _answerRow(answerId);
    if (!existing) {
      var miss = new Error("productQA.pinAnswer: answer " + answerId + " not found");
      miss.code = "PRODUCT_QA_ANSWER_NOT_FOUND";
      throw miss;
    }
    if (Number(existing.is_operator) !== 1) {
      var nonOp = new Error("productQA.pinAnswer: only operator answers can be pinned");
      nonOp.code = "PRODUCT_QA_PIN_REFUSED";
      throw nonOp;
    }
    if (existing.status !== "approved") {
      var notApproved = new Error("productQA.pinAnswer: answer must be approved before pinning (current: " +
        existing.status + ")");
      notApproved.code = "PRODUCT_QA_PIN_REFUSED";
      throw notApproved;
    }
    if (Number(existing.pinned) === 1) {
      return _decodeAnswer(existing);
    }
    // Clear any existing pin on the same question first — the
    // partial unique index in 0133_product_qa.sql enforces at-most-
    // one pinned answer per question and would otherwise reject the
    // second pin. Two statements is fine for this since both target
    // the same indexed (question_id) range.
    await query(
      "UPDATE product_qa_answers SET pinned = 0 WHERE question_id = ?1 AND pinned = 1",
      [existing.question_id],
    );
    await query(
      "UPDATE product_qa_answers SET pinned = 1 WHERE id = ?1",
      [answerId],
    );
    return _decodeAnswer(await _answerRow(answerId));
  }

  // ---- voteUpAnswer ----------------------------------------------------

  async function voteUpAnswer(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("productQA.voteUpAnswer: input object required");
    }
    var answerId = _uuid(input.answer_id, "answer_id");
    var session  = _sessionId(input.session_id);
    var sessionHash = _hashSession(session);

    var existing = await _answerRow(answerId);
    if (!existing) {
      var miss = new Error("productQA.voteUpAnswer: answer " + answerId + " not found");
      miss.code = "PRODUCT_QA_ANSWER_NOT_FOUND";
      throw miss;
    }
    // Pre-check the dedup row so the (insert / bump) pair only fires
    // for genuinely new votes. The UNIQUE constraint on
    // (answer_id, session_id_hash) is the source of truth; this
    // pre-check just keeps the happy-path counter consistent without
    // an INSERT-OR-IGNORE-then-conditional-bump dance.
    var dup = await query(
      "SELECT id FROM product_qa_votes WHERE answer_id = ?1 AND session_id_hash = ?2 LIMIT 1",
      [answerId, sessionHash],
    );
    if (dup.rows.length) {
      return {
        answer_id:  answerId,
        vote_count: Number(existing.vote_count),
        new_vote:   false,
      };
    }

    var ts = _now();
    var voteId = b.uuid.v7();
    await query(
      "INSERT INTO product_qa_votes (id, answer_id, session_id_hash, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4)",
      [voteId, answerId, sessionHash, ts],
    );
    await query(
      "UPDATE product_qa_answers SET vote_count = vote_count + 1 WHERE id = ?1",
      [answerId],
    );
    var fresh = await _answerRow(answerId);
    return {
      answer_id:  answerId,
      vote_count: Number(fresh.vote_count),
      new_vote:   true,
    };
  }

  // ---- read paths ------------------------------------------------------

  function _decodeQuestion(row) {
    if (!row) return null;
    return {
      id:                   row.id,
      product_id:           row.product_id,
      customer_id:          row.customer_id,
      customer_email_hash:  row.customer_email_hash,
      body:                 row.body,
      status:               row.status,
      pinned:               Number(row.pinned),
      vote_count:           Number(row.vote_count),
      occurred_at:          Number(row.occurred_at),
    };
  }

  function _decodeAnswer(row) {
    if (!row) return null;
    return {
      id:            row.id,
      question_id:   row.question_id,
      author:        row.author,
      author_id:     row.author_id,
      body:          row.body,
      is_operator:   Number(row.is_operator),
      status:        row.status,
      pinned:        Number(row.pinned),
      vote_count:    Number(row.vote_count),
      occurred_at:   Number(row.occurred_at),
    };
  }

  async function getQuestion(id) {
    _uuid(id, "question_id");
    return _decodeQuestion(await _questionRow(id));
  }

  async function questionsForProduct(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("productQA.questionsForProduct: input object required");
    }
    var productId = _uuid(input.product_id, "product_id");
    // Default to approved-only so a caller that forgets the status
    // filter doesn't accidentally leak pending / rejected rows onto
    // the storefront.
    var status = input.status === undefined ? "approved" : _statusFilter(input.status);
    var limit  = _limit(input.limit);

    // Opaque cursor stamps the last-seen (occurred_at, id) tuple as
    // `<occurred_at>:<id>`. The primitive's strict-monotonic _now()
    // guarantees occurred_at is unique per row so the tuple predicate
    // collapses to a deterministic total order even when v7 ids
    // generated in the same millisecond sort the wrong way among
    // themselves (RFC 9562 only orders v7 ids across millisecond
    // boundaries).
    var cursor = input.cursor;
    var cursorTs;
    var cursorId;
    if (cursor != null) {
      if (typeof cursor !== "string" || !cursor.length) {
        throw new TypeError("productQA.questionsForProduct: cursor must be a non-empty string when provided");
      }
      var sep = cursor.indexOf(":");
      if (sep < 0) {
        throw new TypeError("productQA.questionsForProduct: cursor — malformed");
      }
      cursorTs = parseInt(cursor.slice(0, sep), 10);
      cursorId = cursor.slice(sep + 1);
      if (!Number.isInteger(cursorTs) || cursorTs < 0 || !cursorId.length) {
        throw new TypeError("productQA.questionsForProduct: cursor — malformed");
      }
    }

    var sql, params;
    if (status !== undefined && cursor) {
      sql = "SELECT * FROM product_qa_questions WHERE product_id = ?1 AND status = ?2 " +
            "AND (occurred_at < ?3 OR (occurred_at = ?3 AND id < ?4)) " +
            "ORDER BY occurred_at DESC, id DESC LIMIT ?5";
      params = [productId, status, cursorTs, cursorId, limit];
    } else if (status !== undefined) {
      sql = "SELECT * FROM product_qa_questions WHERE product_id = ?1 AND status = ?2 " +
            "ORDER BY occurred_at DESC, id DESC LIMIT ?3";
      params = [productId, status, limit];
    } else if (cursor) {
      sql = "SELECT * FROM product_qa_questions WHERE product_id = ?1 " +
            "AND (occurred_at < ?2 OR (occurred_at = ?2 AND id < ?3)) " +
            "ORDER BY occurred_at DESC, id DESC LIMIT ?4";
      params = [productId, cursorTs, cursorId, limit];
    } else {
      sql = "SELECT * FROM product_qa_questions WHERE product_id = ?1 " +
            "ORDER BY occurred_at DESC, id DESC LIMIT ?2";
      params = [productId, limit];
    }
    var r = await query(sql, params);
    var rows = [];
    for (var i = 0; i < r.rows.length; i += 1) rows.push(_decodeQuestion(r.rows[i]));
    var nextCursor = null;
    if (rows.length === limit) {
      var last = rows[rows.length - 1];
      nextCursor = String(last.occurred_at) + ":" + last.id;
    }
    return { rows: rows, next_cursor: nextCursor };
  }

  // The top answer for a question is, in priority order:
  //   1. The pinned answer (at most one, guaranteed by the partial
  //      unique index).
  //   2. The approved answer with the highest vote_count.
  //   3. Tie-break by occurred_at ASC (older answers win ties so a
  //      late-coming "+1" doesn't displace an earlier well-rated
  //      answer).
  // Pending / rejected answers never surface.
  async function topAnswerForQuestion(questionId) {
    _uuid(questionId, "question_id");
    var r = await query(
      "SELECT * FROM product_qa_answers " +
      "WHERE question_id = ?1 AND status = 'approved' " +
      "ORDER BY pinned DESC, vote_count DESC, occurred_at ASC, id ASC " +
      "LIMIT 1",
      [questionId],
    );
    return r.rows.length ? _decodeAnswer(r.rows[0]) : null;
  }

  // Per-product rollup used by the PDP header ("12 questions, 8
  // answered, average 3 upvotes per answer"). Counts approved rows
  // only — pending / rejected don't surface to storefront copy.
  async function metricsForProduct(productId) {
    productId = _uuid(productId, "product_id");
    var qRes = await query(
      "SELECT status, COUNT(*) AS n FROM product_qa_questions " +
      "WHERE product_id = ?1 GROUP BY status",
      [productId],
    );
    var qCounts = { pending: 0, approved: 0, rejected: 0 };
    for (var i = 0; i < qRes.rows.length; i += 1) {
      qCounts[qRes.rows[i].status] = Number(qRes.rows[i].n);
    }
    // Answered = count of approved questions that have at least one
    // approved answer. Use a single grouped aggregate so we get the
    // total upvote tally + answered count in one round-trip.
    var aRes = await query(
      "SELECT a.question_id, COUNT(*) AS answer_count, COALESCE(SUM(a.vote_count), 0) AS upvotes " +
      "FROM product_qa_answers a " +
      "JOIN product_qa_questions q ON q.id = a.question_id " +
      "WHERE q.product_id = ?1 AND q.status = 'approved' AND a.status = 'approved' " +
      "GROUP BY a.question_id",
      [productId],
    );
    var answeredQuestions = aRes.rows.length;
    var totalAnswers      = 0;
    var totalUpvotes      = 0;
    for (var j = 0; j < aRes.rows.length; j += 1) {
      totalAnswers += Number(aRes.rows[j].answer_count);
      totalUpvotes += Number(aRes.rows[j].upvotes);
    }
    return {
      product_id:           productId,
      pending_questions:    qCounts.pending,
      approved_questions:   qCounts.approved,
      rejected_questions:   qCounts.rejected,
      answered_questions:   answeredQuestions,
      total_answers:        totalAnswers,
      total_upvotes:        totalUpvotes,
    };
  }

  // ---- cleanupRejected -------------------------------------------------

  // Reclaim rejected rows after a retention window so the moderation
  // table doesn't grow without bound. Operates on both questions and
  // answers; deleting a question cascades into its answers + votes
  // via the FK so the answer pass only catches orphaned answers
  // attached to non-rejected questions.
  async function cleanupRejected(days) {
    var d = _cleanupDays(days);
    var cutoff = _now() - C.TIME.days(d);

    var qDel = await query(
      "DELETE FROM product_qa_questions WHERE status = 'rejected' AND occurred_at < ?1",
      [cutoff],
    );
    var aDel = await query(
      "DELETE FROM product_qa_answers WHERE status = 'rejected' AND occurred_at < ?1",
      [cutoff],
    );
    return {
      questions_deleted: Number(qDel.rowCount || 0),
      answers_deleted:   Number(aDel.rowCount || 0),
      cutoff:            cutoff,
    };
  }

  return {
    EMAIL_NAMESPACE:     EMAIL_NAMESPACE,
    SESSION_NAMESPACE:   SESSION_NAMESPACE,
    MAX_BODY_LEN:        MAX_BODY_LEN,
    MAX_REASON_LEN:      MAX_REASON_LEN,
    MAX_SESSION_ID_LEN:  MAX_SESSION_ID_LEN,
    MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
    DEFAULT_LIMIT:       DEFAULT_LIMIT,
    DEFAULT_CLEANUP_DAYS: DEFAULT_CLEANUP_DAYS,
    STATUSES:            STATUSES.slice(),
    AUTHORS:             AUTHORS.slice(),

    submitQuestion:       submitQuestion,
    submitAnswer:         submitAnswer,
    approveQuestion:      approveQuestion,
    rejectQuestion:       rejectQuestion,
    approveAnswer:        approveAnswer,
    rejectAnswer:         rejectAnswer,
    pinAnswer:            pinAnswer,
    voteUpAnswer:         voteUpAnswer,
    questionsForProduct:  questionsForProduct,
    getQuestion:          getQuestion,
    topAnswerForQuestion: topAnswerForQuestion,
    metricsForProduct:    metricsForProduct,
    cleanupRejected:      cleanupRejected,
  };
}

module.exports = {
  create:               create,
  EMAIL_NAMESPACE:      EMAIL_NAMESPACE,
  SESSION_NAMESPACE:    SESSION_NAMESPACE,
  MAX_BODY_LEN:         MAX_BODY_LEN,
  MAX_REASON_LEN:       MAX_REASON_LEN,
  MAX_SESSION_ID_LEN:   MAX_SESSION_ID_LEN,
  MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
  DEFAULT_LIMIT:        DEFAULT_LIMIT,
  DEFAULT_CLEANUP_DAYS: DEFAULT_CLEANUP_DAYS,
  STATUSES:             STATUSES,
  AUTHORS:              AUTHORS,
};
