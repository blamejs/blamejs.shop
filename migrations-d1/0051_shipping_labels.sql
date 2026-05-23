-- Shipping labels — per-shipment carrier label records.
--
-- A shipment (rows in `shipments`, owned by orderTracking) is the
-- post-order tracking entity — one row per parcel handed to a
-- carrier. A shipping_label is the carrier's printable artefact for
-- that parcel: the operator (or the operator's worker) requests a
-- label from EasyPost / Shippo / ShipStation / Stamps.com (or a
-- manual paper label / a custom integration), the carrier mints a
-- tracking number + PDF/ZPL URL + final shipping cost, and the
-- label row captures the result.
--
-- The framework does NOT make the HTTP call to the label-broker.
-- That's the operator's worker — different brokers have different
-- auth shapes (EasyPost API key, Shippo OAuth, ShipStation HMAC),
-- and pinning a wire-format choice into the framework would shut
-- out the operator whose preferred broker isn't yet wired. The
-- worker writes `requestLabel` (pending row), calls the broker, and
-- calls back into `markPurchased` (or `markFailed` indirectly via
-- the broker error path the operator owns).
--
-- Status FSM:
--   pending   — requestLabel written; broker call not yet completed
--   purchased — broker minted the label; tracking_number + url known
--   voided    — purchased label voided with the broker (within 30 days)
--   used     — purchased label handed to carrier (post-pickup)
--
-- A void-window of 30 days is enforced at the application tier
-- (markPurchased records `purchased_at`; voidLabel refuses past 30
-- days). The framework cannot enforce the broker's own void window
-- — the broker may refuse a void independently — but the
-- 30-day local refusal saves an operator HTTP round-trip + matches
-- every documented broker's standard window.
--
-- `package_type` is the carrier-agnostic package-type enum: the four
-- common shapes (envelope, parcel, pak, custom) most carriers
-- accept. The actual carrier API may translate further; the
-- framework keeps the enum narrow.
--
-- `purchased_via` records which broker (or manual / custom) minted
-- the label. Cost reporting / cost-by-period aggregates filter on
-- this for per-broker analytics; the index covers the
-- (purchased_via, purchased_at) drain.
--
-- `customs_json` carries an optional international-shipment customs
-- declaration. Stored verbatim as a JSON blob — every broker wants
-- a slightly different shape, and the operator's worker translates.
-- Schema for the documented shape (HS code per line, value, origin
-- country, contents type) is application-tier validation.

CREATE TABLE IF NOT EXISTS shipping_labels (
  id              TEXT NOT NULL PRIMARY KEY,
  shipment_id     TEXT NOT NULL,
  carrier         TEXT NOT NULL CHECK (carrier IN (
                    'ups','fedex','usps','dhl','royal-mail',
                    'canada-post','australia-post','other')),
  service_level   TEXT NOT NULL,
  weight_grams    INTEGER NOT NULL CHECK (weight_grams > 0),
  length_mm       INTEGER NOT NULL CHECK (length_mm > 0),
  width_mm        INTEGER NOT NULL CHECK (width_mm > 0),
  height_mm       INTEGER NOT NULL CHECK (height_mm > 0),
  package_type    TEXT NOT NULL CHECK (package_type IN (
                    'envelope','parcel','pak','custom')),
  status          TEXT NOT NULL CHECK (status IN (
                    'pending','purchased','voided','used')),
  tracking_number TEXT,
  label_url       TEXT,
  cost_minor      INTEGER,
  currency        TEXT CHECK (currency IS NULL OR length(currency) = 3),
  purchased_via   TEXT CHECK (purchased_via IS NULL OR purchased_via IN (
                    'easypost','shippo','shipstation','stamps_com',
                    'manual','custom')),
  customs_json    TEXT,
  void_reason     TEXT,
  created_at      INTEGER NOT NULL,
  purchased_at    INTEGER,
  voided_at       INTEGER,
  used_at         INTEGER,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shipping_labels_shipment       ON shipping_labels(shipment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_shipping_labels_status_created ON shipping_labels(status, created_at);
CREATE INDEX IF NOT EXISTS idx_shipping_labels_purchased      ON shipping_labels(purchased_via, purchased_at);
CREATE INDEX IF NOT EXISTS idx_shipping_labels_tracking       ON shipping_labels(carrier, tracking_number);
