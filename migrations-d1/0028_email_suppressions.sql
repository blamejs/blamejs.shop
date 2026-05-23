-- Email suppression list — opt-out / hard-bounce / complaint / operator-
-- manual gating for every outbound mail the storefront sends.
--
-- The storefront sends transactional mail (order receipt, ship
-- notification, refund) and marketing mail (newsletter, wishlist-
-- discount, abandoned-cart, review-request). Every sender consults this
-- table before composing the message so an address that bounced
-- permanently, filed a complaint with its ISP, or that the operator
-- manually shut off never sees another delivery attempt.
--
-- Schema decisions:
--   * Primary key is `email_hash` — a `b.crypto.namespaceHash(
--     "email-suppression", normalised_email)` digest. A re-occurrence
--     of the same address (a second hard-bounce, a repeat complaint,
--     a second feedback-loop event) collapses onto the same row via
--     `INSERT OR REPLACE` semantics in the primitive, bumping
--     `occurrences` + `last_seen_at` rather than minting a duplicate.
--   * `email_normalized` holds the lowercased + trimmed plaintext so
--     an operator triaging a support ticket can match a customer's
--     "why didn't I get my receipt?" against the row. Storing it is a
--     deliberate operator-PII choice; D1's at-rest AEAD covers the
--     disk layer, and operators authoring application-layer AEAD wrap
--     this primitive via `b.vault.seal`. The raw input (untrimmed,
--     mixed case, with surrounding whitespace) never persists.
--   * `suppression_type` is the operator-debuggable cause:
--       `unsubscribe`      — user clicked the operator-opt-out link
--                            (newsletter unsubscribe is a separate
--                            primitive; this is the broader "stop
--                            sending me anything" gate).
--       `hard-bounce`      — delivery permanently failed (mailbox
--                            does not exist, domain MX refuses).
--       `soft-bounce`      — transient delivery failure (mailbox
--                            full, greylist, temporary DNS). Pairs
--                            with `expires_at` so the suppression
--                            self-clears after the operator-configured
--                            window (typically 24h).
--       `complaint`        — ISP feedback-loop report (Gmail "Report
--                            spam", Outlook "Junk", AOL FBL, etc.).
--       `operator-manual`  — operator suppressed the address from the
--                            admin dashboard (refund-and-block flow,
--                            VIP block, abuse triage).
--       `rate-limit-block` — outbound rate-limiter tripped on this
--                            address (loop guard against runaway
--                            triggers).
--   * `scope` controls which sends the suppression blocks:
--       `'all'`            — every outbound mail.
--       `'marketing'`      — newsletter / wishlist-discount /
--                            abandoned-cart / review-request. The
--                            default for `unsubscribe` because an
--                            operator-opt-out is usually about
--                            marketing volume, not transactional
--                            receipts.
--       `'transactional'`  — order receipt / ship notification /
--                            refund. The default for `hard-bounce` and
--                            `complaint` because a bounce or
--                            complaint is rarely an opt-out of the
--                            entire relationship — the operator
--                            decides not to retry deliveries that
--                            permanently failed.
--   * `reason` is a free-form operator note or the bounce-message
--     detail the upstream ESP returned. Empty string by default so
--     `INSERT OR REPLACE` stays single-shape.
--   * `source` is the system that flagged the address (`sendgrid`,
--     `ses`, `mailgun`, `manual`, etc.). Empty string default for the
--     same reason.
--   * `first_seen_at` is sticky across re-occurrences; `last_seen_at`
--     updates on every re-occurrence. `occurrences` counts how many
--     times the same suppression event landed for this address — a
--     value > 1 on a fresh `hard-bounce` is a sign the operator's
--     send pipeline isn't honoring the suppression list yet.
--   * `expires_at` is NULL for permanent suppressions (every type
--     except `soft-bounce` and `rate-limit-block`). Expired rows stay
--     in storage until `cleanupExpired` sweeps them — the primitive's
--     `isSuppressed` view filters them out, so an expired row blocks
--     nothing in the meantime.

CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash      TEXT NOT NULL PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  suppression_type TEXT NOT NULL CHECK (suppression_type IN ('unsubscribe','hard-bounce','soft-bounce','complaint','operator-manual','rate-limit-block')),
  scope           TEXT NOT NULL CHECK (scope IN ('transactional','marketing','all')),
  reason          TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT '',
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  expires_at      INTEGER,
  occurrences     INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0)
);

CREATE INDEX IF NOT EXISTS idx_email_suppressions_type  ON email_suppressions(suppression_type, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_scope ON email_suppressions(scope, expires_at);
