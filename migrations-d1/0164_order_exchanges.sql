-- Order exchanges: customer-requested item swap, distinct from a full
-- refund through `returns`. The customer ships back the original
-- merchandise AND receives a different item (different SKU, different
-- variant, or different quantity).
--
-- An exchange row tracks one customer-initiated swap against an
-- `orders` row + a specific `order_lines` row. The lifecycle is a
-- six-state FSM walked at the application tier (lib/order-exchanges.js):
--
--     pending   --approve-----> approved --markReplacementShipped-->  shipped
--           \                          \                                |
--            \                          --reject--> rejected (terminal) |
--             --reject--> rejected (terminal)                           |
--                                                                       v
--                                                  +---markReplacementDelivered--+
--                                                  |                             |
--                                                  v                             v
--                                            delivered                       received
--                                                  \         (markReturnReceived)
--                                                   +--closeExchange--> closed
--
--   * shipped         — replacement is in transit to the customer
--   * delivered       — replacement has reached the customer
--   * received        — the customer's return has reached the warehouse
--                       (both sides may land in either order; the
--                       application tier tolerates both delivered-first
--                       and received-first arrivals before closeExchange
--                       collapses them into the terminal `closed` state)
--   * closed          — both the replacement is delivered AND the
--                       customer's return is back at the warehouse;
--                       terminal
--   * rejected        — operator refused the exchange (terminal)
--
-- Distinct timestamp columns (`shipped_at`, `delivered_at`,
-- `returned_at`, `closed_at`) so the FSM history is queryable
-- without joining an event log.
--
-- `replacement_variant_id` is nullable because an exchange may be
-- "same SKU, replace a defective unit" — no variant change. When the
-- customer wants a different size / colour the variant id pins the
-- specific shelf to debit through the composed inventoryAllocations
-- handle at approval time.
--
-- `tracking_number` + `carrier` capture the outbound shipment so the
-- storefront's order-detail page can surface a tracking link without
-- joining a separate shipments table. They populate at
-- markReplacementShipped time and never mutate after.
--
-- Indexes:
--   * `(order_id)` — exchangesForOrder reads.
--   * `(status, created_at)` — operator queue ("what's open?").
--   * `(approver_id)` — operator-by-operator throughput metrics.

CREATE TABLE IF NOT EXISTS order_exchanges (
  id                      TEXT NOT NULL PRIMARY KEY,
  order_id                TEXT NOT NULL,
  line_id                 TEXT NOT NULL,
  return_sku              TEXT NOT NULL,
  return_qty              INTEGER NOT NULL CHECK (return_qty > 0),
  replacement_sku         TEXT NOT NULL,
  replacement_variant_id  TEXT,
  replacement_qty         INTEGER NOT NULL CHECK (replacement_qty > 0),
  reason                  TEXT NOT NULL CHECK (reason IN (
                            'defective', 'wrong-item', 'wrong-size',
                            'wrong-colour', 'damaged-in-transit',
                            'not-as-described', 'other'
                          )),
  status                  TEXT NOT NULL CHECK (status IN (
                            'pending', 'approved', 'shipped',
                            'delivered', 'received', 'closed', 'rejected'
                          )),
  approver_id             TEXT,
  reject_reason           TEXT,
  tracking_number         TEXT,
  carrier                 TEXT,
  shipped_at              INTEGER,
  delivered_at            INTEGER,
  returned_at             INTEGER,
  closed_at               INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_order_exchanges_order
  ON order_exchanges(order_id);

CREATE INDEX IF NOT EXISTS idx_order_exchanges_status_created
  ON order_exchanges(status, created_at);

CREATE INDEX IF NOT EXISTS idx_order_exchanges_approver
  ON order_exchanges(approver_id);
