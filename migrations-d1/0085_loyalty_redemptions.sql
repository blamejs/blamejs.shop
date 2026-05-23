-- Loyalty redemptions — customer-facing redemption layer on top of
-- the `loyalty` points ledger.
--
-- Two tables:
--
--   * `loyalty_rewards` — operator-authored catalog of redeemable
--     items. Slug PK. `kind` is a CHECK-bounded enum
--     (discount_percent / discount_amount / free_product /
--     free_shipping). `point_cost` is the price in points (must be
--     > 0). `value_json` is the per-kind payload (e.g.
--     {"percent":10} for discount_percent, {"amount_minor":500} for
--     discount_amount, {"product_id":"…"} for free_product, {} for
--     free_shipping). `max_per_customer` is an optional lifetime cap
--     — when set, a customer who has reached the cap is refused at
--     `redeemForCustomer`. `expires_days_after_redemption` is an
--     optional sliding window after which an UN-CONSUMED redemption
--     expires; null means redemption never expires.
--
--   * `loyalty_redemptions` — one row per redemption event. `id` is
--     the redemption UUID. `status` is the FSM column:
--       active     — points debited, coupon minted (if coupons
--                    handle injected at factory time), not yet
--                    consumed at checkout.
--       consumed   — markConsumed has fired; the redemption is
--                    settled against `order_id`.
--       expired    — the sliding window elapsed without consumption.
--       cancelled  — operator-initiated rollback. Refunds the
--                    debited points IF status was 'active' at the
--                    time of cancel (a consumed redemption is too
--                    late to refund through this primitive — operators
--                    issue a manual `loyalty.adjust` row in that
--                    case).
--     `coupon_code` is the bearer credential the coupons primitive
--     minted on the operator's behalf; nullable so the primitive
--     stays functional when the operator has not wired a coupons
--     handle (the redemption is then a points-only event the
--     operator's UI surfaces and applies manually).
--
-- Schema decisions:
--
--   * `loyalty_rewards.archived_at` is the soft-delete timestamp.
--     Archived rewards stay readable for historical redemptions but
--     never surface in `listRewards({ active_only: true })`.
--
--   * `loyalty_redemptions.expires_at` is the absolute deadline (epoch
--     ms) computed at redemption time from
--     `loyalty_rewards.expires_days_after_redemption`. Storing the
--     absolute value (vs. recomputing from redeemed_at + window)
--     means a reward whose window changes after redemption doesn't
--     retroactively expire / re-validate prior redemptions.
--
--   * `consumed_at` / `order_id` populate on the consume transition;
--     `cancel_reason` populates on the cancel transition. The three
--     FSM-exit columns are nullable on the row's `active` state and
--     filled by the matching transition.
--
-- Indexes:
--
--   * `(customer_id, redeemed_at DESC)` — drives the
--     `redemptionsForCustomer` cursor pagination + the
--     `max_per_customer` count.
--   * `(reward_slug, customer_id)` — drives the per-customer cap
--     count without scanning the full redemptions table when a
--     popular reward is queried for one customer.
--   * `(status, expires_at)` — drives the operator sweep that
--     transitions expired-but-not-yet-marked redemptions to status
--     'expired' on a scheduled job.

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  slug                          TEXT NOT NULL PRIMARY KEY,
  kind                          TEXT NOT NULL CHECK (kind IN ('discount_percent','discount_amount','free_product','free_shipping')),
  title                         TEXT NOT NULL,
  point_cost                    INTEGER NOT NULL CHECK (point_cost > 0),
  value_json                    TEXT NOT NULL DEFAULT '{}',
  max_per_customer              INTEGER,
  expires_days_after_redemption INTEGER,
  active                        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at                   INTEGER,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id              TEXT NOT NULL PRIMARY KEY,
  customer_id     TEXT NOT NULL,
  reward_slug     TEXT NOT NULL,
  points_debited  INTEGER NOT NULL CHECK (points_debited > 0),
  coupon_code     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('active','consumed','expired','cancelled')),
  redeemed_at     INTEGER NOT NULL,
  consumed_at     INTEGER,
  expires_at      INTEGER,
  order_id        TEXT,
  cancel_reason   TEXT,
  FOREIGN KEY (reward_slug) REFERENCES loyalty_rewards(slug)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_customer
  ON loyalty_redemptions(customer_id, redeemed_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_reward_customer
  ON loyalty_redemptions(reward_slug, customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_status_expires
  ON loyalty_redemptions(status, expires_at);
