"use strict";
/**
 * Address book — full HTTP integration of the per-customer address CRUD.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * addresses + customers deps, against one in-memory `node:sqlite` DB
 * loaded from the live migrations. Per-customer; the routes read the
 * customer from the sealed `shop_auth` cookie (minted via b.vault.seal
 * after boot). Covers add / list / edit / set-default / archive, the
 * cross-customer ownership guard, and validation re-render.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0026_customer_addresses.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
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

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-addr-"));
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

function _authCookie(customerId) {
  return helpers.authCookie(b, customerId);
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

var ADDR_FORM = {
  recipient_name: "Ada Lovelace",
  label:          "Home",
  street_line1:   "12 Analytical Way",
  city:           "London",
  postal_code:    "EC1A 1BB",
  country:        "GB",
};

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var addresses = bShop.addresses.create({ query: query });
  var customers = bShop.customers.create({ query: query });

  var custA = b.uuid.v7();
  var custB = b.uuid.v7();
  var handle = await _bootApp({ catalog: catalog, cart: cart, addresses: addresses, customers: customers });

  try {
    // A jar per customer: the first authenticated GET seeds the
    // double-submit CSRF cookie, which the helper echoes as X-CSRF-Token
    // on each customer's subsequent state-changing POSTs (real gate, no
    // bypass). B gets its own jar so its IDOR attempts carry B's token.
    var jarA = helpers.cookieJar();
    jarA.capture({ "set-cookie": [_authCookie(custA)] });
    var jarB = helpers.cookieJar();
    jarB.capture({ "set-cookie": [_authCookie(custB)] });

    // Anon → redirect to login.
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/addresses" });
    check("anon addresses then 303 login",      anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    // Empty state.
    var empty = await helpers.httpRequest({ port: handle.port, path: "/account/addresses", jar: jarA });
    check("addresses page then 200",            empty.status === 200);
    check("empty-state shown",                  empty.body.indexOf("No saved addresses yet") !== -1);
    check("add form present",                   empty.body.indexOf("name=\"recipient_name\"") !== -1);

    // Validation: missing required recipient_name then 400 + notice.
    var bad = await helpers.httpRequest({ port: handle.port, path: "/account/addresses", method: "POST", jar: jarA, form: { street_line1: "x", city: "y", postal_code: "z", country: "US" } });
    check("add missing field then 400",         bad.status === 400);
    check("add validation notice shown",        bad.body.indexOf("form-notice--error") !== -1);

    // Add a valid address.
    var add = await helpers.httpRequest({ port: handle.port, path: "/account/addresses", method: "POST", jar: jarA, form: Object.assign({ is_default_shipping: "1" }, ADDR_FORM) });
    check("add then 303 /account/addresses",    add.status === 303 && (add.headers["location"] || "") === "/account/addresses?ok=added");
    var rowsA = await addresses.listForCustomer(custA, {});
    check("address persisted",                  rowsA.length === 1 && rowsA[0].recipient_name === "Ada Lovelace");
    check("default shipping set on add",        Number(rowsA[0].is_default_shipping) === 1);
    var addrId = rowsA[0].id;

    // List shows it.
    var list = await helpers.httpRequest({ port: handle.port, path: "/account/addresses", jar: jarA });
    check("list shows the recipient",           list.body.indexOf("Ada Lovelace") !== -1);
    check("list shows default badge",           list.body.indexOf("Default shipping") !== -1);

    // Edit form pre-fills.
    var editForm = await helpers.httpRequest({ port: handle.port, path: "/account/addresses/" + addrId + "/edit", jar: jarA });
    check("edit form pre-fills recipient",      editForm.body.indexOf("value=\"Ada Lovelace\"") !== -1);
    check("edit form posts to the id",          editForm.body.indexOf("action=\"/account/addresses/" + addrId + "\"") !== -1);

    // Update it.
    var upd = await helpers.httpRequest({ port: handle.port, path: "/account/addresses/" + addrId, method: "POST", jar: jarA, form: Object.assign({}, ADDR_FORM, { city: "Manchester" }) });
    check("update then 303",                    upd.status === 303);
    check("update applied",                     (await addresses.get(addrId)).city === "Manchester");

    // Malformed (non-UUID) id is a clean 404, not a 500.
    var malformed = await helpers.httpRequest({ port: handle.port, path: "/account/addresses/not-a-uuid/edit", jar: jarA });
    check("malformed id then 404",              malformed.status === 404);

    // Cross-customer ownership guard: B cannot edit/archive A's address.
    // The GET seeds B's CSRF cookie so the archive POST carries B's token.
    var idorEdit = await helpers.httpRequest({ port: handle.port, path: "/account/addresses/" + addrId + "/edit", jar: jarB });
    check("IDOR edit then 404",                 idorEdit.status === 404);
    var idorArch = await helpers.httpRequest({ port: handle.port, path: "/account/addresses/" + addrId + "/archive", method: "POST", jar: jarB });
    check("IDOR archive then 404",              idorArch.status === 404);
    check("A's address untouched by B",         (await addresses.get(addrId)).is_archived === 0);

    // Archive (own) removes it from the list.
    var arch = await helpers.httpRequest({ port: handle.port, path: "/account/addresses/" + addrId + "/archive", method: "POST", jar: jarA });
    check("archive then 303",                   arch.status === 303);
    check("archived out of the list",           (await addresses.listForCustomer(custA, {})).length === 0);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
