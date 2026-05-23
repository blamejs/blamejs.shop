-- Loyalty — customer points-balance + tier accounts.
--
-- Two tables, append-only ledger model:
--   * `loyalty_accounts` holds the live state per customer:
--     running `balance_points` (spendable), `lifetime_points` (never
--     decremented, drives tier promotions), current `tier`, and
--     optional `tier_expires_at` for time-bound tier guarantees.
--   * `loyalty_transactions` is the audit trail: every earn / redeem /
--     expire / adjust / tier-bonus event lands as a row keyed by
--     `customer_id` with the `points` delta, an operator-supplied
--     `source` string, an optional `order_id` link, and an
--     `occurred_at` epoch-ms timestamp.
--
-- Schema decisions:
--   * `balance_points` and `lifetime_points` carry CHECK >= 0 so the
--     SQL tier guards against negative balances even if the
--     application layer slips. Redemption that would underflow is
--     refused at the primitive layer; the CHECK is belt-and-braces.
--   * Tier is an enumerated string column so an operator inspecting
--     the table can read it directly without a lookup join.
--   * Transactions store the raw signed `points` delta — earn is
--     positive, redeem/expire are negative, adjust can be either.
--     The `transaction_type` column carries the operator-facing
--     category so reporting can group without parsing the sign.
--   * `(customer_id, occurred_at DESC)` index drives the history
--     pagination cursor. `(transaction_type, occurred_at)` drives
--     reporting queries ("how many points did we earn last month?").
--   * `(tier, balance_points)` on accounts drives the leaderboard
--     query without a full table scan.

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  customer_id    TEXT NOT NULL PRIMARY KEY,
  balance_points INTEGER NOT NULL DEFAULT 0 CHECK (balance_points >= 0),
  lifetime_points INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
  tier           TEXT NOT NULL DEFAULT 'bronze' CHECK (tier IN ('bronze','silver','gold','platinum')),
  tier_expires_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id          TEXT NOT NULL PRIMARY KEY,
  customer_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('earn','redeem','expire','adjust','tier-bonus')),
  points      INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  order_id    TEXT,
  notes       TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES loyalty_accounts(customer_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_customer ON loyalty_transactions(customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_type ON loyalty_transactions(transaction_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_accounts_tier ON loyalty_accounts(tier, balance_points);
