-- Product reviews — operator-moderated rating + body per product.
--
-- Reviews are submitted in `pending` state and require an explicit
-- `publish` (or `reject`) call before they surface to the storefront.
-- The customer identity is always stored as `customer_id_hash` —
-- either a `b.crypto.namespaceHash("review-customer", customer_id)`
-- for authenticated submissions or a hash of the normalised email
-- for anonymous submissions. The raw email is never persisted.
--
-- `customer_id` is stored alongside the hash for authenticated
-- submissions so a logged-in shopper can later browse "my reviews"
-- without re-hashing on every read. The column is nullable: anonymous
-- email-based reviews leave it NULL and the storefront resolves the
-- author identity purely through the hash.
--
-- `verified_purchase` is a derived signal the operator stamps when
-- they see an `order_lines` row matching this customer + product.
-- The primitive accepts the bit at submit time; the storefront route
-- layer is what actually does the order lookup before passing 1.

CREATE TABLE IF NOT EXISTS reviews (
  id                TEXT NOT NULL PRIMARY KEY,
  product_id        TEXT NOT NULL,
  customer_id       TEXT,
  customer_id_hash  TEXT NOT NULL,
  rating            INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  verified_purchase INTEGER NOT NULL DEFAULT 0 CHECK (verified_purchase IN (0, 1)),
  status            TEXT NOT NULL CHECK (status IN ('pending', 'published', 'rejected')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reviews_product_status ON reviews(product_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_customer       ON reviews(customer_id_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_product_rating ON reviews(product_id, rating);
