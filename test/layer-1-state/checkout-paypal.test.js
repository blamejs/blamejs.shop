"use strict";
/**
 * Checkout — PayPal (Orders v2) orchestration. Stubs the PayPal adapter (no
 * network) and exercises createPaypalOrder → capturePaypalOrder → paid, plus
 * the handlePaypalEvent webhook backstop (capture-completed + refunded,
 * idempotent on re-delivery). Uses one in-memory node:sqlite DB.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql"]
  .map(function (f) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f); });

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

function _fakePaypal() {
  var n = 0;
  var pp = {
    name: "fake-paypal",
    captureCalls: 0,
    createOrder: async function (input) { n += 1; return { id: "PP-ORDER-" + n, status: "CREATED", _amount: input.amount_minor, _currency: input.currency }; },
    captureOrder: async function (id) {
      pp.captureCalls += 1;
      return { id: id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "PP-CAP-" + id, status: "COMPLETED" }] } }] };
    },
    getOrder: async function (id) { return { id: id, status: "APPROVED" }; },
    refund: async function () { return { id: "PP-REF-1", status: "COMPLETED" }; },
    verifyWebhook: async function (_headers, rawBody) {
      try { return { ok: true, event: JSON.parse(rawBody) }; } catch (_e) { return { ok: false, reason: "malformed-body" }; }
    },
  };
  return pp;
}

async function _setup() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query, cursorSecret: "co-pp" });
  var tax      = bShop.tax.create({ rules: [{ country: "US", state: "CA", rate_bps: 875 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_" + b.crypto.generateToken(8) });
  var paypal   = _fakePaypal();
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order, paypal: paypal,
  });
  var p = await catalog.products.create({ slug: "pp-test", title: "PP Test", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "PP-1", weight_grams: 250 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
  return { query: query, cart: cart, order: order, checkout: checkout, variant: v, paypal: paypal };
}

async function _newCart(s) {
  var sid = b.uuid.v7();
  var c = await s.cart.create(sid, { currency: "USD" });
  await s.cart.addLine(c.id, { variant_id: s.variant.id, qty: 2 });
  return c;
}

function _input(cartId) {
  return {
    cart_id: cartId,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "pp-key-" + b.uuid.v7(),
  };
}

async function _createAndCapture() {
  var s = await _setup();
  var c = await _newCart(s);
  var created = await s.checkout.createPaypalOrder(_input(c.id));
  check("createPaypalOrder returns a paypal order id", /^PP-ORDER-/.test(created.paypal_order_id));
  check("local order is pending",                      created.order.status === "pending");
  check("order links the paypal order id",             created.order.payment_intent_id === created.paypal_order_id);
  check("cart marked converted",                      (await s.cart.get(c.id)).status === "converted");

  var cap = await s.checkout.capturePaypalOrder(created.paypal_order_id);
  check("capture handled",                             cap.handled === true);
  check("capture id surfaced",                         /^PP-CAP-/.test(cap.capture_id));
  check("order advanced to paid",                      cap.order.status === "paid");

  // Re-capture (retry) is idempotent AND must NOT hit PayPal again (a second
  // remote capture would be rejected — orders capture once).
  var recap = await s.checkout.capturePaypalOrder(created.paypal_order_id);
  check("re-capture leaves order paid",                recap.order.status === "paid" && recap.skipped === "already-advanced");
  check("re-capture did not call PayPal again",        s.paypal.captureCalls === 1);
}

async function _webhookBackstop() {
  var s = await _setup();
  var c = await _newCart(s);
  var created = await s.checkout.createPaypalOrder(_input(c.id));
  var ppId = created.paypal_order_id;

  // A CAPTURE.COMPLETED webhook (buyer captured out of band) marks it paid.
  var evt = JSON.stringify({
    id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "CAP-X", supplementary_data: { related_ids: { order_id: ppId } } },
  });
  var r1 = await s.checkout.handlePaypalEvent({ headers: { "paypal-transmission-id": "t" }, rawBody: evt });
  check("webhook capture-completed handled",           r1.handled === true);
  check("webhook advanced order to paid",              r1.order.status === "paid");

  // Re-delivery is idempotent (already advanced).
  var r2 = await s.checkout.handlePaypalEvent({ headers: {}, rawBody: evt });
  check("webhook re-delivery skipped",                 r2.handled === true && r2.skipped === "already-advanced");

  // An unknown event type is a no-op.
  var r3 = await s.checkout.handlePaypalEvent({ headers: {}, rawBody: JSON.stringify({ event_type: "BILLING.SUBSCRIPTION.CREATED", resource: {} }) });
  check("unknown event type not handled",              r3.handled === false);

  // A refund webhook on the paid order refunds it.
  var c2 = await _newCart(s);
  var created2 = await s.checkout.createPaypalOrder(_input(c2.id));
  await s.checkout.capturePaypalOrder(created2.paypal_order_id);
  var refundEvt = JSON.stringify({
    id: "WH-2", event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: { id: "REF-X", supplementary_data: { related_ids: { order_id: created2.paypal_order_id } } },
  });
  var r4 = await s.checkout.handlePaypalEvent({ headers: {}, rawBody: refundEvt });
  check("refund webhook refunds the order",            r4.handled === true && r4.order.status === "refunded");
}

async function _validation() {
  var s = await _setup();
  var c = await _newCart(s);
  await helpers.assert.rejects(s.checkout.createPaypalOrder({ cart_id: c.id, selected_shipping_id: "std", customer: { email: "x@y.com" } }), /idempotency_key/);
  // Adapter absent → methods throw.
  var bare = bShop.checkout.create({
    catalog: bShop.catalog.create({ query: s.query }), cart: s.cart, pricing: bShop.pricing,
    tax: bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] }),
    shipping: bShop.shipping.create({ services: [{ id: "std", label: "S", zones: [{ country: "US", flat_amount_minor: 0 }] }] }),
    payment: bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" }), order: s.order,
    // no `paypal` dep → the PayPal methods must throw.
  });
  await helpers.assert.rejects(bare.createPaypalOrder(_input(c.id)), /paypal adapter not wired/);
}

async function run() {
  await _createAndCapture();
  await _webhookBackstop();
  await _validation();
}

module.exports = { run: run };
