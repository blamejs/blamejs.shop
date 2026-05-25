"use strict";
/**
 * @module shop.paymentRetries
 * @title  Payment retries — failure-code-aware retry orchestration for
 *         failed one-time payments
 *
 * @intro
 *   Recovery orchestration for one-time payment failures. Sibling to
 *   `dunning` (which owns the subscription-invoice escalation walk) —
 *   this primitive owns the per-payment retry sequence keyed on the
 *   processor's `failure_code`. Different decline reasons map to
 *   different retry strategies:
 *
 *     insufficient_funds  → wait 24h, retry once or twice; the bank
 *                           account probably topped up overnight
 *     card_declined       → wait 7d, retry once; an issuer hold may
 *                           have cleared, but back-to-back retries
 *                           burn fraud-score budget
 *     invalid_card        → terminal immediately; no retry will ever
 *                           succeed, prompt the customer for a new
 *                           card instead
 *
 *   The shape:
 *
 *     var pr = bShop.paymentRetries.create({
 *       query:   q,
 *       payment: pay,                // optional — for retry composition
 *     });
 *
 *     await pr.defineRetryPolicy({
 *       slug:                    "default-insufficient-funds",
 *       failure_code:            "insufficient_funds",
 *       retry_schedule:          [24, 48],        // hours
 *       max_attempts:            2,
 *       terminal_after_attempts: 0,
 *     });
 *     await pr.defineRetryPolicy({
 *       slug:                    "default-card-declined",
 *       failure_code:            "card_declined",
 *       retry_schedule:          [168],           // 7 days
 *       max_attempts:            1,
 *       terminal_after_attempts: 0,
 *     });
 *     await pr.defineRetryPolicy({
 *       slug:                    "default-invalid-card",
 *       failure_code:            "invalid_card",
 *       retry_schedule:          [],
 *       max_attempts:            1,
 *       terminal_after_attempts: 1,  // first failure already counted; terminal at attempt 1
 *     });
 *
 *     // Processor webhook: `payment_intent.payment_failed` arrives —
 *     // operator enrolls. The primitive picks the right policy by
 *     // failure_code; an `invalid_card` enrollment short-circuits to
 *     // abandoned at creation time so the storefront can prompt for a
 *     // fresh card immediately.
 *     await pr.enrollFailure({
 *       payment_intent_id: pi_id,
 *       order_id:          order_id,
 *       customer_id:       customer_id,
 *       failure_code:      "insufficient_funds",
 *     });
 *
 *     // Cron tick — walks every active enrollment whose
 *     // next_retry_at is due. The injected `payment` handle, if
 *     // wired, is composed via `payment.retryIntent(...)`; absent the
 *     // handle the tick still advances state so the operator can
 *     // drive retries out-of-band.
 *     await pr.tickRetries({ now: Date.now() });
 *
 *     // Operator reports the outcome of an actual processor retry
 *     // (whether the tick fired it or an external job did). Success
 *     // closes the enrollment as recovered; failure stamps a new
 *     // failure_code + advances the schedule.
 *     await pr.recordRetryOutcome({
 *       retry_id:         enrollment_id,
 *       succeeded:        false,
 *       new_failure_code: "card_declined",
 *     });
 *
 *     // Customer paid out-of-band, refunded, or operator wrote off —
 *     // clear the enrollment so the scheduler stops.
 *     await pr.unenrollPayment({
 *       payment_intent_id: pi_id,
 *       reason:            "paid_out_of_band",
 *     });
 *
 *     await pr.statusForPayment(pi_id);
 *     await pr.historyForPayment(pi_id);
 *     await pr.policiesForFailureCode("insufficient_funds");
 *     await pr.metricsForPolicy({ slug, from, to });
 *
 *   The enrollment row's `status` is the FSM:
 *
 *     active     — scheduler walk still working
 *     recovered  — recordRetryOutcome(succeeded: true) OR unenrollPayment
 *                  with a recovery reason
 *     exhausted  — max_attempts hit or the schedule ran out
 *     abandoned  — terminal_after_attempts cap fired (invalid_card
 *                  short-circuit) OR operator unenrolled with a non-
 *                  recovery reason
 *
 *   `terminal_after_attempts` is the short-circuit cap for failure
 *   codes that will never succeed on retry (invalid_card, expired_card).
 *   Setting it to 1 means the first failure already counts as the
 *   terminal one — enrollFailure closes the row as abandoned without
 *   scheduling any retry.
 *
 *   `max_attempts` is the safety cap that prevents an over-eager
 *   schedule from spinning. A policy with `retry_schedule: [24, 48]`
 *   and `max_attempts: 2` walks at most two retries, then closes as
 *   exhausted regardless of outcome.
 *
 *   `policiesForFailureCode` is the lookup the operator's webhook
 *   handler runs to pick the active (non-archived) policy when more
 *   than one is defined for the same failure_code (e.g. operator A/B
 *   testing two schedules). The primitive itself picks the most-
 *   recently-updated active policy by default; operators wanting more
 *   control inspect this list and call enrollFailure with an explicit
 *   `policy_slug`.
 *
 *   Composition: zero npm runtime deps. Per-factory monotonic clock
 *   guarantees `occurred_at` on the attempts log is strictly
 *   increasing even when multiple recordRetryOutcome calls land
 *   inside a 1ms wall-clock tick.
 *
 * @related b.uuid, b.guardUuid, shop.dunning, shop.subscriptionBilling,
 *          shop.payment
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var STATUSES = ["active", "recovered", "exhausted", "abandoned"];

var MAX_SLUG_LEN          = 64;
var MAX_FAILURE_CODE_LEN  = 64;
var MAX_REASON_LEN        = 280;
var MAX_DELAY_HOURS       = 24 * 365;   // 1 year — sane cap
var MAX_SCHEDULE_STEPS    = 64;
var MAX_ATTEMPTS_CAP      = 64;
var MAX_LIST_LIMIT        = 500;
var DEFAULT_LIST_LIMIT    = 100;
var MS_PER_HOUR           = C.TIME.hours(1);

var SLUG_RE          = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
var FAILURE_CODE_RE  = /^[a-z](?:[a-z0-9_]*[a-z0-9])?$/;
var CONTROL_BYTE_RE  = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE    = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("paymentRetries: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _slug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("paymentRetries: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("paymentRetries: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("paymentRetries: slug must match /[a-z][a-z0-9-]*[a-z0-9]/");
  }
  return s;
}

function _failureCode(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("paymentRetries: failure_code must be a non-empty string");
  }
  if (s.length > MAX_FAILURE_CODE_LEN) {
    throw new TypeError("paymentRetries: failure_code must be <= " + MAX_FAILURE_CODE_LEN + " characters");
  }
  if (!FAILURE_CODE_RE.test(s)) {
    throw new TypeError("paymentRetries: failure_code must match /[a-z][a-z0-9_]*[a-z0-9]/");
  }
  return s;
}

function _retrySchedule(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError("paymentRetries: retry_schedule must be an array of integer hour offsets");
  }
  if (arr.length > MAX_SCHEDULE_STEPS) {
    throw new TypeError("paymentRetries: retry_schedule must have <= " + MAX_SCHEDULE_STEPS + " steps");
  }
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var hrs = arr[i];
    if (!Number.isInteger(hrs) || hrs < 0 || hrs > MAX_DELAY_HOURS) {
      throw new TypeError(
        "paymentRetries: retry_schedule[" + i + "] must be an integer in [0, " + MAX_DELAY_HOURS + "]"
      );
    }
    out.push(hrs);
  }
  return out;
}

function _maxAttempts(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ATTEMPTS_CAP) {
    throw new TypeError(
      "paymentRetries: max_attempts must be an integer in [1, " + MAX_ATTEMPTS_CAP + "]"
    );
  }
  return n;
}

function _terminalAfterAttempts(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_ATTEMPTS_CAP) {
    throw new TypeError(
      "paymentRetries: terminal_after_attempts must be an integer in [0, " + MAX_ATTEMPTS_CAP + "]"
    );
  }
  return n;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("paymentRetries: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("paymentRetries: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("paymentRetries: reason contains control / zero-width bytes");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("paymentRetries: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("paymentRetries: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _parseSchedule(json) {
  // Stored JSON is operator-authored + validated at write; re-parse
  // defensively (a downstream DB tool could have rewritten the row)
  // so a corrupt row fails LOUD at the tick instead of silently mis-
  // scheduling.
  try {
    var parsed = JSON.parse(json);
    return _retrySchedule(parsed);
  } catch (e) {
    var pErr = new Error("paymentRetries: stored retry_schedule_json is malformed (" + (e && e.message || "parse error") + ")");
    pErr.code = "POLICY_CORRUPT";
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
  // Injected handles. `payment` is surface-optional — when wired,
  // tickRetries composes `payment.retryIntent({...})` to trigger the
  // actual processor retry. Absent the handle, tickRetries still
  // advances the schedule state so an operator can drive the retry
  // out-of-band and report the outcome via recordRetryOutcome.
  var paymentHandle = opts.payment || null;

  // Per-factory monotonic clock — guarantees `occurred_at` on the
  // attempts log is strictly increasing across calls emitted by the
  // same primitive instance, even when the wall clock has 1ms
  // resolution and the test loop emits multiple events inside a
  // single tick. Forward-leap if Date.now() outpaces the counter;
  // otherwise bump by 1ms.
  var _lastEventTs = 0;
  function _monotonicTs() {
    var wall = _now();
    if (wall > _lastEventTs) _lastEventTs = wall;
    else                     _lastEventTs += 1;
    return _lastEventTs;
  }

  // -------- internal helpers --------

  async function _getPolicy(slug) {
    var r = await query("SELECT * FROM payment_retry_policies WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  // Pick the most-recently-updated non-archived policy for a given
  // failure_code. enrollFailure uses this when the caller didn't
  // pass an explicit `policy_slug`; operators with multiple policies
  // for the same failure code should call policiesForFailureCode and
  // pass the slug they want.
  async function _pickPolicyForFailureCode(failureCode) {
    var r = await query(
      "SELECT * FROM payment_retry_policies " +
      "WHERE failure_code = ?1 AND archived_at IS NULL " +
      "ORDER BY updated_at DESC, slug ASC LIMIT 1",
      [failureCode],
    );
    return r.rows[0] || null;
  }

  async function _getEnrollment(paymentIntentId) {
    var r = await query("SELECT * FROM payment_retry_enrollments WHERE payment_intent_id = ?1", [paymentIntentId]);
    return r.rows[0] || null;
  }

  async function _refetchEnrollment(id) {
    var r = await query("SELECT * FROM payment_retry_enrollments WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _writeAttempt(enrollmentId, attemptNumber, succeeded, failureCode) {
    var id = b.uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO payment_retry_attempts " +
      "(id, enrollment_id, attempt_number, succeeded, failure_code, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, enrollmentId, attemptNumber, succeeded ? 1 : 0, failureCode || null, ts],
    );
    return ts;
  }

  // Compute the next_retry_at for the given attempt slot. Returns
  // null when the schedule has been exhausted (the caller decides
  // whether to close as exhausted or keep waiting on an external
  // recordRetryOutcome call).
  function _planNextRetry(schedule, nextAttemptIndex, fromTs) {
    if (nextAttemptIndex >= schedule.length) return null;
    var hrs = schedule[nextAttemptIndex];
    return fromTs + hrs * MS_PER_HOUR;
  }

  // Advance ONE enrollment by one scheduler tick. Records the
  // attempt as failed-by-default (the actual processor call is
  // composed via the injected `payment` handle; success requires the
  // operator to call recordRetryOutcome with succeeded=true). Returns
  // the refreshed row.
  async function _tickAdvance(enrollment, policy, schedule, now) {
    var attemptCount = Number(enrollment.attempt_count);
    var maxAttempts  = Number(policy.max_attempts);
    var nextAttemptNumber = attemptCount + 1;

    // Try composing the processor retry. The handle is best-effort;
    // a throw is captured as a failed attempt with the thrown
    // failure_code (when available) or "retry_error".
    var attemptFailureCode = enrollment.last_failure_code || policy.failure_code;
    var attemptSucceeded   = false;
    if (paymentHandle && typeof paymentHandle.retryIntent === "function") {
      try {
        var result = await paymentHandle.retryIntent({
          payment_intent_id: enrollment.payment_intent_id,
          order_id:          enrollment.order_id,
          attempt_number:    nextAttemptNumber,
        });
        if (result && result.succeeded === true) {
          attemptSucceeded = true;
          attemptFailureCode = null;
        } else if (result && typeof result.failure_code === "string") {
          attemptFailureCode = result.failure_code;
        }
      } catch (_e) {
        attemptFailureCode = "retry_error";
      }
    }

    await _writeAttempt(enrollment.id, nextAttemptNumber, attemptSucceeded, attemptFailureCode);

    if (attemptSucceeded) {
      await query(
        "UPDATE payment_retry_enrollments SET status = 'recovered', next_retry_at = NULL, " +
        "attempt_count = ?1, last_failure_code = NULL, ended_at = ?2, end_reason = 'retry_succeeded' " +
        "WHERE id = ?3",
        [nextAttemptNumber, now, enrollment.id],
      );
      return await _refetchEnrollment(enrollment.id);
    }

    // Cap check: if we just used the last allowed attempt, close as
    // exhausted regardless of whether the schedule has more entries.
    if (nextAttemptNumber >= maxAttempts) {
      await query(
        "UPDATE payment_retry_enrollments SET status = 'exhausted', next_retry_at = NULL, " +
        "attempt_count = ?1, last_failure_code = ?2, ended_at = ?3, end_reason = 'max_attempts' " +
        "WHERE id = ?4",
        [nextAttemptNumber, attemptFailureCode, now, enrollment.id],
      );
      return await _refetchEnrollment(enrollment.id);
    }

    // Schedule has more entries → plan the next retry. The schedule
    // is indexed by retry slot (zero-based: schedule[0] is the
    // delay before attempt #2 — the first scheduler-driven retry,
    // since the initial failure is attempt #1; schedule[1] is the
    // delay before attempt #3, and so on). When tickAdvance just
    // ran attempt #N, the next slot index is N-1.
    var nextAt = _planNextRetry(schedule, nextAttemptNumber - 1, now);
    if (nextAt == null) {
      // Cap not hit yet but no more schedule entries — close as
      // exhausted so a poorly-authored schedule + cap pair can't
      // leave the row spinning.
      await query(
        "UPDATE payment_retry_enrollments SET status = 'exhausted', next_retry_at = NULL, " +
        "attempt_count = ?1, last_failure_code = ?2, ended_at = ?3, end_reason = 'schedule_exhausted' " +
        "WHERE id = ?4",
        [nextAttemptNumber, attemptFailureCode, now, enrollment.id],
      );
      return await _refetchEnrollment(enrollment.id);
    }

    await query(
      "UPDATE payment_retry_enrollments SET attempt_count = ?1, " +
      "last_failure_code = ?2, next_retry_at = ?3 WHERE id = ?4",
      [nextAttemptNumber, attemptFailureCode, nextAt, enrollment.id],
    );
    return await _refetchEnrollment(enrollment.id);
  }

  // -------- public surface --------

  return {
    STATUSES:                STATUSES.slice(),
    MAX_SLUG_LEN:            MAX_SLUG_LEN,
    MAX_FAILURE_CODE_LEN:    MAX_FAILURE_CODE_LEN,
    MAX_REASON_LEN:          MAX_REASON_LEN,
    MAX_DELAY_HOURS:         MAX_DELAY_HOURS,
    MAX_SCHEDULE_STEPS:      MAX_SCHEDULE_STEPS,
    MAX_ATTEMPTS_CAP:        MAX_ATTEMPTS_CAP,
    MAX_LIST_LIMIT:          MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:      DEFAULT_LIST_LIMIT,

    defineRetryPolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentRetries.defineRetryPolicy: input object required");
      }
      var slug          = _slug(input.slug);
      var failureCode   = _failureCode(input.failure_code);
      var schedule      = _retrySchedule(input.retry_schedule);
      var maxAttempts   = _maxAttempts(input.max_attempts);
      var terminalAfter = _terminalAfterAttempts(input.terminal_after_attempts);
      var now           = _now();
      var json          = JSON.stringify(schedule);

      var existing = await _getPolicy(slug);
      if (existing) {
        // Re-define is an upsert. archived_at is preserved on a
        // rewrite (a separate archive surface would clear it).
        await query(
          "UPDATE payment_retry_policies SET failure_code = ?1, retry_schedule_json = ?2, " +
          "max_attempts = ?3, terminal_after_attempts = ?4, updated_at = ?5 WHERE slug = ?6",
          [failureCode, json, maxAttempts, terminalAfter, now, slug],
        );
      } else {
        await query(
          "INSERT INTO payment_retry_policies " +
          "(slug, failure_code, retry_schedule_json, max_attempts, terminal_after_attempts, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
          [slug, failureCode, json, maxAttempts, terminalAfter, now],
        );
      }
      return await _getPolicy(slug);
    },

    enrollFailure: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentRetries.enrollFailure: input object required");
      }
      var paymentIntentId = _uuid(input.payment_intent_id, "payment_intent_id");
      var orderId         = _uuid(input.order_id,          "order_id");
      var customerId      = input.customer_id == null
        ? null
        : _uuid(input.customer_id, "customer_id");
      var failureCode     = _failureCode(input.failure_code);
      var occurredAt      = input.occurred_at == null ? _now() : _epochMs(input.occurred_at, "occurred_at");

      // Idempotent replay — webhook redelivery of the same
      // `payment_intent.payment_failed` collapses to one row.
      var existing = await _getEnrollment(paymentIntentId);
      if (existing) return existing;

      // Operator may pass an explicit policy_slug to override the
      // failure-code lookup. When absent, pick the most-recently-
      // updated active policy for this failure_code.
      var policy;
      if (input.policy_slug != null) {
        policy = await _getPolicy(_slug(input.policy_slug));
        if (!policy) {
          var nfErr = new Error("paymentRetries.enrollFailure: policy " + input.policy_slug + " not found");
          nfErr.code = "POLICY_NOT_FOUND";
          throw nfErr;
        }
        if (policy.archived_at != null) {
          var aErr = new Error("paymentRetries.enrollFailure: policy " + input.policy_slug + " is archived");
          aErr.code = "POLICY_ARCHIVED";
          throw aErr;
        }
      } else {
        policy = await _pickPolicyForFailureCode(failureCode);
        if (!policy) {
          var nfErr2 = new Error("paymentRetries.enrollFailure: no policy for failure_code " + failureCode);
          nfErr2.code = "POLICY_NOT_FOUND";
          throw nfErr2;
        }
      }

      var schedule      = _parseSchedule(policy.retry_schedule_json);
      var terminalAfter = Number(policy.terminal_after_attempts);

      // The initial failure is attempt #1 from the customer's
      // perspective (the original charge attempt). terminal_after_
      // attempts is checked against attempt_count=1 — so a policy
      // with terminal_after_attempts=1 closes the row as abandoned
      // immediately (invalid_card / expired_card semantics).
      var id = b.uuid.v7();

      if (terminalAfter > 0 && 1 >= terminalAfter) {
        // Terminal at enrollment: write the row directly to
        // abandoned + log the initial failure as attempt #1.
        await query(
          "INSERT INTO payment_retry_enrollments " +
          "(id, payment_intent_id, order_id, customer_id, policy_slug, status, attempt_count, " +
          " next_retry_at, last_failure_code, ended_at, end_reason, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 'abandoned', 1, NULL, ?6, ?7, 'terminal_failure_code', ?7)",
          [id, paymentIntentId, orderId, customerId, policy.slug, failureCode, occurredAt],
        );
        await _writeAttempt(id, 1, false, failureCode);
        return await _refetchEnrollment(id);
      }

      // Schedule the first retry. schedule[0] is the delay before
      // the first scheduler-driven retry; an empty schedule means
      // there's no scheduled retry, so close as exhausted (operator
      // can still call recordRetryOutcome to drive things manually,
      // but the scheduler walk is a no-op).
      var nextAt = _planNextRetry(schedule, 0, occurredAt);
      var statusStr  = nextAt == null ? "exhausted" : "active";
      var endedAt    = nextAt == null ? occurredAt : null;
      var endReason  = nextAt == null ? "schedule_exhausted" : null;

      await query(
        "INSERT INTO payment_retry_enrollments " +
        "(id, payment_intent_id, order_id, customer_id, policy_slug, status, attempt_count, " +
        " next_retry_at, last_failure_code, ended_at, end_reason, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11)",
        [id, paymentIntentId, orderId, customerId, policy.slug, statusStr, nextAt, failureCode, endedAt, endReason, occurredAt],
      );
      await _writeAttempt(id, 1, false, failureCode);
      return await _refetchEnrollment(id);
    },

    tickRetries: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentRetries.tickRetries: input object required");
      }
      var now = _epochMs(input.now, "now");
      var batchSize = _limit(input.batch_size);

      var due = await query(
        "SELECT * FROM payment_retry_enrollments " +
        "WHERE status = 'active' AND next_retry_at IS NOT NULL AND next_retry_at <= ?1 " +
        "ORDER BY next_retry_at ASC, id ASC LIMIT ?2",
        [now, batchSize],
      );

      var advanced = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var enrollment = due.rows[i];
        var policy = await _getPolicy(enrollment.policy_slug);
        if (!policy) {
          // Policy went missing between enrollment + tick — close
          // as abandoned so the row doesn't spin forever.
          await query(
            "UPDATE payment_retry_enrollments SET status = 'abandoned', next_retry_at = NULL, " +
            "ended_at = ?1, end_reason = 'policy_missing' WHERE id = ?2",
            [now, enrollment.id],
          );
          advanced.push(await _refetchEnrollment(enrollment.id));
          continue;
        }
        var schedule = _parseSchedule(policy.retry_schedule_json);
        var refreshed = await _tickAdvance(enrollment, policy, schedule, now);
        advanced.push(refreshed);
      }
      return advanced;
    },

    recordRetryOutcome: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentRetries.recordRetryOutcome: input object required");
      }
      var retryId   = _uuid(input.retry_id, "retry_id");
      if (typeof input.succeeded !== "boolean") {
        throw new TypeError("paymentRetries.recordRetryOutcome: succeeded must be a boolean");
      }
      var succeeded = input.succeeded;
      var newFailureCode = input.new_failure_code == null
        ? null
        : _failureCode(input.new_failure_code);

      var r = await query("SELECT * FROM payment_retry_enrollments WHERE id = ?1", [retryId]);
      var enrollment = r.rows[0];
      if (!enrollment) {
        var nfErr = new Error("paymentRetries.recordRetryOutcome: retry_id " + retryId + " not found");
        nfErr.code = "ENROLLMENT_NOT_FOUND";
        throw nfErr;
      }
      if (enrollment.status !== "active") {
        // Already terminal — no-op idempotent return so webhook
        // redelivery doesn't fail.
        return enrollment;
      }

      var policy = await _getPolicy(enrollment.policy_slug);
      if (!policy) {
        var pErr = new Error("paymentRetries.recordRetryOutcome: policy " + enrollment.policy_slug + " missing");
        pErr.code = "POLICY_NOT_FOUND";
        throw pErr;
      }
      var schedule    = _parseSchedule(policy.retry_schedule_json);
      var maxAttempts = Number(policy.max_attempts);

      var now           = _now();
      var attemptCount  = Number(enrollment.attempt_count);
      var nextAttempt   = attemptCount + 1;

      await _writeAttempt(enrollment.id, nextAttempt, succeeded, succeeded ? null : newFailureCode);

      if (succeeded) {
        await query(
          "UPDATE payment_retry_enrollments SET status = 'recovered', next_retry_at = NULL, " +
          "attempt_count = ?1, last_failure_code = NULL, ended_at = ?2, end_reason = 'retry_succeeded' " +
          "WHERE id = ?3",
          [nextAttempt, now, enrollment.id],
        );
        return await _refetchEnrollment(enrollment.id);
      }

      // Failure recorded out-of-band. Apply the same cap + schedule-
      // exhaustion checks as the scheduler tick.
      var effectiveFailureCode = newFailureCode || enrollment.last_failure_code || policy.failure_code;

      if (nextAttempt >= maxAttempts) {
        await query(
          "UPDATE payment_retry_enrollments SET status = 'exhausted', next_retry_at = NULL, " +
          "attempt_count = ?1, last_failure_code = ?2, ended_at = ?3, end_reason = 'max_attempts' " +
          "WHERE id = ?4",
          [nextAttempt, effectiveFailureCode, now, enrollment.id],
        );
        return await _refetchEnrollment(enrollment.id);
      }

      var nextAt = _planNextRetry(schedule, nextAttempt - 1, now);
      if (nextAt == null) {
        await query(
          "UPDATE payment_retry_enrollments SET status = 'exhausted', next_retry_at = NULL, " +
          "attempt_count = ?1, last_failure_code = ?2, ended_at = ?3, end_reason = 'schedule_exhausted' " +
          "WHERE id = ?4",
          [nextAttempt, effectiveFailureCode, now, enrollment.id],
        );
        return await _refetchEnrollment(enrollment.id);
      }

      await query(
        "UPDATE payment_retry_enrollments SET attempt_count = ?1, " +
        "last_failure_code = ?2, next_retry_at = ?3 WHERE id = ?4",
        [nextAttempt, effectiveFailureCode, nextAt, enrollment.id],
      );
      return await _refetchEnrollment(enrollment.id);
    },

    unenrollPayment: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentRetries.unenrollPayment: input object required");
      }
      var paymentIntentId = _uuid(input.payment_intent_id, "payment_intent_id");
      var reason          = _reason(input.reason);

      var enrollment = await _getEnrollment(paymentIntentId);
      if (!enrollment) {
        var nfErr = new Error("paymentRetries.unenrollPayment: payment_intent " + paymentIntentId + " has no enrollment");
        nfErr.code = "ENROLLMENT_NOT_FOUND";
        throw nfErr;
      }
      if (enrollment.status !== "active") {
        return enrollment;
      }

      // Recovery vs abandonment: a reason that signals the payment
      // resolved successfully → recovered; everything else →
      // abandoned. The regex is intentionally narrow so a typo
      // doesn't accidentally count as a recovery.
      var recoveredRe = /^(paid|paid_out_of_band|processor_recovered|recovered|refunded)$/i;
      var nextStatus = recoveredRe.test(reason) ? "recovered" : "abandoned";

      var now = _now();
      await query(
        "UPDATE payment_retry_enrollments SET status = ?1, next_retry_at = NULL, " +
        "ended_at = ?2, end_reason = ?3 WHERE id = ?4",
        [nextStatus, now, reason, enrollment.id],
      );
      return await _refetchEnrollment(enrollment.id);
    },

    statusForPayment: async function (paymentIntentId) {
      paymentIntentId = _uuid(paymentIntentId, "payment_intent_id");
      return await _getEnrollment(paymentIntentId);
    },

    historyForPayment: async function (paymentIntentId) {
      paymentIntentId = _uuid(paymentIntentId, "payment_intent_id");
      var enrollment = await _getEnrollment(paymentIntentId);
      if (!enrollment) return [];
      var r = await query(
        "SELECT * FROM payment_retry_attempts WHERE enrollment_id = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [enrollment.id],
      );
      return r.rows;
    },

    policiesForFailureCode: async function (failureCode) {
      failureCode = _failureCode(failureCode);
      var r = await query(
        "SELECT * FROM payment_retry_policies " +
        "WHERE failure_code = ?1 AND archived_at IS NULL " +
        "ORDER BY updated_at DESC, slug ASC",
        [failureCode],
      );
      return r.rows;
    },

    metricsForPolicy: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("paymentRetries.metricsForPolicy: input object required");
      }
      var slug = _slug(input.slug);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from > to) {
        throw new TypeError("paymentRetries.metricsForPolicy: from must be <= to");
      }

      var r = await query(
        "SELECT status, COUNT(*) AS n FROM payment_retry_enrollments " +
        "WHERE policy_slug = ?1 AND created_at >= ?2 AND created_at <= ?3 " +
        "GROUP BY status",
        [slug, from, to],
      );
      var counts = { active: 0, recovered: 0, exhausted: 0, abandoned: 0 };
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        counts[row.status] = Number(row.n);
      }
      var total = counts.active + counts.recovered + counts.exhausted + counts.abandoned;
      // Recovery rate denominator: total enrolled in the window.
      // Returned as a float in [0, 1] — render-tier formatting
      // (percent, locale) is the caller's concern. A zero-total
      // window returns 0 (no enrollments → no recovery to measure);
      // the caller checks `total_enrolled` to distinguish "no data"
      // from "all failed."
      var recoveryRate = total === 0 ? 0 : counts.recovered / total;
      var exhaustionRate = total === 0 ? 0 : counts.exhausted / total;

      return {
        policy_slug:       slug,
        from:              from,
        to:                to,
        total_enrolled:    total,
        active:            counts.active,
        recovered:         counts.recovered,
        exhausted:         counts.exhausted,
        abandoned:         counts.abandoned,
        recovery_rate:     recoveryRate,
        exhaustion_rate:   exhaustionRate,
      };
    },
  };
}

module.exports = {
  create:               create,
  STATUSES:             STATUSES.slice(),
  MAX_SLUG_LEN:         MAX_SLUG_LEN,
  MAX_FAILURE_CODE_LEN: MAX_FAILURE_CODE_LEN,
  MAX_REASON_LEN:       MAX_REASON_LEN,
  MAX_DELAY_HOURS:      MAX_DELAY_HOURS,
  MAX_SCHEDULE_STEPS:   MAX_SCHEDULE_STEPS,
  MAX_ATTEMPTS_CAP:     MAX_ATTEMPTS_CAP,
  MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:   DEFAULT_LIST_LIMIT,
};
