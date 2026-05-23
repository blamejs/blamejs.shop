-- Customer bulk imports — one run row per import job.
--
-- Operators run the importer once during platform migration: a CSV /
-- NDJSON export from a prior storefront is fed through `bShop
-- .customerImport` and lands in the `customers` table (via the
-- existing customers primitive, which holds the SHA3-512 email_hash
-- + display_name surface). The `customer_imports` row records the
-- shape of the job for the operator console — when it started, when
-- it finished, how many rows landed in each outcome bucket, and the
-- structured error list when rows refused validation.
--
-- The status FSM:
--
--   running    — the job is in flight. `completed_at` is NULL.
--   complete   — every row processed; `completed_at` stamped. The
--                rows_* counters sum to rows_processed.
--   failed     — the driver threw before processing finished
--                (e.g. unreadable stream, header refused). errors_json
--                carries the throw shape.
--   cancelled  — `cancelInflight()` was invoked mid-run. The rows
--                already-written stay; subsequent rows are skipped.
--
-- `source` distinguishes the input shape so the operator console can
-- pre-fill the expected column set / record shape on the re-import
-- dialog:
--
--   csv        — header row + RFC 4180 records.
--   ndjson     — one JSON object per line.
--   api        — programmatic call to importRows (no parsing).
--
-- `input_byte_count` is the size of the source stream / buffer at
-- import time, recorded for capacity-planning + audit purposes.
-- `errors_json` is a canonical-JSON-encoded array of
-- `{ row_index, message }` rows; the importer caps the in-memory
-- error list so a runaway-bad file doesn't blow up the run record.

CREATE TABLE IF NOT EXISTS customer_imports (
  id                  TEXT NOT NULL PRIMARY KEY,
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  status              TEXT NOT NULL CHECK (status IN (
    'running', 'complete', 'failed', 'cancelled'
  )),
  source              TEXT NOT NULL CHECK (source IN (
    'csv', 'ndjson', 'api'
  )),
  input_byte_count    INTEGER NOT NULL DEFAULT 0 CHECK (input_byte_count >= 0),
  rows_processed      INTEGER NOT NULL DEFAULT 0 CHECK (rows_processed >= 0),
  rows_created        INTEGER NOT NULL DEFAULT 0 CHECK (rows_created >= 0),
  rows_updated        INTEGER NOT NULL DEFAULT 0 CHECK (rows_updated >= 0),
  rows_skipped        INTEGER NOT NULL DEFAULT 0 CHECK (rows_skipped >= 0),
  rows_errored        INTEGER NOT NULL DEFAULT 0 CHECK (rows_errored >= 0),
  errors_json         TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_customer_imports_status_started
  ON customer_imports(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_imports_source
  ON customer_imports(source);
