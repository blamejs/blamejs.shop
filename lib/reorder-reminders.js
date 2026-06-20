"use strict";
/**
 * @module shop.reorderReminders
 * @title  Reorder reminders — customer-facing "time to reorder" nudges
 *
 * @intro
 *   Distinct from `reorderThresholds` (the sibling primitive that
 *   answers "the operator's warehouse is low — propose a PO to the
 *   supplier"). This primitive answers a different question: "the
 *   customer's pantry is low — nudge them to reorder before they
 *   run out". Consumable categories (water filters, contact lenses,
 *   pet food, vitamins, coffee beans) have a predictable run-out
 *   cadence; missing the reorder window costs the operator a
 *   recurring-revenue line.
 *
 *   The shape:
 *
 *     var rr = b.shop.reorderReminders.create({
 *       query:         q,
 *       order:         orderPrimitive,   // optional read-only dep
 *       notifications: notif,            // wired for in_app dispatch
 *       email:         email,            // wired for email dispatch
 *     });
 *
 *     // Operator defines the cadence for each consumable SKU.
 *     await rr.defineReminderProfile({
 *       sku:                   "FILTER-PUR-12M",
 *       interval_days:         365,
 *       message_template_slug: "reorder-filter-12m",
 *       channel:               "email",
 *     });
 *
 *     // The order-completion hook enrols the customer with the
 *     // recorded purchase timestamp; absent that timestamp, the
 *     // enrolment falls back to "now" and the first reminder fires
 *     // `interval_days` from today.
 *     await rr.enrollCustomerSku({
 *       customer_id:   customerId,
 *       sku:           "FILTER-PUR-12M",
 *       last_order_at: orderRow.placed_at,
 *     });
 *
 *     // Scheduler tick — operator wires this to a cron / Workers
 *     // Cron Trigger. Pulls every active enrollment whose
 *     // next_remind_at is due, dispatches via the profile's channel,
 *     // and stamps a `reorder_dispatches` row per send.
 *     await rr.dispatchTick({ now: Date.now() });
 *
 *   Verbs:
 *     defineReminderProfile — register / replace the SKU's cadence.
 *       Per-SKU uniqueness; redefining the active row patches it in
 *       place rather than archiving (the SKU's cadence is global,
 *       not versioned per customer).
 *
 *     enrollCustomerSku — enrol a (customer_id, sku) pair on the
 *       given last_order_at. `next_remind_at` is computed from the
 *       profile's interval_days. Re-enrolling the same pair refreshes
 *       last_order_at and re-arms the next reminder — the operator
 *       calls this from every order-completion hook so the nudge
 *       window always tracks the freshest purchase.
 *
 *     dispatchTick — pull every active enrollment whose
 *       next_remind_at <= now, walk each via the profile's channel,
 *       stamp a dispatches row, and advance next_remind_at by one
 *       interval. Returns the dispatched rows so the caller can log.
 *
 *     recordSent / markFailed — terminal markers for the channel
 *       hooks. `dispatchTick` calls these inline when the channel
 *       composition returns; an operator with an async provider
 *       (deferred email gateway, SMS DLR callback) can also call
 *       them out-of-band against an `enrollment_id` they captured.
 *
 *     remindersForCustomer — customer-portal read of an account's
 *       enrollments. Filter by status; cursor paginates oldest-first.
 *
 *     unsubscribeFromSku — flip an enrollment to `cancelled` with
 *       the unsubscribed_at stamp. Idempotent. Future dispatchTick
 *       runs skip the row.
 *
 *     metricsForProfile — count sent / failed dispatches in a
 *       window for one SKU. Powers the operator's "is this nudge
 *       converting" dashboard.
 *
 *   Composition:
 *     - b.uuid.v7    — enrollment + dispatch row ids
 *     - b.guardUuid  — customer_id sanitization at every entry point
 *     - notifications (optional) — `in_app` channel composes
 *       `notifications.enqueue`
 *     - email (optional) — `email` channel composes `email.send`
 *       (or any wired-shape `send({ to, template, ... })` hook)
 *     - sms (optional) — `sms` channel composes `sms.send`
 *
 *   Three-tier input validation: every public verb is a config-time
 *   entry point (defineReminderProfile) or a defensive request-
 *   shape reader (everything else). All shapes throw on bad input;
 *   no drop-silent hot paths.
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SKU_RE              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var SLUG_RE             = /^[a-z0-9][a-z0-9._-]{0,127}$/;
var ID_RE               = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var DAY_MS              = C.TIME.days(1);
var MAX_INTERVAL_DAYS   = 3650;        // 10 years — same envelope as supplier lead times; refuses Number.MAX_SAFE_INTEGER typos
var MAX_BATCH_SIZE      = 500;
var DEFAULT_BATCH_SIZE  = 100;
var MAX_LIMIT           = 500;
var DEFAULT_LIMIT       = 50;
var MAX_REASON_LEN      = 1024;
var CHANNELS            = Object.freeze(["email", "sms", "in_app"]);
var STATUSES            = Object.freeze(["active", "paused", "cancelled"]);
var DISPATCH_STATUSES   = Object.freeze(["sent", "failed"]);

// ---- monotonic clock ----------------------------------------------------
//
// Two enrollments / dispatches written inside the same millisecond would
// otherwise collide on the v7-uuid timestamp prefix and tie on
// (next_remind_at, id) ordering. The monotonic step guarantees strict-
// increase so the dispatcher's batch read returns a deterministic order
// without depending on the v7 sub-ms counter.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("reorder-reminders: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _templateSlug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("reorder-reminders: message_template_slug must match /^[a-z0-9][a-z0-9._-]*$/ (lowercase alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _channel(s) {
  if (typeof s !== "string" || CHANNELS.indexOf(s) === -1) {
    throw new TypeError("reorder-reminders: channel must be one of " + CHANNELS.join(", "));
  }
  return s;
}

function _intervalDays(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_INTERVAL_DAYS) {
    throw new TypeError("reorder-reminders: interval_days must be a positive integer ≤ " + MAX_INTERVAL_DAYS);
  }
  return n;
}

function _customerId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("reorder-reminders: customer_id — " + (e && e.message || "invalid UUID"));
  }
}

function _id(s, label) {
  if (typeof s !== "string" || !ID_RE.test(s)) {
    throw new TypeError("reorder-reminders: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("reorder-reminders: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _optionalEpochMs(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("reorder-reminders: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("reorder-reminders: batch_size must be an integer in 1.." + MAX_BATCH_SIZE);
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("reorder-reminders: limit must be an integer in 1.." + MAX_LIMIT);
  }
  return n;
}

function _failReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("reorder-reminders: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("reorder-reminders: reason must be ≤ " + MAX_REASON_LEN + " characters");
  }
  return s;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  // `order` is held as an optional read-only marker — operators that
  // want the primitive to backfill last_order_at from a recent order
  // can compose that at the caller. The primitive never reads from
  // this dep directly today; the factory accepts it so the wiring is
  // explicit at construction time and a future verb can consume it
  // without changing the public factory shape.
  var order = opts.order || null;
  if (order !== null && typeof order !== "object") {
    throw new TypeError("reorder-reminders.create: opts.order must be an object or null");
  }
  var notifications = opts.notifications || null;
  if (notifications !== null && typeof notifications !== "object") {
    throw new TypeError("reorder-reminders.create: opts.notifications must be an object or null");
  }
  var email = opts.email || null;
  if (email !== null && typeof email !== "object") {
    throw new TypeError("reorder-reminders.create: opts.email must be an object or null");
  }
  var sms = opts.sms || null;
  if (sms !== null && typeof sms !== "object") {
    throw new TypeError("reorder-reminders.create: opts.sms must be an object or null");
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // ---- internal shapers ------------------------------------------------

  function _shapeProfile(row) {
    if (!row) return null;
    return {
      sku:                   row.sku,
      interval_days:         row.interval_days,
      message_template_slug: row.message_template_slug,
      channel:               row.channel,
      archived_at:           row.archived_at,
      created_at:            row.created_at,
      updated_at:            row.updated_at,
    };
  }

  function _shapeEnrollment(row) {
    if (!row) return null;
    return {
      id:               row.id,
      customer_id:      row.customer_id,
      sku:              row.sku,
      last_order_at:    row.last_order_at,
      next_remind_at:   row.next_remind_at,
      status:           row.status,
      unsubscribed_at:  row.unsubscribed_at,
      created_at:       row.created_at,
    };
  }

  function _shapeDispatch(row) {
    if (!row) return null;
    return {
      id:             row.id,
      enrollment_id:  row.enrollment_id,
      status:         row.status,
      occurred_at:    row.occurred_at,
      fail_reason:    row.fail_reason,
    };
  }

  async function _getActiveProfile(sku) {
    var r = await query(
      "SELECT * FROM reorder_profiles WHERE sku = ?1 AND archived_at IS NULL LIMIT 1",
      [sku],
    );
    return r.rows[0] || null;
  }

  async function _getProfileBySku(sku) {
    var r = await query(
      "SELECT * FROM reorder_profiles WHERE sku = ?1 LIMIT 1",
      [sku],
    );
    return r.rows[0] || null;
  }

  async function _getEnrollmentById(id) {
    var r = await query(
      "SELECT * FROM reorder_enrollments WHERE id = ?1 LIMIT 1",
      [id],
    );
    return r.rows[0] || null;
  }

  async function _getEnrollmentByPair(customerId, sku) {
    var r = await query(
      "SELECT * FROM reorder_enrollments WHERE customer_id = ?1 AND sku = ?2 LIMIT 1",
      [customerId, sku],
    );
    return r.rows[0] || null;
  }

  // Dispatch one due enrollment through the profile's channel. Returns
  // `{ ok: true }` on success, `{ ok: false, reason }` on failure. The
  // channel deps are optional at factory time so the primitive can be
  // exercised in isolation; a missing dep for a configured channel is
  // a typed failure rather than a silent drop — the operator either
  // wires the dep or archives the profile.
  async function _dispatchOne(enrollment, profile) {
    if (profile.channel === "in_app") {
      if (!notifications || typeof notifications.enqueue !== "function") {
        return { ok: false, reason: "notifications-dep-missing" };
      }
      try {
        await notifications.enqueue({
          recipient_id: enrollment.customer_id,
          channel:      "in-app",
          event_type:   "reorder.reminder",
          title:        "Time to reorder " + enrollment.sku,
          body:         "Reorder reminder for " + enrollment.sku,
          payload:      {
            sku:           enrollment.sku,
            template_slug: profile.message_template_slug,
            enrollment_id: enrollment.id,
          },
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "notifications-enqueue-failed: " + (e && e.message || "unknown") };
      }
    }
    if (profile.channel === "email") {
      if (!email || typeof email.send !== "function") {
        return { ok: false, reason: "email-dep-missing" };
      }
      try {
        await email.send({
          to:            enrollment.customer_id,
          template:      profile.message_template_slug,
          sku:           enrollment.sku,
          enrollment_id: enrollment.id,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "email-send-failed: " + (e && e.message || "unknown") };
      }
    }
    if (profile.channel === "sms") {
      if (!sms || typeof sms.send !== "function") {
        return { ok: false, reason: "sms-dep-missing" };
      }
      try {
        await sms.send({
          customer_id:   enrollment.customer_id,
          template:      profile.message_template_slug,
          sku:           enrollment.sku,
          enrollment_id: enrollment.id,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "sms-send-failed: " + (e && e.message || "unknown") };
      }
    }
    // Defensive: the CHECK constraint refuses any other value at the
    // SQL boundary, but the branch is reached only via a corrupted
    // row — surface a typed reason rather than a silent skip.
    return { ok: false, reason: "unknown-channel: " + profile.channel };
  }

  return {

    // Constants surfaced for tests + admin dashboards.
    CHANNELS:           CHANNELS,
    STATUSES:           STATUSES,
    DISPATCH_STATUSES:  DISPATCH_STATUSES,

    // Register / replace the SKU's reorder cadence. The SKU is the PK
    // — a profile's cadence is global to the catalog. Redefining the
    // same SKU patches the existing row in place (interval_days /
    // message_template_slug / channel) rather than archiving; the
    // archived path is reserved for "stop nudging this SKU at all".
    defineReminderProfile: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-reminders.defineReminderProfile: input object required");
      }
      var sku                  = _sku(input.sku);
      var intervalDays         = _intervalDays(input.interval_days);
      var messageTemplateSlug  = _templateSlug(input.message_template_slug);
      var channel              = _channel(input.channel);

      var existing = await _getProfileBySku(sku);
      var ts       = _now();
      if (existing) {
        // Patch in place — clearing archived_at if the operator is
        // re-activating an archived profile.
        await query(
          "UPDATE reorder_profiles SET interval_days = ?1, message_template_slug = ?2, " +
          "channel = ?3, archived_at = NULL, updated_at = ?4 WHERE sku = ?5",
          [intervalDays, messageTemplateSlug, channel, ts, sku],
        );
        return _shapeProfile(await _getProfileBySku(sku));
      }
      await query(
        "INSERT INTO reorder_profiles (sku, interval_days, message_template_slug, channel, " +
        "archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
        [sku, intervalDays, messageTemplateSlug, channel, ts],
      );
      return _shapeProfile(await _getProfileBySku(sku));
    },

    // Enrol a (customer_id, sku) pair. The profile MUST be active —
    // an operator that archives the profile has paused the campaign
    // and shouldn't be silently enrolling new customers. Re-enrolling
    // the same pair refreshes last_order_at and re-arms next_remind_at
    // (the order-completion hook is the canonical caller, and every
    // fresh order should reset the cadence).
    enrollCustomerSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-reminders.enrollCustomerSku: input object required");
      }
      var customerId  = _customerId(input.customer_id);
      var sku         = _sku(input.sku);
      var lastOrderAt = input.last_order_at == null ? _now() : _epochMs(input.last_order_at, "last_order_at");

      var profile = await _getActiveProfile(sku);
      if (!profile) {
        throw new TypeError("reorder-reminders.enrollCustomerSku: no active reminder profile for sku " +
          JSON.stringify(sku) + " — call defineReminderProfile first");
      }
      var nextRemindAt = lastOrderAt + profile.interval_days * DAY_MS;
      var ts           = _now();
      var existing     = await _getEnrollmentByPair(customerId, sku);
      if (existing) {
        // Re-enrolment refreshes the cadence + clears any prior
        // unsubscribe / paused state. Operators that want sticky opt-
        // outs hold the customer's unsubscribe at a higher layer; this
        // primitive treats a fresh order as an implicit re-opt-in,
        // which matches the operator's intent for the hook ("they
        // just bought it again — keep nudging them").
        await query(
          "UPDATE reorder_enrollments SET last_order_at = ?1, next_remind_at = ?2, " +
          "status = 'active', unsubscribed_at = NULL WHERE id = ?3",
          [lastOrderAt, nextRemindAt, existing.id],
        );
        return _shapeEnrollment(await _getEnrollmentById(existing.id));
      }
      var id = b.uuid.v7({ now: ts });
      await query(
        "INSERT INTO reorder_enrollments (id, customer_id, sku, last_order_at, next_remind_at, " +
        "status, unsubscribed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', NULL, ?6)",
        [id, customerId, sku, lastOrderAt, nextRemindAt, ts],
      );
      return _shapeEnrollment(await _getEnrollmentById(id));
    },

    // Scheduler tick: pull every active enrollment whose
    // next_remind_at is due, dispatch via the profile's channel,
    // stamp a dispatches row per attempt, and advance next_remind_at
    // by one interval (on success only — failed rows stay at the
    // current next_remind_at so the retry sweep picks them up on the
    // next tick). Returns the dispatched rows so the caller can log.
    dispatchTick: async function (input) {
      input = input || {};
      var now       = input.now == null ? _now() : _epochMs(input.now, "now");
      var batchSize = _batchSize(input.batch_size);

      var due = await query(
        "SELECT * FROM reorder_enrollments " +
        "WHERE status = 'active' AND next_remind_at <= ?1 " +
        "ORDER BY next_remind_at ASC, id ASC LIMIT ?2",
        [now, batchSize],
      );

      var dispatched = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var enrollment = due.rows[i];
        var profile = await _getActiveProfile(enrollment.sku);
        var dispatchId = b.uuid.v7({ now: _now() });
        if (!profile) {
          // Profile archived after enrollment — terminal-fail the
          // attempt so the operator's metrics surface the
          // misconfiguration. The enrollment stays active so the
          // operator can re-define the profile and the next tick
          // sweeps it.
          await query(
            "INSERT INTO reorder_dispatches (id, enrollment_id, status, occurred_at, fail_reason) " +
            "VALUES (?1, ?2, 'failed', ?3, ?4)",
            [dispatchId, enrollment.id, _now(), "profile-archived-or-missing"],
          );
          dispatched.push(_shapeDispatch({
            id:            dispatchId,
            enrollment_id: enrollment.id,
            status:        "failed",
            occurred_at:   now,
            fail_reason:   "profile-archived-or-missing",
          }));
          continue;
        }

        // Claim this row BEFORE sending. The send (email/sms/in_app)
        // is an exactly-once side-effect; two concurrent ticks both
        // read this same due row from the snapshot SELECT above and
        // would both fire it. Advancing next_remind_at conditionally
        // on the value we observed (next_remind_at = the snapshot's
        // value) is the atomic claim — SQLite/D1 serializes writers,
        // so exactly one tick's UPDATE matches and the loser sees
        // rowCount 0 and skips the send. We claim by advancing one
        // interval from the OBSERVED next_remind_at (not `now`) so a
        // late tick doesn't drift the cadence forward.
        var nextRemindAt = enrollment.next_remind_at + profile.interval_days * DAY_MS;
        var claim = await query(
          "UPDATE reorder_enrollments SET next_remind_at = ?1 " +
          "WHERE id = ?2 AND status = 'active' AND next_remind_at = ?3",
          [nextRemindAt, enrollment.id, enrollment.next_remind_at],
        );
        if (Number(claim.rowCount || 0) !== 1) {
          // Another tick already advanced this row's cursor (or it was
          // cancelled between the SELECT and now) — it owns the send.
          // Skip without dispatching so the customer is nudged once.
          continue;
        }

        var result = await _dispatchOne(enrollment, profile);
        var occurredAt = _now();
        if (result.ok) {
          await query(
            "INSERT INTO reorder_dispatches (id, enrollment_id, status, occurred_at, fail_reason) " +
            "VALUES (?1, ?2, 'sent', ?3, NULL)",
            [dispatchId, enrollment.id, occurredAt],
          );
          // Cadence already advanced by the claim above; the send
          // succeeded, so the row stays at the new next_remind_at.
          dispatched.push(_shapeDispatch({
            id:            dispatchId,
            enrollment_id: enrollment.id,
            status:        "sent",
            occurred_at:   occurredAt,
            fail_reason:   null,
          }));
        } else {
          // The send failed after we won the claim. Roll the cursor to a
          // value DISTINCT from the one this tick observed (observed + 1ms),
          // NOT back to the exact observed value: a concurrent overlapping
          // tick that read the same observed cursor is waiting to claim
          // `next_remind_at = observed`, and restoring the exact observed
          // value would let it match and re-send in the same overlap.
          // observed+1 is still <= now, so the row stays due and a LATER
          // tick retries it (deferred, not re-fired in this overlap). The
          // guard on the value we set means a concurrent re-enrolment that
          // moved the cursor forward isn't clobbered.
          await query(
            "UPDATE reorder_enrollments SET next_remind_at = ?1 " +
            "WHERE id = ?2 AND next_remind_at = ?3",
            [enrollment.next_remind_at + 1, enrollment.id, nextRemindAt],
          );
          await query(
            "INSERT INTO reorder_dispatches (id, enrollment_id, status, occurred_at, fail_reason) " +
            "VALUES (?1, ?2, 'failed', ?3, ?4)",
            [dispatchId, enrollment.id, occurredAt, result.reason],
          );
          dispatched.push(_shapeDispatch({
            id:            dispatchId,
            enrollment_id: enrollment.id,
            status:        "failed",
            occurred_at:   occurredAt,
            fail_reason:   result.reason,
          }));
        }
      }
      return dispatched;
    },

    // Terminal marker for async channel hooks. The synchronous path
    // through dispatchTick stamps these inline, but an async provider
    // (deferred email gateway, SMS DLR callback) writes through here.
    // The enrollment_id is the only key; reminder_id is the dispatch
    // row id and is generated here, so the operator's hook only needs
    // the enrollment.
    recordSent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-reminders.recordSent: input object required");
      }
      var enrollmentId = _id(input.reminder_id || input.enrollment_id, "reminder_id");
      var sentAt       = input.sent_at == null ? _now() : _epochMs(input.sent_at, "sent_at");
      var enrollment   = await _getEnrollmentById(enrollmentId);
      if (!enrollment) {
        throw new TypeError("reorder-reminders.recordSent: enrollment_id " +
          JSON.stringify(enrollmentId) + " not found");
      }
      var dispatchId = b.uuid.v7({ now: _now() });
      await query(
        "INSERT INTO reorder_dispatches (id, enrollment_id, status, occurred_at, fail_reason) " +
        "VALUES (?1, ?2, 'sent', ?3, NULL)",
        [dispatchId, enrollmentId, sentAt],
      );
      // Advance the cadence here too — recordSent is the terminal
      // marker for a successful send regardless of which path
      // (sync via dispatchTick / async via provider callback)
      // produced the row.
      var profile = await _getActiveProfile(enrollment.sku);
      if (profile) {
        var nextRemindAt = enrollment.next_remind_at + profile.interval_days * DAY_MS;
        await query(
          "UPDATE reorder_enrollments SET next_remind_at = ?1 WHERE id = ?2",
          [nextRemindAt, enrollmentId],
        );
      }
      var r = await query(
        "SELECT * FROM reorder_dispatches WHERE id = ?1 LIMIT 1",
        [dispatchId],
      );
      return _shapeDispatch(r.rows[0]);
    },

    markFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-reminders.markFailed: input object required");
      }
      var enrollmentId = _id(input.reminder_id || input.enrollment_id, "reminder_id");
      var reason       = _failReason(input.reason);
      var enrollment   = await _getEnrollmentById(enrollmentId);
      if (!enrollment) {
        throw new TypeError("reorder-reminders.markFailed: enrollment_id " +
          JSON.stringify(enrollmentId) + " not found");
      }
      var occurredAt = _now();
      var dispatchId = b.uuid.v7({ now: occurredAt });
      await query(
        "INSERT INTO reorder_dispatches (id, enrollment_id, status, occurred_at, fail_reason) " +
        "VALUES (?1, ?2, 'failed', ?3, ?4)",
        [dispatchId, enrollmentId, occurredAt, reason],
      );
      var r = await query(
        "SELECT * FROM reorder_dispatches WHERE id = ?1 LIMIT 1",
        [dispatchId],
      );
      return _shapeDispatch(r.rows[0]);
    },

    // Customer-portal read. Defaults to all statuses; cursor is the
    // created_at of the last row returned (oldest-first the customer
    // sees their longest-running subscriptions). Optional `status`
    // filter narrows to active / paused / cancelled.
    remindersForCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-reminders.remindersForCustomer: input object required");
      }
      var customerId = _customerId(input.customer_id);
      var limit      = _limit(input.limit);
      var cursor     = _optionalEpochMs(input.cursor, "cursor");
      var status     = input.status == null ? null : _status(input.status);

      var clauses = ["customer_id = ?1"];
      var params  = [customerId];
      var idx     = 2;
      if (status) {
        clauses.push("status = ?" + idx); params.push(status); idx += 1;
      }
      if (cursor != null) {
        clauses.push("created_at > ?" + idx); params.push(cursor); idx += 1;
      }
      params.push(limit);
      var sql = "SELECT * FROM reorder_enrollments WHERE " + clauses.join(" AND ") +
                " ORDER BY created_at ASC, id ASC LIMIT ?" + idx;
      var r = await query(sql, params);
      var rows = r.rows.map(_shapeEnrollment);
      var nextCursor = null;
      if (rows.length === limit) {
        nextCursor = Number(rows[rows.length - 1].created_at);
      }
      return { rows: rows, next_cursor: nextCursor };
    },

    // Flip an enrollment to `cancelled` with the unsubscribed_at
    // stamp. Idempotent — re-cancelling preserves the original
    // unsubscribed_at. Future dispatchTick runs skip the row because
    // the partial index targets `status = 'active'`.
    unsubscribeFromSku: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-reminders.unsubscribeFromSku: input object required");
      }
      var customerId = _customerId(input.customer_id);
      var sku        = _sku(input.sku);
      var existing   = await _getEnrollmentByPair(customerId, sku);
      if (!existing) {
        throw new TypeError("reorder-reminders.unsubscribeFromSku: no enrollment for customer " +
          JSON.stringify(customerId) + " sku " + JSON.stringify(sku));
      }
      if (existing.status === "cancelled") {
        return _shapeEnrollment(existing);
      }
      var ts = _now();
      await query(
        "UPDATE reorder_enrollments SET status = 'cancelled', unsubscribed_at = ?1 WHERE id = ?2",
        [ts, existing.id],
      );
      return _shapeEnrollment(await _getEnrollmentById(existing.id));
    },

    // Window-scoped metrics. Counts sent / failed dispatches for one
    // SKU between `from` and `to`. The operator's dashboard powers
    // "what's the success rate for this nudge campaign" off this.
    metricsForProfile: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("reorder-reminders.metricsForProfile: input object required");
      }
      var sku  = _sku(input.sku);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to, "to");
      if (to < from) {
        throw new TypeError("reorder-reminders.metricsForProfile: to (" + to +
          ") must be ≥ from (" + from + ")");
      }
      var r = await query(
        "SELECT d.status AS s, COUNT(*) AS c FROM reorder_dispatches d " +
        "JOIN reorder_enrollments e ON e.id = d.enrollment_id " +
        "WHERE e.sku = ?1 AND d.occurred_at >= ?2 AND d.occurred_at <= ?3 " +
        "GROUP BY d.status",
        [sku, from, to],
      );
      var sent = 0;
      var failed = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        if (row.s === "sent") sent = Number(row.c) || 0;
        else if (row.s === "failed") failed = Number(row.c) || 0;
      }
      return {
        sku:          sku,
        from:         from,
        to:           to,
        sent_count:   sent,
        failed_count: failed,
        total_count:  sent + failed,
      };
    },
  };
}

// Top-level `run()` for direct invocation — exercises the primitive's
// factory shape against an in-memory query stub so the smoke caller
// (operator's release pipeline) can confirm the module loads + the
// factory composes without touching a remote D1 or a migration file.
// The stub is a minimal in-memory map indexed by SQL verb; it covers
// enough of the surface to round-trip a defineReminderProfile call.
async function run() {
  var profiles = {};
  var enrolments = [];
  var dispatches = [];
  var q = async function (sql, params) {
    params = params || [];
    var verb = sql.replace(/^\s+/, "").split(/\s+/)[0].toUpperCase();
    if (verb === "SELECT" && /FROM reorder_profiles/.test(sql)) {
      var sku = params[0];
      var p = profiles[sku];
      return { rows: p ? [p] : [], rowCount: p ? 1 : 0 };
    }
    if (verb === "INSERT" && /reorder_profiles/.test(sql)) {
      profiles[params[0]] = {
        sku:                   params[0],
        interval_days:         params[1],
        message_template_slug: params[2],
        channel:               params[3],
        archived_at:           null,
        created_at:            params[4],
        updated_at:            params[4],
      };
      return { rows: [], rowCount: 1 };
    }
    if (verb === "UPDATE" && /reorder_profiles/.test(sql)) {
      var existing = profiles[params[4]];
      if (existing) {
        existing.interval_days         = params[0];
        existing.message_template_slug = params[1];
        existing.channel               = params[2];
        existing.archived_at           = null;
        existing.updated_at            = params[3];
      }
      return { rows: [], rowCount: existing ? 1 : 0 };
    }
    // Untouched paths return an empty result — the smoke caller
    // only exercises defineReminderProfile.
    return { rows: [], rowCount: 0 };
  };
  // Keep the unused locals referenced so a future smoke extension can
  // walk the full surface without a dangling-variable lint trip.
  void enrolments; void dispatches;
  var rr = create({ query: q });
  await rr.defineReminderProfile({
    sku:                   "FILTER-PUR-12M",
    interval_days:         365,
    message_template_slug: "reorder-filter-12m",
    channel:               "in_app",
  });
  return { ok: true };
}

module.exports = {
  create:             create,
  run:                run,
  CHANNELS:           CHANNELS,
  STATUSES:           STATUSES,
  DISPATCH_STATUSES:  DISPATCH_STATUSES,
};
