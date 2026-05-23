-- Business hours — operator-authored open/close windows per location
-- or tenant. The storefront, support-routing layer, and "we're closed"
-- banners read the schedule for a given slug to decide whether the
-- shop is open at a specific moment, when the next opening or closing
-- will be, and what the weekly rhythm looks like.
--
-- A schedule has three layered parts:
--
--   1. `weekly_hours_json` — base array of `{ day, open, close }`
--      entries (one per weekday the location is open). `day` is 0..6
--      with Sun=0; `open` / `close` are `HH:MM` 24-hour strings in the
--      schedule's IANA `timezone`. Days absent from the array are
--      closed by default. Multiple entries for the same day are
--      allowed (split shift — open mornings + evenings, closed for
--      siesta).
--
--   2. Holidays — full-day closures attached to a specific calendar
--      date (`date` = YYYY-MM-DD in the schedule's timezone). The
--      regular weekly_hours for that weekday are suppressed. Operator
--      authors recurring holidays once a year. `kind = 'holiday'`.
--
--   3. Exceptions — per-date overrides that change the open/close
--      times for a specific day without removing it (early-close for
--      a private event, late-open after maintenance, fully-closed
--      one-off). When `closed = 1` the day is treated as closed
--      regardless of the open/close columns; otherwise the open/close
--      columns REPLACE the weekly_hours for that date. `kind =
--      'exception'`.
--
-- The two row kinds share the `business_hour_exceptions` table because
-- the lookup path treats them identically — both suppress / replace
-- the weekly_hours for a single date. The `kind` column lets the
-- operator dashboard render holidays (annually-recurring closures,
-- "Christmas Day", "Independence Day") separately from one-off
-- exceptions ("staff training Tuesday afternoon").
--
-- `archived_at` is a one-way soft-delete stamp on the parent schedule.
-- Archived schedules drop out of `isOpenAt` / `nextOpenAt` /
-- `nextCloseAt` / `weekSummary` lookups; the row stays for audit.

CREATE TABLE IF NOT EXISTS business_hour_schedules (
  slug                        TEXT NOT NULL PRIMARY KEY,
  timezone                    TEXT NOT NULL,
  weekly_hours_json           TEXT NOT NULL,
  archived_at                 INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_business_hour_schedules_archived
  ON business_hour_schedules(archived_at);

-- Per-date overrides. `kind` distinguishes annually-authored holidays
-- ("kind = 'holiday'", typically carries a `name` like "Christmas Day")
-- from one-off exceptions ("kind = 'exception'", typically carries
-- adjusted open/close times or `closed = 1`).
--
-- `(schedule_slug, date)` is unique — one override per date per
-- schedule. Re-authoring the same date replaces the prior row via the
-- primitive's upsert path.
--
-- `open` and `close` are nullable: a holiday row sets both NULL +
-- `closed = 1`; an early-close exception sets `open = NULL` (inherit
-- from weekly_hours) + `close = '15:00'`; a delayed-open exception
-- sets `open = '11:00'` + `close = NULL` (inherit). When both columns
-- are non-null the exception fully replaces the weekly_hours window
-- for that date.

CREATE TABLE IF NOT EXISTS business_hour_exceptions (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_slug               TEXT NOT NULL
                                REFERENCES business_hour_schedules(slug)
                                ON DELETE CASCADE,
  date                        TEXT NOT NULL,
  open                        TEXT,
  close                       TEXT,
  closed                      INTEGER NOT NULL DEFAULT 0
                                CHECK (closed IN (0, 1)),
  kind                        TEXT NOT NULL
                                CHECK (kind IN ('holiday', 'exception')),
  name                        TEXT,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_hour_exceptions_slug_date
  ON business_hour_exceptions(schedule_slug, date);

CREATE INDEX IF NOT EXISTS idx_business_hour_exceptions_slug_kind
  ON business_hour_exceptions(schedule_slug, kind);
