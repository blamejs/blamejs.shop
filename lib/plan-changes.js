"use strict";
/**
 * @module shop.planChanges
 * @title  Subscription plan changes — proration-aware upgrade / downgrade
 *
 * @intro
 *   Customer is on plan A, switches to plan B. The transition needs
 *   to answer three questions every operator dashboard / customer
 *   portal asks:
 *
 *     1. How much credit does the customer get for the unused
 *        portion of the current billing period on plan A?
 *     2. What's the first prorated charge on plan B for the partial
 *        period between the change clock and the next billing date?
 *     3. When does the change land — immediately (the customer
 *        upgraded and wants the new tier now) or at the next
 *        billing cycle (the customer downgraded and the operator
 *        defers the change to keep the current period whole)?
 *
 *   `proposeChange` answers all three without persisting state.
 *   `executeChange` writes the transition + queues the proration
 *   adjustments via `subscriptionBilling` when injected. The
 *   scheduler-callable `applyScheduledChanges` walks every row whose
 *   `effective_at <= now AND status = 'pending'` and flips them to
 *   executed.
 *
 *   Composition:
 *     var pc = bShop.planChanges.create({
 *       query:               q,
 *       subscriptions:       subs.subscriptions,
 *       subscriptionBilling: bill,                    // optional
 *     });
 *     var plan = await pc.proposeChange({
 *       subscription_id, new_plan_id, change_at,
 *     });
 *     await pc.executeChange({ subscription_id, new_plan_id, change_kind });
 *     await pc.cancelPendingChange({ subscription_id, reason });
 *     await pc.pendingChangeFor(subscription_id);
 *     await pc.historyForSubscription(subscription_id);
 *     await pc.applyScheduledChanges({ now: Date.now() });
 *
 *   Proration math (minor units, integer-only):
 *
 *     periodMs        = current_period_end - current_period_start
 *     usedMs          = effective_at      - current_period_start
 *     remainingMs     = current_period_end - effective_at
 *
 *     proration_credit_minor = floor(from_plan.amount_minor * remainingMs / periodMs)
 *     first_charge_minor     = floor(to_plan.amount_minor   * remainingMs / periodMs)
 *
 *   `next_billing_cycle` proration is zero on both sides — the
 *   outgoing plan rides out the period in full, the incoming plan
 *   starts clean at the next cycle.
 *
 *   Currency mismatch between from/to plan throws — cross-currency
 *   migrations require an FX layer the caller composes outside this
 *   primitive (the same posture `subscriptionBilling.arpu` takes for
 *   cross-currency aggregation).
 *
 * @related b.guardUuid, b.uuid.v7
 */

var b = require("./index").framework;

// ---- constants ----------------------------------------------------------

var CHANGE_KINDS  = ["immediate", "next_billing_cycle"];
var STATUSES      = ["proposed", "pending", "executed", "cancelled"];
var MAX_REASON_LEN = 280;

