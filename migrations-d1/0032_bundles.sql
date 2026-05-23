-- Bundles (kit products): a virtual SKU composed of N child product
-- SKUs. When a customer adds the bundle SKU to their cart, the cart-
-- line resolution layer expands the bundle into the underlying child
-- quantities so inventory + fulfillment + pricing all see the real
-- components.
--
-- Two tables:
--
--   bundles            — one row per bundle definition. The
--                        bundle_sku is the natural key; it lives in
--                        the same SKU namespace as variants but
--                        identifies a virtual composite, not a
--                        stockable variant. `bundle_discount_bps`
--                        (basis points) is an optional override that
--                        the pricing primitive applies on top of the
--                        summed component prices; NULL means
--                        "components sum at list price."
--
--   bundle_components  — child SKUs that compose a bundle. Each row
--                        carries a positive quantity multiplier and
--                        a sort_order so the storefront can render
--                        the bundle contents in a stable sequence.
--                        UNIQUE(bundle_sku, sku) refuses duplicate
--                        component rows — operators bump the qty
--                        instead of inserting a second row.
--
-- A component sku MAY itself reference another bundle (nested bundles
-- up to two levels deep — the primitive enforces the depth cap and
-- refuses cyclic references at definition time).

CREATE TABLE IF NOT EXISTS bundles (
  bundle_sku           TEXT NOT NULL PRIMARY KEY,
  title                TEXT NOT NULL,
  bundle_discount_bps  INTEGER CHECK (bundle_discount_bps IS NULL OR (bundle_discount_bps >= 0 AND bundle_discount_bps <= 10000)),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bundles_updated ON bundles(updated_at);

CREATE TABLE IF NOT EXISTS bundle_components (
  bundle_sku  TEXT    NOT NULL,
  sku         TEXT    NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (bundle_sku) REFERENCES bundles(bundle_sku) ON DELETE CASCADE,
  UNIQUE (bundle_sku, sku)
);

CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle ON bundle_components(bundle_sku, sort_order);
CREATE INDEX IF NOT EXISTS idx_bundle_components_sku    ON bundle_components(sku);
