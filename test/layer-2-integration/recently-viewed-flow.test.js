"use strict";
/**
 * Recently viewed — full HTTP integration of the customer browse
 * history.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * recentlyViewed + customers deps, against one in-memory `node:sqlite`
 * DB loaded from the live migrations. A signed-in customer is
 * authenticated via a sealed `shop_auth` cookie (minted with
 * b.vault.seal after boot). Exercises: empty state, a PDP visit
 * recording a view server-side, the history page listing it, the
 * clear-history round-trip, and the unauthenticated redirect.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0050_recently_viewed.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-rv-"));
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

// Mint the same sealed `shop_auth` envelope the storefront writes at
// login — a customer_id + a future expiry.
function _authCookie(customerId) {
  return "shop_auth=" + encodeURIComponent(
    b.vault.seal(JSON.stringify({ customer_id: customerId, exp: Date.now() + 3600000 })),
  );
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var recentlyViewed = bShop.recentlyViewed.create({ query: query, catalog: catalog });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "Pro widget.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });

  var buyer = b.uuid.v7();

  var handle = await _bootApp({
    catalog: catalog, cart: cart, customers: customers, recentlyViewed: recentlyViewed,
  });
  // The vault is initialized by createApp — mint the sealed cookie now.
  var cookie = _authCookie(buyer);

  try {
    // Empty state before any views.
    var empty = await helpers.httpRequest({ port: handle.port, path: "/account/recently-viewed", headers: { cookie: cookie } });
    check("recently-viewed empty then 200",      empty.status === 200);
    check("empty state copy renders",             empty.body.indexOf("haven't viewed any products") !== -1);
    check("no clear-history form when empty",      empty.body.indexOf("/account/recently-viewed/clear") === -1);

    // A signed-in PDP visit records the view server-side.
    var pdp = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro", headers: { cookie: cookie } });
    check("PDP renders for signed-in customer",   pdp.status === 200);

    // The view now surfaces on the history page as a product card.
    await helpers.waitUntil(async function () {
      var r = await recentlyViewed.forCustomer(buyer, { limit: 24 });
      return r.length >= 1;
    }, { timeoutMs: 5000, label: "recently-viewed: PDP view recorded" });

    var listed = await helpers.httpRequest({ port: handle.port, path: "/account/recently-viewed", headers: { cookie: cookie } });
    check("history then 200",                     listed.status === 200);
    check("history shows the viewed product",      listed.body.indexOf("Widget Pro") !== -1);
    check("history links to the PDP",              listed.body.indexOf("/products/widget-pro") !== -1);
    check("history shows the price",               listed.body.indexOf("$29.99") !== -1);
    check("history shows clear-history form",       listed.body.indexOf("/account/recently-viewed/clear") !== -1);

    // Clear history → redirect → empty again.
    var cleared = await helpers.httpRequest({ port: handle.port, path: "/account/recently-viewed/clear", method: "POST", headers: { cookie: cookie }, form: {} });
    check("clear-history then 303",               cleared.status === 303);
    check("clear-history redirects to history",    (cleared.headers.location || "") === "/account/recently-viewed");

    var afterClear = await helpers.httpRequest({ port: handle.port, path: "/account/recently-viewed", headers: { cookie: cookie } });
    check("history empty after clear",            afterClear.body.indexOf("haven't viewed any products") !== -1);

    // Unauthenticated access redirects to login, never renders.
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/recently-viewed" });
    check("anon history then 303",                anon.status === 303);
    check("anon redirects to login",              (anon.headers.location || "") === "/account/login");

    // A guest PDP visit still renders (no recording, no error).
    var guestPdp = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("guest PDP then 200",                   guestPdp.status === 200);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
