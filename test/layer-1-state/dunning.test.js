"use strict";
/**
 * dunning — operator-defined retry/escalation policy for failed
 * subscription invoices.
 *
 * Layer 1 against in-memory node:sqlite. The dunning primitive is a
 * pure state-machine over its own three tables; the test exercises
 * the scheduler walk directly with stub email + notification handles
 * + a stub billing handle that records the side-effect calls it
 * receives so the gates can verify composition.
 *
 * Direct require of `lib/dunning.js` — the primitive isn't wired into
 * `lib/index.js` yet (the entry-point edit is forbidden by the
 * constraints; the test gate exists ahead of the entry-point wire,
 * the same posture as subscription-billing.test.js).
 *
 * Coverage:
 *   - defineDunningPolicy creates + upserts on second call
 *   - enrollInvoice writes a row + computes next_action_at from
 *     step 0's delay_hours; idempotent on replay
 *   - tickDunning advances enrollments whose next_action_at is due,
 *     skips those that aren't; each advance writes a dunning_events
 *     row + bumps attempt_count
 *   - retry-success path: unsetEnrollment("paid_out_of_band") marks
 *     the enrollment recovered (driven by metricsForPolicy's recovery
 *     rate)
 *   - attempt-cap path: a schedule that doesn't include
 *     cancel_subscription still terminates at cancel_after_attempts
 *   - metricsForPolicy aggregates over the [from, to] window with
 *     recovery + cancellation rates
 *   - composition: tickDunning calls into the injected
 *     subscriptionBilling + email + notifications handles
 *   - validation refusals: bad slug, bad action, bad delay,
 *     missing policy, archived policy, bad invoice UUID
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var dunning = require("../../lib/dunning");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0077_dunning.sql",
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
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _stubBilling(invoicesById) {
  // Stub `subscriptionBilling` handle. Records every call into the
  // `calls` array so gates can verify composition + invoice
  // resolution. `_getInvoiceForDunning` is the optional extension
  // hook the dunning primitive looks up.
  var calls = [];
  return {
    calls: calls,
    recordPaymentAttempt: async function (input) {
      calls.push({ method: "recordPaymentAttempt", input: input });
      return { ok: true };
    },
    enterDunning: async function (input) {
      calls.push({ method: "enterDunning", input: input });
      return { id: _uuid() };
    },
    exitDunning: async function (input) {
      calls.push({ method: "exitDunning", input: input });
      return { id: _uuid() };
    },
    _getInvoiceForDunning: async function (invoiceId) {
      calls.push({ method: "_getInvoiceForDunning", input: invoiceId });
      return invoicesById[invoiceId] || null;
    },
  };
}

function _stubEmail() {
  var calls = [];
  return {
    calls: calls,
    sendDunningReminder: async function (input) {
      calls.push({ method: "sendDunningReminder", input: input });
      return { id: _uuid() };
    },
  };
}

function _stubNotifications() {
  var calls = [];
  return {
    calls: calls,
    enqueue: async function (input) {
      calls.push({ method: "enqueue", input: input });
      return { ok: true, id: _uuid() };
    },
  };
}

function _setup() {
  var q = _makeQuery();
  var invoicesById = {};
  var billing = _stubBilling(invoicesById);
  var email   = _stubEmail();
  var notif   = _stubNotifications();
  var dun = dunning.create({
    query:               q,
    subscriptionBilling: billing,
    email:               email,
    notifications:       notif,
  });
  return {
    query:        q,
    dun:          dun,
    billing:      billing,
    email:        email,
    notifications:notif,
    invoicesById: invoicesById,
  };
}

// ---- defineDunningPolicy + enrollInvoice -------------------------------

async function _definePolicyAndEnroll() {
  var ctx = _setup();
  var policy = await ctx.dun.defineDunningPolicy({
    slug: "default-3-step",
    retry_schedule: [
      { delay_hours: 0,  action: "send_reminder" },
      { delay_hours: 24, action: "retry_charge"  },
      { delay_hours: 48, action: "send_reminder" },
    ],
    cancel_after_attempts: 3,
  });
  check("defineDunningPolicy returns row",       typeof policy === "object" && policy != null);
  check("defineDunningPolicy persists slug",     policy.slug === "default-3-step");
  check("defineDunningPolicy persists cap",      Number(policy.cancel_after_attempts) === 3);
  check("defineDunningPolicy stores schedule JSON",
    typeof policy.retry_schedule_json === "string" && policy.retry_schedule_json.length > 0);

  // Upsert: redefining the same slug updates the schedule + cap.
  var rewritten = await ctx.dun.defineDunningPolicy({
    slug: "default-3-step",
    retry_schedule: [
      { delay_hours: 1, action: "send_reminder" },
      { delay_hours: 2, action: "retry_charge"  },
    ],
    cancel_after_attempts: 5,
  });
  check("defineDunningPolicy upserts cap", Number(rewritten.cancel_after_attempts) === 5);
  check("defineDunningPolicy upserts schedule",
    rewritten.retry_schedule_json !== policy.retry_schedule_json);

  // Re-define with the canonical 3-step schedule for the rest of
  // the suite (subsequent gates rely on that shape).
  await ctx.dun.defineDunningPolicy({
    slug: "default-3-step",
    retry_schedule: [
      { delay_hours: 0,  action: "send_reminder" },
      { delay_hours: 24, action: "retry_charge"  },
      { delay_hours: 48, action: "send_reminder" },
    ],
    cancel_after_attempts: 3,
  });

  var invoiceId = _uuid();
  var enrollment = await ctx.dun.enrollInvoice({
    invoice_id:  invoiceId,
    policy_slug: "default-3-step",
  });
  check("enrollInvoice returns row",                typeof enrollment.id === "string" && enrollment.id.length > 0);
  check("enrollInvoice persists invoice_id",        enrollment.invoice_id === invoiceId);
  check("enrollInvoice persists policy_slug",       enrollment.policy_slug === "default-3-step");
  check("enrollInvoice starts in active",           enrollment.status === "active");
  check("enrollInvoice attempt_count is 0",         Number(enrollment.attempt_count) === 0);
  check("enrollInvoice next_action_at near now",
    typeof enrollment.next_action_at === "number" &&
    enrollment.next_action_at > Date.now() - 10000 &&
    enrollment.next_action_at < Date.now() + 10000);

  // Idempotent replay — the UNIQUE (invoice_id) constraint would
  // refuse a second insert; the primitive short-circuits to the
  // existing row.
  var replay = await ctx.dun.enrollInvoice({
    invoice_id:  invoiceId,
    policy_slug: "default-3-step",
  });
  check("enrollInvoice replay returns existing id", replay.id === enrollment.id);

  // Unknown policy refused.
  await assert.rejects(ctx.dun.enrollInvoice({
    invoice_id:  _uuid(),
    policy_slug: "nope-not-defined",
  }), /not found/);
}

// ---- tickDunning: advance state ----------------------------------------

async function _tickAdvancesState() {
  var ctx = _setup();
  await ctx.dun.defineDunningPolicy({
    slug: "step-policy",
    retry_schedule: [
      { delay_hours: 0,  action: "send_reminder" },
      { delay_hours: 24, action: "retry_charge"  },
    ],
    cancel_after_attempts: 4,
  });

  var invoiceId = _uuid();
  var subscriptionId = _uuid();
  ctx.invoicesById[invoiceId] = {
    id:              invoiceId,
    subscription_id: subscriptionId,
  };

  await ctx.dun.enrollInvoice({
    invoice_id:  invoiceId,
    policy_slug: "step-policy",
  });

  // First tick: next_action_at is `now + 0h` so it's due. The
  // schedule's first action is `send_reminder` — email +
  // notifications stubs should both be hit.
  var firstTick = Date.now() + 1000;
  var advanced = await ctx.dun.tickDunning({ now: firstTick });
  check("tickDunning advances 1 enrollment", advanced.length === 1);
  check("tickDunning bumps attempt_count to 1", Number(advanced[0].attempt_count) === 1);
  check("tickDunning records last_action",       advanced[0].last_action === "send_reminder");
  check("tickDunning still active after 1 step", advanced[0].status === "active");
  check("send_reminder hit email stub",  ctx.email.calls.length === 1);
  check("send_reminder hit notifications stub", ctx.notifications.calls.length === 1);
  check("email call carries invoice_id",
    ctx.email.calls[0].input.invoice_id === invoiceId);
  check("notification call carries event_type",
    ctx.notifications.calls[0].input.event_type === "dunning.reminder");

  // Second tick BEFORE the next step is due — nothing advances.
  var earlyTick = firstTick + 60 * 1000;   // +1 minute
  var noop = await ctx.dun.tickDunning({ now: earlyTick });
  check("tickDunning skips non-due enrollments", noop.length === 0);

  // Second tick AT the due time (+24h) — retry_charge fires.
  var dueTick = firstTick + 24 * 60 * 60 * 1000 + 1000;
  var advanced2 = await ctx.dun.tickDunning({ now: dueTick });
  check("tickDunning advances second step", advanced2.length === 1);
  check("retry_charge bumps attempt_count to 2", Number(advanced2[0].attempt_count) === 2);
  check("retry_charge recorded as last_action",  advanced2[0].last_action === "retry_charge");
  check("retry_charge hit billing stub",
    ctx.billing.calls.some(function (c) { return c.method === "recordPaymentAttempt"; }));

  // History accumulates one event per step.
  var history = await ctx.dun.historyForInvoice(invoiceId);
  check("historyForInvoice has 2 events",        history.length === 2);
  check("history step 0 is send_reminder",       history[0].action === "send_reminder");
  check("history step 1 is retry_charge",        history[1].action === "retry_charge");
  check("history outcomes are ok",               history.every(function (h) { return h.outcome === "ok"; }));
}

// ---- concurrency: two ticks on the same due row fire ONCE --------------

async function _concurrentTickFiresOnce() {
  var ctx = _setup();
  await ctx.dun.defineDunningPolicy({
    slug: "race-policy",
    retry_schedule: [
      { delay_hours: 0,  action: "send_reminder" },
      { delay_hours: 24, action: "retry_charge"  },
    ],
    cancel_after_attempts: 4,
  });

  var invoiceId = _uuid();
  ctx.invoicesById[invoiceId] = { id: invoiceId, subscription_id: _uuid() };
  await ctx.dun.enrollInvoice({ invoice_id: invoiceId, policy_slug: "race-policy" });

  // Two ticks fire concurrently against the SAME due enrollment (an
  // overlapping cron fire, or a manual tick racing the scheduler).
  // The atomic claim must let exactly one advance the row; the loser
  // skips so the customer is emailed + notified ONCE, not twice.
  var now = Date.now() + 1000;
  var results = await Promise.all([
    ctx.dun.tickDunning({ now: now }),
    ctx.dun.tickDunning({ now: now }),
  ]);

  var status = await ctx.dun.statusForInvoice(invoiceId);
  check("concurrent ticks advance attempt_count exactly once",
    Number(status.attempt_count) === 1);
  check("concurrent ticks fire send_reminder email exactly once",
    ctx.email.calls.length === 1);
  check("concurrent ticks fire in-app notification exactly once",
    ctx.notifications.calls.length === 1);

  // Exactly one dunning_events row was written for the step — the
  // loser left no audit trail because it never ran the side-effect.
  var history = await ctx.dun.historyForInvoice(invoiceId);
  check("concurrent ticks write a single event row", history.length === 1);

  // The row is still active on its NEXT step (attempt 1's
  // next_action_at advanced to step 2's +24h), proving exactly one
  // claim moved the scheduler forward by a single step.
  check("concurrent ticks leave the row active on the next step",
    status.status === "active" && status.last_action === "send_reminder");

  // Suppress the unused-var lint; `results` documents that both ticks
  // ran to completion (one claimed, one skipped) without throwing.
  check("both concurrent ticks resolved", Array.isArray(results[0]) && Array.isArray(results[1]));
}

// ---- retry success: unsetEnrollment("paid_out_of_band") ----------------

async function _unsetEnrollmentRecovers() {
  var ctx = _setup();
  await ctx.dun.defineDunningPolicy({
    slug: "recovery-policy",
    retry_schedule: [
      { delay_hours: 0,  action: "send_reminder" },
      { delay_hours: 24, action: "retry_charge"  },
    ],
    cancel_after_attempts: 2,
  });

  var invoiceId = _uuid();
  await ctx.dun.enrollInvoice({ invoice_id: invoiceId, policy_slug: "recovery-policy" });

  // Customer pays out of band — operator clears the enrollment.
  var recovered = await ctx.dun.unsetEnrollment({
    invoice_id: invoiceId,
    reason:     "paid_out_of_band",
  });
  check("unsetEnrollment marks status recovered", recovered.status === "recovered");
  check("unsetEnrollment stamps ended_at",        typeof recovered.ended_at === "number");
  check("unsetEnrollment persists end_reason",    recovered.end_reason === "paid_out_of_band");
  check("unsetEnrollment clears next_action_at",  recovered.next_action_at == null);

  // statusForInvoice mirrors the recovered state.
  var status = await ctx.dun.statusForInvoice(invoiceId);
  check("statusForInvoice reflects recovery",     status.status === "recovered");

  // Idempotent: a second unset on a terminal enrollment is a no-op.
  var replay = await ctx.dun.unsetEnrollment({
    invoice_id: invoiceId,
    reason:     "paid_out_of_band",
  });
  check("unsetEnrollment replay is a no-op",      replay.status === "recovered");

  // tickDunning leaves recovered rows alone.
  var future = Date.now() + 365 * 24 * 60 * 60 * 1000;
  var advanced = await ctx.dun.tickDunning({ now: future });
  check("tickDunning ignores recovered enrollments", advanced.length === 0);

  // Generic operator reason → abandoned, not recovered.
  var inv2 = _uuid();
  await ctx.dun.enrollInvoice({ invoice_id: inv2, policy_slug: "recovery-policy" });
  var abandoned = await ctx.dun.unsetEnrollment({
    invoice_id: inv2,
    reason:     "operator_wrote_off",
  });
  check("unsetEnrollment generic reason → abandoned", abandoned.status === "abandoned");
}

// ---- attempt-cap cancellation ------------------------------------------

async function _attemptCapCancels() {
  var ctx = _setup();
  // Cap-only policy: 3 send_reminder steps, no explicit
  // cancel_subscription, cancel_after_attempts=3. The third tick
  // hits the cap → enrollment closes as cancelled.
  await ctx.dun.defineDunningPolicy({
    slug: "cap-policy",
    retry_schedule: [
      { delay_hours: 0, action: "send_reminder" },
      { delay_hours: 1, action: "send_reminder" },
      { delay_hours: 1, action: "send_reminder" },
    ],
    cancel_after_attempts: 3,
  });

  var invoiceId = _uuid();
  ctx.invoicesById[invoiceId] = { id: invoiceId, subscription_id: _uuid() };
  await ctx.dun.enrollInvoice({ invoice_id: invoiceId, policy_slug: "cap-policy" });

  var t = Date.now() + 1000;
  await ctx.dun.tickDunning({ now: t });
  t += 1 * 60 * 60 * 1000 + 1000;
  await ctx.dun.tickDunning({ now: t });
  t += 1 * 60 * 60 * 1000 + 1000;
  var third = await ctx.dun.tickDunning({ now: t });

  check("third tick advances 1 enrollment", third.length === 1);
  check("attempt cap closes as cancelled",  third[0].status === "cancelled");
  check("attempt cap stamps ended_at",      typeof third[0].ended_at === "number");
  check("attempt cap clears next_action_at", third[0].next_action_at == null);
  check("attempt cap end_reason is attempt_cap", third[0].end_reason === "attempt_cap");

  // Explicit cancel_subscription action also closes the row.
  await ctx.dun.defineDunningPolicy({
    slug: "explicit-cancel",
    retry_schedule: [
      { delay_hours: 0, action: "cancel_subscription" },
    ],
    cancel_after_attempts: 5,
  });
  var inv2 = _uuid();
  ctx.invoicesById[inv2] = { id: inv2, subscription_id: _uuid() };
  await ctx.dun.enrollInvoice({ invoice_id: inv2, policy_slug: "explicit-cancel" });
  var explicit = await ctx.dun.tickDunning({ now: Date.now() + 1000 });
  check("explicit cancel_subscription closes row", explicit[0].status === "cancelled");
  check("explicit cancel end_reason",              explicit[0].end_reason === "policy_cancel_step");
}

// ---- metricsForPolicy aggregation --------------------------------------

async function _metricsAggregation() {
  var ctx = _setup();
  await ctx.dun.defineDunningPolicy({
    slug: "metrics-policy",
    retry_schedule: [
      { delay_hours: 0, action: "send_reminder" },
    ],
    cancel_after_attempts: 1,
  });

  var from = Date.now() - 1000;

  // 5 enrollments. 2 recover, 1 cancels via cap, 1 abandons, 1
  // remains active. To get a single-row tick (cap=1 closes whichever
  // enrollment ticks), settle the others to terminal states FIRST,
  // then tick once with only ids[2] still active.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var id = _uuid();
    ids.push(id);
    await ctx.dun.enrollInvoice({ invoice_id: id, policy_slug: "metrics-policy" });
  }
  await ctx.dun.unsetEnrollment({ invoice_id: ids[0], reason: "paid_out_of_band" });
  await ctx.dun.unsetEnrollment({ invoice_id: ids[1], reason: "processor_recovered" });
  await ctx.dun.unsetEnrollment({ invoice_id: ids[3], reason: "operator_wrote_off" });
  // ids[4] left active — push its next_action_at into the future so
  // the cap tick below only hits ids[2].
  await ctx.query(
    "UPDATE dunning_enrollments SET next_action_at = ?1 WHERE invoice_id = ?2",
    [Date.now() + 365 * 24 * 60 * 60 * 1000, ids[4]],
  );
  // ids[2]: hit the cap (cap=1, so single tick closes it).
  ctx.invoicesById[ids[2]] = { id: ids[2], subscription_id: _uuid() };
  await ctx.dun.tickDunning({ now: Date.now() + 1000 });

  var to = Date.now() + 1000;
  var metrics = await ctx.dun.metricsForPolicy({
    slug: "metrics-policy",
    from: from,
    to:   to,
  });

  check("metrics policy_slug",         metrics.policy_slug === "metrics-policy");
  check("metrics total_enrolled = 5",  metrics.total_enrolled === 5);
  check("metrics recovered = 2",       metrics.recovered === 2);
  check("metrics cancelled = 1",       metrics.cancelled === 1);
  check("metrics abandoned = 1",       metrics.abandoned === 1);
  check("metrics active = 1",          metrics.active === 1);
  check("metrics recovery_rate = 0.4", Math.abs(metrics.recovery_rate - 0.4) < 1e-9);
  check("metrics cancellation_rate = 0.2", Math.abs(metrics.cancellation_rate - 0.2) < 1e-9);

  // Empty window → zero rates without divide-by-zero.
  var empty = await ctx.dun.metricsForPolicy({
    slug: "metrics-policy",
    from: 1,
    to:   2,
  });
  check("metrics empty window total_enrolled = 0", empty.total_enrolled === 0);
  check("metrics empty window recovery_rate = 0",  empty.recovery_rate === 0);
  check("metrics empty window cancellation_rate = 0", empty.cancellation_rate === 0);
}

// ---- validation refusals -----------------------------------------------

async function _validationRefusals() {
  var ctx = _setup();

  // Bad slug shapes.
  await assert.rejects(ctx.dun.defineDunningPolicy({
    slug: "Bad Slug",
    retry_schedule: [{ delay_hours: 0, action: "send_reminder" }],
    cancel_after_attempts: 1,
  }), /slug must match/);

  await assert.rejects(ctx.dun.defineDunningPolicy({
    slug: "",
    retry_schedule: [{ delay_hours: 0, action: "send_reminder" }],
    cancel_after_attempts: 1,
  }), /slug must be a non-empty string/);

  // Bad action.
  await assert.rejects(ctx.dun.defineDunningPolicy({
    slug: "bad-action",
    retry_schedule: [{ delay_hours: 0, action: "delete_universe" }],
    cancel_after_attempts: 1,
  }), /action must be one of/);

  // Bad delay.
  await assert.rejects(ctx.dun.defineDunningPolicy({
    slug: "bad-delay",
    retry_schedule: [{ delay_hours: -1, action: "send_reminder" }],
    cancel_after_attempts: 1,
  }), /delay_hours must be an integer/);

  // Empty schedule.
  await assert.rejects(ctx.dun.defineDunningPolicy({
    slug: "empty-schedule",
    retry_schedule: [],
    cancel_after_attempts: 1,
  }), /retry_schedule must be a non-empty array/);

  // Bad cancel cap.
  await assert.rejects(ctx.dun.defineDunningPolicy({
    slug: "bad-cap",
    retry_schedule: [{ delay_hours: 0, action: "send_reminder" }],
    cancel_after_attempts: 0,
  }), /cancel_after_attempts must be an integer/);

  // Bad invoice UUID on enroll.
  await ctx.dun.defineDunningPolicy({
    slug: "valid",
    retry_schedule: [{ delay_hours: 0, action: "send_reminder" }],
    cancel_after_attempts: 1,
  });
  await assert.rejects(ctx.dun.enrollInvoice({
    invoice_id:  "not-a-uuid",
    policy_slug: "valid",
  }), /invoice_id/);

  // Archived policy refused on enroll (manual UPDATE simulates the
  // archive flow; a future surface will provide an explicit
  // archive() helper).
  await ctx.query(
    "UPDATE dunning_policies SET archived_at = ?1 WHERE slug = ?2",
    [Date.now(), "valid"],
  );
  await assert.rejects(ctx.dun.enrollInvoice({
    invoice_id:  _uuid(),
    policy_slug: "valid",
  }), /is archived/);

  // unsetEnrollment on a missing invoice.
  await assert.rejects(ctx.dun.unsetEnrollment({
    invoice_id: _uuid(),
    reason:     "paid",
  }), /has no enrollment/);

  // tickDunning requires a numeric `now`.
  await assert.rejects(ctx.dun.tickDunning({ now: "later" }), /must be a positive integer/);

  // metricsForPolicy requires from <= to.
  await assert.rejects(ctx.dun.metricsForPolicy({
    slug: "valid",
    from: 100,
    to:   50,
  }), /from must be <= to/);
}

// ---- driver ------------------------------------------------------------

(async function () {
  await _definePolicyAndEnroll();
  await _tickAdvancesState();
  await _concurrentTickFiresOnce();
  await _unsetEnrollmentRecovers();
  await _attemptCapCancels();
  await _metricsAggregation();
  await _validationRefusals();

  console.log("dunning: " + helpers.getChecks() + " checks passed");
})().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});
