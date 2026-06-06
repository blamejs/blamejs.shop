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

async function _run() {
  await _unifiedFlow();
  await _passkeyOnlyFlow();
  await _magicLinkNonBlocking();
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
