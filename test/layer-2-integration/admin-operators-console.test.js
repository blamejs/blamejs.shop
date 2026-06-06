"use strict";
/**
 * Multi-operator staff console — /admin/operators + the role gate on the
 * admin auth chokepoint.
 *
 * A single shared ADMIN_API_KEY guarded the whole console historically;
 * this exercises the additive per-operator layer end to end:
 *
 *   - ADMIN_API_KEY still authenticates as the break-glass owner.
 *   - The owner bootstraps the first operator while authed via the key.
 *   - That operator signs in with email + password and gets a session.
 *   - A manager is allowed catalog writes but denied operator management.
 *   - A viewer is denied EVERY mutating verb (POST), not merely hidden in
 *     the nav — read pages still render.
 *   - A disabled operator's credentials stop authenticating immediately.
 *   - Operator-authored names are escape-by-default on render (XSS).
 *
 * Also a renderer unit so the escape-by-default + control rendering are
 * pinned independent of the live DB.
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

var TOKEN = "admin-token-0123456789abcdef-test"; // >= 16 chars

// catalog + config + order are the admin.mount minimums; operator_accounts
// (0213) + operator_audit_log (0074) back the new console.
var MIGS = [
  "0001_catalog.sql", "0003_order.sql", "0004_shop_config.sql",
  "0074_operator_audit_log.sql", "0213_operator_accounts.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  var query = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  return { query: query, db: db };
}

// ---- renderer unit: escape-by-default on operator names ----------------
function _renderUnit() {
  var html = bShop.admin.renderOperators({
    shop_name: "Test Shop", nav_available: { operators: true },
    operators: [
      { id: "00000000-0000-7000-8000-000000000001", email: "x@example.com",
        display_name: "<script>alert(1)</script>", role: "manager", status: "active", has_api_key: false },
    ],
  });
  check("operators nav link present",        html.indexOf("\"/admin/operators\"") !== -1);
  check("operators raw <script> absent",     html.indexOf("<script>alert(1)</script>") === -1);
  check("operators escaped &lt;script present", html.indexOf("&lt;script&gt;") !== -1);
  // The reveal panel shows the key once when supplied.
  var revealed = bShop.admin.renderOperators({
    shop_name: "S", nav_available: { operators: true }, operators: [],
    reveal: { id: "id", key: "secret-key-plaintext" },
  });
  check("reveal panel shows the key once",    revealed.indexOf("secret-key-plaintext") !== -1);
}

// ---- direct primitive unit: no timing oracle + status gate -------------
async function _primitiveUnit() {
  var mem = _makeQuery();
  var accounts = bShop.operatorAccounts.create({ query: mem.query });
  var made = await accounts.createAccount({
    email: "unit@example.com", display_name: "Unit", password: "correct-horse-battery",
    role: "manager", created_by: "owner", mint_api_key: true,
  });
  check("create returns the minted api_key once", typeof made.api_key === "string" && made.api_key.length > 20);
  check("create never returns a hash", made.password_hash === undefined && made.api_key_hash === undefined);

  var ok = await accounts.verifyPassword({ email: "unit@example.com", password: "correct-horse-battery" });
  check("correct password verifies", !!ok && ok.id === made.id);
  var badPass = await accounts.verifyPassword({ email: "unit@example.com", password: "wrong-password-here" });
  check("wrong password is null", badPass === null);
  var unknown = await accounts.verifyPassword({ email: "nobody@example.com", password: "whatever-here-x" });
  check("unknown email is null (no oracle)", unknown === null);

  var byKey = await accounts.verifyApiKey(made.api_key);
  check("minted api key verifies", !!byKey && byKey.id === made.id);
  check("garbage api key is null", (await accounts.verifyApiKey("not-a-real-key")) === null);

  // Disable → credentials stop authenticating immediately.
  await accounts.setStatus({ id: made.id, status: "disabled", actor_id: "owner" });
  check("disabled password refused", (await accounts.verifyPassword({ email: "unit@example.com", password: "correct-horse-battery" })) === null);
  check("disabled api key refused",  (await accounts.verifyApiKey(made.api_key)) === null);
}

async function _run() {
  _renderUnit();
  await _primitiveUnit();

  var mem      = _makeQuery();
  var catalog  = bShop.catalog.create({ query: mem.query });
  var config   = bShop.config.create({ query: mem.query });
  var order    = bShop.order.create({ query: mem.query, cursorSecret: "ops-ord" });
  var operatorAuditLog = bShop.operatorAuditLog.create({ query: mem.query });
  var operatorAccounts = bShop.operatorAccounts.create({ query: mem.query, operatorAuditLog: operatorAuditLog });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-operators-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, config: config, order: order,
        shop_name: "Test Shop",
        operatorAccounts: operatorAccounts, operatorAuditLog: operatorAuditLog,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;
  var ownerBearer = { authorization: "Bearer " + TOKEN };

  try {
    // --- Additive: with zero operator rows, ADMIN_API_KEY still works ----
    var ping = await helpers.httpRequest({ port: port, path: "/admin/ping", headers: ownerBearer });
    check("ADMIN_API_KEY bearer still authenticates (ping 200)", ping.status === 200);

    // --- Bootstrap: owner (ADMIN_API_KEY) creates the first operators ----
    var mgr = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "manager@example.com", display_name: "Mae Manager", password: "manager-pass-1234", role: "manager", mint_api_key: "1" },
    });
    check("owner bootstraps a manager (201)", mgr.status === 201);
    var mgrBody = JSON.parse(mgr.body);
    check("manager create returns api_key once", typeof mgrBody.api_key === "string" && mgrBody.api_key.length > 20);
    var managerKey = mgrBody.api_key;

    var vwr = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "viewer@example.com", display_name: "Vic Viewer", password: "viewer-pass-1234", role: "viewer", mint_api_key: "1" },
    });
    check("owner bootstraps a viewer (201)", vwr.status === 201);
    var viewerKey = JSON.parse(vwr.body).api_key;

    var ownerOp = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "owner2@example.com", display_name: "Ona Owner", password: "owner-pass-12345", role: "owner", mint_api_key: "1" },
    });
    check("owner bootstraps a second owner (201)", ownerOp.status === 201);
    var owner2Key = JSON.parse(ownerOp.body).api_key;

    // --- Duplicate email refused (409 conflict) --------------------------
    var dup = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "manager@example.com", display_name: "Dup", password: "dup-pass-123456", role: "viewer" },
    });
    check("duplicate operator email is refused (4xx)", dup.status >= 400 && dup.status < 500);

    // --- Operator session sign-in (email + password) ---------------------
    var mgrJar = helpers.cookieJar();
    var signin = await helpers.httpRequest({
      port: port, path: "/admin/operators/signin", method: "POST", jar: mgrJar,
      form: { email: "manager@example.com", password: "manager-pass-1234" },
    });
    check("manager email+password sign-in 303", signin.status === 303);
    check("manager session cookie issued", !!mgrJar.get("shop_admin"));
    var mgrDash = await helpers.httpRequest({ port: port, path: "/admin/products", jar: mgrJar });
    check("manager session reaches a read page (200)", mgrDash.status === 200);

    var badSignin = await helpers.httpRequest({
      port: port, path: "/admin/operators/signin", method: "POST",
      form: { email: "manager@example.com", password: "totally-wrong-pass" },
    });
    check("wrong-password sign-in 401", badSignin.status === 401);

    // --- Role matrix: MANAGER ALLOWED catalog write ----------------------
    var mgrBearer = { authorization: "Bearer " + managerKey };
    var mgrProduct = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", headers: mgrBearer,
      form: { title: "Manager Widget", slug: "manager-widget", status: "active" },
    });
    check("manager ALLOWED to create a product (201)", mgrProduct.status === 201);

    // --- Role matrix: MANAGER DENIED operator management -----------------
    var mgrTriesOperator = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: mgrBearer,
      form: { email: "sneaky@example.com", display_name: "Sneaky", password: "sneaky-pass-1234", role: "owner" },
    });
    check("manager DENIED operator management (403)", mgrTriesOperator.status === 403);

    // --- Role matrix: VIEWER DENIED every write verb ---------------------
    var viewerBearer = { authorization: "Bearer " + viewerKey };
    var viewerReadOk = await helpers.httpRequest({ port: port, path: "/admin/products/search?q=widget", headers: viewerBearer });
    check("viewer ALLOWED a read route (200)", viewerReadOk.status === 200);
    var viewerWrite = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", headers: viewerBearer,
      form: { title: "Viewer Widget", slug: "viewer-widget", status: "active" },
    });
    check("viewer DENIED a catalog write POST (403, not hidden)", viewerWrite.status === 403);
    var viewerOps = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: viewerBearer,
      form: { email: "x2@example.com", display_name: "X", password: "x-pass-12345678", role: "viewer" },
    });
    check("viewer DENIED operator management (403)", viewerOps.status === 403);

    // --- Owner-via-key ALLOWED everything --------------------------------
    var owner2Bearer = { authorization: "Bearer " + owner2Key };
    var owner2Product = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", headers: owner2Bearer,
      form: { title: "Owner2 Widget", slug: "owner2-widget", status: "active" },
    });
    check("second owner ALLOWED catalog write (201)", owner2Product.status === 201);
    var owner2MakesOp = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: owner2Bearer,
      form: { email: "fresh@example.com", display_name: "Fresh", password: "fresh-pass-1234", role: "viewer" },
    });
    check("second owner ALLOWED operator management (201)", owner2MakesOp.status === 201);

    // --- Disable an operator → credentials refused immediately -----------
    var disable = await helpers.httpRequest({
      port: port, path: "/admin/operators/" + encodeURIComponent(mgrBody.id) + "/disable",
      method: "POST", headers: ownerBearer, form: {},
    });
    check("owner disables the manager (200)", disable.status === 200);
    var disabledKeyTry = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", headers: mgrBearer,
      form: { title: "After Disable", slug: "after-disable", status: "active" },
    });
    // Refused at the credential — the disabled key resolves to no actor, so
    // the negotiated POST never reaches the create (a JSON R route would
    // 401; the negotiated POST bounces to the sign-in). Either way it is NOT
    // accepted, and the product is not created.
    check("disabled operator's API key no longer authenticates (refused, not 201)", disabledKeyTry.status !== 201);
    var afterDisable = mem.db.prepare("SELECT COUNT(*) AS n FROM products WHERE slug = ?").get("after-disable");
    check("disabled operator's write did not land", afterDisable && Number(afterDisable.n) === 0);
    // A read route (R-wrapped, goes through _wrap) cleanly 401s the disabled key.
    var disabledRead = await helpers.httpRequest({ port: port, path: "/admin/products/search?q=x", headers: mgrBearer });
    check("disabled operator's API key 401s a JSON read route", disabledRead.status === 401);
    // The live-row re-read means the disabled operator's COOKIE session is
    // also refused on the next request — the resolver returns null (status
    // disabled), the negotiated POST bounces to /admin, and crucially the
    // mutation never runs: no should-fail product exists in the DB.
    await helpers.httpRequest({ port: port, path: "/admin/products", method: "POST", jar: mgrJar, form: { title: "ShouldFail", slug: "should-fail", status: "active" } });
    var leaked = mem.db.prepare("SELECT COUNT(*) AS n FROM products WHERE slug = ?").get("should-fail");
    check("disabled operator's cookie session cannot mutate (no product created)", leaked && Number(leaked.n) === 0);

    // --- Re-role: demote the second owner to viewer, verify the gate -----
    var demote = await helpers.httpRequest({
      port: port, path: "/admin/operators/" + encodeURIComponent(JSON.parse(ownerOp.body).id) + "/role",
      method: "POST", headers: ownerBearer, form: { role: "viewer" },
    });
    check("owner re-roles the second owner to viewer (200)", demote.status === 200);
    var demotedWrite = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", headers: owner2Bearer,
      form: { title: "Demoted", slug: "demoted", status: "active" },
    });
    check("demoted owner is now denied catalog write (403)", demotedWrite.status === 403);

    // --- Anon gate: no credential → 401 on the JSON surface --------------
    var anon = await helpers.httpRequest({ port: port, path: "/admin/operators", method: "POST", form: { email: "a@b.com", display_name: "A", password: "anon-pass-12345", role: "viewer" } });
    check("anon operator-create refused", anon.status === 401 || anon.status === 303);

    // --- The denied attempts were audited --------------------------------
    var deniedRows = mem.db.prepare(
      "SELECT COUNT(*) AS n FROM operator_audit_events WHERE action LIKE 'permission.denied:%'"
    ).get();
    check("role-denied attempts are audited", deniedRows && Number(deniedRows.n) >= 2);
    var createRows = mem.db.prepare(
      "SELECT COUNT(*) AS n FROM operator_audit_events WHERE action = 'operator_account.create'"
    ).get();
    check("operator-create actions are audited", createRows && Number(createRows.n) >= 3);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
