"use strict";
/**
 * paymentRetries — failure-code-aware retry orchestration for failed
 * one-time payments.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0120.
 * The primitive is a pure state-machine over its own three tables; the
 * test exercises the scheduler walk directly with a stub `payment`
 * handle that records every retryIntent call so the gates can verify
 * composition without depending on the actual payment-processor wire.
 *
 * Direct require of `lib/payment-retries.js` — the primitive isn't
 * wired into `lib/index.js` yet (entry-point edit is out of scope per
 * the constraints; same posture as dunning.test.js).
 *
 * Coverage:
 *   - defineRetryPolicy persists slug + failure_code + schedule + caps;
 *     upsert on second call
 *   - enrollFailure picks the right policy by failure_code; explicit
 *     policy_slug override works; invalid_card-style terminal-at-
 *     enrollment short-circuit closes the row as abandoned; idempotent
 *     replay returns the existing row
 *   - tickRetries advances active enrollments whose next_retry_at is
 *     due; calls into the injected payment handle; skips not-yet-due
 *     and non-active rows
 *   - recordRetryOutcome(succeeded=true) closes as recovered;
 *     recordRetryOutcome(succeeded=false) advances + applies max_attempts
 *     cap → exhausted
 *   - statusForPayment + historyForPayment surface the enrollment row
 *     + attempt log
 *   - metricsForPolicy aggregates over the [from, to] window with
 *     recovery + exhaustion rates
 *   - policiesForFailureCode lists active policies for a failure_code
 *   - unenrollPayment recovery-reason → recovered; generic reason →
 *     abandoned
 *   - validation refusals: bad slug, bad failure_code, bad schedule
 *     element, bad cap, missing policy, archived policy, non-uuid
 *     payment_intent_id, non-boolean succeeded, non-positive `now`,
 *     from > to
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var paymentRetries = require("../../lib/payment-retries");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0120_payment_retries.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// Stub `payment` handle. Defaults to "the retry failed" so the
// scheduler advances state through the schedule; per-call overrides
// let individual gates drive success / specific failure codes.
function _stubPayment(opts) {
  opts = opts || {};
  var nextResult = opts.defaultResult || { succeeded: false, failure_code: "card_declined" };
  var calls = [];
  return {
    calls: calls,
    setNextResult: function (r) { nextResult = r; },
    handle: {
      retryIntent: async function (input) {
        calls.push({ method: "retryIntent", input: input });
        return nextResult;
      },
    },
  };
}

function _setup(stubOpts) {
  var q = _makeQuery();
  var pay = _stubPayment(stubOpts);
  var pr = paymentRetries.create({
    query:   q,
    payment: pay.handle,
  });
  return { query: q, pr: pr, payment: pay };
}

// ---- defineRetryPolicy + enrollFailure picks by failure_code ------------

async function _definePolicyAndEnroll() {
  var ctx = _setup();
  var policy = await ctx.pr.defineRetryPolicy({
    slug:                    "default-insufficient-funds",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24, 48],
    max_attempts:            2,
    terminal_after_attempts: 0,
  });
  check("defineRetryPolicy returns row",       typeof policy === "object" && policy != null);
  check("defineRetryPolicy persists slug",     policy.slug === "default-insufficient-funds");
  check("defineRetryPolicy persists failure_code",
    policy.failure_code === "insufficient_funds");
  check("defineRetryPolicy persists max_attempts",
    Number(policy.max_attempts) === 2);
  check("defineRetryPolicy persists terminal cap",
    Number(policy.terminal_after_attempts) === 0);
  check("defineRetryPolicy stores schedule JSON",
    typeof policy.retry_schedule_json === "string" && policy.retry_schedule_json.length > 0);

  // Upsert: redefining the same slug updates the schedule + cap.
  var rewritten = await ctx.pr.defineRetryPolicy({
    slug:                    "default-insufficient-funds",
    failure_code:            "insufficient_funds",
    retry_schedule:          [12],
    max_attempts:            1,
    terminal_after_attempts: 0,
  });
  check("defineRetryPolicy upserts schedule",
    rewritten.retry_schedule_json !== policy.retry_schedule_json);
  check("defineRetryPolicy upserts max_attempts",
    Number(rewritten.max_attempts) === 1);

  // Re-define the canonical 2-step shape for the rest of the suite.
  await ctx.pr.defineRetryPolicy({
    slug:                    "default-insufficient-funds",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24, 48],
    max_attempts:            2,
    terminal_after_attempts: 0,
  });

  // Define a card_declined policy too, so enrollFailure has to pick
  // the right one by failure_code (not by recency-of-define).
  await ctx.pr.defineRetryPolicy({
    slug:                    "default-card-declined",
    failure_code:            "card_declined",
    retry_schedule:          [168],
    max_attempts:            1,
    terminal_after_attempts: 0,
  });

  // Enroll a failure with code `insufficient_funds` — the picker
  // should match `default-insufficient-funds`, NOT
  // `default-card-declined` (most-recently-updated overall).
  var piId = _uuid();
  var orderId = _uuid();
  var customerId = _uuid();
  var enrollment = await ctx.pr.enrollFailure({
    payment_intent_id: piId,
    order_id:          orderId,
    customer_id:       customerId,
    failure_code:      "insufficient_funds",
  });
  check("enrollFailure returns row",
    typeof enrollment.id === "string" && enrollment.id.length > 0);
  check("enrollFailure persists payment_intent_id", enrollment.payment_intent_id === piId);
  check("enrollFailure persists order_id",          enrollment.order_id === orderId);
  check("enrollFailure persists customer_id",       enrollment.customer_id === customerId);
  check("enrollFailure picks policy by failure_code",
    enrollment.policy_slug === "default-insufficient-funds");
  check("enrollFailure starts in active", enrollment.status === "active");
  check("enrollFailure attempt_count starts at 1 (initial failure)",
    Number(enrollment.attempt_count) === 1);
  check("enrollFailure stamps last_failure_code",
    enrollment.last_failure_code === "insufficient_funds");
  // next_retry_at is created_at + 24h.
  check("enrollFailure next_retry_at is created_at + 24h",
    typeof enrollment.next_retry_at === "number" &&
    enrollment.next_retry_at - enrollment.created_at === 24 * 60 * 60 * 1000);

  // Idempotent replay — UNIQUE (payment_intent_id) would refuse a
  // second insert; the primitive short-circuits to the existing row.
  var replay = await ctx.pr.enrollFailure({
    payment_intent_id: piId,
    order_id:          orderId,
    failure_code:      "insufficient_funds",
  });
  check("enrollFailure replay returns existing id", replay.id === enrollment.id);

  // Unknown failure_code refused.
  await assert.rejects(ctx.pr.enrollFailure({
    payment_intent_id: _uuid(),
    order_id:          _uuid(),
    failure_code:      "no_policy_for_this_one",
  }), /no policy for failure_code/);
}

// ---- invalid_card terminal-at-enrollment short-circuit -----------------

async function _terminalAtEnrollment() {
  var ctx = _setup();
  await ctx.pr.defineRetryPolicy({
    slug:                    "default-invalid-card",
    failure_code:            "invalid_card",
    retry_schedule:          [],
    max_attempts:            1,
    terminal_after_attempts: 1,
  });

  var piId    = _uuid();
  var orderId = _uuid();
  var enrolled = await ctx.pr.enrollFailure({
    payment_intent_id: piId,
    order_id:          orderId,
    failure_code:      "invalid_card",
  });
  check("invalid_card enrollment closes as abandoned", enrolled.status === "abandoned");
  check("invalid_card stamps ended_at", typeof enrolled.ended_at === "number");
  check("invalid_card end_reason", enrolled.end_reason === "terminal_failure_code");
  check("invalid_card next_retry_at is null", enrolled.next_retry_at == null);

  // History records the initial failure as attempt #1.
  var history = await ctx.pr.historyForPayment(piId);
  check("invalid_card history has 1 attempt", history.length === 1);
  check("invalid_card history attempt failed", Number(history[0].succeeded) === 0);
  check("invalid_card history failure_code",  history[0].failure_code === "invalid_card");

  // tickRetries doesn't touch an abandoned row.
  var noop = await ctx.pr.tickRetries({ now: Date.now() + 365 * 24 * 60 * 60 * 1000 });
  check("tickRetries ignores abandoned enrollments", noop.length === 0);
}

// ---- tickRetries advances state ----------------------------------------

async function _tickAdvancesState() {
  var ctx = _setup();
  await ctx.pr.defineRetryPolicy({
    slug:                    "fast-retry",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24, 48],
    max_attempts:            3,
    terminal_after_attempts: 0,
  });

  var piId    = _uuid();
  var orderId = _uuid();
  var startTs = Date.now();
  var enrolled = await ctx.pr.enrollFailure({
    payment_intent_id: piId,
    order_id:          orderId,
    failure_code:      "insufficient_funds",
    occurred_at:       startTs,
  });
  check("enrollFailure schedules first retry +24h",
    enrolled.next_retry_at === startTs + 24 * 60 * 60 * 1000);

  // First tick BEFORE the next retry is due — nothing advances.
  var earlyTick = startTs + 60 * 1000;
  var noop = await ctx.pr.tickRetries({ now: earlyTick });
  check("tickRetries skips non-due enrollments", noop.length === 0);
  check("tickRetries did not call payment handle", ctx.payment.calls.length === 0);

  // First tick AT the due time (+24h). The stub returns
  // succeeded=false, so the row stays active + schedules the next
  // retry (+48h).
  var dueTick = startTs + 24 * 60 * 60 * 1000 + 1000;
  var advanced = await ctx.pr.tickRetries({ now: dueTick });
  check("tickRetries advances 1 enrollment",     advanced.length === 1);
  check("tickRetries bumps attempt_count to 2",  Number(advanced[0].attempt_count) === 2);
  check("tickRetries stays active after retry",  advanced[0].status === "active");
  check("tickRetries hit payment handle",        ctx.payment.calls.length === 1);
  check("retryIntent carries payment_intent_id",
    ctx.payment.calls[0].input.payment_intent_id === piId);
  check("retryIntent carries order_id",
    ctx.payment.calls[0].input.order_id === orderId);
  check("retryIntent carries attempt_number 2",
    ctx.payment.calls[0].input.attempt_number === 2);
  check("tickRetries schedules next retry +48h",
    advanced[0].next_retry_at === dueTick + 48 * 60 * 60 * 1000);
}

// ---- recovery path ----------------------------------------------------

async function _recoveryPath() {
  var ctx = _setup();
  await ctx.pr.defineRetryPolicy({
    slug:                    "recovery-policy",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24, 48],
    max_attempts:            3,
    terminal_after_attempts: 0,
  });

  // Recovery via tickRetries when the processor stub returns success.
  ctx.payment.setNextResult({ succeeded: true });
  var piId1   = _uuid();
  var enrolled1 = await ctx.pr.enrollFailure({
    payment_intent_id: piId1,
    order_id:          _uuid(),
    failure_code:      "insufficient_funds",
  });
  var dueTick = enrolled1.next_retry_at + 1000;
  var advanced = await ctx.pr.tickRetries({ now: dueTick });
  check("tickRetries success closes as recovered", advanced[0].status === "recovered");
  check("tickRetries success stamps end_reason",   advanced[0].end_reason === "retry_succeeded");
  check("tickRetries success clears next_retry_at", advanced[0].next_retry_at == null);
  check("tickRetries success clears last_failure_code", advanced[0].last_failure_code == null);

  // Recovery via recordRetryOutcome (operator drove the retry out-of-band).
  ctx.payment.setNextResult({ succeeded: false, failure_code: "card_declined" });
  var piId2 = _uuid();
  var enrolled2 = await ctx.pr.enrollFailure({
    payment_intent_id: piId2,
    order_id:          _uuid(),
    failure_code:      "insufficient_funds",
  });
  var outcome = await ctx.pr.recordRetryOutcome({
    retry_id:  enrolled2.id,
    succeeded: true,
  });
  check("recordRetryOutcome success → recovered", outcome.status === "recovered");
  check("recordRetryOutcome success stamps end_reason",
    outcome.end_reason === "retry_succeeded");

  // history records the success.
  var history = await ctx.pr.historyForPayment(piId2);
  check("history captures the success attempt",
    history.some(function (h) { return Number(h.succeeded) === 1; }));

  // Recovery via unenrollPayment(reason=paid_out_of_band).
  var piId3 = _uuid();
  await ctx.pr.enrollFailure({
    payment_intent_id: piId3,
    order_id:          _uuid(),
    failure_code:      "insufficient_funds",
  });
  var unenrolled = await ctx.pr.unenrollPayment({
    payment_intent_id: piId3,
    reason:            "paid_out_of_band",
  });
  check("unenrollPayment recovery reason → recovered",
    unenrolled.status === "recovered");
  check("unenrollPayment generic reason → abandoned",
    (await (async function () {
      var pi = _uuid();
      await ctx.pr.enrollFailure({
        payment_intent_id: pi,
        order_id:          _uuid(),
        failure_code:      "insufficient_funds",
      });
      var u = await ctx.pr.unenrollPayment({
        payment_intent_id: pi,
        reason:            "operator_wrote_off",
      });
      return u.status;
    })()) === "abandoned");
}

// ---- exhaustion path ---------------------------------------------------

async function _exhaustionPath() {
  var ctx = _setup();
  await ctx.pr.defineRetryPolicy({
    slug:                    "exhaust-policy",
    failure_code:            "card_declined",
    retry_schedule:          [168],
    max_attempts:            2,
    terminal_after_attempts: 0,
  });

  var piId = _uuid();
  var startTs = Date.now();
  await ctx.pr.enrollFailure({
    payment_intent_id: piId,
    order_id:          _uuid(),
    failure_code:      "card_declined",
    occurred_at:       startTs,
  });

  // The schedule has one retry; max_attempts is 2 (initial counts as
  // #1, the scheduled retry is #2). After the tick fires the retry
  // (and the stub returns failure), the cap (#2) is reached → row
  // closes as exhausted.
  ctx.payment.setNextResult({ succeeded: false, failure_code: "card_declined" });
  var dueTick = startTs + 168 * 60 * 60 * 1000 + 1000;
  var advanced = await ctx.pr.tickRetries({ now: dueTick });
  check("exhaustion: tick closes as exhausted", advanced[0].status === "exhausted");
  check("exhaustion: stamps end_reason max_attempts",
    advanced[0].end_reason === "max_attempts");
  check("exhaustion: attempt_count = max",
    Number(advanced[0].attempt_count) === 2);
  check("exhaustion: ended_at stamped",   typeof advanced[0].ended_at === "number");
  check("exhaustion: next_retry_at null", advanced[0].next_retry_at == null);

  // Exhaustion via recordRetryOutcome when schedule walks off the end.
  await ctx.pr.defineRetryPolicy({
    slug:                    "schedule-exhaust",
    failure_code:            "card_declined",
    retry_schedule:          [1],
    max_attempts:            10,
    terminal_after_attempts: 0,
  });
  var piId2 = _uuid();
  var enrolled2 = await ctx.pr.enrollFailure({
    payment_intent_id: piId2,
    order_id:          _uuid(),
    failure_code:      "card_declined",
    policy_slug:       "schedule-exhaust",
  });
  var outcome = await ctx.pr.recordRetryOutcome({
    retry_id:         enrolled2.id,
    succeeded:        false,
    new_failure_code: "card_declined",
  });
  check("schedule-exhaust: closes as exhausted", outcome.status === "exhausted");
  check("schedule-exhaust: end_reason schedule_exhausted",
    outcome.end_reason === "schedule_exhausted");
}

// ---- statusForPayment + historyForPayment ------------------------------

async function _statusAndHistory() {
  var ctx = _setup();
  await ctx.pr.defineRetryPolicy({
    slug:                    "status-policy",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24],
    max_attempts:            3,
    terminal_after_attempts: 0,
  });

  var piId = _uuid();
  var enrolled = await ctx.pr.enrollFailure({
    payment_intent_id: piId,
    order_id:          _uuid(),
    failure_code:      "insufficient_funds",
  });

  var status = await ctx.pr.statusForPayment(piId);
  check("statusForPayment returns row",            status != null);
  check("statusForPayment mirrors enrollment id",  status.id === enrolled.id);
  check("statusForPayment status active",          status.status === "active");

  // Unknown payment returns null (not an error — operators poll this
  // surface and would prefer "no enrollment" over a thrown).
  var missing = await ctx.pr.statusForPayment(_uuid());
  check("statusForPayment unknown returns null",   missing == null);

  // historyForPayment after enrollment shows the initial failure.
  var history0 = await ctx.pr.historyForPayment(piId);
  check("history after enroll has 1 attempt",      history0.length === 1);
  check("history attempt #1 failed",               Number(history0[0].succeeded) === 0);
  check("history attempt #1 failure_code",         history0[0].failure_code === "insufficient_funds");
  check("history attempt_number is 1",             Number(history0[0].attempt_number) === 1);

  // Drive a recordRetryOutcome and confirm history grows.
  await ctx.pr.recordRetryOutcome({
    retry_id:         enrolled.id,
    succeeded:        false,
    new_failure_code: "card_declined",
  });
  var history1 = await ctx.pr.historyForPayment(piId);
  check("history after second attempt has 2 rows", history1.length === 2);
  // Monotonic clock guarantees strictly-increasing occurred_at
  // even when wall clock has 1ms resolution.
  check("history occurred_at strictly increasing",
    history1[1].occurred_at > history1[0].occurred_at);

  // historyForPayment for an unknown payment returns [].
  var emptyHistory = await ctx.pr.historyForPayment(_uuid());
  check("history for unknown payment is empty",    emptyHistory.length === 0);
}

// ---- metricsForPolicy + policiesForFailureCode -------------------------

async function _metricsAndLookup() {
  var ctx = _setup();
  await ctx.pr.defineRetryPolicy({
    slug:                    "metrics-policy",
    failure_code:            "insufficient_funds",
    retry_schedule:          [1],
    max_attempts:            2,
    terminal_after_attempts: 0,
  });
  // A second active policy + an archived one for the same failure
  // code, to drive policiesForFailureCode.
  await ctx.pr.defineRetryPolicy({
    slug:                    "alt-metrics-policy",
    failure_code:            "insufficient_funds",
    retry_schedule:          [2],
    max_attempts:            2,
    terminal_after_attempts: 0,
  });
  await ctx.pr.defineRetryPolicy({
    slug:                    "archived-policy",
    failure_code:            "insufficient_funds",
    retry_schedule:          [3],
    max_attempts:            2,
    terminal_after_attempts: 0,
  });
  await ctx.query(
    "UPDATE payment_retry_policies SET archived_at = ?1 WHERE slug = ?2",
    [Date.now(), "archived-policy"],
  );

  // policiesForFailureCode returns the two non-archived ones.
  var pols = await ctx.pr.policiesForFailureCode("insufficient_funds");
  check("policiesForFailureCode returns 2 active policies", pols.length === 2);
  check("policiesForFailureCode excludes archived",
    pols.every(function (p) { return p.archived_at == null; }));

  // Build a known distribution against `metrics-policy`:
  //   5 enrollments. 2 recovered, 1 exhausted, 1 abandoned, 1 active.
  var from = Date.now() - 1000;
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var pi = _uuid();
    ids.push(pi);
    await ctx.pr.enrollFailure({
      payment_intent_id: pi,
      order_id:          _uuid(),
      failure_code:      "insufficient_funds",
      policy_slug:       "metrics-policy",
    });
  }
  // Recover ids[0] + ids[1].
  await ctx.pr.unenrollPayment({ payment_intent_id: ids[0], reason: "paid_out_of_band" });
  await ctx.pr.unenrollPayment({ payment_intent_id: ids[1], reason: "processor_recovered" });
  // Abandon ids[3] (generic operator reason).
  await ctx.pr.unenrollPayment({ payment_intent_id: ids[3], reason: "operator_wrote_off" });
  // ids[4] stays active — push its next_retry_at into the future so
  // it doesn't accidentally tick.
  await ctx.query(
    "UPDATE payment_retry_enrollments SET next_retry_at = ?1 WHERE payment_intent_id = ?2",
    [Date.now() + 365 * 24 * 60 * 60 * 1000, ids[4]],
  );
  // Drive ids[2] through to exhausted via recordRetryOutcome (cap=2,
  // attempt_count starts at 1, so the next failure hits the cap).
  var enrolled2 = await ctx.pr.statusForPayment(ids[2]);
  await ctx.pr.recordRetryOutcome({
    retry_id:         enrolled2.id,
    succeeded:        false,
    new_failure_code: "card_declined",
  });

  var to = Date.now() + 1000;
  var metrics = await ctx.pr.metricsForPolicy({
    slug: "metrics-policy",
    from: from,
    to:   to,
  });
  check("metrics policy_slug",         metrics.policy_slug === "metrics-policy");
  check("metrics total_enrolled = 5",  metrics.total_enrolled === 5);
  check("metrics recovered = 2",       metrics.recovered === 2);
  check("metrics exhausted = 1",       metrics.exhausted === 1);
  check("metrics abandoned = 1",       metrics.abandoned === 1);
  check("metrics active = 1",          metrics.active === 1);
  check("metrics recovery_rate = 0.4",
    Math.abs(metrics.recovery_rate - 0.4) < 1e-9);
  check("metrics exhaustion_rate = 0.2",
    Math.abs(metrics.exhaustion_rate - 0.2) < 1e-9);

  // Empty window → zero rates without divide-by-zero.
  var empty = await ctx.pr.metricsForPolicy({
    slug: "metrics-policy",
    from: 1,
    to:   2,
  });
  check("metrics empty window total_enrolled = 0", empty.total_enrolled === 0);
  check("metrics empty window recovery_rate = 0",  empty.recovery_rate === 0);
  check("metrics empty window exhaustion_rate = 0", empty.exhaustion_rate === 0);
}

// ---- validation refusals -----------------------------------------------

async function _validationRefusals() {
  var ctx = _setup();

  // Bad slug shapes.
  await assert.rejects(ctx.pr.defineRetryPolicy({
    slug:                    "Bad Slug",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24],
    max_attempts:            1,
    terminal_after_attempts: 0,
  }), /slug must match/);

  await assert.rejects(ctx.pr.defineRetryPolicy({
    slug:                    "",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24],
    max_attempts:            1,
    terminal_after_attempts: 0,
  }), /slug must be a non-empty string/);

  // Bad failure_code.
  await assert.rejects(ctx.pr.defineRetryPolicy({
    slug:                    "bad-fc",
    failure_code:            "Bad FC",
    retry_schedule:          [24],
    max_attempts:            1,
    terminal_after_attempts: 0,
  }), /failure_code must match/);

  // Bad schedule element.
  await assert.rejects(ctx.pr.defineRetryPolicy({
    slug:                    "bad-schedule",
    failure_code:            "insufficient_funds",
    retry_schedule:          [-1],
    max_attempts:            1,
    terminal_after_attempts: 0,
  }), /retry_schedule\[0\] must be an integer/);

  // Schedule not an array.
  await assert.rejects(ctx.pr.defineRetryPolicy({
    slug:                    "not-array",
    failure_code:            "insufficient_funds",
    retry_schedule:          "nope",
    max_attempts:            1,
    terminal_after_attempts: 0,
  }), /retry_schedule must be an array/);

  // Bad max_attempts.
  await assert.rejects(ctx.pr.defineRetryPolicy({
    slug:                    "bad-max",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24],
    max_attempts:            0,
    terminal_after_attempts: 0,
  }), /max_attempts must be an integer/);

  // Bad terminal_after_attempts.
  await assert.rejects(ctx.pr.defineRetryPolicy({
    slug:                    "bad-term",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24],
    max_attempts:            1,
    terminal_after_attempts: -1,
  }), /terminal_after_attempts must be an integer/);

  // Define a valid policy for the rest.
  await ctx.pr.defineRetryPolicy({
    slug:                    "valid",
    failure_code:            "insufficient_funds",
    retry_schedule:          [24],
    max_attempts:            1,
    terminal_after_attempts: 0,
  });

  // Bad payment_intent_id on enrollFailure.
  await assert.rejects(ctx.pr.enrollFailure({
    payment_intent_id: "not-a-uuid",
    order_id:          _uuid(),
    failure_code:      "insufficient_funds",
  }), /payment_intent_id/);

  // Bad order_id on enrollFailure.
  await assert.rejects(ctx.pr.enrollFailure({
    payment_intent_id: _uuid(),
    order_id:          "not-a-uuid",
    failure_code:      "insufficient_funds",
  }), /order_id/);

  // Archived policy refused on explicit slug enrollFailure.
  await ctx.query(
    "UPDATE payment_retry_policies SET archived_at = ?1 WHERE slug = ?2",
    [Date.now(), "valid"],
  );
  await assert.rejects(ctx.pr.enrollFailure({
    payment_intent_id: _uuid(),
    order_id:          _uuid(),
    failure_code:      "insufficient_funds",
    policy_slug:       "valid",
  }), /is archived/);

  // Unknown explicit policy_slug refused.
  await assert.rejects(ctx.pr.enrollFailure({
    payment_intent_id: _uuid(),
    order_id:          _uuid(),
    failure_code:      "insufficient_funds",
    policy_slug:       "no-such-policy",
  }), /not found/);

  // Non-boolean succeeded.
  await assert.rejects(ctx.pr.recordRetryOutcome({
    retry_id:  _uuid(),
    succeeded: "yes",
  }), /succeeded must be a boolean/);

  // Unknown retry_id on recordRetryOutcome.
  await assert.rejects(ctx.pr.recordRetryOutcome({
    retry_id:  _uuid(),
    succeeded: true,
  }), /not found/);

  // unenrollPayment on a missing payment.
  await assert.rejects(ctx.pr.unenrollPayment({
    payment_intent_id: _uuid(),
    reason:            "paid",
  }), /has no enrollment/);

  // Reason with control bytes refused.
  await assert.rejects(ctx.pr.unenrollPayment({
    payment_intent_id: _uuid(),
    reason:            "bad\x00reason",
  }), /control \/ zero-width bytes/);

  // tickRetries requires a numeric `now`.
  await assert.rejects(ctx.pr.tickRetries({ now: "later" }), /must be a positive integer/);

  // metricsForPolicy requires from <= to.
  await assert.rejects(ctx.pr.metricsForPolicy({
    slug: "valid",
    from: 100,
    to:   50,
  }), /from must be <= to/);

  // bShop reachable — surfaces any wiring bug in the require chain.
  check("bShop framework reachable",
    bShop && bShop.framework && typeof bShop.framework.uuid === "object");
}

// ---- driver ------------------------------------------------------------

async function run() {
  await _definePolicyAndEnroll();
  await _terminalAtEnrollment();
  await _tickAdvancesState();
  await _recoveryPath();
  await _exhaustionPath();
  await _statusAndHistory();
  await _metricsAndLookup();
  await _validationRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - payment-retries (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
