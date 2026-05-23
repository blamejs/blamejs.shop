-- customer-risk-profile: long-running per-customer risk aggregation.
--
-- Distinct from `fraud_screenings` (migration 0038), which records the
-- per-order pre-payment screening verdict. This pair of tables answers
-- the long-term question: "how risky is this account in aggregate?" —
-- the picture an operator uses to qualify a B2B credit line, gate VIP
-- perks, or hand-review every order from a customer with a chargeback
-- history.
--
-- Two-table layout:
--
--   * customer_risk_signals — append-only event log. Each row is one
--     observed bad signal: a chargeback, a high fraudScreen score, a
--     refund that converted to store credit, a late payment, an
--     address mismatch on an order, an unusually diverse device
--     fingerprint set. severity is operator-chosen on a 1..10 scale;
--     `kind` is CHECK-bounded to the documented enum so the dashboard
--     can join on it without normalization. A row can be cleared by
--     an operator (false positive, dispute won, edge case) — clearing
--     sets cleared_at + cleared_by + cleared_reason and drops the row
--     from contributing to `risk_score`.
--
--   * customer_risk_summaries — denormalized per-customer summary,
--     keyed 1:1 by customer_id. `risk_score` is the sum of severities
--     of non-cleared signals within the recent-window (90d default).
--     `risk_band` is the score bucketized into one of four
--     operator-readable tiers: low / moderate / high / critical.
--     `lifetime_signal_count` and `recent_signal_count` are
--     denormalized counters that the dashboard pulls without an
--     aggregate query. The summary row is created lazily on first
--     `recompute()` (no row exists for never-recorded customers).
--
-- Monotonic per-customer occurred_at: two signal writes against the
-- same customer in the same millisecond would tie and make the
-- "latest signal" read ambiguous for the `(customer_id, occurred_at
-- DESC)` index. The primitive bumps colliding timestamps to `prior +
-- 1` so the index is strictly monotonic per customer (same discipline
-- as credit_transactions in migration 0122).

CREATE TABLE IF NOT EXISTS customer_risk_signals (
  id              TEXT NOT NULL PRIMARY KEY,
  customer_id     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'chargeback',
                    'refund_request',
                    'fraud_score_high',
                    'chargeback_dispute_lost',
                    'late_payment',
                    'address_mismatch',
                    'device_diversity_high',
                    'refund_to_credit'
                  )),
  severity        INTEGER NOT NULL CHECK (severity >= 1 AND severity <= 10),
  detail_json     TEXT,
  occurred_at     INTEGER NOT NULL,
  cleared_at      INTEGER,
  cleared_by      TEXT,
  cleared_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_customer_risk_signals_customer
  ON customer_risk_signals(customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_risk_signals_kind
  ON customer_risk_signals(customer_id, kind);
CREATE INDEX IF NOT EXISTS idx_customer_risk_signals_cleared
  ON customer_risk_signals(cleared_at);

CREATE TABLE IF NOT EXISTS customer_risk_summaries (
  customer_id            TEXT NOT NULL PRIMARY KEY,
  risk_score             INTEGER NOT NULL CHECK (risk_score >= 0),
  risk_band              TEXT NOT NULL CHECK (risk_band IN ('low', 'moderate', 'high', 'critical')),
  lifetime_signal_count  INTEGER NOT NULL CHECK (lifetime_signal_count >= 0),
  recent_signal_count    INTEGER NOT NULL CHECK (recent_signal_count >= 0),
  recomputed_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_risk_summaries_score
  ON customer_risk_summaries(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_customer_risk_summaries_band
  ON customer_risk_summaries(risk_band, risk_score DESC);
