-- Discounts + redemptions: coupon-code primitive for the storefront.
--
-- `discounts` is the rule definition (code, type, value, time
-- window, usage cap, currency scope). `discount_redemptions` is the
-- per-order audit log appended whenever a discount is applied at
-- checkout.confirm time. The split lets analytics queries answer
-- "how often was DISC25 used last week" without rescanning the
-- orders table for matching subtotal/discount pairs.
--
-- Code lookup is case-insensitive — the operator may publish
-- `summer-25` in marketing copy and the customer types `SUMMER-25`
-- in the form; both resolve to the same row. We normalize input to
-- uppercase before write + use `lower(code)` indexes for lookups.
--
-- value_bps_or_minor carries two distinct semantics keyed by `type`:
--   - percent_off: integer basis points (1 bps = 0.01%); 10000 = 100%
--   - fixed_off:   integer minor units of `currency`
-- The discount engine refuses a percent value > 10000 at write +
-- refuses a fixed_off row without a currency at write. The runtime
-- resolver also clamps the computed discount to the cart subtotal
-- so a $50 coupon on a $10 cart never goes negative.

CREATE TABLE IF NOT EXISTS discounts (
  id                   TEXT NOT NULL PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  type                 TEXT NOT NULL CHECK (type IN ('percent_off', 'fixed_off')),
  value_bps_or_minor   INTEGER NOT NULL CHECK (value_bps_or_minor >= 0),
  currency             TEXT,
  min_subtotal_minor   INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal_minor >= 0),
  max_uses             INTEGER,
  uses                 INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  starts_at            INTEGER,
  ends_at              INTEGER,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK (
    (type = 'percent_off' AND value_bps_or_minor <= 10000 AND currency IS NULL) OR
    (type = 'fixed_off'   AND currency IS NOT NULL AND length(currency) = 3)
  ),
  CHECK (max_uses IS NULL OR max_uses >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discounts_code_ci ON discounts(lower(code));
CREATE INDEX        IF NOT EXISTS idx_discounts_active  ON discounts(active);

CREATE TABLE IF NOT EXISTS discount_redemptions (
  id            TEXT NOT NULL PRIMARY KEY,
  discount_id   TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  redeemed_at   INTEGER NOT NULL,
  FOREIGN KEY (discount_id) REFERENCES discounts(id),
  FOREIGN KEY (order_id)    REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_discount ON discount_redemptions(discount_id, redeemed_at);
CREATE INDEX IF NOT EXISTS idx_discount_redemptions_order    ON discount_redemptions(order_id);
