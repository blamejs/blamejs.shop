-- Sample product-media seed for the blamejs.shop demo storefront.
-- Run with: wrangler d1 execute blamejs-shop --remote --file=scripts/seed-sample-product-media.sql
--
-- Pairs each seeded product (`scripts/seed-sample-products.sql`)
-- with one SVG product image hosted at R2 key `products/<slug>.svg`.
-- The Worker's static-asset pass-through serves these at
-- `/assets/products/<slug>.svg`. `INSERT OR IGNORE` keeps the seed
-- idempotent across reruns.

-- Operator Tee
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000031', '00000000-0000-7000-8000-000000000001', NULL,
   'products/operator-tee.svg', 'image/svg+xml', 800, 800, 0,
   'Operator Tee — heavyweight cotton tee with the shield wordmark on the chest', 1779000000000);

-- Edge Reader v1
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000032', '00000000-0000-7000-8000-000000000002', NULL,
   'products/edge-reader.svg', 'image/svg+xml', 800, 800, 0,
   'Edge Reader v1 — single-purpose serial console reader with hardware RNG', 1779000000000);

-- Operator License
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000033', '00000000-0000-7000-8000-000000000003', NULL,
   'products/operator-license.svg', 'image/svg+xml', 800, 800, 0,
   'Operator License — one-year ML-DSA-signed playbook archive license', 1779000000000);

-- Starter Bundle
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000034', '00000000-0000-7000-8000-000000000004', NULL,
   'products/starter-bundle.svg', 'image/svg+xml', 800, 800, 0,
   'Starter Bundle — Operator Tee, Edge Reader v1, and Operator License at one SKU', 1779000000000);
