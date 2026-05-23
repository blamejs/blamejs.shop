-- Collections: operator-curated and smart-rule product lists.
--
-- Two flavours, one table, distinguished by `type`:
--
--   * `manual` — operator handpicks members via add/remove/reorder
--     against `collection_members`. `rules_json` is NULL.
--   * `smart`  — operator authors a rule set; membership is computed
--     by evaluating those rules against the catalog at read time.
--     `collection_members` rows are not used for smart collections;
--     `rules_json` carries the all/any rule groups.
--
-- The split is intentional: a smart collection is a query saved
-- against the catalog, so materialising its membership would either
-- go stale or fight every catalog write. Manual collections are an
-- explicit operator decision and need a stable join table for
-- reorder + position.
--
-- Schema decisions:
--   * `slug` is the natural key. URL-shaped (lowercase alnum + dash,
--     no leading/trailing dash, <= 200 bytes). The storefront routes
--     `/collections/<slug>` directly.
--   * `type` CHECK enum guards against silently-mistyped writes; the
--     primitive's defineManual / defineSmart factories are the only
--     legitimate insertion paths.
--   * `rules_json` is a TEXT blob holding `{ all: [...], any: [...] }`.
--     The shape is validated at the application layer; the DB stores
--     whatever the primitive serialises. NULL for manual collections.
--   * `sort_strategy` CHECK enum constrains the rendering order.
--     `manual` only makes sense for manual collections; the primitive
--     refuses `manual` on smart and refuses non-`manual` on a manual
--     collection that doesn't have a deterministic sort backing it.
--   * `archived_at` is a soft-delete timestamp. Archived collections
--     drop out of `list({ active_only: true })` and out of
--     `collectionsForProduct(...)`; their members rows are left intact
--     so a future restore is a single column flip.
--   * `hero_image_url` is the optional storefront banner / category
--     hero. Capped at 2048 bytes at the app layer; the DB takes
--     whatever the primitive writes.
--
-- `collection_members` carries the manual-pick join:
--   * UNIQUE(collection_slug, product_id) refuses double-add of the
--     same product to one collection.
--   * `position` defines the operator-controlled render order. The
--     primitive's `reorderProducts` rewrites positions densely
--     (0..N-1) so cursor pagination on (position, id) is stable.
--   * `added_at` is the audit breadcrumb; the storefront doesn't
--     read it but the operator dashboard does ("added 3 days ago").
--
-- Indexes:
--   * `(collection_slug, position)` — `productsIn` walks one
--     collection by position; the index covers the filter + ORDER BY.
--   * `(product_id)` — `collectionsForProduct` reverse lookup walks
--     by product id.
--   * `(type, archived_at)` — `list({ active_only })` filters on
--     type + archived state; the composite covers both.

CREATE TABLE IF NOT EXISTS collections (
  slug            TEXT    NOT NULL PRIMARY KEY,
  type            TEXT    NOT NULL CHECK (type IN ('manual', 'smart')),
  title           TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  hero_image_url  TEXT,
  rules_json      TEXT,
  sort_strategy   TEXT    NOT NULL CHECK (sort_strategy IN ('manual', 'best_selling', 'newest', 'price_asc', 'price_desc', 'alphabetical')),
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((type = 'smart' AND rules_json IS NOT NULL) OR (type = 'manual' AND rules_json IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_collections_type_archived ON collections(type, archived_at);
CREATE INDEX IF NOT EXISTS idx_collections_updated_at    ON collections(updated_at);

CREATE TABLE IF NOT EXISTS collection_members (
  id                TEXT    NOT NULL PRIMARY KEY,
  collection_slug   TEXT    NOT NULL,
  product_id        TEXT    NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0,
  added_at          INTEGER NOT NULL,
  UNIQUE (collection_slug, product_id),
  FOREIGN KEY (collection_slug) REFERENCES collections(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collection_members_slug_pos ON collection_members(collection_slug, position);
CREATE INDEX IF NOT EXISTS idx_collection_members_product  ON collection_members(product_id);
