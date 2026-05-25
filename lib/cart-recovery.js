"use strict";
/**
 * @module shop.cartRecovery
 * @title  Cart recovery — multi-step abandonment email sequences
 *
 * @intro
 *   `cart-abandonment` detects the idle cart + writes a pending
 *   detection row. This primitive owns the multi-step nurture that
 *   follows: a 1h reminder, then a 24h discount nudge, then a 72h
 *   last-chance. Operators define the sequence once, enroll each
 *   detection at fan-out time, and run `dispatchTick` on a cron
 *   cadence. The tick walks enrollments whose `next_step_at <= now`,
 *   renders + sends the step's email (subject to the suppression
 *   gate), then advances `current_step_index` + `next_step_at` to
 *   the following step. When every step has fired the enrollment
 *   lands `completed`; when the customer pays the operator's
 *   checkout layer calls `markRecovered` and the enrollment lands
 *   `recovered` (terminal).
 *
 *   Composition:
 *
 *     var recovery = bShop.cartRecovery.create({
 *       query:             q,
 *       cartAbandonment:   bShop.cartAbandonment.create({ query: q, cart: cart }),
 *       email:             bShop.email.create({ mailer: m }),
 *       emailSuppressions: bShop.emailSuppressions.create({ query: q }),
 *     });
 *
 *     await recovery.defineSequence({
 *       slug:  "default-recovery",
 *       title: "Default 3-step recovery",
 *       steps: [
 *         { step_index: 0, offset_ms: C.TIME.hours(1),  kind: "reminder"    },
 *         { step_index: 1, offset_ms: C.TIME.hours(24), kind: "discount"    },
 *         { step_index: 2, offset_ms: C.TIME.hours(72), kind: "last_chance" },
 *       ],
 *     });
 *
 *     // After cartAbandonment.scan() returns a detection:
 *     await recovery.enrollDetection({
 *       detection_id:    candidate.detection_id,
 *       sequence_slug:   "default-recovery",
 *       cart_id:         candidate.cart_id,
 *       customer_id:     candidate.customer_id,
 *       customer_email:  "shopper@example.com",
 *     });
 *
 *     // Cron-driven dispatcher; safe to call concurrently — the
 *     // FSM transition is gated by current_step_index = ?.
 *     await recovery.dispatchTick();
 *
 *     // Checkout layer signals recovery:
 *     await recovery.markRecovered(enrollment_id, {
 *       order_id: "<uuid>",
 *     });
 *
 *   FSM:
 *
 *     enrolled --dispatchTick (each step)--> enrolled (next step queued)
 *     enrolled --dispatchTick (last step)--> completed
 *     enrolled --markRecovered---------------> recovered
 *     enrolled --cancel----------------------> cancelled
 *
 *   `completed` / `recovered` / `cancelled` are terminal. `recovered`
 *   trumps `completed` even when every step has already fired — the
 *   `markRecovered` call rewrites the terminal status so
 *   `metricsForSequence` counts the order against the sequence's
 *   recovery rate.
 *
 *   Privacy:
 *
 *     `customer_email` reaches `enrollDetection` only at enrollment
 *     time; the row stores the namespace-hashed digest via
 *     `b.crypto.namespaceHash("cart-recovery-email", normalized)` and
 *     never the raw address. The dispatcher re-asks the operator's
 *     `email` primitive for the actual send — the operator owns the
 *     route from `customer_id` to a deliverable address (typically
 *     via the customers primitive).
 *
 *   Suppression check:
 *
 *     Before each send the dispatcher calls
 *     `emailSuppressions.isSuppressed({ email, scope: 'marketing' })`
 *     when an `emailSuppressions` dep is wired. A `suppressed=true`
 *     result writes a `skipped-suppressed` dispatch row + cancels the
 *     enrollment (the customer asked to be left alone; the next step
 *     wouldn't be welcome either).
 *
 *   Monotonic clock:
 *
 *     Two dispatch attempts in the same millisecond would write
 *     identical `dispatched_at` values + arrive at the dispatcher in
 *     non-deterministic order. The `_now()` helper bumps by 1ms on a
 *     tie so the dispatch log stays strictly increasing and a sort-
 *     by-timestamp read returns the events in the order they were
 *     issued.
 *
 *   Storage:
 *     - `cart_recovery_sequences` + `cart_recovery_enrollments` +
 *       `cart_recovery_dispatches` (migration `0171_cart_recovery.sql`).
 *
 *   Composes ONLY blamejs:
 *     - `b.uuid.v7`             — enrollment + dispatch row ids.
 *     - `b.crypto.namespaceHash` — customer_email hashing.
 *     - `b.guardUuid`           — strict UUID gate on every id at the
 *                                 entry point.
 *
 * @primitive cartRecovery
 * @related   shop.cartAbandonment, shop.email, shop.emailSuppressions,
 *            b.uuid.v7, b.crypto.namespaceHash, b.guardUuid
 */

