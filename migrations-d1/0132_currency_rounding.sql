-- Per-currency display rounding rules + audit log of applied roundings.
--
-- Distinct from `fx_rates` (migration 0044 — operator-supplied FX rate
-- cache for cross-currency conversion). FX rates answer "how much EUR
-- is one USD"; this table answers "what increment do I snap a final
-- total to before I show it to the customer". Switzerland abolished
-- the one- and two-rappen coins; CHF retail totals round to the
-- nearest 0.05 ("Rappenrundung"). Sweden retired the öre coins; SEK
-- totals round to the nearest 0.10. JPY has no minor unit at all
-- (ISO 4217 exponent 0) — every total is already a whole yen, but
-- operators selling cross-border in JPY occasionally want a 100-yen
-- rounding step for psychological pricing.
--
-- Schema decisions:
--   * `currency` is the ISO 4217 three-letter code (primary key — one
--     active rule per currency at a time; reassign via update or
--     archive-then-redefine).
--   * `increment_minor` is the smallest unit step EXPRESSED IN THE
--     CURRENCY'S OWN MINOR UNITS. CHF rounds to 0.05 CHF = 5 cents
--     (rappen) = `increment_minor = 5`. JPY rounds to 100 yen =
--     `increment_minor = 100` (JPY has no minor unit; "minor" here is
--     the integer storage unit). Must be a positive integer; 1 is the
--     identity rule (no rounding).
--   * `mode` is a CHECK-bounded enum:
--       half_up    — 0.5 rounds away from zero (the colloquial "round up")
--       half_even  — 0.5 rounds to the nearest even multiple (banker's)
--       half_down  — 0.5 rounds toward zero
--       ceiling    — always rounds toward +infinity
--       floor      — always rounds toward -infinity (toward zero for
--                    non-negative totals)
--   * `applies_to` is a CHECK-bounded enum:
--       display_only — render only; the persisted totals on the order
--                      remain unrounded so downstream FX / refund math
--                      stays exact
--       cart_total   — apply to the cart's grand total only (line
--                      totals stay unrounded)
--       line_total   — apply to each line total
--       all          — apply to every monetary figure the rendering
--                      layer pulls
--   * `active` is a 0/1 flag so archived rules survive for audit
--     replay without re-shaping the table.
--   * `archived_at` is nullable epoch-ms; non-NULL iff `active = 0`.
--   * `created_at` / `updated_at` are operator-supplied epoch-ms (the
--     primitive layer defaults to "now"). Strictly monotonic per
--     currency by primitive-layer convention so a tied-millisecond
--     update doesn't lose ordering.
--
-- The audit log captures every applied rounding so an operator can
-- reconcile a checkout total against the rule that produced it. The
-- log is append-only by convention — no UPDATE/DELETE path is exposed
-- by the primitive.

CREATE TABLE IF NOT EXISTS currency_rounding_rules (
  currency         TEXT NOT NULL PRIMARY KEY,
  increment_minor  INTEGER NOT NULL CHECK (increment_minor > 0),
  mode             TEXT NOT NULL CHECK (mode IN ('half_up', 'half_even', 'half_down', 'ceiling', 'floor')),
  applies_to       TEXT NOT NULL CHECK (applies_to IN ('display_only', 'cart_total', 'line_total', 'all')),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_currency_rounding_rules_active
  ON currency_rounding_rules(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS currency_rounding_log (
  id                TEXT NOT NULL PRIMARY KEY,
  currency          TEXT NOT NULL,
  original_minor    INTEGER NOT NULL,
  rounded_minor     INTEGER NOT NULL,
  adjustment_minor  INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('display_only', 'cart_total', 'line_total', 'all')),
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_currency_rounding_log_currency
  ON currency_rounding_log(currency, occurred_at DESC);
