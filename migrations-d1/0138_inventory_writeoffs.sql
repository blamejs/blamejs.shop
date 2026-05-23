-- Inventory write-offs: operator-recorded events that take stock OUT
-- of the system without a sale. Composes inventoryLocations.adjustStock
-- to debit the shelf and (optionally) costLayers.consumeForSale to
-- account for the cost-impact when COGS reporting is wired.
--
-- Reasons (CHECK enum) — operator picks one per write-off:
--   damaged          — physical damage at the shelf
--   lost             — operator believes stock left without record
--   shrinkage        — periodic adjustment for unattributed loss
--                      (the shrinkage report bucket distinct from
--                      lost/theft)
--   expired          — perishable / dated stock past sell-by
--   recall           — supplier or regulatory recall pulled the unit
--   sample           — given away as a marketing / influencer sample
--   quality_control  — destroyed during QC testing
--   theft            — known or suspected theft (operator-attested)
--
-- Status (CHECK enum):
--   recorded  — the write-off landed; stock has been debited
--   reversed  — the operator reversed it (e.g. miscounted, found the
--               unit), restoring stock + appending a fresh cost layer
--               via costLayers.recordReversal when wired
--
-- `location_code` is nullable — a write-off without a location_code
-- represents global-catalog stock (operators that don't run per-shelf
-- inventory just zero-out a SKU's count). With a location_code, only
-- that shelf is debited.
--
-- `cost_impact_minor` + `currency` are NULL when costLayers wasn't
-- injected at create-time, OR when no on-hand cost layers existed for
-- the SKU at write-off time (operator hasn't recorded any receipts
-- yet). When populated, they're the COGS-equivalent value of the
-- destroyed stock — every cost-impact report joins this column to
-- answer "how much shrinkage cost us in Q3?".
--
-- Indexes:
--   * `(occurred_at)` — listWriteoffs default ordering + period
--     filters for costImpactForPeriod.
--   * `(reason, occurred_at)` — narrowed period filters by reason.
--   * `(location_code, occurred_at)` — narrowed listWriteoffs by
--     location.
--   * `(sku)` — historyForSku-shaped joins (the storefront analytics
--     dashboard joins this to per-SKU loss reports).
--   * `(status)` — distinguishing live vs reversed rows on the
--     dashboard.

CREATE TABLE IF NOT EXISTS inventory_writeoffs (
  id                  TEXT NOT NULL PRIMARY KEY,
  sku                 TEXT NOT NULL,
  location_code       TEXT,
  quantity            INTEGER NOT NULL,
  reason              TEXT NOT NULL CHECK (reason IN (
                        'damaged', 'lost', 'shrinkage', 'expired',
                        'recall', 'sample', 'quality_control', 'theft'
                      )),
  actor               TEXT NOT NULL,
  notes               TEXT,
  cost_impact_minor   INTEGER,
  currency            TEXT,
  status              TEXT NOT NULL CHECK (status IN ('recorded', 'reversed')),
  reversed_at         INTEGER,
  reverse_reason      TEXT,
  occurred_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_occurred_at
  ON inventory_writeoffs(occurred_at);
CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_reason_occurred_at
  ON inventory_writeoffs(reason, occurred_at);
CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_location_occurred_at
  ON inventory_writeoffs(location_code, occurred_at);
CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_sku
  ON inventory_writeoffs(sku);
CREATE INDEX IF NOT EXISTS idx_inventory_writeoffs_status
  ON inventory_writeoffs(status);
