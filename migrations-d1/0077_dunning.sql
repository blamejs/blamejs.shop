-- Dunning — payment-recovery state machine for failed subscription
-- invoices. Sibling to `subscription_billing`: that primitive owns the
-- invoice + attempt + dunning-episode ledger driven by the processor's
-- webhook deliveries; this one owns the OPERATOR-DEFINED retry policy
-- and the per-invoice scheduler walk that progressively escalates a
-- failed invoice through reminder emails, charge retries, an optional
-- pause, and finally subscription cancellation.
--
-- Three tables back the surface:
--
--   dunning_policies      — operator-authored policies. The
--                           `retry_schedule_json` column carries an
--                           ordered list of `{ delay_hours, action }`
--                           steps; the primitive reads the JSON at
--                           tickDunning time. Policies are addressed by
--                           `slug` (operator-friendly identifier) so
--                           enrollment carries a stable reference even
--                           when the schedule body is rewritten.
--                           Archive a policy (set `archived_at`) to
--                           refuse new enrollments without deleting the
--                           history of invoices already running on it.
--
--   dunning_enrollments   — one row per invoice currently being worked.
--                           The UNIQUE (invoice_id) keeps a single
--                           active enrollment per invoice; if the
--                           operator wants to re-enrol after a
--                           recovered/cancelled outcome they archive
--                           the row first (status flips to a terminal
--                           value + ended_at stamp). `next_action_at`
--                           drives the scheduler walk:
--                           `WHERE status='active' AND next_action_at
--                           <= now` is the index-backed query the
--                           tickDunning surface runs every cron tick.
--
--   dunning_events        — append-only audit log of every action
--                           tickDunning executed for an enrollment.
--                           One row per action with the resulting
--                           outcome so the operator can replay the
--                           recovery sequence on the customer profile.
--
-- Indexes:
--   * UNIQUE (invoice_id) on enrollments — one active enrollment per
--     invoice; webhook redelivery of the same `invoice.payment_failed`
--     collapses to one row.
--   * (status, next_action_at) on enrollments — the scheduler walk.
--   * (policy_slug, status) on enrollments — metricsForPolicy
--     aggregation (counts of recovered / cancelled / abandoned).
--   * (enrollment_id, occurred_at, id) on events — the per-invoice
--     history surface, ordered oldest-first.

CREATE TABLE IF NOT EXISTS dunning_policies (
  slug                    TEXT NOT NULL PRIMARY KEY,
  retry_schedule_json     TEXT NOT NULL,
  cancel_after_attempts   INTEGER NOT NULL CHECK (cancel_after_attempts >= 1),
  archived_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dunning_enrollments (
  id                 TEXT NOT NULL PRIMARY KEY,
  invoice_id         TEXT NOT NULL UNIQUE,
  policy_slug        TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active', 'recovered', 'cancelled', 'abandoned')),
  next_action_at     INTEGER,
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_action        TEXT,
  last_action_at     INTEGER,
  ended_at           INTEGER,
  end_reason         TEXT,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (policy_slug) REFERENCES dunning_policies(slug)
);

CREATE INDEX IF NOT EXISTS idx_dunning_enrollments_due
  ON dunning_enrollments(status, next_action_at);

CREATE INDEX IF NOT EXISTS idx_dunning_enrollments_policy_status
  ON dunning_enrollments(policy_slug, status);

CREATE TABLE IF NOT EXISTS dunning_events (
  id              TEXT NOT NULL PRIMARY KEY,
  enrollment_id   TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL CHECK (attempt_number >= 1),
  action          TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  occurred_at     INTEGER NOT NULL,
  FOREIGN KEY (enrollment_id) REFERENCES dunning_enrollments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dunning_events_enrollment
  ON dunning_events(enrollment_id, occurred_at, id);
