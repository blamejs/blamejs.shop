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

-- Operator Hoodie
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000035', '00000000-0000-7000-8000-000000000005', NULL,
   'products/operator-hoodie.svg', 'image/svg+xml', 800, 800, 0,
   'Operator Hoodie — heavyweight fleece pullover with chest shield wordmark', 1779000000000);

-- Vault Stick
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000036', '00000000-0000-7000-8000-000000000006', NULL,
   'products/vault-stick.svg', 'image/svg+xml', 800, 800, 0,
   'Vault Stick — USB-A hardware authenticator with ML-DSA-65 keypair and touch attest', 1779000000000);

-- Signing Cable
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000037', '00000000-0000-7000-8000-000000000007', NULL,
   'products/signing-cable.svg', 'image/svg+xml', 800, 800, 0,
   'Signing Cable — USB-C cable with in-line ML-DSA-65 signing chip', 1779000000000);

-- Build Pass
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000038', '00000000-0000-7000-8000-000000000008', NULL,
   'products/build-pass.svg', 'image/svg+xml', 800, 800, 0,
   'Build Pass — annual CI license with signed-receipt artifact attachments', 1779000000000);

-- Audit Log Kit
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-000000000039', '00000000-0000-7000-8000-000000000009', NULL,
   'products/audit-log-kit.svg', 'image/svg+xml', 800, 800, 0,
   'Audit Log Kit — three serial-numbered hardcover notebooks with wax-style seal', 1779000000000);

-- Self-Hosted Plan
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-00000000003a', '00000000-0000-7000-8000-00000000000a', NULL,
   'products/self-hosted-plan.svg', 'image/svg+xml', 800, 800, 0,
   'Self-Hosted Plan — annual support license for self-hosted blamejs deployments', 1779000000000);

-- Operator Mug
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-00000000003b', '00000000-0000-7000-8000-00000000000b', NULL,
   'products/operator-mug.svg', 'image/svg+xml', 800, 800, 0,
   'Operator Mug — 11oz stoneware mug with fired-ceramic shield wordmark', 1779000000000);

-- Sticker Pack
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-00000000003c', '00000000-0000-7000-8000-00000000000c', NULL,
   'products/sticker-pack.svg', 'image/svg+xml', 800, 800, 0,
   'Sticker Pack — six die-cut weather-rated vinyl decals', 1779000000000);

-- Buy Me a Coffee
INSERT OR IGNORE INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) VALUES
  ('00000000-0000-7000-8000-00000000003d', '00000000-0000-7000-8000-00000000000d', NULL,
   'products/buy-me-a-coffee.svg', 'image/svg+xml', 800, 800, 0,
   'Buy Me a Coffee — a takeaway cup with rising steam and a heart-and-prompt emblem', 1779100000000);
