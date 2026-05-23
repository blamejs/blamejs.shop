-- Geolocation — operator-defined per-country defaults plus the
-- request-hint resolver that picks them.
--
-- The shop never performs an IP-to-country lookup in-process. Instead
-- the operator hands the primitive a bundle of pre-resolved request
-- hints (typically Cloudflare's `CF-IPCountry` + `cf-region` edge
-- headers, the browser's `Accept-Language` and IANA timezone, and an
-- optional buyer-supplied country from a country picker) and the
-- primitive merges them with the per-country settings stored here.
--
-- One row per ISO 3166-1 alpha-2 country code. Currency is ISO 4217.
-- default_locale is a BCP-47 tag (e.g. `en-US`, `de-DE`, `fr-CA`) that
-- the resolver falls back to when no `Accept-Language` value matches
-- the country's preferred language family.
--
-- `geo_blocked` flips checkout off for buyers resolved to this
-- country — used for sanctions compliance (operator's responsibility
-- to keep current) and for countries the shop simply doesn't ship to.
-- `geo_block_reason` carries the operator-facing free-form note that
-- explains the block (e.g. "OFAC SDN — comprehensive sanctions" or
-- "no shipping carrier coverage"). Operators reading the dashboard
-- need to know why a country sits on the block list to decide whether
-- it should still be there.
--
-- `allowed_payment_kinds_json` + `allowed_shipping_kinds_json` are
-- compact JSON arrays of operator-defined strings. The primitive's
-- `resolve` returns them verbatim so checkout filters its method menus
-- against the buyer's resolved country before rendering. A common
-- shape is `["card", "applepay", "googlepay"]` for payments and
-- `["standard", "express"]` for shipping; the schema doesn't bound
-- the vocabulary so operators can extend either menu without a
-- migration.
--
-- `default_timezone` is the IANA timezone id the country renders into
-- when the request doesn't carry a `timezone` hint (e.g. the buyer
-- visited via a deeplink that bypasses the JS that captures
-- `Intl.DateTimeFormat().resolvedOptions().timeZone`). Optional —
-- countries that straddle multiple zones (US, RU, AU, BR, CA) leave
-- this NULL and rely on the per-request hint.

CREATE TABLE IF NOT EXISTS country_settings (
  code                         TEXT NOT NULL PRIMARY KEY CHECK (
    length(code) = 2 AND code GLOB '[A-Z][A-Z]'
  ),
  currency                     TEXT NOT NULL CHECK (
    length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'
  ),
  default_locale               TEXT NOT NULL CHECK (
    length(default_locale) >= 2 AND length(default_locale) <= 35
  ),
  geo_blocked                  INTEGER NOT NULL DEFAULT 0 CHECK (geo_blocked IN (0, 1)),
  geo_block_reason             TEXT,
  allowed_payment_kinds_json   TEXT NOT NULL,
  allowed_shipping_kinds_json  TEXT NOT NULL,
  default_timezone             TEXT,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_country_settings_geo_blocked
  ON country_settings(geo_blocked);
