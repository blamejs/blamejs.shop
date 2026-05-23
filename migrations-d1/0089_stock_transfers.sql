-- Stock transfers: audited multi-step stock movement between
-- inventory locations.
--
-- The `inventory-locations` primitive already ships
-- `transferStock({ sku, from_location, to_location, quantity })` — a
-- single atomic two-row write that moves stock instantly. That verb
-- is the right primitive when the operator is correcting a typo, or
-- moving stock between two bins inside the same warehouse, where the
-- "in transit" window doesn't exist.
--
-- This primitive is the COUNTERPART for moves that actually take
-- physical time: a pallet leaves WH-EAST on Monday, lives on a truck
-- for three days, lands at WH-WEST on Thursday. The operator wants:
--
--   * The shelf at WH-EAST to be debited immediately (so storefront
--     routing doesn't keep selling stock that's on a truck).
--   * The shelf at WH-WEST to be credited only when receiving
--     scans confirm the qty.
--   * A discrepancy flag when the received qty doesn't match the
--     shipped qty (loss, damage, mis-pick at origin).
--   * An audit trail of every state change with operator-supplied
--     reasons, so the variance reconciliation has a paper trail.
--
-- Three tables:
--
--   * `stock_transfers` — the header. One row per transfer. Six-
--     state CHECK enum:
--       open       — created, origin stock decremented, not yet picked up
--       shipped    — picked up by the carrier, tracking number captured
--       in_transit — explicit "we know it left the building" beat
--       received   — destination has scanned the inbound pallet; per-
--                    line received quantities captured but not yet
--                    reconciled into stock
--       reconciled — destination stock incremented, discrepancies (if
--                    any) flagged on the line rows; terminal happy state
--       exception  — lost / damaged / disputed — terminal sad state
--     `carrier` + `tracking_number` are NULL until `markShipped`.
--     `expected_eta` is operator-supplied at open time, NULL allowed
--     (a transfer between adjacent warehouses might not bother).
--     Distinct timestamp columns (`opened_at`, `shipped_at`,
--     `received_at`, `reconciled_at`) so the FSM history is queryable
--     without joining the event log.
--
--   * `stock_transfer_lines` — one row per SKU in the transfer.
--     `quantity_shipped` is captured at open time (the operator's
--     intent). `quantity_received` is NULL until `markReceived`;
--     `discrepancy` is computed as `quantity_shipped - quantity_received`
--     at reconcile time and stored so the operator's variance report
--     doesn't re-compute it on every read. Negative discrepancy = the
--     destination received MORE than the operator shipped (rare but
--     possible — operator mis-counted at origin). Positive = short
--     ship (the common case).
--
--   * `stock_transfer_events` — append-only audit log. One row per
--     state transition, plus per-location scan beats so the operator
--     can ask "where was this pallet on Tuesday?" without inferring
--     from timestamp columns. `event_type` is free-text from the
--     primitive (open / ship / in_transit / receive / reconcile /
--     exception) so future event types don't require a CHECK-enum
--     migration. `detail_json` carries the structured payload
--     (received_lines for receive, exception_reason for exception,
--     etc.) so downstream tooling reads a single column rather than
--     a polymorphic per-event-type table.
--
-- Indexes:
--   * `(from_location, status)` and `(to_location, status)` — the
--     `transfersForLocation` read filters by one or the other; the
--     status column rides along so `listOpen` is a pure index walk.
--   * `(status, opened_at)` — `listOpen` orders by opened_at DESC
--     within the open / shipped / in_transit / received subset.
--   * `(transfer_id)` on lines + events — every fan-out read is keyed
--     by the parent transfer id.

CREATE TABLE IF NOT EXISTS stock_transfers (
  id                 TEXT NOT NULL PRIMARY KEY,
  from_location      TEXT NOT NULL,
  to_location        TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN (
                       'open', 'shipped', 'in_transit', 'received', 'reconciled', 'exception'
                     )),
  reason             TEXT NOT NULL DEFAULT '',
  expected_eta       INTEGER,
  carrier            TEXT,
  tracking_number    TEXT,
  opened_at          INTEGER NOT NULL,
  shipped_at         INTEGER,
  received_at        INTEGER,
  reconciled_at      INTEGER,
  exception_reason   TEXT
);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id                 TEXT NOT NULL PRIMARY KEY,
  transfer_id        TEXT NOT NULL,
  sku                TEXT NOT NULL,
  quantity_shipped   INTEGER NOT NULL CHECK (quantity_shipped > 0),
  quantity_received  INTEGER          CHECK (quantity_received IS NULL OR quantity_received >= 0),
  discrepancy        INTEGER,
  FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stock_transfer_events (
  id                 TEXT NOT NULL PRIMARY KEY,
  transfer_id        TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  location           TEXT,
  detail_json        TEXT,
  occurred_at        INTEGER NOT NULL,
  FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_status     ON stock_transfers(from_location, status);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_status       ON stock_transfers(to_location, status);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_status_opened   ON stock_transfers(status, opened_at);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_transfer   ON stock_transfer_lines(transfer_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_sku        ON stock_transfer_lines(sku);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_events_transfer  ON stock_transfer_events(transfer_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_events_occurred  ON stock_transfer_events(occurred_at);
