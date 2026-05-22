-- Newsletter unsubscribe tokens — single-use opaque bearers that
-- prove the holder of the email address asked to be removed from
-- the broadcast list. The operator generates one of these and emails
-- the plaintext token (embedded in the unsubscribe URL) to the
-- subscriber; the storefront unsubscribe endpoint consumes it.
--
-- Schema decisions:
--   * Stored row keys off `namespaceHash("newsletter-unsubscribe",
--     plaintext)` — the plaintext never lands in the database, so a
--     dump leaks neither the token nor the relationship to a
--     specific signup beyond what the link itself would.
--   * `consumed_at` is NULL until the token is exchanged; a second
--     attempt with the same plaintext refuses (single-use). Rows
--     stay around after consumption so audit / debugging can answer
--     "was this token already used?" without retaining the
--     plaintext.
--   * `expires_at` defaults to one year from issuance. Operators who
--     want a tighter window can roll their own issuance wrapper; the
--     primitive enforces the on-storage expiry on every consume.
--   * The (signup_id, consumed_at) index supports the operator-side
--     question "does this address have an outstanding unsubscribe
--     link?" without a full-table scan.

CREATE TABLE IF NOT EXISTS newsletter_unsubscribe_tokens (
  token_hash   TEXT    NOT NULL PRIMARY KEY,
  signup_id    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_newsletter_unsubscribe_tokens_signup
  ON newsletter_unsubscribe_tokens(signup_id, consumed_at);
