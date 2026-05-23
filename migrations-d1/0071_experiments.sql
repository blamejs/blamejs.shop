-- Experiments — A/B testing framework for the storefront. Operators
-- define experiments with N variants + per-variant traffic weights;
-- each visitor's session is consistently assigned to one variant for
-- the experiment's lifetime via a deterministic hash of
-- (experiment_slug, session_id_hash) modulo the cumulative weight.
-- Conversion events feed a per-variant success counter, and the
-- operator dashboard reads back per-variant counts + Wilson 95%
-- confidence intervals.
--
-- Schema decisions:
--
--   * `slug` is the PK. Operators address experiments by a stable
--     handle (e.g. "hero-cta-copy-2026q2"); the primitive enforces a
--     tight alnum + hyphen / underscore / dot shape at the app layer.
--
--   * `variants_json` stores the variant catalogue as a JSON array
--     of `{ slug, weight }` records. Variants are write-once at
--     defineExperiment time — operators cannot change the weights or
--     add a variant after the experiment has started, because that
--     would re-shuffle the deterministic-assignment mapping for
--     already-seen sessions and corrupt the running metrics. To
--     change variants the operator archives the experiment and
--     defines a new one.
--
--   * `status` is a CHECK enum. The FSM transitions are:
--
--       draft     -> running   (resumeExperiment when first started)
--       running   -> paused    (pauseExperiment)
--       paused    -> running   (resumeExperiment)
--       running   -> archived  (archiveExperiment)
--       paused    -> archived  (archiveExperiment)
--       draft     -> archived  (archiveExperiment)
--
--     Archived is terminal; an archived experiment cannot transition
--     back. `paused_at` is stamped on every pause; `archived_at` is
--     stamped on archive. `starts_at` is the wall-clock time the
--     experiment is supposed to begin reading traffic (operator
--     plans ahead); `ends_at` is an optional hard cutoff after which
--     `getVariant` returns null even if status is still "running".
--
--   * `primary_metric` is the operator-facing label of the metric
--     that ultimately decides the experiment (e.g. "checkout_started",
--     "add_to_cart"). The primitive doesn't enforce that the recorded
--     conversion events match the primary metric — operators may
--     record secondary metrics into the same experiment_events table
--     for exploratory analysis — but the `metricsForExperiment`
--     report defaults to filtering on the primary metric.
--
-- Events table:
--
--   * Append-only. Every `recordConversion` call inserts a row. The
--     id is a UUID v7 so rows sort lexicographically by insertion
--     time and the (experiment_slug, variant_slug, occurred_at) index
--     scans efficiently for the metrics rollup.
--
--   * `session_id_hash` is the SHA3-512 hex of (namespace,
--     session_id) at the app layer — the raw session id never lands
--     here. The column is intentionally not part of any uniqueness
--     constraint: a single session may convert multiple times (e.g.
--     two checkouts in the same shopping session), and the metrics
--     rollup is on raw counts, not unique-session counts. Operators
--     who want unique-session metrics can post-process the events
--     table off-line.
--
-- Indexes:
--   * `(status, starts_at)` — the dashboard listing filters by status
--     and orders by start date.
--   * `(experiment_slug, variant_slug, occurred_at)` — the metrics
--     rollup is a per-variant count over a time window.

CREATE TABLE IF NOT EXISTS experiments (
  slug              TEXT NOT NULL PRIMARY KEY,
  title             TEXT NOT NULL,
  hypothesis        TEXT NOT NULL,
  variants_json     TEXT NOT NULL,
  primary_metric    TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
                      'draft',
                      'running',
                      'paused',
                      'archived'
                    )),
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER,
  paused_at         INTEGER,
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experiments_status_starts_at
  ON experiments(status, starts_at);

CREATE TABLE IF NOT EXISTS experiment_events (
  id                TEXT NOT NULL PRIMARY KEY,
  experiment_slug   TEXT NOT NULL,
  variant_slug      TEXT NOT NULL,
  session_id_hash   TEXT NOT NULL,
  metric            TEXT NOT NULL,
  value             INTEGER NOT NULL DEFAULT 1 CHECK (value >= 0),
  occurred_at       INTEGER NOT NULL,
  FOREIGN KEY (experiment_slug) REFERENCES experiments(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_experiment_events_rollup
  ON experiment_events(experiment_slug, variant_slug, occurred_at);
