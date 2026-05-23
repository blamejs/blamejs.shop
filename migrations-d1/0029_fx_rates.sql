-- FX rates: display-side currency conversion cache.
--
-- The catalog stores prices in their native currency (`USD` for a
-- US shop, `EUR` for a German shop). The storefront serves customers
-- worldwide -- a visitor in France should see the catalog's USD
-- prices rendered in EUR without the operator re-pricing every SKU.
--
-- This table is a small key/value cache keyed by `(base, quote)` ISO
-- 4217 pair. Rates are integer basis-points * 10000 so we never store
-- a float (`1 USD = 0.92 EUR` -> `rate_bps = 9200`). Each row carries
-- its TTL (`expires_at`) -- conversion at read time refuses to use a
-- stale rate and surfaces the staleness to the caller so the
-- storefront can decide whether to display the cached value with a
-- "rates may be out of date" advisory or fall back to the catalog
-- currency.
--
-- The framework never reaches out to a rate feed itself. Operators
-- compose `b.httpClient` against ECB / openexchangerates / fixer.io /
-- their treasury system and call `currencyDisplay.setRate` or
-- `.bulkSetRates` with the result. `cleanupExpired` is the scheduler
-- companion that prunes rows whose TTL has elapsed.

CREATE TABLE IF NOT EXISTS fx_rates (
  base_currency   TEXT NOT NULL CHECK (length(base_currency) = 3),
  quote_currency  TEXT NOT NULL CHECK (length(quote_currency) = 3),
  rate_bps        INTEGER NOT NULL CHECK (rate_bps > 0),
  source          TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (base_currency, quote_currency)
);

CREATE INDEX IF NOT EXISTS idx_fx_rates_expires ON fx_rates(expires_at);
