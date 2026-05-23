-- Customer roles: B2B-style company customers with multiple
-- employee logins.
--
-- Distinct from `customers` (migration 0006) — which models a single
-- account-per-row passkey-enrolled buyer. This layer sits on top:
-- a "company customer" row in `customers` represents the buying
-- organization, and individual "employee customer" rows in
-- `customers` are the people who log in on behalf of the company.
-- The mapping is held in `customer_role_assignments`, keyed on the
-- (company, employee) pair so the same human can hold a role at two
-- different companies (e.g. an accountant who buys for two clients).
--
-- A role is an operator-authored bag of capabilities. The capability
-- enum is closed at the primitive layer (`can_view_orders`,
-- `can_place_order`, `can_approve_order`, `can_manage_users`,
-- `can_view_pricing`, `can_apply_payment_terms`,
-- `can_request_quote`, `can_view_invoices`) — the JSON column stores
-- the subset that this role grants. Adding a new capability slot is
-- a code-side change (the primitive's allow-list grows) plus the
-- operator re-defining the affected roles; the schema doesn't need
-- to move.
--
-- `customer_order_approvals` audits the role-gated approval action
-- — every time an employee with `can_approve_order` actually
-- approves an order, a row lands here so an auditor can reconstruct
-- who signed off on what and against which role. Append-only by
-- convention; no UPDATE / DELETE path on the primitive.
--
-- Schema decisions:
--   * `slug` is the role's stable handle (PK). `capabilities_json` is
--     a JSON array of capability tokens; the primitive validates
--     every entry against the closed enum at write time and on read
--     re-checks shape (defensive against a hand-edited row).
--   * `archived_at` is a soft-delete tombstone. Archived roles still
--     resolve `hasCapability` for already-assigned employees (so an
--     in-flight quote doesn't lose authority mid-flow) but
--     `assignRole` refuses to attach new employees to an archived
--     role.
--   * `customer_role_assignments.UNIQUE(company_customer_id,
--     employee_customer_id)` enforces "one role per employee per
--     company" — an employee changes role via `assignRole`
--     (replace-on-conflict) not a separate update path.
--   * `customer_order_approvals` is indexed on (order_id) for the
--     "show me who approved this order" lookup and on (approved_by)
--     for the "show me everything this employee approved" audit.

CREATE TABLE IF NOT EXISTS customer_roles (
  slug              TEXT NOT NULL PRIMARY KEY,
  title             TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_roles_archived ON customer_roles(archived_at);

CREATE TABLE IF NOT EXISTS customer_role_assignments (
  id                    TEXT NOT NULL PRIMARY KEY,
  company_customer_id   TEXT NOT NULL,
  employee_customer_id  TEXT NOT NULL,
  role_slug             TEXT NOT NULL,
  assigned_at           INTEGER NOT NULL,
  UNIQUE (company_customer_id, employee_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_role_assignments_company  ON customer_role_assignments(company_customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_role_assignments_employee ON customer_role_assignments(employee_customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_role_assignments_role     ON customer_role_assignments(role_slug);

CREATE TABLE IF NOT EXISTS customer_order_approvals (
  id           TEXT NOT NULL PRIMARY KEY,
  order_id     TEXT NOT NULL,
  approved_by  TEXT NOT NULL,
  role_slug    TEXT NOT NULL,
  occurred_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_order_approvals_order    ON customer_order_approvals(order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_order_approvals_employee ON customer_order_approvals(approved_by, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_order_approvals_role     ON customer_order_approvals(role_slug);
