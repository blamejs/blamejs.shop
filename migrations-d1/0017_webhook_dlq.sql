-- Webhook delivery retry policy + dead-letter queue.
--
-- Extends the outbound webhook surface (introduced in
-- `0005_webhooks.sql`) with three concerns that the v1 delivery flow
-- needed to be defensible against a flaky or hostile receiver:
--
--   1. **Backoff retry policy.** A delivery that fails (HTTP non-2xx,
--      timeout, or DNS / TCP error) is rescheduled with exponential
--      backoff [60s, 5m, 30m, 4h, 24h] before the next attempt. The
--      `next_retry_at` column drives a polled scheduler; the
--      `last_attempted_at` column lets the admin list show "last tried
--      at <ts>" separately from "row created at <ts>".
--
--   2. **Dead-letter queue.** After five failed attempts the delivery
--      is moved to `webhook_dlq` for operator investigation — the
--      receiver is either offline long-term or rejecting payloads. The
--      original row stays in `webhook_deliveries` with attempts >= 5
--      so the per-endpoint feed still surfaces the failure; the DLQ
--      row carries the full payload so `replayFromDlq(id)` can
--      re-queue without consulting the original delivery row.
--
--   3. **Per-subscription rate limit.** A slow receiver shouldn't get
--      the entire fan-out throughput pointed at it. Each endpoint
--      carries a `rate_limit_per_minute` ceiling (default 60). At
--      dispatch time the framework counts deliveries created in the
--      last 60s for that endpoint and refuses the new delivery (with
--      `last_error = "rate-limited"`) when the ceiling would be
--      exceeded. The refusal still persists a delivery row so the
--      operator can see the throttle in the admin feed.

ALTER TABLE webhook_endpoints ADD COLUMN rate_limit_per_minute INTEGER NOT NULL DEFAULT 60;

ALTER TABLE webhook_deliveries ADD COLUMN next_retry_at INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN last_attempted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_retry
  ON webhook_deliveries(next_retry_at)
  WHERE next_retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_dlq (
  id                   TEXT NOT NULL PRIMARY KEY,
  endpoint_id          TEXT NOT NULL,
  delivery_id          TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  attempts             INTEGER NOT NULL,
  last_status          INTEGER,
  last_error           TEXT,
  first_attempted_at   INTEGER NOT NULL,
  last_attempted_at    INTEGER NOT NULL,
  dropped_at           INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_endpoint   ON webhook_dlq(endpoint_id, dropped_at);
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_dropped_at ON webhook_dlq(dropped_at);
