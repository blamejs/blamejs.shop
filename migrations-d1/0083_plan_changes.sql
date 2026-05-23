-- Subscription plan changes — proration-aware upgrade / downgrade
-- ledger layered on top of the existing `subscriptions` row. A row in
-- `subscription_plan_changes` represents a customer's transition from
-- one `subscription_plans.id` to another. The row carries the
-- proration math computed at propose-time (credit for the unused
-- portion of the current period on the outgoing plan + first
-- prorated charge on the incoming plan) plus the FSM state the
-- scheduler walks.
--
-- Two transition kinds:
--
--   immediate          — the new plan takes effect on a calendar
--                        clock the operator chooses (defaults to
--                        Date.now()). Proration credit + first
--                        charge are queued through
--                        `subscriptionBilling` (when injected) the
--                        moment `executeChange` runs.
--
--   next_billing_cycle — the change is queued for the subscription's
--                        `current_period_end`. No proration math
--                        applies (the outgoing plan rides out its
--                        period in full; the incoming plan starts
--                        clean at the next cycle). The scheduler's
--                        `applyScheduledChanges` walk picks the row
--                        up when `effective_at <= now`.
--
-- FSM:
--
--   proposed  — `proposeChange` wrote the row; not yet committed.
--   pending   — `executeChange` accepted the row but `effective_at`
--               is in the future. The scheduler flips it to
--               `executed` when the clock reaches it.
--   executed  — the plan transition landed. The outgoing plan row
--               on `subscriptions.plan_id` has been replaced;
--               proration adjustments (if any) have been queued via
--               `subscriptionBilling`.
--   cancelled — the operator (or the customer, via the portal) ran
--               `cancelPendingChange` before the scheduler
--               executed the row. Terminal.
--
-- `cancelPendingChange` refuses a row once `status = 'executed'` —
-- the transition already happened; rolling it back is a fresh
-- plan-change in the other direction, not a cancellation.
--
-- Indexes:
--   * (subscription_id, created_at DESC) — `historyForSubscription`
--     renders newest-first on the customer profile screen.
--   * (status, effective_at) — `applyScheduledChanges` walks every
--     row with `status = 'pending' AND effective_at <= now`; the
--     composite covers the predicate.
--   * (effective_at) — operator dashboards filtering "show me every
--     change landing this week" hit the standalone index without
--     the status predicate.

CREATE TABLE IF NOT EXISTS subscription_plan_changes (
  id                       TEXT NOT NULL PRIMARY KEY,
  subscription_id          TEXT NOT NULL,
  from_plan_id             TEXT NOT NULL,
  to_plan_id               TEXT NOT NULL,
  change_kind              TEXT NOT NULL CHECK (change_kind IN ('immediate', 'next_billing_cycle')),
  status                   TEXT NOT NULL CHECK (status IN ('proposed', 'pending', 'executed', 'cancelled')),
  proration_credit_minor   INTEGER NOT NULL DEFAULT 0 CHECK (proration_credit_minor >= 0),
  first_charge_minor       INTEGER NOT NULL DEFAULT 0 CHECK (first_charge_minor >= 0),
  currency                 TEXT NOT NULL CHECK (length(currency) = 3),
  effective_at             INTEGER NOT NULL,
  executed_at              INTEGER,
  cancelled_at             INTEGER,
  cancel_reason            TEXT,
  created_at               INTEGER NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
  FOREIGN KEY (from_plan_id)    REFERENCES subscription_plans(id),
  FOREIGN KEY (to_plan_id)      REFERENCES subscription_plans(id)
);

CREATE INDEX IF NOT EXISTS idx_sub_plan_changes_subscription
  ON subscription_plan_changes(subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sub_plan_changes_status_effective
  ON subscription_plan_changes(status, effective_at);

CREATE INDEX IF NOT EXISTS idx_sub_plan_changes_effective
  ON subscription_plan_changes(effective_at);
