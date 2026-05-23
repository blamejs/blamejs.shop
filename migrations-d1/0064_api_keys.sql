-- API keys — operator-issued tokens for third-party access to admin
-- endpoints. Each key carries a scope allowlist + per-key rate limit
-- window. Plaintext is shown ONCE at issue time; only the hash lives
-- in storage (`b.crypto.namespaceHash("api-key-token", plaintext)`).
--
-- Two tables:
--
--   api_keys                — one row per key. `owner_type` distinguishes
--                             operator-issued keys from per-app /
--                             per-affiliate / per-tenant keys so a
--                             dashboard can group keys by the role the
--                             holder is authenticating as. `owner_id`
--                             is nullable so a global operator key can
--                             exist without a corresponding owner row.
--                             `scopes_json` is a JSON array of opaque
--                             scope strings the consumer enforces at
--                             the route layer; the primitive only
--                             validates shape (string, alphabet, length).
--                             `token_hash` is the live hash; on rotate
--                             the previous hash slides into
--                             `token_hash_previous` with a 24h grace
--                             so an in-flight caller can re-fetch
--                             without a hard outage. `status` is the
--                             lifecycle FSM:
--                               active   — issued + usable
--                               rotated  — superseded by a newer hash;
--                                          the row's previous hash is
--                                          still accepted until
--                                          rotated_at + 24h
--                               revoked  — terminal; verifyToken
--                                          refuses immediately
--                               expired  — terminal; either reached
--                                          expires_at or was swept by
--                                          cleanupExpired
--
--                             `last_used_at` is updated by
--                             `recordUse` so an operator dashboard can
--                             surface stale keys for retirement.
--
--   api_key_usage           — append-only usage log for audit + rate-
--                             limit accounting. The rate-limit window
--                             itself is a per-key budget (requests per
--                             minute); the route layer reads the log
--                             across the last 60s when deciding whether
--                             to admit a request.

CREATE TABLE IF NOT EXISTS api_keys (
  id                          TEXT NOT NULL PRIMARY KEY,
  owner_type                  TEXT NOT NULL CHECK (owner_type IN (
    'operator', 'app', 'affiliate', 'tenant'
  )),
  owner_id                    TEXT,
  name                        TEXT NOT NULL,
  scopes_json                 TEXT NOT NULL,
  token_hash                  TEXT NOT NULL UNIQUE,
  token_hash_previous         TEXT,
  rotated_at                  INTEGER,
  status                      TEXT NOT NULL CHECK (status IN (
    'active', 'rotated', 'revoked', 'expired'
  )),
  revoked_at                  INTEGER,
  revoke_reason               TEXT,
  rate_limit_per_minute       INTEGER NOT NULL CHECK (rate_limit_per_minute >= 0),
  last_used_at                INTEGER,
  expires_at                  INTEGER,
  created_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_status_expires
  ON api_keys(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_token_hash
  ON api_keys(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner
  ON api_keys(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS api_key_usage (
  id                          TEXT NOT NULL PRIMARY KEY,
  key_id                      TEXT NOT NULL,
  endpoint                    TEXT NOT NULL,
  occurred_at                 INTEGER NOT NULL,
  FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_occurred
  ON api_key_usage(key_id, occurred_at DESC);
