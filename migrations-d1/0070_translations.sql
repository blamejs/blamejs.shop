-- Per-resource translation table for storefront localization. One row
-- per (resource_kind, resource_id, locale, field) tuple. Operators
-- author translations for product titles, descriptions, collection
-- names, page bodies, banner copy, FAQ entries — anything the
-- storefront renders as user-visible text.
--
-- The `translations` primitive (lib/translations.js) is the only
-- writer; downstream primitives (catalog, collections, storefront
-- pages, promo banners, …) read through `getTranslation` /
-- `getForResource` at render time and fall back to the resource's
-- native field when the locale lookup misses.
--
-- Schema decisions:
--
--   * `resource_kind` is operator-namespaced (e.g. "product",
--     "collection", "page", "banner") — kept as TEXT so a new
--     primitive can register a new kind without a migration. The
--     primitive validates the shape at the write site.
--   * `resource_id` is the underlying primitive's identifier (slug
--     or uuid). It's compared as opaque text; the translations
--     primitive does not foreign-key to any specific resource table
--     so the catalogue stays independent of the catalog/collections/
--     pages primitives.
--   * `locale` is a normalised BCP-47 tag (language lowercase,
--     region uppercase: `fr`, `fr-CA`, `pt-BR`). The primitive walks
--     the fallback chain (`fr-CA → fr → en`) at read time.
--   * `field` is the operator-chosen slug for the translated
--     attribute (`title`, `description`, `body`, `cta_label`, …).
--   * `value` is HTML-escaped at write time (the primitive composes
--     `b.template.escapeHtml` so the stored value lands as inert
--     text in the storefront HTML). Operator-intent newlines survive
--     the escape (only the 5 HTML metacharacters are rewritten).
--   * `updated_at` is epoch-ms (consistent with every other table).
--   * UNIQUE(resource_kind, resource_id, locale, field) backs the
--     upsert path; partial-key indexes accelerate the two read
--     shapes the primitive supports:
--       (resource_kind, resource_id, locale) — `getForResource`
--         walks every field for one resource at one locale.
--       (resource_kind, locale) — `missingTranslations` enumerates
--         resources with no rows in the target locale.

CREATE TABLE IF NOT EXISTS translations (
  id              TEXT NOT NULL PRIMARY KEY,
  resource_kind   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  locale          TEXT NOT NULL,
  field           TEXT NOT NULL,
  value           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (resource_kind, resource_id, locale, field)
);

CREATE INDEX IF NOT EXISTS idx_translations_resource_locale
  ON translations(resource_kind, resource_id, locale);

CREATE INDEX IF NOT EXISTS idx_translations_kind_locale
  ON translations(resource_kind, locale);
