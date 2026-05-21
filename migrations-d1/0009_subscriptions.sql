-- Subscriptions: Stripe-backed recurring billing.
--
-- Two tables:
--
--   subscription_plans — the catalog-side recurring offer. Operators
--     pre-create the recurring Price in Stripe (so Stripe holds the
--     pricing source of truth), then mirror the price id + interval
--     + amount here so the storefront can render the plan without a
--     network hop. A plan MAY link to a variant for storefront
--     surfacing, but standalone plans (no variant) are also valid —
--     e.g. an opaque service tier with no physical SKU.
--
--   subscriptions — one row per active customer subscription. Mirrors
--     Stripe's subscription object (id, status, current_period_*).
--     The local row is updated from `customer.subscription.*`
--     webhook deliveries so the shop has an authoritative status
--     view without hitting Stripe on every read.
--
-- Status values mirror Stripe's enum exactly so a webhook event
-- replays into the row without translation.

CREATE TABLE IF NOT EXISTS subscription_plans (
  id                TEXT NOT NULL PRIMARY KEY,
  variant_id        TEXT,
  stripe_price_id   TEXT NOT NULL,
  interval          TEXT NOT NULL CHECK (interval IN ('day', 'week', 'month', 'year')),
  interval_count    INTEGER NOT NULL DEFAULT 1 CHECK (interval_count >= 1 AND interval_count <= 12),
  currency          TEXT NOT NULL CHECK (length(currency) = 3),
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  trial_days        INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0 AND trial_days <= 730),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_variant ON subscription_plans(variant_id);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_active  ON subscription_plans(active);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      TEXT NOT NULL PRIMARY KEY,
  customer_id             TEXT NOT NULL,
  plan_id                 TEXT NOT NULL,
  stripe_subscription_id  TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid')),
  current_period_start    INTEGER,
  current_period_end      INTEGER,
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer        ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status          ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_id       ON subscriptions(stripe_subscription_id);
