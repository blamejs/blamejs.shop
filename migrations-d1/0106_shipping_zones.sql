-- Shipping zones — operator-defined regional rate tables. Distinct from
-- `carrier_rate_quotes` (which caches live carrier-API quotes for a
-- single shipment) and from `shipping` (per-order cost math at the
-- till). A zone is a set of countries / subdivisions PLUS a rate table
-- bucketed by parcel weight OR cart-order value. The till reaches for
-- a zone's rate when the operator has chosen the flat-rate / table-rate
-- option for that destination instead of (or alongside) a carrier-API
-- shopper.
--
-- One table:
--
--   shipping_zones — operator-registered zone. Slug is the operator-
--     chosen stable identifier (`domestic-us`, `eu-zone-1`,
--     `apac-table`). `regions_json` is the array of destinations the
--     zone covers — each entry carries a `country` (ISO 3166-1 alpha-2)
--     and an optional `region` (ISO 3166-2 subdivision, e.g.
--     `CA` / `NY` / `BAV` — the subdivision code without the country
--     prefix). A region-less entry covers the whole country; the most-
--     specific match wins at lookup time. `rates_json` is the bucketed
--     rate table — each entry has optional `min_weight_grams` /
--     `max_weight_grams` (a weight bucket) OR optional
--     `min_order_minor` / `max_order_minor` (an order-value bucket),
--     plus a non-negative `rate_minor`, a 3-letter ISO 4217 `currency`,
--     and an operator-facing `service_label` ("Standard", "Express",
--     "Free over EUR 50"). A rate may carry both kinds of bounds — the
--     bucket then matches only when BOTH the parcel weight AND the
--     order value fall inside. `active = 0` keeps the zone in history
--     but excludes it from `rateFor` / `zoneForDestination` lookups
--     (paused-vendor / seasonal / retired-region case).
--     `archived_at` is a one-way soft-delete stamp — archived zones
--     never come back active even via `updateZone`.
--
-- Why JSON for regions + rates rather than a side table per row:
-- zones are read-mostly with a tiny working set (an operator typically
-- registers 5-20 zones); the lookup walks all active zones in memory
-- and picks the best match. A side-table model would require two more
-- migrations + four more queries per lookup for no measurable read-
-- side win. The JSON columns carry their own validation through the
-- primitive's `_regions` / `_rates` validators — D1 stores opaque
-- text, the primitive owns the shape.

CREATE TABLE IF NOT EXISTS shipping_zones (
  slug                        TEXT NOT NULL PRIMARY KEY,
  title                       TEXT NOT NULL,
  regions_json                TEXT NOT NULL,
  rates_json                  TEXT NOT NULL,
  active                      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at                 INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shipping_zones_active
  ON shipping_zones(active, archived_at, slug);
CREATE INDEX IF NOT EXISTS idx_shipping_zones_archived
  ON shipping_zones(archived_at);
