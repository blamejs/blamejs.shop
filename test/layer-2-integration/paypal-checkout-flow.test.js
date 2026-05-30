"use strict";
/**
 * PayPal express checkout — full HTTP integration of the storefront routes
 * (Stage C), with a STUB PayPal adapter (no network).
 *
 * Boots a real b.createApp with the storefront mounted with checkout wired to
 * a stub PayPal adapter, the raw-body capture ahead of the JSON parser, and a
 * seeded cart. Exercises POST /checkout/paypal/create → POST
 * /checkout/paypal/capture → order paid, the PayPal button rendering on the
 * checkout page, and the POST /api/webhooks/paypal backstop.
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

function _stubPaypal() {
  var n = 0;
  return {
    name: "fake-paypal",
    createOrder: async function () { n += 1; return { id: "PP-O-" + n, status: "CREATED" }; },
    captureOrder: async function (id) { return { id: id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "PP-C-" + id, status: "COMPLETED" }] } }] }; },
    getOrder: async function (id) { return { id: id, status: "APPROVED" }; },
    refund: async function () { return { id: "PP-R", status: "COMPLETED" }; },
    verifyWebhook: async function (_h, rawBody) { try { return { ok: true, event: JSON.parse(rawBody) }; } catch (_e) { return { ok: false, reason: "bad" }; } },
  };
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query, cursorSecret: "pp-sf" });
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 500 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" });
  var paypal   = _stubPaypal();
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping, payment: payment, order: order, paypal: paypal,
  });

  var p = await catalog.products.create({ slug: "ppsf", title: "PP SF", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "PPSF-1", weight_grams: 100 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-ppsf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // bodyParser off at the app level (as production does in server.js): the
    // webhook signature is verified over the EXACT raw bytes, which an app-
    // level parser would consume before webhookRawBodyCapture (mounted inside
    // routes) can buffer them. CSRF stays ON and reads the X-CSRF-Token
    // header the cookie jar echoes — it never needs the parsed body here.
    middleware: { botGuard: false, rateLimit: false, bodyParser: false },
    routes: function (r) {
      r.use(bShop.storefront.webhookRawBodyCapture(["/api/webhooks/paypal"]));
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, checkout: checkout,
        paypal: paypal, paypal_client_id: "AY-paypal-client-xyz", default_shipping_id: "std",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // Seed a session cart with one line.
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/"] });

    // Checkout page renders the PayPal button when configured.
    var page = await helpers.httpRequest({ port: port, path: "/checkout", jar: jar });
    check("checkout page then 200",            page.status === 200);
    check("PayPal button rendered",            page.body.indexOf("paypal-button-container") !== -1 && page.body.indexOf("paypal.com/sdk/js?client-id=AY-paypal-client-xyz") !== -1);

    // create → returns the PayPal order id + local order id.
    var created = await helpers.httpRequest({ port: port, path: "/checkout/paypal/create", method: "POST", jar: jar,
      body: JSON.stringify({ email: "buyer@example.com", name: "Buyer", country: "US", postal: "94103" }),
      headers: { "content-type": "application/json" } });
    check("paypal create then 200",            created.status === 200);
    var createdBody = JSON.parse(created.body);
    check("create returns a paypal order id",   /^PP-O-/.test(createdBody.id));
    check("create returns the local order id",  typeof createdBody.order_id === "string");
    check("local order starts pending",        (await order.get(createdBody.order_id)).status === "pending");

    // capture → marks the order paid + returns the redirect.
    var captured = await helpers.httpRequest({ port: port, path: "/checkout/paypal/capture", method: "POST", jar: jar,
      body: JSON.stringify({ paypal_order_id: createdBody.id }), headers: { "content-type": "application/json" } });
    check("paypal capture then 200",           captured.status === 200);
    var capBody = JSON.parse(captured.body);
    check("capture marks the order paid",       capBody.status === "paid");
    check("capture redirects to the order",     capBody.redirect === "/orders/" + createdBody.order_id);
    check("order is paid in the db",           (await order.get(createdBody.order_id)).status === "paid");

    // create with no session cart → 400/409, not a 500.
    var noCart = await helpers.httpRequest({ port: port, path: "/checkout/paypal/create", method: "POST",
      body: JSON.stringify({ email: "x@y.com" }), headers: { "content-type": "application/json" } });
    check("create without session then 4xx",   noCart.status >= 400 && noCart.status < 500);

    // capture with a bogus id → 400 (missing) handled; bogus order → not-found.
    var badCap = await helpers.httpRequest({ port: port, path: "/checkout/paypal/capture", method: "POST", jar: jar,
      body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    check("capture without id then 400",       badCap.status === 400);

    // Webhook backstop: a CAPTURE.COMPLETED for a fresh pending order pays it.
    var c2 = await cart.create(b.uuid.v7(), { currency: "USD" });
    await cart.addLine(c2.id, { variant_id: v.id, qty: 1 });
    var jar2 = helpers.cookieJar(); jar2.capture({ "set-cookie": ["shop_sid=" + (await cart.get(c2.id)).session_id + "; Path=/"] });
    // GET /checkout seeds the double-submit CSRF cookie into jar2 so the
    // create POST below carries a real X-CSRF-Token (the gate is exercised).
    await helpers.httpRequest({ port: port, path: "/checkout", jar: jar2 });
    var created2 = JSON.parse((await helpers.httpRequest({ port: port, path: "/checkout/paypal/create", method: "POST", jar: jar2,
      body: JSON.stringify({ email: "b2@example.com", country: "US" }), headers: { "content-type": "application/json" } })).body);
    var evt = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "C-X", supplementary_data: { related_ids: { order_id: created2.id } } } });
    var wh = await helpers.httpRequest({ port: port, path: "/api/webhooks/paypal", method: "POST",
      body: evt, headers: { "content-type": "application/json", "paypal-transmission-id": "t" } });
    check("paypal webhook then 200",           wh.status === 200 && JSON.parse(wh.body).handled === true);
    check("webhook paid the order",            (await order.get(created2.order_id)).status === "paid");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
