"use strict";
/**
 * customerRoles — B2B company-customer + employee logins layered on
 * top of the `customers` primitive. Operator authors roles; each role
 * is a bag of capability tokens drawn from a closed allow-list.
 * Assignments link an employee customer to a company customer at one
 * role; `hasCapability` is the fast-path gate; `recordOrderApproval`
 * is the append-only audit hook.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0101.
 *
 * Coverage:
 *   - defineRole + closed-capability-enum whitelist validation
 *   - assignRole UNIQUE(company, employee) — re-assign rotates rather
 *     than duplicating; the row id stays single per pair
 *   - rolesForEmployee + employeesForCompany enumeration
 *   - hasCapability happy + missing-role denial (and archived-role
 *     in-flight authority preserved)
 *   - recordOrderApproval audit row append + listOrderApprovals read
 *   - archiveRole denies new assignments + preserves existing
 *   - factory + input validation refusal classes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var customerRoles = require("../../lib/customer-roles");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0101_customer_roles.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Customers stub — satisfies the `.get(id)` contract the primitive
// uses for the optional referential-integrity check. The stub records
// the membership operators have "enrolled" so refusal classes around
// unknown customer ids can be exercised. Production wires the live
// `bShop.customers.create(...)` instance instead.
function _customersStub() {
  var known = Object.create(null);
  return {
    enroll: function (id) { known[id] = true; },
    get: async function (id) { return known[id] ? { id: id } : null; },
  };
}

function _setup(opts) {
  opts = opts || {};
  var query = _makeQuery();
  var customers = opts.withCustomers ? _customersStub() : null;
  var roles = customerRoles.create({ query: query, customers: customers });
  return { query: query, roles: roles, customers: customers };
}

// ---- 1. defineRole + capability whitelist validation -----------------

async function _defineRoleAndWhitelist() {
  var ctx = _setup();

  var buyer = await ctx.roles.defineRole({
    slug:         "buyer",
    title:        "Junior Buyer",
    capabilities: ["can_view_orders", "can_place_order"],
  });
  check("defineRole returns slug",                buyer.slug === "buyer");
  check("defineRole returns title",               buyer.title === "Junior Buyer");
  check("defineRole returns capabilities",        buyer.capabilities.length === 2);
  check("defineRole capability order preserved",
    buyer.capabilities[0] === "can_view_orders" && buyer.capabilities[1] === "can_place_order");
  check("defineRole opens unarchived",            buyer.archived_at === null);
  check("defineRole stamps created_at",           typeof buyer.created_at === "number");
  check("defineRole stamps updated_at",           typeof buyer.updated_at === "number");

  // getRole resolves identically.
  var fetched = await ctx.roles.getRole("buyer");
  check("getRole resolves by slug",               fetched && fetched.slug === "buyer");

  // CAPABILITIES is exported on the surface for UI rendering.
  check("CAPABILITIES exported as frozen array",
    Array.isArray(ctx.roles.CAPABILITIES) && Object.isFrozen(ctx.roles.CAPABILITIES));
  check("CAPABILITIES module-level export matches",
    customerRoles.CAPABILITIES.indexOf("can_approve_order") !== -1);

  // listRoles enumerates.
  await ctx.roles.defineRole({
    slug: "approver", title: "Order Approver",
    capabilities: ["can_view_orders", "can_approve_order"],
  });
  var listed = await ctx.roles.listRoles();
  check("listRoles returns both",                 listed.length === 2);

  // ---- whitelist refusals ----
  await assert.rejects(ctx.roles.defineRole({
    slug: "ghost", title: "Ghost", capabilities: ["can_haunt_warehouse"],
  }), /allow-list/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "empty-caps", title: "Empty", capabilities: [],
  }), /capabilities/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "no-caps", title: "NoCaps", capabilities: null,
  }), /capabilities/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "dup-caps", title: "Dup",
    capabilities: ["can_view_orders", "can_view_orders"],
  }), /duplicate/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "bad-cap-type", title: "BadType",
    capabilities: ["can_view_orders", 7],
  }), /allow-list/);

  // Re-defining the same slug refuses (operator mutates via updateRole).
  await assert.rejects(ctx.roles.defineRole({
    slug: "buyer", title: "Buyer Again", capabilities: ["can_view_orders"],
  }), /already exists/);

  // updateRole patches title + capabilities; slug stays immutable.
  var patched = await ctx.roles.updateRole("buyer", {
    title:        "Senior Buyer",
    capabilities: ["can_view_orders", "can_place_order", "can_request_quote"],
  });
  check("updateRole patches title",               patched.title === "Senior Buyer");
  check("updateRole patches capabilities",        patched.capabilities.length === 3);
  check("updateRole bumps updated_at",            patched.updated_at >= buyer.updated_at);
  await assert.rejects(ctx.roles.updateRole("buyer", { slug: "newslug" }),                  /unsupported column/);
  await assert.rejects(ctx.roles.updateRole("buyer", {}),                                   /at least one column/);
  await assert.rejects(ctx.roles.updateRole("never-existed", { title: "x" }),               /not found/);
}

// ---- 2. assignRole UNIQUE(company, employee) -------------------------

async function _assignRoleUniqueOnCompanyEmployeePair() {
  var ctx = _setup({ withCustomers: true });
  ctx.customers.enroll("company-acme");
  ctx.customers.enroll("employee-alice");
  ctx.customers.enroll("employee-bob");
  ctx.customers.enroll("company-globex");

  await ctx.roles.defineRole({
    slug: "buyer", title: "Buyer",
    capabilities: ["can_view_orders", "can_place_order"],
  });
  await ctx.roles.defineRole({
    slug: "approver", title: "Approver",
    capabilities: ["can_view_orders", "can_approve_order"],
  });

  var first = await ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    role_slug:            "buyer",
  });
  check("assignRole returns assignment id",       typeof first.id === "string" && first.id.length > 0);
  check("assignRole returns company id",          first.company_customer_id === "company-acme");
  check("assignRole returns employee id",         first.employee_customer_id === "employee-alice");
  check("assignRole returns role slug",           first.role_slug === "buyer");
  check("assignRole stamps assigned_at",          typeof first.assigned_at === "number");

  // Re-assign the same (company, employee) pair with a different role
  // — the primitive replaces in place. UNIQUE(company, employee) is
  // upheld by the lib's existence check, not by the SQL constraint
  // raising (the lib short-circuits and UPDATEs the existing row).
  var rotated = await ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    role_slug:            "approver",
  });
  check("re-assign same pair updates in place",   rotated.id === first.id);
  check("re-assign rotates role_slug",            rotated.role_slug === "approver");
  check("re-assign refreshes assigned_at",        rotated.assigned_at >= first.assigned_at);

  // Database-level row count for the pair is exactly 1.
  var dbRows = (await ctx.query(
    "SELECT id FROM customer_role_assignments " +
    "WHERE company_customer_id = ?1 AND employee_customer_id = ?2",
    ["company-acme", "employee-alice"],
  )).rows;
  check("UNIQUE(company, employee) holds one row per pair", dbRows.length === 1);

  // Same employee at a DIFFERENT company is a separate assignment.
  var crossCo = await ctx.roles.assignRole({
    company_customer_id:  "company-globex",
    employee_customer_id: "employee-alice",
    role_slug:            "buyer",
  });
  check("same employee at different company -> separate row",
    crossCo.id !== rotated.id);

  // company_customer_id === employee_customer_id refused (self-employ).
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "company-acme",
    role_slug:            "buyer",
  }), /must differ/);

  // Unknown role refused.
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-bob",
    role_slug:            "ghost-role",
  }), /not found/);

  // Unknown customer (when customers integration wired) refused.
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id:  "company-never-enrolled",
    employee_customer_id: "employee-alice",
    role_slug:            "buyer",
  }), /not found in customers/);
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-never-enrolled",
    role_slug:            "buyer",
  }), /not found in customers/);

  // unassignRole removes; re-removal is idempotent (false).
  var removed = await ctx.roles.unassignRole({
    company_customer_id:  "company-globex",
    employee_customer_id: "employee-alice",
  });
  check("unassignRole returns true on hit",       removed === true);
  var againNoop = await ctx.roles.unassignRole({
    company_customer_id:  "company-globex",
    employee_customer_id: "employee-alice",
  });
  check("unassignRole second call -> false",      againNoop === false);
}

// ---- 3. rolesForEmployee + employeesForCompany -----------------------

async function _enumerationLookups() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "buyer", title: "Buyer", capabilities: ["can_view_orders", "can_place_order"],
  });
  await ctx.roles.defineRole({
    slug: "approver", title: "Approver",
    capabilities: ["can_view_orders", "can_approve_order"],
  });

  // Alice: buyer at acme + approver at globex.
  await ctx.roles.assignRole({
    company_customer_id: "company-acme", employee_customer_id: "employee-alice",
    role_slug: "buyer",
  });
  await ctx.roles.assignRole({
    company_customer_id: "company-globex", employee_customer_id: "employee-alice",
    role_slug: "approver",
  });
  // Bob: buyer at acme.
  await ctx.roles.assignRole({
    company_customer_id: "company-acme", employee_customer_id: "employee-bob",
    role_slug: "buyer",
  });

  // rolesForEmployee — unscoped returns both alice memberships.
  var aliceAll = await ctx.roles.rolesForEmployee({
    employee_customer_id: "employee-alice",
  });
  check("rolesForEmployee returns 2 memberships",   aliceAll.length === 2);
  var aliceCompanies = aliceAll.map(function (r) { return r.company_customer_id; }).sort();
  check("rolesForEmployee enumerates both companies",
    aliceCompanies[0] === "company-acme" && aliceCompanies[1] === "company-globex");

  // rolesForEmployee scoped to one company returns just that pair.
  var aliceAcme = await ctx.roles.rolesForEmployee({
    employee_customer_id: "employee-alice",
    company_customer_id:  "company-acme",
  });
  check("rolesForEmployee scoped returns 1 row",    aliceAcme.length === 1);
  check("rolesForEmployee scoped picks correct role", aliceAcme[0].role_slug === "buyer");

  // employeesForCompany — acme has alice + bob.
  var acme = await ctx.roles.employeesForCompany("company-acme");
  check("employeesForCompany returns 2 rows",       acme.length === 2);
  var acmeEmployees = acme.map(function (r) { return r.employee_customer_id; }).sort();
  check("employeesForCompany enumerates correctly",
    acmeEmployees[0] === "employee-alice" && acmeEmployees[1] === "employee-bob");

  // Empty company -> [].
  var ghost = await ctx.roles.employeesForCompany("company-no-employees");
  check("employeesForCompany no-rows -> empty",     ghost.length === 0);

  // Unknown employee -> [].
  var noEmp = await ctx.roles.rolesForEmployee({
    employee_customer_id: "employee-never-existed",
  });
  check("rolesForEmployee unknown -> empty",        noEmp.length === 0);
}

// ---- 4. hasCapability happy + missing-role denial --------------------

async function _hasCapabilityGate() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "buyer", title: "Buyer",
    capabilities: ["can_view_orders", "can_place_order"],
  });
  await ctx.roles.defineRole({
    slug: "minimal", title: "Minimal", capabilities: ["can_view_orders"],
  });
  await ctx.roles.assignRole({
    company_customer_id: "company-acme", employee_customer_id: "employee-alice",
    role_slug: "buyer",
  });

  // Happy — granted capability returns true.
  var canView = await ctx.roles.hasCapability({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    capability:           "can_view_orders",
  });
  check("hasCapability granted -> true",            canView === true);
  var canPlace = await ctx.roles.hasCapability({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    capability:           "can_place_order",
  });
  check("hasCapability second granted -> true",     canPlace === true);

  // Denied — role doesn't grant this capability.
  var canApprove = await ctx.roles.hasCapability({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    capability:           "can_approve_order",
  });
  check("hasCapability not-in-role -> false",       canApprove === false);

  // Missing assignment — no row -> false.
  var ghost = await ctx.roles.hasCapability({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-never-assigned",
    capability:           "can_view_orders",
  });
  check("hasCapability missing assignment -> false", ghost === false);

  // Wrong company — alice has no role at globex -> false.
  var wrongCo = await ctx.roles.hasCapability({
    company_customer_id:  "company-globex",
    employee_customer_id: "employee-alice",
    capability:           "can_view_orders",
  });
  check("hasCapability wrong company -> false",     wrongCo === false);

  // Unknown capability token refused (input validation).
  await assert.rejects(ctx.roles.hasCapability({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    capability:           "can_summon_demon",
  }), /allow-list/);
}

// ---- 5. recordOrderApproval audit row --------------------------------

async function _recordOrderApprovalAudit() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "approver", title: "Approver",
    capabilities: ["can_view_orders", "can_approve_order"],
  });
  await ctx.roles.assignRole({
    company_customer_id: "company-acme", employee_customer_id: "employee-mgr",
    role_slug: "approver",
  });

  var audit = await ctx.roles.recordOrderApproval({
    order_id:    "order-XYZ-001",
    approved_by: "employee-mgr",
    role_slug:   "approver",
  });
  check("recordOrderApproval returns id",           typeof audit.id === "string" && audit.id.length > 0);
  check("recordOrderApproval stores order_id",      audit.order_id === "order-XYZ-001");
  check("recordOrderApproval stores approver",      audit.approved_by === "employee-mgr");
  check("recordOrderApproval stores role_slug",     audit.role_slug === "approver");
  check("recordOrderApproval stamps occurred_at",   typeof audit.occurred_at === "number");

  // Append-only — a second call for the same order_id lands a SECOND
  // row (the primitive doesn't double-check or merge audit rows).
  var second = await ctx.roles.recordOrderApproval({
    order_id:    "order-XYZ-001",
    approved_by: "employee-mgr",
    role_slug:   "approver",
  });
  check("recordOrderApproval second call -> distinct row", second.id !== audit.id);

  // listOrderApprovals returns both, newest first.
  var list = await ctx.roles.listOrderApprovals({ order_id: "order-XYZ-001" });
  check("listOrderApprovals returns both rows",     list.length === 2);
  check("listOrderApprovals sorted DESC",           list[0].occurred_at >= list[1].occurred_at);

  // Empty order -> [].
  var none = await ctx.roles.listOrderApprovals({ order_id: "order-never-approved" });
  check("listOrderApprovals empty -> []",           none.length === 0);

  // Unknown role refused.
  await assert.rejects(ctx.roles.recordOrderApproval({
    order_id:    "order-Z",
    approved_by: "employee-mgr",
    role_slug:   "ghost-role",
  }), /not found/);

  // Bad inputs.
  await assert.rejects(ctx.roles.recordOrderApproval(),                                       /input object required/);
  await assert.rejects(ctx.roles.recordOrderApproval({
    order_id: "", approved_by: "x", role_slug: "approver",
  }), /order_id/);
  await assert.rejects(ctx.roles.recordOrderApproval({
    order_id: "ok", approved_by: "", role_slug: "approver",
  }), /approved_by/);
  await assert.rejects(ctx.roles.listOrderApprovals({ order_id: "ok", limit: 0 }),            /limit/);
  await assert.rejects(ctx.roles.listOrderApprovals({ order_id: "ok", limit: 9999 }),         /limit/);
}

// ---- 6. archiveRole denies new + preserves existing ------------------

async function _archiveRoleSemantics() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "legacy", title: "Legacy",
    capabilities: ["can_view_orders", "can_view_pricing"],
  });
  await ctx.roles.defineRole({
    slug: "current", title: "Current",
    capabilities: ["can_view_orders", "can_place_order"],
  });

  // Alice already holds legacy at acme — this is the in-flight
  // authority the primitive preserves on archive.
  await ctx.roles.assignRole({
    company_customer_id: "company-acme", employee_customer_id: "employee-alice",
    role_slug: "legacy",
  });

  // Archive the legacy role.
  var archived = await ctx.roles.archiveRole("legacy");
  check("archiveRole stamps archived_at",           typeof archived.archived_at === "number");

  // Existing assignment STILL resolves hasCapability — in-flight
  // authority is preserved across operator role rotations.
  var stillResolves = await ctx.roles.hasCapability({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    capability:           "can_view_pricing",
  });
  check("archived role preserves in-flight authority", stillResolves === true);

  // NEW assignments to the archived role refused.
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-bob",
    role_slug:            "legacy",
  }), /archived/);

  // Non-archived role still assigns fine.
  var bobAssign = await ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-bob",
    role_slug:            "current",
  });
  check("non-archived assignment after archive still works",
    bobAssign.role_slug === "current");

  // listRoles default returns archived too; active_only narrows.
  var allRoles = await ctx.roles.listRoles();
  check("listRoles default returns archived too",   allRoles.length === 2);
  var activeOnly = await ctx.roles.listRoles({ active_only: true });
  check("listRoles active_only narrows",
    activeOnly.length === 1 && activeOnly[0].slug === "current");

  // Re-archive is idempotent.
  var rearchived = await ctx.roles.archiveRole("legacy");
  check("archiveRole idempotent",                   rearchived.archived_at === archived.archived_at);

  // Archive unknown role refused.
  await assert.rejects(ctx.roles.archiveRole("never-existed"),                                /not found/);

  // Re-assigning an EXISTING (company, employee) pair to a different
  // role works even when the old role is archived — the rotation goes
  // through the assignRole UPDATE path which only checks the NEW role.
  var rotated = await ctx.roles.assignRole({
    company_customer_id:  "company-acme",
    employee_customer_id: "employee-alice",
    role_slug:            "current",
  });
  check("rotation off archived role works",         rotated.role_slug === "current");
}

// ---- 7. factory + input validation refusals --------------------------

async function _factoryAndInputValidation() {
  // Factory accepts an explicit query handle; without one it falls back
  // to bShop.framework.externalDb.query — which throws at call time
  // because no D1 is wired in tests. The factory itself constructs
  // fine.
  var lazyRoles = customerRoles.create();
  check("factory constructs without explicit query",
    typeof lazyRoles.defineRole === "function");

  // Module-level constants.
  check("customerRoles.MAX_SLUG_LEN exported",      customerRoles.MAX_SLUG_LEN === 80);
  check("customerRoles.MAX_TITLE_LEN exported",     customerRoles.MAX_TITLE_LEN === 200);
  check("customerRoles.CAPABILITIES is array",
    Array.isArray(customerRoles.CAPABILITIES) && customerRoles.CAPABILITIES.length === 8);

  var ctx = _setup();

  // ---- defineRole refusal classes ----
  await assert.rejects(ctx.roles.defineRole(),                                                   /input object required/);
  await assert.rejects(ctx.roles.defineRole(null),                                               /input object required/);
  // bad slug shapes
  await assert.rejects(ctx.roles.defineRole({
    slug: "Bad Slug", title: "x", capabilities: ["can_view_orders"],
  }), /slug/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "-leading-dash", title: "x", capabilities: ["can_view_orders"],
  }), /slug/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "", title: "x", capabilities: ["can_view_orders"],
  }), /slug/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "x".repeat(120), title: "x", capabilities: ["can_view_orders"],
  }), /slug/);
  // bad title
  await assert.rejects(ctx.roles.defineRole({
    slug: "ok", title: "", capabilities: ["can_view_orders"],
  }), /title/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "ok", title: "x".repeat(250), capabilities: ["can_view_orders"],
  }), /title/);
  // control byte in title
  await assert.rejects(ctx.roles.defineRole({
    slug: "ok", title: "bad\x01title", capabilities: ["can_view_orders"],
  }), /control bytes/);

  // ---- assignRole refusal classes ----
  await ctx.roles.defineRole({
    slug: "buyer", title: "Buyer", capabilities: ["can_view_orders"],
  });
  await assert.rejects(ctx.roles.assignRole(),                                                   /input object required/);
  await assert.rejects(ctx.roles.assignRole(null),                                               /input object required/);
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id: "", employee_customer_id: "e", role_slug: "buyer",
  }), /company_customer_id/);
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id: "c", employee_customer_id: "", role_slug: "buyer",
  }), /employee_customer_id/);
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id: "c\x01co", employee_customer_id: "e", role_slug: "buyer",
  }), /control bytes/);
  await assert.rejects(ctx.roles.assignRole({
    company_customer_id: "c", employee_customer_id: "e", role_slug: "Bad Slug",
  }), /role_slug/);

  // ---- unassignRole / rolesForEmployee / employeesForCompany ----
  await assert.rejects(ctx.roles.unassignRole(),                                                 /input object required/);
  await assert.rejects(ctx.roles.rolesForEmployee(),                                             /input object required/);
  await assert.rejects(ctx.roles.rolesForEmployee({ employee_customer_id: "" }),                 /employee_customer_id/);
  await assert.rejects(ctx.roles.employeesForCompany(""),                                        /company_customer_id/);
  await assert.rejects(ctx.roles.employeesForCompany(null),                                      /company_customer_id/);

  // ---- hasCapability refusal classes ----
  await assert.rejects(ctx.roles.hasCapability(),                                                /input object required/);
  await assert.rejects(ctx.roles.hasCapability({
    company_customer_id: "c", employee_customer_id: "e", capability: "",
  }), /allow-list/);
  await assert.rejects(ctx.roles.hasCapability({
    company_customer_id: "c", employee_customer_id: "e", capability: 42,
  }), /allow-list/);

  // ---- listRoles refusal classes ----
  await assert.rejects(ctx.roles.listRoles({ active_only: "yes" }),                              /active_only/);
  await assert.rejects(ctx.roles.listRoles({ limit: 0 }),                                        /limit/);
  await assert.rejects(ctx.roles.listRoles({ limit: 9999 }),                                     /limit/);
  await assert.rejects(ctx.roles.listRoles({ limit: 1.5 }),                                      /limit/);

  // ---- getRole + updateRole + archiveRole bad slug ----
  await assert.rejects(ctx.roles.getRole(""),                                                    /slug/);
  await assert.rejects(ctx.roles.getRole("Bad Slug"),                                            /slug/);
  await assert.rejects(ctx.roles.updateRole(""),                                                 /slug/);
  await assert.rejects(ctx.roles.archiveRole("Bad Slug"),                                        /slug/);

  // getRole unknown -> null (not a throw).
  var miss = await ctx.roles.getRole("never-existed");
  check("getRole unknown -> null",                  miss === null);
}

// ---- 8. framework handle is wired (lazy require resolves) ------------

async function _frameworkHandleAvailable() {
  // The primitive composes against `bShop.framework.uuid.v7()` via a
  // lazy require inside `_b()`. This smoke confirms the dependency
  // resolves cleanly at test time (so an assignment id stamp doesn't
  // throw under coverage).
  check("bShop.framework exposes uuid.v7",
    typeof bShop.framework.uuid.v7 === "function");
  check("bShop.framework exposes guardUuid (unused by lib but present)",
    bShop.framework.guardUuid && typeof bShop.framework.guardUuid.sanitize === "function");
}

async function run() {
  await _defineRoleAndWhitelist();
  await _assignRoleUniqueOnCompanyEmployeePair();
  await _enumerationLookups();
  await _hasCapabilityGate();
  await _recordOrderApprovalAudit();
  await _archiveRoleSemantics();
  await _factoryAndInputValidation();
  await _frameworkHandleAvailable();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/customer-roles.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - customer-roles (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
