-- Tenants — multi-store directory. One deployment hosts N branded
-- shops; each shop is a "tenant" with its own primary domain (the
-- canonical host the operator advertises), zero or more alt domains
-- (apex / www aliases, legacy hostnames during a migration window),
-- a default currency + locale, a theme slug (resolved by the theme
-- primitive at render time), and a lifecycle status.
--
-- The Worker resolves an inbound request's `Host` header against the
-- `tenant_domains` table via `resolveByHost(host)` — exact-match
-- only, lowercase, the operator owns the DNS so wildcard routing is
-- out of scope (a tenant that wants a wildcard registers each
-- subdomain explicitly so the directory stays the single source of
-- truth for what's served where).
--
-- Two tables:
--
--   tenants            — one row per shop. `slug` is the immutable
--                        operator-facing handle (used in admin URLs,
--                        log lines, audit trails). `status` is the
--                        lifecycle FSM:
--                          active   — serving traffic
--                          paused   — operator parked the shop; the
--                                     resolveByHost lookup still
--                                     returns the row so the Worker
--                                     can render a "this store is
--                                     temporarily unavailable" page,
--                                     but the storefront primitive
--                                     refuses checkout
--                          archived — soft-deleted; resolveByHost
--                                     refuses to return the row at
--                                     all (archived domains stop
--                                     resolving entirely so a
--                                     decommissioned shop's URL goes
--                                     straight to the operator's
--                                     404 / not-found path)
--                        `paused_at` + `archived_at` are stamped on
--                        transition; reversing a status (resume /
--                        re-activate) clears them.
--
--   tenant_domains     — one row per domain. `is_primary` is 0/1; the
--                        primary domain is the one the storefront
--                        canonicalises to (redirects from alt
--                        domains land here). Exactly one primary per
--                        tenant is enforced by `setPrimaryDomain` —
--                        the FK + the partial index on
--                        (tenant_id) WHERE is_primary = 1 keep the
--                        invariant at the SQL layer too.

CREATE TABLE IF NOT EXISTS tenants (
  id                          TEXT NOT NULL PRIMARY KEY,
  slug                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  default_currency            TEXT NOT NULL,
  default_locale              TEXT NOT NULL,
  theme_slug                  TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN (
    'active', 'paused', 'archived'
  )),
  paused_at                   INTEGER,
  archived_at                 INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_status
  ON tenants(status, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_domains (
  id                          TEXT NOT NULL PRIMARY KEY,
  tenant_id                   TEXT NOT NULL,
  domain                      TEXT NOT NULL UNIQUE,
  is_primary                  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  added_at                    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_domains_primary
  ON tenant_domains(is_primary, tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_domains_domain
  ON tenant_domains(domain);
