-- Click-and-collect (buy-online-pickup-in-store) — pickup locations and
-- per-order pickup schedules.
--
-- Two tables. The first describes the operator's pickup-eligible
-- locations; the second is the per-order schedule that progresses
-- through a five-state FSM as the customer reserves a slot, the
-- operator confirms the goods are ready, and the customer arrives to
-- collect them.
--
-- `pickup_locations` — operator-managed list of stores that can host a
-- pickup. `code` is the primary key (operators reference the location
-- by stable code in URLs / receipts / picker labels rather than by an
-- opaque UUID). `address_json` carries the structured address (line1
-- / city / region / postal / country) so geo-distance ranking can read
-- one column without joining a sibling table. `hours_json` is the
-- weekly opening schedule (an object keyed by ISO weekday with
-- `{ open, close }` HH:MM strings, or a `closed: true` flag) consulted
-- by `availableLocations` when proposing windows. `capacity_per_hour`
-- caps concurrent pickups in a one-hour window so the front-counter
-- doesn't get swamped. `lead_time_hours` is the minimum gap between
-- the operator confirming the order and the earliest scheduled slot —
-- the picker needs time to actually find the goods. `archived_at`
-- soft-deletes a location without dropping the historical schedule
-- rows (an archived row still satisfies the FK on past pickups but is
-- filtered out of `availableLocations`).
--
-- `pickup_schedules` — one row per order. `order_id` is UNIQUE so a
-- given order schedules exactly one pickup window; rescheduling
-- replaces the row in place (the audit trail lives on the parent
-- order's event log). `status` is a five-state CHECK enum:
--   scheduled  — customer picked a slot at checkout, awaiting operator
--   ready      — operator confirmed goods are available, customer
--                notified, awaiting pickup
--   picked_up  — customer arrived + signed; order delivered (terminal)
--   no_show    — customer didn't arrive; operator escalates after 7d
--                (terminal — the order rolls back via a separate
--                operator action; this primitive only records the
--                state)
--   cancelled  — customer cancelled the pickup before ready (terminal)
-- Distinct timestamp columns (`ready_at`, `picked_up_at`, `no_show_at`)
-- so the FSM history is queryable without joining an event log. The
-- `signature_hash` column holds a SHA3-512 namespace-hashed signature
-- captured at pickup (`namespaceHash("click-and-collect-signature",
-- raw_signature)`) — never the raw signature itself; the operator can
-- prove a hash matches a presented signature without storing PII at
-- rest. `customer_id_proof_kind` is a short label (driver_license /
-- passport / national_id / store_credential / other) so the operator
-- meets the proof-of-identity audit requirement without storing the ID
-- document number.
--
-- Indexes:
--   * `(location_code, status, scheduled_window_start)` — the
--     `pickupsForLocation` read filters by location + status and orders
--     by the slot start time.
--   * `(scheduled_window_start, status)` — the operator-wide "what's
--     ready today" dashboard.
--   * `(order_id)` — already UNIQUE; the implicit unique index covers
--     `customerSchedules` joins.

CREATE TABLE IF NOT EXISTS pickup_locations (
  code               TEXT NOT NULL PRIMARY KEY,
  name               TEXT NOT NULL,
  address_json       TEXT NOT NULL,
  hours_json         TEXT NOT NULL,
  capacity_per_hour  INTEGER NOT NULL CHECK (capacity_per_hour > 0),
  lead_time_hours    INTEGER NOT NULL CHECK (lead_time_hours >= 0),
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pickup_schedules (
  id                       TEXT NOT NULL PRIMARY KEY,
  order_id                 TEXT NOT NULL UNIQUE,
  location_code            TEXT NOT NULL,
  scheduled_window_start   INTEGER NOT NULL,
  scheduled_window_end     INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
                             'scheduled', 'ready', 'picked_up', 'no_show', 'cancelled'
                           )),
  ready_at                 INTEGER,
  picked_up_at             INTEGER,
  no_show_at               INTEGER,
  signature_hash           TEXT,
  customer_id_proof_kind   TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  FOREIGN KEY (location_code) REFERENCES pickup_locations(code)
);

CREATE INDEX IF NOT EXISTS idx_pickup_locations_active
  ON pickup_locations(active, archived_at);

CREATE INDEX IF NOT EXISTS idx_pickup_schedules_loc_status_start
  ON pickup_schedules(location_code, status, scheduled_window_start);

CREATE INDEX IF NOT EXISTS idx_pickup_schedules_start_status
  ON pickup_schedules(scheduled_window_start, status);
