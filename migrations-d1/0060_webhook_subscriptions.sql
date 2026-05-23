-- Webhook subscriptions — the registration layer for outbound webhook
-- delivery. Distinct from `webhook_endpoints` (the original webhooks
-- primitive's storage for operator-owned outbound receivers) — that
-- table predates the subscription model and is owned by a single tenant
-- (the operator). This table generalises the registration surface to
-- three owner classes:
--
--   operator  — the shop operator wiring a backend receiver for their
--               own observability pipeline.
--   app       — a third-party app installed through the framework's
--               app surface, registering on behalf of its developer.
--   customer  — a customer-scoped receiver (rare; reserved for
--               customer-portal use cases like "ship me a webhook when
--               my order ships").
--
-- The delivery primitive (`lib/webhooks.js`) iterates this table at
-- emit time to build the fan-out set; this primitive owns lifecycle
-- (subscribe / pause / resume / update / unsubscribe) plus the
-- signing-secret rotation FSM.
--
-- Signing secret storage — the plaintext secret is returned ONCE on
-- subscribe + rotate; at rest the framework keeps a SHA3-512 namespace
-- hash (`b.crypto.namespaceHash("webhook-signing-secret", secret)`).
-- During rotation, the previous secret's hash is preserved alongside
-- the new one for a 24h grace window so receivers verifying with the
-- old key don't see a hard cutover; after grace, the previous hash is
-- cleared on the next mutation that touches the row.
--
-- `event_types_json` is a JSON array (TEXT) of event-type strings the
-- subscription matches. The wildcard `*` is supported as a single-
-- element array (`["*"]`) meaning "all event types"; otherwise the
-- delivery primitive does a literal-equals match per emitted type.
-- The framework stores the JSON shape rather than CSV so future
-- patterns (glob, hierarchical) don't require a schema migration.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                              TEXT NOT NULL PRIMARY KEY,
  owner_type                      TEXT NOT NULL CHECK (owner_type IN (
    'operator', 'app', 'customer'
  )),
  owner_id                        TEXT NOT NULL,
  endpoint_url                    TEXT NOT NULL,
  event_types_json                TEXT NOT NULL,
  signing_secret_hash             TEXT NOT NULL,
  signing_secret_previous_hash    TEXT,
  signing_secret_rotated_at       INTEGER,
  name                            TEXT,
  active                          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  paused_at                       INTEGER,
  created_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_owner
  ON webhook_subscriptions(owner_type, owner_id, active);
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_active
  ON webhook_subscriptions(active);
