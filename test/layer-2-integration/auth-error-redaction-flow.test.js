"use strict";
/**
 * Storefront auth-route error redaction — full HTTP integration.
 *
 * A 5xx from a WebAuthn ceremony route (register/login/add begin/finish)
 * must not echo the underlying error message to the client — that string
 * can carry a DB column, a stack frame, or vault internals. The route
 * logs the real error server-side (correlated by the framework request
 * id) and returns a fixed generic message plus the request id so support
 * can find the failed ceremony in the logs.
 *
 * Boots a real `b.createApp` server with the storefront mounted with a
 * `customers` dep whose `byEmailHash` throws a generic Error carrying a
 * distinctive secret string. POSTing register-begin drives that throw and
 * we assert the response body is generic — the secret never appears — and
 * that a 400-class (TypeError) failure still surfaces its client-shape
 * message (only the 5xx path is redacted).
 *
 * Network: zero — every request lands on 127.0.0.1.
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

var SECRET_INTERNAL = "INTERNAL-d1-column-customers.email_hash-leak-canary";

var MIG_CATALOG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_CART].forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// catalog + cart are mount prerequisites but are never exercised by the
// auth routes under test — wire them against an in-memory DB so mount()
// accepts the deps.
function _catalogCart() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  return { catalog: catalog, cart: cart };
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-autherr-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

function _post(handle, path, body) {
  return helpers.httpRequest({
    port:    handle.port,
    path:    path,
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(body),
  });
}

async function _run() {
  // --- 5xx path: byEmailHash throws a generic Error → redacted body. ---
  var customers500 = {
    hashEmail:   function (email) { return "hash-of-" + email; },
    byEmailHash: function () { throw new Error(SECRET_INTERNAL); },
  };
  var handle = await _bootApp(Object.assign(_catalogCart(), { customers: customers500 }));
  try {
    var res = await _post(handle, "/account/passkey/register-begin", { email: "alice@example.com", display_name: "Alice" });
    check("register-begin 5xx returns 500",          res.status === 500);
    check("register-begin 5xx body omits internal",  res.body.indexOf(SECRET_INTERNAL) === -1);
    check("register-begin 5xx body is generic",      /something went wrong/i.test(res.body));
    // The framework requestId middleware sets X-Request-Id; the redacted
    // body echoes it so support can correlate the logged real error.
    var rid = res.headers["x-request-id"];
    check("register-begin 5xx sets X-Request-Id",    typeof rid === "string" && rid.length > 0);
    check("register-begin 5xx body carries the ref", res.body.indexOf(rid) !== -1);
  } finally {
    await _teardown(handle);
  }

  // --- 400 path: a TypeError (client-shape error) still surfaces its
  //     message — only the 5xx path is redacted. The customers primitive's
  //     own validation throws a TypeError on a malformed email. ---
  var customers400 = {
    hashEmail:   function () { throw new TypeError("register-begin: email is required and must be a string"); },
    byEmailHash: function () { throw new Error("should not reach here"); },
  };
  var handle400 = await _bootApp(Object.assign(_catalogCart(), { customers: customers400 }));
  try {
    var res400 = await _post(handle400, "/account/passkey/register-begin", { display_name: "NoEmail" });
    check("register-begin 400 returns 400",          res400.status === 400);
    check("register-begin 400 surfaces client msg",  res400.body.indexOf("email is required") !== -1);
  } finally {
    await _teardown(handle400);
  }
}

module.exports = { run: _run };
