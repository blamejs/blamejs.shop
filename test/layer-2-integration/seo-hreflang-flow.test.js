"use strict";
/**
 * hreflang alternate links (SEO-4).
 *
 * When an active URL-shaped locale policy (`url_prefix` / `subdomain`)
 * exists, every storefront layout emits a
 * `<link rel="alternate" hreflang="…" href="…">` block (one per supported
 * locale) plus an `hreflang="x-default"` link. The block is byte-identical
 * across substrates (container `lib/storefront.js` + the edge
 * `worker/render/chrome-i18n.js#alternateLinks`) — a parity gate keeps the
 * two from drifting. A single-locale store, or a cookie / accept-language
 * (non-URL) strategy, emits NO hreflang block.
 *
 * Boots a real `b.createApp` server with the storefront wired with a
 * `url_prefix` policy. The edge `alternateLinks` parity is asserted behind
 * an `fs.existsSync` guard preceding the import. Network: zero.
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
  "0070_translations.sql",
  "0139_locale_router.sql",
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-hreflang-"));
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

// Build the storefront i18n deps for a given strategy.
async function _localeDeps(query, strategy) {
  var localeRouter = bShop.localeRouter.create({ query: query });
  await localeRouter.defineLocale({ tag: "en", kind: "primary", currency: "USD", active: true });
  await localeRouter.defineLocale({ tag: "de", kind: "primary", currency: "EUR", active: true });
  await localeRouter.defineLocale({ tag: "fr", kind: "primary", currency: "EUR", active: true });
  await localeRouter.definePolicy({
    slug:              "main",
    strategy:          strategy,
    default_locale:    "en",
    supported_locales: ["en", "de", "fr"],
  });
  await localeRouter.setActivePolicy("main");

  var supported = ["en", "de", "fr"];
  var overrides = await bShop.translations.readChromeOverrides(query, supported);
  var chromeI18n = bShop.translations.createChromeI18n({
    defaultLocale: "en", locales: supported, overrides: overrides,
  });
  return {
    localeRouter:  localeRouter,
    chromeI18n:    chromeI18n,
    localeOptions: {
      defaultLocale: "en",
      locales: [{ tag: "en", label: "English" }, { tag: "de", label: "Deutsch" }, { tag: "fr", label: "Français" }],
      strategy: strategy,
    },
  };
}

// Pull the hreflang block (the contiguous run of alternate links) out of a
// document's <head>.
function _hreflangLines(html) {
  var lines = html.split("\n").filter(function (l) {
    return l.indexOf("rel=\"alternate\" hreflang=") !== -1;
  });
  return lines.map(function (l) { return l.trim(); });
}

async function _run() {
  var HOST = "127.0.0.1";

  // ---- url_prefix policy: hreflang block emitted ----------------------
  var query   = _makeQuery(ALL_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var locale  = await _localeDeps(query, "url_prefix");
  var handle  = await _bootApp({
    catalog: catalog, cart: cart,
    chromeI18n: locale.chromeI18n,
    localeRouter: locale.localeRouter,
    localeOptions: locale.localeOptions,
  });
  var containerHreflang = null;
  try {
    var home = await helpers.httpRequest({ port: handle.port, path: "/", headers: { host: HOST } });
    check("home 200", home.status === 200);
    // Three supported locales + x-default.
    check("hreflang en present",
      home.body.indexOf("<link rel=\"alternate\" hreflang=\"en\" href=\"https://" + HOST + "/en\">") !== -1);
    check("hreflang de present",
      home.body.indexOf("<link rel=\"alternate\" hreflang=\"de\" href=\"https://" + HOST + "/de\">") !== -1);
    check("hreflang fr present",
      home.body.indexOf("<link rel=\"alternate\" hreflang=\"fr\" href=\"https://" + HOST + "/fr\">") !== -1);
    check("hreflang x-default present",
      home.body.indexOf("<link rel=\"alternate\" hreflang=\"x-default\" href=\"https://" + HOST + "/en\">") !== -1);
    containerHreflang = _hreflangLines(home.body);
    check("container hreflang has 4 entries", containerHreflang.length === 4);
  } finally {
    await _teardown(handle);
  }

  // ---- cookie policy: NO hreflang block -------------------------------
  var queryC   = _makeQuery(ALL_MIGS);
  var catalogC = bShop.catalog.create({ query: queryC });
  var cartC    = bShop.cart.create({ query: queryC, catalog: catalogC });
  var localeC  = await _localeDeps(queryC, "cookie");
  var handleC  = await _bootApp({
    catalog: catalogC, cart: cartC,
    chromeI18n: localeC.chromeI18n,
    localeRouter: localeC.localeRouter,
    localeOptions: localeC.localeOptions,
  });
  try {
    var homeC = await helpers.httpRequest({ port: handleC.port, path: "/", headers: { host: HOST } });
    check("cookie strategy 200", homeC.status === 200);
    check("cookie strategy emits NO hreflang",
      homeC.body.indexOf("rel=\"alternate\" hreflang=") === -1);
  } finally {
    await _teardown(handleC);
  }

  // ---- no locale policy: NO hreflang block ----------------------------
  var queryN   = _makeQuery(["0001_catalog.sql", "0002_cart.sql"]);
  var catalogN = bShop.catalog.create({ query: queryN });
  var cartN    = bShop.cart.create({ query: queryN, catalog: catalogN });
  var handleN  = await _bootApp({ catalog: catalogN, cart: cartN });
  try {
    var homeN = await helpers.httpRequest({ port: handleN.port, path: "/", headers: { host: HOST } });
    check("no-policy 200", homeN.status === 200);
    check("no-policy emits NO hreflang",
      homeN.body.indexOf("rel=\"alternate\" hreflang=") === -1);
  } finally {
    await _teardown(handleN);
  }

  // ---- edge ↔ container parity (guarded) ------------------------------
  var chromePath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "chrome-i18n.js");
  if (!nodeFs.existsSync(chromePath)) {
    return;
  }
  _registerJsonHook();
  var edgeChrome = await import(nodeUrl.pathToFileURL(chromePath).href);

  // The edge `alternateLinks` output for the same (host, path, supported,
  // default, strategy) must byte-match what the container emitted on the
  // home page ("/").
  var edgeBlock = edgeChrome.alternateLinks({
    host:             HOST,
    path:             "/",
    defaultLocale:    "en",
    supportedLocales: ["en", "de", "fr"],
    strategy:         "url_prefix",
  });
  var edgeLines = edgeBlock.split("\n").filter(function (l) {
    return l.indexOf("rel=\"alternate\" hreflang=") !== -1;
  }).map(function (l) { return l.trim(); });
  check("edge hreflang has 4 entries", edgeLines.length === 4);
  check("edge ↔ container hreflang byte-identical",
    JSON.stringify(edgeLines) === JSON.stringify(containerHreflang));

  // Edge subdomain strategy.
  var edgeSub = edgeChrome.alternateLinks({
    host:             "de.shop.example",
    path:             "/about",
    defaultLocale:    "en",
    supportedLocales: ["en", "de"],
    strategy:         "subdomain",
  });
  check("edge subdomain en host swap",
    edgeSub.indexOf("hreflang=\"en\" href=\"https://en.shop.example/about\"") !== -1);
  check("edge subdomain de host swap",
    edgeSub.indexOf("hreflang=\"de\" href=\"https://de.shop.example/about\"") !== -1);

  // Edge negatives.
  check("edge cookie strategy → empty",
    edgeChrome.alternateLinks({ host: "shop.example", path: "/", defaultLocale: "en", supportedLocales: ["en", "de"], strategy: "cookie" }) === "");
  check("edge single-locale → empty",
    edgeChrome.alternateLinks({ host: "shop.example", path: "/", defaultLocale: "en", supportedLocales: ["en"], strategy: "url_prefix" }) === "");
  check("edge malformed host → empty",
    edgeChrome.alternateLinks({ host: "not a host!!", path: "/", defaultLocale: "en", supportedLocales: ["en", "de"], strategy: "url_prefix" }) === "");
}

module.exports = { run: _run };