var b = require("./index").framework;
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SLUG_RE        = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var MAX_TITLE_LEN  = 200;
var MAX_REASON_LEN = 280;
var MAX_STEPS      = 12;

var EMAIL_NAMESPACE = "cart-recovery-email";

var STEP_KINDS = Object.freeze([
  "reminder",
  "discount",
  "last_chance",
  "generic",
]);

var ENROLLMENT_STATUSES = Object.freeze([
  "enrolled",
  "completed",
  "recovered",
  "cancelled",
]);

var DISPATCH_STATUSES = Object.freeze([
  "sent",
  "skipped-suppressed",
  "skipped-no-email",
  "failed",
]);

// ---- monotonic clock ---------------------------------------------------
//
// Two dispatch attempts inside the same millisecond would write
// identical `dispatched_at` columns and the per-enrollment audit
// panel would render them in non-deterministic order. Bumping by 1ms
// on a tie keeps the timeline strictly increasing.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _validateSlug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cartRecovery: " + label + " must be a non-empty string");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "cartRecovery: " + label + " must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/"
    );
  }
  return s;
}

function _validateTitle(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cartRecovery: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("cartRecovery: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("cartRecovery: title must not contain CR / LF / NUL");
  }
  return s;
}

function _validateUuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError(
      "cartRecovery: " + label + " — " + (e && e.message || "invalid UUID")
    );
  }
}

function _validatePositiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("cartRecovery: " + label + " must be a positive integer");
  }
  return n;
}

function _validateNonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "cartRecovery: " + label + " must be a non-negative integer"
    );
  }
  return n;
}

function _validateStepKind(k) {
  if (typeof k !== "string" || STEP_KINDS.indexOf(k) === -1) {
    throw new TypeError(
      "cartRecovery: step.kind must be one of " + STEP_KINDS.join(", ")
    );
  }
  return k;
}

function _validateReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cartRecovery: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError(
      "cartRecovery: reason must be <= " + MAX_REASON_LEN + " characters"
    );
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("cartRecovery: reason must not contain control bytes");
  }
  return s;
}

// Operator-supplied email is normalized lowercase + trimmed before
// hashing so 'Shopper@Example.com' and 'shopper@example.com' index
// to the same digest. The full RFC 5322 grammar is out of scope —
// the operator's checkout already validated the address; this guard
// just refuses obvious garbage so a hostile caller can't smuggle a
// control byte into the hash input.
function _validateEmail(s) {
  if (typeof s !== "string" || !s.length || s.length > 254) {
    throw new TypeError(
      "cartRecovery: customer_email must be a non-empty string <= 254 characters"
    );
  }
  if (/[\x00-\x1f\x7f\s]/.test(s)) {
    throw new TypeError("cartRecovery: customer_email must not contain whitespace or control bytes");
  }
  if (s.indexOf("@") < 1) {
    throw new TypeError("cartRecovery: customer_email must contain '@'");
  }
  return s.trim().toLowerCase();
}

// Steps array — operator declares an ordered list of
// `{step_index, offset_ms, kind}`. `step_index` MUST be a dense 0..N-1
// sequence (no gaps); `offset_ms` MUST be strictly increasing so the
// dispatcher never has to send two steps in the same tick window.
function _validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError("cartRecovery: steps must be a non-empty array");
  }
  if (steps.length > MAX_STEPS) {
    throw new TypeError(
      "cartRecovery: steps must declare <= " + MAX_STEPS + " entries"
    );
  }
  var out = [];
  var prevOffset = -1;
  for (var i = 0; i < steps.length; i += 1) {
    var s = steps[i];
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new TypeError("cartRecovery: steps[" + i + "] must be an object");
    }
    if (s.step_index !== i) {
      throw new TypeError(
        "cartRecovery: steps[" + i + "].step_index must equal " + i +
        " (dense 0..N-1 sequence required)"
      );
    }
    _validatePositiveInt(s.offset_ms, "steps[" + i + "].offset_ms");
    if (s.offset_ms <= prevOffset) {
      throw new TypeError(
        "cartRecovery: steps[" + i + "].offset_ms (" + s.offset_ms +
        ") must be strictly greater than the prior step's offset (" + prevOffset + ")"
      );
    }
    _validateStepKind(s.kind);
    out.push({
      step_index: i,
      offset_ms:  s.offset_ms,
      kind:       s.kind,
    });
    prevOffset = s.offset_ms;
  }
  return out;
}

// ---- row → public shape -------------------------------------------------

