-- Per-loyalty-tier benefits — operator-defined perks that gate
-- storefront + checkout features by the customer's current tier.
--
-- A benefit is a (tier, kind) pair plus a typed value: "platinum
-- gets free shipping", "gold gets 15% off", "silver gets early
-- access to drops". The storefront resolves the customer's tier via
-- the `loyalty` primitive and asks `benefitsForCustomer(id)` for the
-- active set; checkout asks the same primitive whether free-shipping
-- / percent-off applies before computing totals.
--
-- Distinct from `loyalty` (which tracks points + tier placement) and
-- from `loyaltyRedemption` (which spends points for a one-shot
-- coupon). Tier benefits are persistent perks the customer enjoys
-- continuously as long as their lifetime points keep them at the
-- tier — they cost nothing to "redeem" and don't decrement any
-- balance.
--
-- Schema decisions:
--
--   * `tier_benefits.slug` is the operator-facing primary key
--     (e.g. "platinum-free-ship", "gold-15-off", "vip-early-access").
--     Lowercase / digits / `_-.` only — refused at the primitive
--     layer for control bytes / over-length / non-conforming shape.
--
--   * `tier` is a free-form string (not CHECK-constrained) because
--     the `loyalty` primitive accepts operator-tuned tier ladders.
--     Default deployments use bronze/silver/gold/platinum; an
--     operator that adds a "diamond" tier upstream wires benefits
--     for it without an additional migration. The primitive
--     normalizes by lowercasing.
--
--   * `kind` is a closed CHECK enum:
--       free_shipping     — gate the shipping primitive into the
--                           "no charge" branch. value_json carries
--                           optional caps: `{ "min_order_minor":
--                           N }` to require a threshold.
--       percent_off       — discount_minor = ceil(subtotal * pct).
--                           value_json: `{ "percent": 15 }` (1-100).
--       early_access      — boolean feature flag. value_json:
--                           `{ "hours": 24 }` (how long before the
--                           public drop the tier sees the SKU).
--       priority_support  — boolean / SLA tier. value_json:
--                           `{ "sla_minutes": 60 }`.
--       exclusive_access  — gates a SKU list / collection.
--                           value_json: `{ "collection_slug": "vip" }`.
--       birthday_bonus    — once-per-year perk on the customer's
--                           birthday. value_json: `{ "points": 500 }`
--                           or `{ "percent_off": 10 }`.
--
--   * `value_json` carries the typed parameters for the kind in a
--     canonical-JSON-ish shape. The primitive parses + validates the
--     shape per-kind so a malformed value is refused at the boundary,
--     never at a downstream `JSON.parse` site.
--
--   * `conditions_json` is an optional gating object:
--       `{ "min_order_minor": N }`     — apply only when subtotal >= N.
--       `{ "currencies": ["USD"] }`    — apply only for the listed
--                                       currencies.
--       `{ "regions": ["US","CA"] }`   — apply only in the listed
--                                       regions.
--       `{ "starts_at": ms, "ends_at": ms }` — time-window gate.
--     `benefitsForTier` + `benefitsForCustomer` filter against an
--     operator-supplied context envelope.
--
--   * `archived_at` is set by `archiveBenefit(slug)` — archived rows
--     never appear in `benefitsForTier` / `benefitsForCustomer` and
--     can't be recorded against in `recordUsage`. The row stays in
--     place so historical usage rows continue to FK-resolve.
--
-- Usage table:
--
--   * `tier_benefit_usages` records every operator-recorded usage
--     event: a free-shipping benefit firing on checkout, a percent-
--     off applied to a cart, an early-access click on a drop page.
--     The operator decides what counts as "usage" per kind —
--     checkout flows record on submit, content gates record on
--     access.
--
--   * `savings_minor` is operator-supplied and nullable — a free-
--     shipping perk records the shipping amount the customer
--     avoided; a percent-off perk records the discount applied; an
--     early-access perk has no monetary savings and stores NULL.
--     `metricsForBenefit` aggregates count + sum(savings_minor)
--     filtering NULLs from the sum.
--
--   * `context` is operator-supplied free-form text (order id,
--     drop slug, support ticket id) for correlation. Refused at the
--     primitive layer for control bytes / over-length.
--
-- Indexes:
--   * `(tier, archived_at)` on `tier_benefits` — drives the
--     `benefitsForTier` read path; the partial-archive filter rides
--     in the index so an archived-heavy table doesn't read every row
--     to find the live ones.
--   * `(benefit_slug, occurred_at DESC)` on `tier_benefit_usages` —
--     `usageForBenefit` + `metricsForBenefit` hot path.
--   * `(customer_id, occurred_at DESC)` on `tier_benefit_usages` —
--     `usageForBenefit({ customer_id })` filter path.

CREATE TABLE IF NOT EXISTS tier_benefits (
  slug             TEXT NOT NULL PRIMARY KEY,
  tier             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'free_shipping',
                     'percent_off',
                     'early_access',
                     'priority_support',
                     'exclusive_access',
                     'birthday_bonus'
                   )),
  value_json       TEXT NOT NULL,
  conditions_json  TEXT,
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tier_benefits_tier
  ON tier_benefits(tier, archived_at);

CREATE INDEX IF NOT EXISTS idx_tier_benefits_kind
  ON tier_benefits(kind, archived_at);

CREATE TABLE IF NOT EXISTS tier_benefit_usages (
  id              TEXT NOT NULL PRIMARY KEY,
  benefit_slug    TEXT NOT NULL REFERENCES tier_benefits(slug),
  customer_id     TEXT NOT NULL,
  context         TEXT,
  savings_minor   INTEGER,
  occurred_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tier_benefit_usages_benefit
  ON tier_benefit_usages(benefit_slug, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_tier_benefit_usages_customer
  ON tier_benefit_usages(customer_id, occurred_at DESC);
