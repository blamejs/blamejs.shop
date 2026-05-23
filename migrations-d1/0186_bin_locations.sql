-- Bin locations — per-SKU warehouse bin/aisle/shelf assignments.
--
-- Three tables. The first records every SKU's bin assignment (one SKU
-- may live in many bins across many locations); the second is an
-- append-only audit log capturing operator-driven bin-content
-- reconciliations; the third tracks each bin's physical condition so
-- the warehouse-floor dashboard can surface bins that need a cleaning
-- pass or are unusable until a repair lands.
--
-- `bin_assignments` — one row per (sku, location_code, bin_label)
-- triple. The `primary` column is a 0/1 flag picking the canonical bin
-- a picker should consult first when the same SKU lives across several
-- bins at the same location (overflow shelves, replenishment buffers).
-- `aisle` / `shelf` / `level` are the structured walk-path coordinates
-- consumed by `pickPathSort` to order a pick list in optimal walking
-- sequence. `archived_at` soft-deletes an assignment without dropping
-- the audit trail of where the SKU used to live; a SKU/location/bin
-- triple may be re-assigned after archival without UNIQUE conflict
-- because the constraint is partial (NULL `archived_at` only).
--
-- `bin_audits` — append-only audit log. Every `recordBinAudit` writes
-- one row capturing the expected vs. actual SKU set at a given bin at
-- a given moment plus the variance (SKUs the auditor found that
-- weren't supposed to be there, SKUs that were supposed to be there
-- but weren't). The JSON columns round-trip arrays of SKU strings;
-- the operator's reconciliation worker reads them to decide whether
-- to adjust stock, file a damage claim, or escalate to a recount.
--
-- `bin_conditions` — one row per (location_code, bin_label) bin
-- tracking its physical state. The CHECK enum is four-valued: `clean`
-- (default-good), `needs_audit` (suspicious activity flagged), `damaged`
-- (physical issue — leaking, broken shelf), `unusable` (do not assign
-- new SKUs here). The warehouse-floor dashboard joins this against
-- `bin_assignments` to surface assignment + condition in one query.
--
-- Indexes:
--   * `(sku, archived_at)` — `binsForSku(sku)` filters by SKU,
--     excludes archived.
--   * `(location_code, aisle, shelf, level)` — `pickPathSort` orders
--     by aisle ASC, shelf ASC, level ASC across all SKUs at a
--     location.
--   * `(location_code, bin_label)` — `skusInBin` reads one bin's
--     residents.
--   * `(location_code, aisle)` — `searchBinsByAisle` enumerates one
--     aisle's bins.
--   * `bin_audits(location_code, bin_label, occurred_at DESC)` — the
--     "most recent audit for this bin" read.
--   * `bin_conditions(condition)` — `listBinsWithCondition` filters
--     by condition state.

CREATE TABLE IF NOT EXISTS bin_assignments (
  id              TEXT NOT NULL PRIMARY KEY,
  sku             TEXT NOT NULL,
  location_code   TEXT NOT NULL,
  bin_label       TEXT NOT NULL,
  aisle           TEXT NOT NULL,
  shelf           TEXT NOT NULL,
  level           TEXT NOT NULL,
  is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  assigned_at     INTEGER NOT NULL,
  archived_at     INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bin_assignments_sku_loc_bin_active
  ON bin_assignments(sku, location_code, bin_label)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bin_assignments_sku_active
  ON bin_assignments(sku, archived_at);

CREATE INDEX IF NOT EXISTS idx_bin_assignments_loc_walk
  ON bin_assignments(location_code, aisle, shelf, level);

CREATE INDEX IF NOT EXISTS idx_bin_assignments_loc_bin
  ON bin_assignments(location_code, bin_label);

CREATE INDEX IF NOT EXISTS idx_bin_assignments_loc_aisle
  ON bin_assignments(location_code, aisle);

CREATE TABLE IF NOT EXISTS bin_audits (
  id                   TEXT NOT NULL PRIMARY KEY,
  location_code        TEXT NOT NULL,
  bin_label            TEXT NOT NULL,
  audited_by           TEXT NOT NULL,
  expected_skus_json   TEXT NOT NULL,
  actual_skus_json     TEXT NOT NULL,
  variance_json        TEXT NOT NULL,
  occurred_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bin_audits_loc_bin_when
  ON bin_audits(location_code, bin_label, occurred_at);

CREATE TABLE IF NOT EXISTS bin_conditions (
  location_code   TEXT NOT NULL,
  bin_label       TEXT NOT NULL,
  condition       TEXT NOT NULL CHECK (condition IN (
                    'clean', 'needs_audit', 'damaged', 'unusable'
                  )),
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (location_code, bin_label)
);

CREATE INDEX IF NOT EXISTS idx_bin_conditions_condition
  ON bin_conditions(condition);
