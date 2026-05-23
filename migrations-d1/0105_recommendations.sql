-- Recommendations — storefront product recommendation engine. Carries
-- the operator-curated override layer ("when viewing product A, always
-- show product B") plus the impression / click / conversion ledger
-- that drives the operator dashboard's CTR + conversion-rate report.
--
-- Two tables, one primitive:
--
--   * `recommendation_overrides` — the operator-curated override layer.
--     Every row carries a `kind` (which surface the override applies
--     to — product PDP rail, cart "frequently bought together",
--     customer-personalized homepage, category-page fallback), a
--     `source_id` (the entity the override is anchored to — product
--     id for `product` / `cart`, customer id for `customer`,
--     collection slug for `category`), a `recommended_product_id` (the
--     product the operator wants to surface), and a `weight` +
--     `position` pair the surface picks read in descending order so a
--     hand-curated rail renders in operator-controlled order. The
--     primitive's pick algorithm reads the overrides FIRST and falls
--     through to algorithmic signals only when the override layer
--     hasn't filled the requested count.
--
--   * `recommendation_events` — the impression / click / conversion
--     ledger. Every row carries the surface `kind`, the `source_id`
--     the surface was rendered for, the `recommended_id` the rail
--     surfaced, a `session_id_hash` (namespace-hashed
--     `recommendations-session` via `b.crypto.namespaceHash` so the raw
--     cookie never lands in the table — same discipline as the
--     analytics + recently-viewed event streams), an `event_type`
--     enum (impression / click / conversion), and an optional
--     `order_id` populated on conversion rows so the
--     `metricsForKind` report can attribute revenue back to the
--     surfacing rail. `occurred_at` is epoch milliseconds matching
--     every other table.
--
-- Schema decisions:
--   * `kind` is a CHECK-constrained enum on BOTH tables; the
--     application layer mirrors the gate so an unknown kind never
--     reaches the row. Same for `event_type` on the ledger.
--   * `source_id` / `recommended_product_id` / `recommended_id` are
--     SOFT foreign keys — the primitive validates UUID shape via
--     `b.guardUuid`, but the D1 layer doesn't enforce referential
--     integrity. An override that points at an archived product is
--     operator-orphan-tolerant; the storefront filters out archived
--     / out-of-stock candidates at render time. `category` overrides
--     anchor on a collection slug (not a UUID) so the source_id
--     column accepts both shapes — the primitive picks the validator
--     at write time based on `kind`.
--   * `weight` is a non-negative integer (default 100). Operators
--     bump it on a per-row basis to override the default ordering;
--     ties break on `position` ASC.
--   * `position` is the secondary ordering key, defaulting to 0 so
--     overrides with the same weight render in insertion order until
--     the operator rewrites positions densely.
--   * `archived_at` is a soft-delete timestamp. The active-override
--     scan filters `archived_at IS NULL`; `removeOverride` flips this
--     column rather than dropping the row so an operator who reverts
--     a curation decision keeps the audit trail.
--   * `order_id` is nullable — only populated on `conversion` rows so
--     the metrics report can resolve the order back to the
--     `orders.grand_total_minor` for revenue attribution.
--
-- Indexes:
--   * `recommendation_overrides(kind, source_id, archived_at)` — the
--     hot-path lookup for `recommendForX` reads all non-archived
--     overrides for a (kind, source_id) tuple; the composite covers
--     the filter AND the archived-state predicate.
--   * UNIQUE `(kind, source_id, recommended_product_id)` filtered to
--     non-archived rows — refuses a double-add of the same override
--     while leaving archived history in place.
--   * `recommendation_events(kind, source_id, occurred_at)` — surface-
--     attributed metrics queries (CTR / CR by source_id).
--   * `recommendation_events(event_type, occurred_at)` — funnel
--     queries (impressions vs clicks vs conversions across all kinds).
--   * `recommendation_events(recommended_id, occurred_at)` — per-
--     recommended-product audits ("which surfaces are pushing this
--     SKU and how is it converting").

CREATE TABLE IF NOT EXISTS recommendation_overrides (
  id                      TEXT    NOT NULL PRIMARY KEY,
  kind                    TEXT    NOT NULL CHECK (kind IN ('product', 'cart', 'customer', 'category')),
  source_id               TEXT    NOT NULL,
  recommended_product_id  TEXT    NOT NULL,
  weight                  INTEGER NOT NULL DEFAULT 100 CHECK (weight >= 0),
  position                INTEGER NOT NULL DEFAULT 0,
  archived_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rec_overrides_lookup
  ON recommendation_overrides(kind, source_id, archived_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_overrides_unique_active
  ON recommendation_overrides(kind, source_id, recommended_product_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rec_overrides_recommended
  ON recommendation_overrides(recommended_product_id);

CREATE TABLE IF NOT EXISTS recommendation_events (
  id                TEXT    NOT NULL PRIMARY KEY,
  kind              TEXT    NOT NULL CHECK (kind IN ('product', 'cart', 'customer', 'category')),
  source_id         TEXT    NOT NULL,
  recommended_id    TEXT    NOT NULL,
  session_id_hash   TEXT,
  event_type        TEXT    NOT NULL CHECK (event_type IN ('impression', 'click', 'conversion')),
  order_id          TEXT,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rec_events_surface
  ON recommendation_events(kind, source_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_rec_events_type_time
  ON recommendation_events(event_type, occurred_at);

CREATE INDEX IF NOT EXISTS idx_rec_events_recommended
  ON recommendation_events(recommended_id, occurred_at);
