"use strict";
/**
 * @module shop.operatorRoles
 * @title  Operator roles — staff-side RBAC for the storefront's
 *         operator console (admin / support / fulfillment / accounting
 *         / marketing)
 *
 * @intro
 *   `customerRoles` (migration 0101) covers the BUYER side: a B2B
 *   company customer and its employee logins. This primitive covers
 *   the OPERATOR side: the humans (and machine actors) who run the
 *   storefront on the operator's behalf — admins, support agents,
 *   fulfillment clerks, accounting, marketing. They log in to the
 *   admin console, not to the storefront, and every gated action is
 *   audited through the composed `operatorAuditLog` peer (migration
 *   0074).
 *
 *   A role is an operator-authored bag of permission tokens drawn
 *   from a closed allow-list. The allow-list is closed at THIS
 *   primitive layer — `defineRole` refuses any token outside it, so
 *   a typo doesn't silently produce a role that grants nothing.
 *   Adding a new permission is a code change here plus the operator
 *   re-defining the affected roles.
 *
 *   Permission allow-list:
 *
 *     orders.read           — view customer order rows
 *     orders.refund         — issue a refund on a customer order
 *     orders.cancel         — cancel an order before fulfillment
 *     customers.read        — view customer rows
 *     customers.export      — bulk-export customer data (PII grain)
 *     catalog.read          — view product / variant / collection
 *     catalog.write         — create / update / delete catalog rows
 *     inventory.write       — adjust on-hand counts, post receipts
 *     vendors.manage        — manage vendor registry + commissions
 *     settings.write        — edit storefront-wide configuration
 *     billing.view          — view operator-side billing & invoices
 *     reports.read          — view sales / accounting / analytics
 *     users.invite          — invite a new operator
 *     users.manage          — change another operator's roles
 *     support.handle        — assignee + state changes on support
 *                             tickets
 *
 *   Surface:
 *
 *     - defineRole({ slug, title, permissions: [...], description? })
 *         Create a role. `slug` is the stable operator handle (PK).
 *         Redefinition is refused — operators mutate via `updateRole`.
 *
 *     - assignRoleToOperator({ operator_id, role_slug, assigned_by,
 *                              expires_at? })
 *         Attach the operator to the named role. Multi-role
 *         assignment is supported (an admin may also be a support
 *         handler). UNIQUE(operator_id, role_slug) holds while the
 *         edge is active — re-assignment of the same (operator,
 *         role) pair while still active is refused. After revoke,
 *         re-assignment creates a NEW row so the historical
 *         tombstone survives.
 *
 *     - revokeRoleFromOperator({ operator_id, role_slug, revoked_by,
 *                                reason })
 *         Stamp the tombstone (`revoked_at`, `revoked_by`,
 *         `revoke_reason`). Soft-delete preserves the audit grain.
 *         Idempotent — calling twice on an already-revoked edge
 *         throws. Time-based revocation through `expires_at` is
 *         honored without explicit revoke.
 *
 *     - rolesForOperator(operator_id)
 *         Returns active assignment rows for the operator. Excludes
 *         rows whose `revoked_at IS NOT NULL` OR whose `expires_at`
 *         is in the past.
 *
 *     - operatorsWithRole(role_slug)
 *         Inverse — every active operator carrying the named role.
 *
 *     - hasPermission({ operator_id, permission })
 *         The fast-path gate. Returns true iff any active assignment
 *         the operator holds maps to a role whose `permissions`
 *         array contains the token. Expired and revoked assignments
 *         resolve false at query time without a separate sweep.
 *
 *     - listRoles({ active_only? })
 *         Enumerate roles. `active_only: true` filters out archived.
 *
 *     - updateRole(slug, patch)
 *         Patch `title` / `permissions` / `description`. Slug is
 *         immutable.
 *
 *     - archiveRole(slug)
 *         Soft-delete. Existing assignments still resolve
 *         `hasPermission` so in-flight authority is preserved; new
 *         assignments are refused.
 *
 *     - listPermissions()
 *         Returns the closed allow-list as a frozen array — UI
 *         renders the role-builder check-boxes from this.
 *
 *     - recordPermissionUse({ operator_id, permission, context })
 *         Append-only per-use audit row. The caller composes
 *         `hasPermission(...)` then this — the primitive does NOT
 *         double-check authority so the same call records both
 *         allowed and denied attempts (the `context` payload carries
 *         the verdict if the caller wants it). Optional
 *         `operatorAuditLog` peer is invoked in parallel when wired
 *         so the chained audit also captures the action.
 *
 *     - permissionUsageLog({ operator_id, permission, from, to })
 *         Read the per-use log clipped to an `[from, to)` epoch-ms
 *         window. Used for "show me every catalog.write the
 *         marketing team did this week" audits.
 *
 *   Composition:
 *     - `b.uuid.v7`              — assignment + audit row PKs
 *     - `shop.operatorAuditLog`  — optional peer for chained audit
 *                                  (when wired, every
 *                                  `recordPermissionUse` also lands a
 *                                  row in `operator_audit_events`)
 *
 *   Monotonic clock: a per-factory monotonic timestamp ensures that
 *   two assignments / revocations / permission-use rows landed within
 *   the same wall-clock millisecond carry strictly-increasing
 *   `assigned_at` / `revoked_at` / `occurred_at` values. Fast
 *   platforms collapse `Date.now()` to identical readings inside one
 *   tick; the monotonic bump keeps the audit ordering deterministic.
 *
 *   Storage: `migrations-d1/0157_operator_roles.sql` — three tables
 *   (`operator_roles` + `operator_role_assignments` +
 *   `operator_permission_log`) with their indexes.
 *
 * @primitive operatorRoles
 * @related   operatorAuditLog, customerRoles, b.uuid
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN        = 80;
var MAX_TITLE_LEN       = 200;
var MAX_DESC_LEN        = 2000;
var MAX_OPERATOR_ID_LEN = 128;
var MAX_REASON_LEN      = 500;
var MAX_CONTEXT_BYTES   = 16 * 1024;
var MAX_LIST_LIMIT      = 500;

// Slug shape matches the rest of the codebase — alnum-leading, alnum
// + hyphen + underscore + dot, capped length.
var SLUG_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var CONTROL_BYTE_RE  = /[\x00-\x1f\x7f]/;

// Closed permission allow-list. Adding a new permission is a code
// change here AND the operator re-defining the affected roles.
var PERMISSIONS = Object.freeze([
  "orders.read",
  "orders.refund",
  "orders.cancel",
  "customers.read",
  "customers.export",
  "customers.impersonate",
  "catalog.read",
  "catalog.write",
  "inventory.write",
  "vendors.manage",
  "settings.write",
  "billing.view",
  "reports.read",
  "users.invite",
  "users.manage",
  "support.handle",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze(["title", "permissions", "description"]);

var b = require("./vendor/blamejs");

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("operatorRoles: " + (label || "slug") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("operatorRoles: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("operatorRoles: title must not contain control bytes");
  }
  return s;
}

function _description(s) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > MAX_DESC_LEN) {
    throw new TypeError("operatorRoles: description must be a string <= " + MAX_DESC_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s.replace(/[\t\r\n]/g, ""))) {
    throw new TypeError("operatorRoles: description must not contain control bytes (except whitespace)");
  }
  return s;
}

function _permission(s) {
  if (typeof s !== "string" || PERMISSIONS.indexOf(s) === -1) {
    throw new TypeError("operatorRoles: permission " + JSON.stringify(s) +
      " is not in the allow-list (" + PERMISSIONS.join(", ") + ")");
  }
  return s;
}

function _permissions(arr) {
  if (!Array.isArray(arr) || !arr.length) {
    throw new TypeError("operatorRoles: permissions must be a non-empty array of allow-list tokens");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var p = _permission(arr[i]);
    if (seen[p]) {
      throw new TypeError("operatorRoles: permissions contains duplicate " + JSON.stringify(p));
    }
    seen[p] = true;
    out.push(p);
  }
  return out;
}

function _operatorId(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_OPERATOR_ID_LEN) {
    throw new TypeError("operatorRoles: " + label + " must be a non-empty string (<= " + MAX_OPERATOR_ID_LEN + " chars)");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("operatorRoles: " + label + " must not contain control bytes");
  }
  return s;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REASON_LEN) {
    throw new TypeError("operatorRoles: reason must be a non-empty string <= " + MAX_REASON_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s.replace(/[\t\r\n]/g, ""))) {
    throw new TypeError("operatorRoles: reason must not contain control bytes (except whitespace)");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new TypeError("operatorRoles: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _context(v) {
  if (v == null) return null;
  // Accept any JSON-serializable value; refuse non-serializable shapes
  // (functions, symbols, BigInt) early.
  var json;
  try { json = JSON.stringify(v); }
  catch (_e) {
    throw new TypeError("operatorRoles: context must be JSON-serializable");
  }
  if (json === undefined) {
    throw new TypeError("operatorRoles: context must be JSON-serializable");
  }
  if (json.length > MAX_CONTEXT_BYTES) {
    throw new TypeError("operatorRoles: context must serialize to <= " + MAX_CONTEXT_BYTES + " bytes");
  }
  return v;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _safeParseArray(s) {
  if (s == null) return [];
  try {
    var parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (_e) {
    return [];
  }
}

function _hydrateRole(r) {
  if (!r) return null;
  // Re-filter permissions through the allow-list on read so a hand-
  // edited or migration-era row carrying a stale token is silently
  // dropped instead of surfacing a grant that the runtime doesn't
  // honor.
  var raw = _safeParseArray(r.permissions_json);
  var perms = [];
  for (var i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] === "string" && PERMISSIONS.indexOf(raw[i]) !== -1) {
      perms.push(raw[i]);
    }
  }
  return {
    slug:        r.slug,
    title:       r.title,
    permissions: perms,
    description: r.description == null ? null : r.description,
    archived_at: r.archived_at == null ? null : Number(r.archived_at),
    created_at:  Number(r.created_at),
    updated_at:  Number(r.updated_at),
  };
}

function _hydrateAssignment(r) {
  if (!r) return null;
  return {
    id:            r.id,
    operator_id:   r.operator_id,
    role_slug:     r.role_slug,
    assigned_by:   r.assigned_by,
    assigned_at:   Number(r.assigned_at),
    expires_at:    r.expires_at    == null ? null : Number(r.expires_at),
    revoked_at:    r.revoked_at    == null ? null : Number(r.revoked_at),
    revoked_by:    r.revoked_by    == null ? null : r.revoked_by,
    revoke_reason: r.revoke_reason == null ? null : r.revoke_reason,
  };
}

function _hydratePermissionLog(r) {
  if (!r) return null;
  var ctx = null;
  if (r.context != null) {
    try { ctx = JSON.parse(r.context); }
    catch (_e) { ctx = null; }
  }
  return {
    id:          r.id,
    operator_id: r.operator_id,
    permission:  r.permission,
    context:     ctx,
    occurred_at: Number(r.occurred_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional peer — when wired, every `recordPermissionUse` also lands
  // a row in the chained `operator_audit_events` log. The primitive
  // composes via duck-typed `.record(...)` so the tests can stub it.
  var operatorAuditLog = opts.operatorAuditLog || null;

  // Per-factory monotonic clock. Fast platforms collapse `Date.now()`
  // to identical readings inside one tick; the bump keeps the audit
  // ordering deterministic — two assignments / revocations /
  // permission-use rows landed in the same millisecond still carry
  // strictly-increasing timestamps.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = _now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- defineRole ----------------------------------------------------

  async function defineRole(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorRoles.defineRole: input object required");
    }
    var slug  = _slug(input.slug);
    var title = _title(input.title);
    var perms = _permissions(input.permissions);
    var desc  = _description(input.description);

    var existing = (await query(
      "SELECT slug FROM operator_roles WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("operatorRoles.defineRole: slug " + JSON.stringify(slug) +
        " already exists - use updateRole");
    }

    var ts = _monotonicTs();
    await query(
      "INSERT INTO operator_roles (slug, title, permissions_json, description, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
      [slug, title, JSON.stringify(perms), desc, ts],
    );
    return await getRole(slug);
  }

  // ---- getRole / listRoles -------------------------------------------

  async function getRole(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM operator_roles WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRole(r);
  }

  async function listRoles(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("operatorRoles.listRoles: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var limit = listOpts.limit == null ? 100 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("operatorRoles.listRoles: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql, params;
    if (activeOnly) {
      sql    = "SELECT * FROM operator_roles WHERE archived_at IS NULL " +
               "ORDER BY created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql    = "SELECT * FROM operator_roles ORDER BY created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRole(rows[i]));
    return out;
  }

  // ---- updateRole ----------------------------------------------------

  async function updateRole(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("operatorRoles.updateRole: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("operatorRoles.updateRole: patch must include at least one column");
    }
    var current = await getRole(slug);
    if (!current) {
      throw new TypeError("operatorRoles.updateRole: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("operatorRoles.updateRole: unsupported column " + JSON.stringify(col));
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
      } else if (col === "permissions") {
        sets.push("permissions_json = ?" + idx);
        params.push(JSON.stringify(_permissions(patch[col])));
      } else /* description */ {
        sets.push("description = ?" + idx);
        params.push(_description(patch[col]));
      }
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_monotonicTs());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE operator_roles SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("operatorRoles.updateRole: slug " + JSON.stringify(slug) + " not found");
    }
    return await getRole(slug);
  }

  // ---- archiveRole ---------------------------------------------------

  async function archiveRole(slug) {
    _slug(slug);
    var current = await getRole(slug);
    if (!current) {
      throw new TypeError("operatorRoles.archiveRole: slug " + JSON.stringify(slug) + " not found");
    }
    // Idempotent — re-archive returns the existing tombstone.
    if (current.archived_at != null) return current;
    var ts = _monotonicTs();
    await query(
      "UPDATE operator_roles SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return await getRole(slug);
  }

  // ---- assignRoleToOperator ------------------------------------------

  async function assignRoleToOperator(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorRoles.assignRoleToOperator: input object required");
    }
    var operatorId = _operatorId(input.operator_id, "operator_id");
    var roleSlug   = _slug(input.role_slug, "role_slug");
    var assignedBy = _operatorId(input.assigned_by, "assigned_by");
    var expiresAt  = input.expires_at == null ? null : _epochMs(input.expires_at, "expires_at");

    var role = await getRole(roleSlug);
    if (!role) {
      throw new TypeError("operatorRoles.assignRoleToOperator: role " +
        JSON.stringify(roleSlug) + " not found");
    }
    if (role.archived_at != null) {
      throw new TypeError("operatorRoles.assignRoleToOperator: role " +
        JSON.stringify(roleSlug) + " is archived - new assignments are refused");
    }

    var ts = _monotonicTs();
    if (expiresAt != null && expiresAt <= ts) {
      throw new TypeError("operatorRoles.assignRoleToOperator: expires_at must be in the future");
    }

    // UNIQUE(operator_id, role_slug) holds for ACTIVE edges. An
    // already-revoked tombstone leaves the historical row in place; a
    // NEW assignment after revoke creates a new row so the audit
    // trail survives.
    var active = (await query(
      "SELECT id FROM operator_role_assignments " +
      "WHERE operator_id = ?1 AND role_slug = ?2 AND revoked_at IS NULL LIMIT 1",
      [operatorId, roleSlug],
    )).rows[0];
    if (active) {
      throw new TypeError("operatorRoles.assignRoleToOperator: operator " +
        JSON.stringify(operatorId) + " already holds role " +
        JSON.stringify(roleSlug) + " - revoke first to re-assign");
    }

    var id = b.uuid.v7();
    await query(
      "INSERT INTO operator_role_assignments " +
      "(id, operator_id, role_slug, assigned_by, assigned_at, expires_at, revoked_at, revoked_by, revoke_reason) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL)",
      [id, operatorId, roleSlug, assignedBy, ts, expiresAt],
    );
    return {
      id:            id,
      operator_id:   operatorId,
      role_slug:     roleSlug,
      assigned_by:   assignedBy,
      assigned_at:   ts,
      expires_at:    expiresAt,
      revoked_at:    null,
      revoked_by:    null,
      revoke_reason: null,
    };
  }

  // ---- revokeRoleFromOperator ----------------------------------------

  async function revokeRoleFromOperator(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorRoles.revokeRoleFromOperator: input object required");
    }
    var operatorId = _operatorId(input.operator_id, "operator_id");
    var roleSlug   = _slug(input.role_slug, "role_slug");
    var revokedBy  = _operatorId(input.revoked_by, "revoked_by");
    var reason     = _reason(input.reason);

    var active = (await query(
      "SELECT id FROM operator_role_assignments " +
      "WHERE operator_id = ?1 AND role_slug = ?2 AND revoked_at IS NULL LIMIT 1",
      [operatorId, roleSlug],
    )).rows[0];
    if (!active) {
      throw new TypeError("operatorRoles.revokeRoleFromOperator: no active assignment for operator " +
        JSON.stringify(operatorId) + " role " + JSON.stringify(roleSlug));
    }

    var ts = _monotonicTs();
    await query(
      "UPDATE operator_role_assignments SET revoked_at = ?1, revoked_by = ?2, revoke_reason = ?3 " +
      "WHERE id = ?4",
      [ts, revokedBy, reason, active.id],
    );
    var updated = (await query(
      "SELECT * FROM operator_role_assignments WHERE id = ?1",
      [active.id],
    )).rows[0];
    return _hydrateAssignment(updated);
  }

  // ---- rolesForOperator ----------------------------------------------

  async function rolesForOperator(operatorId) {
    var id = _operatorId(operatorId, "operator_id");
    var now = _now();
    var rows = (await query(
      "SELECT * FROM operator_role_assignments " +
      "WHERE operator_id = ?1 AND revoked_at IS NULL " +
      "AND (expires_at IS NULL OR expires_at > ?2) " +
      "ORDER BY assigned_at ASC",
      [id, now],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateAssignment(rows[i]));
    return out;
  }

  // ---- operatorsWithRole ---------------------------------------------

  async function operatorsWithRole(roleSlug) {
    _slug(roleSlug, "role_slug");
    var now = _now();
    var rows = (await query(
      "SELECT * FROM operator_role_assignments " +
      "WHERE role_slug = ?1 AND revoked_at IS NULL " +
      "AND (expires_at IS NULL OR expires_at > ?2) " +
      "ORDER BY assigned_at ASC",
      [roleSlug, now],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateAssignment(rows[i]));
    return out;
  }

  // ---- hasPermission -------------------------------------------------

  async function hasPermission(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorRoles.hasPermission: input object required");
    }
    var operatorId = _operatorId(input.operator_id, "operator_id");
    // hasPermission is a hot-path authorization CHECK, not a config-time entry
    // point: an unknown or garbage permission token is DENIED (return false),
    // not thrown. Throwing here would crash a caller that gates on a capability
    // the allow-list doesn't carry (e.g. a workflow's required_capability, or a
    // feature capability) — the correct posture for an authorization check is
    // fail-closed. Config-time surfaces (defineRole, patchRole) still validate
    // permissions strictly via _permission.
    if (typeof input.permission !== "string" || PERMISSIONS.indexOf(input.permission) === -1) {
      return false;
    }
    var permission = input.permission;

    var now = _now();
    var rows = (await query(
      "SELECT role_slug FROM operator_role_assignments " +
      "WHERE operator_id = ?1 AND revoked_at IS NULL " +
      "AND (expires_at IS NULL OR expires_at > ?2)",
      [operatorId, now],
    )).rows;
    if (!rows.length) return false;

    for (var i = 0; i < rows.length; i += 1) {
      var role = await getRole(rows[i].role_slug);
      if (!role) continue;
      // Archived roles still resolve — the in-flight authority that an
      // operator already carries is honored. New assignments to an
      // archived role are refused upstream in `assignRoleToOperator`.
      if (role.permissions.indexOf(permission) !== -1) return true;
    }
    return false;
  }

  // ---- listPermissions -----------------------------------------------

  function listPermissions() {
    return PERMISSIONS;
  }

  // ---- recordPermissionUse + permissionUsageLog ----------------------

  async function recordPermissionUse(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorRoles.recordPermissionUse: input object required");
    }
    var operatorId = _operatorId(input.operator_id, "operator_id");
    var permission = _permission(input.permission);
    var context    = _context(input.context);

    var id = b.uuid.v7();
    var ts = _monotonicTs();
    var ctxJson = context == null ? null : JSON.stringify(context);
    await query(
      "INSERT INTO operator_permission_log (id, operator_id, permission, context, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [id, operatorId, permission, ctxJson, ts],
    );

    // Chained audit through the optional peer. The duck-typed `.record`
    // call mirrors the `operatorAuditLog.record` shape (migration 0074).
    // Failures here are surfaced — the chained audit is part of the
    // primitive's contract when the operator wires it in.
    if (operatorAuditLog && typeof operatorAuditLog.record === "function") {
      await operatorAuditLog.record({
        actor_type:    "operator",
        actor_id:      operatorId,
        action:        "permission.use:" + permission,
        resource_kind: "operator_permission",
        resource_id:   permission,
        before:        null,
        after:         context == null ? null : { context: context },
      });
    }

    return {
      id:          id,
      operator_id: operatorId,
      permission:  permission,
      context:     context,
      occurred_at: ts,
    };
  }

  async function permissionUsageLog(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorRoles.permissionUsageLog: input object required");
    }
    var operatorId = _operatorId(input.operator_id, "operator_id");
    var permission = _permission(input.permission);
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (to < from) {
      throw new TypeError("operatorRoles.permissionUsageLog: to must be >= from");
    }
    var limit = input.limit == null ? 100 : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("operatorRoles.permissionUsageLog: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var rows = (await query(
      "SELECT * FROM operator_permission_log " +
      "WHERE operator_id = ?1 AND permission = ?2 AND occurred_at >= ?3 AND occurred_at < ?4 " +
      "ORDER BY occurred_at DESC LIMIT ?5",
      [operatorId, permission, from, to, limit],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydratePermissionLog(rows[i]));
    return out;
  }

  return {
    PERMISSIONS:            PERMISSIONS,
    defineRole:             defineRole,
    getRole:                getRole,
    listRoles:              listRoles,
    updateRole:             updateRole,
    archiveRole:            archiveRole,
    assignRoleToOperator:   assignRoleToOperator,
    revokeRoleFromOperator: revokeRoleFromOperator,
    rolesForOperator:       rolesForOperator,
    operatorsWithRole:      operatorsWithRole,
    hasPermission:          hasPermission,
    listPermissions:        listPermissions,
    recordPermissionUse:    recordPermissionUse,
    permissionUsageLog:     permissionUsageLog,
  };
}

module.exports = {
  create:        create,
  PERMISSIONS:   PERMISSIONS,
  MAX_SLUG_LEN:  MAX_SLUG_LEN,
  MAX_TITLE_LEN: MAX_TITLE_LEN,
};
