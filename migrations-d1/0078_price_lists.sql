-- Price lists — per-customer wholesale / contract pricing tables.
--
-- A shop typically runs a single retail price book (the rows in
-- `prices`) and zero or more wholesale / B2B / contract overlays.
-- Each overlay is a `price_list` row keyed by a stable slug, with a
-- set of `price_list_members` (SKU + override amount) and a set of
-- `price_list_assignments` (which customers see this overlay). At
-- cart time, the cartBulkOps primitive calls `priceListApply` to
-- rewrite each line's `unit_amount_minor` from the overlay when a
-- member row exists for the SKU.
--
-- Schema decisions:
--
--   * `price_lists.slug` is the primary key. Operators reference the
--     overlay by a stable human-readable handle ("acme-corp-2026",
--     "education-tier"), not a UUID — keeps reports / contracts /
--     CSV imports readable without a join. Slug format is enforced
--     at the application layer (lowercase alnum + hyphen, the same
--     shape the catalog primitive uses for product slugs).
--
--   * `price_lists.currency` pins each overlay to a single ISO 4217
--     code. A wholesale list quoted in USD never silently re-prices
--     a EUR cart — the apply step refuses on currency mismatch.
--
--   * `archived_at` is the soft-delete column (NULL = live). An
--     archived list still resolves for historic audit reads but is
--     refused by `priceListApply` at write time.
--
--   * `price_list_members.override_unit_minor` is the flat per-unit
--     override. `qty_break_minor` is reserved for a future
--     quantity-tiered overlay shape — when present, the override
--     applies only when the cart line qty hits the break point.
--     v1 callers leave it NULL (flat override). The column is
--     declared up-front so a later migration doesn't bump every
--     existing row to backfill the column.
--
--   * `price_list_assignments.customer_id` is the primary key — a
--     customer is on at most one wholesale list at a time. Operators
--     who want stacked / overlay-on-overlay semantics compose them
--     at the application layer (sequence two `priceListApply` calls
--     against the same cart); the database stays single-overlay.
--
--   * Indexes:
--
--       (price_list_slug)               on price_list_members
--           — `listMembers` (operator-facing) + `priceListApply`
--             (cart-facing) both walk the table by slug.
--
--       (price_list_slug, sku) UNIQUE   on price_list_members
--           — refuses a duplicate sku-in-overlay at insert time so
--             the apply step never has to disambiguate.
--
--       (price_list_slug)               on price_list_assignments
--           — supports "which customers are on this overlay?"
--             without a full-table scan.

CREATE TABLE IF NOT EXISTS price_lists (
  slug         TEXT NOT NULL PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_lists_active
  ON price_lists(active, archived_at);

CREATE TABLE IF NOT EXISTS price_list_members (
  id                   TEXT NOT NULL PRIMARY KEY,
  price_list_slug      TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  override_unit_minor  INTEGER NOT NULL CHECK (override_unit_minor >= 0),
  qty_break_minor      INTEGER,
  created_at           INTEGER NOT NULL,
  FOREIGN KEY (price_list_slug) REFERENCES price_lists(slug) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_list_members_slug_sku
  ON price_list_members(price_list_slug, sku);

CREATE INDEX IF NOT EXISTS idx_price_list_members_slug
  ON price_list_members(price_list_slug);

CREATE TABLE IF NOT EXISTS price_list_assignments (
  customer_id      TEXT NOT NULL PRIMARY KEY,
  price_list_slug  TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (price_list_slug) REFERENCES price_lists(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_list_assignments_slug
  ON price_list_assignments(price_list_slug);
