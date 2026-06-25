"use strict";
/**
 * @module shop.dunning
 * @title  Dunning — operator-defined retry/escalation policy for failed invoices
 *
 * @intro
 *   Payment recovery for failed subscription invoices. Sibling to
 *   `subscriptionBilling` (which owns the processor-driven invoice +
 *   attempt + dunning-episode LEDGER) — this primitive owns the
 *   OPERATOR-DEFINED retry policy and the per-invoice scheduler walk
 *   that progressively escalates a failed invoice through reminder
 *   emails, charge retries, an optional pause, and (after the
 *   policy's attempt cap) subscription cancellation.
 *
 *   The shape:
 *
 *     var dun = bShop.dunning.create({
 *       query:               q,
 *       subscriptionBilling: bill,   // for cancelSubscription / pause / retry lookups
 *       email:               eml,    // for send_reminder dispatch
 *       notifications:       notif,  // for in-app reminder fan-out
 *     });
 *
 *     await dun.defineDunningPolicy({
 *       slug: "default-3-step",
 *       retry_schedule: [
 *         { delay_hours:   0, action: "send_reminder" },
 *         { delay_hours:  24, action: "retry_charge"  },
 *         { delay_hours:  72, action: "send_reminder" },
 *         { delay_hours: 168, action: "pause_subscription" },
 *       ],
 *       cancel_after_attempts: 4,
 *     });
 *
 *     await dun.enrollInvoice({ invoice_id, policy_slug: "default-3-step" });
 *
 *     // Scheduler tick — operator wires this to a cron / Workers
 *     // Cron Trigger. Walks every active enrollment whose
 *     // next_action_at is due and executes the next step.
 *     await dun.tickDunning({ now: Date.now() });
 *
 *     // Invoice paid out-of-band (customer phoned in, processor
 *     // automatic recovery fired) — operator clears the enrollment
 *     // so the scheduler stops escalating.
 *     await dun.unsetEnrollment({ invoice_id, reason: "paid_out_of_band" });
 *
 *     await dun.statusForInvoice(invoice_id);
 *     await dun.historyForInvoice(invoice_id);
 *     await dun.metricsForPolicy({ slug, from, to });
 *
 *   The policy schedule is a list of `{ delay_hours, action }` steps.
 *   `delay_hours` is the wait BEFORE the step executes (measured from
 *   the prior step's execution, or from enrollment time for step 0).
 *   `action` is one of:
 *
 *     send_reminder        — email the customer + enqueue an in-app
 *                            notification. The injected `email` /
 *                            `notifications` handles do the actual
 *                            dispatch; this primitive only records that
 *                            the action ran.
 *     retry_charge         — record an event noting a retry attempt.
 *                            The injected subscriptionBilling handle's
 *                            `recordPaymentAttempt` is the operator's
 *                            tool to actually re-charge — this surface
 *                            just stamps the dunning row so the next
 *                            tick advances.
 *     pause_subscription   — compose `subscriptionBilling.enterDunning`
 *                            so the subscription-side state is also
 *                            updated. Operators that wired the
 *                            `subscriptionControls` handle (separately)
 *                            apply their own pause as a side effect.
 *     cancel_subscription  — terminal. Marks the enrollment cancelled
 *                            + composes `subscriptionBilling.exitDunning`
 *                            with outcome `cancelled` (if the
 *                            subscription is currently in dunning).
 *
 *   `cancel_after_attempts` is the safety cap: if the schedule walks
 *   off the end (every step consumed, the invoice still isn't
 *   recovered, and the attempt_count >= cancel_after_attempts), the
 *   tick auto-cancels the subscription. This is the "tried everything"
 *   exit so a poorly-authored schedule can't leave the row spinning.
 *
 *   The enrollment row's `status` is the FSM:
 *
 *     active     — the scheduler walk is still working the row
 *     recovered  — `unsetEnrollment` (or a future processor webhook
 *                  that observes the invoice flip to paid) closed it
 *                  successfully
 *     cancelled  — the schedule reached `cancel_subscription` OR the
 *                  attempt cap fired
 *     abandoned  — operator manually unset with reason !== "recovered"
 *                  (e.g. "customer disputed and operator wrote off")
 *
 *   `metricsForPolicy` aggregates over the [from, to] window keyed on
 *   the enrollment's `created_at`. The result is the recovery rate
 *   (recovered / total_enrolled) + cancellation rate (cancelled /
 *   total_enrolled) — exactly what an operator dashboard renders to
 *   tell whether a given policy is paying for itself.
 *
 *   Composition: zero npm runtime deps; every primitive composes
 *   blamejs (`b.uuid.v7`, `b.guardUuid`) + the injected handles.
 *
 * @related b.uuid, b.guardUuid, shop.subscriptionBilling, shop.email,
 *          shop.notifications
 */

