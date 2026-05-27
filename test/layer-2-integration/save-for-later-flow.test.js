"use strict";
/**
 * Save for later — full HTTP integration of the cart to saved flow.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * saveForLater + customers deps, against one in-memory `node:sqlite` DB
 * loaded from the live migrations. The flow needs BOTH cookies: the
 * session `shop_sid` (which cart) and the sealed `shop_auth` (which
 * customer). The cart cookie is captured from the add-to-cart response;
 * the auth cookie is minted via `b.vault.seal` and injected into the
 * same jar.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0041_save_for_later.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-sfl-"));
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

function _lineIdFrom(html) {
  var m = /\/cart\/lines\/([0-9a-f-]{36})\/update/.exec(html);
  return m ? m[1] : null;
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var sfl      = bShop.saveForLater.create({ query: query, cursorSecret: "sfl-flow-cursor", catalog: catalog });
  var customers = bShop.customers.create({ query: query });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "Pro widget.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: 100 });

  var buyerId = b.uuid.v7();
  var handle  = await _bootApp({ catalog: catalog, cart: cart, saveForLater: sfl, customers: customers });

  try {
    // Anon guards.
    var anonSave = await helpers.httpRequest({ port: handle.port, path: "/cart/lines/" + b.uuid.v7() + "/save", method: "POST" });
    check("anon save then 303 login",          anonSave.status === 303 && (anonSave.headers["location"] || "") === "/account/login");
    var anonList = await helpers.httpRequest({ port: handle.port, path: "/account/saved" });
    check("anon saved page then 303 login",     anonList.status === 303 && (anonList.headers["location"] || "") === "/account/login");

    // Add a line to the cart (captures shop_sid), then inject the auth cookie.
    var jar = helpers.cookieJar();
    var add = await helpers.httpRequest({ port: handle.port, path: "/cart/lines", method: "POST", form: { variant_id: variant.id, qty: 1 }, jar: jar });
    check("add-to-cart then 303",               add.status === 303);
    check("cart session cookie set",            !!jar.get("shop_sid"));
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyerId) + "; Path=/"] });

    // Cart shows the line + a "Save for later" control.
    var cart1 = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    check("cart lists the SKU",                 cart1.body.indexOf("WDG-PRO-L") !== -1);
    check("cart shows Save for later",          cart1.body.indexOf("Save for later") !== -1);
    var lineId = _lineIdFrom(cart1.body);
    check("cart exposes line id",               lineId !== null);

    // Save the line then it moves out of the cart into the saved list.
    var save = await helpers.httpRequest({ port: handle.port, path: "/cart/lines/" + lineId + "/save", method: "POST", jar: jar });
    check("save then 303 /cart",                save.status === 303 && (save.headers["location"] || "") === "/cart");
    check("cart line moved out",                (await sfl.countForCustomer(buyerId)) === 1);
    var cart2 = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    check("cart no longer lists the SKU",       cart2.body.indexOf("WDG-PRO-L") === -1);

    // Saved page lists the item + actions.
    var savedList = await helpers.httpRequest({ port: handle.port, path: "/account/saved", jar: jar });
    check("saved page then 200",                savedList.status === 200);
    check("saved page shows product",           savedList.body.indexOf("Widget Pro") !== -1);
    check("saved page shows Move to cart",      savedList.body.indexOf("Move to cart") !== -1);

    var page = await sfl.listForCustomer({ customer_id: buyerId, limit: 10 });
    var saveId = page.rows[0].id;

    // Move it back to the cart.
    var backToCart = await helpers.httpRequest({ port: handle.port, path: "/saved/" + saveId + "/move-to-cart", method: "POST", jar: jar });
    check("move-to-cart then 303 /cart",        backToCart.status === 303 && (backToCart.headers["location"] || "") === "/cart");
    check("saved list now empty",               (await sfl.countForCustomer(buyerId)) === 0);
    var cart3 = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    check("cart has the SKU again",             cart3.body.indexOf("WDG-PRO-L") !== -1);

    // Save again then remove from the saved list.
    var lineId2 = _lineIdFrom(cart3.body);
    await helpers.httpRequest({ port: handle.port, path: "/cart/lines/" + lineId2 + "/save", method: "POST", jar: jar });
    var page2 = await sfl.listForCustomer({ customer_id: buyerId, limit: 10 });
    var rem = await helpers.httpRequest({ port: handle.port, path: "/saved/" + page2.rows[0].id + "/remove", method: "POST", jar: jar });
    check("remove then 303 /account/saved",     rem.status === 303 && (rem.headers["location"] || "") === "/account/saved?ok=removed");
    check("saved list empty after remove",      (await sfl.countForCustomer(buyerId)) === 0);
    var savedEmpty = await helpers.httpRequest({ port: handle.port, path: "/account/saved", jar: jar });
    check("saved empty-state shown",            savedEmpty.body.indexOf("Nothing saved for later") !== -1);

    // Duplicate-variant collision: re-add the variant to the cart while
    // a saved copy exists, then move-to-cart. The cart's UNIQUE
    // (cart_id, variant_id) makes moveToCart's INSERT collide; the route
    // must treat it gracefully (the variant is already in the cart), not 500.
    var addBack = await helpers.httpRequest({ port: handle.port, path: "/cart/lines", method: "POST", form: { variant_id: variant.id, qty: 1 }, jar: jar });
    var cartC = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    await helpers.httpRequest({ port: handle.port, path: "/cart/lines/" + _lineIdFrom(cartC.body) + "/save", method: "POST", jar: jar });
    var savedRow = (await sfl.listForCustomer({ customer_id: buyerId, limit: 10 })).rows[0];
    // Re-add the same variant to the cart so the destination already has it.
    await helpers.httpRequest({ port: handle.port, path: "/cart/lines", method: "POST", form: { variant_id: variant.id, qty: 1 }, jar: jar });
    var dup = await helpers.httpRequest({ port: handle.port, path: "/saved/" + savedRow.id + "/move-to-cart", method: "POST", jar: jar });
    check("collision move-to-cart not 500",     dup.status === 303 && (dup.headers["location"] || "") === "/cart");
    check("collision drops the saved row",      (await sfl.countForCustomer(buyerId)) === 0);
    check("addBack/cartC requests ran",         addBack.status === 303 && cartC.status === 200);

    // Unavailable saved item (product gone): the saved page must offer
    // Remove but NOT Move to cart (the move can't succeed).
    await query(
      "INSERT INTO save_for_later (id, customer_id, sku, variant_id, quantity, snapshot_price_minor, notes, saved_at) " +
      "VALUES (?1, ?2, 'GHOST-SKU', ?3, 1, 1999, NULL, ?4)",
      [b.uuid.v7(), buyerId, b.uuid.v7(), Date.now()],
    );
    var goneList = await helpers.httpRequest({ port: handle.port, path: "/account/saved", jar: jar });
    check("gone item shows no-longer-available", goneList.body.indexOf("no longer available") !== -1);
    check("gone item has a Remove form",         /\/saved\/[0-9a-f-]{36}\/remove/.test(goneList.body));
    check("gone item has NO Move to cart",       goneList.body.indexOf("Move to cart") === -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
