-- Storefront CMS pages — operator-authored Markdown documents that
-- render at fixed slugs on the storefront (About, Shipping, Returns
-- Policy, Privacy, Terms, etc.). Each page carries a publish FSM
-- (draft → published → archived ↔ unpublish → draft, restore →
-- draft) so an operator can stage edits without exposing them to
-- visitors and retire legacy copy without losing the source.
--
-- Schema decisions:
--
--   * `slug` is the PK. Operators address pages by a stable URL-
--     friendly handle (e.g. "about", "shipping", "returns-policy");
--     the primitive enforces a tight alnum + hyphen / underscore
--     shape at the app layer. The slug is also the storefront URL
--     fragment under `/pages/<slug>`.
--
--   * `version` is a monotonic counter, incremented on every update.
--     Operators can verify "the change I just made landed" by
--     comparing the version they expected to the version returned.
--     Defaults to 1 on insert so the first published copy is v1.
--
--   * `body` is raw Markdown. The primitive's `renderHtml` walks a
--     minimal in-process Markdown subset (paragraphs, headings,
--     lists, links, inline code, emphasis) and HTML-escapes every
--     text run via `b.template.escapeHtml`. Links pass through
--     `b.safeUrl.parse` (https:// or /-rooted) before they reach the
--     HTML so `javascript:` / `data:` / protocol-relative URLs are
--     refused at render time, not at storage.
--
--   * `meta_description` / `meta_keywords` are optional SEO hints
--     that surface in the rendered `<head>` of the storefront layout.
--
--   * `layout` is a CHECK enum so a typo at the SQL layer can't
--     pick a layout the storefront doesn't render. The default is
--     "default"; "wide", "landing", and "legal" tune the wrapper
--     used by the storefront page route.
--
--   * `status` is a CHECK enum holding the FSM state. The legal
--     transitions are enforced at the app layer:
--       draft     → published        (publish)
--       published → draft            (unpublish)
--       published → archived         (archive a live page)
--       archived  → draft            (restore for re-editing)
--     Anything else is refused with a clear error message.
--
--   * `published_at` is the wall-clock instant the page first entered
--     "published" status. `archived_at` is the instant the page
--     entered "archived" status. Both nullable so the FSM can express
--     "never published" / "never archived" distinctly from "the zero
--     epoch".
--
-- Indexes:
--   * `(status, published_at DESC)` — the storefront hot path lists
--     published pages newest-first; the index covers the filter +
--     order.
--   * `(layout)` — the operator dashboard groups pages by their
--     storefront layout; a scan on this column powers that view.

CREATE TABLE IF NOT EXISTS storefront_pages (
  slug              TEXT NOT NULL PRIMARY KEY,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  meta_description  TEXT,
  meta_keywords     TEXT,
  layout            TEXT NOT NULL DEFAULT 'default' CHECK (layout IN (
                      'default',
                      'wide',
                      'landing',
                      'legal'
                    )),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                      'draft',
                      'published',
                      'archived'
                    )),
  published_at      INTEGER,
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storefront_pages_status_published_at
  ON storefront_pages(status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_pages_layout
  ON storefront_pages(layout);
