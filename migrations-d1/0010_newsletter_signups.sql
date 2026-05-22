-- Newsletter signups — operator-collected emails for release-notes
-- broadcasts. The storefront footer + the newsletter band form both
-- POST to `/newsletter` which validates the email through
-- `b.guardEmail`, normalises it (lowercase + trim), and inserts a
-- row here.
--
-- Schema decisions:
--   * Dedupe is on `email_hash` (a namespaceHash of the normalised
--     address). The hash is `UNIQUE` so a repeat signup is an
--     idempotent no-op via `INSERT OR IGNORE`.
--   * `email_normalized` holds the canonical form an operator
--     needs to actually send a message. Storing it in plaintext is
--     a deliberate choice — the operator owns the encryption-at-
--     rest posture for marketing PII via D1's encrypted-at-rest
--     default (Cloudflare handles disk-level AEAD) plus their own
--     access controls. Operators that want application-layer AEAD
--     should wrap this primitive and seal the column via
--     `b.vault.seal`.
--   * `source` is operator-supplied ("storefront-footer",
--     "release-notes-page", etc.) so operators can attribute the
--     signup channel without a separate analytics table.
--   * `unsubscribed_at` is NULL until the user clicks an
--     unsubscribe link. The opt-out flow lands in a follow-up
--     patch; the column ships now so existing rows don't need a
--     schema rewrite when it does.

CREATE TABLE IF NOT EXISTS newsletter_signups (
  id               TEXT NOT NULL PRIMARY KEY,
  email_hash       TEXT NOT NULL UNIQUE,
  email_normalized TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'storefront-footer',
  created_at       INTEGER NOT NULL,
  unsubscribed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_newsletter_signups_created_at ON newsletter_signups(created_at);
CREATE INDEX IF NOT EXISTS idx_newsletter_signups_source     ON newsletter_signups(source);
