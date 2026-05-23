-- Knowledge base — self-serve customer help center. FAQ articles
-- grouped by category, with locale fallback, helpfulness voting,
-- view tracking, and a ranked search-suggest index for the
-- support-tickets compose ("operator suggests articles before
-- opening a ticket").
--
-- Three tables:
--
--   kb_articles  — one row per (slug, locale). The slug is the
--                  stable identifier; locale fallback chains right-
--                  to-left subtag strip (`fr-ca` -> `fr` -> default
--                  locale row). Body is rendered through the
--                  in-process Markdown subset at read time
--                  (escapeHtml + safeUrl) — the raw body lives in
--                  this table; the rendered HTML never lands on
--                  disk. `tags_json` is a free-form string array
--                  used by the search-suggest ranker. Counters:
--                    view_count          — bumped by recordView
--                    helpful_count       — bumped by recordVote
--                    not_helpful_count   — bumped by recordVote
--                  Lifecycle: `published` is the FSM-visible flag
--                  (operators flip via publishArticle /
--                  unpublishArticle). `archived_at` is a soft-
--                  delete tombstone — archived rows are hidden
--                  from every public surface and excluded from
--                  search-suggest.
--
--   kb_views     — append-only view log. session_id is hashed via
--                  b.crypto.namespaceHash("kb-view-session", id)
--                  so the raw session id never lands on disk;
--                  customer_id is optional and stored as-is for
--                  the popular-articles aggregation window.
--
--   kb_votes     — one vote per (slug, session_id_hash). The
--                  UNIQUE constraint enforces dedup at the storage
--                  layer so a repeat-vote from the same session
--                  collapses to a no-op (INSERT OR IGNORE in the
--                  primitive). The aggregate counters on
--                  kb_articles are the operator-facing surface;
--                  this table is the audit trail.

CREATE TABLE IF NOT EXISTS kb_articles (
  slug                TEXT NOT NULL,
  locale              TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  category            TEXT NOT NULL,
  tags_json           TEXT NOT NULL DEFAULT '[]',
  published           INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  archived_at         INTEGER,
  view_count          INTEGER NOT NULL DEFAULT 0,
  helpful_count       INTEGER NOT NULL DEFAULT 0,
  not_helpful_count   INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (slug, locale)
);

CREATE INDEX IF NOT EXISTS idx_kb_articles_category
  ON kb_articles(category, published, locale);
CREATE INDEX IF NOT EXISTS idx_kb_articles_published_updated
  ON kb_articles(published, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_articles_slug
  ON kb_articles(slug);

CREATE TABLE IF NOT EXISTS kb_views (
  id                  TEXT NOT NULL PRIMARY KEY,
  slug                TEXT NOT NULL,
  session_id_hash     TEXT,
  customer_id         TEXT,
  occurred_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_views_slug_occurred
  ON kb_views(slug, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_views_occurred
  ON kb_views(occurred_at DESC);

CREATE TABLE IF NOT EXISTS kb_votes (
  id                  TEXT NOT NULL PRIMARY KEY,
  slug                TEXT NOT NULL,
  session_id_hash     TEXT NOT NULL,
  vote                TEXT NOT NULL CHECK (vote IN ('helpful', 'not_helpful')),
  occurred_at         INTEGER NOT NULL,
  UNIQUE (slug, session_id_hash)
);

CREATE INDEX IF NOT EXISTS idx_kb_votes_slug
  ON kb_votes(slug, occurred_at DESC);
