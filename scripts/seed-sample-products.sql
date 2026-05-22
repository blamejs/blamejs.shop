-- Sample catalog seed for the blamejs.shop demo storefront.
-- Run with: wrangler d1 execute blamejs-shop --remote --file=scripts/seed-sample-products.sql
--
-- Four products land in the catalog grid: a wordmark tee, an
-- edge reader, a digital license key, and a starter bundle. Each
-- has one default variant + a single USD price + initial stock.
-- Timestamps are baked at seed time (epoch ms) so the seed is
-- idempotent — re-running it via the INSERT OR IGNORE guard
-- below produces the same row set without churn.

-- 1. Operator Tee (apparel) — $32
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000001', 'operator-tee',
   'Operator Tee',
   'Heavyweight cotton tee with the shield wordmark on the chest. Cut for the operator who knows where every primitive lives.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000011', '00000000-0000-7000-8000-000000000001',
   'OPR-TEE-BLK-L', 'Black · L', '{"color":"Black","size":"L"}',
   220, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000011',
   'USD', 3200, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('OPR-TEE-BLK-L', 50, 0, 1779000000000);

-- 2. Edge Reader v1 (hardware) — $189
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000002', 'edge-reader-v1',
   'Edge Reader v1',
   'Single-purpose serial console reader sized for a workstation. USB-C, no firmware updates over the wire, hardware random source on the bottom strap.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000012', '00000000-0000-7000-8000-000000000002',
   'EDG-RDR-V1', 'v1', '{"hw":"v1"}',
   320, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000022', '00000000-0000-7000-8000-000000000012',
   'USD', 18900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('EDG-RDR-V1', 24, 0, 1779000000000);

-- 3. blamejs Operator License (digital) — $79
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000003', 'operator-license',
   'Operator License',
   'A one-year individual license to the operator playbook archive — runbooks, post-mortems, incident response templates, and an ML-DSA-signed delivery receipt for the audit log.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000013', '00000000-0000-7000-8000-000000000003',
   'OPR-LIC-1Y', '1 year', '{"term":"1y"}',
   0, 0, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000023', '00000000-0000-7000-8000-000000000013',
   'USD', 7900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('OPR-LIC-1Y', 9999, 0, 1779000000000);

-- 4. Starter Bundle (bundle) — $249
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000004', 'starter-bundle',
   'Starter Bundle',
   'One Operator Tee, one Edge Reader v1, and a year of Operator License — together at a single SKU so checkout is one click and inventory is one decrement.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000014', '00000000-0000-7000-8000-000000000004',
   'STR-BND-A', 'Bundle A', '{"set":"A"}',
   540, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000024', '00000000-0000-7000-8000-000000000014',
   'USD', 24900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('STR-BND-A', 12, 0, 1779000000000);
