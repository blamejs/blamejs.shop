-- Customer segments: RFM-style operator-defined groupings.
--
-- Operators define named segments — "VIPs", "lapsed-90d",
-- "high-value-new", "high-refund-rate" — as a bag of rule predicates
-- ANDed together. Each rule references the customer's order history:
-- last order recency, order frequency, lifetime monetary value,
-- refund rate, last order status, ship-to country, etc. Adding a new
-- predicate is a forward-compatible JSON field in `rules_json`; the
-- evaluator skips unknown keys without erroring so an older deploy
-- doesn't fail on a segment authored by a newer deploy.
--
-- Two tables:
--
--   customer_segments              — one row per defined segment.
--                                    `slug` is the operator-facing
--                                    handle (`/^[a-z0-9][a-z0-9_-]*$/`,
--                                    UNIQUE). `rules_json` carries the
--                                    AND-composed predicates. `archived_at`
--                                    non-null hides the segment from
--                                    evaluate/list by default; archived
--                                    segments are preserved (and their
--                                    membership cache cleared) for
--                                    historical audits.
--
--   customer_segment_membership    — denormalized cache populated by
--                                    `recompute()`. One row per
--                                    (segment, customer). `evaluated_at`
--                                    captures the recompute timestamp
--                                    so an operator can tell when the
--                                    last sweep ran. Indexed on
--                                    (segment_id, customer_id) for
--                                    point lookups + on
--                                    (customer_id, segment_id) for
--                                    `segmentsForCustomer`.
--
-- The membership cache is operator-refreshed (scheduler hits
-- `recompute()`); `evaluate()` reads from the cache, so segments are
-- as fresh as the last recompute. Segments newly defined or just
-- updated are not visible to `evaluate()` until the next recompute —
-- by design, since campaign sends typically run off a snapshot.

CREATE TABLE IF NOT EXISTS customer_segments (
  id                   TEXT NOT NULL PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  rules_json           TEXT NOT NULL DEFAULT '{}',
  archived_at          INTEGER,
  last_recomputed_at   INTEGER,
  last_member_count    INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_segments_archived
  ON customer_segments(archived_at);

CREATE TABLE IF NOT EXISTS customer_segment_membership (
  segment_id     TEXT NOT NULL,
  customer_id    TEXT NOT NULL,
  evaluated_at   INTEGER NOT NULL,
  PRIMARY KEY (segment_id, customer_id),
  FOREIGN KEY (segment_id) REFERENCES customer_segments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_customer_segment_membership_customer
  ON customer_segment_membership(customer_id, segment_id);
CREATE INDEX IF NOT EXISTS idx_customer_segment_membership_segment_eval
  ON customer_segment_membership(segment_id, evaluated_at);
