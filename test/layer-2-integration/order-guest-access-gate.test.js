"use strict";
/**
 * Guest-order access gate — HTTP integration of the IDOR fix that stops a
 * stranger reading (or enumerating, since order ids are timestamp-ordered
 * UUIDv7) a guest order's confirmation page by its bare UUID.
 *
 * A GUEST order carries no customer_id, so the ownership IDOR check can't gate
 * it the way it gates an owned order. Without a capability proof its full
 * name / address / line items would be readable by anyone who learns the id.
 * The gate admits a guest order's /orders/:id (+ /reorder) only when the
 * request proves it is the buyer:
 *
 *   1. the PLACING BROWSER — a sealed `shop_oacc` access cookie stamped at
 *      checkout confirm, carrying a capped rotating list of recently-placed
 *      order ids (~30d). Survives the Stripe round-trip (set before the
 *      redirect leaves the site; the 303 PRG strip preserves it);
 *   2. a SIGNED ACCESS TOKEN in the emailed order link (?k=<token>) — an
 *      order-scoped HMAC-SHA3-512 tag with an embedded ~90d expiry, verified
 *      constant-time. Works on ANY device (a fresh jar with no cookie);
 *   3. the SIGNED-IN OWNER (after the order is claimed/linked).
 *
 * Anything else → 404 (indistinguishable from a missing order). This file
 * mounts a storefront WITH the order-access signing key wired (so the emailed
 * token path is live) and a recording mailer (so the minted ?k= link can be
 * extracted and replayed). Network: zero — every request is on 127.0.0.1.
 *
 * NO worker/ import: only ../../lib + test/helpers + node builtins.
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

// The signing key the storefront verifies ?k= against AND the email factory
// mints links with — they MUST be the same value for a minted link to pass
// the gate (mirrors server.js wiring one derived secret into both).
var ORDER_ACCESS_SECRET = b.crypto.namespaceHash("order-access-token", "guest-access-gate-test-secret");
var SHOP_ORIGIN = "https://shop.example";

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql",
  "0206_orders_email_hash.sql",
  "0006_customers.sql",
  "0004_shop_config.sql",
  "0013_giftcards.sql",
  "0081_gift_card_ledger.sql",
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

// Recording mailer wired with the same access-token material server.js wires,
// so orderReceipt auto-builds the ?k= link the gate validates.
function _stubEmail() {
  var sent = [];
  var mailer = { send: async function (msg) { sent.push(msg); return { ok: true, id: "m" + sent.length }; } };
  return {
    sent:  sent,
    email: bShop.email.create({
      mailer: mailer, from: "shop@example.com",
      orderAccessSecret: ORDER_ACCESS_SECRET, shopOrigin: SHOP_ORIGIN,
    }),
  };
}

function _stubPayment() {
  var n = 0;
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      n += 1;
      return { id: "pi_" + n, client_secret: "pi_" + n + "_secret", status: "requires_payment_method", amount_minor: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

function _teardownApp(handle) {
  if (!handle) return Promise.resolve();
  return Promise.resolve()
    .then(function () { return handle.app.shutdown(); })
    .catch(function () { /* best-effort */ })
    .then(function () { try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ } });
}

