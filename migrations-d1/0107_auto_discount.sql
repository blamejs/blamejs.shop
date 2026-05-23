-- Automatic discounts — operator-defined rules that apply to a cart
-- without requiring a coupon code. The cart-resolution layer consults
-- this primitive and applies every rule whose trigger matches, in
-- priority order.
--
-- Distinct from `couponStacking` (which gates per-code combination
-- decisions) and from `quantityDiscounts` (which decides per-line
-- price breaks against the catalog scope graph). An autoDiscount rule
-- is a CART-LEVEL automatic — "free shipping over $50", "10% off when
-- you buy 3 items from category X", "BOGO on tag SALE" — that the
-- shopper never types.
--
-- Schema decisions:
--
--   * `slug` is the PK. Operators address rules by stable human-readable
--     handles (`free-ship-50`, `bogo-sale-tag`); the primitive enforces
--     a tight alnum + hyphen / underscore shape at the app layer.
--
--   * `trigger_json` carries the trigger shape as JSON because the
--     trigger surface is open-ended (cart_total_min, item_count_min,
--     sku_purchase today; future kinds added without a schema bump).
--     The primitive parses + validates the shape at define time.
--
--   * `value_json` carries the discount shape — `percent_off`,
--     `amount_off_total`, `amount_off_each`, `free_shipping`, `bogo`.
--     Same forward-compatibility reasoning as trigger_json.
--
--   * `applies_to_json` is the OPTIONAL line-scope filter that gates
--     which cart lines the value applies to (e.g. amount_off_each
--     applies only to lines whose tag = "SALE"). NULL = whole cart.
--
--   * `customer_segment_in_json` is a JSON array of segment slugs. When
--     non-empty, the rule only applies to carts whose customer resolves
--     into at least one named segment (via an injected
--     `customerSegments` handle). Carts without a customer_id never
--     satisfy a segment-gated rule.
--
--   * `exclusions_json` lists `{ kind, value }` exclusion entries that
--     short-circuit rule application. The current vocabulary is
--     `{ kind: 'sku', value: '<sku>' }` (refuse if the cart contains
--     this sku) and `{ kind: 'category', value: '<cat>' }` (refuse if
--     any line is tagged with this category). Forward-compatible JSON
--     so new exclusion kinds add without a schema bump.
--
--   * `priority` orders the rules during evaluate(). Higher priority
--     wins ties on the same value-kind; multiple rules can stack
--     across kinds (an `amount_off_total` and a `free_shipping` can
--     both apply on the same cart).
--
--   * `starts_at` / `expires_at` are nullable epoch-ms windows. NULL
--     means "no boundary on that side". The evaluator filters rules
--     by the live window.
--
--   * `max_redemptions_total` caps total uses across all customers.
--     NULL = unlimited. The application layer enforces the cap by
--     joining the rule row's `redemptions_used` counter (bumped via
--     `recordApplication`) against the cap.
--
--   * `max_redemptions_per_customer` caps per-customer uses. NULL =
--     unlimited. The evaluator counts prior applications for the
--     given customer_id against the cap when both the rule and the
--     customer_id are present.
--
--   * `active` (default 1) flips the rule on/off without destroying it.
--     `archived_at` is the soft-delete timestamp; archived rules are
--     excluded from evaluation regardless of `active`.
--
--   * `redemptions_used` is a denormalized counter that the
--     `recordApplication` path bumps atomically. The companion
--     `auto_discount_applications` table is the canonical event log;
--     the counter exists so the cap check is a single-row read on
--     `evaluate`.
--
-- Indexes:
--   * (active, archived_at, priority DESC) — the hot read path in
--     `evaluate` walks active, non-archived rules in priority-DESC
--     order. The DESC direction is encoded so the lookup is a single
--     ordered scan.
--
--   * applications (rule_slug, applied_at) — backs the metricsForRule
--     window scan ordered by time.
--
--   * applications (rule_slug, customer_id) — backs the per-customer
--     cap check during evaluate.

CREATE TABLE IF NOT EXISTS auto_discount_rules (
  slug                          TEXT NOT NULL PRIMARY KEY,
  title                         TEXT NOT NULL,
  trigger_json                  TEXT NOT NULL,
  value_json                    TEXT NOT NULL,
  applies_to_json               TEXT,
  customer_segment_in_json      TEXT NOT NULL DEFAULT '[]',
  exclusions_json               TEXT NOT NULL DEFAULT '[]',
  priority                      INTEGER NOT NULL DEFAULT 0,
  starts_at                     INTEGER,
  expires_at                    INTEGER,
  max_redemptions_total         INTEGER,
  max_redemptions_per_customer  INTEGER,
  active                        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at                   INTEGER,
  redemptions_used              INTEGER NOT NULL DEFAULT 0 CHECK (redemptions_used >= 0),
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  CHECK (max_redemptions_total IS NULL OR max_redemptions_total >= 0),
  CHECK (max_redemptions_per_customer IS NULL OR max_redemptions_per_customer >= 0),
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS auto_discount_applications (
  id              TEXT NOT NULL PRIMARY KEY,
  rule_slug       TEXT NOT NULL REFERENCES auto_discount_rules(slug) ON DELETE CASCADE,
  order_id        TEXT NOT NULL,
  customer_id     TEXT,
  savings_minor   INTEGER NOT NULL CHECK (savings_minor >= 0),
  applied_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auto_discount_rules_active_priority
  ON auto_discount_rules(active, archived_at, priority DESC);

CREATE INDEX IF NOT EXISTS idx_auto_discount_apps_rule_time
  ON auto_discount_applications(rule_slug, applied_at);

CREATE INDEX IF NOT EXISTS idx_auto_discount_apps_rule_customer
  ON auto_discount_applications(rule_slug, customer_id);
