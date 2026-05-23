-- Pixel events — server-side conversion-tracking pixel/event API
-- integration. Operators wire one provider row per ad platform (Meta
-- CAPI, Google Enhanced Conversions, TikTok Events API, Pinterest CAPI,
-- Snap CAPI). The primitive queues each conversion event (purchase,
-- add-to-cart, view-content, ...) and the operator's worker dispatches
-- the queued rows out to each platform's HTTPS conversion endpoint.
--
-- Two tables back the surface:
--
--   pixel_providers  — operator-registered provider rows keyed by
--                      `slug`. `provider` is the platform enum (the
--                      five major ad networks that support a
--                      server-side Conversions API). `pixel_id` is
--                      the platform's pixel / dataset / pixel-tag
--                      identifier (Meta `pixel_id`, Google `conversion
--                      action`, TikTok `pixel_code`, Pinterest `ad
--                      account id`, Snap `pixel_id`). `access_token`
--                      is the operator's API credential — the column
--                      stores a SHA-256 hash of the access token (so
--                      a database dump can't be replayed) alongside
--                      the normalised plaintext kept ONLY for the
--                      dispatcher's HTTP request (each platform's
--                      egress requires the bearer in plain). Operators
--                      that need a stricter posture point
--                      `access_token_normalized` at a secret-manager
--                      reference and resolve at dispatch time.
--                      `conversion_url` is the platform's HTTPS
--                      conversion endpoint (Meta:
--                      graph.facebook.com/.../events; Google: the
--                      Enhanced Conversions REST URL; etc.).
--                      `active` gates dispatch — operators flip a
--                      provider off without deleting the row so the
--                      historical event ledger keeps its FK target.
--                      `archived_at` marks a soft-deleted provider.
--
--   pixel_events     — append-only ledger of every conversion event
--                      the operator's storefront recorded.
--                      `event_name` is the platform-vocabulary event
--                      (the six conversion-tracking shapes that
--                      every supported provider models — purchase,
--                      add_to_cart, view_content, lead,
--                      complete_registration, search). `event_id` is
--                      the operator's deterministic dedup token; the
--                      UNIQUE (provider_slug, event_id) constraint
--                      collapses retried inserts onto one row so a
--                      flaky network retry doesn't double-bill the
--                      ad platform. PII columns
--                      (`customer_email_sha256`, `customer_phone_sha256`,
--                      `ip_hash`) are nullable AND already hashed at
--                      the write site — the primitive computes the
--                      SHA-256 of the normalised email/phone before
--                      persist so a DB dump can't be replayed against
--                      the platform's identity-matching surface.
--                      `value_minor` + `currency` model the monetary
--                      value (purchases / leads). `event_source_url`
--                      is the storefront page that captured the
--                      event. `status` is the dispatch FSM:
--                      queued → dispatched (success) or queued →
--                      failed (terminal). `attempts` increments on
--                      every dispatch attempt; the operator's worker
--                      decides retry vs terminal via `markFailed
--                      ({ retry })`.
--
-- Indexes:
--   * (active) on providers — dispatchTick filters active providers
--     before scanning queued events.
--   * (status, occurred_at) on events — dispatchTick's primary scan
--     is "queued events ordered by occurred_at".
--   * (order_id) on events — eventsForOrder(order_id) lookup.
--   * (provider_slug, status, dispatched_at) on events — metrics-for-
--     provider rollup + dispatchedInPeriod range read.

CREATE TABLE IF NOT EXISTS pixel_providers (
  slug                       TEXT NOT NULL PRIMARY KEY,
  provider                   TEXT NOT NULL CHECK (provider IN (
                                'meta_capi', 'google_ec', 'tiktok_events',
                                'pinterest_capi', 'snap_capi'
                             )),
  pixel_id                   TEXT NOT NULL,
  access_token_hash          TEXT NOT NULL,
  access_token_normalized    TEXT NOT NULL,
  conversion_url             TEXT NOT NULL,
  active                     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at                INTEGER,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pixel_providers_active
  ON pixel_providers(active);

CREATE TABLE IF NOT EXISTS pixel_events (
  id                         TEXT NOT NULL PRIMARY KEY,
  provider_slug              TEXT NOT NULL,
  event_name                 TEXT NOT NULL CHECK (event_name IN (
                                'purchase', 'add_to_cart', 'view_content',
                                'lead', 'complete_registration', 'search'
                             )),
  event_id                   TEXT NOT NULL,
  occurred_at                INTEGER NOT NULL,
  customer_email_sha256      TEXT,
  customer_phone_sha256      TEXT,
  customer_id                TEXT,
  order_id                   TEXT,
  value_minor                INTEGER,
  currency                   TEXT,
  event_source_url           TEXT NOT NULL,
  ua_class                   TEXT,
  ip_hash                    TEXT,
  status                     TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'failed')),
  attempts                   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatched_at              INTEGER,
  response_status            INTEGER,
  response_body              TEXT,
  last_failure               TEXT,
  created_at                 INTEGER NOT NULL,
  UNIQUE (provider_slug, event_id)
);

CREATE INDEX IF NOT EXISTS idx_pixel_events_due
  ON pixel_events(status, occurred_at);

CREATE INDEX IF NOT EXISTS idx_pixel_events_order
  ON pixel_events(order_id);

CREATE INDEX IF NOT EXISTS idx_pixel_events_provider_status_dispatched
  ON pixel_events(provider_slug, status, dispatched_at);
