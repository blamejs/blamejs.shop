-- Fulfillment SLA — per-priority shipping + delivery deadlines and
-- per-order breach tracking. Operators define priority-keyed policies
-- ("standard ships in 48h", "same-day before 2pm local", "overnight
-- delivers in 24h"); the primitive evaluates each order against the
-- matching policy, surfaces breaches, and computes on-time-rate metrics
-- for operator dashboards.
--
-- Two tables.
--
-- `fulfillment_sla_policies` — one row per operator-defined policy.
-- `slug` is the stable identifier operators reference in code + UI
-- (URLs, picker labels). `priority` is the FSM enum that maps an order
-- to a policy: an order's `priority` field selects which policy applies
-- so a single storefront can ship multiple service levels in parallel.
-- `ship_within_hours` is the deadline from the order's `placed_at` to
-- the operator's commitment to handoff to the carrier; `deliver_within_
-- hours` is the deadline to the customer's door. Both are computed off
-- the SAME `placed_at` (not chained off ship_by) so a delayed handoff
-- doesn't silently extend the delivery commitment. `cutoff_local_time`
-- is the HH:MM same-day cutoff (orders placed after this roll over to
-- the next business day for clock-start purposes); `timezone` is the
-- IANA name the cutoff is interpreted against. Both are NULL for
-- always-on policies (overnight / expedited) where no business-hour
-- gate applies. `archived_at` is a soft-delete tombstone — archived
-- rows still satisfy lookups for historical orders but are filtered
-- from `topBreachingPolicies` + new `evaluateOrder` calls.
--
-- `fulfillment_sla_breaches` — append-only breach log. `breach_type`
-- is one of `ship` / `deliver` (the deadline that was missed).
-- `hours_over` is the lateness in hours (float — fractional hours are
-- common when an SLA is measured in hours, not days). `severity` is
-- derived from `hours_over` at insert time (minor < 24h, major < 72h,
-- critical >= 72h) so dashboard reads don't have to recompute the
-- bucket every fetch.
--
-- Indexes:
--   * `(priority, archived_at)` on policies — `evaluateOrder` looks up
--     the active policy by priority in one indexed seek.
--   * `(order_id, recorded_at DESC)` on breaches — `breachesForOrder`
--     returns newest-first without a sort.
--   * `(severity, recorded_at DESC)` on breaches — `currentBreaches`
--     filters by severity.
--   * `(policy_slug, recorded_at)` on breaches — `metricsForPolicy`
--     windows by policy + time range.

CREATE TABLE IF NOT EXISTS fulfillment_sla_policies (
  slug                  TEXT NOT NULL PRIMARY KEY,
  priority              TEXT NOT NULL CHECK (priority IN (
                          'standard', 'expedited', 'overnight', 'same_day'
                        )),
  ship_within_hours     REAL NOT NULL CHECK (ship_within_hours > 0),
  deliver_within_hours  REAL NOT NULL CHECK (deliver_within_hours > 0),
  cutoff_local_time     TEXT,
  timezone              TEXT,
  archived_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_sla_policies_priority
  ON fulfillment_sla_policies(priority, archived_at);

CREATE TABLE IF NOT EXISTS fulfillment_sla_breaches (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  policy_slug   TEXT NOT NULL,
  breach_type   TEXT NOT NULL CHECK (breach_type IN ('ship', 'deliver')),
  hours_over    REAL NOT NULL CHECK (hours_over >= 0),
  severity      TEXT NOT NULL CHECK (severity IN ('minor', 'major', 'critical')),
  recorded_at   INTEGER NOT NULL,
  FOREIGN KEY (policy_slug) REFERENCES fulfillment_sla_policies(slug)
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_sla_breaches_order_recorded
  ON fulfillment_sla_breaches(order_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_fulfillment_sla_breaches_severity_recorded
  ON fulfillment_sla_breaches(severity, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_fulfillment_sla_breaches_policy_recorded
  ON fulfillment_sla_breaches(policy_slug, recorded_at);
