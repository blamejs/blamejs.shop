-- Refund policies — operator-authored eligibility rules that decide
-- whether a customer-initiated refund request qualifies BEFORE any
-- RMA workflow opens. Distinct from `returns` (which owns the RMA
-- finite-state machine for the approved-and-being-shipped-back lane)
-- and from `payment` (which executes the money movement once an RMA
-- reaches `refund`). A refund-policy row is the upstream gate:
--
--   "This customer is requesting a refund on order O. Given the
--    order's lines, the customer's status, the calendar gap between
--    purchase and request, and whether they have a receipt — does
--    one of my active policies say yes, and if so what shape of
--    refund is on the table?"
--
-- The evaluator walks active, non-archived policies in
-- (priority DESC, created_at ASC, slug ASC) order and applies the
-- first policy whose `applies_to` scope and preconditions are
-- satisfied. Refunds the policy refuses (window expired, receipt
-- required, customer-status mismatch, every line excluded) surface
-- as `eligible: false` with a typed reason list; the caller then
-- renders a customer-facing explanation or routes to operator
-- review.
--
-- Schema decisions:
--
--   * `slug` is the PK. Operators address policies by stable
--     human-readable handle (e.g. "default-30d", "no-final-sale",
--     "vip-store-credit"); the primitive enforces a tight alnum +
--     hyphen / underscore / dot shape at the app layer to match
--     coupon-stacking / promo-banners / customer-segments
--     convention.
--
--   * `applies_to` is a closed enum:
--       all       — every order qualifies for this policy's scope
--                   gate (subject still to refund_window_days +
--                   exclusions + customer_status_in).
--       category  — at least one line on the order must NOT match
--                   the `exclusions.categories` set (i.e. the policy
--                   scopes by category-exclusion semantics — the
--                   inverse of an allow-list keeps the operator UX
--                   identical for the four exclusion axes).
--       vendor    — same shape, scoped by vendor.
--       sku       — same shape, scoped by SKU.
--       tag       — same shape, scoped by line tag.
--
--   * `refund_window_days` (>= 0) is the post-purchase window inside
--     which a refund request qualifies. A request whose
--     `request_date - order_date` (in calendar days, UTC midnight
--     boundaries) exceeds the window is refused with reason
--     `outside_refund_window`. `0` means same-day-only.
--
--   * `exclusions_json` carries four optional arrays
--     (`categories`, `vendors`, `skus`, `tags`). Any order line
--     whose attribute appears in the matching exclusion array is
--     dropped from the refundable subset. When every line is
--     excluded, the policy refuses with reason
--     `all_lines_excluded`. The JSON-field shape lets the operator
--     extend the exclusion axes without a schema bump and keeps
--     the four arrays grouped so a "show me what this policy
--     blocks" admin view is one read.
--
--   * `refund_kind` is a closed enum:
--       full              — refund up to order_total_minor.
--       partial           — refund up to (order_total_minor *
--                           partial_refund_bps / 10000).
--                           `partial_refund_bps` must be in
--                           [1, 9999]; 10000 (= 100%) is `full`
--                           and 0 is `no_refund`, both expressed by
--                           the dedicated enum slots so an operator
--                           can't accidentally author a "partial
--                           refund of 100%" that drifts under
--                           rounding.
--       store_credit_only — refund issued as store credit, not the
--                           original payment method. `max_refund_minor`
--                           still applies (the order_total cap).
--       no_refund         — the policy explicitly refuses every
--                           request in scope. Useful for "final
--                           sale" / "clearance" / "custom orders"
--                           exclusion lanes that should produce a
--                           definitive negative answer rather than
--                           falling through to a more permissive
--                           policy.
--
--   * `restocking_fee_minor` (>= 0) is deducted from
--     `max_refund_minor` at evaluate time. Defaults to 0. Charged
--     as a flat fee in minor units of the order currency; carriers
--     wanting a percentage fee author a separate policy with the
--     percentage already resolved against expected order shape, or
--     compute it in the storefront layer before authoring.
--
--   * `requires_receipt` (0/1) flips on a receipt-presence
--     precondition. When 1, an evaluate without `has_receipt: true`
--     refuses with reason `receipt_required`.
--
--   * `customer_status_in_json` is an array of customer-status
--     strings. When non-empty, the policy only applies to a request
--     whose `customer_status` matches one of the listed statuses.
--     Requests without a `customer_status` argument never satisfy a
--     status-gated policy. Common statuses operators author against:
--     `vip`, `loyalty_gold`, `first_time`, `returning`, `flagged`.
--     The primitive doesn't enumerate the status namespace — the
--     storefront layer's customer-segments / loyalty surface owns it.
--
--   * `priority` is an integer; higher wins. Ties broken by
--     `created_at ASC` then `slug ASC` so evaluation is deterministic
--     across deployments.
--
--   * `active` (default 1) flips a policy on/off without destroying
--     it; `archived_at` is the soft-delete timestamp. Both columns
--     exist for the same reason coupon-stacking carries both — pause
--     vs hide are independent gestures.
--
-- Audit log:
--
--   * `refund_policy_audit` records every `evaluate` call's input,
--     verdict, and applied policy (when one applied) keyed by
--     `order_id`. Each row carries a single canonical-JSON blob of
--     the evaluation payload + a string `decision` (eligible /
--     denied / no_policy) for operator dashboard filters. The audit
--     row is the compliance receipt the operator presents when a
--     customer disputes the refusal — "here's exactly what we knew
--     about the order at the time, and which policy governed."
--
--   * No cryptographic chain on this table; `operator_audit_events`
--     (migration 0074) is the chained log for higher-stakes admin
--     actions. Refund-evaluation receipts are append-only by
--     convention (no UPDATE / DELETE surface in the primitive) but
--     don't carry tamper-evident hashes — operators wanting
--     stronger guarantees compose this primitive with
--     operator-audit-log at the action level.
--
-- Indexes:
--   * `(active, priority DESC)` on `refund_policies` — the hot read
--     path in `evaluate` filters by active = 1 and walks
--     priority DESC. Single ordered scan, no separate sort.
--   * `(order_id, occurred_at DESC)` on `refund_policy_audit` — the
--     hot read path is "show me every evaluation against order X."
--   * `(occurred_at DESC)` on `refund_policy_audit` — global
--     "what was evaluated in the last 24h" feed for operator
--     dashboards.

