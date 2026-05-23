-- Banner A/B tests: structured split-tests across promo-banner
-- variants with deterministic per-session assignment and an event
-- ledger for the impression / click / conversion funnel.
--
-- Two tables:
--
--   * `banner_ab_tests` — one row per operator-defined test. `slug`
--     is the PRIMARY KEY (lowercase alnum + dash). `variants_json`
--     is the ordered { banner_slug, weight } catalogue — write-once
--     after defineTest, since changing variants after sessions have
--     been assigned would corrupt the deterministic-assignment
--     contract. `status` is the FSM:
--       - running    -> paused      (pauseTest)
--       - paused     -> running     (resumeTest)
--       - running    -> concluded   (concludeTest, with optional
--                                    winning variant slug)
--       - paused     -> concluded   (concludeTest)
--       - concluded  -> archived    (archiveTest, terminal)
--     `concluded_variant_slug` is the operator's recorded winner
--     (NULL if no winner declared). `paused_at` / `concluded_at` /
--     `archived_at` carry the transition timestamps.
--
--   * `banner_ab_test_events` — append-only ledger of impression /
--     click / conversion events. `session_id_hash` is the SHA3-512
--     namespace-hash of the visitor's session id under the namespace
--     `banner-ab-tests-session` — plaintext session ids never reach
--     storage. `variant_slug` is the banner slug the session was
--     assigned to (denormalised so a later variants-list edit can't
--     orphan historical events; in practice variants are write-once
--     so this is belt-and-braces). `event_kind` is the funnel step
--     (impression / click / conversion). `value` is the optional
--     conversion-value attribution (cents, ml of fuel, whatever the
--     operator tracks — the primitive doesn't interpret it). FK
--     CASCADE on `test_slug` so deleting a test also clears its
--     events.
--
-- Indexes drive the four hot read paths:
--   * (test_slug, event_kind, occurred_at)        — metricsForTest
--   * (test_slug, variant_slug, event_kind)       — per-variant rollup
--   * (status, created_at)                         — listTests filter
--   * (session_id_hash, test_slug, event_kind)    — dedup probe

CREATE TABLE IF NOT EXISTS banner_ab_tests (
  slug                    TEXT    NOT NULL PRIMARY KEY,
  title                   TEXT    NOT NULL,
  hypothesis              TEXT    NOT NULL,
  variants_json           TEXT    NOT NULL,
  status                  TEXT    NOT NULL CHECK (status IN ('running', 'paused', 'concluded', 'archived')),
  starts_at               INTEGER NOT NULL,
  ends_at                 INTEGER,
  concluded_variant_slug  TEXT,
  paused_at               INTEGER,
  concluded_at            INTEGER,
  archived_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  CHECK ((status = 'running'   AND paused_at IS NULL AND concluded_at IS NULL AND archived_at IS NULL)
      OR (status = 'paused'    AND paused_at IS NOT NULL AND concluded_at IS NULL AND archived_at IS NULL)
      OR (status = 'concluded' AND concluded_at IS NOT NULL AND archived_at IS NULL)
      OR (status = 'archived'  AND archived_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_banner_ab_tests_status   ON banner_ab_tests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_banner_ab_tests_starts   ON banner_ab_tests(starts_at);

CREATE TABLE IF NOT EXISTS banner_ab_test_events (
  id                TEXT    NOT NULL PRIMARY KEY,
  test_slug         TEXT    NOT NULL,
  variant_slug      TEXT    NOT NULL,
  session_id_hash   TEXT    NOT NULL,
  event_kind        TEXT    NOT NULL CHECK (event_kind IN ('impression', 'click', 'conversion')),
  value             INTEGER NOT NULL DEFAULT 0,
  occurred_at       INTEGER NOT NULL,
  FOREIGN KEY (test_slug) REFERENCES banner_ab_tests(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_banner_ab_events_test     ON banner_ab_test_events(test_slug, event_kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_banner_ab_events_variant  ON banner_ab_test_events(test_slug, variant_slug, event_kind);
CREATE INDEX IF NOT EXISTS idx_banner_ab_events_session  ON banner_ab_test_events(session_id_hash, test_slug, event_kind);
CREATE INDEX IF NOT EXISTS idx_banner_ab_events_occurred ON banner_ab_test_events(occurred_at);
