"use strict";
/**
 * Unified sign-in screen — both passwordless paths on one page.
 *
 * /account/login offers passkey as the primary action AND the email
 * magic-link as an inline, always-available backup. The passkey ceremony
 * needs JavaScript; the email-link path must NOT — it is a server-rendered
 * <form method=post action=/account/login/link> that a no-JS browser can
 * submit directly. This test boots one real `b.createApp` storefront against
 * an in-memory `node:sqlite` DB loaded from the live customer + portal
 * migrations, wires the SAME primitives server.js constructs (customer-portal
 * + a recording stub mailer), and asserts:
 *
 *   - the login page renders BOTH paths on one screen: the passkey form
 *     (#login-form + the passkey-login.js island) AND the inline email-link
 *     form (action=/account/login/link, its own email field);
 *   - the inline fallback carries the `data-passkey-fallback` hook the island
 *     steers a stranded user to (no dead end) and the no-JS submit button;
 *   - the no-JS fallback POST works as a plain form submit: it 303s to the
 *     enumeration-safe confirmation and dispatches EXACTLY ONE mail;
 *   - enumeration parity — a known and an unknown email produce an IDENTICAL
 *     303 response, and only the known one sends mail (no existence oracle);
 *   - the minted token redeems ONCE into the sealed auth cookie, and an
 *     already-signed-in visitor hitting /account/login is redirected to
 *     /account (no login form re-render);
 *   - WITHOUT the portal/mailer deps, the page shows ONLY the passkey path —
 *     no broken email-link affordance.
 *
 * Network: zero — every request lands on 127.0.0.1. No setTimeout sleeps;
 * `helpers.waitUntil` polls the recording mailer for the dispatched send.
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
  "0072_customer_portal_sessions.sql",
  // The server-side session-revocation boundary that explicit sign-out moves
  // forward (so a sealed cookie copied before logout can't outlive it).
  "0222_customer_session_revocations.sql",
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

// Recording stub mailer matching b.mail.create()'s .send() shape — used to
// build the SAME bShop.email instance server.js wires, so the magic-link
// surface dispatches without a real SMTP server.
function _stubEmailHandle() {
  var sent = [];
  var mailer = { send: async function (msg) { sent.push(msg); return { ok: true, id: "msg_" + sent.length }; } };
  return { sent: sent, email: bShop.email.create({ mailer: mailer, from: "shop@example.com" }) };
}

async function _bootStorefront(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-signin-sf-"));
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

// ---- configured boot: both paths on one screen -------------------------

async function _unifiedFlow() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var customerPortal = bShop.customerPortal.create({ query: query });
  var stub      = _stubEmailHandle();

  // Seed a customer whose email the magic-link path will resolve.
  var customerId = b.uuid.v7();
  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [customerId, customers.hashEmail("shopper@example.com"), "Shopper", nowTs],
  );

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers,
    customerPortal: customerPortal, customerPortalEmail: stub.email,
    shop_name: "Sign-in Shop",
  });

  try {
    // ---- one screen renders BOTH passwordless paths --------------------
    var page = await helpers.httpRequest({ port: sf.port, path: "/account/login", jar: helpers.cookieJar() });
    check("login page → 200",                     page.status === 200);
    // Primary: passkey form + its progressive-enhancement island.
    check("login renders the passkey form",       page.body.indexOf("id=\"login-form\"") !== -1);
    check("login offers Sign in with passkey",    page.body.indexOf("Sign in with passkey") !== -1);
    // The island is referenced by its content-fingerprinted name
    // (passkey-login.<hash>.js), so match the stem the manifest preserves.
    check("login loads the passkey island",       page.body.indexOf("passkey-login.") !== -1);
    // Backup: the inline email magic-link form, on the SAME page.
    check("login renders the inline email-link form",
      page.body.indexOf("action=\"/account/login/link\"") !== -1);
    check("inline form has its own email field",  page.body.indexOf("id=\"magic-email\"") !== -1);
    check("inline form has a no-JS submit",       page.body.indexOf("Email me a sign-in link") !== -1);
    // The fallback hook the island steers a stranded user to (no dead end).
    check("inline form carries the fallback hook", page.body.indexOf("data-passkey-fallback") !== -1);

    // ---- the no-JS fallback works as a plain form POST -----------------
    //
    // No island, no fetch — a bare form submit (the helper's `form` is an
    // application/x-www-form-urlencoded body, exactly what a browser sends).
    // A KNOWN email → enumeration-safe confirmation + EXACTLY one send.
    var sentBefore = stub.sent.length;
    var knownPost = await helpers.httpRequest({
      port: sf.port, path: "/account/login/link", method: "POST", jar: helpers.cookieJar(),
      form: { email: "shopper@example.com" },
    });
    check("no-JS fallback POST → 303 sent",       knownPost.status === 303 &&
      (knownPost.headers["location"] || "") === "/account/login/link?sent=1");
    // Poll the recording mailer rather than asserting synchronously — the
    // send is awaited in-handler but the assertion stays robust under load.
    await helpers.waitUntil(function () { return stub.sent.length === sentBefore + 1; }, {
      timeoutMs: 5000,
      label:     "unified-signin: magic-link mail dispatched exactly once",
    });
    check("fallback POST mailed exactly once",    stub.sent.length === sentBefore + 1);
    var linkMsg = stub.sent[stub.sent.length - 1];
    check("mail addressed to the shopper",        linkMsg.to === "shopper@example.com");
    var tokenMatch = linkMsg.html.match(/\/account\/portal\/([A-Za-z0-9_-]+)/);
    check("mail carries a single-use portal token", !!tokenMatch);
    var plaintext = tokenMatch ? tokenMatch[1] : "";

    // ---- enumeration parity: unknown email is byte-identical -----------
    var sentBefore2 = stub.sent.length;
    var unknownPost = await helpers.httpRequest({
      port: sf.port, path: "/account/login/link", method: "POST", jar: helpers.cookieJar(),
      form: { email: "nobody@example.com" },
    });
    check("unknown email → identical 303 confirmation",
      unknownPost.status === knownPost.status &&
      (unknownPost.headers["location"] || "") === (knownPost.headers["location"] || ""));
    check("unknown email sends nothing (no oracle)", stub.sent.length === sentBefore2);

    // ---- token redeems ONCE into the sealed auth cookie ----------------
    var redeemJar = helpers.cookieJar();
    var redeem = await helpers.httpRequest({
      port: sf.port, path: "/account/portal/" + encodeURIComponent(plaintext), jar: redeemJar,
    });
    check("token redeem → 303 account",           redeem.status === 303 &&
      (redeem.headers["location"] || "") === "/account");
    check("token redeem set an auth cookie",      (redeem.headers["set-cookie"] || []).join(";").indexOf("shop_auth") !== -1);

    var reuse = await helpers.httpRequest({
      port: sf.port, path: "/account/portal/" + encodeURIComponent(plaintext), jar: helpers.cookieJar(),
    });
    check("token reuse → 303 login (single-use)", reuse.status === 303 &&
      (reuse.headers["location"] || "").indexOf("/account/login") === 0);

    // ---- already-signed-in visitor is redirected away from login -------
    var authJar = helpers.cookieJar();
    authJar.capture({ "set-cookie": [helpers.authCookie(b, customerId)] });
    var signedIn = await helpers.httpRequest({ port: sf.port, path: "/account/login", jar: authJar });
    check("signed-in → 303 to /account",          signedIn.status === 303 &&
      (signedIn.headers["location"] || "") === "/account");
  } finally {
    await _teardown(sf);
  }
}

// ---- inert boot: no portal/mailer → passkey-only, no broken fallback ---

async function _passkeyOnlyFlow() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });

  // No customerPortal / customerPortalEmail deps — the page must offer the
  // passkey path alone with NO email-link affordance (a link to a route that
  // doesn't mount would be a dead end).
  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers,
    shop_name: "Passkey-only Shop",
  });

  try {
    var page = await helpers.httpRequest({ port: sf.port, path: "/account/login", jar: helpers.cookieJar() });
    check("passkey-only login → 200",             page.status === 200);
    check("passkey-only still offers passkey",     page.body.indexOf("Sign in with passkey") !== -1);
    check("passkey-only renders NO email-link form",
      page.body.indexOf("/account/login/link") === -1);
    check("passkey-only renders NO fallback hook", page.body.indexOf("data-passkey-fallback") === -1);

    // The magic-link route itself is absent (404), confirming the page
    // correctly suppresses the affordance rather than dangling a dead link.
    var linkRoute = await helpers.httpRequest({ port: sf.port, path: "/account/login/link", jar: helpers.cookieJar() });
    check("passkey-only: magic-link route absent", linkRoute.status === 404);
  } finally {
    await _teardown(sf);
  }
}

// ---- timing parity: the send is off the response's critical path -------

async function _magicLinkNonBlocking() {
  // SECURITY (no account-existence timing oracle): the magic-link POST must
  // answer with the generic confirmation WITHOUT waiting on the session
  // mint + the outbound email send. A registered address does that work
  // and an unregistered one skips it; if the work is awaited before the
  // 303, the registered address answers measurably slower — restoring the
  // oracle the identical response body removes. Prove the send is
  // fire-and-forget: wire a mailer whose sendMagicLink NEVER resolves and
  // confirm a known-email POST still returns the 303 promptly (a regression
  // that re-awaited the send would hang here until the test ceiling fires).
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var customerPortal = bShop.customerPortal.create({ query: query });
  var hangingEmail = { sendMagicLink: function () { return new Promise(function () { /* never resolves */ }); } };

  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [b.uuid.v7(), customers.hashEmail("hang@example.com"), "Hang", nowTs],
  );

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers,
    customerPortal: customerPortal, customerPortalEmail: hangingEmail,
    shop_name: "Timing Shop",
  });

  try {
    var resp = await helpers.withTestTimeout("magic-link non-blocking POST", function () {
      return helpers.httpRequest({
        port: sf.port, path: "/account/login/link", method: "POST", jar: helpers.cookieJar(),
        form: { email: "hang@example.com" },
      });
    }, { timeoutMs: 4000 });
    check("known-email POST returns despite a hanging mailer (send off the critical path)",
      resp.status === 303 && (resp.headers["location"] || "") === "/account/login/link?sent=1");
  } finally {
    await _teardown(sf);
  }
}

