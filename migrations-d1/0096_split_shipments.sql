-- Split shipments: planned-then-executed multi-parcel fulfillment.
--
-- A single order can produce N parcels — the textbook case is a
-- three-line order with one in-stock SKU plus two backordered SKUs,
-- which splits into a "ship now" parcel for the in-stock line and a
-- "ship later" parcel for the backordered lines. The `shipments`
-- table (migration 0021) already carries the per-parcel rows once
-- they exist; this primitive owns the PLAN — the proposed grouping
-- of order_lines into parcels, the strategy that derived the plan,
-- and the executed/cancelled lifecycle so the operator can audit
-- why an order was split the way it was.
--
-- Strategies:
--   availability — split in-stock from backordered lines (composes
--                  with the `backorder` primitive's pending lines)
--   location     — split by routing strategy from inventoryLocations
--                  (one parcel per source location)
--   vendor       — one parcel per vendor (composes with the vendors
--                  primitive's per-SKU vendor mapping)
--   manual       — operator hands the primitive a pre-grouped plan
--
-- Lifecycle:
--   proposed  — planSplit wrote the plan; no shipment rows yet
--   executed  — executeSplit walked the plan and wrote one
--               `shipments` row per parcel via orderTracking
--   cancelled — operator abandoned the plan before execution; the
--               row is preserved so the audit trail survives
--
-- `plan_json` is the operator-readable serialized plan:
--   `[{ rationale, lines: [{ line_id, qty }] }, ...]`
-- One element per proposed parcel. `line_id` references
-- `order_lines.id`; `qty` is the per-parcel quantity (a single
-- order_line can split across multiple parcels when partial
-- availability lands lines in different parcels).
--
-- `executed_shipment_ids_json` captures the `shipments.id` array
-- returned by executeSplit in the same order as the parcels in
-- `plan_json` — that way `splitsForOrder(...)` can hydrate the
-- shipment rows without a second walk.
--
-- Indexes: `(order_id, status)` covers `splitsForOrder` reads and
-- the "is there an executed plan for this order?" check
-- `executeSplit` does before writing shipment rows.

CREATE TABLE IF NOT EXISTS split_shipment_plans (
  id                          TEXT NOT NULL PRIMARY KEY,
  order_id                    TEXT NOT NULL,
  strategy                    TEXT NOT NULL CHECK (strategy IN (
    'availability', 'location', 'vendor', 'manual'
  )),
  plan_json                   TEXT NOT NULL,
  executed_shipment_ids_json  TEXT,
  status                      TEXT NOT NULL CHECK (status IN (
    'proposed', 'executed', 'cancelled'
  )),
  proposed_at                 INTEGER NOT NULL,
  executed_at                 INTEGER,
  cancelled_at                INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_split_shipment_plans_order
  ON split_shipment_plans(order_id, status);

CREATE INDEX IF NOT EXISTS idx_split_shipment_plans_status
  ON split_shipment_plans(status, proposed_at);
