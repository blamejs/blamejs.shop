-- Product bulk imports — one run row per operator-filed import job.
--
-- Distinct from `customer_imports` (operator one-shot migration of
-- the customer table) and from the existing `catalogImport` primitive
-- (a thin CSV → catalog.products adapter that processes a single
-- request inline). `product_imports` is the operator-managed bulk
-- loader: persistent state across the lifetime of the run, structured
-- error report per row, per-format input shape, on-conflict policy
-- recorded on the run row so the operator console can replay the
-- exact options.
--
-- The status FSM:
--
--   running    — the job is in flight. `completed_at` is NULL.
--   complete   — every row processed; `completed_at` stamped. The
--                rows_*  counters sum to rows_processed.
--   failed     — the driver threw before per-row processing could
--                finish (unreadable stream, header refused, format
--                disagreement). The throw shape lands in errors as
--                a single `error_code = "import_aborted"` row at
--                row_index = 0.
--   cancelled  — `cancelInflight()` was invoked mid-run. The rows
--                already-written stay; subsequent rows are skipped
--                with `rows_skipped += remaining`.
--
-- `format` distinguishes the input shape so the operator console can
-- pre-fill the expected column / record schema:
--
--   flat_csv         — header row + RFC 4180 records, one variant
--                      per row (catalog-import-shaped header).
--   shopify_json     — Shopify's products-export JSON shape: a JSON
--                      array of product objects, each with a
--                      `variants` array, `images` array, and a
--                      `handle` slug.
--   blamejs_native   — the canonical shape this primitive emits
--                      back: an array of `{ slug, title, status,
--                      description, variants: [...], media: [...] }`
--                      objects. Round-trips lossless against
--                      `lastReport()`.
--
-- `on_conflict` records the policy in force for the run:
--
--   update — SKU already exists → patch the existing product /
--            variant / price / media surface to match the incoming
--            row (rows_updated += 1).
--   skip   — SKU already exists → ignore the row entirely
--            (rows_skipped += 1).
--   error  — SKU already exists → row-error (rows_errored += 1,
--            error_code = "duplicate_sku").
--
-- `input_byte_count` is the size of the source stream / buffer at
-- import time, recorded for capacity-planning + audit purposes.
-- The errors land in a separate table (`product_import_errors`)
-- rather than a JSON blob so the operator console can paginate
-- through them without re-loading the whole error list.

CREATE TABLE IF NOT EXISTS product_imports (
  id                  TEXT NOT NULL PRIMARY KEY,
  format              TEXT NOT NULL CHECK (format IN (
    'flat_csv', 'shopify_json', 'blamejs_native'
  )),
  on_conflict         TEXT NOT NULL CHECK (on_conflict IN (
    'update', 'skip', 'error'
  )),
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  status              TEXT NOT NULL CHECK (status IN (
    'running', 'complete', 'failed', 'cancelled'
  )),
  input_byte_count    INTEGER NOT NULL DEFAULT 0  CHECK (input_byte_count >= 0),
  rows_processed      INTEGER NOT NULL DEFAULT 0  CHECK (rows_processed   >= 0),
  products_created    INTEGER NOT NULL DEFAULT 0  CHECK (products_created >= 0),
  products_updated    INTEGER NOT NULL DEFAULT 0  CHECK (products_updated >= 0),
  variants_created    INTEGER NOT NULL DEFAULT 0  CHECK (variants_created >= 0),
  variants_updated    INTEGER NOT NULL DEFAULT 0  CHECK (variants_updated >= 0),
  rows_skipped        INTEGER NOT NULL DEFAULT 0  CHECK (rows_skipped     >= 0),
  rows_errored        INTEGER NOT NULL DEFAULT 0  CHECK (rows_errored     >= 0)
);

CREATE INDEX IF NOT EXISTS idx_product_imports_status_started
  ON product_imports(status, started_at DESC);

CREATE TABLE IF NOT EXISTS product_import_errors (
  id           TEXT NOT NULL PRIMARY KEY,
  import_id    TEXT NOT NULL,
  row_index    INTEGER NOT NULL CHECK (row_index >= 0),
  sku          TEXT NOT NULL DEFAULT '',
  error_code   TEXT NOT NULL,
  error_detail TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (import_id) REFERENCES product_imports(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_import_errors_import_id
  ON product_import_errors(import_id);
