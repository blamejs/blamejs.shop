-- Gift-card ledger hash-chain columns.
--
-- The gift_card_ledger (0081) tracks every credit / debit / expire as an
-- append-only row with a denormalized `balance_after_minor` snapshot. That
-- snapshot is the only on-row integrity device — and it is a value, not a
-- proof: a direct D1 row edit that inflates `balance_after_minor`, or a
-- row deletion that drops a debit, passes `balance()` / `bulkBalance()`
-- undetected because both read the latest snapshot and trust it.
--
-- These columns add tamper-evidence the same way operator_audit_events
-- (0074) does: a per-card SHA3-512 hash chain.
--
--   row_hash = SHA3-512(prev_hash || canonical-json(row-fields))
--
-- where `prev_hash` is the prior row's `row_hash` for the SAME gift card
-- (or the ZERO sentinel for a card's first row), and `row-fields` is every
-- ledger column except the two hash columns. Each card is its own
-- independent chain keyed by `gift_card_id` — a tamper on one card's row
-- breaks only that card's linkage, which `verifyChain(giftCardId)`
-- surfaces with the first divergent row.
--
-- Both columns are nullable so the migration applies cleanly over existing
-- rows (pre-chain history carries NULL hashes). `verifyChain` treats the
-- ZERO sentinel as the genesis anchor and a NULL/garbage row_hash as a
-- break, so a legacy row that was never hashed is reported as
-- unverifiable rather than silently trusted. New writes always populate
-- both columns.

ALTER TABLE gift_card_ledger ADD COLUMN prev_hash TEXT;
ALTER TABLE gift_card_ledger ADD COLUMN row_hash  TEXT;
