-- Quantity-discount tiers — automatic per-line price reductions that
-- kick in when the cart line crosses a quantity threshold.
-- Distinct from coupons (per-cart codes typed by the shopper) and
-- from bundle pricing (per-bundle-SKU): a quantity discount attaches
-- to a SCOPE (one SKU, one product, a vendor, a category, a
-- collection slug, or "everything") and a SCHEDULE of
-- (min_quantity, discount_kind, value) rules sorted ascending. The
-- pricing primitive consults this table during cart-line resolution
-- and applies the best (lowest final unit price) matching rule.
--
-- Schema decisions:
--
--   * Two tables. `qd_tier_sets` carries scope + flags + audit
--     timestamps; `qd_tiers` carries one row per (min_quantity,
--     discount_kind, value) entry, FK'd back to the parent set with
--     ON DELETE CASCADE. The split keeps "archive the whole tier
--     schedule" / "rewrite the rule rows" as separate operations.
--
--   * `scope` is a CHECK enum across the six scope levels. The
--     primitive consults them in specificity order (sku > product >
--     collection_slug > vendor > category > global) during rule
--     lookup and picks the lowest-final-price applicable rule.
--
--   * `scope_id` is the corresponding identifier (variant SKU /
--     product UUID / collection slug / vendor name / category slug)
--     and is NULL exactly when scope = 'global'. A CHECK enforces
--     that pairing.
--
--   * `exclusive` (default 0) marks "if this tier-set's best rule
--     applies, no other tier-set may stack on the same line". The
--     primitive resolves stacking at apply time; the column is
--     persisted so the rule's intent travels with the schedule.
--
--   * `archived_at` is NULL = active. The active-eval path filters
--     `WHERE archived_at IS NULL`; archive flips it to a ts, unarchive
--     flips back to NULL. Archived sets stay on disk for audit + the
--     operator-facing list view filters them out by default.
--
--   * `discount_kind` is a CHECK enum across four shapes:
--       percent_off          — value is basis points (0..10000)
--       amount_off_each      — value is minor units off each unit
--       amount_off_total     — value is minor units off the line total
--       fixed_each_price     — value is the new unit price in minor units
--     The pricing primitive applies the kind-specific math at line-
--     resolution time and clamps the discounted unit price at 0
--     (never negative).
--
--   * `value` is INTEGER and its meaning depends on `discount_kind`.
--     A CHECK clamps value >= 0; per-kind upper bounds (e.g. bps <=
--     10000) live in the application layer where they can carry
--     domain-specific error messages.
--
--   * `min_quantity` is the threshold the cart line must meet. A
--     CHECK enforces > 0. The application layer additionally refuses
--     overlapping min_quantity values within the same tier set so a
--     schedule like [{5, percent_off, 1000}, {5, amount_off_each,
--     100}] can't ship.
--
--   * `sort_order` mirrors the bundle_components convention: the
--     order the rules were declared, so the operator-facing
--     tierBreakdown table reads back in insertion order even when
--     min_quantity values are inserted out of order.
--
-- Indexes:
--   * (scope, scope_id, archived_at) covers the hot-path lookup
--     "find every active tier set for this line's SKU / product /
--     vendor / category / collection_slug / global"
--   * (tier_set_id, min_quantity) covers the per-set rule fetch
--     ordered by ascending quantity so the best-rule walk reads in
--     order without a sort step.

CREATE TABLE IF NOT EXISTS qd_tier_sets (
  id           TEXT NOT NULL PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('sku','product','collection_slug','vendor','category','global')),
  scope_id     TEXT,
  exclusive    INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1)),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (
    (scope = 'global' AND scope_id IS NULL) OR
    (scope <> 'global' AND scope_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS qd_tiers (
  id            TEXT NOT NULL PRIMARY KEY,
  tier_set_id   TEXT NOT NULL REFERENCES qd_tier_sets(id) ON DELETE CASCADE,
  min_quantity  INTEGER NOT NULL CHECK (min_quantity > 0),
  discount_kind TEXT NOT NULL CHECK (discount_kind IN ('percent_off','amount_off_each','amount_off_total','fixed_each_price')),
  value         INTEGER NOT NULL CHECK (value >= 0),
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_qd_tier_sets_scope_lookup
  ON qd_tier_sets(scope, scope_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_qd_tiers_set_minqty
  ON qd_tiers(tier_set_id, min_quantity);
