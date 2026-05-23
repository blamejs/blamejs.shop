-- Save-for-later — storefront primitive sitting adjacent to the cart.
-- A customer moves a line out of their cart but keeps it associated
-- with their account for a future session. Distinct from wishlist:
-- wishlist = "I'm interested in this product"; save-for-later =
-- "I was about to buy this exact configuration but not right now,
-- hold the snapshot price + variant + quantity so I can drop it back
-- into the cart later."
--
-- Schema decisions:
--   * `customer_id` / `variant_id` / `source_cart_id` /
--     `source_line_id` are SOFT foreign keys — the primitive
--     validates UUID shape at the app layer with `b.guardUuid`, but
--     the D1 layer doesn't enforce referential integrity here. The
--     trade-off is intentional: customer-deletion + cart-conversion
--     + line-removal flows all live elsewhere and a save row whose
--     source cart was since abandoned still needs to render in the
--     customer's "Saved for later" panel.
--   * `sku` is the source of truth for matching against the catalog
--     (`inventory.get(sku)`). `variant_id` is captured for the
--     re-add-to-cart path that wants to put the customer back on the
--     same variant; nullable so a saved-without-buying flow that
--     captures only a SKU (e.g. a gift-card line) still persists.
--   * `quantity` mirrors the cart-line shape (positive integer, CHECK
--     in the app layer caps it at MAX_QTY).
--   * `snapshot_price_minor` captures the unit price at the moment
--     of save. `staleCheck()` flags `is_stale` when the current
--     catalog price differs; the storefront renders both prices and
--     lets the customer decide which to re-add at.
--   * `notes` is short customer-authored prose, capped at 280 bytes
--     at the app layer. Control bytes (incl. CR/LF) refused at the
--     app layer so a malicious note can't smuggle header-injection-
--     class content into the operator's dashboard or downstream
--     emails. Nullable in the schema (NULL = "no note attached").
--   * `source_cart_id` / `source_line_id` track which cart line the
--     save originated from (NULL when the customer used the
--     "save without buying" UI path that calls `add()` directly).
--     Operator-orphan tolerant — the source cart can be abandoned /
--     converted and the save row keeps its breadcrumb.
--   * `saved_at` / `last_repriced_at` are INTEGER epoch milliseconds.
--     `last_repriced_at` is NULL until the row's snapshot price was
--     refreshed via `repriceAll()`; the storefront renders "saved
--     <relative time>" against `saved_at` and a separate "re-priced
--     <relative time>" badge when `last_repriced_at` is non-NULL.
--
-- UNIQUE constraint: one (customer, sku, variant) tuple per
-- customer. A second save of the same configuration is a no-op
-- (INSERT OR IGNORE at the app layer + this UNIQUE index together
-- form the dedup). The COALESCE collapses NULL-variant tuples so
-- two NULL-variant saves of the same SKU dedup to a single row.
--
-- Indexes:
--   * `(customer_id, saved_at DESC)` — `listForCustomer` reads
--     scoped to one customer in saved_at desc order; the index
--     covers the filter and the ORDER BY.
--   * `(sku, saved_at)` — `expireOlderThan` walks by saved_at; a
--     sku-second column also gives the operator a cheap "how many
--     saves outstanding for this SKU" rollup without a full table
--     scan.

CREATE TABLE IF NOT EXISTS save_for_later (
  id                    TEXT NOT NULL PRIMARY KEY,
  customer_id           TEXT NOT NULL,
  sku                   TEXT NOT NULL,
  variant_id            TEXT,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  snapshot_price_minor  INTEGER NOT NULL CHECK (snapshot_price_minor >= 0),
  notes                 TEXT,
  source_cart_id        TEXT,
  source_line_id        TEXT,
  saved_at              INTEGER NOT NULL,
  last_repriced_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_save_for_later_unique
  ON save_for_later(customer_id, sku, COALESCE(variant_id, ''));

CREATE INDEX IF NOT EXISTS idx_save_for_later_customer
  ON save_for_later(customer_id, saved_at DESC);

CREATE INDEX IF NOT EXISTS idx_save_for_later_sku
  ON save_for_later(sku, saved_at);
