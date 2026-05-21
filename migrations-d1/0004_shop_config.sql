-- Shop config: operator-tunable runtime configuration.
--
-- Keyed table that holds JSON-shaped values. Operators set keys via
-- the admin API (`PUT /admin/config/:key`) and the storefront /
-- checkout primitives read them at request time. The schema is
-- deliberately generic — one row per key, value is a TEXT-encoded
-- JSON blob — so the operator can ship new config shapes without a
-- migration. Each key has its own version field so the
-- `updated_at` timestamp tracks last mutation and concurrent
-- writers can detect stale snapshots.
--
-- Conventional keys (operator-shaped; framework documents them in
-- docs/admin-config.md once that lands):
--
--   tax.rules               Array<{country, state?, postal_prefix?, rate_bps}>
--   shipping.services       Array<{id, label, zones[], free_over_minor?, digital_only?}>
--   shipping.default_id     string — selected_shipping_id fallback
--   shop.name               string — header brand text
--   shop.support_email      string — From/Reply-To for transactional mail
--
-- The framework refuses to write a value that doesn't round-trip
-- through JSON.parse; corrupted rows surface at read with a typed
-- ConfigError so the operator catches the bug at admin-write time
-- rather than at customer-checkout time.

CREATE TABLE IF NOT EXISTS shop_config (
  key         TEXT NOT NULL PRIMARY KEY,
  value_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shop_config_updated_at ON shop_config(updated_at);
