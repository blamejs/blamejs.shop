-- Order timeline cache — memoization of aggregated per-order event
-- feeds assembled by the orderTimeline primitive.
--
-- The orderTimeline primitive aggregates events that already live
-- in their own tables: order_transitions (the order FSM), shipment_
-- events (carrier scans), order_notes (customer-service threads),
-- return_authorizations (RMA lifecycle), fraud_screenings (pre-
-- payment risk verdicts), shipping_labels (broker mints), and
-- notifications (channel fan-outs). Each source is queried in its
-- own primitive's read path; this cache table stores ONLY the
-- summary projection (event_count, last_event_at, milestones) so
-- the customer-service dashboard can render the order list page
-- without re-aggregating every row on every render.
--
-- Cache discipline:
--   - The primary data lives in the source tables. A cache miss is
--     never fatal — the primitive recomputes from the sources on
--     read. The cache row is best-effort; an operator dropping this
--     table degrades performance but does not lose data.
--   - The row is overwritten on every recompute (PK is order_id so
--     INSERT OR REPLACE keeps the cache row count == orders count
--     in steady state).
--   - `computed_at` is the freshness stamp the primitive checks
--     against the latest source event when deciding whether to use
--     the cached row or recompute. The check is per-source: a new
--     shipment event on an order whose cache row is older than the
--     event invalidates only that order's cache, not the whole
--     table.
--
-- Schema choices:
--   - `milestones_json` carries the 5-field milestone digest
--     (paid_at / fulfilled_at / shipped_at / delivered_at /
--     refunded_at), stored as a JSON blob so future milestones can
--     be added without a schema migration.
--   - `event_count` is an INTEGER for cheap GROUP BY aggregation;
--     no CHECK because a future timeline source that surfaces zero
--     events on a never-active order is a legitimate cache row.
--   - Two indexes: (last_event_at DESC) for the recent-activity
--     feed, and (computed_at) for the freshness sweep.

CREATE TABLE IF NOT EXISTS order_timeline_cache (
  order_id        TEXT NOT NULL PRIMARY KEY,
  event_count     INTEGER NOT NULL DEFAULT 0,
  last_event_at   INTEGER NOT NULL DEFAULT 0,
  milestones_json TEXT NOT NULL DEFAULT '{}',
  computed_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_timeline_cache_last
  ON order_timeline_cache(last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_timeline_cache_computed
  ON order_timeline_cache(computed_at);
