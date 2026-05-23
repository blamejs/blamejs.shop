-- Cycle counting: scheduled physical inventory audits that compare
-- expected stock (from `inventory_stock` / catalog) against operator-
-- recorded counts, then write adjustments through
-- inventoryLocations.adjustStock so the audit trail on
-- `inventory_adjustments` carries the rationale.
--
-- Three kinds of count:
--
--   * rotating   — operator picks an explicit SKU subset (a few high-
--                  velocity SKUs counted weekly, or whatever rotating
--                  cadence the operator follows).
--   * abc        — pulls the SKU set from the catalog by ABC class
--                  (operator-supplied via `scope.abc_class` — A, B, C
--                  — opaque to this primitive; the catalog adapter
--                  classifies).
--   * full       — every active SKU in the catalog. Long-running; the
--                  operator typically schedules this during a closure
--                  window.
--
-- Two tables:
--
--   * `cycle_counts` — the header. One row per count, keyed by
--     operator-chosen slug. Five-state CHECK enum:
--       scheduled    — created, worksheet not yet emitted
--       in_progress  — worksheet emitted (one or more lines have
--                      expected_quantity captured)
--       finalized    — operator stopped recording, variance computed,
--                      adjustments optionally written
--       cancelled    — operator abandoned the count (typo, rescheduled,
--                      replaced by a fresh slug)
--     `scope_json` is the structured scope payload — `{ skus: [...] }`
--     for rotating, `{ abc_class: 'A' }` for abc, `{ all_active: true }`
--     for full. The primitive parses it back out at worksheetFor time
--     so downstream readers don't reverse-engineer the kind enum.
--     `location_code` is nullable — a count without a location_code
--     counts global catalog stock (one bucket per SKU); with a
--     location_code, only that shelf's expected_quantity is captured.
--     `variance_count` + `variance_value_minor` are NULL until
--     finalize; the primitive fills them in-place so the operator
--     dashboard's variance report doesn't recompute on every read.
--
--   * `cycle_count_lines` — one row per SKU on the count. The header's
--     scope determines which SKUs land here; worksheetFor populates
--     `expected_quantity` on every line. `actual_quantity` is NULL
--     until the operator records the count via recordCount;
--     `counted_by` + `counted_at` are NULL until the same call.
--     `variance = actual_quantity - expected_quantity` is computed at
--     finalize time and stored so subsequent reads don't recompute.
--     Negative variance = the shelf had LESS than expected (shrinkage,
--     theft, mis-pick); positive = MORE than expected (mis-shipped
--     receive, prior over-count, found-in-back-room).
--
-- Indexes:
--   * `(status, scheduled_at)` — `listCounts({ kind?, from?, to? })`
--     pages the operator dashboard by scheduled date.
--   * `(kind)` — narrowed listCounts by kind.
--   * `(count_slug)` on lines — every fan-out read is keyed by parent.
--   * `(sku)` on lines — `historyForSku` walks every count that
--     touched a SKU.

CREATE TABLE IF NOT EXISTS cycle_counts (
  slug                  TEXT NOT NULL PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('rotating', 'abc', 'full')),
  scope_json            TEXT NOT NULL,
  scheduled_at          INTEGER NOT NULL,
  location_code         TEXT,
  status                TEXT NOT NULL CHECK (status IN (
                          'scheduled', 'in_progress', 'finalized', 'cancelled'
                        )),
  variance_count        INTEGER,
  variance_value_minor  INTEGER,
  finalized_at          INTEGER,
  cancelled_at          INTEGER,
  cancel_reason         TEXT,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cycle_count_lines (
  id                 TEXT NOT NULL PRIMARY KEY,
  count_slug         TEXT NOT NULL,
  sku                TEXT NOT NULL,
  location_code      TEXT,
  expected_quantity  INTEGER NOT NULL,
  actual_quantity    INTEGER,
  counted_by         TEXT,
  counted_at         INTEGER,
  variance           INTEGER,
  FOREIGN KEY (count_slug) REFERENCES cycle_counts(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cycle_counts_status_scheduled  ON cycle_counts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_kind              ON cycle_counts(kind);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_scheduled         ON cycle_counts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_cycle_count_lines_count_slug   ON cycle_count_lines(count_slug);
CREATE INDEX IF NOT EXISTS idx_cycle_count_lines_sku          ON cycle_count_lines(sku);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cycle_count_lines_slug_sku_loc
  ON cycle_count_lines(count_slug, sku, IFNULL(location_code, ''));
