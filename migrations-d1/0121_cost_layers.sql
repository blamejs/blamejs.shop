-- Cost layers: FIFO / LIFO / weighted-average inventory cost
-- accounting.
--
-- The catalog tracks how many units are on the shelf; the cost-layers
-- primitive tracks WHAT EACH UNIT COST so the accountant can answer
-- "if we sold 5 widgets today, what was the cost of goods sold?" with
-- the same precision the warehouse answers "how many widgets do we
-- have?".
--
-- A receipt event (purchase from supplier, transfer-in from another
-- location, positive stock adjustment with cost info) creates a new
-- cost layer with `quantity_remaining` initialized to the received
-- quantity. A sale event consumes from one or more layers depending
-- on the costing method active for the SKU at sale time:
--
--   * fifo             — oldest layer first
--   * lifo             — newest layer first
--   * weighted_average — every consumed unit costs the
--                        weighted-average of the currently-on-hand
--                        layers; layers are debited proportionally
--                        so `quantity_remaining` still represents
--                        the residual count
--
-- Each consumption writes a row to `cogs_attributions` so the
-- accountant can join order_id back to per-layer unit costs.
-- Reversals (returns / refunds) add stock back as a fresh layer at
-- the original unit cost so the inventory valuation stays honest.
--
-- Three tables:
--
--   * sku_costing_methods — one row per SKU declaring which method
--     governs that SKU. SKUs without a row default to weighted_average
--     at the primitive layer (the operator's accountant can override
--     per SKU; the default is the least surprising choice for a shop
--     that hasn't formalized its inventory accounting policy).
--
--   * cost_layers — append-only insert at receipt time; UPDATE
--     decrements `quantity_remaining` at sale time. Layers with
--     `quantity_remaining = 0` are preserved (the audit trail needs
--     the full history; the FIFO / LIFO queries skip them via the
--     `quantity_remaining > 0` filter). `currency` ride-along so a
--     multi-currency operator can keep purchase costs in the
--     supplier's currency without forcing a conversion at receipt
--     time (the conversion happens at COGS reporting time, against
--     the operator's chart-of-accounts FX policy).
--
--   * cogs_attributions — one row per (order_id, line_id, layer)
--     tuple. A sale that crosses two layers writes two attribution
--     rows. Reads sum these rows for per-order / per-period COGS
--     reports.
--
-- Indexes:
--   * cost_layers (sku, occurred_at) — FIFO/LIFO ORDER BY scan
--   * cost_layers (sku, quantity_remaining) — currentLayers walk
--     restricted to the active subset; reconcile / audit reads
--   * cogs_attributions (order_id) — cogsForOrder lookup
--   * cogs_attributions (occurred_at) — cogsForPeriod range scan

CREATE TABLE IF NOT EXISTS sku_costing_methods (
  sku             TEXT NOT NULL PRIMARY KEY,
  method          TEXT NOT NULL CHECK (method IN (
                    'fifo', 'lifo', 'weighted_average'
                  )),
  set_at          INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_layers (
  id                  TEXT NOT NULL PRIMARY KEY,
  sku                 TEXT NOT NULL,
  quantity_received   INTEGER NOT NULL CHECK (quantity_received > 0),
  quantity_remaining  INTEGER NOT NULL CHECK (quantity_remaining >= 0),
  unit_cost_minor     INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  currency            TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN (
                        'receipt', 'transfer', 'adjustment', 'reversal'
                      )),
  source_ref          TEXT,
  occurred_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cogs_attributions (
  id                  TEXT NOT NULL PRIMARY KEY,
  order_id            TEXT NOT NULL,
  line_id             TEXT NOT NULL,
  sku                 TEXT NOT NULL,
  layer_id            TEXT NOT NULL,
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  unit_cost_minor     INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  currency            TEXT NOT NULL,
  reversed            INTEGER NOT NULL DEFAULT 0 CHECK (reversed IN (0, 1)),
  reversal_reason     TEXT,
  occurred_at         INTEGER NOT NULL,
  FOREIGN KEY (layer_id) REFERENCES cost_layers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_cost_layers_sku_occurred       ON cost_layers(sku, occurred_at);
CREATE INDEX IF NOT EXISTS idx_cost_layers_sku_remaining      ON cost_layers(sku, quantity_remaining);
CREATE INDEX IF NOT EXISTS idx_cogs_attributions_order        ON cogs_attributions(order_id);
CREATE INDEX IF NOT EXISTS idx_cogs_attributions_occurred     ON cogs_attributions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_cogs_attributions_sku          ON cogs_attributions(sku);
