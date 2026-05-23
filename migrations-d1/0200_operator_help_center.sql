-- Operator help center — in-admin operator help articles, distinct
-- from `knowledgeBase` (the customer-facing FAQ surface). Indexed by
-- admin-console section so the help drawer can surface articles
-- relevant to whatever screen the operator currently has open.
--
-- Three tables:
--
--   operator_help_articles  — one row per slug. `section` is the
--                             admin-console section the article
--                             belongs to ("orders", "catalog",
--                             "settings", etc.); `audience_roles_json`
--                             is a JSON array of operatorRoles
--                             permission tokens — the article is
--                             visible to any operator whose roles
--                             grant at least one listed permission
--                             (empty array = visible to every
--                             operator). `related_actions_json` is a
--                             free-form JSON array of admin-console
--                             routes the operator can jump to from
--                             the article. Body is rendered through
--                             the in-process Markdown subset at read
--                             time (escapeHtml + safeUrl). Counters:
--                               view_count          — bumped by recordView
--                               helpful_count       — bumped by recordHelpfulVote
--                               not_helpful_count   — bumped by recordHelpfulVote
--                             Lifecycle: `archived_at` is the
--                             tombstone — archived articles are
--                             hidden from every public surface.
--
--   operator_help_views     — append-only view log. operator_id is
--                             the viewer's strict UUID. Drives the
--                             popularArticles aggregation window.
--
--   operator_help_votes     — one vote per (slug, operator_id). The
--                             UNIQUE constraint enforces dedup at the
--                             storage layer so a repeat vote from the
--                             same operator collapses to a no-op
--                             (INSERT OR IGNORE in the primitive).

CREATE TABLE IF NOT EXISTS operator_help_articles (
  slug                   TEXT NOT NULL PRIMARY KEY,
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  section                TEXT NOT NULL,
  related_actions_json   TEXT NOT NULL DEFAULT '[]',
  audience_roles_json    TEXT NOT NULL DEFAULT '[]',
  archived_at            INTEGER,
  view_count             INTEGER NOT NULL DEFAULT 0,
  helpful_count          INTEGER NOT NULL DEFAULT 0,
  not_helpful_count      INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_help_articles_section
  ON operator_help_articles(section, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_help_articles_updated
  ON operator_help_articles(archived_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS operator_help_views (
  id           TEXT NOT NULL PRIMARY KEY,
  slug         TEXT NOT NULL,
  operator_id  TEXT NOT NULL,
  occurred_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_help_views_slug_occurred
  ON operator_help_views(slug, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_help_views_occurred
  ON operator_help_views(occurred_at DESC);

CREATE TABLE IF NOT EXISTS operator_help_votes (
  id           TEXT NOT NULL PRIMARY KEY,
  slug         TEXT NOT NULL,
  operator_id  TEXT NOT NULL,
  vote         TEXT NOT NULL CHECK (vote IN ('helpful', 'not_helpful')),
  occurred_at  INTEGER NOT NULL,
  UNIQUE (slug, operator_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_help_votes_slug
  ON operator_help_votes(slug, occurred_at DESC);
