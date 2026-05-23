-- Customer activity cache — memoization of aggregated per-customer
-- activity rollups computed by the customerActivity primitive.
--
-- customerActivity is a read-only aggregator: every event row lives
-- in the source primitive's own table (order_transitions, wishlist_
-- entries, loyalty_transactions, support_tickets / support_messages,
-- reviews). This cache table stores ONLY the rollup projection the
-- operator's customer-detail page needs to render quickly:
--
--   * `last_activity_at`     — newest source-event timestamp across
--                              every wired source for this customer.
--                              Drives the inactiveCustomers() outreach
--                              query without scanning every source.
--   * `kind_counts_30d_json` — JSON object mapping each event-kind
--                              ("order.mark_paid", "wishlist.added",
--                              "loyalty.earn", "support.opened",
--                              "review.published", ...) to its count
--                              over the trailing 30-day window. The
--                              30/90/365-day windows shipped together
--                              so summarize() returns the canonical
--                              short / mid / long retention slices
--                              the operator dashboard renders.
--   * `kind_counts_90d_json` — same shape, 90-day window.
--   * `kind_counts_365d_json` — same shape, 365-day window.
--   * `computed_at`          — freshness stamp; the primitive
--                              recomputes when the row is older than
--                              the TTL window.
--
-- Cache discipline:
--   * The cache is best-effort. A miss recomputes from the source
--     tables. An operator dropping this table degrades dashboard
--     latency but does not lose data — every event still lives in
--     its owning primitive's table.
--   * The row is rewritten in full on every recompute. PK is
--     customer_id so the steady-state row count tracks the number
--     of customers the operator has touched activity for.
--   * `(last_activity_at DESC)` indexes the inactiveCustomers()
--     outreach query: operators ask "who hasn't done anything in
--     the last N days?" and the index lets the answer come from a
--     single range scan.

CREATE TABLE IF NOT EXISTS customer_activity_cache (
  customer_id            TEXT NOT NULL PRIMARY KEY,
  last_activity_at       INTEGER NOT NULL DEFAULT 0,
  kind_counts_30d_json   TEXT NOT NULL DEFAULT '{}',
  kind_counts_90d_json   TEXT NOT NULL DEFAULT '{}',
  kind_counts_365d_json  TEXT NOT NULL DEFAULT '{}',
  computed_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_activity_cache_last
  ON customer_activity_cache(last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_activity_cache_computed
  ON customer_activity_cache(computed_at);