var b = require("./vendor/blamejs");
// Framework constants (C.TIME duration helpers). Safe at module-eval —
// the index entry point exposes `framework` before the require cascade.
var C = b.constants;

// ---- constants ----------------------------------------------------------

var ACTIONS = ["retry_charge", "send_reminder", "pause_subscription", "cancel_subscription"];
var STATUSES = ["active", "recovered", "cancelled", "abandoned"];
var OUTCOMES = ["ok", "skipped", "failed"];

var MAX_SLUG_LEN          = 64;
var MAX_REASON_LEN        = 280;
var MAX_DELAY_HOURS       = 24 * 365;   // 1 year — sane cap on retry delay
var MAX_SCHEDULE_STEPS    = 64;
var MAX_CANCEL_ATTEMPTS   = 64;
var MAX_LIST_LIMIT        = 500;
var DEFAULT_LIST_LIMIT    = 100;
var MS_PER_HOUR           = C.TIME.hours(1);

var SLUG_RE          = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
var CONTROL_BYTE_RE  = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE    = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("dunning: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _slug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("dunning: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("dunning: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("dunning: slug must match /[a-z][a-z0-9-]*[a-z0-9]/");
  }
  return s;
}

function _action(s) {
  if (typeof s !== "string" || ACTIONS.indexOf(s) === -1) {
    throw new TypeError("dunning: action must be one of " + ACTIONS.join(", "));
  }
  return s;
}

function _retrySchedule(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("dunning: retry_schedule must be a non-empty array");
  }
  if (arr.length > MAX_SCHEDULE_STEPS) {
    throw new TypeError("dunning: retry_schedule must have <= " + MAX_SCHEDULE_STEPS + " steps");
  }
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var step = arr[i];
    if (!step || typeof step !== "object") {
      throw new TypeError("dunning: retry_schedule[" + i + "] must be an object");
    }
    var delay = step.delay_hours;
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_HOURS) {
      throw new TypeError(
        "dunning: retry_schedule[" + i + "].delay_hours must be an integer in [0, " + MAX_DELAY_HOURS + "]"
      );
    }
    var act = _action(step.action);
    out.push({ delay_hours: delay, action: act });
  }
  return out;
}

