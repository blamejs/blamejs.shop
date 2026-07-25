"use strict";
/**
 * operatorRoles — staff-side RBAC layered on the operator console.
 *
 * Distinct from `customerRoles`: this primitive gates ADMIN-side
 * actions (orders.refund / catalog.write / users.manage) rather than
 * B2B buyer-side capabilities. Coverage:
 *
 *   - defineRole + closed-permission allow-list validation
 *   - assignRoleToOperator + multi-role + UNIQUE while active
 *   - hasPermission happy + denial across permissions + multi-role union
 *   - expires_at honored at hasPermission / rolesForOperator query time
 *   - revokeRoleFromOperator drops permission + preserves tombstone
 *   - archiveRole denies new assignments + preserves in-flight authority
 *   - recordPermissionUse audit + permissionUsageLog window read
 *   - operatorAuditLog peer wired -> chained audit row lands
 *   - listPermissions returns the closed allow-list
 *   - factory + refusal-class input validation
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var operatorRoles = require("../../lib/operator-roles");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0157_operator_roles.sql"
);

function _splitSchema(text) {
  // Strip line comments AND remove the `WHERE expires_at IS NOT NULL`
  // partial-index predicate suffix (node:sqlite supports partial
  // indexes but the regex split handles them transparently).
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

// In-memory operatorAuditLog stub — duck-types the `.record(...)`
// surface. Captures every chained call so the test can assert the
// composed audit was actually invoked.
function _auditStub() {
  var recorded = [];
  return {
    recorded: recorded,
    record: async function (row) {
      recorded.push(row);
      return { id: "audit-" + recorded.length, row_hash: "deadbeef", occurred_at: Date.now() };
    },
  };
}

function _setup(opts) {
  opts = opts || {};
  var query = _makeQuery();
  var audit = opts.withAudit ? _auditStub() : null;
  var roles = operatorRoles.create({ query: query, operatorAuditLog: audit });
  return { query: query, roles: roles, audit: audit };
}

// ---- 1. defineRole + permission allow-list validation ----------------

async function _defineRoleAndAllowlist() {
  var ctx = _setup();

  var admin = await ctx.roles.defineRole({
    slug:        "admin",
    title:       "Administrator",
    permissions: ["orders.read", "orders.refund", "catalog.write", "users.manage"],
    description: "Full operator privileges except billing",
  });
  check("defineRole returns slug",                 admin.slug === "admin");
  check("defineRole returns title",                admin.title === "Administrator");
  check("defineRole returns permissions",          admin.permissions.length === 4);
  check("defineRole permission order preserved",
    admin.permissions[0] === "orders.read" && admin.permissions[3] === "users.manage");
  check("defineRole stores description",           admin.description === "Full operator privileges except billing");
  check("defineRole opens unarchived",             admin.archived_at === null);
  check("defineRole stamps created_at",            typeof admin.created_at === "number");
  check("defineRole stamps updated_at",            typeof admin.updated_at === "number");

  // getRole resolves identically.
  var fetched = await ctx.roles.getRole("admin");
  check("getRole resolves by slug",                fetched && fetched.slug === "admin");
  check("getRole hydrates permissions",            fetched.permissions.length === 4);

  // PERMISSIONS is exported on the surface for UI rendering.
  check("listPermissions returns frozen array",
    Array.isArray(ctx.roles.listPermissions()) && Object.isFrozen(ctx.roles.listPermissions()));
  check("listPermissions has all 16 tokens",       ctx.roles.listPermissions().length === 16);
  check("listPermissions covers orders.refund",
    ctx.roles.listPermissions().indexOf("orders.refund") !== -1);
  check("listPermissions covers users.manage",
    ctx.roles.listPermissions().indexOf("users.manage") !== -1);
  check("listPermissions covers support.handle",
    ctx.roles.listPermissions().indexOf("support.handle") !== -1);

  // Description is optional.
  var noDesc = await ctx.roles.defineRole({
    slug:        "support",
    title:       "Support",
    permissions: ["orders.read", "customers.read", "support.handle"],
  });
  check("defineRole without description -> null",  noDesc.description === null);

  // listRoles enumerates.
  var listed = await ctx.roles.listRoles();
  check("listRoles returns both",                  listed.length === 2);

  // ---- allow-list refusals ----
  await assert.rejects(ctx.roles.defineRole({
    slug: "ghost", title: "Ghost", permissions: ["warehouse.demolish"],
  }), /allow-list/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "empty", title: "Empty", permissions: [],
  }), /permissions/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "null-perms", title: "NullPerms", permissions: null,
  }), /permissions/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "dup", title: "Dup",
    permissions: ["orders.read", "orders.read"],
  }), /duplicate/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "bad-type", title: "BadType",
    permissions: ["orders.read", 42],
  }), /allow-list/);

  // Re-defining the same slug refuses.
  await assert.rejects(ctx.roles.defineRole({
    slug: "admin", title: "Admin v2", permissions: ["orders.read"],
  }), /already exists/);

  // updateRole patches title + permissions + description.
  var patched = await ctx.roles.updateRole("admin", {
    title:       "Senior Administrator",
    permissions: ["orders.read", "orders.refund", "catalog.write",
                  "users.manage", "billing.view"],
    description: "Senior staff",
  });
  check("updateRole patches title",                patched.title === "Senior Administrator");
  check("updateRole patches permissions",          patched.permissions.length === 5);
  check("updateRole patches description",          patched.description === "Senior staff");
  check("updateRole bumps updated_at",             patched.updated_at >= admin.updated_at);
  await assert.rejects(ctx.roles.updateRole("admin", { slug: "newslug" }),
    /unsupported column/);
  await assert.rejects(ctx.roles.updateRole("admin", {}),
    /at least one column/);
  await assert.rejects(ctx.roles.updateRole("never-existed", { title: "x" }),
    /not found/);
}

// ---- 2. assignRoleToOperator + multi-role + hasPermission ------------

async function _assignAndPermissionGate() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "admin", title: "Administrator",
    permissions: ["orders.read", "orders.refund", "catalog.write", "users.manage"],
  });
  await ctx.roles.defineRole({
    slug: "support", title: "Support",
    permissions: ["orders.read", "customers.read", "support.handle"],
  });
  await ctx.roles.defineRole({
    slug: "fulfillment", title: "Fulfillment",
    permissions: ["orders.read", "inventory.write"],
  });

  // Alice is both admin AND support — multi-role union resolves
  // permissions from either side.
  var first = await ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "admin", assigned_by: "op-root",
  });
  check("assignRoleToOperator returns id",            typeof first.id === "string" && first.id.length > 0);
  check("assignRoleToOperator returns operator_id",   first.operator_id === "op-alice");
  check("assignRoleToOperator returns role_slug",     first.role_slug === "admin");
  check("assignRoleToOperator stores assigned_by",    first.assigned_by === "op-root");
  check("assignRoleToOperator stamps assigned_at",    typeof first.assigned_at === "number");
  check("assignRoleToOperator no expires_at by default", first.expires_at === null);
  check("assignRoleToOperator opens unrevoked",       first.revoked_at === null);

  var second = await ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "support", assigned_by: "op-root",
  });
  check("assignRoleToOperator second role -> distinct row", second.id !== first.id);

  // hasPermission happy paths from each role.
  var canRefund = await ctx.roles.hasPermission({
    operator_id: "op-alice", permission: "orders.refund",
  });
  check("hasPermission admin permission -> true",     canRefund === true);
  var canHandle = await ctx.roles.hasPermission({
    operator_id: "op-alice", permission: "support.handle",
  });
  check("hasPermission support permission -> true",   canHandle === true);

  // Denied — neither role grants it.
  var canExport = await ctx.roles.hasPermission({
    operator_id: "op-alice", permission: "customers.export",
  });
  check("hasPermission not-in-any-role -> false",     canExport === false);

  // Unknown permission token (outside the closed allow-list) is DENIED, not
  // thrown — hasPermission is a hot-path authorization check that fails closed,
  // so a caller gating on a capability the allow-list doesn't carry gets a
  // clean deny instead of a crash.
  var unknownPerm = await ctx.roles.hasPermission({
    operator_id: "op-alice", permission: "not.a.real.permission",
  });
  check("hasPermission unknown token -> false (no throw)", unknownPerm === false);

  // The newly-added customers.impersonate token is grantable through the RBAC
  // system and resolves — this is the capability customer-impersonation
  // defaults to, so it must be assignable and checkable, not an unknown token.
  check("customers.impersonate in allow-list", ctx.roles.listPermissions().indexOf("customers.impersonate") !== -1);
  await ctx.roles.defineRole({
    slug: "cx-support", title: "CX Support", permissions: ["customers.impersonate"],
  });
  await ctx.roles.assignRoleToOperator({
    operator_id: "op-cx", role_slug: "cx-support", assigned_by: "op-root",
  });
  var canImpersonate = await ctx.roles.hasPermission({
    operator_id: "op-cx", permission: "customers.impersonate",
  });
  check("hasPermission customers.impersonate (granted) -> true", canImpersonate === true);

  // Unassigned operator -> false.
  var ghost = await ctx.roles.hasPermission({
    operator_id: "op-never-assigned", permission: "orders.read",
  });
  check("hasPermission no assignments -> false",      ghost === false);

  // rolesForOperator enumerates active assignments.
  var aliceRoles = await ctx.roles.rolesForOperator("op-alice");
  check("rolesForOperator returns 2 rows",            aliceRoles.length === 2);
  var aliceSlugs = aliceRoles.map(function (r) { return r.role_slug; }).sort();
  check("rolesForOperator enumerates both roles",
    aliceSlugs[0] === "admin" && aliceSlugs[1] === "support");

  // operatorsWithRole inverse.
  await ctx.roles.assignRoleToOperator({
    operator_id: "op-bob", role_slug: "fulfillment", assigned_by: "op-root",
  });
  var supportTeam = await ctx.roles.operatorsWithRole("support");
  check("operatorsWithRole returns 1 for support",    supportTeam.length === 1);
  check("operatorsWithRole picks correct operator",   supportTeam[0].operator_id === "op-alice");

  // Re-assigning same (operator, role) pair while active refused.
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "admin", assigned_by: "op-root",
  }), /already holds/);

  // Unknown role refused.
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "ghost-role", assigned_by: "op-root",
  }), /not found/);
}

// ---- 3. expires_at honored at query time -----------------------------

async function _expiresAtHonored() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "contractor", title: "Contractor",
    permissions: ["orders.read", "support.handle"],
  });

  // Future expires_at: assignment is active.
  var future = Date.now() + 60 * 60 * 1000;
  var temp = await ctx.roles.assignRoleToOperator({
    operator_id: "op-temp", role_slug: "contractor", assigned_by: "op-root",
    expires_at:  future,
  });
  check("assignRoleToOperator stores expires_at",     temp.expires_at === future);

  var active = await ctx.roles.hasPermission({
    operator_id: "op-temp", permission: "orders.read",
  });
  check("hasPermission honors future expires_at -> true", active === true);

  // Past expires_at refused at create.
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-other", role_slug: "contractor", assigned_by: "op-root",
    expires_at:  Date.now() - 1000,
  }), /expires_at must be in the future/);

  // Simulate expiry by direct UPDATE — `hasPermission` and
  // `rolesForOperator` filter at query time without a sweep.
  await ctx.query(
    "UPDATE operator_role_assignments SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 5000, temp.id],
  );

  var afterExpiry = await ctx.roles.hasPermission({
    operator_id: "op-temp", permission: "orders.read",
  });
  check("hasPermission expired -> false",             afterExpiry === false);

  var stillEnumerable = await ctx.roles.rolesForOperator("op-temp");
  check("rolesForOperator excludes expired",          stillEnumerable.length === 0);

  // operatorsWithRole also filters expired.
  var contractors = await ctx.roles.operatorsWithRole("contractor");
  check("operatorsWithRole excludes expired",         contractors.length === 0);
}

// ---- 4. revokeRoleFromOperator drops permission ----------------------

async function _revokeFlow() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "admin", title: "Administrator",
    permissions: ["orders.read", "orders.refund", "users.manage"],
  });
  await ctx.roles.assignRoleToOperator({
    operator_id: "op-mallory", role_slug: "admin", assigned_by: "op-root",
  });

  // Pre-revoke: permission granted.
  var preCheck = await ctx.roles.hasPermission({
    operator_id: "op-mallory", permission: "orders.refund",
  });
  check("pre-revoke hasPermission -> true",           preCheck === true);

  // Revoke.
  var revoked = await ctx.roles.revokeRoleFromOperator({
    operator_id: "op-mallory", role_slug: "admin",
    revoked_by:  "op-root",
    reason:      "left the company",
  });
  check("revokeRoleFromOperator stamps revoked_at",   typeof revoked.revoked_at === "number");
  check("revokeRoleFromOperator stores revoked_by",   revoked.revoked_by === "op-root");
  check("revokeRoleFromOperator stores reason",       revoked.revoke_reason === "left the company");

  // Post-revoke: permission denied.
  var postCheck = await ctx.roles.hasPermission({
    operator_id: "op-mallory", permission: "orders.refund",
  });
  check("post-revoke hasPermission -> false",         postCheck === false);

  // rolesForOperator excludes revoked.
  var stillEnumerable = await ctx.roles.rolesForOperator("op-mallory");
  check("rolesForOperator excludes revoked",          stillEnumerable.length === 0);

  // Tombstone row still in the database (soft-delete preserves audit).
  var dbRows = (await ctx.query(
    "SELECT id, revoked_at FROM operator_role_assignments WHERE operator_id = ?1",
    ["op-mallory"],
  )).rows;
  check("revoke preserves row in db",                 dbRows.length === 1);
  check("revoke stamps revoked_at on row",            dbRows[0].revoked_at != null);

  // Second revoke on already-revoked refused.
  await assert.rejects(ctx.roles.revokeRoleFromOperator({
    operator_id: "op-mallory", role_slug: "admin",
    revoked_by:  "op-root",   reason:    "double-revoke",
  }), /no active assignment/);

  // Re-assignment after revoke creates a NEW row.
  var reAssign = await ctx.roles.assignRoleToOperator({
    operator_id: "op-mallory", role_slug: "admin", assigned_by: "op-root",
  });
  check("re-assign after revoke -> new row",          reAssign.id !== revoked.id);

  var rowCount = (await ctx.query(
    "SELECT id FROM operator_role_assignments WHERE operator_id = ?1",
    ["op-mallory"],
  )).rows.length;
  check("re-assign keeps tombstone + new row",        rowCount === 2);
}

// ---- 5. archiveRole denies new assignments ---------------------------

async function _archiveRoleSemantics() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "legacy", title: "Legacy",
    permissions: ["orders.read", "reports.read"],
  });
  await ctx.roles.defineRole({
    slug: "current", title: "Current",
    permissions: ["orders.read", "orders.refund"],
  });

  // Alice already holds legacy — in-flight authority preserved on
  // archive.
  await ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "legacy", assigned_by: "op-root",
  });

  var archived = await ctx.roles.archiveRole("legacy");
  check("archiveRole stamps archived_at",             typeof archived.archived_at === "number");

  // Existing assignment STILL resolves hasPermission.
  var stillResolves = await ctx.roles.hasPermission({
    operator_id: "op-alice", permission: "reports.read",
  });
  check("archived role preserves in-flight authority", stillResolves === true);

  // NEW assignments to the archived role refused.
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-bob", role_slug: "legacy", assigned_by: "op-root",
  }), /archived/);

  // listRoles default returns archived too; active_only narrows.
  var allRoles = await ctx.roles.listRoles();
  check("listRoles default returns archived too",     allRoles.length === 2);
  var activeOnly = await ctx.roles.listRoles({ active_only: true });
  check("listRoles active_only narrows",
    activeOnly.length === 1 && activeOnly[0].slug === "current");

  // Re-archive is idempotent.
  var rearchived = await ctx.roles.archiveRole("legacy");
  check("archiveRole idempotent",                     rearchived.archived_at === archived.archived_at);

  // Archive unknown role refused.
  await assert.rejects(ctx.roles.archiveRole("never-existed"),
    /not found/);
}

// ---- 6. recordPermissionUse + permissionUsageLog ---------------------

async function _permissionUseAudit() {
  var ctx = _setup();
  await ctx.roles.defineRole({
    slug: "admin", title: "Administrator",
    permissions: ["orders.read", "orders.refund", "catalog.write"],
  });
  await ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "admin", assigned_by: "op-root",
  });

  var t0 = Date.now();
  var use1 = await ctx.roles.recordPermissionUse({
    operator_id: "op-alice",
    permission:  "orders.refund",
    context:     { order_id: "ord-001", amount_minor: 2500 },
  });
  check("recordPermissionUse returns id",             typeof use1.id === "string" && use1.id.length > 0);
  check("recordPermissionUse returns operator_id",    use1.operator_id === "op-alice");
  check("recordPermissionUse returns permission",     use1.permission === "orders.refund");
  check("recordPermissionUse hydrates context",
    use1.context && use1.context.order_id === "ord-001");
  check("recordPermissionUse stamps occurred_at",     typeof use1.occurred_at === "number");
  check("recordPermissionUse occurred_at >= t0",      use1.occurred_at >= t0);

  // Append-only — a second call lands a NEW row.
  var use2 = await ctx.roles.recordPermissionUse({
    operator_id: "op-alice", permission: "orders.refund",
    context:     { order_id: "ord-002", amount_minor: 7500 },
  });
  check("recordPermissionUse second call -> distinct row", use2.id !== use1.id);
  check("monotonic clock keeps occurred_at strictly increasing",
    use2.occurred_at > use1.occurred_at);

  // Null context accepted.
  var use3 = await ctx.roles.recordPermissionUse({
    operator_id: "op-alice", permission: "orders.read",
  });
  check("recordPermissionUse null context -> null",   use3.context === null);

  // permissionUsageLog window read.
  var window = await ctx.roles.permissionUsageLog({
    operator_id: "op-alice", permission: "orders.refund",
    from:        t0 - 1000, to: Date.now() + 1000,
  });
  check("permissionUsageLog returns 2 refund rows",   window.length === 2);
  check("permissionUsageLog sorted DESC",             window[0].occurred_at >= window[1].occurred_at);
  check("permissionUsageLog hydrates context",
    window[0].context && typeof window[0].context.order_id === "string");

  // Different permission window -> empty.
  var noHits = await ctx.roles.permissionUsageLog({
    operator_id: "op-alice", permission: "catalog.write",
    from:        t0 - 1000, to: Date.now() + 1000,
  });
  check("permissionUsageLog different permission -> empty", noHits.length === 0);

  // Different operator window -> empty.
  var otherOp = await ctx.roles.permissionUsageLog({
    operator_id: "op-bob", permission: "orders.refund",
    from:        t0 - 1000, to: Date.now() + 1000,
  });
  check("permissionUsageLog different operator -> empty", otherOp.length === 0);

  // Bad inputs.
  await assert.rejects(ctx.roles.recordPermissionUse(),
    /input object required/);
  await assert.rejects(ctx.roles.recordPermissionUse({
    operator_id: "", permission: "orders.read",
  }), /operator_id/);
  await assert.rejects(ctx.roles.recordPermissionUse({
    operator_id: "op-alice", permission: "ghost.permission",
  }), /allow-list/);
  await assert.rejects(ctx.roles.permissionUsageLog({
    operator_id: "op-alice", permission: "orders.refund",
    from:        Date.now(), to: Date.now() - 1000,
  }), /to must be/);
  await assert.rejects(ctx.roles.permissionUsageLog({
    operator_id: "op-alice", permission: "orders.refund",
    from:        0, to: Date.now(), limit: 0,
  }), /limit/);
}

// ---- 7. operatorAuditLog peer wires through --------------------------

async function _operatorAuditLogPeerWired() {
  var ctx = _setup({ withAudit: true });
  await ctx.roles.defineRole({
    slug: "admin", title: "Administrator",
    permissions: ["orders.refund", "catalog.write"],
  });
  await ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "admin", assigned_by: "op-root",
  });

  await ctx.roles.recordPermissionUse({
    operator_id: "op-alice",
    permission:  "orders.refund",
    context:     { order_id: "ord-AAA" },
  });

  // Audit-log peer captured the chained call.
  check("operatorAuditLog peer received 1 record",    ctx.audit.recorded.length === 1);
  var chained = ctx.audit.recorded[0];
  check("audit row carries actor_type=operator",      chained.actor_type === "operator");
  check("audit row carries actor_id",                 chained.actor_id === "op-alice");
  check("audit row action mentions permission",
    typeof chained.action === "string" && chained.action.indexOf("orders.refund") !== -1);
  check("audit row resource_kind set",                chained.resource_kind === "operator_permission");
  check("audit row resource_id set",                  chained.resource_id === "orders.refund");
  check("audit row after.context propagated",
    chained.after && chained.after.context && chained.after.context.order_id === "ord-AAA");

  // Null-context call still records.
  await ctx.roles.recordPermissionUse({
    operator_id: "op-alice", permission: "catalog.write",
  });
  check("operatorAuditLog peer received 2 records",   ctx.audit.recorded.length === 2);
  check("null-context chained audit.after = null",    ctx.audit.recorded[1].after === null);
}

// ---- 8. factory + input validation refusals --------------------------

async function _factoryAndInputValidation() {
  // Factory accepts an explicit query handle; without one it falls
  // back to bShop.framework.externalDb.query — which throws at call
  // time because no D1 is wired in tests. The factory itself
  // constructs fine.
  var lazyRoles = operatorRoles.create();
  check("factory constructs without explicit query",
    typeof lazyRoles.defineRole === "function");
  check("factory exposes listPermissions on instance",
    typeof lazyRoles.listPermissions === "function");

  // Module-level constants.
  check("operatorRoles.MAX_SLUG_LEN exported",        operatorRoles.MAX_SLUG_LEN === 80);
  check("operatorRoles.MAX_TITLE_LEN exported",       operatorRoles.MAX_TITLE_LEN === 200);
  check("operatorRoles.PERMISSIONS is frozen array",
    Array.isArray(operatorRoles.PERMISSIONS) && Object.isFrozen(operatorRoles.PERMISSIONS));
  check("operatorRoles.PERMISSIONS has all 16 tokens",
    operatorRoles.PERMISSIONS.length === 16);

  var ctx = _setup();

  // ---- defineRole refusal classes ----
  await assert.rejects(ctx.roles.defineRole(),
    /input object required/);
  await assert.rejects(ctx.roles.defineRole(null),
    /input object required/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "Bad Slug", title: "x", permissions: ["orders.read"],
  }), /slug/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "-leading-dash", title: "x", permissions: ["orders.read"],
  }), /slug/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "", title: "x", permissions: ["orders.read"],
  }), /slug/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "x".repeat(120), title: "x", permissions: ["orders.read"],
  }), /slug/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "ok", title: "", permissions: ["orders.read"],
  }), /title/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "ok", title: "x".repeat(250), permissions: ["orders.read"],
  }), /title/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "ok", title: "bad\x01title", permissions: ["orders.read"],
  }), /control bytes/);
  await assert.rejects(ctx.roles.defineRole({
    slug: "ok", title: "ok", permissions: ["orders.read"],
    description: "x".repeat(3000),
  }), /description/);

  // ---- assignRoleToOperator refusal classes ----
  await ctx.roles.defineRole({
    slug: "support", title: "Support", permissions: ["support.handle"],
  });
  await assert.rejects(ctx.roles.assignRoleToOperator(),
    /input object required/);
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "", role_slug: "support", assigned_by: "op-root",
  }), /operator_id/);
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "Bad Slug", assigned_by: "op-root",
  }), /role_slug/);
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "support", assigned_by: "",
  }), /assigned_by/);
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-x\x01y", role_slug: "support", assigned_by: "op-root",
  }), /control bytes/);
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "support", assigned_by: "op-root",
    expires_at: -1,
  }), /expires_at/);
  await assert.rejects(ctx.roles.assignRoleToOperator({
    operator_id: "op-alice", role_slug: "support", assigned_by: "op-root",
    expires_at: 1.5,
  }), /expires_at/);

  // ---- revokeRoleFromOperator refusal classes ----
  await assert.rejects(ctx.roles.revokeRoleFromOperator(),
    /input object required/);
  await assert.rejects(ctx.roles.revokeRoleFromOperator({
    operator_id: "op-x", role_slug: "support", revoked_by: "op-root", reason: "",
  }), /reason/);
  await assert.rejects(ctx.roles.revokeRoleFromOperator({
    operator_id: "op-x", role_slug: "support", revoked_by: "op-root",
    reason: "x".repeat(600),
  }), /reason/);
  await assert.rejects(ctx.roles.revokeRoleFromOperator({
    operator_id: "op-never", role_slug: "support",
    revoked_by:  "op-root",   reason: "no such assignment",
  }), /no active assignment/);

  // ---- hasPermission refusal classes ----
  await assert.rejects(ctx.roles.hasPermission(),
    /input object required/);
  // A garbage or unknown permission token is DENIED (false), not thrown —
  // hasPermission fails closed as a hot-path authorization check (config-time
  // surfaces like defineRole still throw on an unknown token).
  check("hasPermission empty permission -> false",
    (await ctx.roles.hasPermission({ operator_id: "op-x", permission: "" })) === false);
  check("hasPermission unknown permission -> false",
    (await ctx.roles.hasPermission({ operator_id: "op-x", permission: "summon.demon" })) === false);

  // ---- rolesForOperator / operatorsWithRole ----
  await assert.rejects(ctx.roles.rolesForOperator(""),
    /operator_id/);
  await assert.rejects(ctx.roles.rolesForOperator(null),
    /operator_id/);
  await assert.rejects(ctx.roles.operatorsWithRole(""),
    /role_slug/);
  await assert.rejects(ctx.roles.operatorsWithRole("Bad Slug"),
    /role_slug/);

  // ---- listRoles refusal classes ----
  await assert.rejects(ctx.roles.listRoles({ active_only: "yes" }),
    /active_only/);
  await assert.rejects(ctx.roles.listRoles({ limit: 0 }),
    /limit/);
  await assert.rejects(ctx.roles.listRoles({ limit: 9999 }),
    /limit/);
  await assert.rejects(ctx.roles.listRoles({ limit: 1.5 }),
    /limit/);

  // ---- recordPermissionUse / permissionUsageLog ----
  await assert.rejects(ctx.roles.permissionUsageLog(),
    /input object required/);
  await assert.rejects(ctx.roles.permissionUsageLog({
    operator_id: "op-x", permission: "orders.read", from: -1, to: 0,
  }), /from/);

  // Non-JSON-serializable context refused.
  await assert.rejects(ctx.roles.recordPermissionUse({
    operator_id: "op-alice", permission: "orders.read",
    context:     function () { return 1; },
  }), /JSON-serializable/);
  var bigCtx = { blob: "x".repeat(20 * 1024) };
  await assert.rejects(ctx.roles.recordPermissionUse({
    operator_id: "op-alice", permission: "orders.read", context: bigCtx,
  }), /bytes/);

  // getRole + archiveRole bad slug.
  await assert.rejects(ctx.roles.getRole(""), /slug/);
  await assert.rejects(ctx.roles.getRole("Bad Slug"), /slug/);
  await assert.rejects(ctx.roles.archiveRole("Bad Slug"), /slug/);

  // getRole unknown -> null.
  var miss = await ctx.roles.getRole("never-existed");
  check("getRole unknown -> null",                  miss === null);
}

// ---- 9. framework handle is wired (lazy require resolves) ------------

async function _frameworkHandleAvailable() {
  // The primitive composes against `bShop.framework.uuid.v7()` via a
  // lazy require inside `_b()`. This smoke confirms the dependency
  // resolves cleanly at test time.
  check("bShop.framework exposes uuid.v7",
    typeof bShop.framework.uuid.v7 === "function");
}

async function run() {
  await _defineRoleAndAllowlist();
  await _assignAndPermissionGate();
  await _expiresAtHonored();
  await _revokeFlow();
  await _archiveRoleSemantics();
  await _permissionUseAudit();
  await _operatorAuditLogPeerWired();
  await _factoryAndInputValidation();
  await _frameworkHandleAvailable();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/operator-roles.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - operator-roles (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
