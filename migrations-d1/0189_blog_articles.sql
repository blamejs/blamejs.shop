-- Blog articles — operator-published storefront blog. Distinct from
-- storefrontPages (legal / about / shipping — the long-tail of fixed
-- slots every shop carries). The blog is editorial: posts shipped on
-- a cadence, attributed to an author, tagged for browsability,
-- linked back to the catalog so a "five-mistakes-buying-X" post can
-- surface the matching SKUs at the bottom of the article.
--
-- Two tables:
--
--   blog_articles       — one row per slug. `slug` is the PK
--                         (URL-stable; appears in /blog/<slug>).
--                         `title` / `body` are the operator-authored
--                         editorial content. `author_id` is a free-
--                         form string referencing the operator's
--                         authors directory (the blog primitive does
--                         NOT own the author entity — author rows
--                         live wherever the operator chose to model
--                         the editorial team). `tags_json` is a
--                         JSON string array; the primitive parses it
--                         on read and ranks `relatedArticles` by
--                         tag-overlap. `featured_product_ids_json`
--                         is a JSON string array of product ids the
--                         article links to (storefront renders these
--                         as the "products mentioned" block at the
--                         post foot). `hero_image_url` is OPTIONAL
--                         and gated through `b.safeUrl` (https-only)
--                         at the primitive surface. `meta_description`
--                         + `meta_keywords` populate the article's
--                         `<head>` SEO tags. `status` is an FSM enum
--                         (draft / published / archived); `published_at`
--                         + `archived_at` are stamped on transition.
--                         `view_count` is the slug-wide aggregate
--                         (bumped by recordView).
--
--                         Lifecycle FSM:
--                           draft     ──publish──▶ published
--                           published ──unpublish▶ draft
--                           published ──archive──▶ archived
--                           archived  ──restore──▶ draft
--                         Every other transition is refused with an
--                         error naming both states.
--
--   blog_article_views  — append-only view log. session_id is hashed
--                         via b.crypto.namespaceHash("blog-article-
--                         view-session", id) so the raw session id
--                         never lands on disk. `popularArticles`
--                         aggregates this table over a closed time
--                         window.
--
-- Indexes:
--   idx_blog_articles_published_at — drives listPublished newest-first
--   idx_blog_articles_status       — drives listDrafts / listArchived
--   idx_blog_articles_author       — drives byAuthor lookup
--   idx_blog_article_views_slug_t  — drives popularArticles window query
--   idx_blog_article_views_t       — secondary scan for the window itself

CREATE TABLE IF NOT EXISTS blog_articles (
  slug                       TEXT    NOT NULL PRIMARY KEY,
  title                      TEXT    NOT NULL,
  body                       TEXT    NOT NULL,
  author_id                  TEXT    NOT NULL,
  tags_json                  TEXT    NOT NULL DEFAULT '[]',
  featured_product_ids_json  TEXT    NOT NULL DEFAULT '[]',
  hero_image_url             TEXT,
  meta_description           TEXT,
  meta_keywords              TEXT,
  status                     TEXT    NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'published', 'archived')),
  published_at               INTEGER,
  archived_at                INTEGER,
  view_count                 INTEGER NOT NULL DEFAULT 0,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blog_articles_published_at
  ON blog_articles(status, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_blog_articles_status
  ON blog_articles(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blog_articles_author
  ON blog_articles(author_id, status, published_at DESC);

CREATE TABLE IF NOT EXISTS blog_article_views (
  id                  TEXT    NOT NULL PRIMARY KEY,
  slug                TEXT    NOT NULL,
  session_id_hash     TEXT,
  occurred_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blog_article_views_slug_occurred
  ON blog_article_views(slug, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_blog_article_views_occurred
  ON blog_article_views(occurred_at DESC);
