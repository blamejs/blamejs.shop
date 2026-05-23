-- Storefront dashboards — operator-curated arrangements of widgets
-- that compose at render time against the rest of the shop's data
-- primitives (sales reports, analytics, cart abandonment, inventory
-- alerts). Each dashboard carries:
--
--   * a stable URL-friendly `slug` (PK) — the dashboard's identity in
--     operator URLs + audit logs;
--   * a `title` shown in the dashboard header;
--   * a `layout` CHECK enum picking the rendered grid the storefront
--     admin UI wraps the widgets in (`grid_2col` / `grid_3col` /
--     `single_column` / `freeform`);
--   * a `widgets_json` blob — the canonical JSON-serialized array of
--     widget descriptors. Each descriptor is `{ id, kind, config }`;
--     the app-layer factory validates the array shape on every write
--     so the JSON the database holds is always renderable;
--   * `owner_type` / `owner_id` — optional ownership pair. An
--     operator-scoped dashboard has `owner_type = 'operator'` and
--     `owner_id` NULL (the operator dashboard catalog isn't keyed by
--     a row id); a tenant-scoped dashboard has `owner_type =
--     'tenant'` and `owner_id` set to the tenant's UUID. Both NULL
--     means the dashboard is global / unscoped (the storefront
--     default catalog ships in this state);
--   * `archived_at` — wall-clock instant the dashboard was archived.
--     Archived dashboards stay in the table so a clone or audit can
--     still resolve the slug, but they're filtered out of the
--     operator default catalog;
--   * `created_at` / `updated_at` — provenance.
--
-- The widgets the dashboard renders are READ-ONLY composites over
-- other shop primitives. The dashboard storage holds only the layout
-- + widget descriptors; the live data (revenue chart points, low-
-- stock SKUs, etc.) is fetched at render time from whichever
-- primitive owns the metric. That keeps the dashboard surface from
-- duplicating any business logic or cached aggregate already in
-- place.
--
-- Indexes:
--   * `(owner_type, owner_id, archived_at)` — the operator dashboard
--     catalog filters by owner first, then drops archived rows. The
--     compound index covers both legs of that filter without a scan.

CREATE TABLE IF NOT EXISTS storefront_dashboards (
  slug          TEXT NOT NULL PRIMARY KEY,
  title         TEXT NOT NULL,
  layout        TEXT NOT NULL CHECK (layout IN (
                  'grid_2col',
                  'grid_3col',
                  'single_column',
                  'freeform'
                )),
  widgets_json  TEXT NOT NULL,
  owner_type    TEXT CHECK (owner_type IS NULL OR owner_type IN (
                  'operator',
                  'tenant'
                )),
  owner_id      TEXT,
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storefront_dashboards_owner
  ON storefront_dashboards(owner_type, owner_id, archived_at);
