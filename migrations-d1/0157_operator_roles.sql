-- Operator roles: staff-side RBAC for the storefront's operator
-- console.
--
-- Distinct from `customer_roles` (migration 0101) — which models the
-- B2B buyer side: a company customer plus several employee customers
-- with capabilities scoped to that company. THIS table models the
-- STAFF side: the humans who run the storefront on the operator's
-- behalf — admins, support agents, fulfillment clerks, accounting,
-- marketing. They log in to the admin console (not the storefront)
-- and their actions are audited through `operator_audit_events`
-- (migration 0074) via the composed `operatorAuditLog` peer.
--
-- A role is an operator-authored bag of permission tokens drawn from
-- a closed allow-list. The allow-list is enforced at the primitive
-- layer; adding a new token is a code-side change here AND in
-- `lib/operator-roles.js` AND a re-define of the affected role
-- definitions. The schema doesn't move when the permission set
-- grows.
--
-- Permission tokens (the closed allow-list as of this migration):
--
--     orders.read           — view customer order rows
--     orders.refund         — issue a refund on a customer order
--     orders.cancel         — cancel an order before fulfillment
--     customers.read        — view customer rows
--     customers.export      — bulk-export customer data (PII grain)
--     catalog.read          — view product / variant / collection rows
--     catalog.write         — create / update / delete catalog rows
--     inventory.write       — adjust on-hand counts, post receipts
--     vendors.manage        — manage vendor registry + commissions
--     settings.write        — edit storefront-wide configuration
--     billing.view          — view operator-side billing & invoices
--     reports.read          — view sales / accounting / analytics
--                             reports
--     users.invite          — invite a new operator
--     users.manage          — change another operator's roles, suspend
--     support.handle        — assignee + state changes on support
--                             tickets
--
-- Schema decisions:
--
--   * `operator_roles` is keyed on `slug` (PK). `permissions_json` is
--     a JSON array; the primitive validates every entry against the
--     closed enum at write time and re-checks on read so a hand-edited
--     row carrying a stale token is silently dropped instead of
--     surfacing a granted-but-no-longer-recognized capability.
--
--   * `archived_at` is a soft-delete tombstone. Archived roles still
--     resolve `hasPermission` for already-assigned operators — an
--     in-flight workflow does not lose authority mid-step when the
--     operator rotates a role definition. `assignRoleToOperator`
--     refuses new attachments to an archived role.
--
--   * `operator_role_assignments` carries the (operator, role) edge.
--     One operator can hold several roles concurrently (an admin may
--     also be a support handler). Revocation does NOT delete the row
--     — `revoked_at` + `revoked_by` + `revoke_reason` stamp the
--     tombstone so the audit trail survives. `expires_at` is an
--     optional time-based revocation (interim coverage, temp
--     contractor); `hasPermission` honors both `revoked_at` and
--     `expires_at` at query time. UNIQUE(operator_id, role_slug)
--     prevents the same (operator, role) edge being recreated while
--     active — re-assignment after revoke goes through a NEW row to
--     preserve the audit grain.
--
--   * `operator_permission_log` is the per-use audit trail. Every
--     time a permission gate fires the operator console (or a
--     downstream caller) records a row here so an auditor can answer
--     "show me every catalog.write the marketing team did this week."
--     Append-only by convention; the primitive offers no UPDATE /
--     DELETE surface. The `(operator_id, permission, occurred_at)`
--     composite index serves the per-operator-per-permission window
--     read pattern.

CREATE TABLE IF NOT EXISTS operator_roles (
  slug              TEXT NOT NULL PRIMARY KEY,
  title             TEXT NOT NULL,
  permissions_json  TEXT NOT NULL,
  description       TEXT,
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_roles_archived
  ON operator_roles(archived_at);

CREATE TABLE IF NOT EXISTS operator_role_assignments (
  id              TEXT NOT NULL PRIMARY KEY,
  operator_id     TEXT NOT NULL,
  role_slug       TEXT NOT NULL,
  assigned_by     TEXT NOT NULL,
  assigned_at     INTEGER NOT NULL,
  expires_at      INTEGER,
  revoked_at      INTEGER,
  revoked_by      TEXT,
  revoke_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_role_assignments_operator
  ON operator_role_assignments(operator_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_operator_role_assignments_role
  ON operator_role_assignments(role_slug, revoked_at);

CREATE INDEX IF NOT EXISTS idx_operator_role_assignments_expires
  ON operator_role_assignments(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS operator_permission_log (
  id              TEXT NOT NULL PRIMARY KEY,
  operator_id     TEXT NOT NULL,
  permission      TEXT NOT NULL,
  context         TEXT,
  occurred_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_permission_log_operator
  ON operator_permission_log(operator_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_permission_log_perm
  ON operator_permission_log(permission, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_permission_log_op_perm
  ON operator_permission_log(operator_id, permission, occurred_at DESC);