// ---- device-binding soft sign-out --------------------------------------

async function _deviceBindingDrift() {
  // The sealed auth cookie is tamper-proof but device-PORTABLE: a cookie
  // lifted to another device replays for its full life. The store-free
  // device fingerprint (SHAKE256 over UA + sorted Accept-*) stashed inside
  // the sealed envelope at mint time, recomputed + constant-time-compared
  // on read, catches a moved cookie. On drift the visitor is SOFT signed
  // out — the stale cookie is cleared and a neutral notice renders — never
  // a hard 401 mid-page. A network change must NOT trip it (IP excluded),
  // and a pre-binding cookie (no fp) passes through unchanged.
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var customerPortal = bShop.customerPortal.create({ query: query });
  var stub      = _stubEmailHandle();

  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [b.uuid.v7(), customers.hashEmail("dev@example.com"), "Device", nowTs],
  );

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers,
    customerPortal: customerPortal, customerPortalEmail: stub.email,
    shop_name: "Device Shop",
  });

  // Two distinct device shapes: same machine, different User-Agent.
  var UA_A = { "user-agent": "Mozilla/5.0 (Macintosh) DeviceA/1.0" };
  var UA_B = { "user-agent": "Mozilla/5.0 (Windows NT 10.0) DeviceB/9.9" };

  try {
    // Mint the auth cookie via the magic-link redeem FROM device A, so the
    // sealed env carries device A's fingerprint.
    var sentBefore = stub.sent.length;
    await helpers.httpRequest({
      port: sf.port, path: "/account/login/link", method: "POST",
      jar: helpers.cookieJar(), headers: UA_A, form: { email: "dev@example.com" },
    });
    await helpers.waitUntil(function () { return stub.sent.length === sentBefore + 1; }, {
      timeoutMs: 5000, label: "device-binding: magic-link dispatched",
    });
    var tokenMatch = stub.sent[stub.sent.length - 1].html.match(/\/account\/portal\/([A-Za-z0-9_-]+)/);
    check("device-binding: redeem token minted", !!tokenMatch);
    var token = tokenMatch ? tokenMatch[1] : "";

    var jar = helpers.cookieJar();
    var redeem = await helpers.httpRequest({
      port: sf.port, path: "/account/portal/" + encodeURIComponent(token), jar: jar, headers: UA_A,
    });
    check("device-binding: redeem 303 → /account (device A)",
      redeem.status === 303 && (redeem.headers["location"] || "") === "/account");

    // SAME device (UA A) reaches the account page — no drift, stays signed in.
    var sameDevice = await helpers.httpRequest({ port: sf.port, path: "/account", jar: jar, headers: UA_A });
    check("device-binding: same device stays signed in (2xx /account)",
      sameDevice.status >= 200 && sameDevice.status < 300);

    // DIFFERENT device shape (UA B) carrying the SAME cookie (same jar,
    // only the UA header changes) → soft sign-out: a 303 to the neutral
    // device-notice sign-in, NOT a hard 401, NOT a signed-in page render.
    var moved = await helpers.httpRequest({ port: sf.port, path: "/account", jar: jar, headers: UA_B });
    check("device-binding: moved cookie → 303 soft sign-out (not 401)",
      moved.status === 303 &&
      (moved.headers["location"] || "").indexOf("/account/login?signed_out=device") === 0);
    check("device-binding: moved cookie response clears the auth cookie",
      (moved.headers["set-cookie"] || []).join(";").indexOf("shop_auth=") !== -1);

    // The neutral notice renders on the sign-in screen — reassuring copy,
    // never an alarming error, and it discloses no reason.
    var notice = await helpers.httpRequest({
      port: sf.port, path: "/account/login?signed_out=device", jar: helpers.cookieJar(), headers: UA_B,
    });
    check("device-binding: sign-in screen carries the neutral signed-out notice",
      notice.status === 200 && notice.body.indexOf("signed out for your security") !== -1);

    // A pre-binding cookie (no fp, forged directly) must pass through
    // unchanged — a deploy never mass-signs-out live sessions.
    var legacyJar = helpers.cookieJar();
    var legacyId = b.uuid.v7();
    await query(
      "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      [legacyId, customers.hashEmail("legacy@example.com"), "Legacy", Date.now()],
    );
    legacyJar.capture({ "set-cookie": [helpers.authCookie(b, legacyId)] });
    var legacy = await helpers.httpRequest({ port: sf.port, path: "/account", jar: legacyJar, headers: UA_B });
    check("device-binding: pre-binding cookie (no fp) stays signed in across UAs",
      legacy.status >= 200 && legacy.status < 300);
  } finally {
    await _teardown(sf);
  }
}