function _cancelAfterAttempts(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_CANCEL_ATTEMPTS) {
    throw new TypeError(
      "dunning: cancel_after_attempts must be an integer in [1, " + MAX_CANCEL_ATTEMPTS + "]"
    );
  }
  return n;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("dunning: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("dunning: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("dunning: reason contains control / zero-width bytes");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("dunning: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("dunning: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _parseSchedule(json) {
  // Stored JSON is operator-authored + already validated at write;
  // re-parse defensively (a downstream DB tool could have rewritten
  // the row) and re-validate the shape so a corrupt row fails LOUD
  // at the tick instead of silently mis-scheduling.
  try {
    var parsed = JSON.parse(json);
    return _retrySchedule(parsed);
  } catch (e) {
    var pErr = new Error("dunning: stored retry_schedule_json is malformed (" + (e && e.message || "parse error") + ")");
    pErr.code = "DUNNING_POLICY_CORRUPT";
    throw pErr;
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Injected handles. `subscriptionBilling` is the only strictly
  // required one — `email` / `notifications` are surface-optional
  // (a `send_reminder` step short-circuits to outcome `skipped` with
  // reason `no_email_handle` so the scheduler still advances).
  var billing       = opts.subscriptionBilling || null;
  var emailHandle   = opts.email || null;
  var notifHandle   = opts.notifications || null;

  // -------- internal helpers --------

  async function _getPolicy(slug) {
    var r = await query("SELECT * FROM dunning_policies WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _getEnrollment(invoiceId) {
    var r = await query("SELECT * FROM dunning_enrollments WHERE invoice_id = ?1", [invoiceId]);
    return r.rows[0] || null;
  }

  async function _refetchEnrollment(id) {
    var r = await query("SELECT * FROM dunning_enrollments WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _writeEvent(enrollmentId, attemptNumber, action, outcome, ts) {
    var id = b.uuid.v7();
    await query(
      "INSERT INTO dunning_events " +
      "(id, enrollment_id, attempt_number, action, outcome, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, enrollmentId, attemptNumber, action, outcome, ts],
    );
  }

  // Compute the next_action_at + the index of the next step. Returns
  // `null` when the schedule has been exhausted (the caller decides
  // whether to auto-cancel or mark the enrollment recovered).
  function _planNextStep(schedule, attemptCount, fromTs) {
    if (attemptCount >= schedule.length) return null;
    var step = schedule[attemptCount];
    var nextAt = fromTs + step.delay_hours * MS_PER_HOUR;
    return { action: step.action, next_action_at: nextAt };
  }

  // Execute a single action for an enrollment. Returns the outcome
  // string so the caller can write the event + decide what to do
  // next. `send_reminder` and `retry_charge` are non-terminal —
  // `pause_subscription` and `cancel_subscription` flip status.
  async function _executeAction(action, enrollment) {
    if (action === "send_reminder") {
      // Best-effort dispatch. Missing handles → `skipped`. Handle
      // throws → `failed`. Operators that haven't wired email yet
      // can still observe the schedule advancing.
      if (!emailHandle && !notifHandle) return "skipped";
      try {
        if (emailHandle && typeof emailHandle.sendDunningReminder === "function") {
          await emailHandle.sendDunningReminder({
            invoice_id:     enrollment.invoice_id,
            attempt_number: enrollment.attempt_count + 1,
          });
        }
        if (notifHandle && typeof notifHandle.enqueue === "function") {
          await notifHandle.enqueue({
            recipient_id: "invoice:" + enrollment.invoice_id,
            channel:      "in-app",
            event_type:   "dunning.reminder",
            title:        "Payment due",
            body:         "We were unable to charge your subscription. Please update your payment method.",
            payload:      {
              invoice_id:     enrollment.invoice_id,
              attempt_number: enrollment.attempt_count + 1,
            },
          });
        }
        return "ok";
      } catch (_e) {
        return "failed";
      }
    }
    if (action === "retry_charge") {
      // The dunning primitive doesn't own the processor charge —
      // the operator's webhook handler does. We record the retry
      // INTENT here; if a `recordPaymentAttempt` handle is wired
      // we call it (idempotent under the existing UNIQUE
      // (invoice_id, attempt_number) constraint, so a webhook +
      // tick recording the same attempt collapses to one row).
      if (!billing || typeof billing.recordPaymentAttempt !== "function") return "skipped";
      try {
        await billing.recordPaymentAttempt({
          invoice_id:     enrollment.invoice_id,
          attempt_number: enrollment.attempt_count + 1,
          status:         "failed",
          failure_code:   "dunning_retry",
        });
        return "ok";
      } catch (_e) {
        return "failed";
      }
    }
    if (action === "pause_subscription") {
      if (!billing || typeof billing.enterDunning !== "function") return "skipped";
      try {
        // Resolve the subscription_id off the invoice. The
        // billing handle exposes invoicesForSubscription but not
        // a direct `getInvoice` — operators typically inject a
        // thin wrapper. Skip when the subscription_id isn't
        // resolvable so the tick still advances.
        if (typeof billing._getInvoiceForDunning !== "function") return "skipped";
        var inv = await billing._getInvoiceForDunning(enrollment.invoice_id);
        if (!inv || !inv.subscription_id) return "skipped";
        await billing.enterDunning({
          subscription_id: inv.subscription_id,
          reason:          "dunning: pause_subscription step",
        });
        return "ok";
      } catch (_e) {
        return "failed";
      }
    }
    if (action === "cancel_subscription") {
      // Terminal — record the event; the surrounding _advance
      // loop flips status to cancelled + close the enrollment.
      if (!billing || typeof billing.exitDunning !== "function") return "ok";
      try {
        if (typeof billing._getInvoiceForDunning !== "function") return "ok";
        var inv2 = await billing._getInvoiceForDunning(enrollment.invoice_id);
        if (!inv2 || !inv2.subscription_id) return "ok";
        await billing.exitDunning({
          subscription_id: inv2.subscription_id,
          outcome:         "cancelled",
        });
        return "ok";
      } catch (_e) {
        return "failed";
      }
    }
    return "skipped";
  }

  // Advance ONE enrollment by one step. Returns the refreshed row.
  // The function is the heart of tickDunning — it's surfaced
  // internally so tests can drive a single advance deterministically.
  async function _advance(enrollment, schedule, cancelAfterAttempts, now) {
    // ---- atomic claim ----------------------------------------------
    // tickDunning snapshots the due-set with a SELECT, then walks each
    // row here. Two concurrent ticks (overlapping cron fires, a manual
    // tick racing the cron) both see the SAME due row and would each
    // run _executeAction — double-emailing the customer, double-
    // recording the retry, double-pausing/cancelling the subscription.
    // SQLite/D1 serializes writers, so a conditional UPDATE is the
    // atomic claim: null out next_action_at guarded on the value this
    // tick OBSERVED (enrollment.next_action_at) AND status='active'.
    // The first tick to land flips it to 1 row; the loser matches 0
    // rows and skips the row entirely (returns the row unchanged so
    // the snapshot caller still gets a refreshed view without firing
    // the side-effect twice). The subsequent state UPDATEs below all
    // re-assert status='active' so a unsetEnrollment landing mid-walk
    // can't be clobbered back to active either.
    var observedNextAt = enrollment.next_action_at;
    var claim = await query(
      "UPDATE dunning_enrollments SET next_action_at = NULL " +
      "WHERE id = ?1 AND status = 'active' AND next_action_at = ?2",
      [enrollment.id, observedNextAt],
    );
    if (Number(claim.rowCount || 0) !== 1) {
      // Lost the race — another tick already claimed this row (or it
      // was unset to a terminal status between the snapshot and now).
      // Skip the side-effect; return the current row state.
      return await _refetchEnrollment(enrollment.id);
    }

    var attemptCount = Number(enrollment.attempt_count);
    var stepIndex    = attemptCount;
    if (stepIndex >= schedule.length) {
      // Walked off the end with no step left to run. If the attempt cap
      // has been reached this is the "tried everything" auto-cancel, so
      // we COMPOSE the subscription-side cancel (exitDunning) — not just
      // flip the row, otherwise the enrollment reads cancelled while the
      // recurring charge keeps firing. Below the cap it's an
      // operator-authored schedule that ran out before resolution, which
      // closes 'abandoned' with no cancel intent. Either way the audit
      // event records what actually happened — never a fabricated cancel.
      var closeAs = attemptCount >= cancelAfterAttempts ? "cancelled" : "abandoned";
      var exhaustOutcome = closeAs === "cancelled"
        ? await _executeAction("cancel_subscription", enrollment)
        : null;
      await query(
        "UPDATE dunning_enrollments SET status = ?1, next_action_at = NULL, " +
        "ended_at = ?2, end_reason = ?3, last_action = ?4, last_action_at = ?2 " +
        "WHERE id = ?5 AND status = 'active'",
        [closeAs, now, "schedule_exhausted",
          closeAs === "cancelled" ? "cancel_subscription" : "schedule_exhausted",
          enrollment.id],
      );
      await _writeEvent(
        enrollment.id, attemptCount,
        closeAs === "cancelled" ? "cancel_subscription" : "schedule_exhausted",
        closeAs === "cancelled" ? exhaustOutcome : "ok",
        now,
      );
      return await _refetchEnrollment(enrollment.id);
    }

    var action = schedule[stepIndex].action;
    var outcome = await _executeAction(action, enrollment);
    var newAttemptCount = attemptCount + 1;

    var planned = _planNextStep(schedule, newAttemptCount, now);
    var terminal = (action === "cancel_subscription") || (newAttemptCount >= cancelAfterAttempts);

    if (terminal) {
      // A `cancel_subscription` STEP already composed the subscription
      // cancel via _executeAction above. When the ATTEMPT CAP fires on a
      // non-cancel step (send_reminder / retry_charge), the enrollment
      // still closes 'cancelled' — so the subscription-side cancel must
      // be composed here too; the bare status flip would leave the
      // subscription billing. The step's own action event is preserved;
      // the composed cancel is recorded as its own event with the real
      // outcome (so a failed cancel is visible, not masked as success).
      var capCancelOutcome = null;
      if (action !== "cancel_subscription") {
        capCancelOutcome = await _executeAction("cancel_subscription", enrollment);
      }
      await query(
        "UPDATE dunning_enrollments SET status = 'cancelled', next_action_at = NULL, " +
        "attempt_count = ?1, last_action = 'cancel_subscription', last_action_at = ?2, " +
        "ended_at = ?2, end_reason = ?3 WHERE id = ?4 AND status = 'active'",
        [newAttemptCount, now, action === "cancel_subscription" ? "policy_cancel_step" : "attempt_cap", enrollment.id],
      );
      await _writeEvent(enrollment.id, newAttemptCount, action, outcome, now);
      if (action !== "cancel_subscription") {
        await _writeEvent(enrollment.id, newAttemptCount, "cancel_subscription", capCancelOutcome, now);
      }
      return await _refetchEnrollment(enrollment.id);
    }

    if (planned == null) {
      // No more steps + not at the cap yet. Close as abandoned —
      // operator authored a schedule that runs out without
      // resolution, the primitive refuses to spin.
      await query(
        "UPDATE dunning_enrollments SET status = 'abandoned', next_action_at = NULL, " +
        "attempt_count = ?1, last_action = ?2, last_action_at = ?3, " +
        "ended_at = ?3, end_reason = 'schedule_exhausted' WHERE id = ?4 AND status = 'active'",
        [newAttemptCount, action, now, enrollment.id],
      );
      await _writeEvent(enrollment.id, newAttemptCount, action, outcome, now);
      return await _refetchEnrollment(enrollment.id);
    }

    await query(
      "UPDATE dunning_enrollments SET attempt_count = ?1, last_action = ?2, " +
      "last_action_at = ?3, next_action_at = ?4 WHERE id = ?5 AND status = 'active'",
      [newAttemptCount, action, now, planned.next_action_at, enrollment.id],
    );
    await _writeEvent(enrollment.id, newAttemptCount, action, outcome, now);
    return await _refetchEnrollment(enrollment.id);
  }

  // -------- public surface --------

  return {
    ACTIONS:               ACTIONS.slice(),
    STATUSES:              STATUSES.slice(),
    OUTCOMES:              OUTCOMES.slice(),
    MAX_SLUG_LEN:          MAX_SLUG_LEN,
    MAX_REASON_LEN:        MAX_REASON_LEN,
    MAX_DELAY_HOURS:       MAX_DELAY_HOURS,
    MAX_SCHEDULE_STEPS:    MAX_SCHEDULE_STEPS,
    MAX_CANCEL_ATTEMPTS:   MAX_CANCEL_ATTEMPTS,
    MAX_LIST_LIMIT:        MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:    DEFAULT_LIST_LIMIT,

    defineDunningPolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dunning.defineDunningPolicy: input object required");
      }
      var slug                 = _slug(input.slug);
      var schedule             = _retrySchedule(input.retry_schedule);
      var cancelAfterAttempts  = _cancelAfterAttempts(input.cancel_after_attempts);
      var now                  = _now();
      var json                 = JSON.stringify(schedule);

      var existing = await _getPolicy(slug);
      if (existing) {
        // Re-define is an upsert — the operator dashboard edits the
        // policy in place. archived_at is preserved on a rewrite (a
        // separate archivePolicy surface would clear it; out of
        // scope for v1 — operators clear via a direct DB write or
        // re-define with the same slug after manual UPDATE).
        await query(
          "UPDATE dunning_policies SET retry_schedule_json = ?1, " +
          "cancel_after_attempts = ?2, updated_at = ?3 WHERE slug = ?4",
          [json, cancelAfterAttempts, now, slug],
        );
      } else {
        await query(
          "INSERT INTO dunning_policies " +
          "(slug, retry_schedule_json, cancel_after_attempts, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
          [slug, json, cancelAfterAttempts, now],
        );
      }
      return await _getPolicy(slug);
    },

    enrollInvoice: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dunning.enrollInvoice: input object required");
      }
      var invoiceId = _uuid(input.invoice_id, "invoice_id");
      var slug      = _slug(input.policy_slug);

      var policy = await _getPolicy(slug);
      if (!policy) {
        var nfErr = new Error("dunning.enrollInvoice: policy " + slug + " not found");
        nfErr.code = "POLICY_NOT_FOUND";
        throw nfErr;
      }
      if (policy.archived_at != null) {
        var aErr = new Error("dunning.enrollInvoice: policy " + slug + " is archived");
        aErr.code = "POLICY_ARCHIVED";
        throw aErr;
      }

      // Idempotency: if an enrollment already exists for this
      // invoice, return it. Webhook redelivery of
      // `invoice.payment_failed` flows through here repeatedly; the
      // UNIQUE (invoice_id) constraint would refuse the second
      // INSERT, this short-circuit gives the caller a clean replay.
      var existing = await _getEnrollment(invoiceId);
      if (existing) return existing;

      var schedule = _parseSchedule(policy.retry_schedule_json);
      var now      = _now();
      var planned  = _planNextStep(schedule, 0, now);
      // `planned` is non-null because _retrySchedule enforces
      // schedule.length >= 1; defensive nullcheck for the corrupt-
      // row path.
      var nextAt = planned ? planned.next_action_at : null;

      var id = b.uuid.v7();
      await query(
        "INSERT INTO dunning_enrollments " +
        "(id, invoice_id, policy_slug, status, next_action_at, attempt_count, " +
        " last_action, last_action_at, ended_at, end_reason, created_at) " +
        "VALUES (?1, ?2, ?3, 'active', ?4, 0, NULL, NULL, NULL, NULL, ?5)",
        [id, invoiceId, slug, nextAt, now],
      );
      return await _refetchEnrollment(id);
    },

    tickDunning: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dunning.tickDunning: input object required");
      }
      var now = _epochMs(input.now, "now");
      var limit = _limit(input.limit);

      // Snapshot the due-set up front. Each advance runs a small
      // burst of writes; pulling the row list first lets the
      // scheduler process a stable working set per tick.
      var due = await query(
        "SELECT * FROM dunning_enrollments " +
        "WHERE status = 'active' AND next_action_at IS NOT NULL AND next_action_at <= ?1 " +
        "ORDER BY next_action_at ASC, id ASC LIMIT ?2",
        [now, limit],
      );

      var advanced = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var enrollment = due.rows[i];
        var policy = await _getPolicy(enrollment.policy_slug);
        if (!policy) {
          // Policy went missing between enrollment + tick — close
          // the row as abandoned so it doesn't spin forever.
          await query(
            "UPDATE dunning_enrollments SET status = 'abandoned', next_action_at = NULL, " +
            "ended_at = ?1, end_reason = 'policy_missing' WHERE id = ?2",
            [now, enrollment.id],
          );
          advanced.push(await _refetchEnrollment(enrollment.id));
          continue;
        }
        var schedule = _parseSchedule(policy.retry_schedule_json);
        var refreshed = await _advance(enrollment, schedule, Number(policy.cancel_after_attempts), now);
        advanced.push(refreshed);
      }
      return advanced;
    },

    statusForInvoice: async function (invoiceId) {
      invoiceId = _uuid(invoiceId, "invoice_id");
      return await _getEnrollment(invoiceId);
    },

    historyForInvoice: async function (invoiceId) {
      invoiceId = _uuid(invoiceId, "invoice_id");
      var enrollment = await _getEnrollment(invoiceId);
      if (!enrollment) return [];
      var r = await query(
        "SELECT * FROM dunning_events WHERE enrollment_id = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [enrollment.id],
      );
      return r.rows;
    },

    unsetEnrollment: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dunning.unsetEnrollment: input object required");
      }
      var invoiceId = _uuid(input.invoice_id, "invoice_id");
      var reason    = _reason(input.reason);

      var enrollment = await _getEnrollment(invoiceId);
      if (!enrollment) {
        var nfErr = new Error("dunning.unsetEnrollment: invoice " + invoiceId + " has no enrollment");
        nfErr.code = "ENROLLMENT_NOT_FOUND";
        throw nfErr;
      }
      if (enrollment.status !== "active") {
        // Already terminal — no-op idempotent return so webhook
        // redelivery of "paid out of band" doesn't fail.
        return enrollment;
      }

      // The reason string drives the close-state: anything that
      // signals the invoice resolved successfully → recovered;
      // everything else → abandoned. Operators wire "paid",
      // "paid_out_of_band", "processor_recovered" to recovery; a
      // generic operator-initiated stop (refund, write-off) flows
      // to abandoned. The regex is intentionally narrow so a typo
      // doesn't accidentally count as a recovery.
      var recoveredRe = /^(paid|paid_out_of_band|processor_recovered|recovered)$/i;
      var nextStatus = recoveredRe.test(reason) ? "recovered" : "abandoned";

      var now = _now();
      await query(
        "UPDATE dunning_enrollments SET status = ?1, next_action_at = NULL, " +
        "ended_at = ?2, end_reason = ?3 WHERE id = ?4",
        [nextStatus, now, reason, enrollment.id],
      );
      return await _refetchEnrollment(enrollment.id);
    },

    metricsForPolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dunning.metricsForPolicy: input object required");
      }
      var slug = _slug(input.slug);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from > to) {
        throw new TypeError("dunning.metricsForPolicy: from must be <= to");
      }

      var r = await query(
        "SELECT status, COUNT(*) AS n FROM dunning_enrollments " +
        "WHERE policy_slug = ?1 AND created_at >= ?2 AND created_at <= ?3 " +
        "GROUP BY status",
        [slug, from, to],
      );
      var counts = { active: 0, recovered: 0, cancelled: 0, abandoned: 0 };
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        counts[row.status] = Number(row.n);
      }
      var total = counts.active + counts.recovered + counts.cancelled + counts.abandoned;
      // Recovery + cancellation rate denominators: total enrolled
      // in the window. Returned as floats in [0, 1] — render-tier
      // formatting (percent, locale) is the caller's concern. A
      // zero-total window returns 0 rates (no enrollments → no
      // recovery to measure); the caller checks `total_enrolled`
      // to distinguish "no data" from "all failed."
      var recoveryRate     = total === 0 ? 0 : counts.recovered / total;
      var cancellationRate = total === 0 ? 0 : counts.cancelled  / total;

      return {
        policy_slug:          slug,
        from:                 from,
        to:                   to,
        total_enrolled:       total,
        active:               counts.active,
        recovered:            counts.recovered,
        cancelled:            counts.cancelled,
        abandoned:            counts.abandoned,
        recovery_rate:        recoveryRate,
        cancellation_rate:    cancellationRate,
      };
    },
  };
}

module.exports = {
  create:              create,
  ACTIONS:             ACTIONS.slice(),
  STATUSES:            STATUSES.slice(),
  OUTCOMES:            OUTCOMES.slice(),
  MAX_SLUG_LEN:        MAX_SLUG_LEN,
  MAX_REASON_LEN:      MAX_REASON_LEN,
  MAX_DELAY_HOURS:     MAX_DELAY_HOURS,
  MAX_SCHEDULE_STEPS:  MAX_SCHEDULE_STEPS,
  MAX_CANCEL_ATTEMPTS: MAX_CANCEL_ATTEMPTS,
  MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:  DEFAULT_LIST_LIMIT,
};
