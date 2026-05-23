-- Smart restocking — EOQ-style reorder-quantity recommendation that
-- composes demandForecast (units/day prediction), reorderThresholds
-- (current stock + lead-time-days), costLayers (unit cost for the
-- holding-cost calc) and vendors (lead-time multiplier on safety
-- stock). The factory recomputes on demand; persisted rows give the
-- operator a historical recommendation-vs-actual view.
--
-- Three tables, narrow shapes:
--
--   smart_restocking_policies
--     One row per policy slug (primary key). `holding_cost_bps` is
--     annual carrying cost in basis points of unit cost (250 = 2.50%
--     per year, i.e. warehouse + capital + spoilage). `ordering_cost_minor`
--     is the operator's per-PO ordering overhead in minor currency
--     units (paperwork, vendor onboarding, freight floor). The
--     `default_service_level` enum picks the safety-stock z-score
--     when `recommendOrderQty` isn't passed an explicit service_level.
--
--   smart_restocking_policy_assignments
--     One row per SKU bound to a policy. SKU is the primary key —
--     a SKU belongs to at most one active policy at a time. Re-
--     assigning a SKU overwrites the previous binding (the operator's
--     "switch this SKU to a stricter policy" flow); the previous
--     `assigned_at` is replaced.
--
--   smart_restocking_recommendations
--     Append-only history of every recommendation the primitive
--     computed. The `reasoning_json` column captures the composed
--     inputs (predicted_units, lead_time_days, unit_cost_minor,
--     ordering_cost_minor, holding_cost_bps, service_level, z_score)
--     so the operator's "why did the system suggest 240?" read has a
--     concrete answer per row. Indexes target the per-SKU history
--     window + the global computed_at sweep.

CREATE TABLE IF NOT EXISTS smart_restocking_policies (
  slug                     TEXT NOT NULL PRIMARY KEY,
  holding_cost_bps         INTEGER NOT NULL CHECK (holding_cost_bps >= 0 AND holding_cost_bps <= 100000),
  ordering_cost_minor      INTEGER NOT NULL CHECK (ordering_cost_minor >= 0),
  default_service_level    REAL NOT NULL CHECK (default_service_level IN (0.90, 0.95, 0.99)),
  archived_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smart_restocking_policies_active
  ON smart_restocking_policies(slug) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS smart_restocking_policy_assignments (
  sku            TEXT NOT NULL PRIMARY KEY,
  policy_slug    TEXT NOT NULL,
  assigned_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smart_restocking_assignments_policy
  ON smart_restocking_policy_assignments(policy_slug);

CREATE TABLE IF NOT EXISTS smart_restocking_recommendations (
  id                     TEXT NOT NULL PRIMARY KEY,
  sku                    TEXT NOT NULL,
  location_code          TEXT,
  recommended_qty        INTEGER NOT NULL CHECK (recommended_qty >= 0),
  eoq_qty                INTEGER NOT NULL CHECK (eoq_qty >= 0),
  safety_stock_qty       INTEGER NOT NULL CHECK (safety_stock_qty >= 0),
  reorder_point          INTEGER NOT NULL CHECK (reorder_point >= 0),
  cost_estimate_minor    INTEGER NOT NULL CHECK (cost_estimate_minor >= 0),
  currency               TEXT NOT NULL,
  reasoning_json         TEXT NOT NULL,
  computed_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smart_restocking_recs_sku_time
  ON smart_restocking_recommendations(sku, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_smart_restocking_recs_time
  ON smart_restocking_recommendations(computed_at DESC);
