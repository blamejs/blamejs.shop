-- Sales-report cache: memoization of expensive aggregate reports.
--
-- The `salesReports` primitive composes pure read-aggregations over
-- `orders` + `order_lines` + `return_authorizations`. The biggest
-- surfaces (top-N, multi-month cohort, full funnel) scan the
-- whole window and are pure functions of their inputs — perfect
-- for memoization. This table is the shared cache: a row keyed by
-- (report_key, params_hash) holds the JSON-encoded result and a
-- TTL the primitive honors before returning a stale row.
--
-- Cache key shape:
--   report_key   — short identifier of the report kind
--                  ("revenue_by_day", "top_products", "cohort", ...).
--                  Free-form text — the primitive owns the catalog.
--   params_hash  — b.crypto.namespaceHash output (hex SHA3-512) of
--                  the canonical-JSON-stringified parameter object.
--                  Domain-separated by namespace "sales-report-cache"
--                  so a collision with any other hash in the shop is
--                  cryptographically negligible.
--   result_json  — JSON-encoded payload — exactly what the primitive
--                  would have returned if it had executed the query.
--   computed_at  — epoch-ms when the row was written.
--   expires_at   — epoch-ms after which the row is treated as absent.
--                  The primitive checks `expires_at > now` before
--                  using the row; an expired row falls through to a
--                  recompute + REPLACE.
--
-- Invalidation:
--   - TTL-based (most reports cache for minutes-to-hours).
--   - Sweep — the primitive exposes `purgeExpired()` for an operator
--     cron to clear stale rows; the sweep also runs opportunistically
--     when a write lands on a row whose expires_at < now.

CREATE TABLE IF NOT EXISTS sales_report_cache (
  id           TEXT NOT NULL PRIMARY KEY,
  report_key   TEXT NOT NULL,
  params_hash  TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  computed_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Lookup index: every hit goes through (report_key, params_hash).
-- Made UNIQUE so the primitive can REPLACE on (report_key,
-- params_hash) without ever leaving stale duplicates behind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_report_cache_key
  ON sales_report_cache(report_key, params_hash);

-- Sweep index: the expired-row cleanup scans by expires_at.
CREATE INDEX IF NOT EXISTS idx_sales_report_cache_expires
  ON sales_report_cache(report_key, expires_at);

-- Hash-only lookup index — auditing / debugging surfaces ask "which
-- cache row holds the result for params_hash X?" without knowing
-- which report_key produced it.
CREATE INDEX IF NOT EXISTS idx_sales_report_cache_params_hash
  ON sales_report_cache(params_hash);
