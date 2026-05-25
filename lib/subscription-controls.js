"use strict";
/**
 * @module shop.subscriptionControls
 * @title  Subscription controls — operator + customer lifecycle surface
 *
 * @intro
 *   Layered on top of the `subscriptions` primitive. The `subscriptions`
 *   row mirrors Stripe's billing state; this primitive owns the
 *   storefront-side lifecycle the customer-service operator interacts
 *   with — pause, resume, skip-next, change-quantity, change-frequency,
 *   cancel, reactivate — and an append-only audit ledger
 *   (`subscription_control_events`) that records every transition for
 *   replay on the operator console.
 *
 *   Composition:
 *     var ctl = bShop.subscriptionControls.create({
 *       query:         q,
 *       subscriptions: subs.subscriptions,
 *     });
 *     await ctl.pause({ subscription_id, until, reason, actor });
 *     await ctl.resume({ subscription_id, reason, actor });
 *     await ctl.skipNext({ subscription_id, count: 1, reason, actor });
 *     await ctl.changeQuantity({ subscription_id, new_quantity: 2, reason, actor });
 *     await ctl.changeFrequency({ subscription_id, new_frequency: "quarterly", reason, actor });
 *     await ctl.cancel({ subscription_id, reason, immediate: false, actor });
 *     await ctl.reactivate({ subscription_id, reason, actor });
 *     await ctl.historyForSubscription(subscription_id);
 *     await ctl.actorReport({ actor_type: "operator", from, to });
 *     await ctl.scanAutoResume(Date.now());
 *
 *   Logical state derivation:
 *     cancelled — `cancelled_at` IS NOT NULL.
 *     paused    — `cancelled_at` IS NULL AND `paused_at` IS NOT NULL.
 *     active    — otherwise.
 *
 *   The existing `subscriptions.status` column keeps mirroring Stripe;
 *   the controls primitive never writes it. A subscription that's
 *   "active" in Stripe and "paused" here means the operator paused
 *   the customer-side cadence (skip the next ship) without canceling
 *   the underlying Stripe subscription — the typical flow for
 *   reversible churn-prevention pauses.
 *
 *   `scanAutoResume(now)` is the scheduler-callable surface — a cron
 *   wires it to a minute-cadence walk. Every paused row whose
 *   `paused_until <= now` flips back to active and writes a
 *   `system`-actor `resume` event. Rows with `paused_until` in the
 *   future (or NULL — indefinite pause) are left alone.
 *
 *   Composition only — no npm runtime deps; the primitive composes
 *   `b.guardUuid`, `b.uuid.v7`, and the host's `subscriptions` handle.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}
var C = _b().constants;

// ---- constants ----------------------------------------------------------

var EVENTS = [
  "pause",
  "resume",
  "skip",
  "quantity_change",
  "frequency_change",
  "cancel",
  "reactivate",
];

var ACTOR_TYPES = ["customer", "operator", "system"];

var FREQUENCIES = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
];

// Period length in milliseconds, computed off a 30-day-month
// approximation. `skipNext` and `changeFrequency` use these for the
// next_billing_at recomputation. The customer-side cadence is the
// shop's local view; Stripe's authoritative invoice cadence remains
// driven by the upstream plan's `interval` + `interval_count`. The
// approximation drifts versus calendar months across long horizons
// (28/30/31-day months), which is acceptable for the typical 1-3
// step skipNext / changeFrequency surface; a calendar-accurate
// scheduler is out of scope for v1.
var PERIOD_MS = Object.freeze({
  weekly:      C.TIME.days(7),
  biweekly:    C.TIME.days(14),
  monthly:     C.TIME.days(30),
  quarterly:   C.TIME.days(90),
  semiannual:  C.TIME.days(182),
  annual:      C.TIME.days(365),
});

// Plan-interval → frequency fallback. When the row has no `frequency`
// override, derive the cadence from the bound plan (`interval` +
// `interval_count`). Anything outside the mapped cells falls back to
// "monthly" so skipNext / changeFrequency arithmetic stays defined —
// the operator can always override with an explicit `changeFrequency`
// call.
function _frequencyFromPlan(plan) {
  if (!plan || !plan.interval) return "monthly";
  var ic = plan.interval_count || 1;
  if (plan.interval === "week"  && ic === 1) return "weekly";
  if (plan.interval === "week"  && ic === 2) return "biweekly";
  if (plan.interval === "month" && ic === 1) return "monthly";
  if (plan.interval === "month" && ic === 3) return "quarterly";
  if (plan.interval === "month" && ic === 6) return "semiannual";
  if (plan.interval === "year"  && ic === 1) return "annual";
  return "monthly";
}

var REACTIVATE_GRACE_MS  = C.TIME.days(90);
var MAX_REASON_LEN       = 280;
var MAX_SKIP_COUNT       = 12;
var MAX_QUANTITY         = 1000000;

// Control-byte + zero-width refusal — same approach the order-notes /
// returns / cart-abandonment primitives use for operator-authored
// prose. Refuses C0 / DEL and the LRM/RLM/ZWJ/ZWNJ family so a
// malicious reason can't smuggle direction-override / invisible
// content into the operator dashboard.
var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE   = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("subscriptionControls: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("subscriptionControls: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("subscriptionControls: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("subscriptionControls: reason contains control / zero-width bytes");
  }
  return s;
}

function _actor(actor) {
  if (!actor || typeof actor !== "object") {
    throw new TypeError("subscriptionControls: actor object required");
  }
  if (typeof actor.actor_type !== "string" || ACTOR_TYPES.indexOf(actor.actor_type) === -1) {
    throw new TypeError("subscriptionControls: actor.actor_type must be one of " + ACTOR_TYPES.join(", "));
  }
  var actorId = null;
  if (actor.actor_id != null) {
    actorId = _uuid(actor.actor_id, "actor.actor_id");
  }
  return { actor_type: actor.actor_type, actor_id: actorId };
}

function _frequency(s) {
  if (typeof s !== "string" || FREQUENCIES.indexOf(s) === -1) {
    throw new TypeError("subscriptionControls: frequency must be one of " + FREQUENCIES.join(", "));
  }
  return s;
}

function _quantity(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("subscriptionControls: new_quantity must be a positive integer");
  }
  if (n > MAX_QUANTITY) {
    throw new TypeError("subscriptionControls: new_quantity must be <= " + MAX_QUANTITY);
  }
  return n;
}

function _skipCount(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SKIP_COUNT) {
    throw new TypeError("subscriptionControls: count must be an integer in [1, " + MAX_SKIP_COUNT + "]");
  }
  return n;
}

function _untilTs(ts) {
  if (ts == null) return null;
  if (!Number.isInteger(ts) || ts <= 0) {
    throw new TypeError("subscriptionControls: until must be a positive integer (epoch ms) or null");
  }
  return ts;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("subscriptionControls: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- state helpers ------------------------------------------------------

function _logicalState(row) {
  if (!row) return null;
  if (row.cancelled_at != null) return "cancelled";
  if (row.paused_at != null)    return "paused";
  return "active";
}

function _snapshot(row) {
  // The before/after JSON in the audit ledger captures only the
  // mutable control-surface columns — the Stripe-mirrored fields
  // (`status`, period_*) aren't owned by this primitive and would
  // pollute the diff. Operators reading the ledger want to see
  // exactly what changed on this row through control surface
  // mutations.
  return {
    state:           _logicalState(row),
    paused_at:       row.paused_at == null       ? null : row.paused_at,
    paused_until:    row.paused_until == null    ? null : row.paused_until,
    cancelled_at:    row.cancelled_at == null    ? null : row.cancelled_at,
    quantity:        row.quantity == null        ? null : row.quantity,
    frequency:       row.frequency == null       ? null : row.frequency,
    next_billing_at: row.next_billing_at == null ? null : row.next_billing_at,
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  var subscriptionsHandle = opts.subscriptions;
  if (!subscriptionsHandle || typeof subscriptionsHandle.get !== "function") {
    throw new TypeError("subscriptionControls.create: opts.subscriptions handle required");
  }

  // Fetch the raw subscription row + bound plan in one round-trip,
  // returning `null` if either is absent. The plan lookup feeds the
  // frequency fallback for skipNext / changeFrequency arithmetic.
  async function _getRowWithPlan(subscriptionId) {
    var r = await query(
      "SELECT s.*, p.interval AS plan_interval, p.interval_count AS plan_interval_count " +
      "FROM subscriptions s LEFT JOIN subscription_plans p ON p.id = s.plan_id " +
      "WHERE s.id = ?1",
      [subscriptionId],
    );
    if (!r.rows.length) return null;
    var row = r.rows[0];
    return {
      row: row,
      plan: row.plan_interval ? { interval: row.plan_interval, interval_count: row.plan_interval_count } : null,
    };
  }

  function _effectiveFrequency(row, plan) {
    return row.frequency || _frequencyFromPlan(plan);
  }

  // Compute the next_billing_at off a base timestamp + frequency +
  // step count. Used by skipNext (base = current next_billing_at) and
  // changeFrequency (base = current next_billing_at or now).
  function _advanceBilling(baseMs, frequency, steps) {
    var ms = PERIOD_MS[frequency];
    return baseMs + ms * steps;
  }

  // Per-factory monotonic clock — guarantees `occurred_at` is strictly
  // increasing across events emitted by the same primitive instance,
  // even when the wall clock has 1ms resolution and the test loop
  // emits multiple events inside a single tick. Without this, the
  // ledger's (occurred_at DESC, id DESC) ordering relies on v7 UUIDs
  // being sortable within a millisecond — which they aren't (the
  // tail bytes are random). Forward-leap if Date.now() outpaces the
  // counter; otherwise bump by 1ms.
  var _lastEventTs = 0;
  function _monotonicTs() {
    var wall = _now();
    if (wall > _lastEventTs) _lastEventTs = wall;
    else                     _lastEventTs += 1;
    return _lastEventTs;
  }

  async function _writeEvent(subscriptionId, event, before, after, actor, reason) {
    var id = _b().uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO subscription_control_events " +
      "(id, subscription_id, event, actor_type, actor_id, before_json, after_json, reason, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      [
        id, subscriptionId, event, actor.actor_type, actor.actor_id,
        JSON.stringify(before), JSON.stringify(after), reason, ts,
      ],
    );
    return { id: id, occurred_at: ts };
  }

  async function _refetchRow(subscriptionId) {
    var r = await query("SELECT * FROM subscriptions WHERE id = ?1", [subscriptionId]);
    return r.rows[0] || null;
  }

  return {
    EVENTS:             EVENTS.slice(),
    ACTOR_TYPES:        ACTOR_TYPES.slice(),
    FREQUENCIES:        FREQUENCIES.slice(),
    MAX_REASON_LEN:     MAX_REASON_LEN,
    MAX_SKIP_COUNT:     MAX_SKIP_COUNT,
    MAX_QUANTITY:       MAX_QUANTITY,
    REACTIVATE_GRACE_MS: REACTIVATE_GRACE_MS,

    pause: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.pause: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var reason         = _reason(input.reason);
      var until          = _untilTs(input.until);
      var actor          = _actor(input.actor);

      var ctx = await _getRowWithPlan(subscriptionId);
      if (!ctx) {
        var notFound = new Error("subscriptionControls.pause: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var row = ctx.row;
      var state = _logicalState(row);
      if (state === "cancelled") {
        var cErr = new Error("subscriptionControls.pause: refused — subscription is cancelled (use reactivate)");
        cErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw cErr;
      }
      if (state === "paused") {
        var pErr = new Error("subscriptionControls.pause: refused — subscription is already paused");
        pErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw pErr;
      }

      var before = _snapshot(row);
      var ts = _now();
      await query(
        "UPDATE subscriptions SET paused_at = ?1, paused_until = ?2, updated_at = ?3 WHERE id = ?4",
        [ts, until, ts, subscriptionId],
      );
      var after = _snapshot(await _refetchRow(subscriptionId));
      await _writeEvent(subscriptionId, "pause", before, after, actor, reason);
      return after;
    },

    resume: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.resume: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var reason         = _reason(input.reason);
      var actor          = _actor(input.actor);

      var ctx = await _getRowWithPlan(subscriptionId);
      if (!ctx) {
        var notFound = new Error("subscriptionControls.resume: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var row = ctx.row;
      var state = _logicalState(row);
      if (state === "cancelled") {
        var cErr = new Error("subscriptionControls.resume: refused — subscription is cancelled (use reactivate)");
        cErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw cErr;
      }
      if (state === "active") {
        var aErr = new Error("subscriptionControls.resume: refused — subscription is already active");
        aErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw aErr;
      }

      var before = _snapshot(row);
      var ts = _now();
      await query(
        "UPDATE subscriptions SET paused_at = NULL, paused_until = NULL, updated_at = ?1 WHERE id = ?2",
        [ts, subscriptionId],
      );
      var after = _snapshot(await _refetchRow(subscriptionId));
      await _writeEvent(subscriptionId, "resume", before, after, actor, reason);
      return after;
    },

    skipNext: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.skipNext: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var count          = _skipCount(input.count);
      var reason         = _reason(input.reason);
      var actor          = _actor(input.actor);

      var ctx = await _getRowWithPlan(subscriptionId);
      if (!ctx) {
        var notFound = new Error("subscriptionControls.skipNext: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var row = ctx.row;
      if (_logicalState(row) === "cancelled") {
        var cErr = new Error("subscriptionControls.skipNext: refused — subscription is cancelled");
        cErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw cErr;
      }

      var freq = _effectiveFrequency(row, ctx.plan);
      // Base for the bump: the current next_billing_at if set,
      // otherwise the row's current_period_end (Stripe-mirrored),
      // otherwise now. The fallback chain keeps the arithmetic
      // defined for fresh subscriptions whose next_billing_at hasn't
      // been computed yet.
      var base;
      if (row.next_billing_at != null)         base = row.next_billing_at;
      else if (row.current_period_end != null) base = row.current_period_end;
      else                                     base = _now();
      var nextBilling = _advanceBilling(base, freq, count);

      var before = _snapshot(row);
      var ts = _now();
      await query(
        "UPDATE subscriptions SET next_billing_at = ?1, updated_at = ?2 WHERE id = ?3",
        [nextBilling, ts, subscriptionId],
      );
      var after = _snapshot(await _refetchRow(subscriptionId));
      await _writeEvent(subscriptionId, "skip", before, after, actor, reason);
      return { next_billing_at: nextBilling, snapshot: after };
    },

    changeQuantity: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.changeQuantity: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var newQuantity    = _quantity(input.new_quantity);
      var reason         = _reason(input.reason);
      var actor          = _actor(input.actor);

      var ctx = await _getRowWithPlan(subscriptionId);
      if (!ctx) {
        var notFound = new Error("subscriptionControls.changeQuantity: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var row = ctx.row;
      if (_logicalState(row) === "cancelled") {
        var cErr = new Error("subscriptionControls.changeQuantity: refused — subscription is cancelled");
        cErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw cErr;
      }

      var before = _snapshot(row);
      var ts = _now();
      await query(
        "UPDATE subscriptions SET quantity = ?1, updated_at = ?2 WHERE id = ?3",
        [newQuantity, ts, subscriptionId],
      );
      var after = _snapshot(await _refetchRow(subscriptionId));
      await _writeEvent(subscriptionId, "quantity_change", before, after, actor, reason);
      return after;
    },

    changeFrequency: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.changeFrequency: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var newFrequency   = _frequency(input.new_frequency);
      var reason         = _reason(input.reason);
      var actor          = _actor(input.actor);

      var ctx = await _getRowWithPlan(subscriptionId);
      if (!ctx) {
        var notFound = new Error("subscriptionControls.changeFrequency: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var row = ctx.row;
      if (_logicalState(row) === "cancelled") {
        var cErr = new Error("subscriptionControls.changeFrequency: refused — subscription is cancelled");
        cErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw cErr;
      }

      // next_billing_at is recomputed off the row's current cycle
      // anchor — `current_period_start` (Stripe-mirrored) if present,
      // otherwise the current next_billing_at, otherwise now. One
      // period of the NEW frequency is added; the customer's next
      // ship moves to the matching cadence offset.
      var anchor;
      if (row.current_period_start != null) anchor = row.current_period_start;
      else if (row.next_billing_at != null) anchor = row.next_billing_at;
      else                                  anchor = _now();
      var nextBilling = _advanceBilling(anchor, newFrequency, 1);

      var before = _snapshot(row);
      var ts = _now();
      await query(
        "UPDATE subscriptions SET frequency = ?1, next_billing_at = ?2, updated_at = ?3 WHERE id = ?4",
        [newFrequency, nextBilling, ts, subscriptionId],
      );
      var after = _snapshot(await _refetchRow(subscriptionId));
      await _writeEvent(subscriptionId, "frequency_change", before, after, actor, reason);
      return after;
    },

    cancel: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.cancel: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var reason         = _reason(input.reason);
      var actor          = _actor(input.actor);
      var immediate      = input.immediate === true;

      var ctx = await _getRowWithPlan(subscriptionId);
      if (!ctx) {
        var notFound = new Error("subscriptionControls.cancel: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var row = ctx.row;
      var state = _logicalState(row);
      if (state === "cancelled") {
        var cErr = new Error("subscriptionControls.cancel: refused — subscription is already cancelled");
        cErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw cErr;
      }

      // `immediate: false` (default) — operator commits to continue
      // serving the customer through the paid period. The cancelled_at
      // stamp lands at current_period_end (when their access ends);
      // until then, downstream readers see the row as "scheduled for
      // cancellation" via cancel_at_period_end + cancelled_at in the
      // future.
      //
      // `immediate: true` — cancelled_at is stamped at `now`. The
      // customer loses access immediately.
      var stampAt;
      if (immediate) {
        stampAt = _now();
      } else if (row.current_period_end != null) {
        stampAt = row.current_period_end;
      } else {
        // No period end mirrored yet (subscription pre-confirm,
        // unusual but possible) — fall back to immediate so the row
        // doesn't end up with a NULL cancelled_at after a cancel
        // call.
        stampAt = _now();
      }

      var before = _snapshot(row);
      var ts = _now();
      await query(
        "UPDATE subscriptions SET cancelled_at = ?1, paused_at = NULL, paused_until = NULL, updated_at = ?2 WHERE id = ?3",
        [stampAt, ts, subscriptionId],
      );
      var after = _snapshot(await _refetchRow(subscriptionId));
      await _writeEvent(subscriptionId, "cancel", before, after, actor, reason);
      return after;
    },

    reactivate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.reactivate: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var reason         = _reason(input.reason);
      var actor          = _actor(input.actor);

      var ctx = await _getRowWithPlan(subscriptionId);
      if (!ctx) {
        var notFound = new Error("subscriptionControls.reactivate: subscription " + subscriptionId + " not found");
        notFound.code = "SUBSCRIPTION_NOT_FOUND";
        throw notFound;
      }
      var row = ctx.row;
      if (_logicalState(row) !== "cancelled") {
        var sErr = new Error("subscriptionControls.reactivate: refused — subscription is not cancelled");
        sErr.code = "SUBSCRIPTION_STATE_REFUSED";
        throw sErr;
      }
      var now = _now();
      if (now - row.cancelled_at > REACTIVATE_GRACE_MS) {
        var gErr = new Error(
          "subscriptionControls.reactivate: refused — cancellation is older than the " +
          (REACTIVATE_GRACE_MS / C.TIME.days(1)) + "-day grace window"
        );
        gErr.code = "SUBSCRIPTION_REACTIVATE_GRACE_EXPIRED";
        throw gErr;
      }

      var before = _snapshot(row);
      await query(
        "UPDATE subscriptions SET cancelled_at = NULL, updated_at = ?1 WHERE id = ?2",
        [now, subscriptionId],
      );
      var after = _snapshot(await _refetchRow(subscriptionId));
      await _writeEvent(subscriptionId, "reactivate", before, after, actor, reason);
      return after;
    },

    historyForSubscription: async function (subscriptionId) {
      subscriptionId = _uuid(subscriptionId, "subscription_id");
      var r = await query(
        "SELECT * FROM subscription_control_events WHERE subscription_id = ?1 " +
        "ORDER BY occurred_at DESC, id DESC",
        [subscriptionId],
      );
      return r.rows.map(function (row) {
        var hydrated = Object.assign({}, row);
        try { hydrated.before = JSON.parse(row.before_json); } catch (_e) { hydrated.before = null; }
        try { hydrated.after  = JSON.parse(row.after_json);  } catch (_e) { hydrated.after  = null; }
        return hydrated;
      });
    },

    // Operator audit — every event from `actor_type` in the
    // [from, to] window. Use case: "what did this support agent
    // touch last shift" / "show me every pause this month."
    actorReport: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("subscriptionControls.actorReport: input object required");
      }
      if (typeof input.actor_type !== "string" || ACTOR_TYPES.indexOf(input.actor_type) === -1) {
        throw new TypeError("subscriptionControls.actorReport: actor_type must be one of " + ACTOR_TYPES.join(", "));
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from > to) {
        throw new TypeError("subscriptionControls.actorReport: from must be <= to");
      }
      var r = await query(
        "SELECT * FROM subscription_control_events " +
        "WHERE actor_type = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
        "ORDER BY occurred_at DESC, id DESC",
        [input.actor_type, from, to],
      );
      return r.rows.map(function (row) {
        var hydrated = Object.assign({}, row);
        try { hydrated.before = JSON.parse(row.before_json); } catch (_e) { hydrated.before = null; }
        try { hydrated.after  = JSON.parse(row.after_json);  } catch (_e) { hydrated.after  = null; }
        return hydrated;
      });
    },

    // Scheduler entry point — walks every paused row whose
    // `paused_until` has matured (<= now) and resumes it with a
    // `system` actor + a `auto-resume` reason. Rows with
    // `paused_until IS NULL` (indefinite pause) and rows whose
    // pause hasn't matured yet are left alone. Returns the list of
    // resumed subscription ids so the cron operator can log the
    // batch.
    scanAutoResume: async function (now) {
      now = _epochMs(now, "now");
      var matured = (await query(
        "SELECT id FROM subscriptions " +
        "WHERE cancelled_at IS NULL AND paused_at IS NOT NULL " +
        "AND paused_until IS NOT NULL AND paused_until <= ?1 " +
        "ORDER BY paused_until ASC",
        [now],
      )).rows;
      var resumed = [];
      for (var i = 0; i < matured.length; i += 1) {
        var subId = matured[i].id;
        // Re-read the row inside the loop to capture the current
        // snapshot — another writer could have raced us (unlikely,
        // but the audit ledger should reflect the actual before
        // state).
        var ctx = await _getRowWithPlan(subId);
        if (!ctx) continue;
        var row = ctx.row;
        // Defense: re-check the state — concurrent cancel or resume
        // would have invalidated the matured set since the SELECT.
        if (_logicalState(row) !== "paused") continue;
        var before = _snapshot(row);
        var ts = _now();
        await query(
          "UPDATE subscriptions SET paused_at = NULL, paused_until = NULL, updated_at = ?1 WHERE id = ?2",
          [ts, subId],
        );
        var after = _snapshot(await _refetchRow(subId));
        await _writeEvent(
          subId,
          "resume",
          before,
          after,
          { actor_type: "system", actor_id: null },
          "auto-resume: paused_until matured",
        );
        resumed.push(subId);
      }
      return { resumed: resumed, count: resumed.length };
    },
  };
}

module.exports = {
  create:              create,
  EVENTS:              EVENTS.slice(),
  ACTOR_TYPES:         ACTOR_TYPES.slice(),
  FREQUENCIES:         FREQUENCIES.slice(),
  MAX_REASON_LEN:      MAX_REASON_LEN,
  MAX_SKIP_COUNT:      MAX_SKIP_COUNT,
  MAX_QUANTITY:        MAX_QUANTITY,
  REACTIVATE_GRACE_MS: REACTIVATE_GRACE_MS,
  PERIOD_MS:           PERIOD_MS,
};
