-- Loyalty earn reversal marker.
--
-- An order's paid transition awards points (loyalty_earn_log rows + a
-- loyalty.earn credit to the balance). When that order is later cancelled
-- or refunded the points have to come back off the balance or a customer
-- can farm rewards by buying then refunding. The reversal claws the awarded
-- points back off the running balance (floored at zero — a concurrent spend
-- may already have drained them) and marks the earn-log rows reversed.
--
-- `reversed_at` is the idempotency marker: an earn-log row is reversed at
-- most once. The reversal claims the rows with `UPDATE ... WHERE
-- customer_id = ? AND trigger_event_ref = ? AND reversed_at IS NULL` so a
-- concurrent double-fire (the stale-order reaper racing a refund webhook)
-- claws the points back exactly once. NULL = still awarded; a timestamp =
-- already reversed. Lifetime points are NOT decremented — tier never
-- downgrades retroactively (loyalty.adjust's existing stance).

ALTER TABLE loyalty_earn_log ADD COLUMN reversed_at INTEGER;

-- The reversal claims rows by (customer_id, trigger_event_ref) — the order
-- whose settlement is reversing them — across every rule that awarded for
-- that event. Partial on the unreversed rows keeps the index small: once a
-- row is reversed it drops out of the working set.
CREATE INDEX IF NOT EXISTS idx_loyalty_earn_log_reversal
  ON loyalty_earn_log(customer_id, trigger_event_ref) WHERE reversed_at IS NULL;
