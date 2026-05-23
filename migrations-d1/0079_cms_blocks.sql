-- CMS blocks — operator-editable content slots embedded in the
-- storefront templates. The framework defines a closed set of slots
-- (header announcement, hero copy, category-page hero, PDP-bottom
-- slot, footer columns, checkout-success message). Operators author
-- the body in Markdown; the storefront renders the latest published
-- localization at request time.
--
-- Two-table layout:
--
--   cms_blocks
--     A row per slot, keyed by the operator-stable `key`. The row
--     carries the default body (the baseline locale, always rendered
--     when no localization overrides for the requested locale), the
--     storefront layout token, the archive flag, and the audit
--     timestamps. Defining a block is idempotent — re-calling
--     `defineBlock` with the same key updates the default_body /
--     layout without touching the localization history.
--
--   cms_block_localizations
--     A per-locale, per-version body. Every `setLocalized` call
--     INSERTs a new row with `version = MAX(version) + 1` for the
--     (block_key, locale) pair, so the history of a slot stays
--     queryable. `versionsForBlock` returns the version list ordered
--     newest-first; the renderer reads the highest-versioned active
--     row for the requested locale.
--
-- Publish windows:
--   * `publish_at` nullable — when set, the localization is only
--     active at or after that wall-clock instant. NULL means "live
--     since the row landed."
--   * `expire_at`  nullable — when set, the localization stops being
--     active at that instant. NULL means "no expiry."
--   * The renderer walks (block_key, locale) versions newest-first
--     and picks the first row whose publish window covers `now`. If
--     no localization matches, it falls back to the default_body
--     (locale-fallback chain stripping subtags right-to-left).
--
-- Archive:
--   * `archived_at` non-null marks the block retired. The renderer
--     returns an empty string for archived blocks regardless of
--     localization. `defineBlock` on an archived key restores it
--     (clears archived_at, refreshes default_body / layout).
--
-- Schema:

CREATE TABLE IF NOT EXISTS cms_blocks (
  key            TEXT NOT NULL PRIMARY KEY,
  default_body   TEXT NOT NULL,
  layout         TEXT NOT NULL DEFAULT 'inline' CHECK (layout IN (
                   'header_announcement',
                   'hero',
                   'category_hero',
                   'pdp_bottom',
                   'footer_column',
                   'checkout_success',
                   'inline'
                 )),
  archived_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cms_block_localizations (
  id           TEXT NOT NULL PRIMARY KEY,
  block_key    TEXT NOT NULL,
  locale       TEXT NOT NULL,
  body         TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK (version >= 1),
  publish_at   INTEGER,
  expire_at    INTEGER,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (block_key) REFERENCES cms_blocks(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cms_block_localizations_key_locale_version
  ON cms_block_localizations(block_key, locale, version DESC);

CREATE INDEX IF NOT EXISTS idx_cms_block_localizations_publish_at
  ON cms_block_localizations(publish_at);

CREATE INDEX IF NOT EXISTS idx_cms_block_localizations_expire_at
  ON cms_block_localizations(expire_at);
