-- Per-affiliate tamper-evidence hash chain over affiliate_commissions, the
-- last money ledger without one (gift-card, store-credit, and loyalty are
-- already chained). Each commission row links to the prior commission for the
-- SAME affiliate via prev_hash; row_hash = SHA3-512(prev_hash ||
-- canonical-json(immutable money fields)).
--
-- Unlike the other ledgers, affiliate_commissions is NOT append-only — a
-- commission's status walks pending -> paid -> voided and stamps paid_at /
-- voided_at / payout_reference / void_reason in place. Those mutable lifecycle
-- columns are EXCLUDED from the hashed field set, so marking a commission paid
-- or voided never invalidates the chain; only the immutable money facts (order,
-- affiliate, totals, currency, occurred_at) are attested.
ALTER TABLE affiliate_commissions ADD COLUMN prev_hash TEXT;
ALTER TABLE affiliate_commissions ADD COLUMN row_hash  TEXT;

-- Chain-parent fence: at most one child per (affiliate_id, parent row_hash), so
-- a commission derived from a STALE tip collides at the constraint instead of
-- forking the affiliate's chain — the writer re-reads the tip and retries.
-- Legacy pre-chain rows carry NULL prev_hash; SQLite treats NULLs as distinct,
-- so they never collide and the chain anchors fresh (from the all-zero hash) at
-- the first commission recorded after this migration. verifyChain reports the
-- unhashed legacy prefix as unverifiable rather than silently trusting it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_commissions_chain
  ON affiliate_commissions(affiliate_id, prev_hash);
