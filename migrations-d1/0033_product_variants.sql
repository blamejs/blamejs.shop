-- Product variants — normalized option-axis layer on top of
-- `catalog.products`. A product (e.g. T-shirt) has axes (color, size)
-- with option values (red/blue/green × S/M/L/XL), producing the
-- cartesian product of variant SKUs (12 in that example). Each
-- variant row carries the per-SKU overrides — price, weight,
-- inventory count, image — that distinguish it from its siblings.
--
-- Three tables:
--   * `product_variant_axes`         — the option axes registered for
--     a product (one row per axis, e.g. "color"). `position` controls
--     the rendering order on the PDP and the SKU-slug ordering.
--   * `product_variant_axis_options` — the option values for an axis
--     (one row per value, e.g. "red"). `archived_at` soft-deletes a
--     value so historic order lines still resolve while new
--     checkouts can't pick it.
--   * `product_variants`             — the materialized variant rows.
--     `axis_values_json` is the canonical `{axis_name: option_value}`
--     map (lookup-friendly without re-joining the axes tables).
--     `sku` is the lowercase-ASCII-slug compounded from the option
--     labels; UNIQUE across the catalog so an operator typo on
--     `sku_prefix` surfaces at insert time, not at checkout.
--
-- Schema decisions:
--   * Hard FK on `product_id` so the variant rows cascade when the
--     product is deleted (the variants primitive itself never
--     deletes — operators archive — but the FK keeps the schema
--     honest if a future migration drops a product directly).
--   * `axis_values_json` is duplicated against the (axis_id,
--     option_id) join because the storefront PDP renders the variant
--     selector against this map on every paint. Joining four tables
--     to read a price is a hot-path tax we pay once at materialize
--     time.
--   * Money is INTEGER minor units; weight is INTEGER grams; both
--     non-negative. Same discipline as `catalog.variants` /
--     `catalog.prices` so a future merge-back into the catalog
--     surface doesn't require a unit conversion sweep.
--   * `archived_at` is the soft-delete column (NULL = live). A
--     soft-archived variant survives id-lookup (so an order line
--     created before the archive still resolves) but drops out of
--     the default list (the storefront PDP renders only live
--     variants).

CREATE TABLE IF NOT EXISTS product_variant_axes (
  id          TEXT NOT NULL PRIMARY KEY,
  product_id  TEXT NOT NULL,
  axis_name   TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variant_axes_unique
  ON product_variant_axes(product_id, axis_name);

CREATE INDEX IF NOT EXISTS idx_product_variant_axes_product
  ON product_variant_axes(product_id, position);

CREATE TABLE IF NOT EXISTS product_variant_axis_options (
  id            TEXT NOT NULL PRIMARY KEY,
  axis_id       TEXT NOT NULL,
  option_value  TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  archived_at   INTEGER,
  FOREIGN KEY (axis_id) REFERENCES product_variant_axes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variant_axis_options_unique
  ON product_variant_axis_options(axis_id, option_value);

CREATE INDEX IF NOT EXISTS idx_product_variant_axis_options_axis
  ON product_variant_axis_options(axis_id, position);

CREATE TABLE IF NOT EXISTS product_variants (
  id               TEXT NOT NULL PRIMARY KEY,
  product_id       TEXT NOT NULL,
  sku              TEXT NOT NULL UNIQUE,
  axis_values_json TEXT NOT NULL DEFAULT '{}',
  price_minor      INTEGER NOT NULL DEFAULT 0  CHECK (price_minor >= 0),
  weight_grams     INTEGER NOT NULL DEFAULT 0  CHECK (weight_grams >= 0),
  image_url        TEXT NOT NULL DEFAULT '',
  inventory_count  INTEGER NOT NULL DEFAULT 0  CHECK (inventory_count >= 0),
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product
  ON product_variants(product_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_product_variants_archived
  ON product_variants(archived_at);
