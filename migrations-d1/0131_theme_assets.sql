-- Theme assets — operator-uploaded artifacts that a theme references
-- at render time (fonts, logo variants, hero images, favicons,
-- banner / og / icon images, plus a `custom` escape hatch). Distinct
-- from `themes` (which carries the active theme slug + template
-- directory) — this is the asset catalog + content-addressed storage
-- references the storefront resolves when a theme template walks
-- `themeAssets.assetsForTheme()`.
--
-- Each asset carries:
--
--   * `slug` (PK) — stable operator-authored handle. Mirrors the
--     URL-friendly shape used by the rest of the storefront
--     primitives. Reaches operator logs + admin URLs
--     (`/admin/theme-assets/<slug>`).
--
--   * `kind` — closed CHECK enum picking the asset's role
--     (font / logo / hero_image / favicon / banner_image / og_image /
--     icon / custom). The render-time picker dispatches off this
--     column ("which logo do I show in the header?" → asset with
--     kind=`logo` assigned to the active theme).
--
--   * `content_type` — IANA media type the asset was uploaded with
--     (e.g. `image/svg+xml`, `font/woff2`, `image/avif`). NOT NULL —
--     the storefront sets the right Content-Type header when
--     serving the asset, and a missing media type would land as
--     application/octet-stream which breaks browser font / image
--     caching heuristics.
--
--   * `sha3_512` — content-addressed digest of the asset bytes. The
--     primitive validates a 128-char lowercase hex shape at the app
--     layer. The same asset uploaded under two slugs has the same
--     digest; the `idx_theme_assets_sha3` index backs the "is this
--     content already in the catalog?" lookup the upload pipeline
--     uses to de-dupe.
--
--   * `byte_size` — non-negative integer byte length of the asset.
--     Surfaces to the admin UI ("Logo: 12.3 kB") and gates upload
--     quota.
--
--   * `source_url` — where the asset is fetched from (R2 / CDN /
--     `/-rooted` internal path). The primitive routes this through
--     `b.safeUrl` (https-only) at write time. The storefront serves
--     the URL on the storefront's `<link>` / `<img>` / `<source>`
--     references.
--
--   * `alt_text` — optional accessibility caption. NULL for kinds
--     that don't render to assistive tech (`font`, `favicon`); set
--     for image kinds the operator expects to render in `<img>`.
--
--   * `theme_slug` — optional FK-shaped reference to the theme this
--     asset belongs to. NULL for assets the operator has uploaded
--     but not yet assigned to a theme (the "asset library" state).
--     `assignToTheme` is the supported transition; `assetsForTheme`
--     filters this column.
--
--   * `archived_at` — soft-delete instant. Archived assets stay in
--     the table so a render or audit can resolve the slug, but they
--     drop out of `assetsForTheme` / `assetsByKind`.
--
--   * `impression_count` — denormalized counter the hot-path
--     `recordImpression` bumps on every storefront render that
--     resolves the asset. Companion `metricsForAsset` reads this
--     column in addition to scanning the impression-event log so
--     the admin summary read is a single row lookup.
--
--   * `created_at` / `updated_at` — provenance.
--
-- Indexes:
--
--   * (theme_slug, kind) — the hot read path is "give me every
--     logo / favicon / font assigned to theme=<slug>" for the
--     storefront's theme render. The compound covers both legs of
--     the filter without a scan.
--
--   * (kind, archived_at) — the asset-library read path
--     (`assetsByKind` with no theme filter) walks active assets by
--     kind. Putting `archived_at` second lets the planner drop the
--     archived tail of each kind bucket without scanning it.
--
--   * (sha3_512) — content-addressed lookup. Backs the de-dupe path
--     ("did the operator already upload this exact byte sequence
--     under a different slug?").
--
--   * theme_asset_impressions (asset_slug, occurred_at) — backs the
--     per-asset windowed metrics scan (`metricsForAsset` over a
--     `{ from, to }` window).

CREATE TABLE IF NOT EXISTS theme_assets (
  slug                TEXT NOT NULL PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'font',
                        'logo',
                        'hero_image',
                        'favicon',
                        'banner_image',
                        'og_image',
                        'icon',
                        'custom'
                      )),
  content_type        TEXT NOT NULL,
  sha3_512            TEXT NOT NULL,
  byte_size           INTEGER NOT NULL CHECK (byte_size >= 0),
  source_url          TEXT NOT NULL,
  alt_text            TEXT,
  theme_slug          TEXT,
  archived_at         INTEGER,
  impression_count    INTEGER NOT NULL DEFAULT 0 CHECK (impression_count >= 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_theme_assets_theme_kind
  ON theme_assets(theme_slug, kind);

CREATE INDEX IF NOT EXISTS idx_theme_assets_kind_archive
  ON theme_assets(kind, archived_at);

CREATE INDEX IF NOT EXISTS idx_theme_assets_sha3
  ON theme_assets(sha3_512);

CREATE TABLE IF NOT EXISTS theme_asset_impressions (
  id                  TEXT NOT NULL PRIMARY KEY,
  asset_slug          TEXT NOT NULL REFERENCES theme_assets(slug) ON DELETE CASCADE,
  occurred_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_theme_asset_impressions_slug_time
  ON theme_asset_impressions(asset_slug, occurred_at);
