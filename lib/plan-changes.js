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

var b = require("./vendor/blamejs");

// Observability sink for batch-path settlement failures: the scheduler
// reverts a due row to 'pending' and carries on when a Stripe push or a
// credit write throws, but the CAUSE is logged here rather than discarded
// so an operator can see why scheduled plan changes aren't landing.
var _log = b.log.create({});

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
function _max0(n) { return n < 0 ? 0 : n; }

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

  // `storeCredit` is the vehicle for the credit a mid-cycle DOWNGRADE
  // leaves the customer holding: when the outgoing plan's unused
  // remainder exceeds the incoming plan's partial-period charge, the
  // difference is money the customer is owed. The proration invoice can
  // only carry a charge (it clamps a negative net to zero), so without a
  // credit vehicle that remainder would be silently dropped. When a
  // downgrade owes a credit, it is issued to this handle's hash-chained
  // ledger; if the handle is absent the change is refused (executeChange
  // throws) or left pending (applyScheduledChanges) rather than applied
  // with the credit lost.
  //
  // NOTE: the store-credit / invoice path is the model for NON-Stripe
  // subscriptions only. A Stripe-backed subscription (below) lets Stripe
  // own the proration — Stripe invoices the difference (upgrade) or
  // carries the balance forward as a credit (downgrade), so this primitive
  // must NOT also issue a local credit / invoice for those rows, or the
  // customer would be settled twice.
  var storeCreditHandle = opts.storeCredit || null;

  // Optional payment handle (the shared Stripe adapter). When wired, a
  // plan change on a Stripe-backed subscription swaps the subscription
  // item's price at Stripe BEFORE the local plan_id is touched, so the
  // plan the shop shows and the plan Stripe actually bills never diverge.
  // Without it (a deploy with no payment processor, or a non-Stripe row),
  // the change stays local-only and the store-credit / invoice proration
  // model applies. The handle must expose `subscriptions.retrieve(id)` +
  // `subscriptions.update(id, body, idempotencyKey)` — the same shape
  // subscriptionControls composes.
  var payment = opts.payment || null;
  var hasStripe = !!(payment && payment.subscriptions &&
    typeof payment.subscriptions.update === "function" &&
    typeof payment.subscriptions.retrieve === "function");

  // A subscription is Stripe-backed when the processor adapter is wired
  // AND the row carries the upstream subscription id the webhook + billing
  // mirror key on. Rows without one are shop-local (e.g. a manually seeded
  // subscription on a deploy that never reached Stripe) and the local
  // store-credit / invoice proration model applies to them.
  function _isStripeBacked(sub) {
    return hasStripe && sub && typeof sub.stripe_subscription_id === "string" && sub.stripe_subscription_id.length > 0;
  }

  // Swap the subscription item's price at Stripe for a Stripe-backed
  // subscription. Stripe models the price on the subscription ITEM, not
  // the subscription, so we retrieve the live subscription to find its
  // (single) item id, then update that item's price. Every subscription
  // this shop creates binds exactly one price (`items: [{ price }]`), so
  // the first item is authoritative; if a subscription somehow carries no
  // item we surface a structured error rather than silently writing a
  // local-only change that diverges from Stripe.
  //
  // `prorationBehavior` selects who owns the money: "always_invoice"
  // (immediate change) has Stripe invoice the proration delta now;
  // "none" (next-cycle change) applies the new price cleanly from the
  // next invoice with no mid-cycle adjustment. The idempotency key folds
  // in the plan-change id so a retried call is a safe no-op at Stripe.
  async function _pushPlanToStripe(stripeSubscriptionId, newStripePriceId, prorationBehavior, planChangeId) {
    var live;
    try {
      live = await payment.subscriptions.retrieve(stripeSubscriptionId);
    } catch (e) {
      var rErr = new Error(
        "planChanges: could not reach Stripe to swap the subscription plan — " + (e && e.message || e),
      );
      rErr.code = "PLAN_CHANGE_STRIPE_PUSH_FAILED";
      rErr.cause = e;
      throw rErr;
    }
    var items = live && live.items && Array.isArray(live.items.data) ? live.items.data : [];
    if (!items.length || !items[0] || !items[0].id) {
      var noItem = new Error(
        "planChanges: Stripe subscription " + stripeSubscriptionId + " has no billable item to reprice",
      );
      noItem.code = "PLAN_CHANGE_STRIPE_NO_ITEM";
      throw noItem;
    }
    var idemKey = "planchange:" + planChangeId;
    try {
      return await payment.subscriptions.update(
        stripeSubscriptionId,
        { items: [{ id: items[0].id, price: newStripePriceId }], proration_behavior: prorationBehavior },
        idemKey,
      );
    } catch (e2) {
      // The processor rejected or failed the plan swap. Wrap it in a stable
      // code so the route can surface a "nothing changed, retry" notice; the
      // local row is still untouched (this runs before the local write).
      var uErr = new Error(
        "planChanges: Stripe rejected the plan swap — " + (e2 && e2.message || e2),
      );
      uErr.code = "PLAN_CHANGE_STRIPE_PUSH_FAILED";
      uErr.cause = e2;
      throw uErr;
    }
  }

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

  // A downgrade taking effect now owes the customer a credit the invoice
  // ledger cannot carry. Refuse if there is no vehicle to pay it.
  function _assertCreditable(creditMinor) {
    if (creditMinor > 0 && !storeCreditHandle) {
      throw new TypeError(
        "planChanges: a mid-cycle downgrade owes a " + creditMinor +
        "-minor store credit, but no storeCredit handle was provided to " +
        "planChanges.create — wire one or schedule the change to next_billing_cycle"
      );
    }
  }

  // Issue the credit a won downgrade owes to the customer's store-credit
  // ledger. The won-transition claim makes this exactly-once; the caller
  // pairs it with a revert-on-throw so a transient write failure cannot
  // finalize a downgrade whose credit was never paid (the credit is the
  // customer's money — it must be retryable, not lost). _assertCreditable
  // (executeChange) / the pre-claim skip (applyScheduledChanges) guarantee
  // storeCreditHandle is present whenever creditMinor > 0.
  async function _issueDowngradeCredit(o) {
    await storeCreditHandle.credit({
      customer_id:  o.customerId,
      amount_minor: o.creditMinor,
      source:       "refund",
      // Correlates the credit row to the plan-change that produced it.
      source_ref:   "subscription-downgrade:" + o.planChangeId,
    });
  }

  // Record the proration charge through the invoice ledger. Drop-silent —
  // recordInvoice is an optional dashboard record, so a failure must not
  // crash the transition that landed; the caller observes the gap through
  // the billing ledger query. (The owed CREDIT, by contrast, is never
  // dropped — see _issueDowngradeCredit + the callers' revert-on-throw.)
  async function _recordProrationInvoice(o) {
    if (!billingHandle || typeof billingHandle.recordInvoice !== "function") return;
    try {
      // Plans store currency lowercase ('usd'); recordInvoice expects
      // uppercase ISO 4217. Normalize at the boundary.
      await billingHandle.recordInvoice({
        subscription_id: o.subscriptionId,
        period_start:    o.periodStart,
        period_end:      o.periodEnd,
        amount_minor:    o.chargeMinor,
        currency:        String(o.currency).toUpperCase(),
        // Deterministic idempotency key — the change applies once, so a
        // re-run dedupes against the UNIQUE processor_invoice_id rather
        // than writing a second proration invoice.
        processor_invoice_id: "planchange:" + o.planChangeId,
      });
    } catch (_e) {
      // Drop-silent — by design.
    }
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
      // Split the proration into the charge (billed via the invoice
      // ledger) and the credit (owed to the customer). Exactly one is
      // non-zero: an upgrade charges the difference, a downgrade leaves
      // the customer in credit for the outgoing plan's unused remainder.
      // For a Stripe-backed subscription these are informational only —
      // Stripe owns the money — but they're still recorded on the row for
      // history / display.
      var chargeMinor = _max0(proposed.first_charge_minor - proposed.proration_credit_minor);
      var creditMinor = _max0(proposed.proration_credit_minor - proposed.first_charge_minor);
      // Status: `executed` when the effective clock is now-or-past,
      // `pending` when the change is queued for a future clock
      // (typically next_billing_cycle but also any future
      // change_at). The scheduler's applyScheduledChanges walk flips
      // pending → executed when the clock catches up.
      var status      = proposed.effective_at <= ts ? "executed" : "pending";
      var executedAt  = status === "executed" ? ts : null;

      var stripeBacked = _isStripeBacked(sub);

      // Stripe owns the proration for a Stripe-backed subscription: it
      // invoices the upgrade delta now (always_invoice) or carries a
      // downgrade balance forward. So the local store-credit / invoice
      // settlement MUST NOT also run for these rows — that would settle the
      // customer twice. Conversely, a non-Stripe row's only settlement
      // vehicle is the local store-credit ledger, so the credit-vehicle
      // gate still applies there.
      if (status === "executed" && stripeBacked) {
        // Confirm the target plan carries a Stripe price to swap to. A plan
        // with no `stripe_price_id` can't be expressed at Stripe; refuse
        // before any local row is written rather than diverge the local plan
        // from what Stripe bills.
        var toPlanImmediate = await _getPlan(newPlanId);
        if (!toPlanImmediate || !toPlanImmediate.stripe_price_id) {
          var mErr = new Error(
            "planChanges.executeChange: target plan " + newPlanId +
            " has no stripe_price_id — cannot reprice a Stripe-backed subscription"
          );
          mErr.code = "PLAN_CHANGE_STRIPE_PRICE_MISSING";
          throw mErr;
        }
      } else if (status === "executed") {
        // Fail closed: a downgrade taking effect now owes the customer a
        // credit, and the store-credit ledger is the only vehicle for it.
        // Refuse before any row is written rather than apply the transition
        // and silently drop the credit. (A future-dated downgrade is left
        // pending; applyScheduledChanges re-checks at execution time.)
        _assertCreditable(creditMinor);
      }

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

      // A pending (future / next-cycle) change is NOT applied here, whether
      // Stripe-backed or not — applyScheduledChanges pushes it to Stripe (or
      // settles the local credit/invoice) once its clock matures.
      if (status !== "executed") return await _getById(id);

      if (stripeBacked) {
        // Claim the plan transition FIRST — a conditional update gated on the
        // current plan id — so two concurrent immediate changes serialize and
        // ONLY the winner pushes to Stripe. Pushing before the claim (as this
        // did) let two concurrent calls each cut an always_invoice proration
        // invoice, double-charging the card, and left the loser's row
        // 'executed'. (toPlanImmediate is resolved above and is guaranteed to
        // carry a stripe_price_id.)
        var stripeClaim = await query(
          "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3 AND plan_id = ?4",
          [newPlanId, ts, subscriptionId, sub.plan_id],
        );
        if (Number((stripeClaim && stripeClaim.rowCount) || 0) !== 1) {
          // Lost the transition — a concurrent change already moved the plan.
          // No Stripe push and no charge here; void this row rather than leave
          // a phantom 'executed' change carrying charge/credit columns for a
          // transition that did not happen (mirrors the non-Stripe path and
          // applyScheduledChanges).
          await query(
            "UPDATE subscription_plan_changes SET status = 'cancelled', cancelled_at = ?1, " +
            "cancel_reason = ?2 WHERE id = ?3",
            [_now(), "transition-lost", id],
          );
          return await _getById(id);
        }
        // Won the claim — reprice at Stripe with an idempotency key derived
        // from the TRANSITION identity (subscription + from/to price + current
        // period), NOT this row's per-call id, so a retry of the same
        // transition dedupes at Stripe instead of cutting a second proration.
        // _pushPlanToStripe prefixes "planchange:"; supply the transition
        // identity (subscription + from/to price + current period) as the rest.
        var stripeKey = sub.stripe_subscription_id + ":" + sub.plan_id +
                        ":" + toPlanImmediate.stripe_price_id + ":" + String(sub.current_period_end);
        try {
          await _pushPlanToStripe(sub.stripe_subscription_id, toPlanImmediate.stripe_price_id, "always_invoice", stripeKey);
        } catch (e) {
          // The Stripe swap failed AFTER we won the claim. Roll the plan_id
          // back (guarded on the just-applied id so a concurrent change is not
          // clobbered) and void this row so the shop never shows a repricing
          // Stripe did not bill, then rethrow so the route surfaces a clean retry.
          await query(
            "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3 AND plan_id = ?4",
            [sub.plan_id, _now(), subscriptionId, newPlanId],
          );
          await query(
            "UPDATE subscription_plan_changes SET status = 'cancelled', cancelled_at = ?1, " +
            "cancel_reason = ?2 WHERE id = ?3",
            [_now(), "stripe-push-failed", id],
          );
          throw e;
        }
        return await _getById(id);
      }

      // NON-STRIPE — today's local settlement path, unchanged.
      // Atomic transition claim. The plan update is conditional on the
      // CURRENT plan id, so two concurrent executeChange calls for the same
      // immediate change can't both apply it — only the call that observes
      // the pre-change plan id transitions the row (rowCount 1); a racing
      // second call sees rowCount 0. The _pendingFor guard above only blocks
      // PENDING changes, so without this an immediate change executed twice
      // (a double-submit or retry) would record the proration invoice twice
      // and double-charge. The proration below is gated on winning the claim.
      var planUpd = await query(
        "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3 AND plan_id = ?4",
        [newPlanId, ts, subscriptionId, sub.plan_id],
      );
      var wonTransition = Number((planUpd && planUpd.rowCount) || 0) > 0;
      if (wonTransition) {
        if (creditMinor > 0) {
          try {
            await _issueDowngradeCredit({
              customerId:   sub.customer_id,
              creditMinor:  creditMinor,
              planChangeId: id,
            });
          } catch (e) {
            // Revert-on-throw: the credit is the customer's money, so a
            // transient write failure must not finalize a downgrade it
            // was never paid for. Roll the subscription back to the
            // outgoing plan (guarded on the just-applied plan id so a
            // concurrent change isn't clobbered) and void this change,
            // then rethrow so the caller retries from a clean state.
            await query(
              "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3 AND plan_id = ?4",
              [sub.plan_id, _now(), subscriptionId, newPlanId],
            );
            await query(
              "UPDATE subscription_plan_changes SET status = 'cancelled', cancelled_at = ?1, " +
              "cancel_reason = ?2 WHERE id = ?3",
              [_now(), "credit-settlement-failed", id],
            );
            throw e;
          }
        }
        await _recordProrationInvoice({
          subscriptionId: subscriptionId,
          chargeMinor:    chargeMinor,
          currency:       proposed.currency,
          periodStart:    proposed.effective_at,
          periodEnd:      sub.current_period_end,
          planChangeId:   id,
        });
      } else {
        // Lost the transition claim — a concurrent executeChange (double-submit
        // or retry) already flipped this subscription's plan. This row was
        // inserted 'executed' before the claim, but no plan moved, no credit
        // was issued, and no invoice was recorded under it. Void it rather than
        // leave a phantom 'executed' history row that carries money columns yet
        // reflects nothing — a naive revenue rollup
        // (SUM(first_charge_minor) WHERE status='executed') would double-count
        // it. Mirrors the stripe-push-failed / credit-settlement-failed voids.
        await query(
          "UPDATE subscription_plan_changes SET status = 'cancelled', cancelled_at = ?1, " +
          "cancel_reason = ?2 WHERE id = ?3",
          [_now(), "transition-lost", id],
        );
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
        var chargeMinor = _max0(row.first_charge_minor - row.proration_credit_minor);
        var creditMinor = _max0(row.proration_credit_minor - row.first_charge_minor);

        // Read the subscription up front to decide the settlement model.
        // A Stripe-backed row lets Stripe own the proration (the new price
        // applies cleanly from the next invoice — next-cycle semantics), so
        // the local store-credit / invoice path is skipped for it entirely,
        // INCLUDING the credit-vehicle skip guard below (that guard only
        // gates the local store-credit path; Stripe carries a downgrade
        // balance forward without one).
        var dueSub = await _getSubscription(row.subscription_id);
        var rowStripeBacked = _isStripeBacked(dueSub);

        if (!rowStripeBacked) {
          // Fail closed: a due downgrade owes the customer a credit. If no
          // store-credit vehicle is wired, leave the row PENDING (skip
          // before claiming) so it applies on a later sweep once the handle
          // exists — never transition it and drop the credit.
          if (creditMinor > 0 && !storeCreditHandle) continue;
        }

        // Atomic claim: flip pending -> executed gated on the status.
        // Two overlapping scheduler runs (cron overrun, retry, two
        // workers) both SELECT the same due row; WITHOUT this guard both
        // would update the subscription plan AND record a proration
        // invoice / push to Stripe — settling the customer twice for one
        // change. Only the caller whose UPDATE matches one row proceeds;
        // the loser skips. (The synchronous executeChange path is already
        // protected by its plan_id claim; this is the batch path's
        // equivalent.) Both settlement models claim the same way.
        var claim = await query(
          "UPDATE subscription_plan_changes SET status = 'executed', executed_at = ?1 " +
          "WHERE id = ?2 AND status = 'pending'",
          [now, row.id],
        );
        if (!b.sql.casWon(claim).won) continue;   // another run claimed it

        if (rowStripeBacked) {
          // STRIPE-FIRST: swap the price at Stripe with proration_behavior
          // "none" — the new price applies from the next invoice cleanly
          // (next-cycle semantics), no mid-cycle adjustment. On any Stripe
          // failure, roll the claim back to 'pending' (guarded on the
          // just-claimed state) so a later sweep retries it; the local
          // plan_id was NOT touched yet, so there's nothing else to undo.
          // One bad row must not abort the run.
          var toPlan = await _getPlan(row.to_plan_id);
          if (!toPlan || !toPlan.stripe_price_id) {
            await query(
              "UPDATE subscription_plan_changes SET status = 'pending', executed_at = NULL " +
              "WHERE id = ?1 AND status = 'executed'",
              [row.id],
            );
            continue;
          }
          try {
            await _pushPlanToStripe(dueSub.stripe_subscription_id, toPlan.stripe_price_id, "none", row.id);
          } catch (e) {
            // Observe the cause (don't discard it), then roll the claim back
            // to 'pending' so a later sweep retries this row; the local
            // plan_id was not touched. One bad row never aborts the run.
            _log.error("planChanges: scheduled Stripe plan swap failed", {
              plan_change_id:  row.id,
              subscription_id: row.subscription_id,
              err:             (e && e.message) || String(e),
            });
            await query(
              "UPDATE subscription_plan_changes SET status = 'pending', executed_at = NULL " +
              "WHERE id = ?1 AND status = 'executed'",
              [row.id],
            );
            continue;
          }
          // Stripe accepted — land the local plan_id transition. No local
          // credit / invoice for a Stripe-backed row: Stripe owns the money.
          await query(
            "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3",
            [row.to_plan_id, now, row.subscription_id],
          );
          executed.push(await _getById(row.id));
          continue;
        }

        // NON-STRIPE — today's local settlement path, unchanged.
        await query(
          "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3",
          [row.to_plan_id, now, row.subscription_id],
        );
        var subRow = await _getSubscription(row.subscription_id);
        var periodEnd = subRow && subRow.current_period_end != null
          ? subRow.current_period_end : row.effective_at;
        if (creditMinor > 0) {
          try {
            await _issueDowngradeCredit({
              customerId:   subRow ? subRow.customer_id : null,
              creditMinor:  creditMinor,
              planChangeId: row.id,
            });
          } catch (e) {
            // Observe the cause, then revert-on-throw and carry on with the
            // batch: the credit is the customer's money, so a transient write
            // failure must not finalize this downgrade. Roll the plan back and
            // return the row to 'pending' (guarded on the just-applied state)
            // so a later sweep retries it cleanly; one bad row must not abort
            // the run.
            _log.error("planChanges: scheduled downgrade credit failed", {
              plan_change_id:  row.id,
              subscription_id: row.subscription_id,
              err:             (e && e.message) || String(e),
            });
            await query(
              "UPDATE subscriptions SET plan_id = ?1, updated_at = ?2 WHERE id = ?3 AND plan_id = ?4",
              [row.from_plan_id, now, row.subscription_id, row.to_plan_id],
            );
            await query(
              "UPDATE subscription_plan_changes SET status = 'pending', executed_at = NULL " +
              "WHERE id = ?1 AND status = 'executed'",
              [row.id],
            );
            continue;
          }
        }
        await _recordProrationInvoice({
          subscriptionId: row.subscription_id,
          chargeMinor:    chargeMinor,
          currency:       row.currency,
          periodStart:    row.effective_at,
          periodEnd:      periodEnd,
          planChangeId:   row.id,
        });
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
