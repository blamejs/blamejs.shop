"use strict";
/**
 * i18n / locale routing — full HTTP integration of the storefront's
 * localised UI chrome + the footer locale switcher.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * locale-router (cookie strategy) + the chrome i18n instance, against one
 * in-memory `node:sqlite` DB loaded from the live migrations (catalog +
 * cart + translations 0070 + locale-router 0139). Seeds two locales
 * (en, de), an active cookie-strategy policy, and one `ui`/`chrome`
 * override row for `de`. Exercises:
 *
 *   - default chrome (no cookie)            → English, <html lang="en">
 *   - the switcher persists a choice         → /locale sets shop_locale
 *   - chosen-locale chrome translates        → German override surfaces
 *   - untranslated key falls back            → default-locale string,
 *                                              never a raw {{key}}
 *   - unknown locale code                    → default locale
 *   - garbage cookie                         → default locale (no 500)
 *   - <html lang> reflects the locale
 *   - the switcher form is server-rendered (works with JS off)
 *
 * A second boot WITHOUT the translations table proves missing-table
 * resilience (the chrome falls back to the English baseline rather than
 * 500-ing). An edge↔container chrome-resolution parity assertion pins the
 * worker mirror to the lib resolution — guarded so it's skipped when the
 * worker module isn't present in the container build context.
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-i18n-"));
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

// Build the storefront's i18n deps the same way server.js does: the
// active-policy supported list + the chrome overrides → a chrome i18n
// instance + the locale options.
async function _localeDeps(query) {
  var localeRouter = bShop.localeRouter.create({ query: query });
  await localeRouter.defineLocale({ tag: "en", kind: "primary", currency: "USD", active: true });
  await localeRouter.defineLocale({ tag: "de", kind: "primary", currency: "EUR", active: true });
  await localeRouter.definePolicy({
    slug:              "main",
    strategy:          "cookie",
    default_locale:    "en",
    supported_locales: ["en", "de"],
  });
  await localeRouter.setActivePolicy("main");

  // One operator chrome override: translate the nav "Shop" label to
  // German. Every other chrome key stays untranslated for `de`, so the
  // page exercises the default-locale fallback path.
  var translations = bShop.translations.create({ query: query });
  await translations.setTranslation({
    resource_kind: "ui",
    resource_id:   "chrome",
    locale:        "de",
    field:         "nav_shop",
    value:         "Laden",
  });

  var supported = ["en", "de"];
  var overrides = await bShop.translations.readChromeOverrides(query, supported);
  var chromeI18n = bShop.translations.createChromeI18n({
    defaultLocale: "en",
    locales:       supported,
    overrides:     overrides,
  });
  return {
    localeRouter:  localeRouter,
    chromeI18n:    chromeI18n,
    localeOptions: {
      defaultLocale: "en",
      locales: [{ tag: "en", label: "English" }, { tag: "de", label: "Deutsch" }],
    },
  };
}

async function _run() {
  // ---- primary boot: full i18n wired ----------------------------------
  var query   = _makeQuery(ALL_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var locale  = await _localeDeps(query);

  var handle = await _bootApp({
    catalog:       catalog,
    cart:          cart,
    chromeI18n:    locale.chromeI18n,
    localeRouter:  locale.localeRouter,
    localeOptions: locale.localeOptions,
  });

  try {
    // 1. No cookie → default (English) chrome + <html lang="en">.
    var home = await helpers.httpRequest({ port: handle.port, path: "/" });
    check("home 200",                         home.status === 200);
    check("default html lang en",             home.body.indexOf("<html lang=\"en\" dir=\"ltr\">") !== -1);
    check("default nav Shop (en)",            home.body.indexOf(">Shop</a>") !== -1);
    check("default footer All products (en)", home.body.indexOf(">All products</a>") !== -1);
    check("no raw chrome placeholder",        home.body.indexOf("{{nav_shop}}") === -1);

    // The switcher form is server-rendered (works with JS off) and lists
    // both active locales.
    check("switcher form present",            home.body.indexOf("class=\"locale-switcher\"") !== -1);
    check("switcher is a GET form",           home.body.indexOf("<form class=\"locale-switcher\" method=\"get\" action=\"/locale\">") !== -1);
    check("switcher lists English",           home.body.indexOf(">English</option>") !== -1);
    check("switcher lists Deutsch",           home.body.indexOf(">Deutsch</option>") !== -1);

    // 2. The switcher persists a choice: /locale sets the shop_locale
    //    cookie + 303-redirects back to `to`.
    var jar = helpers.cookieJar();
    var setRes = await helpers.httpRequest({ port: handle.port, path: "/locale?lang=de&to=%2F", jar: jar });
    check("/locale 303",                      setRes.status === 303);
    check("/locale redirects to /",           setRes.headers.location === "/");
    check("/locale set shop_locale=de",       jar.get("shop_locale") === "de");

    // 3. Chosen-locale chrome translates; untranslated keys fall back to
    //    the default-locale string (never a raw key); <html lang> reflects
    //    the chosen locale.
    var de = await helpers.httpRequest({ port: handle.port, path: "/", jar: jar });
    check("de home 200",                      de.status === 200);
    check("de html lang de",                  de.body.indexOf("<html lang=\"de\" dir=\"ltr\">") !== -1);
    check("de nav override (Laden)",          de.body.indexOf(">Laden</a>") !== -1);
    check("de nav Shop replaced",             de.body.indexOf(">Shop</a>") === -1);
    check("de untranslated falls back (Framework)", de.body.indexOf(">Framework</a>") !== -1);
    check("de footer fallback (All products)", de.body.indexOf(">All products</a>") !== -1);
    check("de no raw placeholder",            de.body.indexOf("{{") === -1 || de.body.indexOf("{{nav_") === -1);
    check("de switcher de selected",          de.body.indexOf("value=\"de\" selected>") !== -1);

    // 4. Unknown locale code → default locale.
    var unkJar = helpers.cookieJar();
    await helpers.httpRequest({ port: handle.port, path: "/locale?lang=zz&to=%2F", jar: unkJar });
    check("/locale ignored unknown lang",     unkJar.get("shop_locale") === null);
    // Forge an unknown-locale cookie directly to prove the resolver
    // drops it to the default.
    var unknown = await helpers.httpRequest({
      port: handle.port, path: "/",
      headers: { cookie: "shop_locale=zz" },
    });
    check("unknown cookie → default (en)",    unknown.body.indexOf("<html lang=\"en\" dir=\"ltr\">") !== -1);
    check("unknown cookie nav Shop (en)",     unknown.body.indexOf(">Shop</a>") !== -1);

    // 5. Garbage cookie → default locale, no 500.
    var garbage = await helpers.httpRequest({
      port: handle.port, path: "/",
      headers: { cookie: "shop_locale=" + encodeURIComponent("not a locale!!") },
    });
    check("garbage cookie 200 (no 500)",      garbage.status === 200);
    check("garbage cookie → default (en)",    garbage.body.indexOf("<html lang=\"en\" dir=\"ltr\">") !== -1);

    // 6. Open-redirect guard on the switcher: an absolute / protocol-
    //    relative `to` falls back to "/".
    var openRedir = await helpers.httpRequest({ port: handle.port, path: "/locale?lang=en&to=https%3A%2F%2Fevil.example" });
    check("open-redirect refused → /",        openRedir.status === 303 && openRedir.headers.location === "/");
    var protoRel = await helpers.httpRequest({ port: handle.port, path: "/locale?lang=en&to=%2F%2Fevil.example" });
    check("protocol-relative refused → /",    protoRel.status === 303 && protoRel.headers.location === "/");
    var sameOrigin = await helpers.httpRequest({ port: handle.port, path: "/locale?lang=en&to=%2Fcart" });
    check("same-origin path honoured",        sameOrigin.status === 303 && sameOrigin.headers.location === "/cart");
  } finally {
    await _teardown(handle);
  }

  // ---- missing-table resilience: no translations / locale tables ------
  // Boot with only catalog + cart migrations and NO locale deps wired —
  // the storefront must render the English baseline rather than 500.
  var bareQuery   = _makeQuery(["0001_catalog.sql", "0002_cart.sql"]);
  var bareCatalog = bShop.catalog.create({ query: bareQuery });
  var bareCart    = bShop.cart.create({ query: bareQuery, catalog: bareCatalog });
  var bareHandle  = await _bootApp({ catalog: bareCatalog, cart: bareCart });
  try {
    var bare = await helpers.httpRequest({ port: bareHandle.port, path: "/" });
    check("no-i18n boot home 200",            bare.status === 200);
    check("no-i18n English baseline",         bare.body.indexOf("<html lang=\"en\" dir=\"ltr\">") !== -1);
    check("no-i18n nav Shop",                 bare.body.indexOf(">Shop</a>") !== -1);
    check("no-i18n no switcher (single locale)", bare.body.indexOf("class=\"locale-switcher\"") === -1);
    check("no-i18n no raw placeholder",       bare.body.indexOf("{{nav_shop}}") === -1);
  } finally {
    await _teardown(bareHandle);
  }

  // ---- edge ↔ container chrome-resolution parity ----------------------
  // The Worker mirrors the chrome catalog + resolution in pure ESM. Pin
  // its output to the lib's `resolveChrome` so the two never drift. The
  // worker module lives under worker/ which is excluded from the
  // container build context — guard the import so the in-image smoke
  // (no worker/ present) skips this block rather than failing.
  var edgeModPath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "chrome-i18n.js");
  if (nodeFs.existsSync(edgeModPath)) {
    var edge = await import("file://" + edgeModPath.replace(/\\/g, "/"));
    var overrides = { de: { nav_shop: "Laden" } };
    var libI18n = bShop.translations.createChromeI18n({ defaultLocale: "en", locales: ["en", "de"], overrides: overrides });

    // Catalogs match byte-for-byte.
    var libDefaults  = bShop.translations.CHROME_DEFAULTS;
    var edgeDefaults = edge.CHROME_DEFAULTS;
    var defKeys = Object.keys(libDefaults);
    var catalogMatch = Object.keys(edgeDefaults).length === defKeys.length &&
      defKeys.every(function (k) { return libDefaults[k] === edgeDefaults[k]; });
    check("edge/container catalog identical", catalogMatch);

    // resolveChrome agrees across several locales + the subtag-strip path.
    ["en", "de", "de-AT", "fr"].forEach(function (loc) {
      var libOut  = bShop.translations.resolveChrome(libI18n, loc);
      var edgeOut = edge.resolveChrome(loc, { defaultLocale: "en", overrides: overrides });
      var mism = Object.keys(libOut).filter(function (k) { return libOut[k] !== edgeOut[k]; });
      check("edge/container parity " + loc,   mism.length === 0);
    });
  }

}

module.exports = { run: _run };
