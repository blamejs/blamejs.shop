-- Carrier rates — at-checkout shipping rate shopping. Distinct from
-- `shipping` (per-order cost math at the till) and `shipping_labels`
-- (post-checkout label-purchase artefact). This table is the SOURCE
-- OF TRUTH for "which carrier-quoted rates apply to a (cart + ship-
-- to) tuple right now" — the cached quote pool the operator's rate
-- worker writes into when it calls UPS / FedEx / USPS / DHL / a flat-
-- rate fallback and posts results back.
--
-- Two tables:
--
--   carriers — operator-registered rate sources. Slug is the
--     operator-chosen stable identifier (`ups`, `fedex`, `usps-priority`,
--     `flat-rate-domestic`). `service_levels_json` is the carrier's
--     menu of options (e.g. UPS ships Ground / 3-Day Select / 2nd Day
--     Air / Next Day Air Saver / Next Day Air); each entry carries a
--     code, an operator-facing label, and an SLA in days. The framework
--     doesn't call carrier APIs directly — `rate_endpoint` is the URL
--     the operator's worker reads to know where to forward a rate
--     request. `active = 0` keeps the carrier in history but excludes
--     it from new rate shopping (e.g. paused vendor account).
--
--   carrier_rate_quotes — one row per cached quote. The UNIQUE key
--     (carrier_slug, service_code, origin_postal, dest_postal,
--     weight_grams) dedups so a later quote with the same shape
--     refreshes the rate + extends valid_until in place rather than
--     stacking duplicates. INSERT OR REPLACE on a conflict preserves
--     the constraint without an explicit two-step upsert. `valid_until`
--     is the carrier-declared quote expiry (epoch-ms); rows past expiry
--     are excluded from `ratesForShipment` and pruned by
--     `cleanupExpiredQuotes`. `dimensions_json` is the parcel envelope
--     `{length_mm, width_mm, height_mm}` — operator transparency over
--     what shape was quoted (a 30cm box quote doesn't apply to a 60cm
--     box).
--
-- Why postal codes as the routing key: every carrier API the framework
-- targets uses origin + destination postal codes (plus weight +
-- dimensions) as the minimum input. Country-level shopping at the
-- checkout drives a postal-code-keyed lookup; the operator's adapter
-- pads / trims as needed before forwarding to the underlying API.

CREATE TABLE IF NOT EXISTS carriers (
  slug                        TEXT NOT NULL PRIMARY KEY,
  carrier                     TEXT NOT NULL CHECK (carrier IN (
    'ups', 'fedex', 'usps', 'dhl', 'flat_rate'
  )),
  service_levels_json         TEXT NOT NULL,
  rate_endpoint               TEXT,
  active                      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_carriers_active
  ON carriers(active, slug);

CREATE TABLE IF NOT EXISTS carrier_rate_quotes (
  id                          TEXT NOT NULL PRIMARY KEY,
  carrier_slug                TEXT NOT NULL,
  service_code                TEXT NOT NULL,
  origin_postal               TEXT NOT NULL,
  dest_postal                 TEXT NOT NULL,
  weight_grams                INTEGER NOT NULL CHECK (weight_grams > 0),
  dimensions_json             TEXT NOT NULL,
  rate_minor                  INTEGER NOT NULL CHECK (rate_minor >= 0),
  currency                    TEXT NOT NULL CHECK (length(currency) = 3),
  valid_until                 INTEGER NOT NULL CHECK (valid_until > 0),
  queried_at                  INTEGER NOT NULL,
  FOREIGN KEY (carrier_slug) REFERENCES carriers(slug),
  UNIQUE (carrier_slug, service_code, origin_postal, dest_postal, weight_grams)
);

CREATE INDEX IF NOT EXISTS idx_carrier_rate_quotes_lookup
  ON carrier_rate_quotes(origin_postal, dest_postal, weight_grams, valid_until);
CREATE INDEX IF NOT EXISTS idx_carrier_rate_quotes_carrier
  ON carrier_rate_quotes(carrier_slug, queried_at DESC);
CREATE INDEX IF NOT EXISTS idx_carrier_rate_quotes_valid_until
  ON carrier_rate_quotes(valid_until);
