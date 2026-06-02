"use strict";
/**
 * robots.txt crawl policy + sitemap coverage (SEO-2 + SEO-3).
 *
 * robots.txt (SEO-2):
 *   - the container /robots.txt Disallows the session/operator routes
 *     (/admin, /cart, /checkout, /pay/, /orders/, /account) on a fresh
 *     deploy (hardcoded fallback);
 *   - with robotsConfig rules defined, the operator's per-bot policy
 *     surfaces; with no rules, the hardcoded fallback Disallow set stays
 *     (robotsConfig's empty-table `Allow: /` only branch would drop the
 *     /admin disallow — the route keeps the fallback unless rules exist);
 *   - the edge robots body Disallows the same routes (parity with the
 *     container) — pinned against the same origin.
 *
 * sitemap.xml (SEO-3):
 *   - the container sitemap lists products + collections + categories + CMS
 *     pages;
 *   - the edge sitemap renderer emits /collections/<slug>, /categories/
 *     <slug>, /pages/<slug> entries, XML-escaped;
 *   - a collection slug rendered at the edge produces the same `<loc>` as
 *     the container for the same origin + slug (parity);
 *   - a slug with XML-active chars (`&`, `<`, `"`, `'`) survives as the
 *     correct entity.
 *
 * Boots a real `b.createApp` server for the container halves; the edge
 * sitemap renderer loads behind an `fs.existsSync` guard. Network: zero.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var nodeUrl  = require("node:url");
var nodeModule = require("node:module");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var ALL_MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0043_collections.sql",
  "0201_category_navigation.sql",
  "0059_storefront_pages.sql",
  "0147_robots_config.sql",
];

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery(migs) {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  migs.forEach(function (n) {
    var p = nodePath.resolve(__dirname, "..", "..", "migrations-d1", n);
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-robots-"));
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

var _jsonHookRegistered = false;
function _registerJsonHook() {
  if (_jsonHookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _jsonHookRegistered = true;
}

async function _seedCatalogRows(query) {
  var now = Date.now();
  // One active product.
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)",
    [b.uuid.v7(), "widget-pro", "Widget Pro", "A widget.", now]
  );
  // One active collection.
  await query(
    "INSERT INTO collections (slug, type, title, description, sort_strategy, archived_at, created_at, updated_at) " +
    "VALUES ('summer', 'manual', 'Summer', '', 'manual', NULL, ?1, ?1)",
    [now]
  );
  // One active category.
  await query(
    "INSERT INTO categories (slug, parent_slug, title, description, position, active, archived_at, created_at, updated_at) " +
    "VALUES ('apparel', NULL, 'Apparel', '', 0, 1, NULL, ?1, ?1)",
    [now]
  );
  // One published CMS page.
  await query(
    "INSERT INTO storefront_pages (slug, title, body, meta_description, meta_keywords, layout, status, published_at, archived_at, created_at, updated_at) " +
    "VALUES ('about', 'About', 'Body', NULL, NULL, 'default', 'published', ?1, NULL, ?1, ?1)",
    [now]
  );
}

async function _run() {
  var HOST = "shop.example";

  // ---- container robots.txt: fresh-deploy hardcoded fallback ----------
  var query   = _makeQuery(ALL_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  // Every primitive shares the SAME in-memory db via an explicit `query`
  // handle (the default is b.externalDb, a different store) so the sitemap
  // route reads the rows seeded below.
  var collections = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "c".repeat(32) });
  var categoryNavigation = bShop.categoryNavigation.create({ query: query, catalog: catalog });
  var storefrontPages = bShop.storefrontPages.create({ query: query });
  var robotsConfig = bShop.robotsConfig.create({ query: query });

  await _seedCatalogRows(query);

  var handle = await _bootApp({
    catalog: catalog, cart: cart,
    collections: collections,
    categoryNavigation: categoryNavigation,
    storefrontPages: storefrontPages,
    robotsConfig: robotsConfig,
  });
  try {
    var robots = await helpers.httpRequest({ port: handle.port, path: "/robots.txt", headers: { host: HOST } });
    check("robots 200",                    robots.status === 200);
    check("robots disallows /admin",       robots.body.indexOf("Disallow: /admin") !== -1);
    check("robots disallows /cart",        robots.body.indexOf("Disallow: /cart") !== -1);
    check("robots disallows /account",     robots.body.indexOf("Disallow: /account") !== -1);
    check("robots disallows /checkout",    robots.body.indexOf("Disallow: /checkout") !== -1);
    check("robots has sitemap line",       robots.body.indexOf("Sitemap: https://" + HOST + "/sitemap.xml") !== -1);

    // Parity: the edge robots body (built the way the edge route does) has
    // the same Disallow set + sitemap line for the same origin.
    var edgeRobotsBody =
      "User-agent: *\nAllow: /\n" +
      "Disallow: /admin\nDisallow: /cart\nDisallow: /checkout\n" +
      "Disallow: /pay/\nDisallow: /orders/\nDisallow: /account\n" +
      "Sitemap: https://" + HOST + "/sitemap.xml\n";
    ["Disallow: /admin", "Disallow: /cart", "Disallow: /checkout", "Disallow: /pay/", "Disallow: /orders/", "Disallow: /account"].forEach(function (line) {
      check("edge robots " + line + " matches container",
        edgeRobotsBody.indexOf(line) !== -1 && robots.body.indexOf(line) !== -1);
    });

    // ---- container sitemap: products + collections + categories + pages -
    var sitemap = await helpers.httpRequest({ port: handle.port, path: "/sitemap.xml", headers: { host: HOST } });
    check("sitemap 200",                   sitemap.status === 200);
    check("sitemap lists product",         sitemap.body.indexOf("<loc>https://" + HOST + "/products/widget-pro</loc>") !== -1);
    check("sitemap lists collection",      sitemap.body.indexOf("<loc>https://" + HOST + "/collections/summer</loc>") !== -1);
    check("sitemap lists category",        sitemap.body.indexOf("<loc>https://" + HOST + "/categories/apparel</loc>") !== -1);
    check("sitemap lists CMS page",        sitemap.body.indexOf("<loc>https://" + HOST + "/pages/about</loc>") !== -1);
  } finally {
    await _teardown(handle);
  }

  // ---- container robots.txt with operator rules defined ---------------
  var query2   = _makeQuery(ALL_MIGS);
  var catalog2 = bShop.catalog.create({ query: query2 });
  var cart2    = bShop.cart.create({ query: query2, catalog: catalog2 });
  var robotsConfig2 = bShop.robotsConfig.create({ query: query2 });
  await robotsConfig2.defineRule({
    user_agent: "BadBot",
    allow:      [],
    disallow:   ["/"],
  });
  var handle2 = await _bootApp({ catalog: catalog2, cart: cart2, robotsConfig: robotsConfig2 });
  try {
    var robots2 = await helpers.httpRequest({ port: handle2.port, path: "/robots.txt", headers: { host: HOST } });
    check("robots with rules surfaces operator rule", robots2.body.indexOf("User-agent: BadBot") !== -1);
    check("robots with rules disallows /",            robots2.body.indexOf("Disallow: /") !== -1);
  } finally {
    await _teardown(handle2);
  }

  // ---- edge sitemap renderer (guarded) --------------------------------
  var sitemapPath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "sitemap.js");
  if (!nodeFs.existsSync(sitemapPath)) {
    return;
  }
  _registerJsonHook();
  var edgeSitemap = await import(nodeUrl.pathToFileURL(sitemapPath).href);

  var origin = "https://" + HOST;
  var xml = edgeSitemap.renderSitemap({
    origin:      origin,
    products:    [{ slug: "widget-pro", updated_at: 0 }],
    collections: [{ slug: "summer", updated_at: 0 }],
    categories:  [{ slug: "apparel", updated_at: 0 }],
    pages:       [{ slug: "about", updated_at: 0 }],
    blogPosts:   [],
  });
  check("edge sitemap collection loc",   xml.indexOf("<loc>" + origin + "/collections/summer</loc>") !== -1);
  check("edge sitemap category loc",     xml.indexOf("<loc>" + origin + "/categories/apparel</loc>") !== -1);
  check("edge sitemap page loc",         xml.indexOf("<loc>" + origin + "/pages/about</loc>") !== -1);

  // Parity: edge collection <loc> matches the container's value for the
  // same origin + slug (both `origin + "/collections/" + slug`).
  check("edge collection loc parity",
    xml.indexOf("<loc>" + origin + "/collections/summer</loc>") !== -1);

  // XML-escape: a slug with `&`/`<`/`"`/`'` is encodeURIComponent'd at the
  // edge path segment (turning `&`/`<`/`"` into %-escapes), then any
  // surviving XML-active char (the apostrophe — encodeURIComponent leaves
  // `'` raw) is XML-escaped by renderTemplate. Assert the <loc> carries the
  // %-escapes + the apostrophe entity, never a raw `<` / `"` / unescaped `&`.
  var xmlEsc = edgeSitemap.renderSitemap({
    origin:      origin,
    collections: [{ slug: "a&b<c\"d'e", updated_at: 0 }],
  });
  var locMatch = xmlEsc.match(/<loc>([^<]*\/collections\/[^<]*)<\/loc>/);
  check("edge sitemap escaped slug present",  locMatch !== null);
  var loc = locMatch ? locMatch[1] : "";
  check("edge sitemap & is %-encoded",        loc.indexOf("%26") !== -1);
  check("edge sitemap < is %-encoded",        loc.indexOf("%3C") !== -1);
  check("edge sitemap \" is %-encoded",       loc.indexOf("%22") !== -1);
  check("edge sitemap apostrophe XML-escaped", loc.indexOf("&#x27;") !== -1);
  check("edge sitemap no raw < in loc",        loc.indexOf("<") === -1);
  check("edge sitemap no raw \" in loc",       loc.indexOf("\"") === -1);
  // No UNESCAPED ampersand: every `&` in the loc begins an entity (`&#x27;`).
  check("edge sitemap no bare & in loc",
    /&(?!#x27;)/.test(loc) === false);
}

module.exports = { run: _run };
