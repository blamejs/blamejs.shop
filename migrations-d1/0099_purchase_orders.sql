-- Purchase orders — operator-facing record of goods ordered FROM a
-- vendor / supplier. The lifecycle answers "what did we order, has
-- it been confirmed, when did it land, and how much of it actually
-- showed up." Distinct from the `inventory_receipts` table, which
-- records the physical receipt event in catalog-stock terms — a PO
-- composes inventory-receive at receipt time so the catalog stays
-- the single owner of stock_on_hand mutation while the PO carries
-- the upstream-procurement audit trail.
--
-- Two tables:
--
--   purchase_orders        — one row per PO. `id` is a v7 UUID
--                            (millisecond-prefixed, lexicographically
--                            sortable — B-tree-locality wins on the
--                            PK). `vendor_slug` references the
--                            vendors primitive's `slug` handle; no FK
--                            because the vendors table is owned by a
--                            different migration file and SQLite's
--                            cross-file FK semantics depend on
--                            initialisation order — the primitive's
--                            write path validates the vendor exists +
--                            is not archived before insert. `status`
--                            is the seven-state FSM:
--                              draft               — operator is
--                                                    composing the PO,
--                                                    lines mutable
--                              submitted           — sent to vendor,
--                                                    awaiting
--                                                    confirmation
--                              confirmed           — vendor accepted,
--                                                    awaiting goods
--                              partially_received  — some receipts
--                                                    in, more pending
--                              received            — every line fully
--                                                    received (qty
--                                                    matches qty
--                                                    ordered)
--                              closed              — terminal happy
--                                                    path; finalised
--                                                    after receipt
--                              cancelled           — terminal sad
--                                                    path; refuses
--                                                    further mutation
--                            `expected_delivery` is operator-supplied
--                            estimated arrival (epoch ms). nullable —
--                            not every operator captures it.
--                            `vendor_reference` is the vendor's
--                            confirmation number / acknowledgement id
--                            captured at confirm time. `notes` is
--                            free-form operator prose capped at 4000
--                            chars at the application layer.
--                            Timestamps stamp every FSM transition
--                            individually so the audit trail records
--                            when each beat happened, not just the
--                            most recent state change.
--
--   purchase_order_lines   — one row per SKU on the PO. `po_id` FK
--                            ON DELETE CASCADE — if the parent PO is
--                            hard-deleted (operator-side migration,
--                            never via this primitive's surface) the
--                            lines clear too. `quantity_ordered` is
--                            captured at draft / update time;
--                            `quantity_received` accumulates as
--                            recordPartialReceipt lands. The receipt
--                            primitive caps the increment at
--                            ordered - received so the operator
--                            can't over-receive against a PO line
--                            (a vendor that ships more than ordered
--                            is a separate problem the operator
--                            opens a new PO for). `unit_cost_minor`
--                            is the captured-at-draft per-unit cost
--                            in minor currency units; updated by
--                            recordPartialReceipt iff the operator
--                            passes a revised cost (the vendor may
--                            invoice at a different rate than
--                            quoted, in which case the PO line
--                            preserves the actual landed cost).
--                            `currency` is 3-letter ISO 4217.
--
-- The receipt cascade into the inventory-receive primitive lives in
-- application code: recordPartialReceipt composes the injected
-- inventoryReceive.draft + .apply so the catalog's inventory table
-- gets the restock alongside the PO's per-line counter advancing.

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                  TEXT NOT NULL PRIMARY KEY,
  vendor_slug         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
    'draft', 'submitted', 'confirmed', 'partially_received',
    'received', 'closed', 'cancelled'
  )),
  expected_delivery   INTEGER,
  vendor_reference    TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  submitted_at        INTEGER,
  submitted_by        TEXT,
  confirmed_at        INTEGER,
  closed_at           INTEGER,
  cancelled_at        INTEGER,
  cancel_reason       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
  ON purchase_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor
  ON purchase_orders(vendor_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor_status
  ON purchase_orders(vendor_slug, status, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                  TEXT NOT NULL PRIMARY KEY,
  po_id               TEXT NOT NULL,
  sku                 TEXT NOT NULL,
  quantity_ordered    INTEGER NOT NULL CHECK (quantity_ordered > 0),
  quantity_received   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost_minor     INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0),
  currency            TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po
  ON purchase_order_lines(po_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_sku
  ON purchase_order_lines(sku);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_order_lines_po_sku
  ON purchase_order_lines(po_id, sku);
