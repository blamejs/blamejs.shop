-- Auto-replenish — scheduler-driven layer that turns reorder
-- threshold fires into auto-submitted POs against bound vendors.
--
-- Two tables, narrow shapes:
--
--   auto_replenish_policies
--     One row per policy slug (the primary key). The vendor binding
--     is optional — a null vendor_slug means the policy aggregates
--     every candidate vendor on the tick. The schedule column carries
--     metadata only; the operator's cron-trigger orchestrator is the
--     actual clock, and the lib uses `last_run_at + interval` to
--     gate which policies fire on a given tick. `approval_required`
--     is the toggle that holds POs in draft (true) vs auto-submitting
--     them to the vendor (false). The min/max PO value gates and the
--     concurrent-open cap are the safety rails between an operator's
--     trust threshold and a runaway scheduler.
--
--   auto_replenish_runs
--     One row per per-policy decision the scheduler emits. The status
--     CHECK enum distinguishes:
--       proposed  — a candidate set existed but a gate refused (under-
--                   min, over-max, concurrent cap), OR a PO landed in
--                   draft because the policy requires approval
--       submitted — the PO was created AND submitted to the vendor
--                   (approval not required)
--       skipped   — no candidates surfaced, or the bound vendor was
--                   archived
--       failed    — a composition threw (vendor not found, scan
--                   failed, createDraft failed, submitToVendor failed)
--     `po_id` carries the PO row id when one was created (proposed +
--     submitted); null for skipped + failed.
--
-- Indexes target the operator's history-window read (`run_at` range +
-- optional vendor_slug join through the policy table) and the
-- scheduler's batch read (active policies ordered by slug).

CREATE TABLE IF NOT EXISTS auto_replenish_policies (
  slug                     TEXT NOT NULL PRIMARY KEY,
  vendor_slug              TEXT,
  min_po_value_minor       INTEGER NOT NULL CHECK (min_po_value_minor >= 0),
  max_po_value_minor       INTEGER NOT NULL CHECK (max_po_value_minor >= 0),
  max_concurrent_open_pos  INTEGER NOT NULL CHECK (max_concurrent_open_pos > 0),
  approval_required        INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  schedule                 TEXT NOT NULL CHECK (schedule IN ('hourly', 'daily', 'weekly')),
  last_run_at              INTEGER,
  archived_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  CHECK (max_po_value_minor >= min_po_value_minor)
);

CREATE INDEX IF NOT EXISTS idx_auto_replenish_policies_active
  ON auto_replenish_policies(slug) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auto_replenish_policies_vendor
  ON auto_replenish_policies(vendor_slug) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auto_replenish_policies_schedule
  ON auto_replenish_policies(schedule, last_run_at) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS auto_replenish_runs (
  id              TEXT NOT NULL PRIMARY KEY,
  policy_slug     TEXT NOT NULL,
  po_id           TEXT,
  qty_proposed    INTEGER NOT NULL CHECK (qty_proposed >= 0),
  qty_submitted   INTEGER NOT NULL CHECK (qty_submitted >= 0),
  status          TEXT NOT NULL CHECK (status IN ('proposed', 'submitted', 'skipped', 'failed')),
  run_at          INTEGER NOT NULL,
  fail_reason     TEXT,
  CHECK (qty_submitted <= qty_proposed)
);

CREATE INDEX IF NOT EXISTS idx_auto_replenish_runs_policy_time
  ON auto_replenish_runs(policy_slug, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_replenish_runs_status_time
  ON auto_replenish_runs(status, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_replenish_runs_time
  ON auto_replenish_runs(run_at DESC);
