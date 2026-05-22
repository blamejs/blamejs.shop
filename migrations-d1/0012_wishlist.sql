-- Wishlist — customers save products (or specific variants) for
-- later. The PDP "Add to wishlist" toggle, the account-page
-- "Saved items" listing, and the "X people saved this" social-
-- proof counter all read this table.
--
-- Schema decisions:
--   * `customer_id` / `product_id` / `variant_id` are SOFT foreign
--     keys — the wishlist primitive validates UUID shape via
--     `b.guardUuid` at the app layer, but D1 doesn't enforce
--     referential integrity here. The trade-off is intentional:
--     customer-deletion + product-archival flows live elsewhere
--     and the wishlist row is operator-orphan-tolerant (a saved
--     row pointing at a deleted product is rendered as
--     "unavailable" by the storefront, never crashes the listing).
--   * `variant_id` is NULL when the customer saves at the product
--     level (e.g. "this t-shirt", any colour) and populated when
--     they save a specific SKU (e.g. "this t-shirt, size M, navy").
--     The UNIQUE constraint coalesces NULL to '' so the
--     (customer, product, NULL) pair is treated as a single tuple
--     and a second NULL-variant add is a dedup.
--   * `notes` is a short customer-authored memo (e.g. "for my
--     birthday in March") — capped at 280 bytes by the app layer.
--     Stored plaintext; operators that want application-layer
--     AEAD should wrap the primitive and seal the column via
--     `b.vault.seal`.

CREATE TABLE IF NOT EXISTS wishlist_entries (
  id           TEXT NOT NULL PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  product_id   TEXT NOT NULL,
  variant_id   TEXT,
  notes        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_entries_unique
  ON wishlist_entries(customer_id, product_id, COALESCE(variant_id, ''));

CREATE INDEX IF NOT EXISTS idx_wishlist_entries_customer
  ON wishlist_entries(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wishlist_entries_product
  ON wishlist_entries(product_id, created_at);