CREATE TABLE IF NOT EXISTS refund_policies (
  slug                     TEXT NOT NULL PRIMARY KEY,
  title                    TEXT NOT NULL,
  applies_to               TEXT NOT NULL CHECK (applies_to IN (
                             'all',
                             'category',
                             'vendor',
                             'sku',
                             'tag'
                           )),
  refund_window_days       INTEGER NOT NULL CHECK (refund_window_days >= 0),
  exclusions_json          TEXT NOT NULL DEFAULT '{}',
  refund_kind              TEXT NOT NULL CHECK (refund_kind IN (
                             'full',
                             'partial',
                             'store_credit_only',
                             'no_refund'
                           )),
  partial_refund_bps       INTEGER CHECK (partial_refund_bps IS NULL OR (partial_refund_bps >= 1 AND partial_refund_bps <= 9999)),
  restocking_fee_minor     INTEGER NOT NULL DEFAULT 0 CHECK (restocking_fee_minor >= 0),
  requires_receipt         INTEGER NOT NULL DEFAULT 0 CHECK (requires_receipt IN (0, 1)),
  customer_status_in_json  TEXT NOT NULL DEFAULT '[]',
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  priority                 INTEGER NOT NULL DEFAULT 0,
  archived_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refund_policies_active_priority
  ON refund_policies(active, priority DESC);

CREATE TABLE IF NOT EXISTS refund_policy_audit (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  evaluation_json TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN (
                    'eligible',
                    'denied',
                    'no_policy'
                  )),
  applied_slug    TEXT,
  occurred_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refund_policy_audit_order
  ON refund_policy_audit(order_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_refund_policy_audit_occurred_at
  ON refund_policy_audit(occurred_at DESC);
