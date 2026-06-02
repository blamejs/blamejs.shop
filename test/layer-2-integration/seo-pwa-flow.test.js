"use strict";
/**
 * PWA manifest + service worker (SEO-1).
 *
 * The storefront serves an installable web app manifest at
 * /manifest.webmanifest and a service worker at /sw.js. On a fresh deploy
 * (no operator pwaManifest row) both serve a shipped DEFAULT — so the
 * `<link rel="manifest">` every layout carries never 404s. When the
 * operator defines + activates a manifest, that overrides the default on
 * the container path. The edge serves the default bytes only (no DB-backed
 * primitive at the edge); the edge default is byte-identical to the
 * container default.
 *
 * Contracts:
 *   - GET /manifest.webmanifest → 200, application/manifest+json, parses to
 *     a valid manifest (name + start_url + ≥1 icon);
 *   - GET /sw.js → 200, text/javascript, non-empty JS (an addEventListener);
 *   - an active operator manifest row overrides the default;
 *   - every container + edge LAYOUT carries the manifest link;
 *   - the edge default manifest/sw bytes === the container default.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * pwaManifest primitive (migration 0168). The edge half loads behind an
 * `fs.existsSync` guard preceding the import. Network: zero (127.0.0.1).
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
  "0168_pwa_manifest.sql",
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-pwa-"));
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

async function _run() {
  var MANIFEST_LINK = "<link rel=\"manifest\" href=\"/manifest.webmanifest\">";

  // ---- fresh deploy: default manifest + sw serve ----------------------
  var query   = _makeQuery(ALL_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var pwaManifest = bShop.pwaManifest.create({ query: query, cursorSecret: "x".repeat(32) });

  var handle = await _bootApp({ catalog: catalog, cart: cart, pwaManifest: pwaManifest });
  var defaultManifestBody = null;
  var defaultSwBody = null;
  try {
    var man = await helpers.httpRequest({ port: handle.port, path: "/manifest.webmanifest" });
    check("manifest 200",                  man.status === 200);
    check("manifest content-type",         /application\/manifest\+json/.test(man.headers["content-type"] || ""));
    var parsed = JSON.parse(man.body);
    check("manifest has name",             typeof parsed.name === "string" && parsed.name.length > 0);
    check("manifest has start_url",        parsed.start_url === "/");
    check("manifest has ≥1 icon",          Array.isArray(parsed.icons) && parsed.icons.length >= 1);
    check("manifest icon has src+sizes+type",
      parsed.icons[0].src && parsed.icons[0].sizes && parsed.icons[0].type);
    defaultManifestBody = man.body;

    var sw = await helpers.httpRequest({ port: handle.port, path: "/sw.js" });
    check("sw 200",                        sw.status === 200);
    check("sw content-type js",            /text\/javascript/.test(sw.headers["content-type"] || ""));
    check("sw body is non-empty JS",       sw.body.indexOf("addEventListener") !== -1);
    defaultSwBody = sw.body;

    // The container LAYOUT carries the manifest link.
    var home = await helpers.httpRequest({ port: handle.port, path: "/" });
    check("container home carries manifest link", home.body.indexOf(MANIFEST_LINK) !== -1);
  } finally {
    await _teardown(handle);
  }

  // ---- operator override: an active manifest row reflects in the bytes -
  var query2   = _makeQuery(ALL_MIGS);
  var catalog2 = bShop.catalog.create({ query: query2 });
  var cart2    = bShop.cart.create({ query: query2, catalog: catalog2 });
  var pwa2     = bShop.pwaManifest.create({ query: query2, cursorSecret: "y".repeat(32) });
  var defn = await pwa2.defineManifest({
    name:        "Operator Custom App",
    short_name:  "OpCustom",
    description: "Operator override.",
    start_url:   "/",
    scope:       "/",
    display:     "standalone",
    orientation: "portrait",
    theme_color: "#123456",
    background_color: "#000000",
    icons: [{ src: "/assets/brand/favicon.png", sizes: "192x192", type: "image/png" }],
  });
  await pwa2.setActive(defn.version_number);

  var handle2 = await _bootApp({ catalog: catalog2, cart: cart2, pwaManifest: pwa2 });
  try {
    var man2 = await helpers.httpRequest({ port: handle2.port, path: "/manifest.webmanifest" });
    check("override manifest 200",         man2.status === 200);
    var parsed2 = JSON.parse(man2.body);
    check("override manifest reflects operator row", parsed2.name === "Operator Custom App");
    check("override manifest theme_color",  parsed2.theme_color === "#123456");
  } finally {
    await _teardown(handle2);
  }

  // ---- no pwaManifest dep wired: route still serves the default --------
  var query3   = _makeQuery(["0001_catalog.sql", "0002_cart.sql"]);
  var catalog3 = bShop.catalog.create({ query: query3 });
  var cart3    = bShop.cart.create({ query: query3, catalog: catalog3 });
  var handle3  = await _bootApp({ catalog: catalog3, cart: cart3 });
  try {
    var man3 = await helpers.httpRequest({ port: handle3.port, path: "/manifest.webmanifest" });
    check("no-dep manifest 200 (default)", man3.status === 200);
    check("no-dep manifest parses",        JSON.parse(man3.body).start_url === "/");
    var sw3 = await helpers.httpRequest({ port: handle3.port, path: "/sw.js" });
    check("no-dep sw 200 (default)",       sw3.status === 200);
  } finally {
    await _teardown(handle3);
  }

  // ---- edge half (worker/) — guarded by fs.existsSync -----------------
  var renderDir  = nodePath.resolve(__dirname, "..", "..", "worker", "render");
  var libPath    = nodePath.join(renderDir, "_lib.js");
  var homePath   = nodePath.join(renderDir, "home.js");
  var productPath = nodePath.join(renderDir, "product.js");
  var searchPath  = nodePath.join(renderDir, "search.js");
  var cartPath    = nodePath.join(renderDir, "cart.js");
  var blogPath    = nodePath.join(renderDir, "blog.js");
  var pagesPath   = nodePath.join(renderDir, "pages.js");
  var policyPath  = nodePath.join(renderDir, "policy.js");
  if (!nodeFs.existsSync(libPath) || !nodeFs.existsSync(homePath) ||
      !nodeFs.existsSync(productPath) || !nodeFs.existsSync(searchPath) ||
      !nodeFs.existsSync(cartPath) || !nodeFs.existsSync(blogPath) ||
      !nodeFs.existsSync(pagesPath) || !nodeFs.existsSync(policyPath)) {
    return;
  }
  _registerJsonHook();
  var edgeLib    = await import(nodeUrl.pathToFileURL(libPath).href);
  var edgeHome   = await import(nodeUrl.pathToFileURL(homePath).href);
  var edgeProduct = await import(nodeUrl.pathToFileURL(productPath).href);
  var edgeSearch  = await import(nodeUrl.pathToFileURL(searchPath).href);
  var edgeCart    = await import(nodeUrl.pathToFileURL(cartPath).href);
  var edgeBlog    = await import(nodeUrl.pathToFileURL(blogPath).href);
  var edgePages   = await import(nodeUrl.pathToFileURL(pagesPath).href);
  var edgePolicy  = await import(nodeUrl.pathToFileURL(policyPath).href);

  var manifestModule = require("../../lib/asset-manifest.json");

  // Default-bytes parity: the edge default manifest/sw === the container's.
  check("edge default manifest === container default",
    edgeLib.PWA_DEFAULT_MANIFEST === defaultManifestBody);
  check("edge default sw === container default",
    edgeLib.PWA_DEFAULT_SW === defaultSwBody);

  // Every edge LAYOUT carries the manifest link.
  var eHome = edgeHome.renderHome({ products: [], shopName: "Acme", version: manifestModule.version });
  check("edge home manifest link",       eHome.indexOf(MANIFEST_LINK) !== -1);
  var eProduct = edgeProduct.renderProduct({
    product:  { slug: "p", title: "P", description: "d" },
    variants: [{ id: "v1", sku: "S", title: "Default", options: {} }],
    prices:   { v1: { amount_minor: 100, currency: "USD" } },
    shopName: "Acme", version: manifestModule.version,
  });
  check("edge product manifest link",    eProduct.indexOf(MANIFEST_LINK) !== -1);
  var eSearch = edgeSearch.renderSearch({ q: "", products: [], facets: [], filters: {}, total: 0, shopName: "Acme", cartCount: 0, version: manifestModule.version });
  check("edge search manifest link",     eSearch.indexOf(MANIFEST_LINK) !== -1);
  var eCart = edgeCart.renderCart({ lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" }, productLookup: {}, shopName: "Acme", cartCount: 0, version: manifestModule.version });
  check("edge cart manifest link",       eCart.indexOf(MANIFEST_LINK) !== -1);
  var eBlog = edgeBlog.renderBlogList({ articles: [], shopName: "Acme", version: manifestModule.version });
  check("edge blog manifest link",       eBlog.indexOf(MANIFEST_LINK) !== -1);
  var ePage = edgePages.renderStorefrontPage({ page: { slug: "a", title: "A", body: "b", layout: "default", status: "published", updated_at: 0 }, shopName: "Acme", version: manifestModule.version });
  check("edge page manifest link",       ePage.indexOf(MANIFEST_LINK) !== -1);
  var ePolicy = edgePolicy.renderPrivacy({ shopName: "Acme", version: manifestModule.version });
  check("edge policy manifest link",     ePolicy.indexOf(MANIFEST_LINK) !== -1);
}

module.exports = { run: _run };
