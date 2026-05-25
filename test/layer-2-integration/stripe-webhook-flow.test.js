"use strict";
/**
 * Stripe webhook → order completion — full HTTP integration.
 *
 * Payment confirmation is asynchronous: a PaymentIntent succeeds after the
 * customer leaves the pay page, and Stripe POSTs the event to the webhook.
 * This test proves the container webhook route is wired end to end: a
 * correctly-signed `payment_intent.succeeded` drives a seeded order from
 * `pending` to `paid`, the raw body survives the body-parser (the signature
 * is verified over the exact bytes), a bad signature is rejected (400, order
 * untouched), and a re-delivery is idempotent (200, no double transition).
 *
 * Network: zero — every request lands on 127.0.0.1; payment.verifyWebhook
 * is local HMAC, no call to Stripe.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs     = require("node:fs");
var nodeOs     = require("node:os");
var nodePath   = require("node:path");
var nodeCrypto = require("node:crypto");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var WEBHOOK_SECRET = "whsec_test_webhook_flow_0123456789";

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql"]
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

// Stripe's webhook signature: t=<unix>,v1=<hmac-sha256("<t>.<body>", secret)>.
function _sign(secret, ts, body) {
  return nodeCrypto.createHmac("sha256", secret).update(ts + "." + body).digest("hex");
}
function _stripeHeaders(body) {
  var ts = Math.floor(Date.now() / 1000);
  return { "stripe-signature": "t=" + ts + ",v1=" + _sign(WEBHOOK_SECRET, ts, body), "content-type": "application/json" };
}

// Seed a `pending` order carrying `pi` as its payment_intent_id.
async function _seedPendingOrder(query, cart, pi) {
  var sid = "wh-sess-" + b.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  var orderId = b.uuid.v7();
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'pending', 'USD', 2999, 0, 0, 0, 2999, ?4, '{}', NULL, ?5, ?5)",
    [orderId, c.id, sid, pi, Date.now()],
  );
  return orderId;
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "wh-flow" });
  var payment = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: WEBHOOK_SECRET });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: {}, shipping: {}, payment: payment, order: order,
  });

  var paidPi = "pi_test_webhook_paid";
  var badPi  = "pi_test_webhook_bad";
  var paidOrderId = await _seedPendingOrder(query, cart, paidPi);
  var badOrderId  = await _seedPendingOrder(query, cart, badPi);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-wh-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      // Same ordering as server.js: raw-capture BEFORE the body parser.
      r.use(bShop.storefront.webhookRawBodyCapture(["/api/webhooks/stripe"]));
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, order: order, checkout: checkout });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // A correctly-signed payment_intent.succeeded drives pending → paid.
    var paidBody = JSON.stringify({ id: "evt_paid_1", type: "payment_intent.succeeded", data: { object: { id: paidPi } } });
    var ok = await helpers.httpRequest({ port: port, path: "/api/webhooks/stripe", method: "POST",
      headers: _stripeHeaders(paidBody), body: paidBody });
    check("valid webhook then 200",            ok.status === 200);
    check("webhook reports handled",            JSON.parse(ok.body).handled === true);
    check("order advanced pending → paid",     (await order.get(paidOrderId)).status === "paid");

    // Re-delivery of the same event is idempotent — still 200, still paid,
    // no illegal second transition.
    var replay = await helpers.httpRequest({ port: port, path: "/api/webhooks/stripe", method: "POST",
      headers: _stripeHeaders(paidBody), body: paidBody });
    check("replay then 200",                   replay.status === 200);
    check("replay leaves order paid",          (await order.get(paidOrderId)).status === "paid");

    // A tampered signature is rejected (400) and the order is untouched.
    var badBody = JSON.stringify({ id: "evt_bad_1", type: "payment_intent.succeeded", data: { object: { id: badPi } } });
    var bad = await helpers.httpRequest({ port: port, path: "/api/webhooks/stripe", method: "POST",
      headers: { "stripe-signature": "t=" + Math.floor(Date.now() / 1000) + ",v1=" + "00".repeat(32), "content-type": "application/json" },
      body: badBody });
    check("bad-signature webhook then 400",    bad.status === 400);
    check("bad-signature leaves order pending", (await order.get(badOrderId)).status === "pending");

    // An event for an unknown PaymentIntent verifies but is a no-op (200).
    var orphanBody = JSON.stringify({ id: "evt_orphan_1", type: "payment_intent.succeeded", data: { object: { id: "pi_does_not_exist" } } });
    var orphan = await helpers.httpRequest({ port: port, path: "/api/webhooks/stripe", method: "POST",
      headers: _stripeHeaders(orphanBody), body: orphanBody });
    check("unknown-PI webhook then 200",       orphan.status === 200);
    check("unknown-PI reports not handled",     JSON.parse(orphan.body).handled === false);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
