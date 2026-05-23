-- Push notifications — outbound mobile + web push layer with per-
-- customer device-token registry, channel-scoped opt-in/opt-out
-- state, and a delivery FSM with transient-failure retries.
--
-- Four tables back the surface:
--
--   push_providers       — operator-registered provider rows keyed by
--                          `slug` (one per egress: APNs for iOS, FCM
--                          for Android, web-push for VAPID). `kind`
--                          is the transport class — `apns` / `fcm` /
--                          `web_push`. `credentials_hash` is the
--                          128-hex SHA3-512 digest of the operator's
--                          credentials material (APNs auth key /
--                          FCM service-account JSON / VAPID private
--                          key); `credentials_normalised` is the
--                          canonicalised form the operator's send
--                          hook reads at dispatch time. The raw
--                          credential never persists in plaintext —
--                          the normalisation step is the only place
--                          the operator's send hook can recover the
--                          shape it needs.
--
--   push_devices         — one row per (customer, provider, device-
--                          token). `device_token_hash` is the 128-hex
--                          SHA3-512 namespaceHash digest; the column
--                          carries a UNIQUE so a token can't be
--                          registered twice (operators handing the
--                          same token to two customer rows surfaces
--                          loudly instead of silently splitting the
--                          push fan-out). `device_class` is the
--                          surface class — `ios` / `android` / `web`
--                          / `desktop`. `revoked_at` is the soft-
--                          delete timestamp; once a device is
--                          revoked it's invisible to enqueue.
--
--   push_opt_state       — one row per (customer, channel) tracking
--                          the latest consent state. `channel` is
--                          the consent channel: `marketing` /
--                          `transactional` / `alert`. `state` is
--                          `opt_in` or `opt_out`. The UNIQUE
--                          (customer_id, channel) collapses repeated
--                          consent events onto one row (last write
--                          wins).
--
--   push_notifications   — one row per enqueued notification. The
--                          status column is the FSM:
--                            queued → sent → delivered
--                                          ↘ failed (retry → queued,
--                                                    or terminal)
--                          `payload_json` is the operator-authored
--                          structured payload that the operator's
--                          send hook serialises into the provider-
--                          specific wire format (APNs aps dict, FCM
--                          message body, web-push JSON). Indexes back
--                          the dispatcher walk (`status='queued' AND
--                          schedule_at <= now`), the per-customer
--                          history surface, and the provider-side
--                          delivery-receipt lookup
--                          (`provider_message_id`).
--
-- Schema decisions:
--   * Device tokens never persist in plaintext. The primitive hashes
--     the operator-supplied token via b.crypto.namespaceHash(
--     "push-device-token", t) at the write site; the column carries
--     the 128-hex digest. `device_token_normalised` is the canonical
--     form (trimmed, no zero-width bytes) — what the operator's send
--     hook reads when constructing the provider call. Operators that
--     want the original token store it separately at their layer; the
--     primitive treats the registered token as opaque material.
--   * `provider_slug` on push_devices is nullable-FK-style — the
--     value matches a push_providers.slug at registration time but
--     no FK is enforced (operators may register devices ahead of
--     wiring the provider). `provider_message_id` on
--     push_notifications is the provider-side identifier returned by
--     the operator's send hook (APNs apns-id header / FCM message
--     name / web-push 201 response Location).
--   * Retry: `attempts` increments on every transient failure;
--     `next_retry_at` is the back-off deadline. `markFailed` with
--     `retry=true` re-queues; `retry=false` flips to terminal failed.
--   * `archived_at` on providers is a soft-delete column (operators
--     rotate providers without rewriting historical metrics rows).

CREATE TABLE IF NOT EXISTS push_providers (
  slug                     TEXT NOT NULL PRIMARY KEY,
  kind                     TEXT NOT NULL CHECK (kind IN ('apns', 'fcm', 'web_push')),
  credentials_hash         TEXT NOT NULL,
  credentials_normalised   TEXT NOT NULL,
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_providers_active
  ON push_providers(active, archived_at);

CREATE INDEX IF NOT EXISTS idx_push_providers_kind
  ON push_providers(kind);

CREATE TABLE IF NOT EXISTS push_devices (
  id                       TEXT NOT NULL PRIMARY KEY,
  customer_id              TEXT NOT NULL,
  provider_slug            TEXT NOT NULL,
  device_token_hash        TEXT NOT NULL UNIQUE,
  device_token_normalised  TEXT NOT NULL,
  device_class             TEXT NOT NULL CHECK (device_class IN ('ios', 'android', 'web', 'desktop')),
  locale                   TEXT,
  revoked_at               INTEGER,
  revoke_reason            TEXT,
  last_seen_at             INTEGER NOT NULL,
  created_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_devices_customer
  ON push_devices(customer_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_push_devices_provider
  ON push_devices(provider_slug, revoked_at);

CREATE TABLE IF NOT EXISTS push_opt_state (
  id             TEXT NOT NULL PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('marketing', 'transactional', 'alert')),
  state          TEXT NOT NULL CHECK (state IN ('opt_in', 'opt_out')),
  reason         TEXT,
  occurred_at    INTEGER NOT NULL,
  UNIQUE (customer_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_push_opt_state_customer
  ON push_opt_state(customer_id);

CREATE TABLE IF NOT EXISTS push_notifications (
  id                     TEXT NOT NULL PRIMARY KEY,
  recipient_customer_id  TEXT NOT NULL,
  channel                TEXT NOT NULL CHECK (channel IN ('marketing', 'transactional', 'alert')),
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  payload_json           TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  provider_slug          TEXT,
  provider_message_id    TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at          INTEGER,
  fail_reason            TEXT,
  schedule_at            INTEGER NOT NULL,
  dispatched_at          INTEGER,
  delivered_at           INTEGER,
  failed_at              INTEGER,
  created_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_due
  ON push_notifications(status, schedule_at);

CREATE INDEX IF NOT EXISTS idx_push_notifications_customer
  ON push_notifications(recipient_customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_push_notifications_provider_msg
  ON push_notifications(provider_slug, provider_message_id);

CREATE INDEX IF NOT EXISTS idx_push_notifications_channel
  ON push_notifications(channel, created_at);
