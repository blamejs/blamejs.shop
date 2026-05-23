-- Price-display rules — operator-declared per-country presentation mode
-- plus a per-customer override table.
--
-- The catalog stores one set of prices. Whether a storefront line item
-- renders as `€12.00` (tax-included, the EU B2C default) or `€10.00 +
-- VAT` (tax-excluded, the standard B2B presentation, and the US default)
-- is a *display* decision. Operators declare the country defaults here;
-- the storefront's `formatPrice` consults the table at render time and
-- composes the tax primitive when a tax breakdown is requested.
--
-- Two tables, no joins:
--
--   * `price_display_rules` — one row per country (ISO 3166-1 alpha-2).
--     `mode` is the country's default presentation. The optional
--     `customer_status_in_json` narrows the rule to a specific buyer
--     posture — for example, an EU country may default to
--     `tax_included` for B2C buyers but also carry a `tax_excluded`
--     rule that only applies when `customer_status = "b2b"`. Rule
--     resolution walks customer-status-specific rules before falling
--     back to the country default; see lib/price-display.js.
--
--   * `customer_price_display_overrides` — one row per `customer_id`
--     pinning a specific mode to that buyer regardless of country.
--     B2B accounts trading in the EU often need pre-tax presentation
--     even though the country default is tax-included; this is the
--     direct lever for that. Override always wins over country rule.
--
-- Mode vocabulary (CHECK-enforced):
--
--     tax_included    — display gross (tax already in the figure)
--     tax_excluded    — display net   (tax shown separately or omitted)
--     both            — display both forms (e.g. `€12.00 incl. VAT —
--                       €10.00 ex VAT`); storefront chooses layout
--
-- `archived_at` is the soft-delete column on the rules table. The
-- customer-override table is mutate-in-place (the row IS the
-- assignment; clearing the override deletes the row).

CREATE TABLE IF NOT EXISTS price_display_rules (
  country                  TEXT NOT NULL PRIMARY KEY CHECK (
    length(country) = 2 AND country GLOB '[A-Z][A-Z]'
  ),
  mode                     TEXT NOT NULL CHECK (
    mode IN ('tax_included', 'tax_excluded', 'both')
  ),
  customer_status_in_json  TEXT,
  archived_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_display_rules_archived_at
  ON price_display_rules(archived_at);

CREATE TABLE IF NOT EXISTS customer_price_display_overrides (
  customer_id  TEXT NOT NULL PRIMARY KEY,
  mode         TEXT NOT NULL CHECK (
    mode IN ('tax_included', 'tax_excluded', 'both')
  ),
  set_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_price_display_overrides_set_at
  ON customer_price_display_overrides(set_at);
