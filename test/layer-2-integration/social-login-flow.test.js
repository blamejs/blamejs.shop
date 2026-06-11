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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0006_customers.sql",
            "0205_customer_oauth_identities.sql", "0206_orders_email_hash.sql",
            "0226_guest_order_reconciliations.sql"]
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
// `claims` may be a static object OR a function (called per exchange) so a
// single booted app can return different identities on successive callbacks.
function _stubOAuth(claims) {
  return {
    authorizationUrl: async function () {
      return { url: "https://accounts.google.com/o/oauth2/v2/auth?stub=1", state: "STATE-abc", nonce: "NONCE-abc", verifier: "VERIFIER-abc" };
    },
    exchangeCode: async function (_e) {
      return { claims: typeof claims === "function" ? claims() : claims };
    },
  };
}

async function _boot(query, customers, oauthGoogle) {
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "oidc-flow" });
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-oidc-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, customers: customers, order: order, oauthGoogle: oauthGoogle });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir, cart: cart, order: order };
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
    var guestCart = await handle.cart.create(sid, { currency: "USD" });

    // Seed a prior GUEST order under the same email (no owner yet),
    // recording the buyer-email hash the way checkout does, to prove it
    // gets claimed on the verified sign-in. Direct insert against the
    // real cart so foreign keys hold; the reconciliation only touches
    // the orders row.
    var guestOrderId = b.uuid.v7();
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
      "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
      "payment_intent_id, ship_to_json, customer_email_hash, created_at, updated_at) " +
      "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 2999, 0, 0, 0, 2999, NULL, ?4, ?5, ?6, ?6)",
      [guestOrderId, guestCart.id, sid, JSON.stringify({ name: "Buyer", country: "US" }),
       customers.hashEmail("buyer@example.com"), Date.now()],
    );

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
    // The prior guest order placed under this (now verified) email is
    // claimed into the account.
    check("guest order claimed on verified sign-in", (await handle.order.get(guestOrderId)).customer_id === linked.id);
    // The attach left an audit row naming the order, the account, and the
    // proof route — so a disputed link is traceable.
    var recons = await handle.order.reconciliationsForCustomer(linked.id);
    check("reconciliation wrote one audit row",  recons.length === 1 && recons[0].order_id === guestOrderId);
    check("audit row attributes the proof route", recons[0].linked_via === "verified-email");

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

  // --- No silent account takeover on an UNVERIFIED-email match. ---
  // A local account already exists for victim@example.com (registered via
  // the passwordless customers.register path — no passkey, no federated
  // link). An attacker drives a Google sign-in whose `sub` is brand-new and
  // whose claimed email is the victim's, but with email_verified=false. The
  // route MUST refuse: no session minted, no identity linked to the victim,
  // the victim row left exactly as it was. This is the headline takeover
  // class (an enroll/sign-in route attaching to an existing account by mere
  // email knowledge) the customers model guards against — proven here end to
  // end at the HTTP layer, not just in the unit suite.
  var query2 = _makeQuery();
  var customers2 = bShop.customers.create({ query: query2 });
  var victim = await customers2.register({ email: "victim@example.com", display_name: "Victim" });
  var attackerClaims = { sub: "attacker-sub-999", email: "victim@example.com", email_verified: false, name: "Mallory" };
  var handle2 = await _boot(query2, customers2, _stubOAuth(attackerClaims));
  try {
    var jar3 = helpers.cookieJar();
    await helpers.httpRequest({ port: handle2.port, path: "/account/login/google", jar: jar3 });
    var attack = await helpers.httpRequest({ port: handle2.port, path: "/account/auth/google/callback?code=CODE&state=STATE-abc", jar: jar3 });
    check("takeover attempt then 303",          attack.status === 303);
    // Bounced to login with the conflict notice — NOT signed in.
    check("takeover attempt bounces to login",  (attack.headers.location || "").indexOf("/account/login") === 0);
    check("takeover attempt flags email-conflict", (attack.headers.location || "").indexOf("error=email-conflict") !== -1);
    check("takeover attempt minted no session", !jar3.get("shop_auth"));
    // The attacker's subject was never linked to anyone.
    check("attacker subject left unlinked",     (await customers2.byOAuthIdentity("google", "attacker-sub-999")) === null);
    // The victim's account is untouched — no federated identity grafted on.
    var victimOauth = await query2(
      "SELECT * FROM customer_oauth_identities WHERE customer_id = ?1", [victim.id],
    );
    check("victim account untouched",           victimOauth.rows.length === 0);
    // The conflict notice renders as friendly, escaped copy on the login page
    // (no provider/internal detail leaked; the message is a fixed string).
    var conflictPage = await helpers.httpRequest({ port: handle2.port, path: "/account/login?error=email-conflict" });
    check("conflict page then 200",             conflictPage.status === 200);
    check("conflict page shows friendly notice", conflictPage.body.indexOf("That email already has an account") !== -1);
  } finally {
    try { await handle2.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(handle2.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }

  // --- Unconfigured graceful state: no adapter wired → no button, no route. ---
  // When the operator hasn't supplied GOOGLE_OAUTH_CLIENT_ID/SECRET the
  // adapter is never built and `deps.oauthGoogle` is absent. The login page
  // must NOT advertise a Google button (a dead link), and the start/callback
  // routes must not exist (a 404, never a 500). This is the "ship disabled
  // when credentials absent" contract — the button is opt-in on real config.
  var query3 = _makeQuery();
  var customers3 = bShop.customers.create({ query: query3 });
  var handle3 = await _boot(query3, customers3, undefined);
  try {
    var bare = await helpers.httpRequest({ port: handle3.port, path: "/account/login" });
    check("unconfigured login then 200",        bare.status === 200);
    check("unconfigured login hides the button", bare.body.indexOf("/account/login/google") === -1);
    // The start route isn't mounted at all → 404 (not a 500 from a missing dep).
    var noStart = await helpers.httpRequest({ port: handle3.port, path: "/account/login/google" });
    check("unconfigured start route is 404",    noStart.status === 404);
    var noCb = await helpers.httpRequest({ port: handle3.port, path: "/account/auth/google/callback?code=C&state=S" });
    check("unconfigured callback route is 404", noCb.status === 404);
  } finally {
    try { await handle3.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(handle3.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
