"use strict";
/**
 * Storefront purchase flow — full HTTP integration.
 *
 * Boots a real `b.createApp` HTTP server on an ephemeral port with
 * the storefront routes mounted exactly as `server.js` mounts them
 * in pure-storefront mode (catalog + cart, no Stripe). Catalog +
 * cart are wired against an in-memory `node:sqlite` database loaded
 * from the live `migrations-d1/0001_catalog.sql` + `0002_cart.sql`
 * so every CHECK / UNIQUE / FK constraint the live D1 sees is
 * exercised end-to-end. The `b.externalDb` singleton is never
 * initialized — the catalog + cart factories take the in-memory
 * query function directly via `opts.query`, so this test exists in
 * the same process as the layer-1 externaldb-d1 contract test
 * without colliding on global state.
 *
 * Network: zero. Every request lands on 127.0.0.1 against the test
 * server's bound port. The test never opens a remote socket.
 */

// Framework's boot-time SNTP drift check reaches out to pool.ntp.org
// — silence it before any module that touches `b.db.init` loads.
// Tests must NOT touch the network; this is the only call that
// would, and the env override is the documented escape hatch.
process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var b = bShop.framework;

var MIG_CATALOG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");

// Split a D1 migration file on bare `;` (outside comments) and run
// each statement via prepare().run(). Mirrors the per-statement
// dispatch the live D1 bridge does and matches the helper the
// layer-1 catalog/cart tests use.
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
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _seedCatalog(catalog) {
  var product = await catalog.products.create({
    slug:        "widget-pro",
    title:       "Widget Pro",
    description: "The pro variant of the widget.",
    status:      "active",
  });
  var variant = await catalog.variants.create(product.id, {
    sku:     "WDG-PRO-BLK-L",
    options: { color: "black", size: "L" },
  });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  return { product: product, variant: variant };
}

