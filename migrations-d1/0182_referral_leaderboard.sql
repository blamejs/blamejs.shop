-- Referral leaderboard — top-referrer reports + tiered rewards on
-- top of the existing referrals primitive (migration 0025).
--
-- Two tables:
--
--   referral_tier_config            — singleton (id = 1) operator-
--                                     tunable thresholds for the
--                                     rolling-90-day completed-
--                                     referral count that places a
--                                     referrer into bronze / silver /
--                                     gold / platinum. The
--                                     `referralTier({ customer_id })`
--                                     read counts completed funnels
--                                     against these thresholds.
--                                     `setTierThresholds(...)` upserts
--                                     this row; absent row falls back
--                                     to the primitive-shipped
--                                     defaults at read time.
--
--   referral_leaderboard_bonuses    — append-only payout log keyed by
--                                     (customer_id, period_label,
--                                     tier). The UNIQUE constraint is
--                                     the re-award gate — a second
--                                     awardLeaderboardBonus call with
--                                     the same triple collapses to a
--                                     no-op (the row's loyalty.earn
--                                     composition only fires on the
--                                     INSERT side). `period_label` is
--                                     operator-defined ("2026-05" /
--                                     "2026-Q2" / "2026-week-21") —
--                                     the primitive treats it as an
--                                     opaque string.

CREATE TABLE IF NOT EXISTS referral_tier_config (
  id                   INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  bronze_threshold     INTEGER NOT NULL CHECK (bronze_threshold >= 0),
  silver_threshold     INTEGER NOT NULL CHECK (silver_threshold >= 0),
  gold_threshold       INTEGER NOT NULL CHECK (gold_threshold >= 0),
  platinum_threshold   INTEGER NOT NULL CHECK (platinum_threshold >= 0),
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_leaderboard_bonuses (
  id                   TEXT NOT NULL PRIMARY KEY,
  customer_id          TEXT NOT NULL,
  tier                 TEXT NOT NULL CHECK (tier IN ('bronze','silver','gold','platinum')),
  period_label         TEXT NOT NULL,
  points_awarded       INTEGER NOT NULL CHECK (points_awarded >= 0),
  occurred_at          INTEGER NOT NULL,
  UNIQUE (customer_id, period_label, tier)
);

CREATE INDEX IF NOT EXISTS idx_referral_leaderboard_bonuses_customer
  ON referral_leaderboard_bonuses(customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_leaderboard_bonuses_period
  ON referral_leaderboard_bonuses(period_label, tier);
CREATE INDEX IF NOT EXISTS idx_referral_leaderboard_bonuses_occurred
  ON referral_leaderboard_bonuses(occurred_at DESC);
