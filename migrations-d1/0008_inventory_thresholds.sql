-- Inventory low-stock alerts.
--
-- Extends the existing `inventory` table with an optional per-SKU
-- low-stock threshold and introduces a sibling `inventory_alerts`
-- table that records every time a SKU's available stock
-- (`stock_on_hand - stock_held`) drops below its threshold.
--
-- Schema decisions:
--   * `low_stock_threshold` is NULL by default — the alert path is
--     opt-in per SKU. A NULL threshold means "never alert".
--   * `inventory_alerts.sku` is a loose FK (no DB-level FOREIGN KEY)
--     because inventory rows can be deleted independently of the
--     alert history. Operators keep the audit trail even after a SKU
--     retires.
--   * `available_at_alert` captures the computed
--     `stock_on_hand - stock_held` at fire time, so a later restock
--     doesn't rewrite the historical signal.
--   * `fired_at` is INTEGER epoch milliseconds for sort + range
--     queries; the `(sku, fired_at)` composite index is the index
--     the alert-list admin route uses.

ALTER TABLE inventory ADD COLUMN low_stock_threshold INTEGER;

CREATE TABLE IF NOT EXISTS inventory_alerts (
  id                  TEXT NOT NULL PRIMARY KEY,
  sku                 TEXT NOT NULL,
  available_at_alert  INTEGER NOT NULL,
  threshold           INTEGER NOT NULL,
  fired_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_alerts_sku_fired ON inventory_alerts(sku, fired_at);
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_fired_at  ON inventory_alerts(fired_at);
