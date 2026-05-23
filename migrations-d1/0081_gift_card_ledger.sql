-- Gift-card ledger: append-only credit/debit/expire rows per card.
--
-- This is the LEDGER side of the gift-card surface. The companion
-- `giftcards` primitive (migration 0013) owns the bearer-credential
-- code, the issued/balance snapshot on the card row, and the
-- single-action `redeem` path that decrements that snapshot. This
-- table is the audit-trail / replay-derivable view of the same
-- balance — every credit (issuance, refund-to-giftcard, promotional
-- credit, operator manual adjustment), every debit (order capture),
-- and every operator-initiated expire lands as one row keyed by
-- `gift_card_id`.
--
-- Schema decisions:
--   * `kind` is a CHECK-bounded enum: credit / debit / expire.
--     `amount_minor` is always stored as a positive integer (the
--     `kind` carries the sign), so range queries that sum positive
--     deltas — total credited, total debited — read cleanly.
--   * `source` is nullable because it only applies to credits: every
--     credit row carries a CHECK-bounded source (purchase /
--     refund_to_giftcard / promotional / manual). Debit + expire rows
--     set source NULL.
--   * `source_ref` is the operator-supplied free-form correlation
--     handle (e.g. the originating order id for a `purchase` credit,
--     a refund-id for `refund_to_giftcard`, a campaign code for
--     `promotional`). Stored as TEXT so a future primitive can
--     introduce structured sub-shapes without a schema migration.
--   * `order_id` is the order this row settles against — populated
--     on debit rows; nullable for credit + expire.
--   * `balance_after_minor` is the denormalized snapshot of the
--     card balance AFTER this row applied. With the
--     `(gift_card_id, occurred_at DESC)` index the current balance
--     query becomes ORDER-BY-occurred_at-DESC + LIMIT 1, O(1)
--     against the index, no SUM aggregation needed at read time.
--   * `occurred_at` is operator-supplied epoch-ms (defaults to "now"
--     at the primitive layer when the caller omits it). Distinct
--     from `created_at` (which we don't carry) so an operator
--     back-dating a manual credit lands the row in the audit order
--     they expect.
--   * Index `(gift_card_id, occurred_at DESC)` drives the balance
--     read + the history pagination cursor. `(order_id)` drives the
--     `transactionsForOrder` lookup. `(kind, occurred_at)` drives
--     reporting queries ("total credited last month").

CREATE TABLE IF NOT EXISTS gift_card_ledger (
  id                   TEXT NOT NULL PRIMARY KEY,
  gift_card_id         TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('credit', 'debit', 'expire')),
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  source               TEXT CHECK (source IS NULL OR source IN ('purchase', 'refund_to_giftcard', 'promotional', 'manual')),
  source_ref           TEXT,
  order_id             TEXT,
  balance_after_minor  INTEGER NOT NULL CHECK (balance_after_minor >= 0),
  occurred_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gift_card_ledger_card  ON gift_card_ledger(gift_card_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_card_ledger_order ON gift_card_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_gift_card_ledger_kind  ON gift_card_ledger(kind, occurred_at);
