"use strict";
/**
 * Sign in with Google (OIDC) — full HTTP integration of the storefront
 * OAuth routes, with a STUB oauth adapter (no network to Google).
 *
 * The framework's real `b.auth.oauth` adapter owns discovery + PKCE +
 * ID-token verification; that's covered by the framework's own suite.
 * Here we pin the storefront's route layer: the sealed in-flight state
 * cookie, the CSRF state check on the callback, turning verified claims
 * into a `shop_auth` session via customers.signInWithOIDC, and the
 * login page surfacing the button.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0205_customer_oauth_identities.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Stub OIDC adapter: deterministic authorization URL + verified claims.
function _stubOAuth(claims) {
  return {
    authorizationUrl: async function () {
      return { url: "https://accounts.google.com/o/oauth2/v2/auth?stub=1", state: "STATE-abc", nonce: "NONCE-abc", verifier: "VERIFIER-abc" };
    },
    exchangeCode: async function (_e) { return { claims: claims }; },
  };
}

async function _boot(query, customers, oauthGoogle) {
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-oidc-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, customers: customers, oauthGoogle: oauthGoogle });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir, cart: cart };
}

async function _run() {
  var query = _makeQuery();
  var customers = bShop.customers.create({ query: query });
  var oauth = _stubOAuth({ sub: "google-123", email: "buyer@example.com", email_verified: true, name: "Buyer" });

  var handle = await _boot(query, customers, oauth);
  var port = handle.port;
  try {
    // Login page surfaces the Google button.
    var login = await helpers.httpRequest({ port: port, path: "/account/login" });
    check("login page then 200",               login.status === 200);
    check("login shows the Google button",      login.body.indexOf("/account/login/google") !== -1);

    // Seed a guest cart for a session, then carry that session cookie
    // through the sign-in so we can assert the cart is adopted.
    var sid = "oidc-session-0001-xyz";
    await handle.cart.create(sid, { currency: "USD" });

    // Start: redirects to the provider + sets the sealed state cookie.
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/"] });
    var start = await helpers.httpRequest({ port: port, path: "/account/login/google", jar: jar });
    check("start then 302",                    start.status === 302);
    // Parse + compare the host (not a substring check — a substring
    // match would accept arbitrary hosts containing the string).
    check("start redirects to provider",        new URL(start.headers.location || "http://x/").hostname === "accounts.google.com");
    check("start sets the oauth state cookie",  !!jar.get("shop_oauth"));

    // Callback with the matching state signs in → shop_auth session + redirect.
    var cb = await helpers.httpRequest({ port: port, path: "/account/auth/google/callback?code=CODE&state=STATE-abc", jar: jar });
    check("callback then 303",                 cb.status === 303);
    check("callback redirects to /account",     (cb.headers.location || "") === "/account");
    check("callback set a shop_auth session",   !!jar.get("shop_auth"));
    // The customer now exists + is linked to the Google subject.
    var linked = await customers.byOAuthIdentity("google", "google-123");
    check("customer linked to google subject",  linked !== null);
    // The guest cart was adopted into the account (so checkout attaches
    // the order to the customer).
    check("guest cart adopted on sign-in",       (await handle.cart.bySession(sid)).customer_id === linked.id);

    // A forged callback whose state doesn't match the cookie is dropped.
    var jar2 = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/account/login/google", jar: jar2 });
    var forged = await helpers.httpRequest({ port: port, path: "/account/auth/google/callback?code=CODE&state=WRONG-state", jar: jar2 });
    check("forged-state callback then 303",    forged.status === 303);
    check("forged-state bounces to login",      (forged.headers.location || "").indexOf("/account/login") === 0);
    check("forged-state set no session",        !jar2.get("shop_auth"));

    // Callback with no in-flight cookie at all → login error, no session.
    var noCookie = await helpers.httpRequest({ port: port, path: "/account/auth/google/callback?code=CODE&state=STATE-abc" });
    check("no-cookie callback bounces to login", noCookie.status === 303 && (noCookie.headers.location || "").indexOf("/account/login") === 0);
  } finally {
    try { await handle.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
