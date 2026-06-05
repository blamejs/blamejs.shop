-- Discount codes a shopper has applied to a cart on the cart page. The
-- cart-page coupon entry validates a typed code (it must resolve to an
-- active, code-gated auto-discount rule), then persists it here so the
-- cart totals re-render with the rule's savings and checkout.confirm
-- honours the same code at charge time. This is the cart/session-scoped
-- store the checkout path reads back from — the discount math itself
-- still lives in the auto-discount engine, so there is no parallel
-- discount path.
--
--   * Keyed by `cart_id` so an anonymous (session) cart and a signed-in
--     cart both carry their applied codes; conversion / abandonment of the
--     cart row carries the codes with it (CASCADE on the cart).
--
--   * `code` is stored as the shopper typed it; `code_lower` is the
--     lower-cased form the UNIQUE constraint and the rule lookup key off,
--     so applying the same code twice (any casing) is idempotent rather
--     than stacking duplicate rows.
--
--   * `rule_slug` snapshots which auto-discount rule the code resolved to
--     at apply time. The checkout path re-resolves by code (the rule may
--     have been archived between apply and checkout), so this is an audit
--     convenience, not the authority.

CREATE TABLE IF NOT EXISTS cart_discount_codes (
  id          TEXT NOT NULL PRIMARY KEY,
  cart_id     TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  code_lower  TEXT NOT NULL,
  rule_slug   TEXT,
  applied_at  INTEGER NOT NULL,
  UNIQUE (cart_id, code_lower)
);

-- Read path: list a cart's applied codes (apply ordering).
CREATE INDEX IF NOT EXISTS idx_cart_discount_codes_cart
  ON cart_discount_codes(cart_id, applied_at);