async function _bootApp(catalog, cart) {
  // Temp dir for the framework's data layer (vault, local sqlite,
  // shutdown bookkeeping). `b.createApp` requires it; we never write
  // shop data through it — the catalog + cart go through the in-memory
  // query function. The dir is cleaned up at test end.
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-l2-"));
  var app = await b.createApp({
    dataDir: dataDir,
    // Plaintext vault — the integration test uses an ephemeral data
    // directory deleted at end of run; sealed-mode would block on an
    // interactive passphrase prompt that has no answer in a smoke
    // gate. Real deployments run wrapped via BLAMEJS_VAULT_PASSPHRASE.
    vault:      { mode: "plaintext" },
    // Plaintext local DB — the encrypted default requires a tmpfs
    // mount the test harness can't promise across runners. We don't
    // write shop data through `b.db` at all (the storefront's
    // catalog + cart live in the in-memory sqlite via `query`), so
    // the local DB only holds framework bookkeeping that's discarded
    // when the temp dir is removed at teardown.
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: {
      // bot-guard's browser-fingerprint heuristics (Accept-Language +
      // Sec-Fetch-Mode probes) make sense in front of customer traffic
      // but block the test's plain HTTP client. We send realistic
      // header shapes anyway, but disabling the middleware keeps this
      // test independent of the heuristic catalog.
      botGuard:  false,
      rateLimit: false,
    },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart });
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });

  var seeded  = await _seedCatalog(catalog);
  var handle  = await _bootApp(catalog, cart);
  var jar     = helpers.cookieJar();

  try {
    // GET / — home page lists the seeded product
    var home = await helpers.httpRequest({ port: handle.port, path: "/", jar: jar });
    check("home returns 200",                      home.status === 200);
    check("home content-type HTML",                /text\/html/.test(home.headers["content-type"] || ""));
    check("home contains seeded product title",     home.body.indexOf("Widget Pro") !== -1);
    check("home contains product link",             home.body.indexOf("/products/widget-pro") !== -1);
    check("home renders starting price",            home.body.indexOf("$29.99") !== -1);

    // GET /products/widget-pro — variant SKU + price visible
    var pdp = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro", jar: jar });
    check("pdp returns 200",                       pdp.status === 200);
    check("pdp shows variant SKU",                  pdp.body.indexOf("WDG-PRO-BLK-L") !== -1);
    check("pdp shows variant price",                pdp.body.indexOf("$29.99") !== -1);
    check("pdp embeds add-to-cart form",            /action=\"\/cart\/lines\"/.test(pdp.body));
    check("pdp embeds variant_id hidden field",     pdp.body.indexOf("name=\"variant_id\"") !== -1);

    // POST /cart/lines — add the variant to the cart; expect a 303
    // redirect to /cart and a shop_sid Set-Cookie binding the
    // anonymous session id.
    var add = await helpers.httpRequest({
      port: handle.port,
      path: "/cart/lines",
      method: "POST",
      form: { variant_id: seeded.variant.id, qty: 2 },
      jar:  jar,
    });
    check("add-to-cart returns 303",                add.status === 303);
    check("add-to-cart redirects to /cart",         (add.headers["location"] || "") === "/cart");
    check("add-to-cart sets shop_sid cookie",       !!jar.get("shop_sid"));

    // GET /cart — line + total visible, cart count = 1
    var cartPage = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    check("cart returns 200",                       cartPage.status === 200);
    check("cart lists SKU",                         cartPage.body.indexOf("WDG-PRO-BLK-L") !== -1);
    check("cart shows qty=2 line",                  /value=\"2\"/.test(cartPage.body));
    check("cart shows line total $59.98",           cartPage.body.indexOf("$59.98") !== -1);
    check("cart pill shows count 1",                cartPage.body.indexOf("Cart, 1 items") !== -1);

    // Extract the cart-line id from the embedded update form's action
    // path: /cart/lines/<line_id>/update. The HTML form is the only
    // place the id surfaces to the client; the customer-shaped flow
    // is to POST back to that URL with a new qty.
    var lineMatch = /\/cart\/lines\/([0-9a-f-]{36})\/update/.exec(cartPage.body);
    check("cart page embeds line update form path", lineMatch !== null);
    var lineId = lineMatch[1];

    // POST /cart/lines/:line_id/update — change qty to 3; expect a
    // 303 redirect, then a fresh /cart shows the updated qty + total
    var upd = await helpers.httpRequest({
      port:   handle.port,
      path:   "/cart/lines/" + lineId + "/update",
      method: "POST",
      form:   { qty: 3 },
      jar:    jar,
    });
    check("update-line returns 303",                upd.status === 303);
    check("update-line redirects to /cart",         (upd.headers["location"] || "") === "/cart");

    var cartAfterUpd = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    check("cart after update returns 200",          cartAfterUpd.status === 200);
    check("cart after update shows qty=3",           /value=\"3\"/.test(cartAfterUpd.body));
    check("cart after update shows total $89.97",   cartAfterUpd.body.indexOf("$89.97") !== -1);

    // POST /cart/lines/:line_id/remove — drop the line; expect a 303
    // redirect, then /cart shows the empty-state copy.
    var rem = await helpers.httpRequest({
      port:   handle.port,
      path:   "/cart/lines/" + lineId + "/remove",
      method: "POST",
      jar:    jar,
    });
    check("remove-line returns 303",                rem.status === 303);
    check("remove-line redirects to /cart",         (rem.headers["location"] || "") === "/cart");

    var cartEmpty = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    check("cart after remove returns 200",          cartEmpty.status === 200);
    check("cart after remove renders empty card",   cartEmpty.body.indexOf("cart-empty__card") !== -1);
    check("cart pill shows count 0",                cartEmpty.body.indexOf("Cart, 0 items") !== -1);

    // Round-trip the assert module to keep the layer-2 surface in
    // the same accounting bucket as the layer-1 tests above.
    assert.strictEqual(home.status, 200);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
