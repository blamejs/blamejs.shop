-- Search facets — storefront search-result filter definitions +
-- analytics on which filters shoppers actually use. Two tables, both
-- owned by the `searchFacets` primitive:
--
--   * `search_facets` — operator-curated facet definitions. Each row
--     declares one filterable surface on the storefront search
--     results page. `key` is the operator-chosen identifier
--     ([a-z0-9-]+) and is the primary key so the operator's authoring
--     UI can patch / archive by a stable handle. `field` is the
--     product-row field the facet computes against (e.g. `tags`,
--     `vendor`, `category`, `price_minor`, `in_stock`). `kind`
--     enumerates the facet shape:
--       - `categorical`   — distinct values surfaced with their
--         counts (e.g. "Brand: Nike (12)"). `display_limit` caps
--         how many options surface to the shopper.
--       - `numeric_range` — counts grouped into operator-defined
--         buckets stored in `buckets_json` as
--         `[{ label, min, max }]` (min inclusive, max exclusive;
--         `null` on either side is unbounded).
--       - `boolean`       — two-option facet (true / false) keyed
--         on a truthy field value.
--     `archived_at` is the soft-delete marker so historical analytics
--     rows still resolve their facet key.
--   * `search_facet_usage` — append-only analytics log of which
--     facet+value pairs shoppers click. `session_id_hash` is
--     namespaceHashed under `"search-facet-session"` at the write
--     site; the raw session cookie never reaches the DB. Used by
--     operator dashboards to spot facets nobody touches (candidates
--     for removal) and high-traffic values (candidates for promotion
--     to the navigation chrome).
--
-- Schema decisions:
--   * `key` / `field` are TEXT with the same shape the rest of the
--     shop uses for operator-chosen identifiers (lowercase alnum +
--     hyphen / underscore). The primitive enforces shape at the
--     write site; the table column is permissive so a future
--     migration widening the identifier shape doesn't fight a
--     CHECK constraint here.
--   * `kind` carries a CHECK constraint mirroring the primitive's
--     enum so a hand-crafted INSERT can't poison the registry with
--     an unknown shape that `getFacets` would have no path to
--     compute.
--   * `buckets_json` is NULL for `categorical` / `boolean` kinds and
--     a JSON array for `numeric_range`. Stored as TEXT rather than
--     a JSON1 column type so the table loads cleanly on D1 builds
--     compiled without the JSON1 extension enabled.
--   * `display_limit` is NULL meaning "no cap"; an explicit integer
--     caps the categorical facet's surfaced options.
--   * `active` is a 0/1 flag separate from `archived_at`. Archive
--     is permanent (soft-delete); `active` lets the operator toggle
--     a facet off the results page without losing its definition.
--   * `created_at` / `updated_at` are epoch-ms (every other table
--     in the codebase agrees).
--   * Indexes — the hot path is "load all active non-archived facets
--     once per primitive instance" so the partial index on
--     `(archived_at, active)` keeps that scan tight. Usage analytics
--     are queried by `(facet_key, occurred_at)` for dashboard
--     timelines and by `occurred_at` for retention sweeps.

CREATE TABLE IF NOT EXISTS search_facets (
  key            TEXT NOT NULL PRIMARY KEY,
  field          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('categorical', 'numeric_range', 'boolean')),
  buckets_json   TEXT,
  display_limit  INTEGER,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_facets_active
  ON search_facets(archived_at, active);

CREATE TABLE IF NOT EXISTS search_facet_usage (
  id               TEXT NOT NULL PRIMARY KEY,
  facet_key        TEXT NOT NULL,
  value            TEXT NOT NULL,
  session_id_hash  TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_facet_usage_key_time
  ON search_facet_usage(facet_key, occurred_at);

CREATE INDEX IF NOT EXISTS idx_search_facet_usage_occurred
  ON search_facet_usage(occurred_at);
