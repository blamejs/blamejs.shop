-- Gift-card redemption reversal marker.
--
-- A gift-card redemption (giftcard_redemptions) debits spendable balance
-- off the card row at checkout. When the order that spent the card never
-- completes — abandoned, cancelled, or refunded — that debit has to be
-- credited back or the customer's balance is silently burned. The reversal
-- restores the card balance and writes a refund_to_giftcard ledger credit.
--
-- `reversed_at` is the idempotency marker: a redemption is reversed at most
-- once. The reversal claims the row with `UPDATE ... WHERE id = ? AND
-- reversed_at IS NULL` so a concurrent double-fire (the stale-order reaper
-- racing a payment-failed webhook) credits the balance back exactly once.
-- NULL = still spent; a timestamp = already credited back.

ALTER TABLE giftcard_redemptions ADD COLUMN reversed_at INTEGER;

-- The reversal looks redemptions up by order_id (the order whose settlement
-- is releasing them), so index that lookup alongside the existing per-card
-- index. Partial on the unreversed rows keeps the index small — once a
-- redemption is credited back it drops out of the working set.
CREATE INDEX IF NOT EXISTS idx_giftcard_redemptions_order
  ON giftcard_redemptions(order_id) WHERE reversed_at IS NULL;
