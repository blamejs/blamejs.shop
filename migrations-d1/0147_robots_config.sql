-- Robots config — operator-editable robots.txt rules, sitemap
-- declarations, and the optional `Host:` directive that the worker
-- composes into the bytes served at /robots.txt.
--
-- Distinct from the worker's static fallback. The fallback is the
-- defensive default ("everyone is allowed everywhere; here is the
-- sitemap") that ships when an operator has not configured anything
-- yet. This primitive is the operator's editable surface: per-bot
-- Allow / Disallow lines, per-bot crawl-delay, AI-crawler opt-outs
-- (GPTBot, ClaudeBot, CCBot, anthropic-ai, Google-Extended, etc.),
-- and one or more <Sitemap:> declarations pointing at the canonical
-- sitemap index URL.
--
-- One row per rule. A rule is the (user_agent, allow[], disallow[],
-- crawl_delay?) tuple a single robots.txt stanza encodes; the
-- `render()` step joins every active rule into the final bytes. The
-- `priority` column is the stable sort key — lower priority renders
-- first so an operator can pin a wildcard "*" stanza below a
-- specific-bot stanza without relying on insertion order.
--
-- Archive, don't delete. `archived_at` is the soft-delete cursor;
-- archived rules drop out of render() but stay in the table so an
-- operator can audit "what we used to disallow against ClaudeBot."
-- A re-add of an archived rule's user_agent is a fresh row, not an
-- in-place revive — the audit trail must show the gap.
--
-- `allow_json` + `disallow_json` are JSON arrays of path strings.
-- Path strings are operator-authored — they sit downstream of the
-- application-tier validator (no control bytes, length-capped). The
-- render step writes each entry on its own `Allow: <path>` /
-- `Disallow: <path>` line. An empty array means "no Allow / no
-- Disallow lines emitted for this rule" — an operator who wants the
-- "block everything for this bot" shape sets disallow=["/"].

CREATE TABLE IF NOT EXISTS robots_rules (
  id            TEXT    NOT NULL PRIMARY KEY,
  user_agent    TEXT    NOT NULL,
  allow_json    TEXT    NOT NULL DEFAULT '[]',
  disallow_json TEXT    NOT NULL DEFAULT '[]',
  crawl_delay   INTEGER,
  priority      INTEGER NOT NULL DEFAULT 100,
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_robots_rules_active
  ON robots_rules(archived_at, priority ASC, user_agent ASC);

CREATE INDEX IF NOT EXISTS idx_robots_rules_user_agent
  ON robots_rules(user_agent);

-- Sitemap declarations. One row per absolute sitemap URL the
-- operator wants surfaced in robots.txt. The URL is the primary key
-- so the same URL declared twice is a single row (the second
-- addSitemap call is a no-op). Operators typically register one
-- entry pointing at the sitemap index (/sitemap.xml) — the
-- sitemapGenerator primitive owns the chunking.

CREATE TABLE IF NOT EXISTS robots_sitemaps (
  url        TEXT    NOT NULL PRIMARY KEY,
  added_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_robots_sitemaps_added
  ON robots_sitemaps(added_at ASC);

-- Host directive — robots.txt non-standard but widely-honored
-- canonical-host hint (Yandex documented it; Google ignores; Bing
-- treats it as a soft canonical signal). The id column is locked to
-- 1 so the table holds at most a single host string; setHostDirective
-- is upsert-shaped. Unset state is "row absent" — render() then
-- omits the Host: line entirely.

CREATE TABLE IF NOT EXISTS robots_host_directive (
  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  host        TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
