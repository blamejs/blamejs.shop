-- Site-redirects tables — operator-defined 301/302/307/308 URL
-- redirects with optional expiry + hit counter.
--
--   site_redirects        — one row per redirect slug. `source_path`
--                            is the inbound URL the storefront sees
--                            and `target_url` is where it forwards;
--                            `match_kind` (exact / prefix / regex)
--                            selects the resolution discipline. The
--                            primitive refuses regex patterns with
--                            backreferences or lookahead at write time
--                            so a hostile or careless author can't
--                            land a catastrophic-backtracking pattern
--                            in the live redirect table.
--
--                            `code` is constrained to the four HTTP
--                            redirect verbs the spec permits — 301
--                            (permanent), 302 (found / temporary),
--                            307 (temporary, preserves method + body)
--                            and 308 (permanent, preserves method +
--                            body). Anything else is a smell at the
--                            shape of the redirect table, not a
--                            configuration knob.
--
--                            `expires_at` is a nullable epoch-ms
--                            cutoff; rows whose expiry has elapsed
--                            stop resolving (treated like archived
--                            rows) and are eligible for the
--                            cleanupExpired sweep. `archived_at` is
--                            the soft-delete stamp — archived rows
--                            drop out of resolveForPath but persist
--                            for the audit trail.
--
--                            `hit_count` is the lifetime running
--                            total of recordHit calls — the per-event
--                            log lives in site_redirect_hits below
--                            so a busy redirect doesn't grow the
--                            site_redirects row unboundedly while
--                            the storefront still has a counter to
--                            render.
--
--   site_redirect_hits     — append-only per-hit log keyed on
--                            redirect slug. Operators inspecting
--                            "which redirects were busiest last
--                            week" walk this table within the
--                            occurred_at window via topHits;
--                            cleanupExpired does NOT prune hit rows
--                            because operators want the historical
--                            record even after a redirect itself
--                            ages out.

CREATE TABLE IF NOT EXISTS site_redirects (
  slug                        TEXT NOT NULL PRIMARY KEY,
  source_path                 TEXT NOT NULL,
  target_url                  TEXT NOT NULL,
  code                        INTEGER NOT NULL CHECK (code IN (301, 302, 307, 308)),
  match_kind                  TEXT NOT NULL CHECK (match_kind IN ('exact', 'prefix', 'regex')),
  active                      INTEGER NOT NULL CHECK (active IN (0, 1)),
  expires_at                  INTEGER,
  archived_at                 INTEGER,
  hit_count                   INTEGER NOT NULL DEFAULT 0,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_redirects_match
  ON site_redirects(match_kind, archived_at, active);
CREATE INDEX IF NOT EXISTS idx_site_redirects_source
  ON site_redirects(source_path);
CREATE INDEX IF NOT EXISTS idx_site_redirects_expires
  ON site_redirects(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS site_redirect_hits (
  id                          TEXT NOT NULL PRIMARY KEY,
  slug                        TEXT NOT NULL,
  occurred_at                 INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_site_redirect_hits_slug
  ON site_redirect_hits(slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_site_redirect_hits_window
  ON site_redirect_hits(occurred_at);
