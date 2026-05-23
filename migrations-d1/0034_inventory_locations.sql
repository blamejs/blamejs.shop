-- Inventory locations: multi-warehouse per-SKU stock + routing.
--
-- The catalog `inventory` table tracks one stock_on_hand per SKU —
-- enough when the operator ships from a single bucket. Once a
-- second physical location enters the picture (a retail store with
-- its own counter, a dropship supplier whose stock the operator
-- promises but doesn't move, a regional warehouse closer to the
-- customer than the main one), the single bucket loses fidelity:
-- the routing layer can't ask "which location has this SKU and is
-- cheapest to ship from?" and the receiving layer can't say "this
-- shipment landed at WH-EAST, not WH-WEST."
--
-- Schema decisions:
--   * `inventory_locations.code` is the operator-chosen short id
--     (e.g. `WH-EAST`, `STORE-NYC`). Operators reference locations
--     by code in every downstream verb — `setStock(sku,
--     location_code, qty)`, `transferStock(... from_location ...)`
--     — so the code IS the primary key. UUIDs would force the
--     operator to look up + paste a 36-char string into every
--     transfer; the trade-off (operator can rename a typo'd code
--     only via UPDATE) is acceptable for an operator-controlled
--     identifier.
--   * `type` is a three-state CHECK enum: warehouse (operator-
--     owned stock that the operator picks + ships), retail (an
--     in-store counter — stock is real but routing usually prefers
--     warehouses unless the customer is local), dropship (supplier-
--     held stock — the operator commits to ship without ever
--     touching the box). The primitive uses `type` for default
--     routing-priority weighting; operators that want a different
--     weighting override via explicit `priority`.
--   * `priority` is INTEGER, lower-first. Operators set the global
--     pick order (1 = first picked; 100 = last). The default
--     `priority-fill` routing strategy walks active locations in
--     ascending priority order, allocating each SKU greedily until
--     the line is full. Ties broken by `code` ASC for determinism.
--   * `address_json` is the location's postal address as a JSON
--     string. The primitive doesn't parse it directly — it's stored
--     so the `nearest-by-postal-prefix` routing strategy can pull
--     out the postal code and match against an operator-supplied
--     destination prefix, and so admin UIs can render it without
--     a second lookup. NULL allowed (dropship suppliers often
--     don't expose a single canonical address).
--   * `active` is BOOLEAN (stored as INTEGER 0/1). Inactive
--     locations are skipped by every routing strategy and don't
--     appear in `listLocations({ active_only: true })`. The row
--     stays in the table so historical adjustments still resolve.
--
--   * `inventory_stock` is the (sku, location_code) -> quantity
--     join table. Composite PK so the upsert path is a single
--     INSERT ... ON CONFLICT (sku, location_code) DO UPDATE. The
--     `quantity` column is CHECK >= 0 — the primitive never
--     persists negative stock; allocation strategies that would
--     drive a location negative push the unmet qty onto
--     `unfulfillable` instead.
--   * `inventory_adjustments` is the append-only audit log: every
--     setStock / adjustStock / transferStock writes a row capturing
--     who-set-what-when-why. The `delta` column carries the signed
--     change (positive on receive / transfer-in, negative on
--     transfer-out / sale). `reason` is operator-supplied free
--     text capped at 256 chars at the application layer. The id
--     is a v7 UUID so the audit log sorts by insertion order
--     without a separate timestamp index.

CREATE TABLE IF NOT EXISTS inventory_locations (
  code           TEXT NOT NULL PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('warehouse', 'retail', 'dropship')),
  address_json   TEXT,
  priority       INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_stock (
  sku            TEXT NOT NULL,
  location_code  TEXT NOT NULL,
  quantity       INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (sku, location_code),
  FOREIGN KEY (location_code) REFERENCES inventory_locations(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id             TEXT NOT NULL PRIMARY KEY,
  sku            TEXT NOT NULL,
  location_code  TEXT NOT NULL,
  delta          INTEGER NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  occurred_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_locations_priority      ON inventory_locations(priority);
CREATE INDEX IF NOT EXISTS idx_inventory_locations_active        ON inventory_locations(active);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_sku               ON inventory_stock(sku);
CREATE INDEX IF NOT EXISTS idx_inventory_stock_location          ON inventory_stock(location_code);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_sku         ON inventory_adjustments(sku);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_location    ON inventory_adjustments(location_code);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_occurred_at ON inventory_adjustments(occurred_at);
