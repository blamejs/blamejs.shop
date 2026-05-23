-- Metered usage — usage-based pricing companion to the recurring-
-- billing primitives. Subscriptions where some portion of the bill
-- scales with measured consumption (API calls, GB transferred,
-- compute-seconds, seats consumed for the period) need both a place
-- to land raw usage events and a place to fold those events into a
-- billable line at period close.
--
-- Two tables:
--
--   meters — operator-defined catalog of meterable resources. Slug
--   PK so the operator's instrumentation pins the meter at code-time
--   without a per-deploy UUID lookup. `unit` is operator-authored
--   free-form copy (e.g. "api_call", "GB", "seat-hour"); the
--   primitive never interprets it. Pricing is one of two shapes:
--
--     * `tier_price_minor` — flat per-unit minor-unit price (e.g.
--       100 minor units per GB).
--     * `tier_schedule_json` — JSON array of `{ up_to, price_minor }`
--       tiers. `up_to: null` is the open-ended tail tier. Quantities
--       are billed across tiers in ascending order — first N units at
--       tier 0's rate, next M units at tier 1's rate, etc. The flat
--       and tiered schedules are mutually exclusive at define time;
--       a meter has exactly one pricing shape.
--
--   `included_units_per_period` is the per-period free allowance —
--   subtracted from total_units before the tier walk. 1000 free API
--   calls per billing month is the common shape; usage above that
--   threshold pays the tier rate. `currency` is ISO 4217 stored
--   uppercase. `archived_at` is the soft-delete timestamp — archived
--   meters refuse new `recordUsage` calls but historical events stay
--   readable so prior periods still render.
--
--   meter_events — append-only usage ledger. One row per recorded
--   event. `quantity` is an integer count in the meter's unit (the
--   primitive doesn't model fractional units — instrumentation that
--   captures GB-transferred records the byte count and lets the
--   meter slug carry the unit semantics, or rounds at the call
--   site). `occurred_at` is the epoch-ms timestamp the event
--   represents (operator-supplied; defaults to now when omitted) so
--   late-arriving events still land in their true period rather
--   than the wall-clock-now period.
--
--   `idempotency_key` is the optional dedup key — the same event
--   re-submitted (e.g. webhook redelivery, retry-on-network-error
--   from an instrumentation library) collapses to one row. UNIQUE
--   when present, NULL allowed (and not unique-collapsed by SQLite's
--   NULL-is-distinct semantics) for callers that don't track keys.
--
--   `period_start` / `period_end` are optional pre-bucketed window
--   markers — when the caller knows the billing period at record
--   time it carries them through; otherwise `usageForPeriod` slices
--   by `occurred_at` against the [period_start, period_end] range
--   the caller hands in at query time.
--
-- Indexes:
--   * `(subscription_id, meter_slug, occurred_at DESC)` — the
--     primary read path: "all events for subscription S on meter M
--     in window [from, to]". Ordering by occurred_at lets the
--     period-window scan terminate early once it crosses the window
--     edge.
--   * `(meter_slug, occurred_at)` — drives operator-side reporting
--     across all subscriptions for a single meter (e.g. "total API
--     calls this hour across the fleet").
--   * `(idempotency_key)` — supports the dedup lookup before the
--     INSERT. UNIQUE-WHERE-NOT-NULL keeps NULL-keyed events
--     unaffected.

CREATE TABLE IF NOT EXISTS meters (
  slug                       TEXT NOT NULL PRIMARY KEY,
  title                      TEXT NOT NULL,
  unit                       TEXT NOT NULL,
  tier_price_minor           INTEGER,
  tier_schedule_json         TEXT,
  included_units_per_period  INTEGER NOT NULL DEFAULT 0 CHECK (included_units_per_period >= 0),
  currency                   TEXT NOT NULL CHECK (length(currency) = 3),
  archived_at                INTEGER,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  CHECK (
    (tier_price_minor IS NOT NULL AND tier_schedule_json IS NULL)
    OR (tier_price_minor IS NULL AND tier_schedule_json IS NOT NULL)
  ),
  CHECK (tier_price_minor IS NULL OR tier_price_minor >= 0)
);

CREATE TABLE IF NOT EXISTS meter_events (
  id               TEXT NOT NULL PRIMARY KEY,
  subscription_id  TEXT NOT NULL,
  meter_slug       TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity >= 0),
  idempotency_key  TEXT,
  occurred_at      INTEGER NOT NULL,
  period_start     INTEGER,
  period_end       INTEGER,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (meter_slug) REFERENCES meters(slug)
);

CREATE INDEX IF NOT EXISTS idx_meter_events_sub_meter_time
  ON meter_events(subscription_id, meter_slug, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_meter_events_meter_time
  ON meter_events(meter_slug, occurred_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meter_events_idem
  ON meter_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
