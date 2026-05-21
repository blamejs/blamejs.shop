-- Catalog: products, variants, prices, inventory, media.
--
-- Schema decisions:
--   * IDs are TEXT (UUIDv4 strings), caller-generated. Distributed-
--     systems-friendly — no autoincrement contention, no merge-time
--     id remapping across import/export rounds.
--   * Timestamps are INTEGER epoch milliseconds. Stable across
--     dialects, sortable, no parse step at read time.
--   * Money is INTEGER minor units (e.g. cents). Never floats — every
--     `amount_minor` is exact and addition is associative.
--   * Currency is TEXT, 3-letter ISO 4217 (USD, EUR, GBP, ...).
--   * Status enums use CHECK constraints; the framework rejects
--     unknown values at write time AND the DB refuses to store them.
--   * Foreign keys declared but D1's FK enforcement requires
--     PRAGMA foreign_keys=ON per session — primitives validate
--     existence at the application layer regardless.

CREATE TABLE IF NOT EXISTS products (
  id          TEXT NOT NULL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_status     ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at);

CREATE TABLE IF NOT EXISTS variants (
  id                TEXT NOT NULL PRIMARY KEY,
  product_id        TEXT NOT NULL,
  sku               TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL DEFAULT '',
  options_json      TEXT NOT NULL DEFAULT '{}',
  weight_grams      INTEGER NOT NULL DEFAULT 0   CHECK (weight_grams >= 0),
  requires_shipping INTEGER NOT NULL DEFAULT 1   CHECK (requires_shipping IN (0, 1)),
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id, position);

CREATE TABLE IF NOT EXISTS prices (
  id              TEXT NOT NULL PRIMARY KEY,
  variant_id      TEXT NOT NULL,
  currency        TEXT NOT NULL CHECK (length(currency) = 3),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor >= 0),
  effective_from  INTEGER NOT NULL,
  effective_until INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prices_current ON prices(variant_id, currency, effective_until);

CREATE TABLE IF NOT EXISTS inventory (
  sku           TEXT NOT NULL PRIMARY KEY,
  stock_on_hand INTEGER NOT NULL DEFAULT 0  CHECK (stock_on_hand >= 0),
  stock_held    INTEGER NOT NULL DEFAULT 0  CHECK (stock_held >= 0),
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id           TEXT NOT NULL PRIMARY KEY,
  product_id   TEXT,
  variant_id   TEXT,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  width        INTEGER NOT NULL DEFAULT 0  CHECK (width >= 0),
  height       INTEGER NOT NULL DEFAULT 0  CHECK (height >= 0),
  position     INTEGER NOT NULL DEFAULT 0,
  alt_text     TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  CHECK (product_id IS NOT NULL OR variant_id IS NOT NULL),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_product ON media(product_id, position);
CREATE INDEX IF NOT EXISTS idx_media_variant ON media(variant_id, position);
