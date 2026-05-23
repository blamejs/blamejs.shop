-- Coupon stacking policies — operator-authored rules that decide
-- which coupon codes and which `quantityDiscounts` schedules may be
-- combined on the same order. The cart resolution path consults this
-- table when more than one code is presented, when an automatic
-- quantity discount has already attached to a line, or when a code
-- in the cart appears on a policy's exclusive list.
--
-- Distinct from coupons themselves (this primitive does not store
-- redemption events, expiry, or per-code discount math) and distinct
-- from `quantityDiscounts` (which decides per-line price breaks
-- automatically). The stacking policy is the gate that sits between
-- those two surfaces: "this cart is presenting codes [A, B, C] and
-- has a quantity discount on line 2 — which of those may apply
-- together?"
--
-- Schema decisions:
--
--   * `slug` is the PK. Operators address policies by a stable
--     human-readable handle (e.g. "default-stack", "vip-only");
--     the primitive enforces a tight alnum + hyphen / underscore
--     shape at the app layer.
--
--   * `allow_combine_json` carries the two booleans
--     `with_quantity_discounts` and `with_other_codes` together so
--     adding a future allow-axis (per-line vs cart-wide, etc.) is a
--     forward-compatible JSON-field add rather than a schema bump.
--     The evaluator refuses unknown allow-keys at define time so a
--     typo can't silently widen the stacking rules.
--
--   * `max_codes_per_order` caps the number of codes the policy will
--     accept on one order. A CHECK enforces >= 1 so a policy can't
--     accidentally refuse every code; "no codes" is expressed by not
--     authoring a policy, not by max_codes_per_order = 0.
--
--   * `exclusive_codes_json` is a JSON array of code strings. When
--     any code in the cart matches an entry on this list, every
--     other code on the same order is refused with reason
--     `exclusive_code_present`. The list is stored as JSON because
--     SQLite has no native array column and the evaluator only ever
--     reads it whole.
--
--   * `customer_segment_in_json` is a JSON array of segment slugs.
--     When present and non-empty, the policy only applies to a cart
--     whose `customer_id` resolves into at least one of the named
--     segments (via an injected `customerSegments` handle). Carts
--     without a customer never satisfy a segment-gated policy.
--
--   * `order_min_minor` is the cart subtotal floor (in minor units)
--     the policy requires. Defaults to 0. Carts below the floor fall
--     through to the next-priority policy.
--
--   * `priority` is an integer; higher wins. The evaluator walks
--     policies in (priority DESC, created_at ASC) order and the
--     first policy whose preconditions are satisfied (segment +
--     order_min_minor) governs the evaluation. Ties are broken by
--     creation order so two policies at the same priority resolve
--     deterministically.
--
--   * `active` (default 1) flips the policy on/off without
--     destroying it. `archived_at` is the soft-delete timestamp;
--     archived policies are excluded from evaluation regardless of
--     `active`. Both columns exist because operators want a
--     "temporarily pause this policy" gesture (active) and a
--     "remove this policy from operator-facing lists" gesture
--     (archive) and the two should not collide.
--
-- Indexes:
--   * `(active, priority DESC)` — the hot read path in `evaluate`
--     filters by active = 1 and walks priority DESC. The DESC
--     direction is encoded in the index so the lookup is a single
--     ordered scan without a separate sort step.

CREATE TABLE IF NOT EXISTS coupon_stacking_policies (
  slug                     TEXT NOT NULL PRIMARY KEY,
  title                    TEXT NOT NULL,
  allow_combine_json       TEXT NOT NULL DEFAULT '{}',
  max_codes_per_order      INTEGER NOT NULL CHECK (max_codes_per_order >= 1),
  exclusive_codes_json     TEXT NOT NULL DEFAULT '[]',
  order_min_minor          INTEGER NOT NULL DEFAULT 0 CHECK (order_min_minor >= 0),
  customer_segment_in_json TEXT NOT NULL DEFAULT '[]',
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at              INTEGER,
  priority                 INTEGER NOT NULL DEFAULT 0,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coupon_stacking_policies_active_priority
  ON coupon_stacking_policies(active, priority DESC);
