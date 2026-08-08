-- In-flight claim for a Stripe-backed immediate plan change.
--
-- An immediate change moves the local plan_id and reprices the subscription at
-- Stripe. Those are two steps against two systems, and the local step lands
-- first so that concurrent changes serialize on it. That leaves a window where
-- the database already advertises the NEW plan while the provider call for it
-- is still in flight — long enough for a second change to read the new plan,
-- win its own plan_id claim, and issue a second provider call. The two calls
-- then settle in arbitrary order, so Stripe can finish on the earlier plan
-- while the shop shows the later one, and the proration invoices are cut
-- against the wrong transition.
--
-- This column closes that window. It holds the subscription_plan_changes id
-- whose provider call has not settled yet; NULL means no transition is in
-- flight. The claim is a single conditional UPDATE gated on BOTH the current
-- plan id AND this column being NULL, so a transition cannot start while
-- another is unsettled and two provider calls for one subscription can never
-- overlap. The winner clears the column once Stripe confirms.
--
-- It also gives the change's provider call a durable identity. The idempotency
-- key is the claimed change row's id, so a retry of the SAME unsettled
-- transition replays under the same key and Stripe dedupes it, while a later,
-- genuinely separate transition between the same two plans in the same billing
-- period is a different row and therefore bills correctly.
ALTER TABLE subscriptions ADD COLUMN plan_transition_change_id TEXT;

-- The scheduler sweep reconciles subscriptions stranded mid-transition (the
-- provider call outcome was indeterminate — a timeout or a 5xx — so the claim
-- is deliberately held rather than rolled back). Only those rows carry a
-- non-NULL value, so a partial index keeps the sweep's lookup off a full scan
-- while costing nothing on the overwhelmingly common settled row.
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_transition
  ON subscriptions(plan_transition_change_id)
  WHERE plan_transition_change_id IS NOT NULL;
