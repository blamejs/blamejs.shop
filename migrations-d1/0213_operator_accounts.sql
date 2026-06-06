-- Operator accounts: the staff person who signs in to the admin
-- console, holding their OWN credential.
--
-- Today a single shared ADMIN_API_KEY guards the whole console. This
-- table adds per-operator identity so several humans can run the shop
-- with distinct logins, distinct roles, and an audit trail that names
-- WHO did each thing. ADMIN_API_KEY keeps working as the bootstrap /
-- break-glass credential mapped to the owner role — an upgrade never
-- locks the operator out, and with zero rows in this table the console
-- behaves exactly as it did before.
--
-- Distinct from:
--   * `customers` — the BUYER side (storefront logins).
--   * `operator_roles` (0157) — operator-authored custom RBAC roles.
--     The v1 console ships three built-in roles (owner / manager /
--     viewer) carried in the `role` column here; the 0157 assignment
--     tables remain available for operators who want finer-grained
--     custom roles on top.
--   * `operator_sessions` (0165) — the cookie-bearing browser session
--     minted AFTER a primary-credential challenge against this table.
--
-- Credential shape:
--
--   * `password_hash` is an Argon2id PHC string produced by the
--     vendored `b.password.hash` (OWASP-2026-floor params). The
--     plaintext never reaches the database. Verification is
--     `b.password.verify`, which is constant-time within the Argon2id
--     comparison.
--
--   * `api_key_hash` is the namespaceHash of an optional per-operator
--     bearer token (32-byte CSPRNG draw, base64url). The plaintext is
--     returned once at mint time and never stored. Lookup is by the
--     hash; the verify path runs a timing-safe compare so a wrong key
--     and an unknown operator are indistinguishable on the wire. NULL
--     when the operator has no API key (browser-only login).
--
--   * `email_hash` keys the account for login lookup without storing
--     the address in plaintext index form;  `email` retains the
--     display address (operators see who they are managing). The hash
--     is `namespaceHash("operator-email", canonical-email)`.
--
-- Lifecycle:
--
--   * `status` is `active` | `disabled`. A disabled operator's
--     password + API key stop authenticating immediately (the
--     resolver refuses any non-active account). Soft-state, never a
--     row delete — the audit grain (who they were, who disabled them)
--     survives.
--
--   * `role` is one of `owner` | `manager` | `viewer`. The owner role
--     grants everything including operator management; manager covers
--     catalog / orders / customers / marketing writes; viewer is
--     read-only (denied on every mutating verb, not merely hidden in
--     the nav).

CREATE TABLE IF NOT EXISTS operator_accounts (
  id             TEXT NOT NULL PRIMARY KEY,
  email          TEXT NOT NULL,
  email_hash     TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  api_key_hash   TEXT UNIQUE,
  role           TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'viewer')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  disabled_at    INTEGER,
  disabled_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_accounts_status
  ON operator_accounts(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_accounts_role
  ON operator_accounts(role);
