-- Backorder: out-of-stock SKUs the operator opts in for advance
-- ordering. The catalog's `inventory.stock_on_hand` is the source of
-- truth for "do we have it on the shelf right now"; backorder layers
-- on top so the answer "we don't have it on the shelf, but we'll
-- ship it by <date>" can be offered without lying to the customer
-- and without driving stock_on_hand negative.
--
-- Two tables:
--   * `backorder_skus` — per-SKU config (one row per backorderable
--     SKU). Operator opts a SKU in via `markBackorderable(...)`;
--     opts it out via `markNotBackorderable(...)` (sets active=0,
--     row preserved so historical backorder lines still resolve
--     their config). Caps the in-flight backorder quantity via
--     `max_quantity` (NULL = unlimited). `pending_quantity` is a
--     cached counter incremented on `recordBackorder` and decremented
--     on `fulfillBackorder` / `cancelBackorder` so the cap check is
--     a single read, not a COUNT(*) aggregate.
--   * `backorder_lines` — one row per backordered order-line at
--     checkout time. Three-state CHECK enum
--     (pending / fulfilled / cancelled). `reason` carries operator-
--     supplied prose for the cancellation case; NULL on pending +
--     fulfilled rows. Distinct timestamp columns
--     (`created_at`, `fulfilled_at`, `cancelled_at`) so the audit
--     trail captures when each transition happened — NULL until the
--     respective transition occurs.
--
-- Indexes:
--   * `(status, expected_ship_date)` — `arrivalsThisWeek` reads
--     pending lines joined to the per-SKU expected_ship_date; the
--     query plan walks this index in date order without a full
--     table scan.
--   * `(customer_id, status)` — `customerBackorders` reads scoped to
--     one customer in created_at desc order; the index covers the
--     filter, the ORDER BY uses the v7-uuid PK lexicographic order.
--   * `(sku, status)` — `pendingForSku` reads scoped to one SKU; the
--     same shape covers the cap-enforcement check in
--     `recordBackorder` (count pending rows for the SKU).

CREATE TABLE IF NOT EXISTS backorder_skus (
  sku                 TEXT NOT NULL PRIMARY KEY,
  max_quantity        INTEGER          CHECK (max_quantity IS NULL OR max_quantity >= 0),
  expected_ship_date  INTEGER NOT NULL,
  message             TEXT NOT NULL DEFAULT '',
  pending_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (pending_quantity >= 0),
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backorder_lines (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  sku           TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  fulfilled_at  INTEGER,
  cancelled_at  INTEGER,
  UNIQUE (order_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_backorder_skus_active                  ON backorder_skus(active);
CREATE INDEX IF NOT EXISTS idx_backorder_lines_status_expected        ON backorder_lines(status);
CREATE INDEX IF NOT EXISTS idx_backorder_lines_customer_status        ON backorder_lines(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_backorder_lines_sku_status             ON backorder_lines(sku, status);
