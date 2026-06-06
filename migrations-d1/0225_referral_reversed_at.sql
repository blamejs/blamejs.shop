-- Referral invitations: the timestamp the funnel completion was reversed.
--
-- A referral's qualifying first order being refunded / cancelled must roll
-- back the both-rewarded completion so buy-then-refund can't farm referral
-- rewards. NULL = still counted toward the referrer's leaderboard; a timestamp
-- = the completion was rolled back and referrals_count decremented. The
-- reversal claims the row with `WHERE first_order_id = ? AND reversed_at IS
-- NULL` so a re-delivered refund webhook reverses the funnel exactly once.
ALTER TABLE referral_invitations ADD COLUMN reversed_at INTEGER;

-- The reversal finds the invitation by the order that completed it
-- (first_order_id), so index that lookup; partial on the un-reversed rows
-- keeps the working set small.
CREATE INDEX IF NOT EXISTS idx_referral_invitations_first_order
  ON referral_invitations(first_order_id) WHERE reversed_at IS NULL;
