-- Webhook receiver — inbound webhook acceptor for operators receiving
-- signed events from third-party platforms (Stripe, GitHub, Slack,
-- BigCommerce, Square, etc.). The operator registers an endpoint slug
-- and a signing secret; this primitive verifies the HMAC-SHA-256
-- signature, dedupes by idempotency_key, and persists the raw body
-- for the operator's downstream processor.
--
-- Distinct from `webhooks` (which DELIVERS outbound events to operator-
-- registered endpoints) and `webhook_subscriptions` (which MANAGES
-- delivery subscriptions). Receiver is the inbound side.
--
-- Schema decisions:
--   * `webhook_sources.slug` is the operator-chosen URL component
--     (`/webhooks/<slug>`). Stable across secret rotations so the
--     third-party doesn't have to reconfigure their endpoint URL.
--   * `signing_secret_hash` stores the namespaceHash of the plaintext
--     secret. Plaintext is returned exactly once at defineSource +
--     rotateSecret; subsequent reads see only the hash.
--   * `signing_secret_previous_hash` + `signing_secret_rotated_at`
--     carry the 24h rotation grace — verifyAndPersist accepts a
--     signature computed under either the live or previous secret
--     while the third-party redeploys the new secret.
--   * `replay_window_seconds` is the per-source tolerance for the
--     `timestamp` header. Default 300s (5 min) matches Stripe; the
--     operator narrows it for high-frequency platforms.
--   * `max_body_bytes` caps the inbound payload size — a webhook
--     posting 10 MB of JSON is almost certainly a misbehaving peer or
--     an outright DoS attempt. Default 1 MiB.
--   * `signature_header_name` + `timestamp_header_name` let the
--     operator name the inbound headers per their third-party. E.g.
--     GitHub: `X-Hub-Signature-256` + (no separate ts header — that
--     platform inlines the ts in the signature). Stripe:
--     `Stripe-Signature` carries both. The operator wires the route
--     layer to extract the right header values before calling the
--     primitive.
--   * `active` toggles acceptance. When false, verifyAndPersist refuses
--     every inbound event for the source. `archived_at` is the
--     terminal off-switch — set once the operator decommissions the
--     source; the row stays for historical event-trail lookups.
--
-- Received events:
--   * `id` is a UUID v7 — keyset-paginates naturally in time order.
--   * `idempotency_key` is the third-party's per-event id (Stripe
--     event id, GitHub delivery id, etc.). UNIQUE(source_slug,
--     idempotency_key) so a replayed delivery deduplicates rather than
--     piling up extra rows.
--   * `body_sha3_512` is the SHA3-512 fingerprint of the raw body.
--     Operators verifying an audit trail against the third-party's
--     console paste-compare this digest.
--   * `body_size` is the raw byte length — useful for storage planning
--     and for the dashboard's "largest payloads this week" view.
--   * `status` is the receive-FSM: `received` → `processed` / `failed`.
--     `received` is the initial state on verify+persist. `processed`
--     is terminal-success (markProcessed). `failed` is terminal-or-
--     retryable (markFailed) — retryable carries `retry=true` so the
--     operator's scheduler can re-attempt downstream processing.
--   * `outcome` carries an opaque operator-supplied string on
--     markProcessed (`"order-created"`, `"customer-updated"`, etc.).
--   * `processed_at` / `failed_at` / `fail_reason` capture the FSM
--     transitions; NULL until the corresponding mark* fires.

CREATE TABLE IF NOT EXISTS webhook_sources (
  slug                          TEXT NOT NULL PRIMARY KEY,
  signing_secret_hash           TEXT NOT NULL,
  signing_secret_previous_hash  TEXT,
  signing_secret_rotated_at     INTEGER,
  replay_window_seconds         INTEGER NOT NULL,
  max_body_bytes                INTEGER NOT NULL,
  signature_header_name         TEXT NOT NULL,
  timestamp_header_name         TEXT NOT NULL,
  active                        INTEGER NOT NULL CHECK (active IN (0, 1)),
  archived_at                   INTEGER,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_sources_active ON webhook_sources(active, slug);

CREATE TABLE IF NOT EXISTS webhook_received_events (
  id               TEXT NOT NULL PRIMARY KEY,
  source_slug      TEXT NOT NULL,
  idempotency_key  TEXT,
  body_sha3_512    TEXT NOT NULL,
  body_size        INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('received','processed','failed')),
  outcome          TEXT,
  received_at      INTEGER NOT NULL,
  processed_at     INTEGER,
  failed_at        INTEGER,
  fail_reason      TEXT,
  FOREIGN KEY (source_slug) REFERENCES webhook_sources(slug)
);

-- Idempotency dedupe. NULL idempotency_keys do not collide (SQLite
-- treats NULL as distinct under UNIQUE) — the operator's third-party
-- either always supplies one or never does; mixed sources surface as
-- separate rows by design.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_received_events_idem
  ON webhook_received_events(source_slug, idempotency_key);

-- Per-source feed in time order. The dashboard's "events for source X"
-- view reads via this index.
CREATE INDEX IF NOT EXISTS idx_webhook_received_events_source_time
  ON webhook_received_events(source_slug, received_at DESC, id DESC);

-- Unprocessed-events queue: the downstream worker SELECTs `received`
-- rows and processes them. Partial index on status keeps the queue
-- index small as the row count grows into the millions.
CREATE INDEX IF NOT EXISTS idx_webhook_received_events_status_time
  ON webhook_received_events(status, received_at);

-- Retention sweeps: DELETE FROM webhook_received_events WHERE received_at < ?
CREATE INDEX IF NOT EXISTS idx_webhook_received_events_received_at
  ON webhook_received_events(received_at);
