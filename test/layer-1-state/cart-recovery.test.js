"use strict";
/**
 * cartRecovery — multi-step abandonment email sequences with
 * dispatcher, suppression gate, and recovery metrics.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0171.
 *
 * Coverage:
 *   - defineSequence: creates row + stores ordered steps; redefine
 *     replaces the steps + bumps updated_at; refusals on bad slug,
 *     non-dense step_index, non-increasing offset, bad kind
 *   - enrollDetection: writes enrollment row, schedules next_step_at
 *     at enrolled_at + steps[0].offset_ms; refuses unknown sequence
 *   - dispatchTick: advances enrollments through each step, writes
 *     one dispatch row per step, lands `completed` after the last
 *     step
 *   - dispatchTick + suppressions: a suppressed email writes
 *     `skipped-suppressed` + cancels the enrollment
 *   - dispatchTick + no email resolver + no email_hash: writes
 *     `skipped-no-email` + cancels
 *   - markRecovered: terminal-rewrite even when status is `completed`;
 *     idempotent re-call
 *   - markStepSkipped: records a `skipped-suppressed` dispatch +
 *     cancels enrollment
 *   - recordStepSent: direct-record path advances FSM; idempotent at
 *     the (enrollment, step_index) pair
 *   - cancelEnrollment: pulls the enrollment out of the dispatch
 *     queue without writing a dispatch row
 *   - enrollmentsForCustomer + dispatchesForEnrollment + getSequence
 *   - metricsForSequence: counts + recovery rate
 *
 * The monotonic-clock seam is exercised by passing an explicit `now`
 * to every state-mutating call so the test's row timestamps are
 * deterministic.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var cartRecovery  = require("../../lib/cart-recovery");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0171_cart_recovery.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
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

function _factory(deps) {
  var query = _makeQuery();
  return {
    query:    query,
    recovery: cartRecovery.create({
      query:             query,
      cartAbandonment:   (deps && deps.cartAbandonment)   || null,
      email:             (deps && deps.email)             || null,
      emailSuppressions: (deps && deps.emailSuppressions) || null,
    }),
  };
}

// Deterministic clock — bumps on every read so two calls in the same
// physical millisecond still order.
function _clock(start) {
  var t = start || 1700000000000;
  return function () { t += 1; return t; };
}

// Stable UUIDs for the test's cart_id / customer_id / detection_id
// inputs. The primitive enforces strict UUID shape so we use a
// minimal v4-shaped string.
function _uuid(seed) {
  // Pad to 32 hex chars then format as 8-4-4-4-12.
  var hex = String(seed).replace(/[^0-9a-f]/gi, "").toLowerCase();
  while (hex.length < 32) hex = hex + "0";
  hex = hex.slice(0, 32);
  // Force the version nibble to 4 + variant nibble to 8/9/a/b so the
  // guardUuid strict gate accepts the value.
  var v = hex.slice(0, 12) + "4" + hex.slice(13, 16) + "8" + hex.slice(17);
  return (
    v.slice(0, 8) + "-" +
    v.slice(8, 12) + "-" +
    v.slice(12, 16) + "-" +
    v.slice(16, 20) + "-" +
    v.slice(20, 32)
  );
}

var HOUR = 3600 * 1000;
var DAY  = 24 * HOUR;

// ---- tests --------------------------------------------------------------

async function _defineSequenceHappy() {
  var f = _factory();
  var tick = _clock();

  var seq = await f.recovery.defineSequence({
    slug:  "default-recovery",
    title: "Default 3-step recovery",
    steps: [
      { step_index: 0, offset_ms:  1 * HOUR,  kind: "reminder"    },
      { step_index: 1, offset_ms: 24 * HOUR,  kind: "discount"    },
      { step_index: 2, offset_ms: 72 * HOUR,  kind: "last_chance" },
    ],
    now: tick(),
  });
  check("defineSequence returns row", seq && seq.slug === "default-recovery");
  check("defineSequence stores 3 steps", seq.steps.length === 3);
  check("defineSequence step 0 is reminder",
    seq.steps[0].kind === "reminder" && seq.steps[0].offset_ms === HOUR);
  check("defineSequence step 1 is discount",
    seq.steps[1].kind === "discount" && seq.steps[1].offset_ms === 24 * HOUR);
  check("defineSequence step 2 is last_chance",
    seq.steps[2].kind === "last_chance" && seq.steps[2].offset_ms === 72 * HOUR);
  check("defineSequence active=true by default", seq.active === true);

  // Redefine — replaces steps, bumps updated_at.
  var seq2 = await f.recovery.defineSequence({
    slug:  "default-recovery",
    title: "Renamed",
    steps: [
      { step_index: 0, offset_ms: 2 * HOUR, kind: "reminder" },
      { step_index: 1, offset_ms: 4 * HOUR, kind: "generic"  },
    ],
    now: tick(),
  });
  check("redefine returns updated title", seq2.title === "Renamed");
  check("redefine collapses steps", seq2.steps.length === 2);
  check("redefine bumps updated_at", seq2.updated_at > seq.updated_at);

  // Refusals.
  assert.rejects(
    f.recovery.defineSequence({
      slug:  "Bad-Slug",
      title: "x",
      steps: [{ step_index: 0, offset_ms: HOUR, kind: "reminder" }],
      now:   tick(),
    }),
    /slug must match/
  );
  assert.rejects(
    f.recovery.defineSequence({
      slug:  "gap-steps",
      title: "x",
      steps: [
        { step_index: 0, offset_ms: HOUR,     kind: "reminder" },
        { step_index: 2, offset_ms: 2 * HOUR, kind: "discount" },
      ],
      now: tick(),
    }),
    /step_index must equal 1/
  );
  assert.rejects(
    f.recovery.defineSequence({
      slug:  "non-increasing",
      title: "x",
      steps: [
        { step_index: 0, offset_ms: 2 * HOUR, kind: "reminder" },
        { step_index: 1, offset_ms: 1 * HOUR, kind: "discount" },
      ],
      now: tick(),
    }),
    /strictly greater/
  );
  assert.rejects(
    f.recovery.defineSequence({
      slug:  "bad-kind",
      title: "x",
      steps: [{ step_index: 0, offset_ms: HOUR, kind: "not-a-kind" }],
      now:   tick(),
    }),
    /step.kind must be one of/
  );
  assert.rejects(
    f.recovery.defineSequence({
      slug:  "empty-steps",
      title: "x",
      steps: [],
      now:   tick(),
    }),
    /non-empty array/
  );
}

async function _enrollDetectionSchedulesNextStep() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "enroll-test",
    title: "Enroll test",
    steps: [
      { step_index: 0, offset_ms:  1 * HOUR, kind: "reminder"    },
      { step_index: 1, offset_ms: 24 * HOUR, kind: "discount"    },
      { step_index: 2, offset_ms: 72 * HOUR, kind: "last_chance" },
    ],
    now: t0,
  });

  var t1 = tick();
  var enr = await f.recovery.enrollDetection({
    sequence_slug:  "enroll-test",
    detection_id:   _uuid("dec1"),
    cart_id:        _uuid("ca7"),
    customer_id:    _uuid("c031"),
    customer_email: "shopper@example.com",
    now:            t1,
  });
  check("enrollDetection returns row", enr && enr.id);
  check("enrollDetection status=enrolled", enr.status === "enrolled");
  check("enrollDetection current_step_index=0", enr.current_step_index === 0);
  check("enrollDetection next_step_at = enrolled_at + 1h",
    enr.next_step_at === t1 + 1 * HOUR);
  check("enrollDetection hashes customer_email",
    typeof enr.customer_email_hash === "string" && enr.customer_email_hash.length > 32);
  check("enrollDetection does NOT store raw email",
    enr.customer_email_hash !== "shopper@example.com");

  // Refuse unknown sequence.
  await assert.rejects(
    f.recovery.enrollDetection({
      sequence_slug:  "never-defined",
      cart_id:        _uuid("ca7"),
      now:            tick(),
    }),
    /not found/
  );

  // Refuse missing cart_id.
  await assert.rejects(
    f.recovery.enrollDetection({
      sequence_slug:  "enroll-test",
      now:            tick(),
    }),
    /cart_id/
  );
}

async function _dispatchTickAdvancesSteps() {
  // Mock email primitive captures every send + returns OK.
  var sends = [];
  var mockEmail = {
    sendAbandonedCartReminder: async function (input) {
      sends.push(input);
      return { ok: true };
    },
  };

  var f = _factory({ email: mockEmail });
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "advance",
    title: "Advance test",
    steps: [
      { step_index: 0, offset_ms: 1 * HOUR, kind: "reminder"    },
      { step_index: 1, offset_ms: 2 * HOUR, kind: "discount"    },
      { step_index: 2, offset_ms: 3 * HOUR, kind: "last_chance" },
    ],
    now: t0,
  });

  var enrolledAt = t0 + 100;
  var enr = await f.recovery.enrollDetection({
    sequence_slug:  "advance",
    cart_id:        _uuid("ca42"),
    customer_id:    _uuid("c042"),
    customer_email: "buyer@example.com",
    now:            enrolledAt,
  });
  check("enrollment scheduled at +1h",
    enr.next_step_at === enrolledAt + HOUR);

  // Resolver returns the email for the dispatcher.
  var resolver = async function () { return "buyer@example.com"; };

  // First tick — too early.
  var r0 = await f.recovery.dispatchTick({
    now:           enrolledAt + 30 * 60 * 1000,   // +30min
    resolveEmail:  resolver,
  });
  check("early tick dispatches nothing", r0.dispatched === 0);

  // Second tick — at +1h.
  var r1 = await f.recovery.dispatchTick({
    now:           enrolledAt + HOUR,
    resolveEmail:  resolver,
  });
  check("tick @ +1h dispatches 1", r1.dispatched === 1);
  check("step 0 dispatched", r1.rows[0].step_index === 0 && r1.rows[0].status === "sent");
  check("email primitive called once for step 0", sends.length === 1);

  var afterStep0 = await f.recovery.getEnrollment(enr.id);
  check("FSM advanced to step 1", afterStep0.current_step_index === 1);
  check("next_step_at pinned to enrolled_at + 2h",
    afterStep0.next_step_at === enrolledAt + 2 * HOUR);
  check("status still enrolled mid-sequence", afterStep0.status === "enrolled");

  // Third tick — at +2h.
  var r2 = await f.recovery.dispatchTick({
    now:           enrolledAt + 2 * HOUR,
    resolveEmail:  resolver,
  });
  check("tick @ +2h dispatches step 1", r2.dispatched === 1 && r2.rows[0].step_index === 1);

  var afterStep1 = await f.recovery.getEnrollment(enr.id);
  check("FSM advanced to step 2", afterStep1.current_step_index === 2);
  check("next_step_at pinned to enrolled_at + 3h",
    afterStep1.next_step_at === enrolledAt + 3 * HOUR);

  // Fourth tick — at +3h, last step.
  var r3 = await f.recovery.dispatchTick({
    now:           enrolledAt + 3 * HOUR,
    resolveEmail:  resolver,
  });
  check("tick @ +3h dispatches step 2", r3.dispatched === 1 && r3.rows[0].step_index === 2);

  var afterLast = await f.recovery.getEnrollment(enr.id);
  check("FSM lands `completed` after last step", afterLast.status === "completed");
  check("current_step_index advanced past last step",
    afterLast.current_step_index === 3);
  check("next_step_at NULL after completion",
    afterLast.next_step_at === null);

  // Fifth tick — nothing due.
  var r4 = await f.recovery.dispatchTick({
    now:           enrolledAt + 10 * HOUR,
    resolveEmail:  resolver,
  });
  check("tick after completion dispatches nothing", r4.dispatched === 0);

  // dispatchesForEnrollment returns 3 rows oldest-first.
  var log = await f.recovery.dispatchesForEnrollment(enr.id);
  check("dispatchesForEnrollment returns 3 rows", log.length === 3);
  check("dispatch log step_index 0/1/2",
    log[0].step_index === 0 && log[1].step_index === 1 && log[2].step_index === 2);
}

async function _dispatchTickSuppressionGate() {
  // Mock email + mock suppressions — the suppressions hit on
  // 'blocked@example.com'.
  var sends = [];
  var mockEmail = {
    sendAbandonedCartReminder: async function (input) {
      sends.push(input);
      return { ok: true };
    },
  };
  var mockSuppressions = {
    isSuppressed: async function (input) {
      if (input.email === "blocked@example.com") {
        return {
          suppressed:       true,
          suppression_type: "complaint",
          scope:            "marketing",
        };
      }
      return { suppressed: false };
    },
  };

  var f = _factory({
    email:             mockEmail,
    emailSuppressions: mockSuppressions,
  });
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "supp-test",
    title: "Suppression test",
    steps: [
      { step_index: 0, offset_ms: HOUR, kind: "reminder" },
      { step_index: 1, offset_ms: DAY,  kind: "discount" },
    ],
    now: t0,
  });

  var enrolledAt = t0 + 100;
  var enr = await f.recovery.enrollDetection({
    sequence_slug:  "supp-test",
    cart_id:        _uuid("cb1"),
    customer_id:    _uuid("cb2"),
    customer_email: "blocked@example.com",
    now:            enrolledAt,
  });

  var r = await f.recovery.dispatchTick({
    now:           enrolledAt + HOUR,
    resolveEmail:  async function () { return "blocked@example.com"; },
  });
  check("suppression tick dispatches 1 row", r.dispatched === 1);
  check("dispatch status = skipped-suppressed",
    r.rows[0].status === "skipped-suppressed");
  check("no email send happened",
    sends.length === 0);

  var post = await f.recovery.getEnrollment(enr.id);
  check("suppressed enrollment cancelled", post.status === "cancelled");
  check("next_step_at cleared on cancel", post.next_step_at === null);
}

async function _dispatchTickNoEmailSkip() {
  // No email resolver + no customer_email at enrollment → the
  // dispatcher writes skipped-no-email + cancels.
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "no-email",
    title: "No email test",
    steps: [{ step_index: 0, offset_ms: HOUR, kind: "reminder" }],
    now:   t0,
  });

  var enrolledAt = t0 + 100;
  var enr = await f.recovery.enrollDetection({
    sequence_slug: "no-email",
    cart_id:       _uuid("cc1"),
    customer_id:   _uuid("cc2"),
    // No customer_email supplied.
    now:           enrolledAt,
  });
  check("enrollment without email has null hash",
    enr.customer_email_hash === null);

  var r = await f.recovery.dispatchTick({
    now: enrolledAt + HOUR,
  });
  check("no-email tick dispatches 1 row", r.dispatched === 1);
  check("dispatch status = skipped-no-email",
    r.rows[0].status === "skipped-no-email");

  var post = await f.recovery.getEnrollment(enr.id);
  check("no-email enrollment cancelled", post.status === "cancelled");
}

async function _markRecoveredAndIdempotent() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "recov",
    title: "Recovery test",
    steps: [
      { step_index: 0, offset_ms: HOUR, kind: "reminder" },
      { step_index: 1, offset_ms: DAY,  kind: "discount" },
    ],
    now: t0,
  });

  var enrolledAt = t0 + 100;
  var enr = await f.recovery.enrollDetection({
    sequence_slug:  "recov",
    cart_id:        _uuid("cd1"),
    customer_id:    _uuid("cd2"),
    customer_email: "happy@example.com",
    now:            enrolledAt,
  });

  // Customer pays mid-sequence (before any step fires).
  var orderId = _uuid("00d");
  var rec = await f.recovery.markRecovered(enr.id, {
    order_id:     orderId,
    recovered_at: enrolledAt + 30 * 60 * 1000,
  });
  check("markRecovered returns changed=true", rec.changed === true);
  check("markRecovered status=recovered", rec.status === "recovered");

  var post = await f.recovery.getEnrollment(enr.id);
  check("enrollment terminal=recovered", post.status === "recovered");
  check("recovered_order_id persisted", post.recovered_order_id === orderId);
  check("next_step_at cleared", post.next_step_at === null);

  // Idempotent re-call.
  var rec2 = await f.recovery.markRecovered(enr.id, {
    order_id:     _uuid("0ff"),
    recovered_at: enrolledAt + DAY,
  });
  check("markRecovered idempotent: changed=false", rec2.changed === false);
  var post2 = await f.recovery.getEnrollment(enr.id);
  check("idempotent re-call keeps first order_id",
    post2.recovered_order_id === orderId);
  check("idempotent re-call keeps first recovered_at",
    post2.recovered_at === enrolledAt + 30 * 60 * 1000);

  // Dispatcher does not re-touch a recovered enrollment.
  var r = await f.recovery.dispatchTick({
    now:           enrolledAt + 100 * HOUR,
    resolveEmail:  async function () { return "happy@example.com"; },
  });
  check("dispatcher skips recovered enrollment", r.dispatched === 0);

  // markRecovered on a cancelled enrollment refuses.
  var enrC = await f.recovery.enrollDetection({
    sequence_slug:  "recov",
    cart_id:        _uuid("cd5"),
    customer_id:    _uuid("cd6"),
    customer_email: "x@example.com",
    now:            tick(),
  });
  await f.recovery.cancelEnrollment(enrC.id, {
    reason:        "operator cancelled",
    cancelled_at:  tick(),
  });
  await assert.rejects(
    f.recovery.markRecovered(enrC.id, { now: tick() }),
    /cancelled/
  );
}

async function _markRecoveredRewritesCompleted() {
  // A late-arriving order should still count as recovered even when
  // every step had already fired.
  var mockEmail = {
    sendAbandonedCartReminder: async function () { return { ok: true }; },
  };
  var f = _factory({ email: mockEmail });
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "late-recov",
    title: "Late recovery test",
    steps: [
      { step_index: 0, offset_ms: HOUR,     kind: "reminder" },
      { step_index: 1, offset_ms: 2 * HOUR, kind: "discount" },
    ],
    now: t0,
  });

  var enrolledAt = t0 + 100;
  var enr = await f.recovery.enrollDetection({
    sequence_slug:  "late-recov",
    cart_id:        _uuid("ce1"),
    customer_id:    _uuid("ce2"),
    customer_email: "late@example.com",
    now:            enrolledAt,
  });

  var resolver = async function () { return "late@example.com"; };
  await f.recovery.dispatchTick({ now: enrolledAt + HOUR,     resolveEmail: resolver });
  await f.recovery.dispatchTick({ now: enrolledAt + 2 * HOUR, resolveEmail: resolver });

  var afterAll = await f.recovery.getEnrollment(enr.id);
  check("all steps fired → completed", afterAll.status === "completed");

  var orderId = _uuid("0c0");
  await f.recovery.markRecovered(enr.id, {
    order_id:     orderId,
    recovered_at: enrolledAt + 3 * HOUR,
  });
  var afterRec = await f.recovery.getEnrollment(enr.id);
  check("recovered trumps completed", afterRec.status === "recovered");
  check("recovered_order_id persisted on rewrite",
    afterRec.recovered_order_id === orderId);
}

async function _markStepSkippedAndCancel() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "skip-test",
    title: "Skip test",
    steps: [
      { step_index: 0, offset_ms: HOUR, kind: "reminder" },
      { step_index: 1, offset_ms: DAY,  kind: "discount" },
    ],
    now: t0,
  });

  var enr = await f.recovery.enrollDetection({
    sequence_slug:  "skip-test",
    cart_id:        _uuid("cf1"),
    customer_email: "x@example.com",
    now:            tick(),
  });

  var sk = await f.recovery.markStepSkipped(enr.id, {
    step_index: 0,
    reason:     "bounce",
    skipped_at: tick(),
  });
  check("markStepSkipped changed=true", sk.changed === true);
  check("markStepSkipped status=cancelled", sk.status === "cancelled");

  var post = await f.recovery.getEnrollment(enr.id);
  check("skipped enrollment cancelled", post.status === "cancelled");
  check("cancelled_reason=bounce", post.cancelled_reason === "bounce");

  var log = await f.recovery.dispatchesForEnrollment(enr.id);
  check("skip wrote 1 dispatch row", log.length === 1);
  check("dispatch status=skipped-suppressed",
    log[0].status === "skipped-suppressed");

  // markStepSkipped on a terminal enrollment is a no-op (no error).
  var noop = await f.recovery.markStepSkipped(enr.id, {
    step_index: 1,
    reason:     "another bounce",
    skipped_at: tick(),
  });
  check("skip on terminal is no-op", noop.changed === false);
}

async function _recordStepSentDirectPath() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "direct",
    title: "Direct record test",
    steps: [
      { step_index: 0, offset_ms: HOUR, kind: "reminder" },
      { step_index: 1, offset_ms: DAY,  kind: "discount" },
    ],
    now: t0,
  });

  var enrolledAt = t0 + 100;
  var enr = await f.recovery.enrollDetection({
    sequence_slug:  "direct",
    cart_id:        _uuid("cg1"),
    customer_email: "x@example.com",
    now:            enrolledAt,
  });

  var rs = await f.recovery.recordStepSent(enr.id, {
    step_index: 0,
    sent_at:    enrolledAt + HOUR,
  });
  check("recordStepSent changed=true", rs.changed === true);
  check("recordStepSent advances to step 1", rs.next_step_index === 1);

  var post = await f.recovery.getEnrollment(enr.id);
  check("recordStepSent advances enrollment", post.current_step_index === 1);
  check("next_step_at = enrolled_at + offset[1]",
    post.next_step_at === enrolledAt + DAY);

  // Idempotent at (enrollment, step_index) pair — re-calling for an
  // already-advanced step refuses (step_index mismatch).
  await assert.rejects(
    f.recovery.recordStepSent(enr.id, {
      step_index: 0,
      sent_at:    enrolledAt + HOUR,
    }),
    /does not match/
  );

  // Last step → completed.
  await f.recovery.recordStepSent(enr.id, {
    step_index: 1,
    sent_at:    enrolledAt + DAY,
  });
  var done = await f.recovery.getEnrollment(enr.id);
  check("recordStepSent on last step → completed",
    done.status === "completed");

  // Dispatches log has 2 entries.
  var log = await f.recovery.dispatchesForEnrollment(enr.id);
  check("recordStepSent wrote 2 dispatches", log.length === 2);
  check("dispatch[0].status=sent", log[0].status === "sent");
  check("dispatch[1].status=sent", log[1].status === "sent");
}

async function _metricsForSequence() {
  var mockEmail = {
    sendAbandonedCartReminder: async function () { return { ok: true }; },
  };
  var f = _factory({ email: mockEmail });
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "metrics",
    title: "Metrics test",
    steps: [
      { step_index: 0, offset_ms: HOUR,     kind: "reminder"    },
      { step_index: 1, offset_ms: 2 * HOUR, kind: "discount"    },
    ],
    now: t0,
  });

  var resolver = async function (e) { return e.cart_id + "@example.com"; };

  // Enroll 5 carts.
  var enrollments = [];
  for (var i = 0; i < 5; i += 1) {
    var enr = await f.recovery.enrollDetection({
      sequence_slug:  "metrics",
      cart_id:        _uuid("dd" + i),
      customer_id:    _uuid("ee" + i),
      customer_email: "u" + i + "@example.com",
      now:            t0 + 100 + i,
    });
    enrollments.push(enr);
  }

  // Dispatch first step for all 5.
  await f.recovery.dispatchTick({
    now:          t0 + 100 + 5 + HOUR,
    resolveEmail: resolver,
  });

  // Recover 2 of them.
  await f.recovery.markRecovered(enrollments[0].id, {
    order_id:     _uuid("0a0"),
    recovered_at: t0 + 100 + 5 + HOUR + 60_000,
  });
  await f.recovery.markRecovered(enrollments[1].id, {
    order_id:     _uuid("0a1"),
    recovered_at: t0 + 100 + 5 + HOUR + 120_000,
  });

  // Cancel 1.
  await f.recovery.cancelEnrollment(enrollments[2].id, {
    reason:       "manual",
    cancelled_at: t0 + 100 + 5 + HOUR + 180_000,
  });

  // Finish the remaining 2 (step 1 → completed).
  await f.recovery.dispatchTick({
    now:          t0 + 100 + 5 + 2 * HOUR,
    resolveEmail: resolver,
  });

  var m = await f.recovery.metricsForSequence("metrics");
  check("metrics total=5", m.total === 5);
  check("metrics recovered=2", m.counts.recovered === 2);
  check("metrics completed=2", m.counts.completed === 2);
  check("metrics cancelled=1", m.counts.cancelled === 1);
  check("metrics enrolled=0", m.counts.enrolled === 0);
  // 2 recovered out of 5.
  check("metrics recovery_rate=0.4",
    Math.abs(m.recovery_rate - 0.4) < 1e-9);
  // Dispatch counts: first tick = 5 sends; second tick = 2 sends
  // (the 2 not-yet-terminal enrollments).
  check("metrics dispatches.sent >= 5",
    m.dispatches.sent >= 5);

  // Zero-row sequence returns recovery_rate=0 (not NaN).
  await f.recovery.defineSequence({
    slug:  "empty-metrics",
    title: "Empty",
    steps: [{ step_index: 0, offset_ms: HOUR, kind: "reminder" }],
    now:   tick(),
  });
  var mEmpty = await f.recovery.metricsForSequence("empty-metrics");
  check("empty metrics total=0", mEmpty.total === 0);
  check("empty metrics recovery_rate=0", mEmpty.recovery_rate === 0);
}

async function _enrollmentsForCustomerAndGetSequence() {
  var f = _factory();
  var tick = _clock();
  var t0 = tick();

  await f.recovery.defineSequence({
    slug:  "by-customer",
    title: "By customer",
    steps: [{ step_index: 0, offset_ms: HOUR, kind: "reminder" }],
    now:   t0,
  });

  var customerId = _uuid("cccc");
  for (var i = 0; i < 3; i += 1) {
    await f.recovery.enrollDetection({
      sequence_slug:  "by-customer",
      cart_id:        _uuid("ff" + i),
      customer_id:    customerId,
      customer_email: "x@example.com",
      now:            t0 + 100 + i,
    });
  }
  // A different customer's enrollment shouldn't surface.
  await f.recovery.enrollDetection({
    sequence_slug:  "by-customer",
    cart_id:        _uuid("11ff"),
    customer_id:    _uuid("dddd"),
    customer_email: "x@example.com",
    now:            t0 + 200,
  });

  var rows = await f.recovery.enrollmentsForCustomer(customerId);
  check("enrollmentsForCustomer returns 3 rows", rows.length === 3);
  for (var ri = 0; ri < rows.length; ri += 1) {
    check("enrollmentsForCustomer filters by customer_id",
      rows[ri].customer_id === customerId);
  }

  var got = await f.recovery.getSequence("by-customer");
  check("getSequence returns row", got && got.slug === "by-customer");

  var miss = await f.recovery.getSequence("never-defined");
  check("getSequence returns null on miss", miss === null);

  await assert.rejects(
    f.recovery.metricsForSequence("never-defined"),
    /not found/
  );
}

async function run() {
  await _defineSequenceHappy();
  await _enrollDetectionSchedulesNextStep();
  await _dispatchTickAdvancesSteps();
  await _dispatchTickSuppressionGate();
  await _dispatchTickNoEmailSkip();
  await _markRecoveredAndIdempotent();
  await _markRecoveredRewritesCompleted();
  await _markStepSkippedAndCancel();
  await _recordStepSentDirectPath();
  await _metricsForSequence();
  await _enrollmentsForCustomerAndGetSequence();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7,
  // guardUuid, crypto.namespaceHash) is wired before the first test
  // runs.
  void bShop;
  run().then(function () {
    process.stdout.write("cart-recovery.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("cart-recovery.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
