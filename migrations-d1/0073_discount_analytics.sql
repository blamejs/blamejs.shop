-- Discount analytics — operator-dashboard aggregations over coupon
-- impressions + redemptions. Distinct from the `coupons` primitive
-- (which records the canonical redemption event tied to the order)
-- and from `quantityDiscounts` (which decides per-line price breaks
-- automatically). This surface owns the two append-only tables that
-- back the operator's "how is my discount programme performing?"
-- dashboard:
--
--   * `discount_impressions` — one row per coupon-bar render. The
--     storefront's promo-bar / hero-banner / cart-rail components
--     emit an impression whenever they show a code to a shopper. The
--     session id is hashed via
--     `namespaceHash("discount-analytics-session", session_id)` at the
--     primitive boundary so a database dump never leaks a raw session
--     cookie / device id. The dashboard's funnel surface counts BOTH
--     total impression rows (the `created` step — how many times the
--     bar rendered) and `COUNT(DISTINCT session_id_hash)` (the
--     `viewed` step — how many unique sessions saw the bar) so the
--     operator can read "we rendered the bar 100 000 times to 12 000
--     people, 800 of them redeemed it."
--
--   * `discount_redemptions` — one row per redeemed coupon, tagged
--     with the order id, the amount discounted (in minor units), and
--     the currency. The primitive does not re-derive these from the
--     `orders` table — operators record redemptions at the moment a
--     code is accepted at checkout via `recordRedemption()`. This
--     keeps the analytics surface decoupled from order FSM details
--     and lets a deployment with a custom checkout pipeline still
--     populate the dashboard. Quantity-discount tier-set redemptions
--     use the `coupon_code` convention `tier:<tier_set_id>` so the
--     same table backs the per-tier dashboard surface without a
--     parallel `tier_redemptions` table — the (coupon_code,
--     occurred_at) index handles both shapes equally.
--
-- Schema decisions:
--
--   * Append-only — no UPDATE / DELETE in the surface. A misrecorded
--     row stays in the table; the operator's data hygiene is to use
--     `recordRedemption` + `recordImpression` only at the moments
--     the events actually happen, never as a retroactive backfill
--     tool. (Re-running a checkout flow that already redeemed a code
--     will write a second row — the checkout primitive is the gate.)
--
--   * `occurred_at` is the canonical event time in epoch ms (UTC).
--     Both windowing (`from <= occurred_at < to`) and the funnel /
--     top-coupons / per-coupon aggregates use this column. The
--     `(coupon_code, occurred_at)` composite index is the primary
--     read path; the `(occurred_at)` index supports the
--     `revenueImpact` whole-window scan when no coupon filter
--     applies.
--
--   * `session_id_hash` on `discount_impressions` is the
--     `namespaceHash("discount-analytics-session", session_id)`
--     output — a hex digest (no `@`, no raw cookie material). The
--     primitive refuses a raw `session_id` longer than 256 chars and
--     hashes it once at the boundary; the database never sees the
--     plaintext.
--
--   * `currency` on `discount_redemptions` is the 3-letter ISO code
--     that travels with the order. The revenueImpact aggregate
--     groups by currency so multi-currency deployments don't mix
--     USD + EUR minor units in a single sum. A NULL currency is
--     refused at the primitive boundary; every redemption has a
--     currency by construction.
--
--   * `coupon_code` shape matches the rest of the framework's
--     code-handling primitives (coupon-stacking, etc.) — alnum +
--     hyphen + underscore + dot + colon (the colon admits the
--     `tier:<id>` convention). Length cap 96 keeps room for the
--     `tier:<uuid-v7>` shape (5 + 36 = 41 chars) plus a generous
--     margin for operator-defined codes.

CREATE TABLE IF NOT EXISTS discount_impressions (
  id               TEXT    NOT NULL PRIMARY KEY,
  coupon_code      TEXT    NOT NULL,
  session_id_hash  TEXT    NOT NULL,
  occurred_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discount_impressions_code_time
  ON discount_impressions(coupon_code, occurred_at);

CREATE INDEX IF NOT EXISTS idx_discount_impressions_time
  ON discount_impressions(occurred_at);

CREATE TABLE IF NOT EXISTS discount_redemptions (
  id               TEXT    NOT NULL PRIMARY KEY,
  coupon_code      TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,
  amount_minor     INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency         TEXT    NOT NULL,
  occurred_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_code_time
  ON discount_redemptions(coupon_code, occurred_at);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_time
  ON discount_redemptions(occurred_at);
