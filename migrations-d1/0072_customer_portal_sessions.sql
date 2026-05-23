-- Customer portal sessions — single-use signed bearers that let a
-- customer reach the framework's OWN self-serve portal (addresses,
-- payment methods, subscriptions, open orders).
--
-- This is NOT a Stripe Customer Portal link — the framework hosts the
-- portal page itself. The mint flow goes:
--
--   1. Customer requests a portal link from the storefront (typically
--      via an "email me a link" flow keyed off a verified address or a
--      newly-completed login challenge).
--   2. The primitive mints a 32-byte base64url plaintext token, hashes
--      it with `namespaceHash("customer-portal-token", plaintext)`, and
--      writes the hash to this table alongside the scope, ttl, and
--      whatever per-request fingerprints the caller supplies
--      (`ip_hash`, `ua_class`).
--   3. The plaintext lands in the customer's inbox / device once. The
--      database NEVER stores the plaintext — a dump only ever leaks
--      the hash, the scope, and the audit trail.
--   4. When the customer follows the link, the portal endpoint calls
--      `verifyToken(plaintext)` which:
--        * Re-hashes the plaintext via `namespaceHash`.
--        * Looks up the row by the hash (primary-key index).
--        * `timingSafeEqual`s the stored hash against the recomputed
--          one (belt-and-braces — the PK index is already a hash hit,
--          but the constant-time compare keeps the latency profile
--          identical between hit and miss paths).
--        * Refuses when status !== 'issued' OR expires_at <= now.
--        * On success, flips status → 'consumed', stamps consumed_at,
--          and returns the scope + customer_id + session id.
--      Single-use — re-presenting the same plaintext after the flip
--      misses on the status gate.
--
-- Schema decisions:
--   * `token_hash` is the primary key — the lookup happens off the
--     hash, never the plaintext. UNIQUE is redundant but kept explicit
--     so a future migration that swaps the PK still preserves it.
--   * `scope` is a CHECK enum (5 values). The portal endpoint reads
--     the scope to decide which tab to render and which mutations to
--     allow — a `billing_only` token can update payment methods but
--     cannot edit addresses or cancel subscriptions, etc.
--   * `status` is the FSM column. Four terminal states:
--       issued    — fresh, redeemable, not yet expired
--       consumed  — verifyToken succeeded and flipped the row
--       expired   — the operator-scheduler `expireOlderThan` walk
--                   stamped this; lazy gate. Operators who never run
--                   the scheduler see issued rows past their ttl and
--                   rely on the `expires_at` runtime check in
--                   verifyToken — the status column is the durable
--                   record for audit, not the live gate.
--       revoked   — operator-initiated kill via `revokeSession`.
--   * `consumed_at` / `revoked_at` are nullable timestamps that record
--     when the FSM transition fired; `revoke_reason` is a free-form
--     short string the operator supplies ("password-reset",
--     "session-stolen", "operator-eject"). Refused at length > 64.
--   * `ip_hash` and `ua_class` are optional per-issuance fingerprints.
--     `ip_hash` is the caller's hashed IP (the primitive does NOT do
--     the hashing — the caller passes an already-hashed value so the
--     primitive stays orthogonal to the operator's PII policy).
--     `ua_class` is a short UA classifier ("mobile-safari",
--     "desktop-firefox", "bot-suspected") for analytics.
--   * Two indexes:
--       (customer_id, created_at desc) — supports `listForCustomer`
--           pagination by issuance time without a full-table scan.
--       (status, expires_at)           — supports the operator
--           scheduler walk `expireOlderThan(seconds)` and ad-hoc
--           "show me every live issued token" queries.
--
-- Companion considerations:
--   * The primitive enforces single-use server-side. A customer who
--     bookmarks the portal URL after their first visit hits the
--     `already-consumed` branch on the second hit; the portal handler
--     surfaces a friendly "request a fresh link" page. The portal
--     itself runs against a SEPARATE session cookie minted on
--     consumption (out of scope for this migration).

CREATE TABLE IF NOT EXISTS customer_portal_sessions (
  id              TEXT    NOT NULL PRIMARY KEY,
  customer_id     TEXT    NOT NULL,
  token_hash      TEXT    NOT NULL UNIQUE,
  scope           TEXT    NOT NULL CHECK (scope IN (
                    'full',
                    'billing_only',
                    'address_only',
                    'subscriptions_only',
                    'order_history_only'
                  )),
  status          TEXT    NOT NULL CHECK (status IN (
                    'issued',
                    'consumed',
                    'expired',
                    'revoked'
                  )),
  consumed_at     INTEGER,
  revoked_at      INTEGER,
  revoke_reason   TEXT,
  ip_hash         TEXT,
  ua_class        TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_portal_sessions_customer
  ON customer_portal_sessions(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_portal_sessions_status_expiry
  ON customer_portal_sessions(status, expires_at);
