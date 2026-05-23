-- Inventory audits: periodic full-inventory audits — year-end /
-- quarter-end / spot — that capture a comprehensive snapshot of the
-- shelf and reconcile it against expected stock. Distinct from
-- `cycle_counts` (rolling): cycle counts pick a subset on a cadence;
-- audits walk every SKU in scope in a single window.
--
-- Three kinds:
--
--   * full      — every SKU at every covered location. Long-running;
--                 the operator typically schedules this during the
--                 year-end closure window.
--   * quarterly — every SKU at every covered location, scoped to the
--                 quarter-end reconciliation window. Same shape as
--                 full; the enum distinguishes them so the dashboard's
--                 cadence reports separate annual vs. quarterly
--                 variance trends.
--   * spot      — a focused audit on a category / vendor / single
--                 location. Operator-supplied scope; not driven by
--                 the rotating-cadence machinery in cycle_counts.
--
-- Four-state FSM (open / in_progress / finalized / cancelled):
--
--   open        — header created via openAudit; no scan lines yet.
--   in_progress — first recordScanLine call has landed.
--   finalized   — operator stopped scanning, variance computed,
--                 adjustments optionally written through
--                 inventoryLocations.adjustStock with reason
--                 "inventory-audit:<slug>".
--   cancelled   — operator abandoned the audit (rescheduled, replaced
--                 by a fresh slug). Scan rows survive for forensic
--                 review (FK CASCADE only fires on parent DELETE).
--
-- Two tables:
--
--   * `inventory_audits` — the header. One row per audit, keyed by
--     UUID id with operator-chosen `slug` as the unique business key.
--     `scope` is a CHECK enum (all / category / vendor / location);
--     `location_codes_json` is the per-audit list of locations the
--     scan covers (NULL when the audit walks every wired location).
--     `variance_count` + `variance_value_minor` are NULL until
--     finalize; the primitive fills them in-place so the operator
--     dashboard's variance report doesn't recompute on every read.
--
--   * `inventory_audit_lines` — one row per scanned (sku, location_code)
--     pair. `expected_qty` snapshots the shelf at scan time;
--     `counted_qty` is the operator-recorded count; `recount_qty` +
--     `recounted_by` + `recounted_at` are non-NULL only on lines where
--     a recount overrode the original count. `variance = (recount_qty
--     OR counted_qty) - expected_qty`, stamped at finalize time so
--     subsequent reads don't recompute.
--
-- Indexes:
--   * `(slug)` UNIQUE — slug lookup for openAudit + getAudit.
--   * `(status, scheduled_at)` — listAudits dashboard pages by status
--     and date.
--   * `(kind)` — listAudits narrowed by kind.
--   * `(audit_id)` on lines — every fan-out read is keyed by parent.
--   * `(sku)` on lines — historyForSku walks every audit that
--     touched a SKU.
--   * `(audit_id, sku, location_code)` UNIQUE — one scan row per
--     (audit, sku, location) so re-scanning the same SKU overwrites
--     rather than appending.

CREATE TABLE IF NOT EXISTS inventory_audits (
  id                    TEXT NOT NULL PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,
  kind                  TEXT NOT NULL CHECK (kind IN ('full', 'quarterly', 'spot')),
  scope                 TEXT NOT NULL CHECK (scope IN ('all', 'category', 'vendor', 'location')),
  scheduled_at          INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'open', 'in_progress', 'finalized', 'cancelled'
                        )),
  variance_count        INTEGER,
  variance_value_minor  INTEGER,
  finalized_at          INTEGER,
  cancelled_at          INTEGER,
  cancel_reason         TEXT,
  location_codes_json   TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_audit_lines (
  id            TEXT NOT NULL PRIMARY KEY,
  audit_id      TEXT NOT NULL,
  sku           TEXT NOT NULL,
  location_code TEXT,
  expected_qty  INTEGER NOT NULL,
  counted_qty   INTEGER NOT NULL,
  recount_qty   INTEGER,
  recounted_by  TEXT,
  recounted_at  INTEGER,
  variance      INTEGER,
  counted_by    TEXT NOT NULL,
  counted_at    INTEGER NOT NULL,
  FOREIGN KEY (audit_id) REFERENCES inventory_audits(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_audits_status_scheduled  ON inventory_audits(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_inventory_audits_kind              ON inventory_audits(kind);
CREATE INDEX IF NOT EXISTS idx_inventory_audits_scheduled         ON inventory_audits(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_lines_audit_id     ON inventory_audit_lines(audit_id);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_lines_sku          ON inventory_audit_lines(sku);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_audit_lines_audit_sku_loc
  ON inventory_audit_lines(audit_id, sku, IFNULL(location_code, ''));
