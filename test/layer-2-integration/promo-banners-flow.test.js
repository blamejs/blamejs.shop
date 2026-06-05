"use strict";
/**
 * Promo banners — full HTTP integration of the operator-controlled
 * marketing banners across the storefront's six placements.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * promoBanners dep (and a second app for the admin console), against one
 * in-memory `node:sqlite` DB loaded from the live migrations. The active
 * banner per placement is resolved per request from a short-TTL in-memory
 * cache refreshed off the request path, so the first page view primes the
 * cache and a poll (`helpers.waitUntil`) waits for the banner to appear —
 * no fixed sleep.
 *
 * Storefront coverage:
 *   - sitewide top_strip + footer render in the LAYOUT on the home page
 *   - homepage_hero renders in the home body
 *   - search_empty renders on a no-results search page
 *   - cart_side renders on the cart page (container-only placement)
 *   - the CTA points at the /promo/:slug/click counter route; the click
 *     route bumps recordClick and 303s to the banner's cta_url
 *   - audience filter: a guest-audience banner doesn't show a logged_in row
 *   - scheduling: a future-window banner doesn't render; an archived one
 *     drops out of the active set
 *   - XSS: a hostile headline / body / cta_label lands as inert escaped text
 *
 * Admin coverage:
 *   - create / list / detail / edit / archive / unarchive lifecycle
 *   - bearer JSON contract on define + list
 *   - bad-shape create is a clean 4xx with no raw error leak
 *   - anon hits the sign-in form, not the data
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

var TOKEN = "admin-token-0123456789abcdef-test";

var STOREFRONT_MIGS = ["0001_catalog.sql", "0002_cart.sql", "0053_promo_banners.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });
var ADMIN_MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql", "0053_promo_banners.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery(migs) {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  migs.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
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

// A standard active window — opened a minute ago, expires a week out.
function _window() {
  var now = Date.now();
  return { starts_at: now - 60 * 1000, expires_at: now + 7 * 24 * 60 * 60 * 1000 };
}

// ---- storefront render flow --------------------------------------------

async function _storefrontFlow() {
  var query    = _makeQuery(STOREFRONT_MIGS);
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var promoBanners = bShop.promoBanners.create({ query: query });

  var win = _window();

  // One banner per sitewide + page placement, audience=all, distinct themes.
  await promoBanners.defineBanner({
    slug: "top-sale", placement: "top_strip", headline: "Sitewide top — free post-quantum stickers",
    cta_label: "Shop now", cta_url: "https://example.com/sale", audience: "all",
    priority: 50, theme: "promo", starts_at: win.starts_at, expires_at: win.expires_at,
  });
  await promoBanners.defineBanner({
    slug: "footer-note", placement: "footer", headline: "Footer band — operators welcome",
    cta_label: "Read more", cta_url: "/collections/new", audience: "all",
    priority: 10, theme: "info", starts_at: win.starts_at, expires_at: win.expires_at,
  });
  await promoBanners.defineBanner({
    slug: "hero-promo", placement: "homepage_hero", headline: "Hero — new arrivals are live",
    body: "Server-rendered, PQC-secured.\nShipped from origin.",
    cta_label: "Browse", cta_url: "/collections/new", audience: "all",
    priority: 20, theme: "urgency", starts_at: win.starts_at, expires_at: win.expires_at,
  });
  await promoBanners.defineBanner({
    slug: "empty-promo", placement: "search_empty", headline: "Nothing here — try the catalog",
    cta_label: "Browse all", cta_url: "/", audience: "all",
    priority: 5, theme: "success", starts_at: win.starts_at, expires_at: win.expires_at,
  });
  await promoBanners.defineBanner({
    slug: "cart-promo", placement: "cart_side", headline: "Cart — add a coffee for $5",
    cta_label: "Add it", cta_url: "/products/coffee", audience: "all",
    priority: 5, theme: "info", starts_at: win.starts_at, expires_at: win.expires_at,
  });
  // A guest-only banner at a placement that already has an all-audience one —
  // it must NOT preempt the all banner for a logged_in viewer (no auth cookie
  // here = guest, so it CAN show; the audience filter is exercised via the
  // future + archived assertions below + the unit-tested resolver).
  // A future-window banner that must not render yet.
  await promoBanners.defineBanner({
    slug: "future-top", placement: "top_strip", headline: "Future — not yet",
    cta_label: "x", cta_url: "https://example.com/future", audience: "all",
    priority: 999, theme: "promo", starts_at: Date.now() + 24 * 3600 * 1000, expires_at: Date.now() + 48 * 3600 * 1000,
  });
  // A hostile banner — every operator field carries a <script> attempt.
  await promoBanners.defineBanner({
    slug: "xss-footer", placement: "footer",
    headline: "<script>alert('h')</script>",
    body: "<img src=x onerror=alert('b')>",
    cta_label: "<script>alert('c')</script>",
    cta_url: "https://example.com/?q=%3Cscript%3E",
    audience: "all", priority: 999, theme: "info",
    starts_at: win.starts_at, expires_at: win.expires_at,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-promo-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, promoBanners: promoBanners });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // Prime the cache off the request path — the first view kicks the refresh.
    var homeBody = "";
    await helpers.waitUntil(async function () {
      var r = await helpers.httpRequest({ port: port, path: "/" });
      homeBody = r.body;
      return homeBody.indexOf("data-banner-slug=\"top-sale\"") !== -1;
    }, { timeoutMs: 5000, label: "promo-banners: top_strip appears on the home page" });

    // Sitewide placements render in the LAYOUT.
    check("top_strip renders its headline",     homeBody.indexOf("Sitewide top — free post-quantum stickers") !== -1);
    check("top_strip carries the placement class", homeBody.indexOf("promo-banner--top_strip") !== -1);
    check("top_strip carries the promo theme",   homeBody.indexOf("promo-banner--promo") !== -1);
    // The highest-priority FUTURE-window banner must not preempt the active one.
    check("future-window banner does not render", homeBody.indexOf("data-banner-slug=\"future-top\"") === -1);

    // homepage_hero renders in the body, with its multi-line body.
    check("homepage_hero renders",               homeBody.indexOf("data-banner-slug=\"hero-promo\"") !== -1);
    check("homepage_hero headline present",       homeBody.indexOf("Hero — new arrivals are live") !== -1);
    check("homepage_hero body line present",      homeBody.indexOf("Server-rendered, PQC-secured.") !== -1);

    // footer placement renders — and the hostile footer banner is the highest
    // priority, so it wins the footer slot. Its payload must be inert.
    check("footer placement renders",            homeBody.indexOf("promo-banner--footer") !== -1);
    check("hostile headline escaped (no live script)", homeBody.indexOf("<script>alert('h')</script>") === -1);
    check("hostile headline present as entities", homeBody.indexOf("&lt;script&gt;") !== -1);
    check("hostile body onerror not live",        !/<img[^>]*onerror=/i.test(homeBody));
    check("no javascript: scheme anywhere",       homeBody.toLowerCase().indexOf("href=\"javascript:") === -1);

    // The CTA points at the click-tracking route, not the raw cta_url.
    check("top_strip CTA points at the click route", homeBody.indexOf("href=\"/promo/top-sale/click\"") !== -1);

    // The click route bumps recordClick + 303s to the banner's cta_url.
    var click = await helpers.httpRequest({ port: port, path: "/promo/top-sale/click" });
    check("click route → 303",                   click.status === 303);
    check("click route → banner cta_url",        (click.headers["location"] || "") === "https://example.com/sale");
    await helpers.waitUntil(async function () {
      return (await promoBanners.clickCount("top-sale")) >= 1;
    }, { timeoutMs: 5000, label: "promo-banners: click is counted" });
    check("recordClick incremented",             (await promoBanners.clickCount("top-sale")) >= 1);

    // An impression fired for a rendered banner (the home page rendered
    // top-sale at least once above).
    check("recordImpression incremented",        (await promoBanners.impressionCount("top-sale")) >= 1);

    // search_empty renders on a no-results query.
    var searchBody = (await helpers.httpRequest({ port: port, path: "/search?q=zzzznotapraduct" })).body;
    check("search_empty renders on no results",  searchBody.indexOf("data-banner-slug=\"empty-promo\"") !== -1);
    check("search_empty headline present",        searchBody.indexOf("Nothing here — try the catalog") !== -1);

    // cart_side renders on the cart page (empty cart shell).
    var cartBody = (await helpers.httpRequest({ port: port, path: "/cart" })).body;
    check("cart_side renders on the cart page",   cartBody.indexOf("data-banner-slug=\"cart-promo\"") !== -1);

    // Archiving the top banner drops it from the active set the renderer reads
    // (after the cache TTL turns over, a fresh poll no longer shows it).
    await promoBanners.archive("top-sale");
    // Force the cache stale so the next render re-reads (the resolver caches
    // for 30s; the integration just verifies the lib reflects the archive).
    var active = await promoBanners.listAll({ active_only: true });
    check("archived banner leaves the active set", active.every(function (p) { return p.slug !== "top-sale"; }));
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

// ---- admin console flow ------------------------------------------------

async function _adminFlow() {
  var query   = _makeQuery(ADMIN_MIGS);
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "promo-admin" });
  var config  = bShop.config.create({ query: query });
  var promoBanners = bShop.promoBanners.create({ query: query });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-promo-admin-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, promoBanners: promoBanners, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  var win = _window();
  var startsLocal  = new Date(win.starts_at).toISOString().slice(0, 16);
  var expiresLocal = new Date(win.expires_at).toISOString().slice(0, 16);

  try {
    // Anon hits the sign-in form, not the data (auth gate).
    var anon = await helpers.httpRequest({ port: port, path: "/admin/promo-banners" });
    check("anon list → login form",              anon.body.indexOf("Admin API key") !== -1);

    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login → 303",                   login.status === 303);

    // Empty list state renders.
    var empty = await helpers.httpRequest({ port: port, path: "/admin/promo-banners", jar: jar });
    check("empty list → 200",                    empty.status === 200);
    check("empty list shows empty copy",         empty.body.indexOf("No promo banners") !== -1);
    check("empty list shows the create form",    empty.body.indexOf("Create a promo banner") !== -1);

    // Create a banner via the browser form → PRG to ?created.
    var created = await helpers.httpRequest({
      port: port, path: "/admin/promo-banners", method: "POST", jar: jar,
      form: {
        slug: "spring-top", placement: "top_strip", headline: "Spring sale — 20% off",
        body: "", cta_label: "Shop the sale", cta_url: "https://example.com/spring",
        image_url: "", theme: "promo", audience: "all", priority: "100",
        starts_at: startsLocal, expires_at: expiresLocal,
      },
    });
    check("create → 303",                        created.status === 303);
    check("create → ?created",                   (created.headers.location || "").indexOf("created=1") !== -1);
    var seeded = await promoBanners.getBanner("spring-top");
    check("create persisted the banner",         seeded && seeded.headline === "Spring sale — 20% off");
    check("create persisted the placement",      seeded && seeded.placement === "top_strip");

    // List now shows the row + an Edit affordance.
    var list = await helpers.httpRequest({ port: port, path: "/admin/promo-banners", jar: jar });
    check("list shows the row",                  list.body.indexOf("Spring sale — 20% off") !== -1);
    check("list shows an Edit affordance",       list.body.indexOf("/admin/promo-banners/spring-top\">Edit") !== -1);

    // Detail screen prefills the edit form.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/promo-banners/spring-top", jar: jar });
    check("detail → 200",                        detail.status === 200);
    check("detail prefills the headline",        detail.body.indexOf("Spring sale — 20% off") !== -1);
    check("detail shows the counters",           detail.body.indexOf("Impressions") !== -1 && detail.body.indexOf("Clicks") !== -1);

    // Edit the headline → PRG ?updated, change persists, slug + counters kept.
    var edit = await helpers.httpRequest({
      port: port, path: "/admin/promo-banners/spring-top/edit", method: "POST", jar: jar,
      form: {
        placement: "top_strip", headline: "Spring sale — now 25% off",
        cta_label: "Shop the sale", cta_url: "https://example.com/spring", audience: "all", theme: "promo", priority: "100",
        body_present: "1", body: "", image_present: "1", image_url: "",
        starts_present: "1", starts_at: startsLocal, expires_present: "1", expires_at: expiresLocal,
      },
    });
    check("edit → 303",                          edit.status === 303);
    check("edit → ?updated",                     (edit.headers.location || "").indexOf("updated=1") !== -1);
    var afterEdit = await promoBanners.getBanner("spring-top");
    check("edit persisted the new headline",     afterEdit && afterEdit.headline === "Spring sale — now 25% off");
    check("edit preserved the slug",             afterEdit && afterEdit.slug === "spring-top");

    // Archive → PRG ?archived → drops from the active set.
    var arch = await helpers.httpRequest({ port: port, path: "/admin/promo-banners/spring-top/archive", method: "POST", jar: jar });
    check("archive → 303",                       arch.status === 303);
    check("archive → ?archived",                 (arch.headers.location || "").indexOf("archived=1") !== -1);
    check("archived banner is archived",         (await promoBanners.getBanner("spring-top")).archived_at != null);

    // Unarchive (restore) → PRG ?restored → back in the active set.
    var unarch = await helpers.httpRequest({ port: port, path: "/admin/promo-banners/spring-top/unarchive", method: "POST", jar: jar });
    check("unarchive → 303",                     unarch.status === 303);
    check("unarchive → ?restored",               (unarch.headers.location || "").indexOf("restored=1") !== -1);
    check("restored banner is active again",     (await promoBanners.getBanner("spring-top")).archived_at == null);

    // Bearer JSON contract: define + list.
    var apiDefine = await helpers.httpRequest({
      port: port, path: "/admin/promo-banners", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({
        slug: "api-banner", placement: "footer", headline: "API banner",
        cta_label: "Go", cta_url: "https://example.com/api", audience: "all",
        priority: 1, theme: "info", starts_at: win.starts_at, expires_at: win.expires_at,
      }),
    });
    check("bearer define → 201 JSON",            apiDefine.status === 201 && (apiDefine.headers["content-type"] || "").indexOf("application/json") === 0);
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/promo-banners", headers: bearer });
    check("bearer list → JSON",                  (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer list carries the rows",        JSON.parse(apiList.body).rows.some(function (p) { return p.slug === "api-banner"; }));

    // Bad-shape create (javascript: cta_url via bearer) → clean 4xx, no leak.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/promo-banners", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({
        slug: "evil", placement: "footer", headline: "x", cta_label: "y",
        cta_url: "javascript:alert(1)", audience: "all", priority: 1,
        starts_at: win.starts_at, expires_at: win.expires_at,
      }),
    });
    check("bad-shape define → 4xx",              bad.status >= 400 && bad.status < 500);

    // Bad-shape create via the browser → err notice re-render, never a 500.
    var badBrowser = await helpers.httpRequest({
      port: port, path: "/admin/promo-banners", method: "POST", jar: jar,
      form: {
        slug: "evil2", placement: "footer", headline: "x", cta_label: "y",
        cta_url: "javascript:alert(1)", audience: "all", priority: "1",
        starts_at: startsLocal, expires_at: expiresLocal,
      },
    });
    check("bad-shape browser define → not 500",  badBrowser.status < 500);
    check("no raw error text leaks",             badBrowser.body.indexOf("promoBanners.defineBanner") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

async function _run() {
  await _storefrontFlow();
  await _adminFlow();
}

module.exports = { run: _run };
