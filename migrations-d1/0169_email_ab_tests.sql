-- Email A/B tests: subject-line + body experiments across email
-- templates with deterministic per-recipient variant assignment +
-- per-variant open / click metrics.
--
-- Two tables:
--
--   * `email_ab_tests` — one row per operator-defined experiment.
--     `id` is a UUID v7 (lex-monotonic so audit reads sort cleanly).
--     `template_slug` ties the test to a single template — every
--     variant overrides that template's subject + bodies for a
--     subset of recipients picked by deterministic hash. `status`
--     is the FSM:
--       - draft     -> running    (start)
--       - running   -> paused     (pauseTest — recipients still get
--                                  the previously assigned variant,
--                                  but recordEmailSent refuses new
--                                  assignments)
--       - paused    -> running    (resumeTest)
--       - running   -> concluded  (concludeTest — winner_variant_id
--                                  recorded; metrics frozen)
--       - paused    -> concluded
--       - *         -> archived   (archiveTest; terminal)
--     `variants_json` is the operator-authored array of variant
--     specs. Each variant carries:
--       { id, label, weight, subject?, body_html?, body_text? }
--     Variant id is a stable lowercase alnum/dash slug (1..64
--     chars). Variant weights are positive integers; assignment
--     uses cumulative-weight bucketing against a 100,000-bucket
--     SHA3-512 hash so split percentages are exact for the
--     declared weights (no rounding-induced bias). At least two
--     variants required; total weight bounded so the JSON column
--     can't be unbounded.
--     `winner_variant_id` is set at `concludeTest` and references
--     a variant id in `variants_json`.
--   * `email_ab_test_events` — append-only ledger of per-recipient
--     events. `kind` is one of (sent, opened, clicked). The
--     (test_id, recipient_id, variant_id, kind) UNIQUE index makes
--     recordOpen / recordClick idempotent — replaying the same
--     event lands as a no-op, never as a double-count. `sent`
--     also unique per (test_id, recipient_id) so a single
--     recipient can't be assigned more than one variant within
--     one test.
--
-- Indexes drive the three hot read paths:
--   * (status)                                  — listTests filter
--   * (test_id, kind)                            — metricsForTest
--     aggregate
--   * (test_id, recipient_id)                    — assignment-cache
--     lookup in getVariantForRecipient (read existing assignment
--     before re-computing one)

CREATE TABLE IF NOT EXISTS email_ab_tests (
  id                 TEXT    NOT NULL PRIMARY KEY,
  slug               TEXT    NOT NULL UNIQUE,
  title              TEXT    NOT NULL,
  template_slug      TEXT    NOT NULL,
  variants_json      TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'concluded', 'archived')),
  winner_variant_id  TEXT,
  started_at         INTEGER,
  paused_at          INTEGER,
  concluded_at       INTEGER,
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK ((status = 'draft'     AND started_at IS NULL     AND concluded_at IS NULL AND archived_at IS NULL)
      OR (status = 'running'   AND started_at IS NOT NULL AND concluded_at IS NULL AND archived_at IS NULL)
      OR (status = 'paused'    AND started_at IS NOT NULL AND paused_at IS NOT NULL AND concluded_at IS NULL AND archived_at IS NULL)
      OR (status = 'concluded' AND concluded_at IS NOT NULL AND archived_at IS NULL)
      OR (status = 'archived'  AND archived_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_email_ab_tests_status   ON email_ab_tests(status);
CREATE INDEX IF NOT EXISTS idx_email_ab_tests_template ON email_ab_tests(template_slug);

CREATE TABLE IF NOT EXISTS email_ab_test_events (
  id            TEXT    NOT NULL PRIMARY KEY,
  test_id       TEXT    NOT NULL,
  recipient_id  TEXT    NOT NULL,
  variant_id    TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('sent', 'opened', 'clicked')),
  occurred_at   INTEGER NOT NULL,
  FOREIGN KEY (test_id) REFERENCES email_ab_tests(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_ab_test_events_unique
  ON email_ab_test_events(test_id, recipient_id, variant_id, kind);
CREATE INDEX IF NOT EXISTS idx_email_ab_test_events_test_kind
  ON email_ab_test_events(test_id, kind);
CREATE INDEX IF NOT EXISTS idx_email_ab_test_events_test_recipient
  ON email_ab_test_events(test_id, recipient_id);
