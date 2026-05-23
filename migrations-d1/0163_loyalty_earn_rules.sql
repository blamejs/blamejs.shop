-- Loyalty earn rules — per-action point-earning rules. Distinct from
-- the loyalty ledger (which records the balance + transactions) and
-- from tier benefits (which configures perks at each tier). This
-- table defines HOW points are earned: per-dollar spent, per-purchase,
-- per-review submitted, per-referral redeemed, birthday bonus, signup
-- bonus, first-purchase bonus, abandoned-cart-recovered bonus.
--
-- Two tables:
--
--   loyalty_earn_rules — one row per operator-defined rule. `slug` is
--                        the stable identifier (lowercase alnum +
--                        dash, max 100 chars) and is the PRIMARY KEY.
--                        `trigger` is the event that fires the rule,
--                        from a fixed enum so the rollup / dispatch
--                        path can switch on a known set. The eight
--                        triggers cover the conversion-funnel motions
--                        that operators routinely reward:
--                          per_dollar_spent            — N points per
--                                                        $1 of order
--                                                        subtotal (the
--                                                        primary
--                                                        revenue-tied
--                                                        rule)
--                          per_purchase               — flat N points
--                                                        per completed
--                                                        order
--                                                        regardless of
--                                                        size
--                          per_review                 — N points when
--                                                        a customer
--                                                        submits a
--                                                        product
--                                                        review
--                          per_referral_redeemed     — N points when
--                                                        a referred
--                                                        friend's
--                                                        first order
--                                                        completes
--                          birthday                   — N points
--                                                        granted on
--                                                        the
--                                                        customer's
--                                                        birthday
--                          signup_bonus               — N points
--                                                        granted on
--                                                        account
--                                                        creation
--                          first_purchase             — N points
--                                                        granted on
--                                                        the
--                                                        customer's
--                                                        first ever
--                                                        completed
--                                                        order
--                          abandoned_cart_recovered   — N points
--                                                        when an
--                                                        abandoned
--                                                        cart converts
--                                                        via the
--                                                        recovery
--                                                        flow
--                        `points_per_unit` is a positive integer — for
--                        unit-priced rules (per_dollar_spent /
--                        per_purchase) it's the multiplier; for flat
--                        rules (birthday / signup_bonus / etc.) it's
--                        the flat amount. `max_per_event` is an
--                        optional cap so a $100,000 wholesale order at
--                        10 points/$ doesn't mint a million-point
-- balance; NULL means uncapped.
--                        `customer_status_in_json` is an optional JSON
--                        array of customer-status strings the rule
--                        applies to (e.g. ["active", "vip"]); NULL
--                        means every customer is eligible.
--                        `active` gates evaluation — operators flip a
--                        rule off without deleting it so the historical
--                        ledger keeps its breadcrumb. `archived_at` is
--                        the soft-delete tombstone.
--
--   loyalty_earn_log  — append-only audit row per award. The (rule_slug,
--                        customer_id, trigger_event_ref) UNIQUE
--                        constraint prevents the same event from
--                        re-awarding when the upstream caller retries
--                        a delivery. `trigger_event_ref` is the caller-
--                        supplied dedup key (order_id, review_id,
--                        referral_id, ...) — opaque to the schema.
--
-- Indexes drive the four hot read paths:
--   * (trigger, active)          — evaluateForEvent rule lookup
--   * (active, archived_at)      — listRules({ active_only: true })
--   * (rule_slug, occurred_at)   — metricsForRule window scan
--   * (customer_id, occurred_at) — per-customer audit timeline

CREATE TABLE IF NOT EXISTS loyalty_earn_rules (
  slug                     TEXT    NOT NULL PRIMARY KEY,
  trigger                  TEXT    NOT NULL CHECK (trigger IN (
                              'per_dollar_spent', 'per_purchase', 'per_review',
                              'per_referral_redeemed', 'birthday',
                              'signup_bonus', 'first_purchase',
                              'abandoned_cart_recovered'
                            )),
  points_per_unit          INTEGER NOT NULL CHECK (points_per_unit > 0),
  max_per_event            INTEGER CHECK (max_per_event IS NULL OR max_per_event > 0),
  customer_status_in_json  TEXT,
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loyalty_earn_rules_trigger  ON loyalty_earn_rules(trigger, active);
CREATE INDEX IF NOT EXISTS idx_loyalty_earn_rules_active   ON loyalty_earn_rules(active, archived_at);

CREATE TABLE IF NOT EXISTS loyalty_earn_log (
  id                  TEXT    NOT NULL PRIMARY KEY,
  rule_slug           TEXT    NOT NULL,
  customer_id         TEXT    NOT NULL,
  points_awarded      INTEGER NOT NULL CHECK (points_awarded >= 0),
  trigger_event_ref   TEXT    NOT NULL,
  occurred_at         INTEGER NOT NULL,
  FOREIGN KEY (rule_slug) REFERENCES loyalty_earn_rules(slug) ON DELETE CASCADE,
  UNIQUE (rule_slug, customer_id, trigger_event_ref)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_earn_log_rule     ON loyalty_earn_log(rule_slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_earn_log_customer ON loyalty_earn_log(customer_id, occurred_at);
