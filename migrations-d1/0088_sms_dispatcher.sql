-- SMS dispatcher — outbound SMS layer with per-country provider
-- routing, customer opt-in/opt-out state, and a delivery FSM with
-- transient-failure retries.
--
-- Three tables back the surface:
--
--   sms_providers     — operator-registered provider rows keyed by
--                       `slug` (Twilio / MessageBird / Plivo / ...).
--                       `regions_json` is the ordered list of ISO-3166
--                       alpha-2 country codes the provider serves;
--                       `providerForRegion(code)` returns the first
--                       active provider whose regions include `code`.
--                       Operators wire Twilio for US/CA, MessageBird
--                       for the EU, etc., without baking the routing
--                       table into application code.
--
--   sms_opt_state     — one row per (phone_hash, channel) tracking the
--                       latest consent state. `channel` is the consent
--                       channel: `marketing` / `transactional` /
--                       `verification`. `state` is `opt_in` or
--                       `opt_out`. The UNIQUE (phone_hash, channel)
--                       collapses repeated consent events onto one row
--                       (last write wins) so the `isOptedIn` lookup is
--                       a single indexed read.
--
--   sms_messages      — one row per outbound message. The status
--                       column is the FSM:
--                         queued → sent → delivered
--                                       ↘ failed (retry → queued, or
--                                                 terminal)
--                       Indexes back the dispatcher walk
--                       (`status='queued' AND schedule_at <= now`),
--                       the per-customer history surface, and the
--                       provider-side delivery-receipt lookup
--                       (`provider_slug, provider_ref`).
--
-- Schema decisions:
--   * Phone numbers never persist in plaintext. The primitive hashes
--     the normalised phone via b.crypto.namespaceHash("sms-phone", n)
--     at the write site; the column carries the 128-hex digest.
--   * `country_code` is the ISO-3166 alpha-2 the operator passed at
--     enqueue time. Stored uppercase. The provider routing reads this
--     column to pick the egress.
--   * `body` is the rendered SMS text. Operator-supplied — the
--     primitive refuses emoji-only / control-byte bodies at the write
--     site so a degenerate payload can't waste a provider segment.
--   * `provider_slug` is stamped at enqueue time (whichever provider
--     `providerForRegion` resolved). The dispatcher tick re-reads the
--     row and hands it to the operator-wired send hook; the hook
--     stamps `provider_ref` (Twilio SID / MessageBird ID / ...) via
--     markDelivered.
--   * Retry: `attempts` increments on every transient failure;
--     `next_retry_at` is the back-off deadline. `markFailed` with
--     `retry=true` re-queues; `retry=false` flips to terminal failed.
--   * `customer_id` is nullable — verification SMS can target a
--     pre-customer (sign-up flow) where the customer row doesn't exist
--     yet. `recipient_phone_hash` is always present.

CREATE TABLE IF NOT EXISTS sms_providers (
  slug          TEXT NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  regions_json  TEXT NOT NULL,
  endpoint_url  TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sms_providers_active
  ON sms_providers(active);

CREATE TABLE IF NOT EXISTS sms_opt_state (
  id              TEXT NOT NULL PRIMARY KEY,
  phone_hash      TEXT NOT NULL,
  customer_id     TEXT,
  channel         TEXT NOT NULL CHECK (channel IN ('marketing', 'transactional', 'verification')),
  state           TEXT NOT NULL CHECK (state IN ('opt_in', 'opt_out')),
  opt_in_text     TEXT,
  reason          TEXT,
  occurred_at     INTEGER NOT NULL,
  UNIQUE (phone_hash, channel)
);

CREATE INDEX IF NOT EXISTS idx_sms_opt_state_customer
  ON sms_opt_state(customer_id);

CREATE TABLE IF NOT EXISTS sms_messages (
  id                     TEXT NOT NULL PRIMARY KEY,
  recipient_phone_hash   TEXT NOT NULL,
  country_code           TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('transactional', 'marketing', 'verification')),
  body                   TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  provider_slug          TEXT,
  provider_ref           TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at          INTEGER,
  failure_reason         TEXT,
  schedule_at            INTEGER NOT NULL,
  sent_at                INTEGER,
  delivered_at           INTEGER,
  failed_at              INTEGER,
  customer_id            TEXT,
  created_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_due
  ON sms_messages(status, schedule_at);

CREATE INDEX IF NOT EXISTS idx_sms_messages_customer
  ON sms_messages(customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sms_messages_provider_ref
  ON sms_messages(provider_slug, provider_ref);

CREATE INDEX IF NOT EXISTS idx_sms_messages_phone
  ON sms_messages(recipient_phone_hash, created_at);
