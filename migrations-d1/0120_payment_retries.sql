-- Payment retries — failure-code-aware retry orchestration for failed
-- one-time payments. Sibling to dunning (which owns the subscription
-- invoice escalation walk); this primitive owns the per-payment
-- recovery sequence keyed on the processor's failure_code, so
-- `insufficient_funds` waits 24h and retries, `card_declined` waits 7d
-- and retries once, `invalid_card` short-circuits to terminal prompt-
-- customer state without consuming retry budget.
--
-- Three tables back the surface:
--
--   payment_retry_policies     — operator-authored policies keyed on
--                                `slug` + scoped by `failure_code` (the
--                                processor decline reason the policy
--                                applies to). The retry_schedule_json
--                                column carries an ordered list of
--                                hour offsets between attempts; the
--                                primitive reads the JSON at
--                                tickRetries time. `terminal_after_attempts`
--                                is the short-circuit count (e.g.
--                                invalid_card → 0, meaning the first
--                                failure is terminal); `max_attempts`
--                                is the safety cap that closes the
--                                enrollment as exhausted if the
--                                schedule runs out without recovery.
--                                Archive a policy via archived_at to
--                                refuse new enrollments without losing
--                                the audit trail.
--
--   payment_retry_enrollments  — one row per payment_intent currently
--                                being worked. UNIQUE (payment_intent_id)
--                                guarantees the processor's webhook
--                                redelivery of the same
--                                `payment_intent.payment_failed` collapses
--                                to one row. status FSM:
--
--                                  active     — scheduler walk still working
--                                  recovered  — recordRetryOutcome(true)
--                                               or unenrollPayment with a
--                                               recovery reason closed it
--                                  exhausted  — max_attempts hit or
--                                               schedule walked off the
--                                               end without success
--                                  abandoned  — terminal_after_attempts
--                                               cap fired OR operator
--                                               unenrolled with a non-
--                                               recovery reason
--
--   payment_retry_attempts     — append-only audit log. One row per
--                                retry attempt (whether succeeded or
--                                failed); recordRetryOutcome appends
--                                the row. The (enrollment_id,
--                                occurred_at, id) index drives
--                                historyForPayment.
--
-- Indexes:
--   * UNIQUE (payment_intent_id) on enrollments — single active
--     enrollment per payment; webhook redelivery collapses cleanly.
--   * (status, next_retry_at) on enrollments — scheduler tick query.
--   * (policy_slug, status) on enrollments — metricsForPolicy.
--   * (failure_code, archived_at) on policies — policiesForFailureCode
--     lookup at enrollFailure time.
--   * (enrollment_id, occurred_at, id) on attempts — history surface.

CREATE TABLE IF NOT EXISTS payment_retry_policies (
  slug                       TEXT NOT NULL PRIMARY KEY,
  failure_code               TEXT NOT NULL,
  retry_schedule_json        TEXT NOT NULL,
  max_attempts               INTEGER NOT NULL CHECK (max_attempts >= 1),
  terminal_after_attempts    INTEGER NOT NULL CHECK (terminal_after_attempts >= 0),
  archived_at                INTEGER,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_retry_policies_failure_code
  ON payment_retry_policies(failure_code, archived_at);

CREATE TABLE IF NOT EXISTS payment_retry_enrollments (
  id                  TEXT NOT NULL PRIMARY KEY,
  payment_intent_id   TEXT NOT NULL UNIQUE,
  order_id            TEXT NOT NULL,
  customer_id         TEXT,
  policy_slug         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('active', 'recovered', 'exhausted', 'abandoned')),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at       INTEGER,
  last_failure_code   TEXT,
  ended_at            INTEGER,
  end_reason          TEXT,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (policy_slug) REFERENCES payment_retry_policies(slug)
);

CREATE INDEX IF NOT EXISTS idx_payment_retry_enrollments_due
  ON payment_retry_enrollments(status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_payment_retry_enrollments_policy_status
  ON payment_retry_enrollments(policy_slug, status);

CREATE TABLE IF NOT EXISTS payment_retry_attempts (
  id              TEXT NOT NULL PRIMARY KEY,
  enrollment_id   TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL CHECK (attempt_number >= 1),
  succeeded       INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  failure_code    TEXT,
  occurred_at     INTEGER NOT NULL,
  FOREIGN KEY (enrollment_id) REFERENCES payment_retry_enrollments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_retry_attempts_enrollment
  ON payment_retry_attempts(enrollment_id, occurred_at, id);
