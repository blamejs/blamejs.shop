-- Chain-parent fence for the gift-card ledger's hash chain. A ledger row's
-- prev_hash names its parent, and a hash chain has exactly one child per
-- parent — so two concurrent writes deriving from the same tip collide on
-- this constraint instead of forking the chain or persisting a balance
-- computed off a stale snapshot; the loser re-reads the tip and retries.
-- Partial: legacy pre-chain rows carry NULL prev_hash and stay exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_card_ledger_chain_parent
  ON gift_card_ledger(gift_card_id, prev_hash) WHERE prev_hash IS NOT NULL;