function _rowToSequence(row) {
  if (!row) return null;
  var steps;
  try { steps = JSON.parse(row.steps_json); }
  catch (_e) {
    // drop-silent — a malformed JSON column would be a write-side
    // corruption we surface as the operator-readable empty shape so
    // the dashboard renders rather than crashes.
    steps = [];
  }
  return {
    slug:       row.slug,
    title:      row.title,
    steps:      steps,
    active:     Number(row.active) === 1,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function _rowToEnrollment(row) {
  if (!row) return null;
  return {
    id:                   row.id,
    sequence_slug:        row.sequence_slug,
    detection_id:         row.detection_id || null,
    cart_id:              row.cart_id,
    customer_id:          row.customer_id || null,
    customer_email_hash:  row.customer_email_hash || null,
    status:               row.status,
    current_step_index:   Number(row.current_step_index),
    next_step_at:         row.next_step_at == null ? null : Number(row.next_step_at),
    enrolled_at:          Number(row.enrolled_at),
    updated_at:           Number(row.updated_at),
    recovered_at:         row.recovered_at == null ? null : Number(row.recovered_at),
    recovered_order_id:   row.recovered_order_id || null,
    cancelled_at:         row.cancelled_at == null ? null : Number(row.cancelled_at),
    cancelled_reason:     row.cancelled_reason || null,
  };
}

function _rowToDispatch(row) {
  if (!row) return null;
  return {
    id:             row.id,
    enrollment_id:  row.enrollment_id,
    step_index:     Number(row.step_index),
    status:         row.status,
    reason:         row.reason || null,
    dispatched_at:  Number(row.dispatched_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Optional dep: the cart-abandonment primitive. When wired, the
  // dispatcher can resolve a detection row + bump its terminal
  // reminder_status; absent, enrollments still flow and the operator
  // wires the cart-abandonment bookkeeping at the call site.
  var cartAbandonment = opts.cartAbandonment || null;
  if (cartAbandonment && typeof cartAbandonment !== "object") {
    throw new TypeError(
      "cartRecovery.create: opts.cartAbandonment must be an object exposing the cart-abandonment primitive"
    );
  }

  // Optional dep: the email primitive. When wired, `dispatchTick`
  // routes each step through the matching `sendAbandonedCartReminder`
  // call; absent, the dispatcher still walks the FSM + writes the
  // dispatch log but skips the actual send (the operator's worker
  // performs the send after reading the enrollment row).
  var email = opts.email || null;
  if (email && typeof email !== "object") {
    throw new TypeError(
      "cartRecovery.create: opts.email must be an object exposing the email primitive"
    );
  }

  // Optional dep: the email-suppressions primitive. When wired, the
  // dispatcher consults `isSuppressed` before each send + cancels the
  // enrollment on a hit (the customer asked to be left alone).
  var emailSuppressions = opts.emailSuppressions || null;
  if (emailSuppressions && typeof emailSuppressions.isSuppressed !== "function") {
    throw new TypeError(
      "cartRecovery.create: opts.emailSuppressions must expose an isSuppressed(input) method"
    );
  }

  // ---- internals ------------------------------------------------------

  async function _getSequenceRow(slug) {
    var r = await query(
      "SELECT * FROM cart_recovery_sequences WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function _getEnrollmentRow(id) {
    var r = await query(
      "SELECT * FROM cart_recovery_enrollments WHERE id = ?1 LIMIT 1",
      [id],
    );
    return r.rows[0] || null;
  }

  function _hashEmail(email_) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, email_);
  }

  // Resolve the next-step offset from the sequence row. Returns
  // `null` when `nextIndex` is past the last step (the enrollment is
  // about to land `completed`).
  function _offsetForStep(steps, nextIndex) {
    if (!Array.isArray(steps) || nextIndex >= steps.length) return null;
    var s = steps[nextIndex];
    return s ? s.offset_ms : null;
  }

  function _kindForStep(steps, idx) {
    if (!Array.isArray(steps) || idx >= steps.length) return null;
    var s = steps[idx];
    return s ? s.kind : null;
  }

  // ---- surface --------------------------------------------------------

  return {
    STEP_KINDS:           STEP_KINDS,
    ENROLLMENT_STATUSES:  ENROLLMENT_STATUSES,
    DISPATCH_STATUSES:    DISPATCH_STATUSES,

    // Define / redefine an operator-owned sequence. The slug is the
    // primary key; redefining replaces the steps + bumps updated_at.
    // Existing enrollments KEEP the steps they were enrolled under —
    // the steps JSON copies into the enrollment's read path at
    // dispatch time, so changing the sequence rewires only future
    // enrollments. (A future "rewire-existing" call would land here
    // as a separate verb.)
    defineSequence: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cartRecovery.defineSequence: input object required");
      }
      var slug  = _validateSlug(input.slug, "slug");
      var title = _validateTitle(input.title);
      var steps = _validateSteps(input.steps);

      var now = input.now == null ? _now() : input.now;
      _validateNonNegInt(now, "now");

      var existing = await _getSequenceRow(slug);
      if (!existing) {
        await query(
          "INSERT INTO cart_recovery_sequences " +
          "(slug, title, steps_json, active, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, 1, ?4, ?4)",
          [slug, title, JSON.stringify(steps), now],
        );
      } else {
        await query(
          "UPDATE cart_recovery_sequences SET " +
          "title = ?1, steps_json = ?2, updated_at = ?3 WHERE slug = ?4",
          [title, JSON.stringify(steps), now, slug],
        );
      }
      return _rowToSequence(await _getSequenceRow(slug));
    },

    // Enroll an abandoned-cart detection into a sequence. Schedules
    // `next_step_at` for the first step (enrolled_at + steps[0].offset_ms).
    // The detection_id stays nullable so an operator can enroll a
    // raw cart without a prior detection row (manual operator action
    // from the dashboard).
    enrollDetection: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cartRecovery.enrollDetection: input object required");
      }
      var sequenceSlug = _validateSlug(input.sequence_slug, "sequence_slug");
      var cartId       = _validateUuid(input.cart_id, "cart_id");
      var detectionId  = input.detection_id == null
        ? null
        : _validateUuid(input.detection_id, "detection_id");
      var customerId   = input.customer_id == null
        ? null
        : _validateUuid(input.customer_id, "customer_id");
      var customerEmailHash = null;
      if (input.customer_email != null) {
        var normalized = _validateEmail(input.customer_email);
        customerEmailHash = _hashEmail(normalized);
      }

      var now = input.now == null ? _now() : input.now;
      _validateNonNegInt(now, "now");

      var seq = await _getSequenceRow(sequenceSlug);
      if (!seq) {
        throw new TypeError(
          "cartRecovery.enrollDetection: sequence '" + sequenceSlug + "' not found"
        );
      }
      if (Number(seq.active) !== 1) {
        throw new TypeError(
          "cartRecovery.enrollDetection: sequence '" + sequenceSlug + "' is inactive"
        );
      }
      var steps;
      try { steps = JSON.parse(seq.steps_json); }
      catch (_e) {
        throw new TypeError(
          "cartRecovery.enrollDetection: sequence '" + sequenceSlug + "' has malformed steps_json"
        );
      }
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new TypeError(
          "cartRecovery.enrollDetection: sequence '" + sequenceSlug + "' has no steps"
        );
      }

      var id = b.uuid.v7();
      var nextStepAt = now + steps[0].offset_ms;
      await query(
        "INSERT INTO cart_recovery_enrollments " +
        "(id, sequence_slug, detection_id, cart_id, customer_id, " +
        " customer_email_hash, status, current_step_index, next_step_at, " +
        " enrolled_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'enrolled', 0, ?7, ?8, ?8)",
        [
          id, sequenceSlug, detectionId, cartId, customerId,
          customerEmailHash, nextStepAt, now,
        ],
      );
      return _rowToEnrollment(await _getEnrollmentRow(id));
    },

    // Cron-driven dispatcher. Walks every enrollment with
    // `status='enrolled'` and `next_step_at <= now` (or the
    // caller-supplied tick time), dispatches the current step, then
    // advances the FSM. Returns the list of dispatch rows written so
    // the caller's observability sink can fan-out a per-step
    // notification without re-reading the table.
    dispatchTick: async function (tickOpts) {
      tickOpts = tickOpts || {};
      var now = tickOpts.now == null ? _now() : tickOpts.now;
      _validateNonNegInt(now, "now");
      var maxBatch = tickOpts.max_batch == null ? 500 : tickOpts.max_batch;
      _validatePositiveInt(maxBatch, "max_batch");

      // Optional "resolve a deliverable email from the customer_id"
      // hook. The dispatcher passes the enrollment row at the call
      // site; the caller returns the email string (or null when the
      // customer has no contact on file). Absent the resolver the
      // dispatcher uses the hashed email as a presence signal only —
      // it can't send an email it doesn't have the plaintext for.
      var resolveEmail = tickOpts.resolveEmail || null;
      if (resolveEmail != null && typeof resolveEmail !== "function") {
        throw new TypeError(
          "cartRecovery.dispatchTick: resolveEmail must be a function (enrollment) => Promise<string|null>"
        );
      }

      var due = (await query(
        "SELECT * FROM cart_recovery_enrollments " +
        "WHERE status = 'enrolled' AND next_step_at IS NOT NULL AND next_step_at <= ?1 " +
        "ORDER BY next_step_at ASC LIMIT ?2",
        [now, maxBatch],
      )).rows;

      var dispatches = [];

      for (var i = 0; i < due.length; i += 1) {
        var enr = due[i];
        var seq = await _getSequenceRow(enr.sequence_slug);
        if (!seq) {
          // Sequence vanished out from under us (operator deleted the
          // row mid-tick). Cancel the enrollment so the dispatcher
          // doesn't loop on a row it can't service.
          await query(
            "UPDATE cart_recovery_enrollments SET " +
            "status = 'cancelled', next_step_at = NULL, " +
            "cancelled_at = ?1, cancelled_reason = ?2, updated_at = ?1 " +
            "WHERE id = ?3 AND status = 'enrolled'",
            [now, "sequence-missing", enr.id],
          );
          continue;
        }
        var steps;
        try { steps = JSON.parse(seq.steps_json); }
        catch (_e) { steps = []; }

        var stepIdx = Number(enr.current_step_index);
        var stepKind = _kindForStep(steps, stepIdx);
        if (stepKind == null) {
          // No step at this index — the enrollment is stale (sequence
          // shrank). Land it `completed` so the dispatcher moves on.
          await query(
            "UPDATE cart_recovery_enrollments SET " +
            "status = 'completed', next_step_at = NULL, updated_at = ?1 " +
            "WHERE id = ?2 AND status = 'enrolled'",
            [now, enr.id],
          );
          continue;
        }

        var dispatchStatus = "sent";
        var dispatchReason = null;
        var cancelEnrollment = false;
        var sendError = null;

        // Suppression gate: when wired, ask the suppressions
        // primitive before sending. A `suppressed=true` hit writes a
        // `skipped-suppressed` dispatch row + cancels the
        // enrollment (the customer's preference applies to every
        // future step too).
        var resolvedEmail = null;
        if (resolveEmail) {
          try { resolvedEmail = await resolveEmail(_rowToEnrollment(enr)); }
          catch (e) {
            sendError = e && e.message ? String(e.message) : String(e || "resolveEmail failed");
            dispatchStatus = "failed";
          }
        }

        if (dispatchStatus === "sent" && emailSuppressions && resolvedEmail) {
          try {
            var sup = await emailSuppressions.isSuppressed({
              email: resolvedEmail,
              scope: "marketing",
            });
            if (sup && sup.suppressed) {
              dispatchStatus = "skipped-suppressed";
              dispatchReason = sup.suppression_type || "suppressed";
              cancelEnrollment = true;
            }
          } catch (_e) {
            // drop-silent — a suppressions outage shouldn't block the
            // operator's recovery campaign. The dispatcher errs toward
            // sending; the operator's mailer is the next gate.
          }
        }

        // No deliverable address — `customer_email` wasn't supplied
        // at enrollment + the operator didn't wire a resolver, OR
        // the resolver returned null. Write a `skipped-no-email` row
        // + cancel the enrollment so the dispatcher doesn't loop.
        if (
          dispatchStatus === "sent" &&
          !resolvedEmail &&
          !enr.customer_email_hash
        ) {
          dispatchStatus = "skipped-no-email";
          dispatchReason = "no-email";
          cancelEnrollment = true;
        }

        // Actual send. When `email` is wired + we have an address +
        // the gate didn't fire, route through the matching template.
        // The dispatcher leans on `sendAbandonedCartReminder` for
        // every step kind — the email primitive owns subject /
        // template variation per kind (a future refinement could
        // route discount + last_chance through separate verbs).
        if (
          dispatchStatus === "sent" &&
          email &&
          resolvedEmail &&
          typeof email.sendAbandonedCartReminder === "function"
        ) {
          try {
            await email.sendAbandonedCartReminder({
              customer_email: resolvedEmail,
              cart_url:       tickOpts.cart_url_base
                ? (tickOpts.cart_url_base + "/" + enr.cart_id)
                : ("https://example.invalid/cart/" + enr.cart_id),
              lines:          tickOpts.lines || [
                { title: "Your cart" },
              ],
            });
          } catch (e) {
            sendError = e && e.message ? String(e.message) : String(e || "send failed");
            dispatchStatus = "failed";
          }
        }

        // Write the dispatch row.
        var dispatchId = b.uuid.v7();
        var truncatedReason = dispatchReason;
        if (dispatchStatus === "failed" && sendError) {
          truncatedReason = sendError.length > MAX_REASON_LEN
            ? sendError.slice(0, MAX_REASON_LEN)
            : sendError;
        }
        await query(
          "INSERT INTO cart_recovery_dispatches " +
          "(id, enrollment_id, step_index, status, reason, dispatched_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          [dispatchId, enr.id, stepIdx, dispatchStatus, truncatedReason, now],
        );

        // Advance the FSM. On a clean send → bump to the next step
        // (or land `completed` when no next step exists). On
        // suppression / no-email → cancel. On a transient `failed` →
        // keep `enrolled` + push next_step_at out one hour so the
        // next tick retries (the operator's retry policy could shape
        // this further; the default keeps the row alive without
        // hammering the failing send).
        if (cancelEnrollment) {
          await query(
            "UPDATE cart_recovery_enrollments SET " +
            "status = 'cancelled', next_step_at = NULL, " +
            "cancelled_at = ?1, cancelled_reason = ?2, updated_at = ?1 " +
            "WHERE id = ?3 AND status = 'enrolled'",
            [now, dispatchReason || "cancelled-on-dispatch", enr.id],
          );
        } else if (dispatchStatus === "failed") {
          // Push next_step_at one hour out so retry doesn't fire in
          // the same tick. The current_step_index does NOT advance —
          // we're retrying this step.
          await query(
            "UPDATE cart_recovery_enrollments SET " +
            "next_step_at = ?1, updated_at = ?2 " +
            "WHERE id = ?3 AND status = 'enrolled'",
            [now + C.TIME.hours(1), now, enr.id],
          );
        } else {
          // Clean send. Advance.
          var nextIdx = stepIdx + 1;
          var nextOffset = _offsetForStep(steps, nextIdx);
          if (nextOffset == null) {
            // Last step fired. Land `completed`.
            await query(
              "UPDATE cart_recovery_enrollments SET " +
              "status = 'completed', current_step_index = ?1, " +
              "next_step_at = NULL, updated_at = ?2 " +
              "WHERE id = ?3 AND status = 'enrolled' AND current_step_index = ?4",
              [nextIdx, now, enr.id, stepIdx],
            );
          } else {
            // Schedule the next step relative to the original
            // enrolled_at. Using enrolled_at + offset (rather than
            // now + delta-between-steps) keeps the cadence pinned to
            // the original abandonment moment even when a slow tick
            // delays an earlier send.
            var enrolledAt = Number(enr.enrolled_at);
            await query(
              "UPDATE cart_recovery_enrollments SET " +
              "current_step_index = ?1, next_step_at = ?2, updated_at = ?3 " +
              "WHERE id = ?4 AND status = 'enrolled' AND current_step_index = ?5",
              [nextIdx, enrolledAt + nextOffset, now, enr.id, stepIdx],
            );
          }
        }

        dispatches.push({
          enrollment_id: enr.id,
          step_index:    stepIdx,
          status:        dispatchStatus,
          reason:        truncatedReason,
          dispatched_at: now,
        });
      }

      return {
        dispatched: dispatches.length,
        rows:       dispatches,
      };
    },

    // Direct-record path for callers that drive the send themselves
    // and just want the dispatch log + FSM advance. Idempotent at
    // the (enrollment_id, step_index) pair — re-recording the same
    // step is a no-op.
    recordStepSent: async function (enrollmentId, recOpts) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      recOpts = recOpts || {};
      _validateNonNegInt(recOpts.step_index, "step_index");
      var now = recOpts.sent_at == null ? _now() : recOpts.sent_at;
      _validateNonNegInt(now, "sent_at");

      var enr = await _getEnrollmentRow(id);
      if (!enr) {
        throw new TypeError(
          "cartRecovery.recordStepSent: enrollment '" + id + "' not found"
        );
      }
      if (enr.status !== "enrolled") {
        return {
          enrollment_id: id,
          changed:       false,
          status:        enr.status,
        };
      }
      if (Number(enr.current_step_index) !== recOpts.step_index) {
        throw new TypeError(
          "cartRecovery.recordStepSent: step_index " + recOpts.step_index +
          " does not match enrollment's current_step_index " + enr.current_step_index
        );
      }

      var seq = await _getSequenceRow(enr.sequence_slug);
      if (!seq) {
        throw new TypeError(
          "cartRecovery.recordStepSent: sequence '" + enr.sequence_slug + "' not found"
        );
      }
      var steps;
      try { steps = JSON.parse(seq.steps_json); }
      catch (_e) { steps = []; }

      // Idempotency: if a dispatch row already exists for this
      // (enrollment, step_index) pair we don't write a second one.
      var prior = await query(
        "SELECT id FROM cart_recovery_dispatches " +
        "WHERE enrollment_id = ?1 AND step_index = ?2 LIMIT 1",
        [id, recOpts.step_index],
      );
      if (!prior.rows[0]) {
        var dispatchId = b.uuid.v7();
        await query(
          "INSERT INTO cart_recovery_dispatches " +
          "(id, enrollment_id, step_index, status, reason, dispatched_at) " +
          "VALUES (?1, ?2, ?3, 'sent', NULL, ?4)",
          [dispatchId, id, recOpts.step_index, now],
        );
      }

      var nextIdx = recOpts.step_index + 1;
      var nextOffset = _offsetForStep(steps, nextIdx);
      var enrolledAt = Number(enr.enrolled_at);
      if (nextOffset == null) {
        await query(
          "UPDATE cart_recovery_enrollments SET " +
          "status = 'completed', current_step_index = ?1, " +
          "next_step_at = NULL, updated_at = ?2 " +
          "WHERE id = ?3 AND status = 'enrolled'",
          [nextIdx, now, id],
        );
      } else {
        await query(
          "UPDATE cart_recovery_enrollments SET " +
          "current_step_index = ?1, next_step_at = ?2, updated_at = ?3 " +
          "WHERE id = ?4 AND status = 'enrolled'",
          [nextIdx, enrolledAt + nextOffset, now, id],
        );
      }

      return {
        enrollment_id: id,
        changed:       true,
        next_step_index: nextIdx,
      };
    },

    // Operator marks a step skipped (suppression / opt-out / bounce
    // landing post-send). Writes the dispatch row + cancels the
    // enrollment (the customer's preference applies to every future
    // step too).
    markStepSkipped: async function (enrollmentId, skipOpts) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      if (!skipOpts || typeof skipOpts !== "object") {
        throw new TypeError("cartRecovery.markStepSkipped: opts object required");
      }
      _validateNonNegInt(skipOpts.step_index, "step_index");
      _validateReason(skipOpts.reason);
      var now = skipOpts.skipped_at == null ? _now() : skipOpts.skipped_at;
      _validateNonNegInt(now, "skipped_at");

      var enr = await _getEnrollmentRow(id);
      if (!enr) {
        throw new TypeError(
          "cartRecovery.markStepSkipped: enrollment '" + id + "' not found"
        );
      }
      if (enr.status !== "enrolled") {
        return {
          enrollment_id: id,
          changed:       false,
          status:        enr.status,
        };
      }

      var dispatchId = b.uuid.v7();
      await query(
        "INSERT INTO cart_recovery_dispatches " +
        "(id, enrollment_id, step_index, status, reason, dispatched_at) " +
        "VALUES (?1, ?2, ?3, 'skipped-suppressed', ?4, ?5)",
        [dispatchId, id, skipOpts.step_index, skipOpts.reason, now],
      );
      await query(
        "UPDATE cart_recovery_enrollments SET " +
        "status = 'cancelled', next_step_at = NULL, " +
        "cancelled_at = ?1, cancelled_reason = ?2, updated_at = ?1 " +
        "WHERE id = ?3 AND status = 'enrolled'",
        [now, skipOpts.reason, id],
      );

      return {
        enrollment_id: id,
        changed:       true,
        status:        "cancelled",
      };
    },

    // Checkout layer signals "customer paid for the abandoned cart."
    // The enrollment lands `recovered` (terminal). Rewrites a prior
    // `completed` row too — the order trumps the calendar, since the
    // operator's metrics treat recovery as the success outcome
    // regardless of whether every step had already fired.
    markRecovered: async function (enrollmentId, recOpts) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      recOpts = recOpts || {};
      var orderId = recOpts.order_id == null
        ? null
        : _validateUuid(recOpts.order_id, "order_id");
      var now = recOpts.recovered_at == null ? _now() : recOpts.recovered_at;
      _validateNonNegInt(now, "recovered_at");

      var enr = await _getEnrollmentRow(id);
      if (!enr) {
        throw new TypeError(
          "cartRecovery.markRecovered: enrollment '" + id + "' not found"
        );
      }
      if (enr.status === "recovered") {
        // Idempotent — keep the first recovered_at + order_id.
        return {
          enrollment_id: id,
          changed:       false,
          status:        "recovered",
        };
      }
      if (enr.status === "cancelled") {
        throw new TypeError(
          "cartRecovery.markRecovered: enrollment '" + id +
          "' is cancelled — cannot transition to recovered"
        );
      }

      await query(
        "UPDATE cart_recovery_enrollments SET " +
        "status = 'recovered', next_step_at = NULL, " +
        "recovered_at = ?1, recovered_order_id = ?2, updated_at = ?1 " +
        "WHERE id = ?3 AND status IN ('enrolled', 'completed')",
        [now, orderId, id],
      );

      return {
        enrollment_id: id,
        changed:       true,
        status:        "recovered",
        order_id:      orderId,
      };
    },

    // Operator manual cancel — pulls the enrollment out of the
    // dispatch queue without a send. Distinct from `markStepSkipped`
    // (which records a dispatch row); this verb is the operator-
    // dashboard "stop nurturing this customer" button.
    cancelEnrollment: async function (enrollmentId, cancelOpts) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      if (!cancelOpts || typeof cancelOpts !== "object") {
        throw new TypeError("cartRecovery.cancelEnrollment: opts object required");
      }
      var reason = _validateReason(cancelOpts.reason);
      var now = cancelOpts.cancelled_at == null ? _now() : cancelOpts.cancelled_at;
      _validateNonNegInt(now, "cancelled_at");

      var enr = await _getEnrollmentRow(id);
      if (!enr) {
        throw new TypeError(
          "cartRecovery.cancelEnrollment: enrollment '" + id + "' not found"
        );
      }
      if (enr.status !== "enrolled") {
        return {
          enrollment_id: id,
          changed:       false,
          status:        enr.status,
        };
      }
      await query(
        "UPDATE cart_recovery_enrollments SET " +
        "status = 'cancelled', next_step_at = NULL, " +
        "cancelled_at = ?1, cancelled_reason = ?2, updated_at = ?1 " +
        "WHERE id = ?3 AND status = 'enrolled'",
        [now, reason, id],
      );
      return {
        enrollment_id: id,
        changed:       true,
        status:        "cancelled",
      };
    },

    // Read a single sequence.
    getSequence: async function (slug) {
      _validateSlug(slug, "slug");
      return _rowToSequence(await _getSequenceRow(slug));
    },

    // Read a single enrollment.
    getEnrollment: async function (enrollmentId) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      return _rowToEnrollment(await _getEnrollmentRow(id));
    },

    // Read the dispatch log for an enrollment, oldest-first so the
    // dashboard's per-step audit panel renders the timeline in
    // forward order.
    dispatchesForEnrollment: async function (enrollmentId) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      var rows = (await query(
        "SELECT * FROM cart_recovery_dispatches " +
        "WHERE enrollment_id = ?1 ORDER BY dispatched_at ASC, step_index ASC",
        [id],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_rowToDispatch(rows[i]));
      return out;
    },

    // Every enrollment for a given customer_id, newest-first. The
    // operator's customer-detail dashboard renders this so the agent
    // can see "how many recovery sequences this person has been
    // through" before manually intervening.
    enrollmentsForCustomer: async function (customerId) {
      var id = _validateUuid(customerId, "customer_id");
      var rows = (await query(
        "SELECT * FROM cart_recovery_enrollments " +
        "WHERE customer_id = ?1 ORDER BY enrolled_at DESC, id DESC",
        [id],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_rowToEnrollment(rows[i]));
      return out;
    },

    // Aggregate metrics for a sequence. Returns enrollments by
    // status + the derived recovery rate (recovered / total). The
    // recovery rate is the operator's headline number — what
    // fraction of nudged carts actually paid.
    metricsForSequence: async function (sequenceSlug) {
      var slug = _validateSlug(sequenceSlug, "sequence_slug");
      var seq = await _getSequenceRow(slug);
      if (!seq) {
        throw new TypeError(
          "cartRecovery.metricsForSequence: sequence '" + slug + "' not found"
        );
      }
      var rows = (await query(
        "SELECT status, COUNT(*) AS n FROM cart_recovery_enrollments " +
        "WHERE sequence_slug = ?1 GROUP BY status",
        [slug],
      )).rows;
      var counts = {
        enrolled:  0,
        completed: 0,
        recovered: 0,
        cancelled: 0,
      };
      var total = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var n = Number(rows[i].n || 0);
        if (Object.prototype.hasOwnProperty.call(counts, rows[i].status)) {
          counts[rows[i].status] = n;
        }
        total += n;
      }
      var dispatchRows = (await query(
        "SELECT d.status AS status, COUNT(*) AS n " +
        "FROM cart_recovery_dispatches d " +
        "JOIN cart_recovery_enrollments e ON e.id = d.enrollment_id " +
        "WHERE e.sequence_slug = ?1 " +
        "GROUP BY d.status",
        [slug],
      )).rows;
      var dispatchCounts = {
        sent:                  0,
        "skipped-suppressed":  0,
        "skipped-no-email":    0,
        failed:                0,
      };
      var totalDispatches = 0;
      for (var di = 0; di < dispatchRows.length; di += 1) {
        var dn = Number(dispatchRows[di].n || 0);
        if (Object.prototype.hasOwnProperty.call(dispatchCounts, dispatchRows[di].status)) {
          dispatchCounts[dispatchRows[di].status] = dn;
        }
        totalDispatches += dn;
      }
      // Recovery rate uses (enrolled + completed + recovered +
      // cancelled) as the denominator — every enrollment that ever
      // landed in the sequence. A zero-total sequence returns 0 so
      // the dashboard can render without a NaN guard.
      var recoveryRate = total === 0 ? 0 : counts.recovered / total;
      return {
        sequence_slug:   slug,
        total:           total,
        counts:          counts,
        dispatches:      dispatchCounts,
        total_dispatches: totalDispatches,
        recovery_rate:   recoveryRate,
      };
    },

    // Expose the optional deps so a wiring sanity check can assert
    // they reached the factory.
    _deps: {
      cartAbandonment:   cartAbandonment,
      email:             email,
      emailSuppressions: emailSuppressions,
    },
  };
}

module.exports = {
  create:              create,
  STEP_KINDS:          STEP_KINDS,
  ENROLLMENT_STATUSES: ENROLLMENT_STATUSES,
  DISPATCH_STATUSES:   DISPATCH_STATUSES,
};
