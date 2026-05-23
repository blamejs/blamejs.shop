-- Email engagement score — per-customer 0..100 score derived from open
-- / click / unsubscribe / spam-complaint events.
--
-- Two tables. The first is an append-only log of engagement events for
-- a customer's email correspondence; the second is the denormalized
-- per-customer summary that callers read on the hot path (the
-- segmentation dashboard, the abandoned-cart guard, the "should we
-- send to this address?" gate).
--
-- `email_engagement_events` — one row per observed event. `event_type`
-- is a CHECK enum covering the six signals the score consumes:
--   opened                — recipient opened a delivered message
--   clicked               — recipient clicked a link inside one
--   unsubscribed          — recipient hit the one-click unsubscribe
--                           header (RFC 8058) or footer link
--   spam_reported         — mailbox provider's feedback loop reported
--                           the customer hit "report spam"
--   bounced               — provider rejected delivery (hard or soft)
--   not_opened_in_window  — a send landed but no open was observed in
--                           the configured staleness window (the
--                           operator records these via a cron pass so
--                           the score decays as the customer goes
--                           dark, not just when negative signals
--                           arrive)
-- The id is a UUIDv7 so the log is lexicographically + monotonically
-- sortable in the natural index order. `occurred_at` is epoch-ms so
-- the recompute pass can do simple integer arithmetic against the
-- staleness window. Indexes cover the two read shapes the primitive
-- exercises: per-customer history reads in reverse-chronological
-- order, and the recompute pass that walks every customer with at
-- least one event in a recent window.
--
-- `email_engagement_scores` — one row per customer. `score` is the
-- 0..100 integer; `band` is a CHECK enum derived from `score` so the
-- dashboard can filter by band without recomputing the bucketization
-- on the read path. `last_opened_at` / `last_clicked_at` are nullable
-- (a customer who has only ever bounced has neither). `send_count`
-- / `open_count` / `click_count` are running counters that
-- `recompute()` re-derives from the event log so the engagement
-- panel can render open_rate / click_rate without a per-render
-- aggregate query. `computed_at` is the last recompute timestamp —
-- `recomputeAll({ since })` walks every customer whose `computed_at`
-- is older than the cutoff OR who has a fresh event since the cutoff.
--
-- Indexes:
--   * `(customer_id, occurred_at DESC)` — historyForCustomer pulls the
--     timeline newest-first.
--   * `(occurred_at)` — recomputeAll picks up customers with fresh
--     events since the cutoff without scanning the full log.
--   * `(band, score DESC)` — `unengagedCustomers({ band_max })`
--     surfaces the segment under a chosen band cap, ordered by score
--     ascending (the lowest-engagement customers float first when the
--     operator filters by `band_max = 'unengaged'`).

CREATE TABLE IF NOT EXISTS email_engagement_events (
  id           TEXT NOT NULL PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN (
                 'opened', 'clicked', 'unsubscribed',
                 'spam_reported', 'bounced', 'not_opened_in_window'
               )),
  occurred_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_engagement_scores (
  customer_id      TEXT NOT NULL PRIMARY KEY,
  score            INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  band             TEXT NOT NULL CHECK (band IN (
                     'highly_engaged', 'engaged', 'lapsed', 'unengaged'
                   )),
  last_opened_at   INTEGER,
  last_clicked_at  INTEGER,
  send_count       INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  open_count       INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  click_count      INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  computed_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_engagement_events_customer_occurred
  ON email_engagement_events(customer_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_engagement_events_occurred
  ON email_engagement_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_email_engagement_scores_band_score
  ON email_engagement_scores(band, score);
