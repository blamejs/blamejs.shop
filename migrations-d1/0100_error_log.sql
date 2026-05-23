-- Error log — operator-side record of HTTP 4xx/5xx events for
-- broken-link triage + upstream-failure monitoring + slow-render
-- alerting. Written by `lib/error-log.js` from the request
-- lifecycle; read by the operator dashboard.
--
-- Schema decisions:
--   * `status` is the HTTP status code (400-599). Stored as INTEGER
--     so range filters (`status BETWEEN 500 AND 599`) hit the index
--     without a CAST.
--   * `method` is a CHECK-constrained enum of the HTTP methods the
--     framework dispatches. An unknown method on the request line
--     drops at the write site (this is a hot-path sink — the
--     primitive refuses to crash the request that triggered it).
--   * `path` is the request path (no query string). The aggregate
--     queries GROUP BY path to surface the dead-link top-N; query-
--     string variation would shatter the buckets, so callers strip
--     it before passing.
--   * `referrer` is the inbound Referer header (or NULL). Useful for
--     tracking where dead links live; nothing else reads it.
--   * `user_agent_class` is a small enum (`desktop` / `mobile` /
--     `bot` / `other`) — same shape as `analytics_events`. A full UA
--     string is PII-adjacent and never persisted.
--   * `session_id_hash` is HASHED at the write site via
--     `b.crypto.namespaceHash("error-log-session", ...)`. Raw
--     session_id never reaches this table.
--   * `customer_id` is the logged-in customer's id when known (NULL
--     for anonymous traffic). Stored plain because the customers
--     table primary-keys on the same shape; operators join when
--     they need the customer email.
--   * `error_id` is a server-generated correlation id surfaced in
--     the rendered error page (so a customer copy-pastes "error
--     7f3a..." and the operator looks up exactly the row). NULL when
--     the request didn't surface an error page (e.g. an API 404).
--   * `response_time_ms` is the request → response wall-clock in
--     milliseconds. NULL when the timing wasn't captured. Used by
--     `slowRenders` to surface p99 outliers and by `metrics` for
--     percentile math.
--   * `occurred_at` is epoch-ms (matches every other table). Indexes
--     are `(status, occurred_at DESC)` for status-bucket dashboards,
--     `(path, status, occurred_at)` for per-path drilldowns,
--     `(error_id)` for correlation-id lookup, and `(occurred_at)`
--     for retention sweeps.

CREATE TABLE IF NOT EXISTS error_log (
  id           TEXT NOT NULL PRIMARY KEY,
  status       INTEGER NOT NULL,
  path         TEXT NOT NULL,
  method       TEXT NOT NULL CHECK (method IN (
    'GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'
  )),
  referrer     TEXT,
  user_agent_class TEXT NOT NULL CHECK (user_agent_class IN (
    'desktop','mobile','bot','other'
  )),
  -- Hashed session join key — raw session_id never reaches this
  -- table. NULL when the request had no session cookie at all.
  session_id_hash TEXT,
  customer_id     TEXT,
  -- Server-generated correlation id surfaced in the rendered
  -- error page. NULL when the request didn't surface one.
  error_id        TEXT,
  -- Wall-clock from request to response in ms. NULL when the
  -- timing wasn't captured (e.g. a router-level 404 before the
  -- timing middleware ran).
  response_time_ms INTEGER,
  occurred_at  INTEGER NOT NULL
);

-- Status-bucket dashboards: "5xx in the last hour" / "404s today".
-- DESC on occurred_at so the dashboard's most-recent-N scans the
-- head of the index without an in-memory sort.
CREATE INDEX IF NOT EXISTS idx_error_log_status_time ON error_log(status, occurred_at DESC);

-- Per-path drilldowns: "every 404 hit on /products/foo" + the
-- top-404 aggregate. Composite covers GROUP BY path with a status
-- filter and an occurred_at window.
CREATE INDEX IF NOT EXISTS idx_error_log_path_status_time ON error_log(path, status, occurred_at);

-- Correlation-id lookup — operator pastes the error id the customer
-- copied from the rendered page and pulls the single row back.
CREATE INDEX IF NOT EXISTS idx_error_log_error_id ON error_log(error_id);

-- Retention sweeps: DELETE FROM error_log WHERE occurred_at < ?
CREATE INDEX IF NOT EXISTS idx_error_log_occurred_at ON error_log(occurred_at);
