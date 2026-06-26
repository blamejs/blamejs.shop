-- Loyalty ledger: per-customer running-balance hash chain.
--
-- loyalty_transactions becomes an append-only running-balance ledger: each
-- mutating row carries balance_after_points + lifetime_after_points + tier_after
-- (the running state AFTER the row) plus prev_hash + row_hash (a per-customer
-- SHA3-512 chain). The single guarded INSERT that records the event also carries
-- the new balance, so the balance change and the audit row are one write — there
-- is no longer a window between a stored-column balance UPDATE and the ledger
-- INSERT to crash in. This is the model the gift-card ledger (0220/0230) and the
-- store-credit ledger (0235/0236) already run on; loyalty_accounts is kept as a
-- non-authoritative mirror (balance_points / lifetime_points / tier /
-- tier_expires_at) for the cross-customer leaderboard and the operator
-- tier-expiry time-bound, never read on a mutation's decision path.
--
-- All five columns are nullable so the ALTER applies cleanly over live rows
-- (pre-chain history carries NULL). A NULL row_hash is an unverifiable legacy
-- prefix; a NULL balance_after_points is a pre-running-balance row. The first
-- app write off a NULL-hash tip anchors the chain from ZERO_HASH (lazy genesis
-- anchor, mirroring lib/gift-card-ledger.js _readLatest).

ALTER TABLE loyalty_transactions ADD COLUMN balance_after_points  INTEGER;
ALTER TABLE loyalty_transactions ADD COLUMN lifetime_after_points INTEGER;
ALTER TABLE loyalty_transactions ADD COLUMN tier_after            TEXT;
ALTER TABLE loyalty_transactions ADD COLUMN prev_hash             TEXT;
ALTER TABLE loyalty_transactions ADD COLUMN row_hash              TEXT;

-- Chain-parent fence: a row's prev_hash names its parent, and a chain has
-- exactly one child per parent — two concurrent writes off the same tip collide
-- here instead of forking the chain or persisting a stale balance_after; the
-- loser re-reads the advanced tip and retries. Partial: legacy NULL-prev_hash
-- rows are exempt. Genesis rows carry prev_hash = ZERO_HASH (a real value), so a
-- second genesis for the same customer collides on (customer_id, ZERO_HASH) — a
-- free double-anchor guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_tx_chain_parent
  ON loyalty_transactions(customer_id, prev_hash) WHERE prev_hash IS NOT NULL;

-- O(1) tip read: latest row by (customer_id, occurred_at DESC, id DESC). The
-- base 0022 index is (customer_id, occurred_at DESC); the id tail makes a
-- same-ms tie deterministic (uuid.v7 is lexicographically monotonic). The
-- write path's _resolveOccurredAt already enforces strict-monotonic occurred_at
-- per customer, so the tie-break is belt-and-braces.
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_running
  ON loyalty_transactions(customer_id, occurred_at DESC, id DESC);

-- Per-customer genesis anchor: one row per existing loyalty_accounts row,
-- carrying the CURRENT TRUSTED balance / lifetime / tier as the running
-- snapshot. We do NOT replay or SUM history — historical deltas need not equal
-- the live balance after an out-of-band operator adjust, and a disagreeing
-- replay would CORRUPT the balance. The anchor copies the existing balance
-- verbatim with points = 0, so it nets to zero in any SUM / history / metrics
-- and cannot shift a balance. row_hash stays NULL (SHA3-512 is computed
-- app-side); the lazy ZERO_HASH anchor in _readLatest coerces this NULL-hash tip
-- so the first app write chains off ZERO_HASH and recomputes the genesis hash.
-- Deterministic id ('genesis-' || customer_id) + WHERE NOT EXISTS a
-- prev_hash-bearing row + the (customer_id, ZERO_HASH) fence make re-applying
-- the migration a no-op. occurred_at = the account's created_at places the
-- anchor at the oldest position (history pagination reaches it last).
INSERT INTO loyalty_transactions
  (id, customer_id, transaction_type, points, source, order_id, notes,
   occurred_at, balance_after_points, lifetime_after_points, tier_after,
   prev_hash, row_hash)
SELECT
  'genesis-' || a.customer_id, a.customer_id, 'adjust', 0, 'chain-genesis', NULL, '',
  a.created_at, a.balance_points, a.lifetime_points, a.tier,
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  NULL
FROM loyalty_accounts a
WHERE NOT EXISTS (
  SELECT 1 FROM loyalty_transactions t
  WHERE t.customer_id = a.customer_id AND t.prev_hash IS NOT NULL
);
