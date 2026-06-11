"use strict";
/**
 * Operator-tunable search ranking — full HTTP integration of the /search
 * rerank + the /admin/search-ranking console (weight sets, activation, pins,
 * coded-error mapping, XSS escaping, never-500 robustness).
 *
 * Boots ONE b.createApp with BOTH the storefront (wired { catalog, cart,
 * searchRanking }) and admin.mount (wired { token, catalog, order,
 * searchRanking }) against one in-memory node:sqlite DB so the admin writes
 * and the storefront reranks share the same data.
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql", "0167_search_ranking.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// Pull the ordered product slugs out of the rendered search grid so the test
// can assert relative order. The product card links /products/<slug>.
function _orderedSlugs(html) {
  var out = [];
  var re = /\/products\/([a-z0-9-]+)/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    if (out.indexOf(m[1]) === -1) out.push(m[1]);
  }
  return out;
}

async function _run() {
  var mq      = helpers.memD1Query(MIGS);
  var query   = mq.query;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "sr-test" });
  var config  = bShop.config.create({ query: query });
  var searchRanking = bShop.searchRanking.create({ query: query });

  // Seed 3 products matching "widget": two in stock, one OOS. The default
  // catalog search order is updated_at DESC, so seed them in a known order.
  async function _seed(slug, title, sku, stock) {
    var p = await catalog.products.create({ slug: slug, title: title, status: "active" });
    await catalog.variants.create(p.id, { sku: sku, title: "Default", position: 0 });
    await catalog.inventory.create(sku, { stock_on_hand: stock });
    return p;
  }
  var pOos = await _seed("widget-alpha", "Widget Alpha", "WID-A", 0);   // OOS, newest
  await _seed("widget-bravo", "Widget Bravo", "WID-B", 50);             // in stock
  await _seed("widget-charlie", "Widget Charlie", "WID-C", 50);         // in stock

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-srank-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, searchRanking: searchRanking });
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        searchRanking: searchRanking, shop_name: "Test Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login 303",                       login.status === 303);

    // t1 — search with NO active weight set: default order (rerank inert).
    var s0 = await helpers.httpRequest({ port: port, path: "/search?q=widget" });
    check("t1 search 200 (no active set)",         s0.status === 200);
    var slugs0 = _orderedSlugs(s0.body);
    check("t1 all three products present",          slugs0.indexOf("widget-alpha") !== -1 && slugs0.indexOf("widget-bravo") !== -1 && slugs0.indexOf("widget-charlie") !== -1);

    // t2 — define a weight set weighting in_stock high; activate; in-stock
    // products now lead the OOS one.
    var def = await helpers.httpRequest({
      port: port, path: "/admin/search-ranking/weights", method: "POST", jar: jar,
      form: { slug: "in-stock-first", name: "In stock first", weights: "{\"in_stock\":100}" },
    });
    check("t2 define weights 303",                 def.status === 303);
    var act = await helpers.httpRequest({
      port: port, path: "/admin/search-ranking/weights/in-stock-first/activate", method: "POST", jar: jar, form: {},
    });
    check("t2 activate 303",                        act.status === 303);
    var s1 = await helpers.httpRequest({ port: port, path: "/search?q=widget" });
    check("t2 search 200 (active set)",            s1.status === 200);
    var slugs1 = _orderedSlugs(s1.body);
    var alphaIdx = slugs1.indexOf("widget-alpha");
    var bravoIdx = slugs1.indexOf("widget-bravo");
    var charlieIdx = slugs1.indexOf("widget-charlie");
    check("t2 in-stock products lead the OOS one", bravoIdx < alphaIdx && charlieIdx < alphaIdx);

    // t3 — pin the OOS product to position 1 for "widget"; it now leads
    // regardless of its weighted score.
    var pin = await helpers.httpRequest({
      port: port, path: "/admin/search-ranking/pins", method: "POST", jar: jar,
      form: { query: "widget", product_id: pOos.id, position: "1" },
    });
    check("t3 pin 303",                             pin.status === 303);
    var s2 = await helpers.httpRequest({ port: port, path: "/search?q=widget" });
    var slugs2 = _orderedSlugs(s2.body);
    check("t3 pinned OOS product leads",            slugs2[0] === "widget-alpha");

    // t4 — archived/unknown weight slug on activate → 400/404 coded-error
    // mapping (browser → err redirect, never 500). Use the bearer JSON API to
    // assert the exact status code.
    var bearer = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
    var unknownAct = await helpers.httpRequest({
      port: port, path: "/admin/search-ranking/weights/does-not-exist/activate", method: "POST",
      headers: bearer, body: "{}",
    });
    check("t4 unknown slug activate 404",           unknownAct.status === 404);
    // Archive the set then try to activate it → 400 (archived).
    await helpers.httpRequest({ port: port, path: "/admin/search-ranking/weights/in-stock-first/archive", method: "POST", jar: jar, form: {} });
    var archivedAct = await helpers.httpRequest({
      port: port, path: "/admin/search-ranking/weights/in-stock-first/activate", method: "POST",
      headers: bearer, body: "{}",
    });
    check("t4 archived slug activate 400",          archivedAct.status === 400);

    // t5 — XSS: weight-set name + pin query with a payload → escaped in the
    // admin list screen.
    await helpers.httpRequest({
      port: port, path: "/admin/search-ranking/weights", method: "POST", jar: jar,
      form: { slug: "xss-set", name: "<script>alert('name')</script>", weights: "{\"in_stock\":1}" },
    });
    await helpers.httpRequest({
      port: port, path: "/admin/search-ranking/pins", method: "POST", jar: jar,
      form: { query: "<script>alert('q')</script>", product_id: pOos.id, position: "1" },
    });
    var listPage = await helpers.httpRequest({ port: port, path: "/admin/search-ranking?pins_query=" + encodeURIComponent("<script>alert('q')</script>"), jar: jar });
    check("t5 admin list 200",                      listPage.status === 200);
    check("t5 weight-set name escaped",             listPage.body.indexOf("<script>alert('name')</script>") === -1);
    check("t5 pin query escaped",                   listPage.body.indexOf("<script>alert('q')</script>") === -1);

    // t6 — rerank robustness: even with the active set archived (above) the
    // /search page still renders (the try/catch never-500 fallback).
    var s3 = await helpers.httpRequest({ port: port, path: "/search?q=widget" });
    check("t6 search still renders after archive",  s3.status === 200);
    check("t6 search still lists products",         _orderedSlugs(s3.body).length >= 3);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };
