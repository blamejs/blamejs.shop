-- Print queue: warehouse print job scheduler.
--
-- The operator's problem: the warehouse needs packing slips, shipping
-- labels, return labels, and invoices printed at six workstations
-- across two floors. Each workstation has a thermal label printer +
-- a laser printer; some only print 4x6 thermal labels, others only
-- handle Letter / A4 paper. A naive "print this slip directly" verb
-- couples the order-flow code to which printer is physically online
-- right now, which paper is loaded, which workstation is unmanned at
-- 3am. The fix is a queue: order-flow code calls `enqueueJob({...})`
-- and walks away; workstations call `claimJob({ station_id, kinds? })`
-- when their operator is ready to print, marking the job in_progress;
-- after the print succeeds the workstation calls `markComplete`. If
-- the printer jams or runs out of paper, `markFailed({ retry: true })`
-- puts the job back at the front of the queue for the next claimant.
--
-- Single table — `print_jobs`. Five-state CHECK enum:
--   queued       — enqueued, waiting for a workstation to claim.
--                  Default state on insert.
--   in_progress  — a workstation has claimed the job and is printing.
--                  `claimed_by_station` + `claimed_at` are non-null.
--                  Persists until the workstation calls markComplete
--                  or markFailed.
--   complete     — the workstation confirmed the print succeeded.
--                  `completed_at` + `completed_by_station` non-null.
--                  Terminal happy state. cleanupCompleted sweeps these
--                  after the operator-supplied age cutoff so the table
--                  doesn't grow without bound.
--   failed       — the workstation reported the print failed.
--                  `fail_reason` + `failed_at` non-null. When the
--                  failure was retryable (printer jam, paper out) the
--                  job is requeued by inserting a fresh `queued` row
--                  with `retry_count + 1`; the failed row stays on
--                  disk for the audit. When the failure was terminal
--                  (corrupt payload, station offline) the row is the
--                  final state.
--   cancelled    — the operator abandoned the job (order cancelled
--                  upstream, duplicate enqueue). `cancel_reason` +
--                  `failed_at` non-null. Terminal sad state.
--
-- Two enums on the input shape:
--   kind: which document the workstation prints — packing_slip /
--         shipping_label / invoice / packing_label / return_label /
--         pickup_slip. The CHECK constraint refuses anything else so a
--         typo at the order-flow caller surfaces at enqueue time, not
--         when a workstation tries to render an unknown template.
--   paper_size: letter / a4 / thermal_4x6 / thermal_4x8. The
--         workstation filters claims by paper_size when its loaded
--         media doesn't match the job — claimJob without a `kinds`
--         override falls back to the station_filter on the row + the
--         station's own capability matrix at the caller level.
--
-- station_filter is an optional column — when null the job can be
-- claimed by any workstation; when set to a specific station_id only
-- that workstation can claim it (e.g. "print this invoice on the
-- accounting workstation, not the warehouse floor").
--
-- priority is an integer 0..10. Higher wins. The claim query orders
-- by (priority DESC, scheduled_at ASC, created_at ASC) so the
-- highest-priority job that's eligible to print right now (scheduled
-- in the past) gets claimed first. Ties broken by scheduled_at then
-- by created_at — FIFO within a priority band, deterministic.
--
-- scheduled_at lets the operator defer a job ("print the morning
-- batch at 06:00"). claimJob refuses to return a job whose
-- scheduled_at is greater than now(). When omitted the column defaults
-- to created_at so the job is immediately eligible.
--
-- Indexes:
--   * `(status, priority DESC, scheduled_at)` — the claim query's hot
--     path. Workstation polls call this constantly so the index
--     ordering matches the ORDER BY exactly.
--   * `(claimed_by_station, status)` — jobsForStation lookup.
--   * `(kind, status)` — pendingByKind dashboard read.

CREATE TABLE IF NOT EXISTS print_jobs (
  id                     TEXT NOT NULL PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind IN (
                           'packing_slip', 'shipping_label', 'invoice',
                           'packing_label', 'return_label', 'pickup_slip'
                         )),
  payload_ref            TEXT NOT NULL,
  priority               INTEGER NOT NULL CHECK (priority >= 0 AND priority <= 10),
  station_filter         TEXT,
  paper_size             TEXT NOT NULL CHECK (paper_size IN (
                           'letter', 'a4', 'thermal_4x6', 'thermal_4x8'
                         )),
  copies                 INTEGER NOT NULL CHECK (copies > 0 AND copies <= 99),
  scheduled_at           INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN (
                           'queued', 'in_progress', 'complete', 'failed', 'cancelled'
                         )),
  claimed_by_station     TEXT,
  claimed_at             INTEGER,
  completed_at           INTEGER,
  completed_by_station   TEXT,
  failed_at              INTEGER,
  fail_reason            TEXT,
  retry_count            INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  cancel_reason          TEXT,
  created_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_claim
  ON print_jobs(status, priority DESC, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_print_jobs_station_status
  ON print_jobs(claimed_by_station, status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_kind_status
  ON print_jobs(kind, status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_created
  ON print_jobs(created_at);
