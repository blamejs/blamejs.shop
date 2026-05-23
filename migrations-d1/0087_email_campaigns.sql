-- Email campaigns — operator-scheduled bulk marketing sends. Sits
-- one layer above the transactional `email` primitive: where `email`
-- composes a single per-recipient send (order receipt, ship
-- notification, refund), this primitive owns the operator-defined
-- broadcast — a single message body, an audience slug resolved
-- through `mailing_audiences`, a schedule_at the dispatcher walks
-- on a cron tick, and a per-event ledger (delivered / opened /
-- clicked / bounced / unsubscribed) the dashboard rolls up into
-- engagement rates.
--
-- Two tables back the surface:
--
--   email_campaigns       — one row per defined campaign, keyed by
--                           operator-chosen `slug`. `status` is the
--                           FSM (draft → scheduled → sending → sent;
--                           paused / cancelled as off-ramps).
--                           `recipients_resolved_count` + `sent_count`
--                           are stamped when the dispatcher resolves
--                           the audience + drains the per-recipient
--                           sends. `from_address` / `from_name` /
--                           `reply_to` are per-campaign sender
--                           identity (operators run sales / support /
--                           release-notes campaigns out of distinct
--                           addresses).
--
--   email_campaign_events — append-only per-recipient delivery
--                           lifecycle. The dispatcher records
--                           `delivered` after each send; the operator
--                           wires `recordEvent` to the ESP webhook to
--                           backfill `opened` / `clicked` / `bounced`
--                           / `unsubscribed`. `metricsForCampaign`
--                           aggregates by event_type to produce the
--                           per-campaign rates the dashboard renders.
--
-- Indexes:
--   * (status, schedule_at) on campaigns — the scheduler walks
--     `WHERE status='scheduled' AND schedule_at <= now` every tick.
--   * (campaign_slug, event_type, occurred_at) on events — the
--     metrics rollup + per-campaign timeline read this composite to
--     avoid a full-table scan on a multi-million-event ledger.
--
-- recipient_hash is the foreign-key onto `mailing_audiences` /
-- `newsletter_signups.email_hash` — already a SHA3-512 namespaced
-- hash, so the ledger never stores plaintext PII alongside the
-- event stream.

CREATE TABLE IF NOT EXISTS email_campaigns (
  slug                       TEXT NOT NULL PRIMARY KEY,
  subject                    TEXT NOT NULL,
  body_html                  TEXT NOT NULL,
  body_text                  TEXT NOT NULL,
  audience_slug              TEXT NOT NULL,
  schedule_at                INTEGER,
  from_address               TEXT NOT NULL,
  from_name                  TEXT NOT NULL,
  reply_to                   TEXT,
  status                     TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled')),
  recipients_resolved_count  INTEGER,
  sent_count                 INTEGER,
  sent_at                    INTEGER,
  paused_at                  INTEGER,
  cancelled_at               INTEGER,
  cancel_reason              TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_campaigns_status_schedule
  ON email_campaigns(status, schedule_at);

CREATE TABLE IF NOT EXISTS email_campaign_events (
  id              TEXT NOT NULL PRIMARY KEY,
  campaign_slug   TEXT NOT NULL,
  recipient_hash  TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN ('delivered', 'opened', 'clicked', 'bounced', 'unsubscribed')),
  occurred_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_campaign_events_rollup
  ON email_campaign_events(campaign_slug, event_type, occurred_at);
