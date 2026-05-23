-- Email warmup — gradual SMTP IP / domain warmup schedules. Operator
-- brings up a new sending IP or sending domain; this primitive caps
-- per-day send volume on a ramping schedule (Day 1: 50, Day 2: 100,
-- Day 3: 250, ...) to build sender reputation with mailbox providers
-- before high-volume traffic begins. Sibling primitives
-- (emailCampaigns, dunning) consult `canSend` before each batch so
-- the warmup gate is uniform across every sender of the new IP.
--
-- Two tables back the surface:
--
--   email_warmup_schedules    — one row per operator-defined warmup
--                               schedule, keyed by `slug`. Stores the
--                               full `daily_targets_json` ramp +
--                               `sender_domain` / `sender_ip` (IP is
--                               nullable; some operators warm a
--                               domain across a pooled IP range and
--                               only track the domain). `status` is
--                               the FSM (active → paused → active,
--                               or active/paused → archived); paused
--                               schedules return ok=false from
--                               canSend so the caller skips that
--                               sender entirely until the operator
--                               resumes. `status_check_threshold` is
--                               the per-day cap (basis points) on
--                               bounce + complaint rate above which
--                               the operator dashboard flags the
--                               schedule for review — the primitive
--                               surfaces the threshold through
--                               metricsForSchedule; the gate
--                               (auto-pause) is operator-policy and
--                               lives outside the primitive.
--
--   email_warmup_daily_sends  — per-(schedule, calendar-day) ledger
--                               of how many sends went out on that
--                               day. `canSend` reads this row to
--                               compute `sends_used_today`; record-
--                               Sends upserts (INSERT … ON CONFLICT
--                               for SQLite / D1). The `day_index` is
--                               the schedule-relative ordinal (Day 1,
--                               Day 2, …) computed from
--                               (occurred_date - start_date), kept
--                               alongside the ISO date so the metrics
--                               rollup can join cleanly.
--
-- Indexes:
--   * (status) on schedules — listSchedules({ active_only: true })
--     filters by status; the index keeps the active-set scan small
--     even when archived schedules accumulate.
--   * (schedule_slug, occurred_date) UNIQUE on daily_sends — the
--     write path uses ON CONFLICT to accumulate same-day sends; the
--     read path (canSend, metricsForSchedule) hits the row directly.

CREATE TABLE IF NOT EXISTS email_warmup_schedules (
  slug                      TEXT NOT NULL PRIMARY KEY,
  sender_domain             TEXT NOT NULL,
  sender_ip                 TEXT,
  start_date                TEXT NOT NULL,         -- ISO YYYY-MM-DD (UTC)
  daily_targets_json        TEXT NOT NULL,         -- JSON array of positive ints
  status_check_threshold    INTEGER NOT NULL,      -- basis points (0..10000)
  status                    TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  paused_reason             TEXT,
  paused_at                 INTEGER,
  archived_at               INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_warmup_schedules_status
  ON email_warmup_schedules(status);

CREATE TABLE IF NOT EXISTS email_warmup_daily_sends (
  id                  TEXT NOT NULL PRIMARY KEY,
  schedule_slug       TEXT NOT NULL,
  day_index           INTEGER NOT NULL,           -- 1-based schedule-relative day
  sends_count         INTEGER NOT NULL DEFAULT 0 CHECK (sends_count >= 0),
  bounce_count        INTEGER NOT NULL DEFAULT 0 CHECK (bounce_count >= 0),
  complaint_count     INTEGER NOT NULL DEFAULT 0 CHECK (complaint_count >= 0),
  occurred_date       TEXT NOT NULL,              -- ISO YYYY-MM-DD (UTC)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (schedule_slug, occurred_date)
);

CREATE INDEX IF NOT EXISTS idx_email_warmup_daily_sends_schedule_day
  ON email_warmup_daily_sends(schedule_slug, day_index);
