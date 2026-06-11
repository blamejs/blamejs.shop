"use strict";
/**
 * Saved payment methods — end-to-end HTTP integration of the customer
 * /account/payment-methods surfaces (list / set-default / archive) and the
 * Stripe SetupIntent add-card flow, wired over ONE in-memory `node:sqlite`
 * DB loaded from the live migrations (including payment_methods). The Stripe
 * adapter is STUBBED (createSetupIntent / retrieveSetupIntent /
 * retrievePaymentMethod / createCustomer return canned pm_… data) so the
 * flow drives the real routes + primitive without touching the network.
 *
 * Asserts:
 *   - add via the SetupIntent→add path stores the row; listForCustomer
 *     returns it; the account page renders the brand + last4;
 *   - setDefault flips exactly one default; archive removes it;
 *   - IDOR (the load-bearing gate): a stranger's session cannot
 *     setDefault/archive the buyer's card → 404 (the _ownedPaymentMethod
 *     gate), AND the stranger's own listForCustomer excludes it;
 *   - the _screenForRawCard floor: a PAN-shaped digit run reaching add() is
 *     refused (nothing stored);
 *   - PAYMENT_METHOD_DUPLICATE_TOKEN → idempotent "already on file" notice,
 *     not a 500.
 *
 * Every state-changing POST goes through the real double-submit CSRF gate.
 * Network: zero — payment is a stub, every request lands on 127.0.0.1.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql",
            "0004_shop_config.sql", "0036_payment_methods.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
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

// A stubbed Stripe adapter: each setup-intent yields a fresh pm_… so two
// shoppers' cards don't collide on the processor_token UNIQUE index.
var _pmSeq = 0;
function _stubPayment() {
  return {
    name: "fake-stripe",
    createCustomer: async function () { return { id: "cus_" + (++_pmSeq) }; },
    createSetupIntent: async function (input) {
      var n = ++_pmSeq;
      return { id: "seti_" + n, client_secret: "seti_" + n + "_secret", customer: input.customer };
    },
    retrieveSetupIntent: async function (id) {
      // Map the seti id to its pm id (the island posts back the setup_intent
      // id; the server reads the pm off it).
      return { id: id, payment_method: "pm_" + id.replace("seti_", ""), status: "succeeded" };
    },
    retrievePaymentMethod: async function (id) {
      return { id: id, card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

function _noLeak(body) {
  body = body || "";
  return body.indexOf("at Object.") === -1 && body.indexOf("TypeError") === -1 && body.indexOf("    at ") === -1;
}

// Drive the SetupIntent→add path the way the island does: POST setup-intent
// to get a client_secret, then POST the resulting setup_intent_id back. The
// stub maps seti_<n> → pm_<n>. Returns the page after the add redirect is
// followed.
async function _addCard(port, jar) {
  var si = await helpers.httpRequest({ port: port, path: "/account/payment-methods/setup-intent", method: "POST", jar: jar, body: "{}", headers: { "content-type": "application/json" } });
  if (si.status !== 200) return { ok: false, step: "setup-intent", status: si.status };
  var clientSecret = JSON.parse(si.body).client_secret;
  // The island confirms with Stripe.js client-side; here we synthesize the
  // setup_intent_id the browser would post back (seti id = client_secret
  // minus the _secret suffix).
  var setupIntentId = clientSecret.replace(/_secret$/, "");
  var add = await helpers.httpRequest({ port: port, path: "/account/payment-methods", method: "POST", jar: jar, form: { setup_intent_id: setupIntentId } });
  return { ok: true, status: add.status, location: add.headers["location"] || "", setup_intent_id: setupIntentId };
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "pm-order-sf" });
  var customers = bShop.customers.create({ query: query });
  var paymentMethods = bShop.paymentMethods.create({ query: query });
  var payment = _stubPayment();

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-pm-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        paymentMethods: paymentMethods, payment: payment,
        stripe_publishable_key: "pk_test_x",
        shop_name: "PM Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // Prime the CSRF cookie with a GET so the helper echoes the token on the
    // state-changing POSTs.
    var listPage0 = await helpers.httpRequest({ port: port, path: "/account/payment-methods", jar: buyerJar });
    check("payment methods page -> 200", listPage0.status === 200);
    check("page shows the add CTA", listPage0.body.indexOf("/account/payment-methods/add") !== -1);
    check("publishable key present -> live add link", listPage0.body.indexOf("href=\"/account/payment-methods/add\"") !== -1);

    // ---- add a card via the SetupIntent flow -------------------------
    var add1 = await _addCard(port, buyerJar);
    check("add card -> 303 ?ok=added", add1.ok && add1.status === 303 && add1.location.indexOf("ok=added") !== -1);

    var saved = await paymentMethods.listForCustomer(buyer);
    check("card stored for the buyer", saved.length === 1 && saved[0].brand === "visa" && saved[0].last4 === "4242");
    var cardId = saved[0].id;

    var listPage1 = await helpers.httpRequest({ port: port, path: "/account/payment-methods", jar: buyerJar });
    check("page renders the brand + last4", listPage1.body.indexOf("4242") !== -1 && listPage1.body.toLowerCase().indexOf("visa") !== -1);

    // ---- add a second card + set-default flips exactly one -----------
    var add2 = await _addCard(port, buyerJar);
    check("add second card -> 303", add2.ok && add2.status === 303);
    var saved2 = await paymentMethods.listForCustomer(buyer);
    check("two cards on file", saved2.length === 2);
    var secondId = saved2.filter(function (p) { return p.id !== cardId; })[0].id;

    var setDef = await helpers.httpRequest({ port: port, path: "/account/payment-methods/" + secondId + "/default", method: "POST", jar: buyerJar, form: {} });
    check("set default -> 303 ?ok=default", setDef.status === 303 && (setDef.headers["location"] || "").indexOf("ok=default") !== -1);
    var afterDef = await paymentMethods.listForCustomer(buyer);
    var defaults = afterDef.filter(function (p) { return Number(p.is_default) === 1; });
    check("exactly one default after setDefault", defaults.length === 1 && defaults[0].id === secondId);

    // ---- IDOR: a stranger cannot setDefault/archive the buyer's card -
    var strangerJar = helpers.cookieJar();
    strangerJar.capture({ "set-cookie": [helpers.authCookie(b, stranger)] });
    await helpers.httpRequest({ port: port, path: "/account/payment-methods", jar: strangerJar }); // prime csrf

    var idorDefault = await helpers.httpRequest({ port: port, path: "/account/payment-methods/" + cardId + "/default", method: "POST", jar: strangerJar, form: {} });
    check("stranger setDefault on buyer's card -> 404", idorDefault.status === 404);
    check("idor setDefault leaks no raw error", _noLeak(idorDefault.body));

    var idorArchive = await helpers.httpRequest({ port: port, path: "/account/payment-methods/" + cardId + "/archive", method: "POST", jar: strangerJar, form: {} });
    check("stranger archive on buyer's card -> 404", idorArchive.status === 404);

    // The buyer's card is untouched by the stranger's attempts.
    var stillThere = await paymentMethods.get(cardId);
    check("buyer's card untouched by IDOR attempts", stillThere && stillThere.archived_at == null);

    // And the stranger's OWN list excludes the buyer's cards.
    var strangerList = await paymentMethods.listForCustomer(stranger);
    check("stranger's list excludes the buyer's cards", strangerList.length === 0);

    // ---- archive the buyer's own card -------------------------------
    var archive = await helpers.httpRequest({ port: port, path: "/account/payment-methods/" + cardId + "/archive", method: "POST", jar: buyerJar, form: {} });
    check("buyer archive -> 303 ?ok=archived", archive.status === 303 && (archive.headers["location"] || "").indexOf("ok=archived") !== -1);
    var afterArchive = await paymentMethods.listForCustomer(buyer);
    check("archived card drops from the active list", afterArchive.every(function (p) { return p.id !== cardId; }));

    // ---- the _screenForRawCard floor refuses a PAN-shaped run -------
    // Drive the primitive directly (the add route never carries a PAN — the
    // pm_… is opaque — but the floor is the contract, so pin it).
    var rawRefused = false;
    try {
      await paymentMethods.add({
        customer_id: buyer, processor: "stripe",
        processor_token: "4242424242424242", brand: "visa", last4: "4242",
        exp_month: 4, exp_year: 2030,
      });
    } catch (e) { rawRefused = e instanceof TypeError && /PAN-shaped/.test(e.message); }
    check("PAN-shaped processor_token refused (raw-card floor)", rawRefused);
    var afterRaw = await paymentMethods.listForCustomer(buyer, { include_archived: true });
    check("raw-card attempt stored nothing new", afterRaw.every(function (p) { return p.processor_token == null || p.processor_token.indexOf("4242424242") === -1; }));

    // ---- duplicate token -> idempotent notice, not 500 -------------
    // Re-confirm the SAME setup_intent_id the buyer already added (the stub
    // maps it to the same pm_…), so the second add hits
    // PAYMENT_METHOD_DUPLICATE_TOKEN. First add a fresh card to get a known
    // setup_intent_id, then replay it.
    var freshJar = helpers.cookieJar();
    var freshCustomer = b.uuid.v7();
    freshJar.capture({ "set-cookie": [helpers.authCookie(b, freshCustomer)] });
    await helpers.httpRequest({ port: port, path: "/account/payment-methods", jar: freshJar }); // prime csrf
    var freshAdd = await _addCard(port, freshJar);
    check("fresh add -> 303", freshAdd.ok && freshAdd.status === 303);
    // Replay the SAME setup_intent_id → same pm_… → duplicate token.
    var dup = await helpers.httpRequest({ port: port, path: "/account/payment-methods", method: "POST", jar: freshJar, form: { setup_intent_id: freshAdd.setup_intent_id } });
    check("duplicate token -> 303 ?ok=exists (idempotent, not 500)", dup.status === 303 && (dup.headers["location"] || "").indexOf("ok=exists") !== -1);
    var freshList = await paymentMethods.listForCustomer(freshCustomer);
    check("duplicate add did not create a second row", freshList.length === 1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

// Partial Stripe config: STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET present (so
// the list/set-default/archive routes mount and `payment` is wired) but no
// STRIPE_PUBLISHABLE_KEY — the add-card SetupIntent flow can't complete. The
// page must NOT offer a live "Add a card" link (which dead-ends on the add
// route's 503); it renders the disabled affordance + an honest note instead.
async function _runNoPublishableKey() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "pm-order-sf-nopk" });
  var customers = bShop.customers.create({ query: query });
  var paymentMethods = bShop.paymentMethods.create({ query: query });
  var payment = _stubPayment();

  var buyer = b.uuid.v7();

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-pm-nopk-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        paymentMethods: paymentMethods, payment: payment,
        // No stripe_publishable_key — the partial-config case.
        shop_name: "PM Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    var page = await helpers.httpRequest({ port: port, path: "/account/payment-methods", jar: jar });
    check("no-pk: payment methods page -> 200", page.status === 200);
    check("no-pk: NO live add link", page.body.indexOf("href=\"/account/payment-methods/add\"") === -1);
    check("no-pk: disabled add-card affordance renders", /<button[^>]*disabled[^>]*>Add a card<\/button>/.test(page.body));
    check("no-pk: honest unconfigured note", page.body.indexOf("isn't available on this store yet") !== -1);

    // Defense-in-depth: a direct hit on the add route still 503s gracefully
    // (the disabled CTA means nothing links here, but a typed URL must not 500).
    var addDirect = await helpers.httpRequest({ port: port, path: "/account/payment-methods/add", jar: jar });
    check("no-pk: direct add route -> 503", addDirect.status === 503);
    check("no-pk: 503 leaks no raw error", _noLeak(addDirect.body));
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

async function run() { await _run(); await _runNoPublishableKey(); }

module.exports = { run: run };

if (require.main === module) {
  _run().then(function () {
    console.log("OK — payment-methods-flow (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — payment-methods-flow: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
