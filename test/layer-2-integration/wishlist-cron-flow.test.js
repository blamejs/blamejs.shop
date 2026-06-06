"use strict";
/**
 * Wishlist alert + digest opt-in + magic-link sign-in — HTTP integration
 * of the customer-facing surfaces these crons compose.
 *
 * Boots one real `b.createApp` storefront against an in-memory
 * `node:sqlite` DB loaded from the live wishlist / alerts / digest /
 * customer-portal migrations, wires the SAME primitives server.js
 * constructs (with a recording stub mailer so the toggles + the
 * magic-link surface render), and exercises:
 *
 *   - /account/wishlist renders the alert + digest opt-in panel when the
 *     alerts/digest primitives are wired;
 *   - POST /account/wishlist/alerts round-trips the per-trigger opt-out
 *     (the toggle reflects the new state on the next GET);
 *   - POST /account/wishlist/digest enrolls + pauses a digest schedule;
 *   - an unauthenticated toggle POST is bounced to login (303), never a
 *     200 acting on another customer;
 *   - the magic-link surface: GET /account/login/link renders the email
 *     form, POST always returns the enumeration-safe confirmation, the
 *     minted token redeems ONCE into the sealed auth cookie, and a reused
 *     / unknown token bounces to login;
 *   - INERT contract: a storefront with NO alerts/digest/portal deps (the
 *     stock CI / no-mailer boot) renders NO opt-in panel and NO magic-link
 *     entry — the surfaces simply don't mount.
 *
 * Network: zero — every request lands on 127.0.0.1. No setTimeout sleeps.
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

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0006_customers.sql",
  "0012_wishlist.sql",
  "0072_customer_portal_sessions.sql",
  "0156_wishlist_alerts.sql",
  "0214_wishlist_alert_state.sql",
  "0198_wishlist_digest.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

// Recording stub mailer matching b.mail.create()'s .send() shape — used
// to build the SAME bShop.email instance server.js wires, so the alerts /
// digest / portal surfaces light up without a real SMTP server.
function _stubEmailHandle() {
  var sent = [];
  var mailer = { send: async function (msg) { sent.push(msg); return { ok: true, id: "msg_" + sent.length }; } };
  return { sent: sent, email: bShop.email.create({ mailer: mailer, from: "shop@example.com" }) };
}

async function _bootStorefront(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-wlcron-sf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
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

function _noLeak(body) {
  return body.indexOf("at Object.") === -1 && body.indexOf("    at ") === -1;
}

// ---- configured-mailer boot: toggles + magic-link round-trips ----------

async function _configuredFlow() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var wishlist  = bShop.wishlist.create({ query: query });
  var stub      = _stubEmailHandle();

  // The SAME primitive construction server.js does (sharing one mailer).
  var wishlistAlerts = bShop.wishlistAlerts.create({
    query: query, wishlist: wishlist, catalog: catalog, email: stub.email,
    emailForCustomer: async function () { return null; },   // inert resolver, like prod
  });
  var wishlistDigest = bShop.wishlistDigest.create({
    query: query, wishlist: wishlist, catalog: catalog, email: stub.email,
  });
  var customerPortal = bShop.customerPortal.create({ query: query });

  // Seed a customer + a known digest schedule.
  var customerId = b.uuid.v7();
  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [customerId, customers.hashEmail("shopper@example.com"), "Shopper", nowTs],
  );
  await wishlistDigest.defineSchedule({
    slug: "weekly-news", frequency: "weekly", day_of_week: 1, time_local: "09:00", timezone: "UTC",
  });

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers, wishlist: wishlist,
    wishlistAlerts: wishlistAlerts, wishlistDigest: wishlistDigest,
    customerPortal: customerPortal, customerPortalEmail: stub.email,
    shop_name: "Cron Shop",
  });

  try {
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, customerId)] });

    // ---- opt-in panel renders, defaults to subscribed/not-enrolled -----
    var page = await helpers.httpRequest({ port: sf.port, path: "/account/wishlist", jar: jar });
    check("wishlist page → 200",                  page.status === 200);
    check("alert toggle panel renders",           page.body.indexOf("Wishlist notifications") !== -1);
    check("price-drop alert default On",          page.body.indexOf("drops in price") !== -1);
    check("digest schedule listed",               page.body.indexOf("weekly-news") !== -1);
    check("digest default Not subscribed",        page.body.indexOf("Not subscribed") !== -1);
    check("wishlist page leaks no raw error",     _noLeak(page.body));

    // ---- alert opt-out round-trip --------------------------------------
    var optOut = await helpers.httpRequest({
      port: sf.port, path: "/account/wishlist/alerts", method: "POST", jar: jar,
      body: "trigger=price_drop&on=", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("alert opt-out → 303",                  optOut.status === 303);
    check("alert opt-out redirects to prefs",     (optOut.headers["location"] || "").indexOf("/account/wishlist?prefs=alerts") === 0);

    // The primitive now reads the opt-out as set.
    check("opt-out persisted in primitive",
      (await wishlistAlerts.isUnsubscribedFromTrigger(customerId, "price_drop")) === true);

    var afterOptOut = await helpers.httpRequest({ port: sf.port, path: "/account/wishlist", jar: jar });
    check("toggle reflects opt-out (Turn on)",    afterOptOut.body.indexOf("Turn on") !== -1);

    // ---- alert re-subscribe round-trip ---------------------------------
    var optIn = await helpers.httpRequest({
      port: sf.port, path: "/account/wishlist/alerts", method: "POST", jar: jar,
      body: "trigger=price_drop&on=1", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("alert opt-in → 303",                   optIn.status === 303);
    check("opt-out cleared in primitive",
      (await wishlistAlerts.isUnsubscribedFromTrigger(customerId, "price_drop")) === false);

    // ---- digest enroll round-trip --------------------------------------
    var enroll = await helpers.httpRequest({
      port: sf.port, path: "/account/wishlist/digest", method: "POST", jar: jar,
      body: "schedule_slug=weekly-news&on=1", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("digest enroll → 303",                  enroll.status === 303);
    var afterEnroll = await helpers.httpRequest({ port: sf.port, path: "/account/wishlist", jar: jar });
    check("digest now Subscribed",                afterEnroll.body.indexOf("Subscribed") !== -1 &&
                                                  afterEnroll.body.indexOf("Unsubscribe") !== -1);
    var enrollments = await wishlistDigest.enrollmentsForCustomer(customerId);
    check("digest enrollment is active",          enrollments.length === 1 && enrollments[0].status === "active");

    // ---- digest pause round-trip ---------------------------------------
    var pause = await helpers.httpRequest({
      port: sf.port, path: "/account/wishlist/digest", method: "POST", jar: jar,
      body: "schedule_slug=weekly-news&on=", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("digest pause → 303",                   pause.status === 303);
    var afterPause = await wishlistDigest.enrollmentsForCustomer(customerId);
    check("digest enrollment paused",             afterPause[0].status === "paused");

    // ---- unauthenticated toggle POST → login, no action ----------------
    var anonJar = helpers.cookieJar();
    var anon = await helpers.httpRequest({
      port: sf.port, path: "/account/wishlist/alerts", method: "POST", jar: anonJar,
      body: "trigger=price_drop&on=", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("anon toggle → 303 login",              anon.status === 303 &&
      (anon.headers["location"] || "") === "/account/login");

    // ---- magic-link: login page advertises it --------------------------
    var loginPage = await helpers.httpRequest({ port: sf.port, path: "/account/login", jar: helpers.cookieJar() });
    check("login advertises magic-link",          loginPage.body.indexOf("/account/login/link") !== -1);

    var linkForm = await helpers.httpRequest({ port: sf.port, path: "/account/login/link", jar: helpers.cookieJar() });
    check("magic-link form → 200",                linkForm.status === 200);
    check("magic-link form has email field",      linkForm.body.indexOf("Email me a link") !== -1);

    // POST a KNOWN email → enumeration-safe confirmation + a real send.
    var sentBefore = stub.sent.length;
    var linkPost = await helpers.httpRequest({
      port: sf.port, path: "/account/login/link", method: "POST", jar: helpers.cookieJar(),
      body: "email=" + encodeURIComponent("shopper@example.com"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("magic-link POST → 303 sent",           linkPost.status === 303 &&
      (linkPost.headers["location"] || "") === "/account/login/link?sent=1");
    check("magic-link email dispatched",          stub.sent.length === sentBefore + 1);
    var linkMsg = stub.sent[stub.sent.length - 1];
    check("magic-link email to the shopper",      linkMsg.to === "shopper@example.com");
    var tokenMatch = linkMsg.html.match(/\/account\/portal\/([A-Za-z0-9_-]+)/);
    check("magic-link email carries a portal token", !!tokenMatch);
    var plaintext = tokenMatch ? tokenMatch[1] : "";

    // POST an UNKNOWN email → same confirmation, NO send (no oracle).
    var sentBefore2 = stub.sent.length;
    var unknownPost = await helpers.httpRequest({
      port: sf.port, path: "/account/login/link", method: "POST", jar: helpers.cookieJar(),
      body: "email=" + encodeURIComponent("nobody@example.com"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("unknown email → same 303 confirmation", unknownPost.status === 303 &&
      (unknownPost.headers["location"] || "") === "/account/login/link?sent=1");
    check("unknown email sends nothing",          stub.sent.length === sentBefore2);

    // Redeem the token ONCE → sealed auth cookie + 303 to /account.
    var redeemJar = helpers.cookieJar();
    var redeem = await helpers.httpRequest({
      port: sf.port, path: "/account/portal/" + encodeURIComponent(plaintext), jar: redeemJar,
    });
    check("portal redeem → 303 account",          redeem.status === 303 &&
      (redeem.headers["location"] || "") === "/account");
    check("portal redeem set an auth cookie",     (redeem.headers["set-cookie"] || []).join(";").indexOf("shop_auth") !== -1);

    // The now-authenticated cookie reaches the account dashboard.
    var dash = await helpers.httpRequest({ port: sf.port, path: "/account", jar: redeemJar });
    check("redeemed session reaches /account",    dash.status === 200);

    // Re-redeem the SAME token → single-use, bounced to login.
    var reuse = await helpers.httpRequest({
      port: sf.port, path: "/account/portal/" + encodeURIComponent(plaintext), jar: helpers.cookieJar(),
    });
    check("token reuse → 303 login error",        reuse.status === 303 &&
      (reuse.headers["location"] || "").indexOf("/account/login") === 0);

    // An unknown token → same login bounce (no oracle).
    var bogus = await helpers.httpRequest({
      port: sf.port, path: "/account/portal/" + encodeURIComponent("not-a-real-token"), jar: helpers.cookieJar(),
    });
    check("unknown token → 303 login",            bogus.status === 303 &&
      (bogus.headers["location"] || "").indexOf("/account/login") === 0);
  } finally {
    await _teardown(sf);
  }
}

// ---- inert boot: no alerts/digest/portal deps → no surfaces ------------

async function _inertFlow() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var wishlist  = bShop.wishlist.create({ query: query });

  var customerId = b.uuid.v7();
  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [customerId, "hash-inert-" + customerId, "Inert Shopper", nowTs],
  );

  // No wishlistAlerts / wishlistDigest / customerPortal deps — the stock,
  // no-mailer CI boot. The wishlist itself is wired so the page renders.
  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers, wishlist: wishlist,
    shop_name: "Inert Shop",
  });

  try {
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, customerId)] });

    var page = await helpers.httpRequest({ port: sf.port, path: "/account/wishlist", jar: jar });
    check("inert wishlist page → 200",            page.status === 200);
    check("inert: no opt-in panel",               page.body.indexOf("Wishlist notifications") === -1);

    // The toggle POST routes don't mount → the path is a 404 (or the SPA
    // not-found page), never a 303-to-prefs.
    var optOut = await helpers.httpRequest({
      port: sf.port, path: "/account/wishlist/alerts", method: "POST", jar: jar,
      body: "trigger=price_drop&on=", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    check("inert: alert toggle route absent",     optOut.status === 404);

    // Magic-link surface absent.
    var loginPage = await helpers.httpRequest({ port: sf.port, path: "/account/login", jar: helpers.cookieJar() });
    check("inert: login does NOT advertise magic-link", loginPage.body.indexOf("/account/login/link") === -1);
    var linkForm = await helpers.httpRequest({ port: sf.port, path: "/account/login/link", jar: helpers.cookieJar() });
    check("inert: magic-link route absent",       linkForm.status === 404);
  } finally {
    await _teardown(sf);
  }
}

async function _run() {
  await _configuredFlow();
  await _inertFlow();
}

module.exports = { run: _run };

if (require.main === module) {
  _run().then(function () {
    console.log("wishlist-cron-flow: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
