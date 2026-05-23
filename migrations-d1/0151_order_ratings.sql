-- Order ratings: per-order customer feedback covering shipping,
-- packaging, and recommend-to-friend. Distinct from `reviews`
-- (per-product star ratings) and from `customer_surveys` (NPS / CSAT
-- / CES survey instruments). One row per order — UNIQUE(order_id)
-- enforces "one rating per order" at the schema layer so a duplicate
-- submitRating call surfaces as a constraint-error rather than a
-- silent overwrite.
--
-- Columns:
--   * `id`                   — primitive-issued UUID v7 (lex-monotonic).
--   * `order_id`             — opaque order id (UNIQUE).
--   * `customer_id`          — opaque customer id (validated by the
--                              primitive against the strict UUID
--                              shape so a typo can't slip through).
--   * `shipping_rating`      — integer in [1, 5] (the primitive
--                              refuses 0 / 6 / non-int via a typed
--                              throw before INSERT; the CHECK is a
--                              schema-layer second line of defense).
--   * `packaging_rating`     — integer in [1, 5].
--   * `recommend_rating`     — integer in [1, 5].
--   * `comment`              — optional operator-author text; HTML-
--                              escaped on render via b.template.escapeHtml.
--                              Storage carries the raw operator string
--                              (control bytes rejected at write time
--                              by the primitive). NULL when the
--                              customer left no comment.
--   * `comment_flagged`      — 0 / 1 boolean. Operator-side moderation
--                              flag; flagComment() sets to 1 with a
--                              reason + actor id. Storefront renderers
--                              suppress flagged comments.
--   * `flag_reason`          — operator-supplied moderation reason
--                              (NULL when not flagged).
--   * `flag_actor`           — operator id that placed the flag (NULL
--                              when not flagged).
--   * `response_text`        — operator's public reply (NULL until
--                              responseToCustomer() lands).
--   * `response_actor`       — operator id that authored the reply.
--   * `response_at`          — epoch-ms when the reply landed.
--   * `occurred_at`          — submission timestamp (epoch-ms; strict-
--                              monotonic across same-millisecond calls
--                              within a single process — see lib/order-
--                              ratings.js).
--
-- Indexes drive the four read paths:
--   * (customer_id, occurred_at DESC)  — ratingsForCustomer
--   * (occurred_at)                    — aggregateForPeriod window scan
--   * (comment_flagged, occurred_at)   — moderation queue
--   * UNIQUE(order_id) (PRIMARY)       — getRating + duplicate guard

CREATE TABLE IF NOT EXISTS order_ratings (
  id                TEXT    NOT NULL PRIMARY KEY,
  order_id          TEXT    NOT NULL UNIQUE,
  customer_id       TEXT    NOT NULL,
  shipping_rating   INTEGER NOT NULL CHECK (shipping_rating  BETWEEN 1 AND 5),
  packaging_rating  INTEGER NOT NULL CHECK (packaging_rating BETWEEN 1 AND 5),
  recommend_rating  INTEGER NOT NULL CHECK (recommend_rating BETWEEN 1 AND 5),
  comment           TEXT,
  comment_flagged   INTEGER NOT NULL DEFAULT 0 CHECK (comment_flagged IN (0, 1)),
  flag_reason       TEXT,
  flag_actor        TEXT,
  response_text     TEXT,
  response_actor    TEXT,
  response_at       INTEGER,
  occurred_at       INTEGER NOT NULL,
  CHECK ((comment_flagged = 0 AND flag_reason IS NULL    AND flag_actor IS NULL)
      OR (comment_flagged = 1 AND flag_reason IS NOT NULL AND flag_actor IS NOT NULL)),
  CHECK ((response_text IS NULL     AND response_actor IS NULL     AND response_at IS NULL)
      OR (response_text IS NOT NULL AND response_actor IS NOT NULL AND response_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_order_ratings_customer ON order_ratings(customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_order_ratings_occurred ON order_ratings(occurred_at);
CREATE INDEX IF NOT EXISTS idx_order_ratings_flagged  ON order_ratings(comment_flagged, occurred_at);
