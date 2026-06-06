-- Per-recipient broadcast send ledger for email campaigns.
--
-- The 0087 schema gave campaigns an FSM (email_campaigns) and an
-- engagement event stream (email_campaign_events: delivered / opened /
-- clicked / bounced / unsubscribed, backfilled from the ESP webhook).
-- This table records the OUTBOUND send attempt itself — one row per
-- (campaign, recipient) the consent-gated broadcast actually walked.
--
-- Why a distinct table from email_campaign_events:
--
--   * It is the per-recipient dedupe key. The UNIQUE (campaign_slug,
--     email_hash) constraint means a campaign never sends the same
--     mailbox twice, and a resumed / re-run broadcast skips recipients
--     already attempted instead of re-mailing them.
--
--   * It records the CONSENT DECISION made at send time, not just a
--     delivered event. `outcome` distinguishes a real send from a
--     recipient skipped because they were no longer marketing-
--     consented (unsubscribed from the newsletter list) or were on the
--     marketing suppression list AT THE SEND MOMENT. A recipient who
--     unsubscribes after the broadcast starts lands as
--     `skipped_unsubscribed`, never `sent` — the compliance read can
--     show exactly who was reached and who was honored an opt-out.
--
--   * It carries the per-recipient failure so one bad address never
--     aborts the campaign: a mailer fault lands as `failed` with the
--     scrubbed reason, the broadcast continues, and the console rolls
--     the counts up.
--
-- email_hash is the SHA3-512 namespaced hash that keys
-- newsletter_signups / email_suppressions — the ledger stores no
-- plaintext PII. The deliverable plaintext address used for the send
-- is read transiently from newsletter_signups at send time and never
-- persisted here.

CREATE TABLE IF NOT EXISTS email_campaign_sends (
  id             TEXT    NOT NULL PRIMARY KEY,
  campaign_slug  TEXT    NOT NULL,
  email_hash     TEXT    NOT NULL,
  outcome        TEXT    NOT NULL CHECK (outcome IN ('sent', 'failed', 'skipped_unsubscribed', 'skipped_suppressed')),
  fail_reason    TEXT,
  attempted_at   INTEGER NOT NULL,
  UNIQUE (campaign_slug, email_hash)
);

-- The broadcast drain reads "have I already attempted this recipient?"
-- per page, and the console rolls counts up grouped by outcome — both
-- read this composite.
CREATE INDEX IF NOT EXISTS idx_email_campaign_sends_rollup
  ON email_campaign_sends(campaign_slug, outcome);
