"use strict";
/**
 * Loyalty points redeemed at checkout — full HTTP integration of the
 * points-as-credit path, mirroring the gift-card redemption test.
 *
 * Boots a real b.createApp with the storefront checkout wired with a
 * stub Stripe payment + the loyalty primitive, sharing one in-memory
 * SQLite query handle. Exercises:
 *   - the checkout form surfaces a redeem-points field for a signed-in
 *     customer with a balance
 *   - redeeming points reduces the PaymentIntent amount by the credit
 *     (capped at the points' value), the order records the full grand
 *     total it owed, and the points are debited exactly once
 *   - a points request worth more than the order is capped (only the
 *     points the granted credit is worth are spent; the surplus stays)
 *   - points that fully cover the order pay it with NO Stripe intent
 *   - requesting more points than the balance is a 400 (no debit)
 *   - a guest cart (no customer_id) requesting points is a 400
 *
 * Network: zero — every request lands on 127.0.0.1; payment is a stub.
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
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0022_loyalty.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

function _stubPayment() {
  var n = 0;
  var intents = [];
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      n += 1;
      intents.push({ amount_minor: input.amount_minor, currency: input.currency, metadata: input.metadata });
      return { id: "pi_" + n, client_secret: "pi_" + n + "_secret", status: "requires_payment_method" };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
    _intents: intents,
  };
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query, cursorSecret: "loy-credit-sf" });
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = _stubPayment();
  var loyalty  = bShop.loyalty.create({ query: query });   // default ratio: 100 points = $1
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping,
    payment: payment, order: order, loyalty: loyalty,
  });

  // $30.00 product.
  var p = await catalog.products.create({ slug: "loy-prod", title: "Loy Prod", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "LOY-1", weight_grams: 100 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 3000 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-loycr-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, checkout: checkout,
        loyalty: loyalty, default_shipping_id: "std",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  // Seed a signed-in buyer with a 1000-point balance ($10 of credit).
  var buyer = b.uuid.v7();
  await loyalty.earn({ customer_id: buyer, points: 1000, source: "test-seed" });
  var authCookie = helpers.authCookie(b, buyer);

  // Fresh active cart owned by the buyer (checkout reads the cart's
  // customer_id for the loyalty debit). Returns a cookie jar carrying
  // both the session cookie and the auth cookie.
  async function _freshBuyerCart() {
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: v.id, qty: 1 });
    await cart.setCustomer(c.id, buyer);
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/", authCookie] });
    // GET /checkout seeds the double-submit CSRF cookie into the jar so
    // the checkout POST below carries a real X-CSRF-Token (the gate is
    // exercised end-to-end, never bypassed).
    await helpers.httpRequest({ port: port, path: "/checkout", jar: jar });
    return jar;
  }

  try {
    // ---- checkout form surfaces the redeem-points field ---------------
    var jarForm = await _freshBuyerCart();
    var formPage = await helpers.httpRequest({ port: port, path: "/checkout", jar: jarForm });
    check("checkout form then 200",            formPage.status === 200);
    check("form shows redeem-points field",    formPage.body.indexOf("name=\"loyalty_redeem_points\"") !== -1);
    check("form shows the balance helper",      formPage.body.indexOf("1000 points") !== -1);

    // ---- partial credit: redeem 500 points ($5) on a $30 order --------
    var jar1 = await _freshBuyerCart();
    var co1 = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar1,
      form: { email: "buyer@example.com", name: "Buyer", line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103", loyalty_redeem_points: "500" },
    });
    check("checkout w/ 500 points then 303",   co1.status === 303 && (co1.headers.location || "").indexOf("/pay/") === 0);
    var firstIntent = payment._intents[payment._intents.length - 1];
    check("PI reduced by $5 credit",           firstIntent && firstIntent.amount_minor === 2500);
    check("PI metadata records the credit",    firstIntent && firstIntent.metadata.loyalty_applied_minor === "500");
    var orderId1 = (co1.headers.location || "").replace("/pay/", "");
    var o1 = await order.get(orderId1);
    check("order records full grand total",    o1 && o1.grand_total_minor === 3000);
    var bal1 = await loyalty.balance(buyer);
    check("500 points debited",                bal1.balance === 500);
    // The redemption is recorded once, linked to the order.
    var ledger1 = await loyalty.history(buyer, { limit: 10 });
    var redeemRows1 = ledger1.rows.filter(function (t) { return t.transaction_type === "redeem" && t.order_id === orderId1; });
    check("exactly one redeem row for order",  redeemRows1.length === 1 && redeemRows1[0].points === -500);

    // ---- over-value cap: request 500 points worth $5 on a... ----------
    // Re-seed enough balance for a clean cap test. Buyer has 500 left;
    // top up to 5000 ($50). Requesting all 5000 points ($50) against a
    // $30 order caps the credit at $30 → only 3000 points are spent.
    await loyalty.earn({ customer_id: buyer, points: 4500, source: "test-seed" });
    var balBeforeCap = await loyalty.balance(buyer);
    check("balance topped to 5000",            balBeforeCap.balance === 5000);
    var intentsBeforeCap = payment._intents.length;
    var jar2 = await _freshBuyerCart();
    var co2 = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar2,
      form: { email: "b2@example.com", name: "B2", line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103", loyalty_redeem_points: "5000" },
    });
    // $50 of points caps at the $30 order → zero due, paid outright, NO PI.
    check("full-cover checkout then 303",      co2.status === 303);
    check("full-cover skips /pay (→ /orders)", (co2.headers.location || "").indexOf("/orders/") === 0);
    check("full-cover created NO PaymentIntent", payment._intents.length === intentsBeforeCap);
    var orderId2 = (co2.headers.location || "").replace("/orders/", "");
    var o2 = await order.get(orderId2);
    check("full-cover order is paid",          o2 && o2.status === "paid");
    var bal2 = await loyalty.balance(buyer);
    // $30 credit = 3000 points spent; 5000 - 3000 = 2000 left (surplus kept).
    check("only the capped points were spent", bal2.balance === 2000);

    // ---- over-balance request is refused (no debit) -------------------
    var balBeforeOver = (await loyalty.balance(buyer)).balance;
    var jar3 = await _freshBuyerCart();
    var co3 = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar3,
      form: { email: "b3@example.com", name: "B3", line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103", loyalty_redeem_points: "999999" },
    });
    check("over-balance redeem then 400",      co3.status === 400);
    var bal3 = await loyalty.balance(buyer);
    check("over-balance left points untouched", bal3.balance === balBeforeOver);

    // ---- guest cart requesting points is refused ----------------------
    var sidGuest = b.uuid.v7();
    var cg = await cart.create(sidGuest, { currency: "USD" });
    await cart.addLine(cg.id, { variant_id: v.id, qty: 1 });
    var jarGuest = helpers.cookieJar();
    jarGuest.capture({ "set-cookie": ["shop_sid=" + sidGuest + "; Path=/"] });
    // Seed CSRF for the guest jar too: the 400 we assert must come from the
    // route refusing a guest points-redeem, not from the CSRF gate.
    await helpers.httpRequest({ port: port, path: "/checkout", jar: jarGuest });
    var coGuest = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jarGuest,
      form: { email: "guest@example.com", name: "Guest", line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103", loyalty_redeem_points: "100" },
    });
    check("guest redeem-points then 400",      coGuest.status === 400);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
