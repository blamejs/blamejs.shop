-- refund-automation: auto-refund eligibility + execution rules.
--
-- Composes the existing refund-side primitives without owning their
-- responsibilities. `refundPolicy` (migration 0090) answers the
-- upstream question "is a refund permitted at all?"; this primitive
-- answers the narrower follow-on question "is this specific refund
-- request safe to issue WITHOUT operator review?" Distinct concerns:
--
--   refundPolicy        operator-authored eligibility rules
--   returns             RMA finite-state machine once a refund is
--                       accepted as eligible
--   payment.refund      processor-side money movement
--   refundAutomation    decides whether the eligible refund can skip
--                       human review and fires payment.refund when so
--
-- Two tables:
--
--   * refund_automation_rules — operator-authored auto-approval rules,
--     each scoped to a maximum refund amount, a per-customer annual
--     cap, an optional low-risk gate, and a closed set of reasons
--     and currencies the rule applies to. Operators address rules by
--     stable slug (matching coupon-stacking / refund-policy
--     convention). Higher `priority` wins; ties broken by created_at
--     ASC then slug ASC.
--
--   * refund_automation_decisions — append-only decision log keyed by
--     order_id + decided_at. Every evaluateForRefundRequest call that
--     produces an `auto_approved` verdict or an actual decline writes
--     a row; manual_review fall-through is also recorded so a
--     dashboard "refund requests waiting on a human" view is one
--     read. The audit row is the compliance receipt the operator
--     presents when reconciling automated refunds against monthly
--     ledger statements.
--
-- Schema decisions:
--
--   * slug PK on the rules table mirrors refund-policies. Operators
--     enumerate rules by slug from admin UI / scripted exports; the
--     primitive enforces a tight alnum + hyphen / underscore / dot
--     shape at the app layer.
--
--   * `max_amount_minor` (>= 1) is the per-request cap. A refund
--     request whose amount exceeds this falls through to manual
--     review regardless of every other gate — the operator authored
--     this rule as a "small enough not to worry about" lane.
--
--   * `max_refunds_per_customer_year` (>= 1) is the per-customer
--     annual cap. The evaluator counts auto-approved decisions in
--     `refund_automation_decisions` for this customer in the trailing
--     365 days; a request that would push the count past the cap
--     falls through to manual review.
--
--   * `requires_low_risk` (0/1) flips on the customerRiskProfile
--     gate. When 1, the evaluator calls the injected
--     `customerRiskProfile.bandFor(customer_id)` handle; only `low`
--     band auto-approves. Without an injected handle the gate refuses
--     the request — a missing risk signal is a manual-review signal,
--     not a free pass.
--
--   * `eligible_reasons_json` is a JSON array of reason strings the
--     rule applies to. Common operator-authored values:
--     `requested_by_customer`, `duplicate`, `fraudulent` (the
--     processor's documented set). Empty array means "any reason
--     qualifies."
--
--   * `currency_in_set_json` is a JSON array of ISO-4217 currency
--     codes the rule applies to. Empty array means "any currency
--     qualifies." Operators authoring multi-region rules use this to
--     scope the lane to a single billing currency.
--
--   * `priority` is the operator-authored tiebreaker when multiple
--     active rules could match the same request. Higher wins; ties
--     resolve by created_at ASC then slug ASC for deterministic
--     evaluation across deployments.
--
--   * `archived_at` is the soft-delete timestamp. Archived rules
--     never match. Operators reactivate a rule by clearing the field
--     via updateRule({ archived_at: null }) — though the primitive
--     surfaces archiveRule as the documented gesture and resurrection
--     is rare enough not to warrant a dedicated method.
--
-- Decisions table:
--
--   * `decision` is a closed enum: auto_approved / manual_review /
--     declined. auto_approved rows have an applied_rule slug and a
--     non-NULL amount_minor. manual_review and declined rows may have
--     a NULL applied_rule when no rule was a candidate.
--
--   * `reason` is the customer-supplied refund reason (the same value
--     passed to evaluateForRefundRequest). Audited alongside the
--     decision so the operator can later see which reasons most often
--     fall through to manual review (signal for authoring new rules
--     or widening existing ones).
--
-- Indexes:
--
--   * (active, priority DESC) on refund_automation_rules — hot read
--     in the evaluator. Single ordered scan, no separate sort.
--   * (customer_id, decided_at DESC) on refund_automation_decisions
--     — hot read for the per-customer annual cap walk.
--   * (decision, decided_at DESC) — operator dashboard "auto-refunds
--     in the last 24h" + "refunds waiting on review" feeds.
--   * (applied_rule, decided_at DESC) — metricsForRule rollup.

CREATE TABLE IF NOT EXISTS refund_automation_rules (
  slug                            TEXT NOT NULL PRIMARY KEY,
  max_amount_minor                INTEGER NOT NULL CHECK (max_amount_minor >= 1),
  max_refunds_per_customer_year   INTEGER NOT NULL CHECK (max_refunds_per_customer_year >= 1),
  requires_low_risk               INTEGER NOT NULL DEFAULT 0 CHECK (requires_low_risk IN (0, 1)),
  eligible_reasons_json           TEXT NOT NULL DEFAULT '[]',
  currency_in_set_json            TEXT NOT NULL DEFAULT '[]',
  priority                        INTEGER NOT NULL DEFAULT 0,
  active                          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at                     INTEGER,
  created_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refund_automation_rules_active_priority
  ON refund_automation_rules(active, priority DESC);

CREATE TABLE IF NOT EXISTS refund_automation_decisions (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  applied_rule    TEXT,
  decision        TEXT NOT NULL CHECK (decision IN (
                    'auto_approved',
                    'manual_review',
                    'declined'
                  )),
  amount_minor    INTEGER,
  reason          TEXT,
  decided_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refund_automation_decisions_customer
  ON refund_automation_decisions(customer_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_refund_automation_decisions_decision
  ON refund_automation_decisions(decision, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_refund_automation_decisions_rule
  ON refund_automation_decisions(applied_rule, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_refund_automation_decisions_order
  ON refund_automation_decisions(order_id, decided_at DESC);
