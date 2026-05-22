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

-- 5. Operator Hoodie (apparel) — $74
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000005', 'operator-hoodie',
   'Operator Hoodie',
   'Heavyweight 450gsm fleece pullover with the shield wordmark across the chest and a kangaroo pocket sized for a notebook. Cut roomy so it lives over a tee for the late-night incident-response shift.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000015', '00000000-0000-7000-8000-000000000005',
   'OPR-HOD-BLK-L', 'Black · L', '{"color":"Black","size":"L"}',
   620, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000025', '00000000-0000-7000-8000-000000000015',
   'USD', 7400, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('OPR-HOD-BLK-L', 30, 0, 1779000000000);

-- 6. Vault Stick (hardware) — $129
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000006', 'vault-stick',
   'Vault Stick',
   'USB-A hardware authenticator that ships with an ML-DSA-65 keypair generated on-device and never leaves the silicon. Touch the ring to attest; the green LED pulses once on success.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000016', '00000000-0000-7000-8000-000000000006',
   'VLT-STK-V1', 'v1', '{"hw":"v1"}',
   18, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000026', '00000000-0000-7000-8000-000000000016',
   'USD', 12900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('VLT-STK-V1', 60, 0, 1779000000000);

-- 7. Signing Cable (hardware) — $49
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000007', 'signing-cable',
   'Signing Cable',
   'One-meter USB-C to USB-C cable with an in-line ML-DSA-65 signing chip. Sign release artifacts from any laptop without trusting the laptop — the chip holds the key, the cable does the rest.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000017', '00000000-0000-7000-8000-000000000007',
   'SGN-CBL-1M', '1m · USB-C', '{"length":"1m","connector":"usb-c"}',
   60, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000027', '00000000-0000-7000-8000-000000000017',
   'USD', 4900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('SGN-CBL-1M', 120, 0, 1779000000000);

-- 8. Build Pass (digital) — $299
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000008', 'build-pass',
   'Build Pass',
   'Annual CI license for the blamejs build infrastructure — unlimited build minutes on a single project, signed receipts attached to every artifact, and a deprecation calendar that never pulls the rug mid-quarter.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000018', '00000000-0000-7000-8000-000000000008',
   'BLD-PSS-1Y', '1 year', '{"term":"1y"}',
   0, 0, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000028', '00000000-0000-7000-8000-000000000018',
   'USD', 29900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('BLD-PSS-1Y', 9999, 0, 1779000000000);

-- 9. Audit Log Kit (bundle) — $59
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000009', 'audit-log-kit',
   'Audit Log Kit',
   'Three numbered hardcover notebooks — Volumes I, II, III — pre-stamped with serial numbers and shipped with a wax-style holographic seal. The paper trail your post-mortem deserves.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000019', '00000000-0000-7000-8000-000000000009',
   'AUD-LOG-KIT3', 'Set of 3', '{"volumes":"I-III"}',
   780, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-000000000029', '00000000-0000-7000-8000-000000000019',
   'USD', 5900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('AUD-LOG-KIT3', 40, 0, 1779000000000);

-- 10. Self-Hosted Plan (digital) — $1,200
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-00000000000a', 'self-hosted-plan',
   'Self-Hosted Plan',
   'Annual support license for self-hosted blamejs deployments — your servers, your keys, our pager. Includes incident-response runbooks, an upgrade window calendar, and a direct line for stuck migrations.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-00000000001a', '00000000-0000-7000-8000-00000000000a',
   'SHP-SUP-1Y', '1 year', '{"term":"1y"}',
   0, 0, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-00000000002a', '00000000-0000-7000-8000-00000000001a',
   'USD', 120000, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('SHP-SUP-1Y', 9999, 0, 1779000000000);

-- 11. Operator Mug (apparel) — $22
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-00000000000b', 'operator-mug',
   'Operator Mug',
   'Eleven-ounce stoneware mug with the shield wordmark printed in fired ceramic. Dishwasher safe, microwave safe, on-call safe. Holds enough coffee to read the whole runbook.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-00000000001b', '00000000-0000-7000-8000-00000000000b',
   'OPR-MUG-11', '11oz · White', '{"size":"11oz","color":"White"}',
   380, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-00000000002b', '00000000-0000-7000-8000-00000000001b',
   'USD', 2200, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('OPR-MUG-11', 80, 0, 1779000000000);

-- 12. Sticker Pack (apparel) — $9
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-00000000000c', 'sticker-pack',
   'Sticker Pack',
   'Six die-cut vinyl decals — shield, PQC badge, SBOM tag, wordmark, brace-pair, and approved checkmark. Weather-rated for laptops, hardware cases, and the side of a deployed Edge Reader.',
   'active', 1779000000000, 1779000000000);
INSERT OR IGNORE INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) VALUES
  ('00000000-0000-7000-8000-00000000001c', '00000000-0000-7000-8000-00000000000c',
   'STK-PCK-6', 'Set of 6', '{"count":6}',
   30, 1, 0, 1779000000000, 1779000000000);
INSERT OR IGNORE INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) VALUES
  ('00000000-0000-7000-8000-00000000002c', '00000000-0000-7000-8000-00000000001c',
   'USD', 900, 1779000000000, NULL, 1779000000000);
INSERT OR IGNORE INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES
  ('STK-PCK-6', 200, 0, 1779000000000);
