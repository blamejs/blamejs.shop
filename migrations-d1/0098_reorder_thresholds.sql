-- Reorder thresholds + per-SKU velocity tracking — automated PO suggestions.
--
-- Distinct from `inventory_alerts` (migration 0008), which only fans
-- a notification when available stock crosses a threshold. This pair
-- of tables underwrites a different question: "when stock falls
-- below `min_stock`, what quantity should the operator order, from
-- which vendor, and how soon does the supplier need the PO to land
-- before the shelf runs dry?" The answer is computed from three
-- inputs:
--
--   1. Current stock — read from `inventory_stock` when a
--      `location_code` is configured, otherwise from the catalog
--      `inventory.stock_on_hand`.
--   2. Recent velocity — `sku_velocity` rows are the operator's
--      append-only log of "units sold in a period" so the
--      primitive can derive a units/day rolling average.
--   3. Lead time — `lead_time_days` is the operator-supplied
--      supplier-lead promise. The PO suggestion adds `lead_time_days
--      * velocity` to the bare gap (reorder_to - current) so the
--      operator doesn't stock to the threshold then immediately
--      cross it again while the truck is in transit.
--
-- Schema decisions:
--   * `reorder_thresholds.id` is a v7 UUID so the row sorts by
--     creation order without a separate index — the operator
--     admin UI renders thresholds newest-first.
--   * `location_code` is nullable. The NULL row is the "global"
--     threshold that applies to every location (or to the single-
--     bucket catalog inventory when the operator hasn't adopted
--     multi-location yet). A per-location row overrides the
--     global row for that location. Uniqueness is enforced by the
--     `idx_reorder_thresholds_sku_loc` partial UNIQUE indexes
--     below — SQLite NULL semantics mean a single UNIQUE on
--     `(sku, location_code)` would let multiple NULL rows
--     duplicate the global, so the indexes split the active-row
--     set into "has-location" and "global" buckets each with its
--     own UNIQUE.
--   * `min_stock` is the trigger floor; `reorder_to` is the
--     target ceiling. `reorder_to >= min_stock` is a CHECK so
--     the suggested-qty math never goes negative.
--   * `lead_time_days` is INTEGER >= 0. Zero is legal (the
--     operator's supplier ships same-day) — the velocity-padded
--     reorder math just collapses to (reorder_to - current).
--   * `vendor_slug` is nullable. When set, `proposePurchaseOrder`
--     scopes its aggregation to thresholds tagged with that
--     vendor; an unset slug means "no preferred vendor" and the
--     threshold only surfaces in vendor-agnostic scans. No FK
--     to `vendors.slug` because the threshold's vendor reference
--     can outlive an archived vendor — the operator should still
--     see the orphan threshold in `listThresholds({ vendor_slug:
--     "<archived>" })` so they can re-key it.
--   * `archived_at` soft-deletes the row. Live queries filter on
--     `archived_at IS NULL` via the partial UNIQUE indexes; the
--     row stays in the table so historical PO drafts that
--     captured the threshold id still resolve.
--
--   * `sku_velocity` is the operator-supplied "units sold per
--     period" log. `period_start` / `period_end` are epoch ms;
--     `units_sold` is the integer count. `evaluate` aggregates
--     the most-recent `VELOCITY_WINDOW_DAYS` of rows (30d
--     default; the primitive surfaces the constant) and divides
--     by the elapsed day-count to derive units/day. The append-
--     only shape lets the operator backfill historical sales
--     without re-deriving prior velocity computations.
--   * `sku_velocity.id` is a v7 UUID — the same sorting-without-
--     a-second-index trick as the threshold table.
--   * `location_code` on velocity rows is the same global-vs-per-
--     location split as the thresholds. NULL means "across all
--     locations" — the operator-reporter that captures storefront
--     sales typically writes the global row; an operator with
--     multi-location PoS writes per-location rows.

CREATE TABLE IF NOT EXISTS reorder_thresholds (
  id                 TEXT NOT NULL PRIMARY KEY,
  sku                TEXT NOT NULL,
  location_code      TEXT,
  min_stock          INTEGER NOT NULL CHECK (min_stock >= 0),
  reorder_to         INTEGER NOT NULL CHECK (reorder_to >= 0),
  lead_time_days     INTEGER NOT NULL CHECK (lead_time_days >= 0),
  vendor_slug        TEXT,
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (reorder_to >= min_stock)
);

-- Active-row uniqueness — two partial indexes split the
-- (sku, location_code) namespace so the global (NULL) row and the
-- per-location rows each enforce their own UNIQUE without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reorder_thresholds_sku_loc
  ON reorder_thresholds(sku, location_code)
  WHERE archived_at IS NULL AND location_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reorder_thresholds_sku_global
  ON reorder_thresholds(sku)
  WHERE archived_at IS NULL AND location_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_reorder_thresholds_vendor
  ON reorder_thresholds(vendor_slug, archived_at);
CREATE INDEX IF NOT EXISTS idx_reorder_thresholds_location
  ON reorder_thresholds(location_code, archived_at);

CREATE TABLE IF NOT EXISTS sku_velocity (
  id                 TEXT NOT NULL PRIMARY KEY,
  sku                TEXT NOT NULL,
  location_code      TEXT,
  period_start       INTEGER NOT NULL,
  period_end         INTEGER NOT NULL,
  units_sold         INTEGER NOT NULL CHECK (units_sold >= 0),
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_sku_velocity_sku_period
  ON sku_velocity(sku, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_sku_velocity_sku_loc_period
  ON sku_velocity(sku, location_code, period_end DESC);
