-- Per-line allocation of order-level discounts.
--
-- An order carries one or more order-level discounts: "$20 off the
-- whole order", "15% off everything after the threshold",
-- "free-shipping credit applied as a $9.95 line credit". The line
-- items underneath the order each carry their own subtotal and
-- quantity. For accounting + refund precision the operator needs to
-- know, for any one line, what slice of the order-level discount
-- belongs to it: a partial refund of one line must remove that line's
-- share of the discount, not the whole-order amount.
--
-- This primitive is the per-allocation audit row + the reversal log.
-- Allocation arithmetic itself is pure (no row written) — the
-- operator calls `allocate(...)` to compute the breakdown and then
-- `recordAllocation(...)` once the discount lands on the order.
-- Later, when a refund clears against one or more lines, the operator
-- calls `reverseAllocation(...)` to compute the per-line refund
-- shares against the recorded breakdown. The reversal row is the
-- audit trail proving the refund math came from the same breakdown
-- the allocation was written against — not a recomputation that could
-- drift if the underlying subtotals were modified after the fact.
--
-- Schema decisions:
--
--   * `discount_allocations.kind` is a closed CHECK enum:
--       proportional     — distribute by line_subtotal_minor weight.
--                          Same math as `by_subtotal` but kept as a
--                          distinct slot so an operator can author a
--                          policy that explicitly says "proportional
--                          to subtotal" vs the synonymous direct
--                          axis. (The primitive treats both kinds
--                          identically internally; the audit row
--                          carries the operator-authored kind so the
--                          downstream report says what the operator
--                          intended.)
--       equal            — divide the discount evenly across line
--                          count, rounding remainder onto the
--                          highest-subtotal line.
--       by_subtotal      — proportional by subtotal weight (alias).
--       by_quantity      — distribute by quantity weight.
--
--   * `source` is operator-supplied: "coupon:WELCOME10",
--     "auto_discount:weekend-sale", "loyalty_redemption:<uuid>",
--     "manual:<operator>". Refused at the primitive layer for control
--     bytes / over-length / empty so a malformed source string can't
--     poison the audit-trail column.
--
--   * `total_minor` is the order-level discount this row distributed,
--     in integer minor units of the order currency. CHECK > 0 — a
--     zero-discount allocation is a no-op the primitive refuses to
--     persist.
--
--   * `breakdown_json` is the canonical-JSON line allocation:
--     `[{"line_id":"L1","allocated_minor":667,"remaining_minor":...}, ...]`.
--     The `allocated_minor` values sum exactly to `total_minor` by
--     construction (half-even rounding remainder lands on the
--     highest-subtotal line). `remaining_minor` is the line subtotal
--     after this discount applied — operators rendering a receipt
--     don't have to re-subtract.
--
--   * `applied_at` is operator-supplied epoch-ms (defaults to "now"
--     at the primitive layer). Index `(order_id, applied_at DESC)`
--     drives the per-order audit-feed read path.
--
-- Reversal table:
--
--   * `discount_reversals.allocation_id` is the FK back to the
--     allocation row. Each reversal walks the recorded
--     `breakdown_json` in reverse — given a refund amount in minor
--     units, the primitive computes per-line refund shares against
--     the original breakdown's proportions, stores the reverse
--     breakdown in `reverse_breakdown_json`, and writes the audit row.
--
--   * `refund_minor` is the per-reversal refund amount distributed.
--     CHECK > 0. Multiple reversals against one allocation are
--     allowed (a single allocation may be partially refunded across
--     several refund events); the sum of all reversal amounts can
--     exceed the original `total_minor` if the operator manually
--     refunds more than the discount value (e.g. a goodwill refund
--     larger than the original order subtotal), so no CHECK constraint
--     enforces the sum bound — the primitive surfaces it as a metric
--     and lets the operator decide whether to refuse.
--
-- Indexes:
--   * `(order_id, applied_at DESC)` on `discount_allocations` — the
--     hot read path is "show me every allocation against order X".
--   * `(kind, applied_at)` on `discount_allocations` — drives the
--     `metricsForKind` aggregation feed.
--   * `(allocation_id, occurred_at DESC)` on `discount_reversals` —
--     "show me every reversal against this allocation".

CREATE TABLE IF NOT EXISTS discount_allocations (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  source          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'proportional',
                    'equal',
                    'by_subtotal',
                    'by_quantity'
                  )),
  total_minor     INTEGER NOT NULL CHECK (total_minor > 0),
  breakdown_json  TEXT NOT NULL,
  applied_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discount_allocations_order
  ON discount_allocations(order_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_discount_allocations_kind_applied_at
  ON discount_allocations(kind, applied_at);

CREATE TABLE IF NOT EXISTS discount_reversals (
  id                       TEXT NOT NULL PRIMARY KEY,
  allocation_id            TEXT NOT NULL REFERENCES discount_allocations(id),
  refund_minor             INTEGER NOT NULL CHECK (refund_minor > 0),
  reverse_breakdown_json   TEXT NOT NULL,
  occurred_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discount_reversals_allocation
  ON discount_reversals(allocation_id, occurred_at DESC);
