-- Wishlist digest — periodic email summaries of a customer's wishlist
-- with stock changes and price drops over the period since the last
-- send. Distinct from `wishlistAlerts` (event-driven "this single SKU
-- just dropped 20%"); the digest is a rollup the operator authors as a
-- weekly or monthly cadence and customers opt into per-cadence.
--
-- Three tables, slug-keyed primary table:
--
--   wishlist_digest_schedules
--     One row per operator-defined cadence. `slug` is the PK. `frequency`
--     is the CHECK enum (weekly / monthly). `day_of_week` is 0..6 with
--     Sun = 0 when frequency = weekly; NULL otherwise. `day_of_month` is
--     1..28 when frequency = monthly (capped at 28 so February doesn't
--     skip the send in non-leap years); NULL otherwise. `time_local` is
--     HH:MM in the schedule's IANA `timezone`; the dispatcher resolves
--     each enrollment's `next_dispatch_at` against this pair via
--     `Intl.DateTimeFormat`. `archived_at` soft-retires the schedule —
--     existing enrollments still fire until they hit a terminal state,
--     new enrollments refuse.
--
--   wishlist_digest_enrollments
--     One row per (customer_id, schedule_slug) opt-in. `status` is the
--     FSM-bounded enum (active / paused / cancelled). `next_dispatch_at`
--     is the computed wall-clock target the dispatcher polls against;
--     refreshed on every successful send (advance one period) and on
--     resumeEnrollment. `paused_reason` + `paused_at` are stamped on
--     pauseEnrollment and cleared on resumeEnrollment. `cancelled_at`
--     stamps the terminal-cancel moment; once set, the row is read-only.
--
--   wishlist_digest_sent
--     One row per dispatched digest — append-only by primitive convention.
--     `item_count` is the number of wishlist items the digest covered
--     (operator dashboard rollup), `sent_at` is the dispatch timestamp.
--     The composition with `email` is at the dispatcher level; the
--     ledger only records "we sent this customer their digest at T with
--     N items in it".
--
-- Indexes drive the three hot read paths:
--   * (status, next_dispatch_at)              — dispatchTick window
--   * (customer_id, status)                   — enrollmentsForCustomer
--   * (schedule_slug, sent_at)                — metricsForSchedule

CREATE TABLE IF NOT EXISTS wishlist_digest_schedules (
  slug             TEXT    NOT NULL PRIMARY KEY,
  frequency        TEXT    NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  day_of_week      INTEGER          CHECK (day_of_week  IS NULL OR (day_of_week  BETWEEN 0 AND 6)),
  day_of_month     INTEGER          CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 28)),
  time_local       TEXT    NOT NULL,
  timezone         TEXT    NOT NULL,
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((frequency = 'weekly'  AND day_of_week  IS NOT NULL AND day_of_month IS NULL)
      OR (frequency = 'monthly' AND day_of_month IS NOT NULL AND day_of_week  IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_wishlist_digest_schedules_archived
  ON wishlist_digest_schedules(archived_at);

CREATE TABLE IF NOT EXISTS wishlist_digest_enrollments (
  id                TEXT    NOT NULL PRIMARY KEY,
  customer_id       TEXT    NOT NULL,
  schedule_slug     TEXT    NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('active', 'paused', 'cancelled')),
  next_dispatch_at  INTEGER NOT NULL,
  paused_reason     TEXT,
  paused_at         INTEGER,
  cancelled_at      INTEGER,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (schedule_slug) REFERENCES wishlist_digest_schedules(slug) ON DELETE CASCADE,
  UNIQUE (customer_id, schedule_slug),
  CHECK ((status = 'active'    AND paused_at IS NULL  AND cancelled_at IS NULL)
      OR (status = 'paused'    AND paused_at IS NOT NULL AND cancelled_at IS NULL)
      OR (status = 'cancelled' AND cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_wishlist_digest_enrollments_due
  ON wishlist_digest_enrollments(status, next_dispatch_at);

CREATE INDEX IF NOT EXISTS idx_wishlist_digest_enrollments_customer
  ON wishlist_digest_enrollments(customer_id, status);

CREATE TABLE IF NOT EXISTS wishlist_digest_sent (
  id             TEXT    NOT NULL PRIMARY KEY,
  enrollment_id  TEXT    NOT NULL,
  item_count     INTEGER NOT NULL CHECK (item_count >= 0),
  sent_at        INTEGER NOT NULL,
  FOREIGN KEY (enrollment_id) REFERENCES wishlist_digest_enrollments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wishlist_digest_sent_enrollment
  ON wishlist_digest_sent(enrollment_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_wishlist_digest_sent_schedule_time
  ON wishlist_digest_sent(enrollment_id, sent_at);
