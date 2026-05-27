"use strict";
/**
 * checkout — orchestrator quote + confirm + webhook dispatch.
 *
 * Layer 1 stitches every prior primitive (catalog, cart, pricing,
 * tax, shipping, payment, order) against in-memory SQLite. Payment
 * outbound HTTP is stubbed via a fake adapter (we test the
 * orchestration, not the Stripe API integration — that's covered by
 * payment.test.js).
 *
 * Coverage:
 *   - quote returns lines + totals + shipping_rates + tax_jurisdiction
 *   - confirm creates a PaymentIntent + order in pending
 *   - confirm marks the cart converted
 *   - confirm refuses zero-total carts
 *   - handleStripeEvent maps payment_intent.succeeded → mark_paid
 *   - handleStripeEvent is idempotent on re-delivery
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");
var nodeCrypto = require("node:crypto");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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

function _fakePayment(webhookSecret) {
  // Tracks calls for assertion + returns canned responses. Verifier
  // is the real one (via the real payment.create against the secret)
  // so webhook tests exercise the actual HMAC-SHA256 path.
  var real = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: webhookSecret });
  var pi_counter = 0;
  return {
    name: "fake-stripe",
    verifyWebhook: real.verifyWebhook,
    createPaymentIntent: async function (input, idempotencyKey) {
      pi_counter += 1;
      return {
        id:            "pi_test_" + pi_counter,
        client_secret: "pi_test_" + pi_counter + "_secret_xxx",
        status:        "requires_payment_method",
        amount:        input.amount_minor,
        currency:      input.currency,
        metadata:      input.metadata,
        _idempotencyKey: idempotencyKey,
      };
    },
  };
}

async function _setup() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var tax     = bShop.tax.create({ rules: [
    { country: "US", state: "CA", rate_bps: 875 },
  ]});
  var shipping = bShop.shipping.create({ services: [
    { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] },
  ]});
  var webhookSecret = "whsec_test_" + bShop.framework.crypto.generateToken(8);
  var payment = _fakePayment(webhookSecret);
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
  });

  // Seed product + variant + price + cart with one line.
  var p = await catalog.products.create({ slug: "co-test", title: "Checkout Test", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "CO-1", weight_grams: 250 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
  return { query: query, catalog: catalog, cart: cart, order: order, payment: payment, checkout: checkout, cartRow: c, sessionId: sid, webhookSecret: webhookSecret, variant: v };
}

async function _quote() {
  var s = await _setup();
  var q = await s.checkout.quote({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
  });
  check("quote returns lines",            q.lines.length === 1);
  check("quote includes shipping rates",   q.shipping_rates.length === 1);
  check("quote selects shipping",          q.selected_shipping.id === "std");
  // subtotal 5998 + tax (5998×875/10000 = 524.825 → banker's 525) + shipping 695 = 7218
  check("quote totals.subtotal",           q.totals.subtotal_minor === 5998);
  check("quote totals.tax",                q.totals.tax_minor === 525);
  check("quote totals.shipping",            q.totals.shipping_minor === 695);
  check("quote totals.grand_total",         q.totals.grand_total_minor === 7218);
  check("quote tax_jurisdiction CA",        q.tax_jurisdiction === "US/CA");
}

async function _confirm() {
  var s = await _setup();
  var idempotencyKey = "idemp_" + nodeCrypto.randomUUID();
  var result = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: idempotencyKey,
  });
  check("confirm returns order",                result.order && result.order.id);
  check("confirm starts in pending",             result.order.status === "pending");
  check("confirm captures payment_intent_id",    result.order.payment_intent_id === result.payment_intent.id);
  check("confirm returns client_secret",         result.payment_intent.client_secret.indexOf("_secret_") !== -1);

  // Cart should now be 'converted'
  var c = await s.cart.get(s.cartRow.id);
  check("confirm marks cart converted",          c.status === "converted");
}

async function _confirmPersistsFullAddress() {
  var s = await _setup();
  var result = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: {
      line1: "500 Market St", line2: "Suite 5", city: "San Francisco",
      country: "US", state: "CA", postal: "94103",
    },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com", name: "Ada Lovelace" },
    idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
  });
  // Re-read through the order model so we exercise the ship_to_json
  // round-trip, not just the in-flight object.
  var stored = await s.order.get(result.order.id);
  check("confirm persists ship_to.line1",  stored.ship_to.line1 === "500 Market St");
  check("confirm persists ship_to.line2",  stored.ship_to.line2 === "Suite 5");
  check("confirm persists ship_to.city",   stored.ship_to.city  === "San Francisco");
  check("confirm persists ship_to.country", stored.ship_to.country === "US");
}

async function _confirmRejectsMalformedAddress() {
  var s = await _setup();
  // A street line beyond the 200-char cap is refused as a client error
  // (TypeError), not silently stored.
  await assert.rejects(s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { line1: "x".repeat(201), city: "Town", country: "US" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
  }), /ship_to\.line1 malformed/);
}

async function _confirmRefusesZeroTotal() {
  // Build a setup where every cost component is zero:
  //   - cart line at 0 minor units
  //   - shipping zone at 0 minor units
  //   - tax 0% (no rules)
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var tax     = bShop.tax.create({ rules: [] });
  var shipping = bShop.shipping.create({ services: [
    { id: "free", label: "Free", zones: [{ country: "US", flat_amount_minor: 0 }] },
  ]});
  var payment = _fakePayment("whsec_zt_xxxxxxxx");
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
  });
  var p = await catalog.products.create({ slug: "zt", title: "ZT", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "ZT-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 0 });
  var c = await cart.create(bShop.framework.uuid.v7(), { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1, unit_amount_minor: 0, unit_currency: "USD" });

  await assert.rejects(checkout.confirm({
    cart_id: c.id,
    ship_to: { country: "US" },
    selected_shipping_id: "free",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_zerototal_xxxxxxxx",
  }), /grand_total_minor must be > 0/);
}

async function _webhookDispatchHappyPath() {
  var s = await _setup();
  var result = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_happy_xxxxxxxx",
  });

  // Build a Stripe webhook event manually.
  var event = {
    id:   "evt_test_1",
    type: "payment_intent.succeeded",
    data: { object: { id: result.payment_intent.id, payment_intent: result.payment_intent.id } },
  };
  var rawBody = JSON.stringify(event);
  var ts = Math.floor(Date.now() / 1000);
  var sig = nodeCrypto.createHmac("sha256", s.webhookSecret).update(ts + "." + rawBody).digest("hex");
  var headers = { "stripe-signature": "t=" + ts + ",v1=" + sig };

  var dispatched = await s.checkout.handleStripeEvent({ headers: headers, rawBody: rawBody });
  check("webhook dispatched ok",              dispatched.handled === true);
  check("webhook fired mark_paid",             dispatched.order.status === "paid");

  // Idempotency: re-deliver the same event.
  var redelivered = await s.checkout.handleStripeEvent({ headers: headers, rawBody: rawBody });
  check("re-delivered webhook is idempotent",  redelivered.handled === true && redelivered.skipped === "already-advanced");
}

async function _webhookBadSig() {
  var s = await _setup();
  var rawBody = "{}";
  var headers = { "stripe-signature": "t=" + Math.floor(Date.now() / 1000) + ",v1=" + "00".repeat(32) };
  await assert.rejects(s.checkout.handleStripeEvent({ headers: headers, rawBody: rawBody }),
    /webhook signature invalid/);
}

async function run() {
  await _quote();
  await _confirm();
  await _confirmPersistsFullAddress();
  await _confirmRejectsMalformedAddress();
  await _confirmRefusesZeroTotal();
  await _webhookDispatchHappyPath();
  await _webhookBadSig();
}

module.exports = { run: run };
