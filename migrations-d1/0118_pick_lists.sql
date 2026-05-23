-- Pick lists: warehouse fulfillment worksheet for converting N open
-- orders into a picker-walkable sequence sorted by aisle/bin.
--
-- The operator's problem: thirty orders just rolled in, each one is a
-- mix of two or three SKUs scattered across different aisles, and a
-- naive "pick each order in turn" walk has the picker criss-crossing
-- the warehouse for half an hour. The fix is to consolidate the open
-- orders into a single sequenced worksheet keyed by aisle position —
-- the picker walks each aisle once, scans every SKU on the route, and
-- the system stitches the picked qty back onto the parent orders.
--
-- Two tables:
--
--   * `pick_lists` — the header. One row per generated worksheet.
--     Four-state CHECK enum:
--       generated   — created from N order_ids at a given location,
--                     line rows captured at generation time; no
--                     picker activity yet
--       in_progress — first confirmLine has landed; the picker is
--                     working the route. Persists for as long as the
--                     worksheet has unconfirmed lines.
--       complete    — every line has been confirmed AND the operator
--                     called markListComplete (which fans out one
--                     orderTracking.createShipment per parent order).
--                     Terminal happy state.
--       cancelled   — operator abandoned the route (re-prioritized,
--                     stock disappeared, picker shift ended).
--                     Terminal sad state; `cancel_reason` captures
--                     the rationale, `cancelled_at` carries the
--                     timestamp.
--     Distinct timestamp columns (`generated_at`, `completed_at`,
--     `cancelled_at`) so the FSM history is queryable without
--     joining a separate event log.
--
--   * `pick_list_lines` — one row per (order_id, sku, variant_id)
--     tuple captured at generateList time. The line carries the
--     `expected_quantity` snapshot pulled from the parent order_line
--     plus an `aisle_position` column the primitive populates from
--     the optional `inventoryLocations.binForSku(sku, location_code)`
--     verb (when wired) or falls back to the sku itself (deterministic,
--     sortable, no fabricated bin data). `actual_quantity` is NULL
--     until the picker scans the line; on confirm `picked_by` +
--     `picked_at` are stamped so the audit answers "who picked what
--     when". A FK CASCADE binds each line to its parent list — if
--     the operator cancels the list, the lines vanish.
--
-- Indexes:
--   * `(location_code, status)` — listLists scopes by both; the
--     status column rides along so the common operator UI ("show me
--     all in-progress lists at WH-EAST") is a single index walk.
--   * `(status, generated_at)` — the unscoped listLists ordering.
--   * `(list_id)` on lines — every fan-out read is keyed by the
--     parent list id.
--   * `(order_id)` on lines — the markListComplete shipment fan-out
--     groups by parent order; the variance / discrepancy report
--     joins lines back to orders by this column.
--   * `(aisle_position)` on lines — the generateList sort writes the
--     rows in aisle order at insert time, but the read-side sort
--     ("show me the route in walk order") benefits from the index
--     for large lists.

CREATE TABLE IF NOT EXISTS pick_lists (
  id                 TEXT NOT NULL PRIMARY KEY,
  location_code      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN (
                       'generated', 'in_progress', 'complete', 'cancelled'
                     )),
  sort_by            TEXT NOT NULL CHECK (sort_by IN (
                       'aisle', 'sku', 'priority', 'order_id'
                     )),
  generated_at       INTEGER NOT NULL,
  completed_at       INTEGER,
  cancelled_at       INTEGER,
  cancel_reason      TEXT
);

CREATE TABLE IF NOT EXISTS pick_list_lines (
  id                 TEXT NOT NULL PRIMARY KEY,
  list_id            TEXT NOT NULL,
  order_id           TEXT NOT NULL,
  sku                TEXT NOT NULL,
  variant_id         TEXT,
  expected_quantity  INTEGER NOT NULL CHECK (expected_quantity > 0),
  actual_quantity    INTEGER          CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
  picked_by          TEXT,
  picked_at          INTEGER,
  aisle_position     TEXT NOT NULL,
  sequence_number    INTEGER NOT NULL CHECK (sequence_number >= 0),
  FOREIGN KEY (list_id) REFERENCES pick_lists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pick_lists_location_status     ON pick_lists(location_code, status);
CREATE INDEX IF NOT EXISTS idx_pick_lists_status_generated    ON pick_lists(status, generated_at);
CREATE INDEX IF NOT EXISTS idx_pick_list_lines_list           ON pick_list_lines(list_id);
CREATE INDEX IF NOT EXISTS idx_pick_list_lines_order          ON pick_list_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_pick_list_lines_aisle          ON pick_list_lines(aisle_position);
CREATE INDEX IF NOT EXISTS idx_pick_list_lines_seq            ON pick_list_lines(list_id, sequence_number);
