-- Fraud screenings: pre-payment risk scoring ledger.
--
-- The `fraudScreen` primitive evaluates each checkout BEFORE the
-- payment intent is created, emits a `{ score, decision, signals }`
-- verdict, and persists the verdict here so the operator dashboard
-- can show recent activity, the velocity / chargeback signals can
-- look back through prior orders for the same hashed email, and the
-- model can be tuned against actual outcomes once a chargeback or
-- a clean delivery lands.
--
-- Three tables:
--
--   * `fraud_screenings`   — one row per screen() call. `email_hash`
--     is the `b.crypto.namespaceHash("fraud-email", email)` digest;
--     the raw address is never written. `signals_json` is the
--     serialized array of { name, weight, fired, detail } entries
--     so the operator dashboard can render the exact reasoning
--     without re-running the model. `actual_outcome` is filled in
--     later via recordOutcome() once the order resolves (paid_clean
--     / chargeback / refunded / cancelled).
--
--   * `fraud_chargebacks`  — append-only ledger of chargebacks /
--     disputes filed against past orders. The velocity + prior-
--     chargeback signals look back at this table by email_hash.
--     `amount_minor` is the chargeback amount in the currency the
--     order was settled in (operators are responsible for tracking
--     the currency separately if mixed-currency dispute analysis
--     matters — v1 stores the minor-unit number without an FX
--     normalization).
--
--   * `fraud_email_flags`  — operator-pinned manual block-list.
--     `flagEmail({ email, reason })` writes a row keyed by
--     `email_hash`; any subsequent screen() with the same address
--     forces `decision = 'refuse'` regardless of the heuristic
--     score. PK is `email_hash` so re-flagging is idempotent — the
--     row is upserted with the latest reason + timestamp.
--
-- Schema decisions:
--   * Money is INTEGER minor units, non-negative. Same convention
--     as orders / payment_methods so a future cross-table join
--     doesn't require unit-conversion.
--   * `score` is INTEGER 0..100 with a CHECK constraint so a model
--     change can't accidentally start writing out-of-range values
--     without the migration surface noticing.
--   * `decision` is a closed enum — approve / review / step_up /
--     refuse — and CHECKed so the operator dashboard can render
--     fixed pills without defensive normalization.
--   * Indexes are scoped to the dashboard + velocity hot paths:
--     - (email_hash, occurred_at DESC) — velocity lookback + the
--       prior-chargeback signal's email join.
--     - (customer_id, occurred_at)     — customerRiskHistory().
--     - (decision, occurred_at DESC)   — operator-dashboard "show
--       all recent refusals" filter.
--   * No FK on `order_id` because the screen happens BEFORE the
--     order row is created (the orchestrator's first call). The
--     order id is operator-supplied (typically the cart id +
--     namespaceHash, or a freshly minted UUID); referential
--     integrity is enforced by the orchestrator, not the schema.

CREATE TABLE IF NOT EXISTS fraud_screenings (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  customer_id     TEXT,
  email_hash      TEXT NOT NULL,
  score           INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  decision        TEXT NOT NULL CHECK (decision IN ('approve', 'review', 'step_up', 'refuse')),
  signals_json    TEXT NOT NULL DEFAULT '[]',
  actual_outcome  TEXT CHECK (actual_outcome IS NULL OR actual_outcome IN ('paid_clean', 'chargeback', 'refunded', 'cancelled')),
  occurred_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fraud_screenings_email_hash
  ON fraud_screenings(email_hash, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_fraud_screenings_customer
  ON fraud_screenings(customer_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_fraud_screenings_decision
  ON fraud_screenings(decision, occurred_at DESC);

CREATE TABLE IF NOT EXISTS fraud_chargebacks (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  customer_id   TEXT,
  email_hash    TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  reason        TEXT NOT NULL DEFAULT '',
  occurred_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fraud_chargebacks_email_hash
  ON fraud_chargebacks(email_hash, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_fraud_chargebacks_order
  ON fraud_chargebacks(order_id);

CREATE TABLE IF NOT EXISTS fraud_email_flags (
  email_hash    TEXT NOT NULL PRIMARY KEY,
  reason        TEXT NOT NULL DEFAULT '',
  flagged_at    INTEGER NOT NULL
);
