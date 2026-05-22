-- Inventory receipts: bulk stock receipt with per-receipt audit trail.
--
-- The catalog `inventory` table tracks per-SKU stock; the existing
-- `inventory.restock(sku, qty)` verb mutates stock_on_hand one SKU
-- at a time. Operators receiving a shipment (e.g. a PO with thirty
-- SKUs landing on the dock) need a single record that groups every
-- line, persists the supplier + reference + cost, and applies the
-- whole batch as an atomic operation — and reverses the same way
-- when the shipment turns out to be wrong.
--
-- Schema decisions:
--   * `inventory_receipts.id` is a v7 UUID (millisecond-prefixed,
--     lexicographically sortable — B-tree-locality wins on the PK).
--   * `reference` is the operator-supplied PO number / receipt
--     number / shipping manifest id. UNIQUE so the same physical
--     shipment can't be double-entered. Operators control the
--     namespace; the primitive validates length + shape only.
--   * `status` is a three-state enum: pending (drafted, lines
--     captured, no stock mutation yet), applied (stock mutated),
--     reversed (mutation undone). Idempotent re-apply on already-
--     applied is a no-op; re-reverse on already-reversed refuses.
--   * `total_qty` + `total_value_minor` are cached aggregates of
--     the line items (line.qty * line.unit_cost_minor summed), set
--     at draft time so the listing / admin UI doesn't have to
--     re-aggregate per row.
--   * Money is INTEGER minor units, currency is TEXT 3-letter ISO
--     4217 — same convention the rest of the schema uses.
--   * `notes` is capped at 4000 chars at the application layer;
--     the column is unbounded TEXT so operator-friendly prose
--     fits without truncation surprises.

CREATE TABLE IF NOT EXISTS inventory_receipts (
  id                 TEXT NOT NULL PRIMARY KEY,
  reference          TEXT NOT NULL,
  supplier           TEXT NOT NULL DEFAULT '',
  received_by        TEXT NOT NULL DEFAULT '',
  received_at        INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'reversed')),
  total_qty          INTEGER NOT NULL DEFAULT 0 CHECK (total_qty >= 0),
  total_value_minor  INTEGER NOT NULL DEFAULT 0 CHECK (total_value_minor >= 0),
  total_currency     TEXT NOT NULL DEFAULT 'USD' CHECK (length(total_currency) = 3),
  notes              TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (reference)
);

CREATE TABLE IF NOT EXISTS inventory_receipt_lines (
  id                  TEXT NOT NULL PRIMARY KEY,
  receipt_id          TEXT NOT NULL,
  sku                 TEXT NOT NULL,
  qty_received        INTEGER NOT NULL CHECK (qty_received > 0),
  unit_cost_minor     INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0),
  unit_cost_currency  TEXT NOT NULL DEFAULT 'USD' CHECK (length(unit_cost_currency) = 3),
  notes               TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (receipt_id) REFERENCES inventory_receipts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_receipts_received_at  ON inventory_receipts(received_at);
CREATE INDEX IF NOT EXISTS idx_inventory_receipts_status       ON inventory_receipts(status);
CREATE INDEX IF NOT EXISTS idx_inventory_receipt_lines_receipt ON inventory_receipt_lines(receipt_id);
CREATE INDEX IF NOT EXISTS idx_inventory_receipt_lines_sku     ON inventory_receipt_lines(sku);
