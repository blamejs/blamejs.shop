"use strict";
/**
 * Product compare — full HTTP integration of the side-by-side compare
 * basket: the PDP "Add to compare" toggle, the cookie-keyed guest
 * basket, the /compare table, the empty state, malformed-id handling,
 * and the four-product cap.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * productCompare + catalog + cart deps, against one in-memory
 * `node:sqlite` DB loaded from the live migrations. The basket is keyed
 * on the `shop_sid` session cookie (no login required), so the test
 * drives it through a cookie jar that captures the minted session
 * cookie and replays it on subsequent requests.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0195_product_compare.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-cmp-"));
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

// Build the catalog adapter the storefront wires into the productCompare
// primitive in server.js — getProduct returns the product enriched with a
// `variants` array so the baked-in variant-sourced attributes resolve.
function _compareCatalogAdapter(catalog) {
  return {
    getProduct: async function (productId) {
      var product = await catalog.products.get(productId);
      if (!product || product.status !== "active") return null;
      var variants = await catalog.variants.listForProduct(productId);
      var enriched = [];
      for (var i = 0; i < variants.length; i += 1) {
        var v = variants[i];
        var priceMinor = null;
        var pr = await catalog.prices.current(v.id, "USD");
        if (pr) priceMinor = pr.amount_minor;
        enriched.push({ sku: v.sku, weight: v.weight_grams, price_minor: priceMinor });
      }
      return Object.assign({}, product, { variants: enriched });
    },
  };
}

async function _makeProduct(catalog, slug, title, sku, priceMinor) {
  var product = await catalog.products.create({ slug: slug, title: title, description: title + " description.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: sku, options: { size: "L" }, weight_grams: 250 });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: priceMinor });
  return product;
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var productCompare = bShop.productCompare.create({ query: query, catalog: _compareCatalogAdapter(catalog) });

  var pA = await _makeProduct(catalog, "widget-a", "Widget A", "WDG-A", 1999);
  var pB = await _makeProduct(catalog, "widget-b", "Widget B", "WDG-B", 2999);
  var pC = await _makeProduct(catalog, "widget-c", "Widget C", "WDG-C", 3999);
  var pD = await _makeProduct(catalog, "widget-d", "Widget D", "WDG-D", 4999);
  var pE = await _makeProduct(catalog, "widget-e", "Widget E", "WDG-E", 5999);

  var handle = await _bootApp({ catalog: catalog, cart: cart, productCompare: productCompare });

  try {
    // PDP shows the compare control (action-only, posts to the toggle).
    var pdp0 = await helpers.httpRequest({ port: handle.port, path: "/products/widget-a" });
    check("pdp shows add-to-compare button",        pdp0.body.indexOf("Add to compare") !== -1);
    check("pdp compare form posts to toggle",       /action="\/compare\/toggle"/.test(pdp0.body));
    check("pdp links to /compare",                  /href="\/compare"/.test(pdp0.body));

    // Footer surfaces the Compare link alongside Cart.
    check("footer has compare link",                pdp0.body.indexOf("<li><a href=\"/compare\">Compare</a></li>") !== -1);

    // Empty state — a fresh visitor with no session sees the empty page,
    // and the GET doesn't mint a session cookie.
    var empty = await helpers.httpRequest({ port: handle.port, path: "/compare" });
    check("empty /compare → 200",                   empty.status === 200);
    check("empty /compare shows empty copy",        empty.body.indexOf("haven't added anything to compare") !== -1);
    check("empty /compare mints no session cookie", !(empty.headers["set-cookie"] || []).join(";").match(/shop_sid=/));

    // Malformed product id → 400 (the primitive throws TypeError on a
    // non-UUID; the route surfaces it as a client error, not a 500).
    var jarBad = helpers.cookieJar();
    var bad = await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jarBad, form: { product_id: "not-a-uuid" } });
    check("toggle bad id → 400",                    bad.status === 400);

    // Add A → 303 back to the PDP, a session cookie is minted, basket has A.
    var jar = helpers.cookieJar();
    var addA = await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pA.id } });
    check("toggle add A → 303",                     addA.status === 303);
    check("toggle add A → back to product",         (addA.headers["location"] || "").indexOf("/products/widget-a") === 0);
    check("toggle add A → added notice",            (addA.headers["location"] || "").indexOf("notice=added") !== -1);
    check("toggle add A mints session cookie",      jar.get("shop_sid") !== null);
    var sid1 = jar.get("shop_sid");

    // Add B (carries the same session via the jar). Basket = {A, B}.
    var addB = await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pB.id } });
    check("toggle add B → 303",                     addB.status === 303);
    check("session cookie stable across adds",      jar.get("shop_sid") === sid1);
    var listAB = await productCompare.getCompareList({ session_id: sid1 });
    check("basket holds both A and B",              listAB.product_ids.length === 2);

    // Toggle A again — A is present, so this REMOVES it. Basket = {B}.
    var rmA = await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pA.id } });
    check("toggle present id → removed notice",     (rmA.headers["location"] || "").indexOf("notice=removed") !== -1);
    var listB = await productCompare.getCompareList({ session_id: sid1 });
    check("toggle of present id removes it",         listB.product_ids.indexOf(pA.id) === -1);
    check("toggle leaves the other entry",           listB.product_ids.indexOf(pB.id) !== -1);

    // Toggle A once more — absent now, so this ADDS it back. Basket = {B, A}.
    await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pA.id } });

    // Compare page renders the side-by-side table for {B, A}.
    var page = await helpers.httpRequest({ port: handle.port, path: "/compare", jar: jar });
    check("/compare → 200",                          page.status === 200);
    check("/compare shows Widget A",                 page.body.indexOf("Widget A") !== -1);
    check("/compare shows Widget B",                 page.body.indexOf("Widget B") !== -1);
    check("/compare shows a Price row",              page.body.indexOf("Price") !== -1);
    check("/compare shows an Availability row",      page.body.indexOf("Availability") !== -1);
    check("/compare shows formatted prices",         page.body.indexOf("$29.99") !== -1 && page.body.indexOf("$19.99") !== -1);
    check("/compare has per-column remove",          /action="\/compare\/toggle"[\s\S]*?name="return_to" value="\/compare"/.test(page.body));
    check("/compare title shows the count",          page.body.indexOf("Compare products (2)") !== -1);

    // Cap behaviour — fill to four ({B, A, C, D}), then a fifth refuses
    // with the full notice and the basket is unchanged.
    await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pC.id } });
    await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pD.id } });
    var full = await productCompare.getCompareList({ session_id: sid1 });
    check("basket fills to the 4-product cap",       full.product_ids.length === 4);
    var fifth = await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pE.id } });
    check("fifth add → 303 with full notice",        fifth.status === 303 && (fifth.headers["location"] || "").indexOf("notice=full") !== -1);
    var afterFifth = await productCompare.getCompareList({ session_id: sid1 });
    check("cap holds — still 4, E rejected",         afterFifth.product_ids.length === 4 && afterFifth.product_ids.indexOf(pE.id) === -1);

    // Unavailable/archived product resolves out gracefully — archive A,
    // the column renders the gone-state, the table doesn't 500.
    await catalog.products.update(pA.id, { status: "archived" });
    var pageGone = await helpers.httpRequest({ port: handle.port, path: "/compare", jar: jar });
    check("/compare with archived product → 200",    pageGone.status === 200);
    check("/compare renders gone-state column",      pageGone.body.indexOf("No longer available") !== -1);

    // Open-redirect guard on the toggle — a `//evil` return_to falls back
    // to the product PDP, never the off-origin host.
    var evil = await helpers.httpRequest({ port: handle.port, path: "/compare/toggle", method: "POST", jar: jar, form: { product_id: pB.id, return_to: "//evil.example" } });
    check("toggle rejects //evil return_to",         (evil.headers["location"] || "").indexOf("/products/widget-b") === 0);

    // Clear empties the basket and redirects back to /compare.
    var cleared = await helpers.httpRequest({ port: handle.port, path: "/compare/clear", method: "POST", jar: jar });
    check("clear → 303 to /compare",                 cleared.status === 303 && (cleared.headers["location"] || "").indexOf("/compare") === 0);
    var afterClear = await productCompare.getCompareList({ session_id: sid1 });
    check("clear empties the basket",                afterClear.product_ids.length === 0);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
