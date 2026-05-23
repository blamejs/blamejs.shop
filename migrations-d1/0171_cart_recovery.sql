-- Cart recovery — multi-step abandonment email sequences.
--
-- Where `cart-abandonment` detects an idle cart and the operator's
-- fan-out worker fires a single reminder, this primitive owns the
-- multi-step nurture that follows: a 1h reminder, then a 24h
-- discount nudge, then a 72h last-chance. Operators define the
-- sequence once + enroll each detection; the per-tick dispatcher
-- walks enrolled rows whose `next_step_at <= now`, sends the next
-- step through the `email` primitive (subject to the suppression
-- gate), and advances `current_step_index` + `next_step_at` to the
-- following step. When `current_step_index` exceeds the sequence
-- length the enrollment lands `completed` and stops dispatching.
--
-- Recovery: the operator's checkout layer calls `markRecovered`
-- when the abandoned-cart customer finishes a purchase. The
-- enrollment lands `recovered` (terminal) + the `recovered_order_id`
-- column records which order closed it; `metricsForSequence` divides
-- recovered enrollments by total to surface the sequence's recovery
-- rate.
--
-- Three tables back the surface:
--
--   cart_recovery_sequences    — operator-defined sequence config.
--                                `steps_json` is the ordered array of
--                                `{step_index, offset_ms, kind}` rows
--                                — `kind` is the email-template kind
--                                the dispatcher renders (reminder /
--                                discount / last_chance / generic).
--                                `active=0` archives the sequence
--                                without dropping historical
--                                enrollments.
--
--   cart_recovery_enrollments  — one row per enrolled detection.
--                                FSM: enrolled → completed (all steps
--                                fired) | recovered (customer paid) |
--                                cancelled (operator pulled it).
--                                `next_step_at` is the epoch-ms at
--                                which the dispatcher should send the
--                                next step; NULL when the enrollment
--                                is terminal. `customer_email_hash` is
--                                the namespace-hashed email so the
--                                row never persists the raw address.
--
--   cart_recovery_dispatches   — append-only log of every step
--                                attempt (sent / skipped / failed).
--                                The dispatcher writes one row per
--                                step transition so the operator
--                                dashboard can answer "which step
--                                landed which message at which time".
--
-- Indexes:
--   * (next_step_at) on enrollments — the dispatcher's hot read is
--     "every enrollment with status='enrolled' and next_step_at <= now".
--   * (status, sequence_slug) on enrollments — metricsForSequence.
--   * (customer_id) on enrollments — enrollmentsForCustomer.
--   * (enrollment_id, step_index) on dispatches — per-enrollment audit
--     panel + idempotency check inside recordStepSent.

CREATE TABLE IF NOT EXISTS cart_recovery_sequences (
  slug         TEXT NOT NULL PRIMARY KEY,
  title        TEXT NOT NULL,
  steps_json   TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cart_recovery_sequences_active
  ON cart_recovery_sequences(active);

CREATE TABLE IF NOT EXISTS cart_recovery_enrollments (
  id                    TEXT NOT NULL PRIMARY KEY,
  sequence_slug         TEXT NOT NULL,
  detection_id          TEXT,
  cart_id               TEXT NOT NULL,
  customer_id           TEXT,
  customer_email_hash   TEXT,
  status                TEXT NOT NULL CHECK (status IN (
    'enrolled',
    'completed',
    'recovered',
    'cancelled'
  )),
  current_step_index    INTEGER NOT NULL DEFAULT 0,
  next_step_at          INTEGER,
  enrolled_at           INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  recovered_at          INTEGER,
  recovered_order_id    TEXT,
  cancelled_at          INTEGER,
  cancelled_reason      TEXT,
  FOREIGN KEY (sequence_slug) REFERENCES cart_recovery_sequences(slug) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_cart_recovery_enrollments_next_step
  ON cart_recovery_enrollments(next_step_at, status);

CREATE INDEX IF NOT EXISTS idx_cart_recovery_enrollments_status_seq
  ON cart_recovery_enrollments(status, sequence_slug);

CREATE INDEX IF NOT EXISTS idx_cart_recovery_enrollments_customer
  ON cart_recovery_enrollments(customer_id);

CREATE INDEX IF NOT EXISTS idx_cart_recovery_enrollments_detection
  ON cart_recovery_enrollments(detection_id);

CREATE TABLE IF NOT EXISTS cart_recovery_dispatches (
  id              TEXT NOT NULL PRIMARY KEY,
  enrollment_id   TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
    'sent',
    'skipped-suppressed',
    'skipped-no-email',
    'failed'
  )),
  reason          TEXT,
  dispatched_at   INTEGER NOT NULL,
  FOREIGN KEY (enrollment_id) REFERENCES cart_recovery_enrollments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cart_recovery_dispatches_enrollment
  ON cart_recovery_dispatches(enrollment_id, step_index);
