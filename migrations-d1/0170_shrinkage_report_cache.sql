-- Shrinkage-report cache: memoization of expensive shrinkage
-- aggregations for the loss-prevention dashboard.
--
-- The `shrinkageReport` primitive composes pure read-aggregations over
-- `inventory_writeoffs` (rolled-up by reason / period / location /
-- sku / category). The biggest surfaces (top-N rankings, multi-month
-- trends, full category breakdown) scan the whole window and are pure
-- functions of their inputs — perfect for memoization. This table is
-- the shared cache: a row keyed by (scope_key, scope_value,
-- period_from, period_to) holds the JSON-encoded breakdown + headline
-- rollups (total units + total cost impact) the primitive returns.
--
-- Cache key shape:
--   scope_key    — short identifier of the rollup dimension
--                  ("report", "top_locations", "top_skus",
--                  "category_comparison", "monthly_trend",
--                  "reason_pie", "anomalies"). Free-form text —
--                  the primitive owns the catalog.
--   scope_value  — b.crypto.namespaceHash of the canonical-JSON
--                  parameter object (hex SHA3-512). Domain-separated
--                  by namespace "shrinkage-report-cache" so a
--                  collision with any other hash in the shop is
--                  cryptographically negligible.
--   period_from  — start of the operator-requested window (epoch-ms).
--   period_to    — end of the window (epoch-ms, exclusive).
--   total_units  — sum of `quantity` across non-reversed writeoffs in
--                  the window after the rollup's filters apply. Pulled
--                  out of `breakdown_json` so the dashboard can
--                  render a headline number without re-parsing JSON.
--   total_cost_impact_minor — sum of `cost_impact_minor` across the
--                  same rowset. NULL when no rows had cost-impact
--                  attribution (costLayers wasn't wired at write-off
--                  time, or no on-hand layers existed for the SKU).
--   breakdown_json — JSON-encoded payload — exactly what the
--                  primitive would have returned if it had executed
--                  the query.
--   computed_at  — epoch-ms when the row was written. The primitive's
--                  per-scope TTL applies on top of this stamp.
--
-- Invalidation:
--   - TTL-based (most rollups cache for minutes-to-hours).
--   - Sweep — the primitive exposes `purgeExpired()` for an operator
--     cron to clear stale rows; the sweep also runs opportunistically
--     when a write lands on a row whose computed_at + ttl < now.

CREATE TABLE IF NOT EXISTS shrinkage_report_cache (
  id                       TEXT NOT NULL PRIMARY KEY,
  scope_key                TEXT NOT NULL,
  scope_value              TEXT NOT NULL,
  period_from              INTEGER NOT NULL,
  period_to                INTEGER NOT NULL,
  total_units              INTEGER NOT NULL,
  total_cost_impact_minor  INTEGER,
  breakdown_json           TEXT NOT NULL,
  computed_at              INTEGER NOT NULL
);

-- Lookup index: every hit goes through
-- (scope_key, scope_value, period_from, period_to). Made UNIQUE so the
-- primitive can REPLACE on the tuple without ever leaving stale
-- duplicates behind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shrinkage_report_cache_scope
  ON shrinkage_report_cache(scope_key, scope_value, period_from, period_to);

-- Sweep index: the expired-row cleanup scans by (scope_key,
-- computed_at). Keeps the purge tight when only one scope's TTL has
-- elapsed.
CREATE INDEX IF NOT EXISTS idx_shrinkage_report_cache_computed_at
  ON shrinkage_report_cache(scope_key, computed_at);

-- Period-overlap index: invalidation queries that touch every cache
-- row whose window crosses a freshly-written writeoff use
-- (period_from, period_to) to narrow the scan.
CREATE INDEX IF NOT EXISTS idx_shrinkage_report_cache_period
  ON shrinkage_report_cache(period_from, period_to);
