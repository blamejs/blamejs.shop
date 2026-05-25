"use strict";
/**
 * Sign in with Apple (OIDC) — full HTTP integration of the storefront
 * Apple routes, with a STUB oauth adapter (no network to Apple).
 *
 * Apple differs from Google in two ways this test pins: the callback is a
 * POST (response_mode=form_post) whose code/state arrive in the form body,
 * and the user's display name arrives only on first consent, in a `user`
 * form field (JSON) rather than the ID token. Also covered: Apple's
 * `email_verified` arriving as the string "true", the sealed-state CSRF
 * check, guest-cart adoption, guest-order reconciliation, and the login
 * page surfacing the button.
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
            "0205_customer_oauth_identities.sql", "0206_orders_email_hash.sql"]
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

// Stub Apple OIDC adapter. Apple omits the name from the ID token; here the
// claims carry only sub + email (+ email_verified as the STRING "true",
// the way Apple sends it) — the name comes through the form's `user` blob.
function _stubApple(claims) {
  return {
    authorizationUrl: async function () {
      return { url: "https://appleid.apple.com/auth/authorize?stub=1", state: "AS-state", nonce: "AS-nonce", verifier: "AS-verifier" };
    },
    exchangeCode: async function (_e) { return { claims: claims }; },
  };
}

async function _boot(query, customers, oauthApple) {
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "apple-flow" });
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-apple-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, customers: customers, order: order, oauthApple: oauthApple });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir, cart: cart, order: order };
}

async function _run() {
  var query = _makeQuery();
  var customers = bShop.customers.create({ query: query });
  var oauth = _stubApple({ sub: "apple-789", email: "shopper@privaterelay.appleid.com", email_verified: "true" });

  var handle = await _boot(query, customers, oauth);
  var port = handle.port;
  try {
    // Login page surfaces the Apple button.
    var login = await helpers.httpRequest({ port: port, path: "/account/login" });
    check("login page then 200",               login.status === 200);
    check("login shows the Apple button",       login.body.indexOf("/account/login/apple") !== -1);

    // Seed a guest cart + a prior guest order under the same email.
    var sid = "apple-session-0001-xyz";
    var guestCart = await handle.cart.create(sid, { currency: "USD" });
    var guestOrderId = b.uuid.v7();
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
      "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
      "payment_intent_id, ship_to_json, customer_email_hash, created_at, updated_at) " +
      "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 4999, 0, 0, 0, 4999, NULL, ?4, ?5, ?6, ?6)",
      [guestOrderId, guestCart.id, sid, JSON.stringify({ name: "Shopper", country: "US" }),
       customers.hashEmail("shopper@privaterelay.appleid.com"), Date.now()],
    );

    // Start: 302 to Apple + sealed state cookie.
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/"] });
    var start = await helpers.httpRequest({ port: port, path: "/account/login/apple", jar: jar });
    check("start then 302",                    start.status === 302);
    check("start redirects to Apple",           new URL(start.headers.location || "http://x/").hostname === "appleid.apple.com");
    check("start sets the oauth state cookie",  !!jar.get("shop_oauth"));

    // Callback is a POST (form_post). The first-auth `user` blob carries
    // the name; assert it lands on the new account.
    var userBlob = JSON.stringify({ name: { firstName: "Casey", lastName: "Shopper" }, email: "shopper@privaterelay.appleid.com" });
    var cb = await helpers.httpRequest({ port: port, path: "/account/auth/apple/callback", method: "POST", jar: jar,
      form: { code: "CODE", state: "AS-state", user: userBlob } });
    check("callback then 303",                 cb.status === 303);
    check("callback redirects to /account",     (cb.headers.location || "") === "/account");
    check("callback set a shop_auth session",   !!jar.get("shop_auth"));
    var linked = await customers.byOAuthIdentity("apple", "apple-789");
    check("customer linked to apple subject",   linked !== null);
    check("name captured from user blob",       linked.display_name === "Casey Shopper");
    // Guest cart adopted.
    check("guest cart adopted on sign-in",       (await handle.cart.bySession(sid)).customer_id === linked.id);
    // Guest order claimed — proves email_verified:"true" (string) is honored.
    check("guest order claimed (string verified)", (await handle.order.get(guestOrderId)).customer_id === linked.id);

    // A forged state (no match to the sealed cookie) is dropped.
    var jar2 = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/account/login/apple", jar: jar2 });
    var forged = await helpers.httpRequest({ port: port, path: "/account/auth/apple/callback", method: "POST", jar: jar2,
      form: { code: "CODE", state: "WRONG" } });
    check("forged-state callback then 303",    forged.status === 303);
    check("forged-state bounces to login",      (forged.headers.location || "").indexOf("/account/login") === 0);
    check("forged-state set no session",        !jar2.get("shop_auth"));

    // No in-flight cookie at all → login error, no session.
    var noCookie = await helpers.httpRequest({ port: port, path: "/account/auth/apple/callback", method: "POST",
      form: { code: "CODE", state: "AS-state" } });
    check("no-cookie callback bounces to login", noCookie.status === 303 && (noCookie.headers.location || "").indexOf("/account/login") === 0);

    // Missing code/state in the body → login error.
    var empty = await helpers.httpRequest({ port: port, path: "/account/auth/apple/callback", method: "POST", jar: jar, form: {} });
    check("empty callback bounces to login",    empty.status === 303 && (empty.headers.location || "").indexOf("/account/login") === 0);
  } finally {
    try { await handle.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
