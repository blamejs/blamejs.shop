"use strict";
/**
 * RBAC fail-closed default on the admin chokepoint.
 *
 * Every mutating admin route names an audit action (`W("product.update",
 * ...)`); the action's first segment maps to the permission the route
 * requires. The systemic risk is the FALLBACK: an action whose prefix
 * nobody mapped used to resolve to the broad `catalog.write` grant — so a
 * newly-added `W()`-route was silently reachable by a manager. This pins the
 * fail-closed contract:
 *
 *   - an UNMAPPED mutating action requires the OWNER role — a viewer AND a
 *     manager are both denied; only owner (which holds the `*` root scope
 *     via b.permissions) passes,
 *   - existing MAPPED routes keep their grants exactly: manager holds
 *     catalog/orders/customers writes, is denied settings + operator
 *     management; viewer holds nothing,
 *   - every `W("<prefix>.<verb>", ...)` route registered in lib/admin.js has
 *     its prefix mapped in `_ACTION_PERMISSION`, so a future route can't
 *     re-introduce the fallback silently (it would have to be added to the
 *     map to be reachable at all — and the map is what this test reads).
 *
 * A live end-to-end leg proves the resolver is actually wired into the auth
 * chokepoint: a manager is ALLOWED a mapped catalog write and a viewer is
 * DENIED it (403) through the real admin router.
 *
 * Network: zero — every request lands on 127.0.0.1. NO worker/ import.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;
var admin = bShop.admin;

var TOKEN = "admin-token-0123456789abcdef-rbac";

var MIGS = [
  "0001_catalog.sql", "0003_order.sql", "0004_shop_config.sql",
  "0043_collections.sql",
  "0074_operator_audit_log.sql", "0213_operator_accounts.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// ---- unit: the fail-closed resolver + role-grant predicate ----------------
function _failClosedResolver() {
  var OWNER_ONLY = admin._OWNER_ONLY_PERMISSION;

  // Unmapped mutating actions FAIL CLOSED to the owner-only fallback.
  var unmapped = [
    "newfeature.create", "loyaltytier.update", "vendorpayout.approve",
    "zzz.delete", "definitely_not_mapped.write",
  ];
  for (var i = 0; i < unmapped.length; i += 1) {
    var perm = admin._permissionForAction(unmapped[i]);
    check("unmapped action resolves to owner-only fallback: " + unmapped[i], perm === OWNER_ONLY);
    check("manager DENIED unmapped action: " + unmapped[i], admin._roleGrants("manager", perm) === false);
    check("viewer DENIED unmapped action: " + unmapped[i],  admin._roleGrants("viewer", perm) === false);
    check("owner ALLOWED unmapped action: " + unmapped[i],   admin._roleGrants("owner", perm) === true);
  }

  // A null / empty audit action (defensive) also fails closed to owner-only.
  check("empty audit action → owner-only", admin._permissionForAction("") === OWNER_ONLY);
  check("non-string audit action → owner-only", admin._permissionForAction(null) === OWNER_ONLY);
  check("manager DENIED the owner-only fallback directly", admin._roleGrants("manager", OWNER_ONLY) === false);
  check("owner ALLOWED the owner-only fallback directly",  admin._roleGrants("owner", OWNER_ONLY) === true);

  // Mapped routes keep their grants exactly — the fix doesn't over-tighten.
  var mappedManagerOk = [
    "product.update", "variant.create", "inventory.adjust", "collection.update",
    "order.refund", "return.approve", "export.create", "quote.send",
    "customer.update", "customer_segment.create", "email_campaign.create",
  ];
  for (var m = 0; m < mappedManagerOk.length; m += 1) {
    var p2 = admin._permissionForAction(mappedManagerOk[m]);
    check("manager ALLOWED mapped action: " + mappedManagerOk[m], admin._roleGrants("manager", p2) === true);
    check("viewer DENIED mapped action: " + mappedManagerOk[m],   admin._roleGrants("viewer", p2) === false);
    check("owner ALLOWED mapped action: " + mappedManagerOk[m],   admin._roleGrants("owner", p2) === true);
    check("mapped action is NOT the owner-only fallback: " + mappedManagerOk[m], p2 !== admin._OWNER_ONLY_PERMISSION);
  }

  // Owner-only mapped routes stay owner-only — manager is denied config +
  // operator management even though they're explicitly mapped.
  var ownerOnlyMapped = ["config.update", "operator.create", "operator.set_role", "operator.disable"];
  for (var o = 0; o < ownerOnlyMapped.length; o += 1) {
    var p3 = admin._permissionForAction(ownerOnlyMapped[o]);
    check("manager DENIED owner-only mapped action: " + ownerOnlyMapped[o], admin._roleGrants("manager", p3) === false);
    check("owner ALLOWED owner-only mapped action: " + ownerOnlyMapped[o],  admin._roleGrants("owner", p3) === true);
  }

  // An unknown role grants NOTHING (fails closed) for any permission.
  check("unknown role grants nothing (mapped)",   admin._roleGrants("superuser", admin._permissionForAction("product.update")) === false);
  check("unknown role grants nothing (fallback)", admin._roleGrants("superuser", OWNER_ONLY) === false);
}

// ---- coverage gate: every W()-route prefix is mapped ----------------------
//
// Reads lib/admin.js source and extracts every `W("<prefix>.<verb>", ...)`
// audit action. Each prefix MUST resolve to a non-fallback permission — a
// new route whose prefix nobody mapped resolves to owner-only, which trips
// here (the route would only be owner-reachable until it's mapped to the
// role that should hold it).
function _everyWriteRoutePrefixIsMapped() {
  var src = nodeFs.readFileSync(nodePath.resolve(__dirname, "..", "..", "lib", "admin.js"), "utf8");
  var re = /\bW\("([a-z_]+)\./g;
  var seen = {};
  var unmapped = [];
  var m;
  while ((m = re.exec(src)) !== null) {
    var prefix = m[1];
    if (seen[prefix]) continue;
    seen[prefix] = true;
    if (admin._permissionForAction(prefix + ".x") === admin._OWNER_ONLY_PERMISSION) {
      unmapped.push(prefix);
    }
  }
  check("every W()-route prefix maps to an explicit permission (none fall through to owner-only): " +
    (unmapped.length ? unmapped.join(", ") : "all mapped"), unmapped.length === 0);
}

// ---- live: resolver is wired into the real auth chokepoint ----------------
async function _liveChokepointWired() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "rbac-fc-order" });
  var config  = bShop.config.create({ query: query });
  var collections = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "rbac-fc-coll" });
  var operatorAuditLog = bShop.operatorAuditLog.create({ query: query });
  var operatorAccounts = bShop.operatorAccounts.create({ query: query, operatorAuditLog: operatorAuditLog });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-rbac-fc-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        collections: collections,
        operatorAccounts: operatorAccounts, operatorAuditLog: operatorAuditLog,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;
  var ownerBearer = { authorization: "Bearer " + TOKEN };

  try {
    var vwr = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "v@example.com", display_name: "Vic Viewer", password: "viewer-pass-1234", role: "viewer", mint_api_key: "1" },
    });
    check("bootstrap viewer (201)", vwr.status === 201);
    var viewerBearer = { authorization: "Bearer " + JSON.parse(vwr.body).api_key };

    var mgr = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "m@example.com", display_name: "Mae Manager", password: "manager-pass-1234", role: "manager", mint_api_key: "1" },
    });
    check("bootstrap manager (201)", mgr.status === 201);
    var managerBearer = { authorization: "Bearer " + JSON.parse(mgr.body).api_key };

    // A manager creating a collection (catalog.write, mapped) is ALLOWED.
    var mgrWrite = await helpers.httpRequest({
      port: port, path: "/admin/collections", method: "POST", headers: managerBearer,
      form: { type: "manual", title: "Manager Collection", slug: "mgr-coll" },
    });
    check("manager ALLOWED a mapped catalog write (2xx)", mgrWrite.status >= 200 && mgrWrite.status < 300);

    // A viewer is DENIED the same mapped write (403 on the verb, before the
    // create runs).
    var vwrWrite = await helpers.httpRequest({
      port: port, path: "/admin/collections", method: "POST", headers: viewerBearer,
      form: { type: "manual", title: "Viewer Collection", slug: "vwr-coll" },
    });
    check("viewer DENIED a mapped catalog write (403)", vwrWrite.status === 403);

    // A manager is DENIED operator management (owner-only, mapped).
    var mgrOperator = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: managerBearer,
      form: { email: "x@example.com", display_name: "X", password: "another-pass-1234", role: "viewer" },
    });
    check("manager DENIED operator management (403)", mgrOperator.status === 403);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

async function _run() {
  _failClosedResolver();
  _everyWriteRoutePrefixIsMapped();
  await _liveChokepointWired();
  console.log("admin-rbac-fail-closed: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: _run };
