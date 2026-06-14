"use strict";
/**
 * Save-for-later through the LIVE security stack — proves the authenticated
 * `POST /cart/lines/:line_id/save` is CSRF-protected and is NOT silently
 * exempted by the `/cart/lines` edge-form prefix.
 *
 * `/cart/lines` is in EDGE_POST_PATHS for the edge-cached add / qty-update /
 * remove forms (cookie-less, token-less). A bare prefix match would also
 * exempt `/cart/lines/:line_id/save` — a login-required cart mutation rendered
 * only by the container — dropping the double-submit token on an authenticated
 * state change. The fix carves that path back into protection; this test locks
 * it: the save form ships a `_csrf` field, a save POST with a mismatched token
 * is refused (403), one with the jar's real token succeeds (303), and the
 * genuinely-exempt edge forms (add / update / remove) still post token-less.
 *
 * Boots the SAME production composition server.js / test/e2e/serve.js use:
 * the app-level CSRF / fetch-metadata / body-parser auto-mounts are disabled
 * and re-mounted INSIDE the route chain via
 * bShop.securityMiddleware.mountRouteGuards — i.e. the SECURITY STACK IS ON
 * (unlike the plain save-for-later-flow test, which disables it).
 *
 * Network: zero — every request lands on 127.0.0.1.
 *
 * NO worker/ import: imports only ../../lib + test/helpers + node builtins.
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
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _lineIdFrom(html) {
  var m = /\/cart\/lines\/([0-9a-f-]{36})\/update/.exec(html);
  return m ? m[1] : null;
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var sfl       = bShop.saveForLater.create({ query: query, cursorSecret: "sfl-csrf-cursor", catalog: catalog });
  var customers = bShop.customers.create({ query: query });

  var product = await catalog.products.create({ slug: "csrf-widget", title: "CSRF Widget", description: "Guard me.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "CSRF-WDG-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: 100 });

  var buyerId = b.uuid.v7();

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-sfl-csrf-"));
  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Same composition as test/e2e/serve.js: disable the app-level auto-mounts
    // and re-mount the shop's configured copies inside routes() so the
    // security stack matches production exactly (the point of this test).
    middleware: {
      securityHeaders: bShop.securityMiddleware.securityHeadersOpts(),
      rateLimit:       bShop.securityMiddleware.globalRateLimitOpts(),
      csrf:            false,
      bodyParser:      false,
      fetchMetadata:   false,
      cspNonce:        false,
    },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.securityMiddleware.mountRouteGuards(r);
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, saveForLater: sfl, customers: customers });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var origin = "http://127.0.0.1:" + port;

  try {
    var jar = helpers.cookieJar();

    // GET the PDP — seeds the session + CSRF cookie into the jar. Add-to-cart
    // is an EDGE_POST_PATHS form, so it lands token-less (proves the
    // legitimate edge exemption still works).
    var pdp = await helpers.httpRequest({ port: port, path: "/products/csrf-widget", jar: jar });
    check("pdp 200",                          pdp.status === 200);
    check("csrf cookie seeded",               !!(jar.get("csrf") || jar.get("__Host-csrf")));

    var add = await helpers.httpRequest({
      port: port, path: "/cart/lines", method: "POST", jar: jar,
      form: { variant_id: variant.id, qty: "1" }, headers: { origin: origin },
    });
    check("edge add-to-cart accepted token-less (303)", add.status === 303);

    // Inject the signed-in-customer cookie so the save route's login gate passes.
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyerId) + "; Path=/"] });

    // The container cart page renders the "Save for later" form AND, now that
    // /cart/lines/:id/save is no longer edge-exempt, injects the `_csrf` token
    // into it. The edge add/update/remove forms stay token-less.
    var cartView = await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    check("cart shows the line",              cartView.body.indexOf("CSRF-WDG-L") !== -1);
    var lineId = _lineIdFrom(cartView.body);
    check("cart exposes a line id",           lineId !== null);
    var saveFormRe = new RegExp("<form[^>]*action=\"/cart/lines/" + lineId + "/save\"[^>]*>\\s*<input type=\"hidden\" name=\"_csrf\"");
    check("save form carries a _csrf token",  saveFormRe.test(cartView.body));
    // The edge update form under the same /cart/lines prefix stays token-less.
    var updateFormRe = new RegExp("<form[^>]*action=\"/cart/lines/" + lineId + "/update\"[^>]*>\\s*<input type=\"hidden\" name=\"_csrf\"");
    check("edge update form stays token-less", !updateFormRe.test(cartView.body));

    // A save POST with the session + auth cookies but a MISMATCHED token is
    // refused by the guard (403). A non-empty bad token defeats the jar's
    // auto-attach, so the gate sees a real cookie + a wrong token — proving it
    // validates the value, i.e. the path is no longer blanket-exempt.
    var badSave = await helpers.httpRequest({
      port: port, path: "/cart/lines/" + lineId + "/save", method: "POST", jar: jar,
      headers: { "x-csrf-token": "token-that-does-not-match", origin: origin }, body: "",
    });
    check("save with bad token refused (403)", badSave.status === 403);
    check("save line NOT moved on refusal",    (await sfl.countForCustomer(buyerId)) === 0);

    // The same save WITH the jar's real double-submit token + a same-origin
    // Origin succeeds (303 → /cart) and moves the line into the saved list.
    var goodSave = await helpers.httpRequest({
      port: port, path: "/cart/lines/" + lineId + "/save", method: "POST", jar: jar,
      headers: { origin: origin }, body: "",
    });
    check("save with valid token accepted (303)", goodSave.status === 303 && (goodSave.headers["location"] || "") === "/cart");
    check("save line moved into saved list",      (await sfl.countForCustomer(buyerId)) === 1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