// Reuse the same control-byte / zero-width refusal posture as the
// sibling subscription-billing primitive — operator-authored prose
// can land in cancel_reason and replay into the customer profile
// screen, so the same "no direction-override / no invisible glyph"
// floor applies.
var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE   = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("planChanges: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("planChanges: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _epochMsOrNull(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _changeKind(s) {
  if (typeof s !== "string" || CHANGE_KINDS.indexOf(s) === -1) {
    throw new TypeError("planChanges: change_kind must be one of " + CHANGE_KINDS.join(", "));
  }
  return s;
}

function _optReason(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("planChanges: reason must be a non-empty string when provided");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("planChanges: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("planChanges: reason contains control / zero-width bytes");
  }
  return s;
}

function _now() { return Date.now(); }

// ---- proration math -----------------------------------------------------

// Pure function, exported under the factory + as a module-level
// surface for tests / external callers that want to reason about the
// math without instantiating the factory. Returns integer minor
// units. Inputs that produce a non-positive period collapse to
// (credit=0, charge=fromAmount=0 / toAmount on the new plan); the
// caller's validation upstream (proposeChange) refuses those shapes
// before they reach here, but the function stays defensive so a
// future direct caller can't divide-by-zero through it.
function _prorate(fromAmount, toAmount, periodStart, periodEnd, effectiveAt) {
  var periodMs = periodEnd - periodStart;
  if (periodMs <= 0) {
    return { proration_credit_minor: 0, first_charge_minor: 0 };
  }
  var clampedEffective = effectiveAt;
  if (clampedEffective < periodStart) clampedEffective = periodStart;
  if (clampedEffective > periodEnd)   clampedEffective = periodEnd;
  var remainingMs = periodEnd - clampedEffective;
  // Integer math throughout — minor units are integers, and the
  // (amount * remaining / period) shape multiplies before dividing
  // so a small remaining window doesn't truncate prematurely.
  var credit = Math.floor((fromAmount * remainingMs) / periodMs);
  var charge = Math.floor((toAmount   * remainingMs) / periodMs);
  return { proration_credit_minor: credit, first_charge_minor: charge };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var subscriptionsHandle = opts.subscriptions;
  if (!subscriptionsHandle || typeof subscriptionsHandle.get !== "function") {
    throw new TypeError("planChanges.create: opts.subscriptions handle required");
  }
  // `subscriptionBilling` is optional. When wired, `executeChange`
  // queues the proration adjustments through it
  // (`recordInvoice({ amount_minor: first_charge_minor - proration_credit_minor })`)
  // so the operator dashboard's invoice ledger reflects the
  // transition. When absent, the row still persists; the operator
  // wires the billing handle later or queues the adjustments via
  // a parallel surface.
  var billingHandle = opts.subscriptionBilling || null;

  async function _getSubscription(subscriptionId) {
    // Prefer the injected handle (production composition); fall back
    // to a direct read so tests that pass a minimal handle
    // ({ get: ... }) still see consistent rows.
    var row = await subscriptionsHandle.get(subscriptionId);
    if (row) return row;
    var r = await query("SELECT * FROM subscriptions WHERE id = ?1", [subscriptionId]);
    return r.rows[0] || null;
  }

  async function _getPlan(planId) {
    var r = await query("SELECT * FROM subscription_plans WHERE id = ?1", [planId]);
    return r.rows[0] || null;
  }

  async function _pendingFor(subscriptionId) {
    var r = await query(
      "SELECT * FROM subscription_plan_changes " +
      "WHERE subscription_id = ?1 AND status IN ('proposed', 'pending') " +
      "ORDER BY created_at DESC, id DESC LIMIT 1",
      [subscriptionId],
    );
    return r.rows[0] || null;
  }

  async function _getById(id) {
    var r = await query("SELECT * FROM subscription_plan_changes WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  return {
    CHANGE_KINDS:    CHANGE_KINDS.slice(),
    STATUSES:        STATUSES.slice(),
    MAX_REASON_LEN:  MAX_REASON_LEN,

    // Exposed for tests + callers that want the pure math without
    // round-tripping the factory.
    prorate: _prorate,

    proposeChange: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("planChanges.proposeChange: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var newPlanId      = _uuid(input.new_plan_id,     "new_plan_id");
      var changeAt       = _epochMsOrNull(input.change_at, "change_at");

      var sub = await _getSubscription(subscriptionId);
      if (!sub) {
        var nf = new Error("planChanges.proposeChange: subscription " + subscriptionId + " not found");
        nf.code = "SUBSCRIPTION_NOT_FOUND";
        throw nf;
      }
      if (sub.plan_id === newPlanId) {
        throw new TypeError("planChanges.proposeChange: new_plan_id is the same as the current plan");
      }
      var fromPlan = await _getPlan(sub.plan_id);
      var toPlan   = await _getPlan(newPlanId);
      if (!fromPlan) {
        var nfFrom = new Error("planChanges.proposeChange: from-plan " + sub.plan_id + " not found");
        nfFrom.code = "PLAN_NOT_FOUND";
        throw nfFrom;
      }
      if (!toPlan) {
        var nfTo = new Error("planChanges.proposeChange: to-plan " + newPlanId + " not found");
        nfTo.code = "PLAN_NOT_FOUND";
        throw nfTo;
      }
      if (!toPlan.active) {
        throw new TypeError("planChanges.proposeChange: to-plan " + newPlanId + " is archived");
      }
      if (fromPlan.currency !== toPlan.currency) {
        throw new TypeError(
          "planChanges.proposeChange: cross-currency change refused (" +
          fromPlan.currency + " → " + toPlan.currency + ")"
        );
      }
      if (sub.current_period_start == null || sub.current_period_end == null) {
        throw new TypeError("planChanges.proposeChange: subscription has no current billing period");
      }

      var effectiveAt = changeAt == null ? _now() : changeAt;
      // Decide kind. The caller can override by passing
      // change_at >= current_period_end (next-cycle) or omitting it
      // (immediate at Date.now()). The kind is derived, not passed —
      // the operator's intent reads off the clock they pick.
      var kind;
      if (effectiveAt >= sub.current_period_end) {
        kind        = "next_billing_cycle";
        effectiveAt = sub.current_period_end;
      } else {
        kind = "immediate";
      }

      var pror;
      if (kind === "immediate") {
        pror = _prorate(
          fromPlan.amount_minor,
          toPlan.amount_minor,
          sub.current_period_start,
          sub.current_period_end,
          effectiveAt,
        );
      } else {
        // next_billing_cycle — outgoing plan rides out the period in
        // full, incoming plan starts clean at the next cycle. No
        // proration applies on either side.
        pror = { proration_credit_minor: 0, first_charge_minor: 0 };
      }

      return {
        proration_credit_minor: pror.proration_credit_minor,
        first_charge_minor:     pror.first_charge_minor,
        currency:               fromPlan.currency,
        effective_at:           effectiveAt,
        change_kind:            kind,
        from_plan_id:           sub.plan_id,
        to_plan_id:             newPlanId,
      };
    },

    executeChange: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("planChanges.executeChange: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var newPlanId      = _uuid(input.new_plan_id,     "new_plan_id");
      // change_kind is optional on the input — when omitted, the
      // primitive recomputes via proposeChange so the caller can pass
      // (subscription_id, new_plan_id) alone and the row's kind
      // derives off the clock. When passed, it's validated against
      // the enum but the math is still recomputed against the live
      // subscription period.
      if (input.change_kind != null) _changeKind(input.change_kind);

      // Refuse if a pending change already exists — the operator
      // must cancel it first. Otherwise concurrent proposeChange
      // calls would race a single subscription into a multi-pending
      // state the scheduler couldn't disambiguate.
      var existingPending = await _pendingFor(subscriptionId);
      if (existingPending) {
        var pErr = new Error(
          "planChanges.executeChange: refused — subscription has a " +
          existingPending.status + " change " + existingPending.id
        );
        pErr.code = "PLAN_CHANGE_REFUSED";
        throw pErr;
      }

      var proposed = await this.proposeChange({
        subscription_id: subscriptionId,
        new_plan_id:     newPlanId,
        change_at:       input.change_at,
      });

      var sub = await _getSubscription(subscriptionId);
      var id  = b.uuid.v7();
      var ts  = _now();
      // Status: `executed` when the effective clock is now-or-past,
      // `pending` when the change is queued for a future clock
      // (typically next_billing_cycle but also any future
      // change_at). The scheduler's applyScheduledChanges walk flips
      // pending → executed when the clock catches up.
      var status      = proposed.effective_at <= ts ? "executed" : "pending";
      var executedAt  = status === "executed" ? ts : null;

      await query(
        "INSERT INTO subscription_plan_changes " +
        "(id, subscription_id, from_plan_id, to_plan_id, change_kind, status, " +
        " proration_credit_minor, first_charge_minor, currency, effective_at, " +
        " executed_at, cancelled_at, cancel_reason, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, ?12)",
        [
          id, subscriptionId, sub.plan_id, newPlanId, proposed.change_kind, status,
          proposed.proration_credit_minor, proposed.first_charge_minor, proposed.currency,
          proposed.effective_at, executedAt, ts,
        ],
      );

      if (status === "executed") {
        await query(
          "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3",
          [newPlanId, ts, subscriptionId],
        );
        if (billingHandle && typeof billingHandle.recordInvoice === "function") {
          // Queue the proration adjustment as a single invoice row.
          // The amount is the net (first_charge - credit); negative
          // nets clamp to zero (the credit covers the partial-period
          // charge in full — the unused remainder becomes a future-
          // period credit the operator surfaces through a separate
          // ledger entry outside this primitive's surface).
          var net = proposed.first_charge_minor - proposed.proration_credit_minor;
          if (net < 0) net = 0;
          try {
            // The `subscription_plans` table stores currency
            // lowercase (`'usd'`); `subscriptionBilling.recordInvoice`
            // expects uppercase ISO 4217. Normalize at the boundary
            // so callers don't have to know the casing dialect each
            // primitive picked.
            await billingHandle.recordInvoice({
              subscription_id: subscriptionId,
              period_start:    proposed.effective_at,
              period_end:      sub.current_period_end,
              amount_minor:    net,
              currency:        proposed.currency.toUpperCase(),
            });
          } catch (_e) {
            // Drop-silent — by design. The billing handle is an
            // optional composition; a recordInvoice failure must not
            // crash executeChange (the plan transition itself
            // landed). The caller observes the invoice gap through
            // the billing handle's own ledger query.
          }
        }
      }

      return await _getById(id);
    },

    cancelPendingChange: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("planChanges.cancelPendingChange: input object required");
      }
      var subscriptionId = _uuid(input.subscription_id, "subscription_id");
      var reason         = _optReason(input.reason);

      var pending = await _pendingFor(subscriptionId);
      if (!pending) {
        var nf = new Error("planChanges.cancelPendingChange: no pending change for " + subscriptionId);
        nf.code = "NO_PENDING_CHANGE";
        throw nf;
      }
      // Defensive: `_pendingFor` already filters to proposed/pending,
      // so this branch is unreachable through the public surface;
      // it stays as a belt-and-braces refusal in case a caller
      // bypasses _pendingFor via a future direct surface.
      if (pending.status === "executed" || pending.status === "cancelled") {
        var sErr = new Error(
          "planChanges.cancelPendingChange: refused — change " +
          pending.id + " is " + pending.status + " (terminal)"
        );
        sErr.code = "PLAN_CHANGE_STATE_REFUSED";
        throw sErr;
      }
      var ts = _now();
      await query(
        "UPDATE subscription_plan_changes SET status = 'cancelled', cancelled_at = ?1, cancel_reason = ?2 " +
        "WHERE id = ?3",
        [ts, reason, pending.id],
      );
      return await _getById(pending.id);
    },

    pendingChangeFor: async function (subscriptionId) {
      subscriptionId = _uuid(subscriptionId, "subscription_id");
      return await _pendingFor(subscriptionId);
    },

    historyForSubscription: async function (subscriptionId) {
      subscriptionId = _uuid(subscriptionId, "subscription_id");
      var r = await query(
        "SELECT * FROM subscription_plan_changes WHERE subscription_id = ?1 " +
        "ORDER BY created_at DESC, id DESC",
        [subscriptionId],
      );
      return r.rows;
    },

    // Scheduler-callable. Walks every row with `status = 'pending'`
    // and `effective_at <= now`, flips them to executed, and updates
    // the parent subscription row's plan_id. Queues the proration
    // adjustment through `subscriptionBilling` when injected
    // (drop-silent on recordInvoice failure, mirroring
    // `executeChange`).
    //
    // Returns the list of executed change rows for the caller's
    // logging / metrics. A cron wires this to a minute-cadence walk.
    applyScheduledChanges: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("planChanges.applyScheduledChanges: input object required");
      }
      var now = _epochMs(input.now, "now");
      var due = await query(
        "SELECT * FROM subscription_plan_changes " +
        "WHERE status = 'pending' AND effective_at <= ?1 " +
        "ORDER BY effective_at ASC, id ASC",
        [now],
      );
      var executed = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var row = due.rows[i];
        await query(
          "UPDATE subscription_plan_changes SET status = 'executed', executed_at = ?1 WHERE id = ?2",
          [now, row.id],
        );
        await query(
          "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3",
          [row.to_plan_id, now, row.subscription_id],
        );
        if (billingHandle && typeof billingHandle.recordInvoice === "function") {
          var net = row.first_charge_minor - row.proration_credit_minor;
          if (net < 0) net = 0;
          var subRow = await _getSubscription(row.subscription_id);
          var periodEnd = subRow && subRow.current_period_end != null
            ? subRow.current_period_end : row.effective_at;
          try {
            // Same casing-normalization the synchronous executeChange
            // path runs — plans store currency lowercase, billing
            // expects uppercase.
            await billingHandle.recordInvoice({
              subscription_id: row.subscription_id,
              period_start:    row.effective_at,
              period_end:      periodEnd,
              amount_minor:    net,
              currency:        String(row.currency).toUpperCase(),
            });
          } catch (_e) {
            // Drop-silent — see executeChange.
          }
        }
        executed.push(await _getById(row.id));
      }
      return executed;
    },
  };
}

module.exports = {
  create:         create,
  CHANGE_KINDS:   CHANGE_KINDS.slice(),
  STATUSES:       STATUSES.slice(),
  MAX_REASON_LEN: MAX_REASON_LEN,
  prorate:        _prorate,
};
