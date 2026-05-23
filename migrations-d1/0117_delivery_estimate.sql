-- Delivery-estimate tables — PDP + cart "Get it by Thursday" window
-- calculator. The four tables compose:
--
--   carrier_transits        — for each (from_zone -> to_zone, carrier,
--                             service_level) tuple, the carrier-declared
--                             transit_days budget (business days). The
--                             UNIQUE (from_zone, to_zone, carrier,
--                             service_level) constraint lets the
--                             primitive UPSERT a refreshed transit
--                             estimate in place rather than stacking
--                             duplicates each time the operator reloads
--                             the carrier's published service guide.
--                             `archived_at` is the one-way soft-delete
--                             stamp; archived rows drop out of estimate
--                             math but persist for audit.
--
--   shipping_cutoffs        — per-inventory-location daily cutoff. PK
--                             is `origin_location`; each origin has
--                             exactly one cutoff row. Operators wanting
--                             time-band cutoffs (a 14:00 standard +
--                             09:00 express) author two origin slugs
--                             and route accordingly. `timezone` is the
--                             IANA name the framework hands to
--                             Intl.DateTimeFormat to decompose `now`
--                             into the origin's wall clock — DST
--                             handled by the platform Intl runtime,
--                             never by hand-rolled offset math.
--
--   shipping_holidays       — observed holidays per region. Region is
--                             an operator-chosen slug (`us`, `us-ca`,
--                             `eu-de`); the primitive doesn't enumerate
--                             the region namespace, the operator's
--                             documented policy does. The UNIQUE
--                             (region, date) lets a re-import of the
--                             year's calendar refresh `name` in place
--                             without churning row ids. `archived_at`
--                             soft-deletes a holiday when the
--                             observance schedule changes mid-year.
--
--   delivery_postal_zones   — postal-prefix -> zone mapping per
--                             country. PK is (country, postal_prefix);
--                             longest-prefix wins at lookup time. The
--                             table is small (one row per prefix-bucket
--                             the operator cares about) so the
--                             primitive walks it in JS at lookup time
--                             rather than encoding a longest-prefix
--                             match into SQL.
--
-- Why postal-prefix rather than full postal codes: carriers publish
-- transit-day tables against region buckets (US zone 1-8, EU zone A-C),
-- not against per-postcode rows. A bucket of `902` for "US 90xxx"
-- and `100` for "US 10xxx" matches how the operator already authors
-- their carrier service guide. Operators wanting per-postcode
-- precision register longer prefixes (e.g. `90210`) and the longest
-- match wins.

CREATE TABLE IF NOT EXISTS carrier_transits (
  id                          TEXT NOT NULL PRIMARY KEY,
  from_zone                   TEXT NOT NULL,
  to_zone                     TEXT NOT NULL,
  carrier                     TEXT NOT NULL CHECK (carrier IN (
    'ups', 'fedex', 'usps', 'dhl', 'flat_rate', 'custom'
  )),
  service_level               TEXT NOT NULL,
  transit_days                INTEGER NOT NULL CHECK (transit_days >= 0 AND transit_days <= 365),
  archived_at                 INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  UNIQUE (from_zone, to_zone, carrier, service_level)
);

CREATE INDEX IF NOT EXISTS idx_carrier_transits_lookup
  ON carrier_transits(from_zone, to_zone, archived_at);
CREATE INDEX IF NOT EXISTS idx_carrier_transits_carrier
  ON carrier_transits(carrier, archived_at);

CREATE TABLE IF NOT EXISTS shipping_cutoffs (
  origin_location             TEXT NOT NULL PRIMARY KEY,
  daily_cutoff_local_time     TEXT NOT NULL,
  timezone                    TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shipping_holidays (
  id                          TEXT NOT NULL PRIMARY KEY,
  region                      TEXT NOT NULL,
  date                        TEXT NOT NULL,
  name                        TEXT NOT NULL,
  archived_at                 INTEGER,
  created_at                  INTEGER NOT NULL,
  UNIQUE (region, date)
);

CREATE INDEX IF NOT EXISTS idx_shipping_holidays_region
  ON shipping_holidays(region, archived_at, date);
CREATE INDEX IF NOT EXISTS idx_shipping_holidays_date
  ON shipping_holidays(date);

CREATE TABLE IF NOT EXISTS delivery_postal_zones (
  country                     TEXT NOT NULL,
  postal_prefix               TEXT NOT NULL,
  zone                        TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  PRIMARY KEY (country, postal_prefix)
);

CREATE INDEX IF NOT EXISTS idx_delivery_postal_zones_country
  ON delivery_postal_zones(country);
