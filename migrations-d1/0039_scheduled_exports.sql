-- Scheduled exports: queued operator-export jobs for offline analysis,
-- accounting reconciliation, and 3PL handoff.
--
-- Operators routinely need to ship the entire orders table (or a
-- date-bounded slice of it) out to CSV / NDJSON for downstream
-- consumers — bookkeeping software, fulfillment partners, marketing
-- platforms, financial-audit teams. Running the export inline against
-- the request-serving HTTP worker is a footgun on a large catalogue;
-- the right shape is a worker queue that the operator picks up and
-- runs against a streaming cursor.
--
-- A row in `scheduled_exports` represents one queued job. The
-- order-export primitive transitions rows through a four-state FSM:
--
--   queued    — operator filed the request, worker hasn't picked it up
--   running   — worker has claimed the row + is producing output
--   complete  — output produced; row_count + byte_size + sha3_512 are
--               persisted so the operator can verify integrity
--   failed    — worker bailed; error text captured for triage
--   cancelled — operator cancelled before the worker claimed it
--
-- Schema decisions:
--   * `id` is a v7 UUID — millisecond-prefixed, lexicographically
--     sortable, so the B-tree PK doubles as an arrival-order index.
--   * `format` is a two-state enum (csv / ndjson). Adding a future
--     format means a migration step, by design — operators don't get
--     to invent freeform format names.
--   * `from_ts` / `to_ts` are epoch-millisecond bounds on the order
--     `created_at` column (the export's date-range query). Half-open
--     `[from, to)` semantics are enforced at the application layer.
--   * `columns_json` is a JSON array of column names allowlisted
--     against the built-in 24-column schema — NULL means "all columns".
--   * `deliver_to_url` is operator-supplied — a webhook / object-store
--     PUT URL that the worker uses to ship the produced bytes. NULL
--     means "operator polls for the file id". Validated at the app
--     layer; the column itself accepts any TEXT shape so future
--     delivery transports (sftp://, s3://, etc.) compose cleanly.
--   * `file_sha3_512` is the SHA3-512 of the produced bytes (128 hex
--     chars). The operator-side verifier round-trips this against the
--     received blob so a truncated upload fails noisily.
--   * Timestamps `queued_at` / `started_at` / `completed_at` are kept
--     separately so the worker's actual wall-clock latency is
--     observable without subtracting a single mutated `updated_at`.

CREATE TABLE IF NOT EXISTS scheduled_exports (
  id              TEXT NOT NULL PRIMARY KEY,
  format          TEXT NOT NULL CHECK (format IN ('csv', 'ndjson')),
  from_ts         INTEGER NOT NULL CHECK (from_ts >= 0),
  to_ts           INTEGER NOT NULL CHECK (to_ts   >= 0),
  columns_json    TEXT,
  deliver_to_url  TEXT,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  row_count       INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  byte_size       INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  file_sha3_512   TEXT,
  error           TEXT,
  queued_at       INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_scheduled_exports_status_queued ON scheduled_exports(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_exports_format_queued ON scheduled_exports(format, queued_at DESC);
