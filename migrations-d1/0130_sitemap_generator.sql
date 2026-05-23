-- Sitemap generator — operator-configurable sitemap.xml + sitemap-
-- index.xml emission for catalog, collections, storefront pages, and
-- custom URL streams.
--
-- The generated artifacts are the bytes a crawler reads at
-- `/sitemap.xml` (the index) and `/sitemap-<slug>-N.xml` (the chunks).
-- The bytes themselves are produced on demand by the primitive's
-- `generate()` call; the operator's worker is responsible for
-- persisting them to the storefront's static-asset surface (R2,
-- CDN, etc.) — this primitive is the byte source, not the storage.
--
-- `sitemap_sections` carries the operator's per-section config:
--
--   * `slug` is the PK. URL-shaped (alnum + hyphen / underscore /
--     dot, capped at 80 chars) — surfaces in the chunk filename
--     (`sitemap-<slug>-N.xml`) so a hostile slug would smuggle a
--     path traversal into the storefront's static surface; the
--     primitive enforces the shape at the app layer and the SQL
--     CHECK is the second line of defence.
--
--   * `source` is a CHECK enum picking the URL stream the section
--     reads from:
--       'product'           — every active catalog product, slug-rooted
--       'collection'        — every non-archived collection
--       'storefront_page'   — every published storefront page
--       'custom'            — the operator supplies the URLs via a
--                             registered callback at generate-time;
--                             the primitive does not pull from a
--                             table — the custom adapter pushes them.
--
--   * `base_path` is the URL path prefix prepended to each row's
--     slug (e.g. "/products/", "/collections/", "/pages/"). The
--     primitive joins the section base_path with the row slug and
--     URL-encodes the result; operators can change the prefix to
--     match their storefront routing without code edits.
--
--   * `priority` is a 0.0..1.0 float (the sitemap spec). A higher
--     number is a stronger hint to the crawler that the URL is
--     important relative to other URLs on the same site. The CHECK
--     constraint refuses out-of-range values at the SQL layer.
--
--   * `changefreq` is the operator-supplied refresh hint. The
--     sitemap spec restricts it to the listed enum; the CHECK
--     enforces that exact set.
--
--   * `max_urls` is the optional cap on URLs the section emits.
--     NULL means "no operator-imposed cap"; the primitive still
--     applies the per-chunk URL_HARD_CAP (50,000 URLs per file,
--     per the sitemap spec). Operators set this when a section is
--     legitimately bounded (e.g. a static "top 100 categories"
--     view) and an unbounded scan would waste bytes.
--
--   * `active` is the operator's enable/disable flag. When false,
--     the section is skipped by `generate()` even before the
--     archive tombstone; `active_only` filters fold both into
--     a single "is this section emitting" predicate.
--
--   * `archived_at` is the soft-delete tombstone. Archived sections
--     don't emit (the URLs vanish from the index); their config
--     row stays so an operator can audit what *used* to be emitted
--     when reconciling a SEO regression.
--
-- `sitemap_generations` is the audit log. One row per
-- `recordGeneration()` call — the operator's worker calls this
-- after persisting the bytes so the dashboard can show "last
-- generated at <ts>, <N> URLs across <M> artifacts, <B> bytes
-- total". The artifact bytes themselves aren't stored here; the
-- byte size + URL count are the post-hoc summary.
--
-- Indexes:
--   * `idx_sitemap_sections_active_archived` — `sections({ active_only:
--     true })` enumerates emitting sections; the composite covers
--     the filter.
--   * `idx_sitemap_generations_generated_at` — `lastGeneration()`
--     reads newest-first; the descending index covers the order.

CREATE TABLE IF NOT EXISTS sitemap_sections (
  slug         TEXT    NOT NULL PRIMARY KEY CHECK (length(slug) >= 1 AND length(slug) <= 80),
  source       TEXT    NOT NULL CHECK (source IN (
                 'product',
                 'collection',
                 'storefront_page',
                 'custom'
               )),
  base_path    TEXT    NOT NULL CHECK (length(base_path) >= 1 AND length(base_path) <= 256),
  priority     REAL    NOT NULL CHECK (priority >= 0.0 AND priority <= 1.0),
  changefreq   TEXT    NOT NULL CHECK (changefreq IN (
                 'always',
                 'hourly',
                 'daily',
                 'weekly',
                 'monthly',
                 'yearly',
                 'never'
               )),
  max_urls     INTEGER CHECK (max_urls IS NULL OR max_urls >= 1),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sitemap_sections_active_archived
  ON sitemap_sections(active, archived_at);

CREATE TABLE IF NOT EXISTS sitemap_generations (
  id              TEXT    NOT NULL PRIMARY KEY,
  origin_url      TEXT    NOT NULL CHECK (length(origin_url) >= 1 AND length(origin_url) <= 2048),
  artifact_count  INTEGER NOT NULL CHECK (artifact_count >= 0),
  total_url_count INTEGER NOT NULL CHECK (total_url_count >= 0),
  total_byte_size INTEGER NOT NULL CHECK (total_byte_size >= 0),
  generated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sitemap_generations_generated_at
  ON sitemap_generations(generated_at DESC);
