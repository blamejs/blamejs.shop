-- Category navigation — storefront category tree + mega-menu data.
-- Hierarchical (parent / child) categories that drive breadcrumbs on
-- product / collection pages and sub-menu rendering data for the
-- storefront header nav. One table:
--
--   categories  — one row per category. `slug` is the stable
--                 identifier; `parent_slug` is a self-referential
--                 nullable foreign key (top-level categories have
--                 NULL parent_slug). The CHECK(slug != parent_slug)
--                 guard refuses self-parent at the storage layer;
--                 deeper cycle detection (A -> B -> A) lives in the
--                 primitive's `move` verb because SQLite has no
--                 recursive-CTE-as-CHECK shape.
--
--                 `position` is the operator-assigned sibling order
--                 (0-based, ties broken by slug ASC). `hero_image_url`
--                 is the optional mega-menu hero artwork — gated by
--                 b.safeUrl at the boundary so javascript: / data:
--                 never persist. `active` is the operator-visible
--                 publish flag (mega-menu rendering filters on it);
--                 `archived_at` is the soft-delete tombstone.
--                 Archived rows are hidden from every read surface.

CREATE TABLE IF NOT EXISTS categories (
  slug             TEXT NOT NULL PRIMARY KEY,
  parent_slug      TEXT,
  title            TEXT NOT NULL,
  description      TEXT,
  hero_image_url   TEXT,
  position         INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (slug != parent_slug),
  FOREIGN KEY (parent_slug) REFERENCES categories(slug)
);

CREATE INDEX IF NOT EXISTS idx_categories_parent_position
  ON categories(parent_slug, position);
CREATE INDEX IF NOT EXISTS idx_categories_active_archived
  ON categories(active, archived_at);
