"use strict";
/**
 * Wishlist — full HTTP integration of the per-customer save flow.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * wishlist + customers deps, against one in-memory `node:sqlite` DB
 * loaded from the live migrations. Wishlist is per-customer, so the
 * routes read `{ customer_id }` from the sealed `shop_auth` cookie;
 * the test mints that cookie via `b.vault.seal` after boot rather than
 * driving a WebAuthn ceremony.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0012_wishlist.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-wl-"));
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var wishlist = bShop.wishlist.create({ query: query, cursorSecret: "wl-flow-cursor" });
  var customers = bShop.customers.create({ query: query });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "Pro widget.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });

  var buyerId = b.uuid.v7();
  var handle  = await _bootApp({ catalog: catalog, cart: cart, wishlist: wishlist, customers: customers });

  try {
    var cookie = _authCookie(buyerId);

    // Anon → both wishlist surfaces redirect to login.
    var anonList = await helpers.httpRequest({ port: handle.port, path: "/account/wishlist" });
    check("anon /account/wishlist → 303",          anonList.status === 303);
    check("anon /account/wishlist → login",        (anonList.headers["location"] || "") === "/account/login");
    var anonToggle = await helpers.httpRequest({ port: handle.port, path: "/wishlist/toggle", method: "POST", form: { product_id: product.id } });
    check("anon toggle → 303 login",               anonToggle.status === 303 && (anonToggle.headers["location"] || "") === "/account/login");

    // PDP shows the save control; no count before any save.
    var pdp0 = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows save-to-wishlist button",     pdp0.body.indexOf("Save to wishlist") !== -1);
    check("pdp save form posts to toggle",         /action="\/wishlist\/toggle"/.test(pdp0.body));
    check("pdp no count before any save",          pdp0.body.indexOf("saved this") === -1);

    // Bad product id → 400.
    var bad = await helpers.httpRequest({ port: handle.port, path: "/wishlist/toggle", method: "POST", headers: { cookie: cookie }, form: { product_id: "not-a-uuid" } });
    check("toggle bad id → 400",                   bad.status === 400);

    // Save → 303 back to the product PDP; entry persisted.
    var add = await helpers.httpRequest({ port: handle.port, path: "/wishlist/toggle", method: "POST", headers: { cookie: cookie }, form: { product_id: product.id } });
    check("toggle save → 303",                     add.status === 303);
    check("toggle save → back to product",         (add.headers["location"] || "") === "/products/widget-pro");
    check("wishlist now has the entry",            (await wishlist.isWishlisted({ customer_id: buyerId, product_id: product.id })) === true);

    // PDP now shows the social-proof count.
    var pdp1 = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows '1 shopper saved this'",      pdp1.body.indexOf("1 shopper saved this") !== -1);

    // Account page lists the saved product.
    var list = await helpers.httpRequest({ port: handle.port, path: "/account/wishlist", headers: { cookie: cookie } });
    check("account wishlist → 200",                list.status === 200);
    check("account wishlist shows the product",    list.body.indexOf("Widget Pro") !== -1);
    check("account wishlist has remove form",      /name="return_to" value="\/account\/wishlist"/.test(list.body));

    // Toggle again (idempotent remove) → entry gone.
    var remove = await helpers.httpRequest({ port: handle.port, path: "/wishlist/toggle", method: "POST", headers: { cookie: cookie }, form: { product_id: product.id, return_to: "/account/wishlist" } });
    check("toggle remove → 303",                   remove.status === 303);
    check("toggle remove honors return_to",        (remove.headers["location"] || "") === "/account/wishlist?ok=removed");
    check("wishlist entry removed",                (await wishlist.isWishlisted({ customer_id: buyerId, product_id: product.id })) === false);

    // Empty state after removal.
    var listEmpty = await helpers.httpRequest({ port: handle.port, path: "/account/wishlist", headers: { cookie: cookie } });
    check("account wishlist empty-state",          listEmpty.body.indexOf("haven't saved anything yet") !== -1);

    // Open-redirect guard: a `//evil` return_to is rejected, falls back to product.
    await wishlist.add({ customer_id: buyerId, product_id: product.id });
    var evil = await helpers.httpRequest({ port: handle.port, path: "/wishlist/toggle", method: "POST", headers: { cookie: cookie }, form: { product_id: product.id, return_to: "//evil.example" } });
    check("toggle rejects //evil return_to",       (evil.headers["location"] || "") === "/products/widget-pro");
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