// ---- magic-link uses the trusted origin, not a forged Host -------------
//
// The single-use portal token in the magic-link authenticates on its own, so
// the link must point at the operator's configured origin (shop_origin),
// never a host an attacker forged into the request. Boot with shop_origin set,
// POST the link request under a forged Host, and assert the mailed link points
// at the trusted origin and never carries the forged host.
async function _magicLinkUsesTrustedOrigin() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var customerPortal = bShop.customerPortal.create({ query: query });
  var stub      = _stubEmailHandle();

  var customerId = b.uuid.v7();
  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [customerId, customers.hashEmail("vip@example.com"), "VIP", nowTs],
  );

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers,
    customerPortal: customerPortal, customerPortalEmail: stub.email,
    shop_name: "Sign-in Shop", shop_origin: "https://shop.example",
  });

  try {
    var before = stub.sent.length;
    var resp = await helpers.httpRequest({
      port: sf.port, path: "/account/login/link", method: "POST", jar: helpers.cookieJar(),
      headers: { host: "evil.attacker.test" },
      form: { email: "vip@example.com" },
    });
    check("magic-link POST → 303", resp.status === 303);
    await helpers.waitUntil(function () { return stub.sent.length === before + 1; }, {
      timeoutMs: 5000, label: "magic-link trusted-origin: mail dispatched",
    });
    var msg = stub.sent[stub.sent.length - 1];
    check("magic-link is built from the trusted shop_origin, not the request Host",
      msg.html.indexOf("https://shop.example/account/portal/") !== -1);
    check("magic-link never carries the forged Host",
      msg.html.indexOf("evil.attacker.test") === -1);
  } finally {
    await _teardown(sf);
  }
}

