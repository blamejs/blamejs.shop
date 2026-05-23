-- Store-credit ledger: append-only credit/debit/expire rows per customer.
--
-- Distinct from the `gift_card_ledger` table (migration 0081). That
-- table is keyed by `gift_card_id` because gift cards are bearer
-- credentials — a single code can be loaded, partially debited,
-- transferred to whoever holds the code. This table is keyed by
-- `customer_id` because store credit is account-bound: it lives on
-- the customer record and follows the customer, with no code surface
-- and no transfer path.
--
-- The two share the same ledger shape (kind enum, positive amount,
-- denormalized `balance_after_minor`, operator-supplied
-- `occurred_at`) because the read patterns are identical: O(1)
-- current balance, paginated history newest-first, transactions
-- touching a given order, expiring-balance sweeps.
--
-- Schema decisions:
--   * `kind` is a CHECK-bounded enum: credit / debit / expire.
--     `amount_minor` is always stored as a positive integer (the
--     `kind` carries the sign).
--   * `source` is the credit-row provenance — CHECK-bounded enum:
--     refund / goodwill / promotional / manual / loyalty_redemption.
--     NULL on debit + expire rows.
--   * `source_ref` is the free-form correlation handle (originating
--     refund id, campaign code, operator note). Stored TEXT so a
--     future primitive can introduce structured sub-shapes without a
--     schema migration.
--   * `order_id` is the order this row settles against — populated
--     on debit rows; nullable for credit + expire.
--   * `balance_after_minor` is the denormalized snapshot of the
--     customer's store-credit balance AFTER this row applied. With
--     the `(customer_id, occurred_at DESC)` index the current
--     balance query becomes ORDER-BY-occurred_at-DESC + LIMIT 1.
--   * `expires_at` is nullable epoch-ms on credit rows — the
--     deadline after which the credited amount is swept by the
--     scheduler-callable `cleanupExpired`. NULL means "never
--     expires" (manual operator credits, loyalty redemptions
--     redeemed at point of order). Indexed partial (WHERE NOT NULL)
--     so the expiring-sweep query is bounded by rows that actually
--     carry a deadline.
--   * `occurred_at` is operator-supplied epoch-ms (defaults to
--     "now" at the primitive layer when the caller omits it).

CREATE TABLE IF NOT EXISTS store_credit_ledger (
  id                   TEXT NOT NULL PRIMARY KEY,
  customer_id          TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('credit', 'debit', 'expire')),
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  source               TEXT CHECK (source IS NULL OR source IN ('refund', 'goodwill', 'promotional', 'manual', 'loyalty_redemption')),
  source_ref           TEXT,
  order_id             TEXT,
  balance_after_minor  INTEGER NOT NULL CHECK (balance_after_minor >= 0),
  expires_at           INTEGER,
  occurred_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_customer ON store_credit_ledger(customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_order    ON store_credit_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_store_credit_ledger_expires  ON store_credit_ledger(expires_at) WHERE expires_at IS NOT NULL;
