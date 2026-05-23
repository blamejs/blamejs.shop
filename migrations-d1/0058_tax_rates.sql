-- Tax rates — operator-managed per-jurisdiction rate table with
-- scheduled effective dates. Distinct from the `tax` primitive (which
-- is the math + adapter surface): this table is the SOURCE OF TRUTH
-- for "what rate applies in jurisdiction X on date Y for category Z"
-- and is what the operator's tax-update process writes into when a
-- statutory change is published (VIES, US state notices, finance-
-- department bulletins, paid feeds like Avalara).
--
-- One row per (jurisdiction, category, effective_from). Categories
-- are operator-defined strings (NULL means "default rate for the
-- jurisdiction"); a row for `category = NULL` is the fallback when a
-- more-specific category row doesn't cover the lookup. Rate selection
-- at read time is:
--
--   for a given (jurisdiction, category, on_date):
--     1. find the most recent row where effective_from <= on_date
--        AND (effective_until IS NULL OR effective_until > on_date)
--        AND archived_at IS NULL
--        AND category = <requested category>
--     2. if no category-specific row matches, repeat with category = NULL
--     3. if still no row, return null (caller decides whether to
--        fall back to a default rate or refuse the sale)
--
-- Overlapping live windows for the same (jurisdiction, category) are
-- REFUSED at define time — two rows whose [effective_from,
-- effective_until) intervals intersect would make rate selection
-- ambiguous. Archiving a row clears it from the overlap check so an
-- operator can "supersede" an existing future-dated row.
--
-- jurisdiction format: ISO 3166-1 alpha-2 country code, optionally
-- followed by `-` and an ISO 3166-2 subdivision tag of 1-3 uppercase
-- alphanumerics (the practical world's subdivisions all fit in this
-- envelope). The CHECK uses SQLite GLOB to enforce the basic shape;
-- the primitive's app-layer regex is the strict gate.
--
-- source: who declared this rate. Operators tagging the import path
-- lets the finance dashboard show provenance ("manual" vs a paid feed
-- vs the EU's VIES bulletin) without joining a separate audit table.
-- Allowed values are bounded — operators adding a new source extend
-- both the enum here and the primitive's accepted list.

CREATE TABLE IF NOT EXISTS tax_rates (
  id                          TEXT NOT NULL PRIMARY KEY,
  jurisdiction                TEXT NOT NULL CHECK (
    length(jurisdiction) >= 2 AND length(jurisdiction) <= 6 AND (
      jurisdiction GLOB '[A-Z][A-Z]' OR
      jurisdiction GLOB '[A-Z][A-Z]-[A-Z0-9]' OR
      jurisdiction GLOB '[A-Z][A-Z]-[A-Z0-9][A-Z0-9]' OR
      jurisdiction GLOB '[A-Z][A-Z]-[A-Z0-9][A-Z0-9][A-Z0-9]'
    )
  ),
  category                    TEXT,
  rate_bps                    INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  effective_from              INTEGER NOT NULL CHECK (effective_from >= 0),
  effective_until             INTEGER CHECK (effective_until IS NULL OR effective_until > effective_from),
  source                      TEXT NOT NULL CHECK (source IN (
    'manual', 'vies', 'state_dept', 'avalara'
  )),
  archived_at                 INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tax_rates_lookup
  ON tax_rates(jurisdiction, category, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_tax_rates_effective_from
  ON tax_rates(effective_from);
CREATE INDEX IF NOT EXISTS idx_tax_rates_effective_until
  ON tax_rates(effective_until);