// ---- explicit sign-out moves the session-revocation boundary -----------
//
// The sealed auth cookie is stateless for its full TTL, so clearing it on
// sign-out only signs out the responding browser — a cookie copied before
// sign-out would stay valid until it naturally expired. POST /account/logout
// must move the customer's server-side revocation boundary forward, so every
// live sealed cookie for the account is invalidated.
async function _logoutRevokesAllSessions() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });

  var customerId = b.uuid.v7();
  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [customerId, customers.hashEmail("member@example.com"), "Member", nowTs],
  );

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers, shop_name: "Sign-in Shop",
  });

  try {
    var authJar = helpers.cookieJar();
    authJar.capture({ "set-cookie": [helpers.authCookie(b, customerId)] });
    var signedIn = await helpers.httpRequest({ port: sf.port, path: "/account/login", jar: authJar });
    check("signed-in visitor is bounced from the login page",
      signedIn.status === 303 && (signedIn.headers["location"] || "") === "/account");

    check("no session-revocation boundary before sign-out",
      Number(await customers.sessionsValidFrom(customerId)) === 0);

    var out = await helpers.httpRequest({
      port: sf.port, path: "/account/logout", method: "POST", jar: authJar,
    });
    check("logout → 303 home", out.status === 303 && (out.headers["location"] || "") === "/");
    check("sign-out moves the revocation boundary forward (invalidates every live cookie)",
      Number(await customers.sessionsValidFrom(customerId)) > 0);
  } finally {
    await _teardown(sf);
  }
}

async function _run() {
  await _unifiedFlow();
  await _passkeyOnlyFlow();
  await _magicLinkNonBlocking();
  await _deviceBindingDrift();
  await _magicLinkUsesTrustedOrigin();
  await _logoutRevokesAllSessions();
}

module.exports = { run: _run };

if (require.main === module) {
  _run().then(function () {
    process.stdout.write("unified-signin-flow OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write(String((e && e.stack) || e) + "\n");
    process.exit(1);
  });
}
