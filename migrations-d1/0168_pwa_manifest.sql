-- PWA manifest + service-worker config — operator-configurable
-- web app manifest (`manifest.webmanifest`) and companion service-
-- worker config (`/sw.js`) the storefront ships to make the site
-- installable as a Progressive Web App.
--
-- Two tables back the surface — manifests and SW configs are
-- versioned independently so an operator can iterate on the
-- service-worker caching policy without re-publishing the visual
-- manifest, and vice versa. Within each table exactly one row may
-- be `is_active=1` at a time; `setActive` flips the active row in
-- a single sweep.
--
--   pwa_manifests       — one row per version. `version_number` is
--                         monotonically increasing on defineManifest;
--                         `is_active` flags the version the
--                         renderManifestJson surface emits. Colors
--                         live as `#rrggbb` (lowercase 6-digit hex);
--                         orientation + display are closed enums
--                         constrained at the lib layer (the column-
--                         level CHECK below mirrors the lib's
--                         allowed sets so a hand-written INSERT can
--                         not smuggle a bogus value past the storage
--                         layer either). `icons_json` is the JSON
--                         array of `{ src, sizes, type, purpose? }`
--                         icon descriptors validated by
--                         validateIcons; `start_url` + `scope` are
--                         site-rooted (`/` … ) or absolute https://.
--                         `archived_at` soft-deletes the version row
--                         — archived rows never become active.
--
--   pwa_sw_configs      — one row per version. Mirrors the manifest
--                         shape — versioned, `is_active`, archived
--                         tombstone. `precache_urls_json` is the
--                         operator-curated list of URLs the SW
--                         precaches on `install`; `runtime_rules_json`
--                         is the URL-pattern → strategy table
--                         (network-first / cache-first / stale-while-
--                         revalidate). `cache_name` namespaces the
--                         operator's caches so two parallel SW
--                         versions don't collide during a rollout.
--
-- Indexes:
--   * (is_active) on each table — the renderer's hot read is "give
--     me the currently-active row". Single-column indexes are wide
--     enough because exactly one row is is_active=1 by construction.
--   * (version_number DESC) on each table — listVersions pages
--     descending and renderActiveBytes resolves "active row"
--     deterministically by `is_active=1 AND archived_at IS NULL`.

CREATE TABLE IF NOT EXISTS pwa_manifests (
  id                  TEXT NOT NULL PRIMARY KEY,
  version_number      INTEGER NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  short_name          TEXT NOT NULL,
  description         TEXT NOT NULL,
  start_url           TEXT NOT NULL,
  scope               TEXT NOT NULL,
  display             TEXT NOT NULL CHECK (display IN (
    'standalone', 'fullscreen', 'minimal-ui', 'browser'
  )),
  orientation         TEXT NOT NULL CHECK (orientation IN (
    'any', 'natural', 'portrait', 'landscape'
  )),
  theme_color         TEXT NOT NULL,
  background_color    TEXT NOT NULL,
  lang                TEXT NOT NULL,
  dir                 TEXT NOT NULL CHECK (dir IN ('ltr', 'rtl', 'auto')),
  icons_json          TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  archived_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pwa_manifests_active
  ON pwa_manifests(is_active, archived_at);
CREATE INDEX IF NOT EXISTS idx_pwa_manifests_version
  ON pwa_manifests(version_number DESC);

CREATE TABLE IF NOT EXISTS pwa_sw_configs (
  id                  TEXT NOT NULL PRIMARY KEY,
  version_number      INTEGER NOT NULL UNIQUE,
  cache_name          TEXT NOT NULL,
  precache_urls_json  TEXT NOT NULL,
  runtime_rules_json  TEXT NOT NULL,
  offline_fallback    TEXT,
  navigation_fallback TEXT,
  is_active           INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  archived_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pwa_sw_configs_active
  ON pwa_sw_configs(is_active, archived_at);
CREATE INDEX IF NOT EXISTS idx_pwa_sw_configs_version
  ON pwa_sw_configs(version_number DESC);
