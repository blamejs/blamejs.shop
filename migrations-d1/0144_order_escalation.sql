-- Order escalation — operator workflow for routing orders that need
-- manual attention. Two tables:
--
--   * `order_escalation_rules`  — operator-authored rule definitions.
--     A rule names a `slug`, a JSON condition bag, a severity, and the
--     downstream side-effects to apply when an incoming order matches.
--     The condition bag is intentionally union-shaped (every key is
--     optional; absence means "ignore this dimension") so an operator
--     can author "any order with fraud_score >= 80" and "any new
--     customer placing a first order over $1000" using the same
--     surface without per-rule schema migrations.
--
--     Condition keys the primitive layer understands:
--       total_minor_min          — order grand total >= this value
--       country_in               — array of ISO-3166 alpha-2 codes
--                                  that the ship-to country must
--                                  appear in
--       prior_orders_max         — customer's prior-order count <=
--                                  this value (e.g. 0 for "first-time
--                                  buyer", 1 for "second order")
--       fraud_score_min          — fraud-screen score >= this value
--       refund_pending           — boolean; the order has a refund in
--                                  the pending FSM state
--       payment_method_kind_in   — array of payment-method kinds the
--                                  paid lane used
--                                  (card / paypal / ach / etc.)
--
--     Side-effects on match:
--       severity                 — info / warning / critical; drives
--                                  the operator-console sort + the
--                                  notification urgency
--       assigned_operator        — optional UUID of the operator who
--                                  owns escalations on this rule. The
--                                  operator-console "my queue" filter
--                                  reads this column. NULL means
--                                  unassigned — any operator with the
--                                  right role can claim it.
--       auto_tags_json           — array of tags the orchestrator's
--                                  `orderTags.applyTag` hook should
--                                  stamp on the order when the rule
--                                  fires. The primitive is hands-off
--                                  about tag taxonomy; the caller
--                                  supplies the `orderTags` stub.
--       notification_template    — opaque template handle the
--                                  notifications layer dispatches
--                                  (typically a slug into the
--                                  email-templates / sms-dispatcher
--                                  primitive). NULL skips notify.
--
--     `archived_at` soft-retires a rule. `evaluateOrder` skips
--     archived rules; `listRules` surfaces them when the operator
--     asks for the full history.
--
--   * `order_escalations`       — one row per fired escalation.
--     `status` is a 3-state FSM: open / resolved / false_positive.
--     `recordEscalation` writes `status='open'`; `resolveEscalation`
--     transitions to `resolved` and stamps `resolution` +
--     `resolved_at`; `markAsFalsePositive` transitions to
--     `false_positive` and stamps `resolution` (carrying the operator
--     reason) + `resolved_at`.
--
--     `notes` is the optional free-text operator note authored at
--     escalation time (e.g. the matched signal summary the rule
--     wants to surface in the queue row); `resolution` is the
--     close-out string written by the resolve / false-positive call.
--
-- Indexes drive four hot reads:
--   * (status, severity, occurred_at)         — openEscalations
--                                               filtered by severity
--   * (status, assigned_operator)             — openEscalations
--                                               filtered by operator
--   * (order_id, occurred_at)                 — escalationsForOrder
--   * (rule_slug, occurred_at)                — metricsForRule

CREATE TABLE IF NOT EXISTS order_escalation_rules (
  slug                  TEXT    NOT NULL PRIMARY KEY,
  conditions_json       TEXT    NOT NULL DEFAULT '{}',
  severity              TEXT    NOT NULL CHECK (severity IN (
                          'info',
                          'warning',
                          'critical'
                        )),
  assigned_operator     TEXT,
  auto_tags_json        TEXT    NOT NULL DEFAULT '[]',
  notification_template TEXT,
  archived_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_escalation_rules_archived
  ON order_escalation_rules(archived_at, severity);

CREATE TABLE IF NOT EXISTS order_escalations (
  id                 TEXT    NOT NULL PRIMARY KEY,
  order_id           TEXT    NOT NULL,
  rule_slug          TEXT    NOT NULL,
  severity           TEXT    NOT NULL CHECK (severity IN (
                       'info',
                       'warning',
                       'critical'
                     )),
  assigned_operator  TEXT,
  notes              TEXT,
  status             TEXT    NOT NULL DEFAULT 'open' CHECK (status IN (
                       'open',
                       'resolved',
                       'false_positive'
                     )),
  resolution         TEXT,
  resolved_at        INTEGER,
  occurred_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_escalations_open_severity
  ON order_escalations(status, severity, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_escalations_open_operator
  ON order_escalations(status, assigned_operator);

CREATE INDEX IF NOT EXISTS idx_order_escalations_order
  ON order_escalations(order_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_escalations_rule
  ON order_escalations(rule_slug, occurred_at DESC);
