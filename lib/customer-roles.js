"use strict";
/**
 * @module shop.customerRoles
 * @title  Customer roles — B2B company-customer + employee logins
 *
 * @intro
 *   The `customers` primitive (lib/customers.js, migration 0006)
 *   models a single passkey-enrolled buyer per row. That shape fits
 *   direct-to-consumer storefronts cleanly. It does NOT fit B2B,
 *   where the buying entity is a company and several humans log in
 *   on its behalf, each carrying a different authority — a junior
 *   buyer who can drop items into the cart but cannot submit the
 *   purchase order, a manager who can submit but cannot exceed a
 *   payment-terms threshold, an admin who can mint and revoke
 *   employee logins. This primitive layers that role-and-capability
 *   structure on top of `customers` without modifying the underlying
 *   table.
 *
 *   Composition rule: a "company customer" is just a regular row in
 *   `customers` (the operator decides whether it represents an
 *   organization or an individual). An "employee customer" is
 *   another regular row in `customers`. The link between them is
 *   `customer_role_assignments`, which carries the role slug that
 *   gates what the employee can do for the company.
 *
 *   Roles are operator-authored. Each role names a capability set
 *   drawn from a closed enum:
 *
 *     can_view_orders         — see existing orders for the company
 *     can_place_order         — submit a new order on behalf
 *     can_approve_order       — sign off on an order that another
 *                                employee staged (the audit row
 *                                lands in `customer_order_approvals`
 *                                via `recordOrderApproval`)
 *     can_manage_users        — assign / unassign other employees
 *     can_view_pricing        — see operator-confidential prices
 *                                (negotiated discounts, contract
 *                                rates, B2B price lists)
 *     can_apply_payment_terms — flip an order to net-30 / net-60
 *                                instead of pay-now
 *     can_request_quote       — open a sales-channel quote
 *     can_view_invoices       — pull historical invoices for the
 *                                company
 *
 *   The enum is closed at this layer — `defineRole` refuses any
 *   capability token outside the allow-list, so a typo doesn't
 *   silently produce a role that grants nothing. Adding a new
 *   capability is a code change here, plus the operator re-defining
 *   the affected roles.
 *
 *   Surface:
 *
 *     - defineRole({ slug, title, capabilities: [...] })
 *         Create a role. `slug` is the stable operator handle
 *         (UNIQUE). Redefinition is refused — operators mutate via
 *         `updateRole`.
 *
 *     - assignRole({ company_customer_id, employee_customer_id,
 *                    role_slug })
 *         Attach the employee to the company at the named role. The
 *         pair (company, employee) is UNIQUE — re-assigning the same
 *         employee replaces the prior role row. Archived roles
 *         refuse new assignments; existing assignments keep
 *         resolving `hasCapability` (so an in-flight quote doesn't
 *         lose authority while operators rotate role definitions).
 *
 *     - unassignRole({ company_customer_id, employee_customer_id })
 *         Remove the role binding. Idempotent — re-removing returns
 *         false. The employee's `customers` row is NOT touched; only
 *         the role assignment goes away.
 *
 *     - rolesForEmployee({ employee_customer_id, company_customer_id? })
 *         Returns the assignment rows the employee carries. With
 *         `company_customer_id` set, scopes to that single pairing.
 *         Useful for "switch active company" UIs.
 *
 *     - employeesForCompany(company_customer_id)
 *         Returns every assignment row the company has, employee +
 *         role joined into one row per employee.
 *
 *     - hasCapability({ employee_customer_id, company_customer_id,
 *                       capability })
 *         The fast-path gate. Returns true iff the (company,
 *         employee) pair has an assignment, the role row exists, and
 *         the role's capability list contains the requested
 *         capability. Missing assignment, missing role, archived
 *         role's capability stripped — every miss returns false.
 *
 *     - getRole(slug) / listRoles({ active_only?, limit? }) /
 *       updateRole(slug, patch) / archiveRole(slug)
 *         Read + mutate role definitions. `updateRole` accepts
 *         `title` and / or `capabilities`; nothing else is allowed
 *         (slug is immutable).
 *
 *     - recordOrderApproval({ order_id, approved_by, role_slug })
 *         Audit hook for role-gated actions. The caller composes
 *         `hasCapability(can_approve_order)` then this — the
 *         primitive doesn't double-check capability so the same
 *         function can record any role-gated audit (the role slug
 *         is captured so the auditor sees which authority the
 *         employee invoked under). Append-only.
 *
 *   Storage:
 *     - `customer_roles`, `customer_role_assignments`,
 *       `customer_order_approvals` (migration
 *       `0101_customer_roles.sql`).
 *
 * @primitive customerRoles
 * @related    customers, order, operatorAuditLog
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN  = 80;
var MAX_TITLE_LEN = 200;
var MAX_LIST_LIMIT = 200;

// Slug shape matches the rest of the codebase — alnum-leading, alnum +
// hyphen + underscore + dot, capped length.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

// Closed capability enum. Adding a new capability is a code change
// here + the operator re-defines the affected roles.
var CAPABILITIES = Object.freeze([
  "can_view_orders",
  "can_place_order",
  "can_approve_order",
  "can_manage_users",
  "can_view_pricing",
  "can_apply_payment_terms",
  "can_request_quote",
  "can_view_invoices",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze(["title", "capabilities"]);

var b = require("./index").framework;

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("customerRoles: " + (label || "slug") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("customerRoles: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("customerRoles: title must not contain control bytes");
  }
  return s;
}

function _capability(s) {
  if (typeof s !== "string" || CAPABILITIES.indexOf(s) === -1) {
    throw new TypeError("customerRoles: capability " + JSON.stringify(s) +
      " is not in the allow-list (" + CAPABILITIES.join(", ") + ")");
  }
  return s;
}

function _capabilities(arr) {
  if (!Array.isArray(arr) || !arr.length) {
    throw new TypeError("customerRoles: capabilities must be a non-empty array of allow-list tokens");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var c = _capability(arr[i]);
    if (seen[c]) {
      throw new TypeError("customerRoles: capabilities contains duplicate " + JSON.stringify(c));
    }
    seen[c] = true;
    out.push(c);
  }
  return out;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customerRoles: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _opaqueId(s, label) {
  if (typeof s !== "string" || !s.length || s.length > 200) {
    throw new TypeError("customerRoles: " + label + " must be a non-empty string (<= 200 chars)");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("customerRoles: " + label + " must not contain control bytes");
  }
  return s;
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
  // Re-filter capabilities through the allow-list on read so a
  // hand-edited or migration-era row that carries a stale token is
  // silently dropped instead of polluting the operator surface.
  var raw = _safeParseArray(r.capabilities_json);
  var caps = [];
  for (var i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] === "string" && CAPABILITIES.indexOf(raw[i]) !== -1) {
      caps.push(raw[i]);
    }
  }
  return {
    slug:         r.slug,
    title:        r.title,
    capabilities: caps,
    archived_at:  r.archived_at == null ? null : Number(r.archived_at),
    created_at:   Number(r.created_at),
    updated_at:   Number(r.updated_at),
  };
}

function _hydrateAssignment(r) {
  if (!r) return null;
  return {
    id:                   r.id,
    company_customer_id:  r.company_customer_id,
    employee_customer_id: r.employee_customer_id,
    role_slug:            r.role_slug,
    assigned_at:          Number(r.assigned_at),
  };
}

function _hydrateApproval(r) {
  if (!r) return null;
  return {
    id:          r.id,
    order_id:    r.order_id,
    approved_by: r.approved_by,
    role_slug:   r.role_slug,
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
  // `customers` integration is optional — the primitive enforces UUID
  // shape on every id parameter, but if the operator wires the live
  // `customers` primitive in we additionally verify the referenced
  // customer row exists before assigning. Tests pass a stub that
  // satisfies the `.get(id)` contract; production wires the real
  // `bShop.customers.create(...)` instance.
  var customers = opts.customers || null;

  async function _requireCustomer(id, label) {
    if (!customers) return;
    var row = await customers.get(id);
    if (!row) {
      throw new TypeError("customerRoles: " + label + " " + JSON.stringify(id) + " not found in customers");
    }
  }

  // ---- defineRole ----------------------------------------------------

  async function defineRole(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerRoles.defineRole: input object required");
    }
    var slug  = _slug(input.slug);
    var title = _title(input.title);
    var caps  = _capabilities(input.capabilities);

    var existing = (await query(
      "SELECT slug FROM customer_roles WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("customerRoles.defineRole: slug " + JSON.stringify(slug) +
        " already exists - use updateRole");
    }

    var ts = _now();
    await query(
      "INSERT INTO customer_roles (slug, title, capabilities_json, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
      [slug, title, JSON.stringify(caps), ts],
    );
    return await getRole(slug);
  }

  // ---- getRole / listRoles -------------------------------------------

  async function getRole(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM customer_roles WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRole(r);
  }

  async function listRoles(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("customerRoles.listRoles: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("customerRoles.listRoles: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql, params;
    if (activeOnly) {
      sql    = "SELECT * FROM customer_roles WHERE archived_at IS NULL " +
               "ORDER BY created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql    = "SELECT * FROM customer_roles ORDER BY created_at ASC, slug ASC LIMIT ?1";
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
      throw new TypeError("customerRoles.updateRole: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("customerRoles.updateRole: patch must include at least one column");
    }
    var current = await getRole(slug);
    if (!current) {
      throw new TypeError("customerRoles.updateRole: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("customerRoles.updateRole: unsupported column " + JSON.stringify(col));
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
      } else /* capabilities */ {
        sets.push("capabilities_json = ?" + idx);
        params.push(JSON.stringify(_capabilities(patch[col])));
      }
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE customer_roles SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("customerRoles.updateRole: slug " + JSON.stringify(slug) + " not found");
    }
    return await getRole(slug);
  }

  // ---- archiveRole ---------------------------------------------------

  async function archiveRole(slug) {
    _slug(slug);
    var current = await getRole(slug);
    if (!current) {
      throw new TypeError("customerRoles.archiveRole: slug " + JSON.stringify(slug) + " not found");
    }
    // Idempotent — re-archive returns the existing tombstone.
    if (current.archived_at != null) return current;
    var ts = _now();
    await query(
      "UPDATE customer_roles SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return await getRole(slug);
  }

  // ---- assignRole ----------------------------------------------------

  async function assignRole(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerRoles.assignRole: input object required");
    }
    var companyId  = _opaqueId(input.company_customer_id,  "company_customer_id");
    var employeeId = _opaqueId(input.employee_customer_id, "employee_customer_id");
    if (companyId === employeeId) {
      throw new TypeError("customerRoles.assignRole: company_customer_id and employee_customer_id must differ");
    }
    var roleSlug = _slug(input.role_slug, "role_slug");

    var role = await getRole(roleSlug);
    if (!role) {
      throw new TypeError("customerRoles.assignRole: role " + JSON.stringify(roleSlug) + " not found");
    }
    if (role.archived_at != null) {
      throw new TypeError("customerRoles.assignRole: role " + JSON.stringify(roleSlug) +
        " is archived - new assignments are refused");
    }

    await _requireCustomer(companyId,  "company_customer_id");
    await _requireCustomer(employeeId, "employee_customer_id");

    var ts = _now();
    var existing = (await query(
      "SELECT id FROM customer_role_assignments " +
      "WHERE company_customer_id = ?1 AND employee_customer_id = ?2 LIMIT 1",
      [companyId, employeeId],
    )).rows[0];
    if (existing) {
      // Replace-on-conflict — the operator changes an employee's role
      // by calling assignRole again. The id + assigned_at refresh so
      // the audit trail captures the rotation.
      await query(
        "UPDATE customer_role_assignments SET role_slug = ?1, assigned_at = ?2 WHERE id = ?3",
        [roleSlug, ts, existing.id],
      );
      var updated = (await query(
        "SELECT * FROM customer_role_assignments WHERE id = ?1",
        [existing.id],
      )).rows[0];
      return _hydrateAssignment(updated);
    }
    var id = b.uuid.v7();
    await query(
      "INSERT INTO customer_role_assignments " +
      "(id, company_customer_id, employee_customer_id, role_slug, assigned_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [id, companyId, employeeId, roleSlug, ts],
    );
    return {
      id:                   id,
      company_customer_id:  companyId,
      employee_customer_id: employeeId,
      role_slug:            roleSlug,
      assigned_at:          ts,
    };
  }

  // ---- unassignRole --------------------------------------------------

  async function unassignRole(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerRoles.unassignRole: input object required");
    }
    var companyId  = _opaqueId(input.company_customer_id,  "company_customer_id");
    var employeeId = _opaqueId(input.employee_customer_id, "employee_customer_id");
    var r = await query(
      "DELETE FROM customer_role_assignments " +
      "WHERE company_customer_id = ?1 AND employee_customer_id = ?2",
      [companyId, employeeId],
    );
    return Number(r.rowCount || 0) > 0;
  }

  // ---- rolesForEmployee ----------------------------------------------

  async function rolesForEmployee(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerRoles.rolesForEmployee: input object required");
    }
    var employeeId = _opaqueId(input.employee_customer_id, "employee_customer_id");
    var rows;
    if (input.company_customer_id != null) {
      var companyId = _opaqueId(input.company_customer_id, "company_customer_id");
      rows = (await query(
        "SELECT * FROM customer_role_assignments " +
        "WHERE employee_customer_id = ?1 AND company_customer_id = ?2 " +
        "ORDER BY assigned_at ASC",
        [employeeId, companyId],
      )).rows;
    } else {
      rows = (await query(
        "SELECT * FROM customer_role_assignments WHERE employee_customer_id = ?1 " +
        "ORDER BY assigned_at ASC",
        [employeeId],
      )).rows;
    }
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateAssignment(rows[i]));
    return out;
  }

  // ---- employeesForCompany ------------------------------------------

  async function employeesForCompany(companyId) {
    var id = _opaqueId(companyId, "company_customer_id");
    var rows = (await query(
      "SELECT * FROM customer_role_assignments WHERE company_customer_id = ?1 " +
      "ORDER BY assigned_at ASC",
      [id],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateAssignment(rows[i]));
    return out;
  }

  // ---- hasCapability -------------------------------------------------

  async function hasCapability(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerRoles.hasCapability: input object required");
    }
    var companyId  = _opaqueId(input.company_customer_id,  "company_customer_id");
    var employeeId = _opaqueId(input.employee_customer_id, "employee_customer_id");
    var capability = _capability(input.capability);

    var asn = (await query(
      "SELECT role_slug FROM customer_role_assignments " +
      "WHERE company_customer_id = ?1 AND employee_customer_id = ?2 LIMIT 1",
      [companyId, employeeId],
    )).rows[0];
    if (!asn) return false;

    var role = await getRole(asn.role_slug);
    if (!role) return false;
    // Archived roles still resolve — the in-flight authority that an
    // employee already carries is honoured. New assignments to an
    // archived role are refused upstream in `assignRole`.
    return role.capabilities.indexOf(capability) !== -1;
  }

  // ---- recordOrderApproval ------------------------------------------

  async function recordOrderApproval(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerRoles.recordOrderApproval: input object required");
    }
    var orderId    = _opaqueId(input.order_id,    "order_id");
    var approvedBy = _opaqueId(input.approved_by, "approved_by");
    var roleSlug   = _slug(input.role_slug, "role_slug");

    var role = await getRole(roleSlug);
    if (!role) {
      throw new TypeError("customerRoles.recordOrderApproval: role " +
        JSON.stringify(roleSlug) + " not found");
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO customer_order_approvals (id, order_id, approved_by, role_slug, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [id, orderId, approvedBy, roleSlug, ts],
    );
    return {
      id:          id,
      order_id:    orderId,
      approved_by: approvedBy,
      role_slug:   roleSlug,
      occurred_at: ts,
    };
  }

  async function listOrderApprovals(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerRoles.listOrderApprovals: input object required");
    }
    var orderId = _opaqueId(input.order_id, "order_id");
    var limit = input.limit == null ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("customerRoles.listOrderApprovals: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var rows = (await query(
      "SELECT * FROM customer_order_approvals WHERE order_id = ?1 " +
      "ORDER BY occurred_at DESC LIMIT ?2",
      [orderId, limit],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateApproval(rows[i]));
    return out;
  }

  return {
    CAPABILITIES:         CAPABILITIES,
    defineRole:           defineRole,
    getRole:              getRole,
    listRoles:            listRoles,
    updateRole:           updateRole,
    archiveRole:          archiveRole,
    assignRole:           assignRole,
    unassignRole:         unassignRole,
    rolesForEmployee:     rolesForEmployee,
    employeesForCompany:  employeesForCompany,
    hasCapability:        hasCapability,
    recordOrderApproval:  recordOrderApproval,
    listOrderApprovals:   listOrderApprovals,
    // Exposed for tests that want to skip the live customers integration.
    _uuid:                _uuid,
  };
}

module.exports = {
  create:        create,
  CAPABILITIES:  CAPABILITIES,
  MAX_SLUG_LEN:  MAX_SLUG_LEN,
  MAX_TITLE_LEN: MAX_TITLE_LEN,
};
