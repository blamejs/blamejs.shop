-- Subscription analytics cache: memoization of recurring-revenue
-- aggregations the operator dashboard hits frequently.
--
-- The `subscriptionAnalytics` primitive is read-only — every aggregate
-- (MRR, ARR, churn, LTV, pause rate, cohort retention, plan-transition
-- matrix, top-churning plans, recovery rate, daily MRR series)
-- composes the existing `subscriptions` / `subscription_plans` /
-- `subscription_invoices` / `subscription_payment_attempts` /
-- `subscription_dunning_states` / `subscription_control_events` tables.
-- The heavy rollups scan the full window and are pure functions of
-- their inputs — perfect candidates for memoization on the operator
-- dashboard hot path.
--
-- Row shape:
--   scope         — the rollup family: "mrr", "arr", "churn_rate",
--                   "pause_rate", "ltv", "cohort_retention",
--                   "plan_transitions", "top_churning_plans",
--                   "recovery_rate", "daily_mrr_series". Free-form
--                   text; the primitive owns the catalog.
--   scope_value   — `b.crypto.namespaceHash` of the canonical-JSON
--                   parameter object (hex SHA3-512). Domain-separated
--                   by the namespace "subscription-analytics-cache"
--                   so collisions with any other hash in the shop are
--                   cryptographically negligible.
--   period_from   — start of the operator-requested window (epoch-ms).
--   period_to     — end of the window (epoch-ms, exclusive).
--   metric        — short name of the headline figure stored in `value`
--                   (e.g. "mrr_minor", "churn_rate", "active_count").
--                   Pulled out of `breakdown_json` so the dashboard can
--                   render the headline without re-parsing the payload.
--   value         — the headline figure for the row. Integer minor
--                   units for money metrics; for rates the primitive
--                   stores a basis-points scaled integer
--                   (`Math.round(rate * 10000)`) so the column type
--                   stays uniform.
--   breakdown_json — JSON-encoded payload — exactly what the primitive
--                   would have returned if it had executed the query.
--   computed_at   — epoch-ms when the row was written. The primitive's
--                   per-scope TTL applies on top of this stamp.
--
-- Invalidation:
--   * TTL-based (most rollups cache for minutes-to-hours on a
--     dashboard hot path).
--   * Sweep — the primitive exposes a `purgeExpired()` for an operator
--     cron to clear stale rows; the sweep also runs opportunistically
--     when a write lands on a row whose `computed_at + ttl < now`.

CREATE TABLE IF NOT EXISTS subscription_metrics_snapshots (
  id              TEXT NOT NULL PRIMARY KEY,
  scope           TEXT NOT NULL,
  scope_value     TEXT NOT NULL,
  period_from     INTEGER NOT NULL,
  period_to       INTEGER NOT NULL,
  metric          TEXT NOT NULL,
  value           INTEGER NOT NULL,
  breakdown_json  TEXT NOT NULL,
  computed_at     INTEGER NOT NULL
);

-- Lookup index: every hit walks (scope, scope_value, period_from,
-- period_to). UNIQUE so a fresh recompute can REPLACE on the tuple
-- without leaving stale duplicates behind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_metrics_snapshots_scope
  ON subscription_metrics_snapshots(scope, scope_value, period_from, period_to);

-- Sweep index: the expired-row cleanup scans by (scope, computed_at).
-- Keeps the purge tight when only one scope's TTL has elapsed.
CREATE INDEX IF NOT EXISTS idx_subscription_metrics_snapshots_computed_at
  ON subscription_metrics_snapshots(scope, computed_at);

-- Period-overlap index: invalidation queries that touch every cache
-- row whose window crosses a freshly-mutated subscription use
-- (period_from, period_to) to narrow the scan.
CREATE INDEX IF NOT EXISTS idx_subscription_metrics_snapshots_period
  ON subscription_metrics_snapshots(period_from, period_to);
