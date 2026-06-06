-- Loyalty ledger: cumulative points already restored against a redeem row.
--
-- Points a customer SPENT as a checkout tender must be re-credited when the
-- order is refunded, in the same proportion as the refund. restored_points
-- carries the cumulative points already restored against the redeem
-- transaction the order is linked through (order_id); a restore credits the
-- delta up to the proportional target and advances this column, so a
-- partial-then-final refund converges on the full redeemed amount. Default 0
-- so existing rows read as nothing-restored-yet.
ALTER TABLE loyalty_transactions ADD COLUMN restored_points INTEGER NOT NULL DEFAULT 0;

-- The restore looks the redeem rows up by (order_id) — the order whose refund
-- is releasing them. Restricted to the redeem rows a refund restores.
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_order_restore
  ON loyalty_transactions(order_id, transaction_type)
  WHERE order_id IS NOT NULL AND transaction_type = 'redeem';
