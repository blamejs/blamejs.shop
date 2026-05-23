-- Reorder reminders — customer-facing "time to reorder" nudges for
-- consumable products (filters, vitamins, contact lenses, pet food).
-- Operators define a per-SKU interval and message template; the
-- primitive enrols a (customer_id, sku) pair on a recorded last-order
-- date, computes next_remind_at = last_order_at + interval_days, and
-- the dispatcher tick walks due rows and hands each one to the
-- channel-matching notifications / email / sms primitive.
--
-- Three tables, narrow shapes:
--
--   reorder_profiles
--     One row per SKU the operator wants to nudge on. The SKU is the
--     PK — a SKU's reorder cadence is global to the catalog, not
--     per-customer; per-customer overrides live on the enrollment row
--     (via last_order_at) rather than a fork of the profile.
--
--   reorder_enrollments
--     One row per (customer_id, sku) enrollment. `next_remind_at` is
--     the computed wall-clock target the dispatcher polls against.
--     `status` is a CHECK-bounded enum (active / paused / cancelled);
--     `unsubscribed_at` stamps the cancel moment so an audit log can
--     prove the customer opted out.
--
--   reorder_dispatches
--     One row per send attempt — append-only by primitive convention.
--     `status` distinguishes sent from failed; failed rows carry a
--     `fail_reason` string so operators can debug provider outages
--     without grepping logs.
--
-- Indexes target the dispatcher's hot read (`status = 'active' AND
-- next_remind_at <= now`) and the customer-portal read
-- (`customer_id`).

CREATE TABLE IF NOT EXISTS reorder_profiles (
  sku                    TEXT NOT NULL PRIMARY KEY,
  interval_days          INTEGER NOT NULL CHECK (interval_days > 0),
  message_template_slug  TEXT NOT NULL,
  channel                TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'in_app')),
  archived_at            INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reorder_profiles_active
  ON reorder_profiles(sku) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS reorder_enrollments (
  id                TEXT NOT NULL PRIMARY KEY,
  customer_id       TEXT NOT NULL,
  sku               TEXT NOT NULL,
  last_order_at     INTEGER NOT NULL,
  next_remind_at    INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled')),
  unsubscribed_at   INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE (customer_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_reorder_enrollments_due
  ON reorder_enrollments(status, next_remind_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_reorder_enrollments_customer
  ON reorder_enrollments(customer_id, status);

CREATE TABLE IF NOT EXISTS reorder_dispatches (
  id              TEXT NOT NULL PRIMARY KEY,
  enrollment_id   TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  occurred_at     INTEGER NOT NULL,
  fail_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_reorder_dispatches_enrollment
  ON reorder_dispatches(enrollment_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_reorder_dispatches_sku_time
  ON reorder_dispatches(enrollment_id, status, occurred_at);
