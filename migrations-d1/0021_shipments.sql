-- Shipments + shipment_events: post-order fulfillment tracking.
--
-- A single order can produce multiple shipments (split-shipment
-- support: backorders, multi-warehouse picks, partial dispatch).
-- Each row in `shipments` carries the carrier, tracking number,
-- weight, cost, and the lifecycle status. `shipment_events` is the
-- per-shipment audit log of carrier scans / operator updates — one
-- row per status change with the carrier-reported location + detail
-- captured verbatim.
--
-- Status lifecycle:
--   pending           — row created, no carrier label yet
--   label-created     — operator generated the shipping label
--   in-transit        — carrier picked up
--   out-for-delivery  — carrier final-mile underway
--   delivered         — confirmed delivery
--   exception         — carrier-reported problem (damaged, refused,
--                       address-undeliverable, etc.)
--   returned          — package en route back / received back
--
-- Carrier enum is the well-known set of large carriers plus
-- 'other' as the escape hatch when the operator ships via something
-- not on the list (regional couriers, freight LTL, white-glove
-- delivery). When carrier='other', `carrier_other_name` captures
-- the operator-supplied label.
--
-- The `(carrier, tracking_number)` index supports a webhook
-- delivery-confirmation flow where the carrier callback only knows
-- the tracking number.

CREATE TABLE IF NOT EXISTS shipments (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  tracking_number TEXT,
  carrier         TEXT NOT NULL CHECK (carrier IN ('ups','fedex','usps','dhl','royal-mail','canada-post','australia-post','other')),
  carrier_other_name TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','label-created','in-transit','out-for-delivery','delivered','exception','returned')),
  shipped_at      INTEGER,
  delivered_at    INTEGER,
  estimated_delivery_at INTEGER,
  weight_grams    INTEGER NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  cost_minor      INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  cost_currency   TEXT NOT NULL DEFAULT 'USD' CHECK (length(cost_currency) = 3),
  notes           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shipment_events (
  id          TEXT NOT NULL PRIMARY KEY,
  shipment_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  location    TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shipments_order        ON shipments(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_shipments_status       ON shipments(status, shipped_at);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking     ON shipments(carrier, tracking_number);
CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment ON shipment_events(shipment_id, occurred_at);