function _setCookieNamed(res, name) {
  var raw = (res.headers && res.headers["set-cookie"]) || [];
  var list = Array.isArray(raw) ? raw : [raw];
  for (var i = 0; i < list.length; i += 1) {
    if (String(list[i]).indexOf(name + "=") === 0) return String(list[i]);
  }
  return null;
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "guest-access" });
  var customers = bShop.customers.create({ query: query });
  var tax       = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping  = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment   = _stubPayment();
  var giftcards = bShop.giftcards.create({ query: query });
  var ledger    = bShop.giftCardLedger.create({ query: query });
  var stub      = _stubEmail();
  var checkout  = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping,
    payment: payment, order: order, giftcards: giftcards, giftCardLedger: ledger,
    customers: customers,
  });

  var product = await catalog.products.create({ slug: "gate-widget", title: "Gate Widget", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "GATE-1", weight_grams: 100 });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 3000 });
  await catalog.inventory.create("GATE-1", { stock_on_hand: 100 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-gate-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        checkout: checkout, giftcards: giftcards, default_shipping_id: "std",
        order_access_secret: ORDER_ACCESS_SECRET,
        email: stub.email,
        shop_name: "Gate Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var handle = { app: app, dataDir: dataDir };

  async function _issueCard(amountMinor) {
    var card = await giftcards.issue({ amount_minor: amountMinor, currency: "USD" });
    await ledger.credit({ gift_card_id: card.id, amount_minor: amountMinor, source: "manual", source_ref: "test-issue" });
    return card.code;
  }
  async function _freshCart() {
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: variant.id, qty: 1 });
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/"] });
    await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    return jar;
  }
  async function _guestCheckout(email, name, jar) {
    var code = await _issueCard(5000);
    var co = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar,
      form: { email: email, name: name, line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103", gift_card_code: code },
    });
    return co;
  }

  try {
    // ===================================================================
    // A. Placing browser: confirm stamps the access cookie → 200
    // ===================================================================
    var jarA = await _freshCart();
    var coA  = await _guestCheckout("buyer@example.com", "Buyer", jarA);
    check("guest checkout → 303 /orders",        coA.status === 303 &&
      (coA.headers.location || "").indexOf("/orders/") === 0);
    var orderId = (coA.headers.location || "").replace("/orders/", "");
    check("confirm stamped the access cookie",    !!_setCookieNamed(coA, "shop_oacc"));

    var seeded = await order.get(orderId);
    check("order is a guest order (no owner)",     seeded && !seeded.customer_id);

    var pageA = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: jarA });
    check("placing browser (cookie) → 200",        pageA.status === 200);
    check("placing browser sees the address",      pageA.body.indexOf("1 Main St") !== -1);

    // ===================================================================
    // B. Bare UUID, anonymous (no cookie, no token) → 404
    // ===================================================================
    var anonGet = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: helpers.cookieJar() });
    check("bare-UUID anonymous → 404",             anonGet.status === 404);
    check("404 leaks no address",                  anonGet.body.indexOf("1 Main St") === -1);

    // ===================================================================
    // C. Emailed token link → 200 from a FRESH jar (any device)
    // ===================================================================
    // Drive the receipt mail (the same orderReceipt server.js wires); pull the
    // ?k= token out of the minted link and replay it from a cookie-less jar.
    await stub.email.orderReceipt({
      order: seeded, customer: { email: "buyer@example.com", name: "Buyer", tax_jurisdiction: "US" },
    });
    var mail = stub.sent[stub.sent.length - 1];
    var linkMatch = mail.text.match(/\/orders\/[^\s?]+\?k=([A-Za-z0-9._%-]+)/);
    check("receipt mail carries a ?k= order link", !!linkMatch);
    var token = linkMatch ? decodeURIComponent(linkMatch[1]) : "";

    var freshJar = helpers.cookieJar();
    var tokenGet = await helpers.httpRequest({ port: port, path: "/orders/" + orderId + "?k=" + encodeURIComponent(token), jar: freshJar });
    check("emailed token (fresh jar) → 200",       tokenGet.status === 200);
    check("token page shows the address",          tokenGet.body.indexOf("1 Main St") !== -1);
    // Opening the link stamped an access cookie on THIS device, so a refresh
    // (no ?k=) keeps resolving.
    check("token open stamped a device cookie",     !!_setCookieNamed(tokenGet, "shop_oacc"));
    var refreshGet = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: freshJar });
    check("post-token refresh (cookie) → 200",      refreshGet.status === 200);

    // ===================================================================
    // D. Tampered / expired token → 404
    // ===================================================================
    // Flip the last hex char of the tag → MAC mismatch → 404.
    var lastCh = token.charAt(token.length - 1);
    var swapped = (lastCh === "0" ? "1" : "0");
    var tampered = token.slice(0, -1) + swapped;
    var tamperedGet = await helpers.httpRequest({ port: port, path: "/orders/" + orderId + "?k=" + encodeURIComponent(tampered), jar: helpers.cookieJar() });
    check("tampered token → 404",                  tamperedGet.status === 404);

    // A token whose embedded expiry is in the past → 404 (expiry check).
    // Re-sign the SAME order id under an already-elapsed exp using the test's
    // own copy of the signing key (the verifier recomputes over orderId+exp,
    // so this is a structurally-valid-but-expired token, not a forgery).
    var pastExpB36 = (Date.now() - 1000).toString(36);
    var pastTag = b.crypto.hmacSha3(ORDER_ACCESS_SECRET, "order-access:v1:" + orderId + ":" + pastExpB36).slice(0, 32);
    var expiredToken = pastExpB36 + "." + pastTag;
    var expiredGet = await helpers.httpRequest({ port: port, path: "/orders/" + orderId + "?k=" + encodeURIComponent(expiredToken), jar: helpers.cookieJar() });
    check("expired token → 404",                   expiredGet.status === 404);

    // A token minted for a DIFFERENT order can't open this one (order-scoped).
    var otherId = b.uuid.v7();
    var otherExpB36 = (Date.now() + 86400000).toString(36);
    var otherTag = b.crypto.hmacSha3(ORDER_ACCESS_SECRET, "order-access:v1:" + otherId + ":" + otherExpB36).slice(0, 32);
    var otherToken = otherExpB36 + "." + otherTag;
    var wrongOrderGet = await helpers.httpRequest({ port: port, path: "/orders/" + orderId + "?k=" + encodeURIComponent(otherToken), jar: helpers.cookieJar() });
    check("token for a different order → 404",      wrongOrderGet.status === 404);

    // ===================================================================
    // E. Signed-in owner → 200; signed-in NON-owner with the URL → 404
    // ===================================================================
    var ownerId = b.uuid.v7();
    await query(
      "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      [ownerId, customers.hashEmail("owner@example.com"), "Owner", Date.now()],
    );
    var ownedCartId = b.uuid.v7(); var ownedOrderId = b.uuid.v7();
    await query(
      "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
      "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
      [ownedCartId, b.uuid.v7(), ownerId, Date.now(), Date.now() + 86400000],
    );
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
      "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, " +
      "customer_email_hash, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 3000, 0, 0, 0, 3000, NULL, '{\"country\":\"US\",\"line1\":\"9 Owner Way\"}', ?5, ?6, ?6)",
      [ownedOrderId, ownedCartId, ownerId, b.uuid.v7(), customers.hashEmail("owner@example.com"), Date.now()],
    );

    var ownerJar = helpers.cookieJar();
    ownerJar.capture({ "set-cookie": [helpers.authCookie(b, ownerId)] });
    var ownerPage = await helpers.httpRequest({ port: port, path: "/orders/" + ownedOrderId, jar: ownerJar });
    check("signed-in owner → 200",                 ownerPage.status === 200);

    // A signed-in NON-owner (different customer) with the URL → 404. A guest-
    // order access cookie / token must NOT override the owned-order IDOR gate.
    var nonOwnerJar = helpers.cookieJar();
    nonOwnerJar.capture({ "set-cookie": [helpers.authCookie(b, b.uuid.v7())] });
    // Carry the placing browser's access cookie too — proving it grants NO
    // access to an OWNED order it doesn't list, only to guest orders.
    var oaccRaw = jarA.get("shop_oacc");
    if (oaccRaw) nonOwnerJar.capture({ "set-cookie": ["shop_oacc=" + oaccRaw] });
    var nonOwnerPage = await helpers.httpRequest({ port: port, path: "/orders/" + ownedOrderId, jar: nonOwnerJar });
    check("signed-in non-owner with URL → 404",    nonOwnerPage.status === 404);
    check("non-owner 404 leaks no address",         nonOwnerPage.body.indexOf("9 Owner Way") === -1);

    // An anonymous request to the OWNED order also 404s (unchanged IDOR).
    var anonOwned = await helpers.httpRequest({ port: port, path: "/orders/" + ownedOrderId, jar: helpers.cookieJar() });
    check("anonymous on owned order → 404",         anonOwned.status === 404);

    // ===================================================================
    // F. /reorder is gated identically to GET
    // ===================================================================
    // Placing browser can reorder its own guest order.
    var reorderOwn = await helpers.httpRequest({ port: port, path: "/orders/" + orderId + "/reorder", method: "POST", jar: jarA });
    check("placing browser reorder → 303",          reorderOwn.status === 303 &&
      (reorderOwn.headers.location || "").indexOf("/orders/" + orderId) === 0);
    // Anonymous bare-UUID reorder of the guest order → 404 (no content leak,
    // no cart rebuild).
    var reorderAnon = await helpers.httpRequest({ port: port, path: "/orders/" + orderId + "/reorder", method: "POST", jar: helpers.cookieJar() });
    check("anonymous reorder of guest order → 404", reorderAnon.status === 404);
    // Emailed token also authorizes reorder from a fresh device.
    var reorderTokenJar = helpers.cookieJar();
    var reorderToken = await helpers.httpRequest({
      port: port, path: "/orders/" + orderId + "/reorder?k=" + encodeURIComponent(token), method: "POST", jar: reorderTokenJar,
    });
    check("emailed-token reorder → 303",            reorderToken.status === 303);

    // ===================================================================
    // G. Stripe-return PRG: the access cookie set at confirm survives the
    //    redirect_status=succeeded round-trip + records the funnel event.
    // ===================================================================
    // Build a Stripe-intent order (not gift-card-covered) so confirm lands on
    // /pay; the placing browser still gets the access cookie at confirm. Then
    // simulate Stripe's return: GET /orders/:id?redirect_status=succeeded with
    // the placing jar → 303 PRG to the bare URL, access preserved.
    var jarG = await _freshCart();
    var coG = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jarG,
      form: { email: "stripe@example.com", name: "Stripe Buyer", line1: "7 Pay Rd", city: "SF", country: "US", state: "CA", postal: "94103" },
    });
    check("stripe-path checkout → 303 /pay",        coG.status === 303 &&
      (coG.headers.location || "").indexOf("/pay/") === 0);
    check("stripe-path confirm stamped access cookie", !!_setCookieNamed(coG, "shop_oacc"));
    var payOrderId = (coG.headers.location || "").replace("/pay/", "");

    // Stripe returns the buyer to /orders/:id?redirect_status=succeeded in the
    // PLACING browser (jarG holds the access cookie) → 303 PRG.
    var stripeReturn = await helpers.httpRequest({
      port: port, path: "/orders/" + payOrderId + "?redirect_status=succeeded", jar: jarG,
    });
    check("stripe return PRG → 303 bare URL",       stripeReturn.status === 303 &&
      (stripeReturn.headers.location || "") === "/orders/" + payOrderId);
    // After the PRG strip the bare URL still resolves for the placing browser
    // (the access cookie carried through; the ?k= was never needed here).
    var afterPrg = await helpers.httpRequest({ port: port, path: "/orders/" + payOrderId, jar: jarG });
    check("post-PRG bare URL (cookie) → 200",       afterPrg.status === 200);
    check("post-PRG page shows the address",        afterPrg.body.indexOf("7 Pay Rd") !== -1);
    // Same bare URL from a stranger → 404 (the PRG didn't widen access).
    var strangerAfterPrg = await helpers.httpRequest({ port: port, path: "/orders/" + payOrderId, jar: helpers.cookieJar() });
    check("post-PRG stranger → 404",                strangerAfterPrg.status === 404);
  } finally {
    if (handle) await _teardownApp(handle);
  }
}

module.exports = { run: _run };
