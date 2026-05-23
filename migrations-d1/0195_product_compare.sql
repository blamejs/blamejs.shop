-- Product compare — storefront "compare 2-4 products side-by-side"
-- feature. Customers pick a small fixed-cap set of products from a
-- collection page; the storefront renders a table whose columns are
-- the chosen products and whose rows are the attributes the operator
-- declared comparable (price / sku / brand / vendor / weight /
-- dimensions / inventory_status by default, plus any operator-defined
-- additions). Three tables back the surface:
--
--   `compare_lists` — one row per shopper-session compare basket.
--     `session_id_hash` is the SHA3-512 namespace-hashed session cookie
--     (namespace `product-compare-session`) so a database dump can't
--     be replayed to reconstruct an active session. `customer_id` is
--     nullable — anonymous shoppers compare without authenticating;
--     when a logged-in shopper drives the action the customer id rides
--     alongside the session hash so the operator's account-page widget
--     can resume the same basket on a different device. `product_ids_json`
--     is the ordered JSON array of product UUIDs (cap enforced by the
--     application layer at 4 — the column itself does not carry the
--     cap as a CHECK because product ids are opaque to SQLite). The
--     UNIQUE on `session_id_hash` collapses repeat writes onto one
--     row; `updated_at` floats forward on every mutation so a
--     cleanup sweep can age out abandoned baskets.
--
--   `compare_attributes` — operator-extensible attribute catalog. The
--     seven defaults (price / sku / brand / vendor / weight /
--     dimensions / inventory_status) live in the application code so
--     a fresh storefront serves a working compare table without
--     seeding rows here. Operators add custom rows (warranty,
--     country_of_origin, certifications, ...) for category-specific
--     compare tables — the slug is the primary key (lowercase alnum +
--     dash). `source` enum tells the resolver where to pull the
--     value from on each product (`variant` = first variant's
--     column; `product` = product row column; `metadata` = the
--     product's metadata_json bag). `format` enum tells the
--     storefront's table renderer how to display the value (text /
--     number / currency / boolean / enum). `archived_at` soft-
--     retires an attribute without dropping historical rows that
--     might still reference its slug.
--
--   `compare_impressions` — append-only ledger of every "this
--     product was placed into a compare basket" event. Drives the
--     `popularCompares({ from, to })` rollup the storefront's
--     merchandising widget reads ("most-compared products this
--     week"). `source_kind` is a short label the application
--     captures at write time (collection_page / search_results /
--     product_recommendation / customer_account / other) so the
--     rollup can slice by surface. Session hash arrives namespace-
--     hashed at write time (the same hashing as `compare_lists`)
--     and survives the cleanup sweep that prunes lists so the
--     long-window rollup keeps its historical depth.
--
-- Indexes drive the three hot read paths:
--   * (session_id_hash) UNIQUE on compare_lists — single-session
--     reads + writes (every `addToCompare` / `removeFromCompare`
--     looks up the row by session hash).
--   * (updated_at) on compare_lists — `cleanupOlderThan(days)`
--     sweep.
--   * (product_id, occurred_at) on compare_impressions — the
--     popularCompares rollup groups by product within a window.
--   * (occurred_at) on compare_impressions — the cleanup sweep +
--     window range scans without forcing a product join.

CREATE TABLE IF NOT EXISTS compare_lists (
  id                  TEXT    NOT NULL PRIMARY KEY,
  session_id_hash     TEXT    NOT NULL UNIQUE,
  customer_id         TEXT,
  product_ids_json    TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compare_lists_updated
  ON compare_lists(updated_at);
CREATE INDEX IF NOT EXISTS idx_compare_lists_customer
  ON compare_lists(customer_id);

CREATE TABLE IF NOT EXISTS compare_attributes (
  slug         TEXT    NOT NULL PRIMARY KEY,
  label        TEXT    NOT NULL,
  source       TEXT    NOT NULL CHECK (source IN ('variant', 'product', 'metadata')),
  format       TEXT    NOT NULL CHECK (format IN ('text', 'number', 'currency', 'boolean', 'enum')),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compare_attributes_archived
  ON compare_attributes(archived_at);

CREATE TABLE IF NOT EXISTS compare_impressions (
  id                TEXT    NOT NULL PRIMARY KEY,
  product_id        TEXT    NOT NULL,
  source_kind       TEXT    NOT NULL,
  session_id_hash   TEXT    NOT NULL,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compare_impressions_product
  ON compare_impressions(product_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_compare_impressions_occurred
  ON compare_impressions(occurred_at);
