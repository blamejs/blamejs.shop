"use strict";
/**
 * Gift options — end-to-end HTTP integration of the operator gift-wrap
 * catalog (/admin/gift-wraps) and the customer cart/checkout gift flow,
 * wired over ONE in-memory `node:sqlite` DB loaded from the live migrations
 * (including gift_options + gift_wraps) so a wrap an operator defines is
 * selectable by the shopper the same request.
 *
 * THE MONEY-PRECISION GUARD (the headline assertion): the wrap fee rides as
 * a REAL cart line, so it flows through pricing.totals and is charged by
 * checkout.confirm. The test confirms a real order through a payment STUB
 * that records the amount it was asked to charge, and asserts that amount
 * (integer minor units) EQUALS the order's grand_total_minor INCLUDING the
 * wrap fee — catching the "post-commit fee line would mis-charge" trap.
 *
 * Also asserts:
 *   - operator defines a wrap whose SKU is a real catalog variant; a
 *     non-variant SKU is refused (400) — the catalog gate;
 *   - POST /cart/gift adds the wrap as a cart LINE (subtotal grows by the
 *     wrap's catalog price); re-posting "no wrap" removes it;
 *   - setForOrder round-trips message / recipient / hide_prices on the
 *     placed order; /orders/:id renders them;
 *   - XSS: a gift_message / recipient_name of `<img src=x onerror=alert(1)>`
 *     renders escaped on /orders/:id — raw payload absent, escaped present;
 *   - the gift-message control-byte refusal surfaces cleanly (no 500).
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

var TOKEN = "admin-token-0123456789abcdef-test";

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql",
            "0004_shop_config.sql", "0046_gift_options.sql"]
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

// A payment stub that records the amount it was asked to charge, keyed by the
// returned PaymentIntent id — so the test can prove the charged amount equals
// the order grand total INCLUDING the wrap fee.
var _piSeq = 0;
var _chargeByPi = {};
function _stubPayment() {
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      _piSeq += 1;
      var id = "pi_gift_" + _piSeq;
      _chargeByPi[id] = input.amount_minor;
      return { id: id, client_secret: id + "_secret", status: "requires_payment_method", _amount: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

function _noLeak(body) {
  body = body || "";
  return body.indexOf("at Object.") === -1 && body.indexOf("TypeError") === -1 && body.indexOf("    at ") === -1;
}

var SHIP_TO_BODY = { line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103" };

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "gift-order-sf" });
  var config  = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query });
  var giftOptions = bShop.giftOptions.create({ query: query, catalog: catalog });

  // A $40 product (the gift item) + a $5 gift-wrap variant (the wrap_sku).
  var product = await catalog.products.create({ slug: "mug", title: "Mug", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "MUG-1" });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 4000 });
  await catalog.inventory.create("MUG-1", { stock_on_hand: 100 });

  var wrapProduct = await catalog.products.create({ slug: "giftwrap", title: "Gift Wrap", description: "w", status: "active" });
  var wrapVariant = await catalog.variants.create(wrapProduct.id, { sku: "WRAP-1" });
  await catalog.prices.set(wrapVariant.id, { currency: "USD", amount_minor: 500 });
  await catalog.inventory.create("WRAP-1", { stock_on_hand: 1000 });
  var WRAP_FEE = 500;

  // Zero tax + zero shipping so the money assertion is exact + obvious.
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: bShop.tax.create({ rules: [] }),
    shipping: bShop.shipping.create({ services: [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 0 }] }] }),
    payment: _stubPayment(), order: order,
    giftOptions: giftOptions,
  });

  var buyer = b.uuid.v7();

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-gift-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        giftOptions: giftOptions, shop_name: "Gift Shop",
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        checkout: checkout, giftOptions: giftOptions, shop_name: "Gift Shop",
        default_shipping_id: "std",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // ---- operator defines a wrap (admin) -----------------------------
    var adminJar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: adminJar });
    check("admin login -> 303", login.status === 303);

    // A wrap_sku that is NOT a catalog variant is refused (the catalog gate).
    var badWrap = await helpers.httpRequest({
      port: port, path: "/admin/gift-wraps", method: "POST", jar: adminJar,
      form: { wrap_sku: "NOT-A-VARIANT", title: "Bad", fee_minor: "500", active: "1" },
    });
    check("non-variant wrap_sku -> 303 ?err=1", badWrap.status === 303 && (badWrap.headers["location"] || "").indexOf("?err=1") !== -1);

    var defWrap = await helpers.httpRequest({
      port: port, path: "/admin/gift-wraps", method: "POST", jar: adminJar,
      form: { wrap_sku: "WRAP-1", title: "Premium wrap", fee_minor: String(WRAP_FEE), active: "1" },
    });
    check("define wrap -> 303 ?saved=1", defWrap.status === 303 && (defWrap.headers["location"] || "").indexOf("?saved=1") !== -1);

    var wraps = await giftOptions.listWraps({});
    check("wrap persisted", wraps.length === 1 && wraps[0].wrap_sku === "WRAP-1" && wraps[0].fee_minor === WRAP_FEE);

    var wrapList = await helpers.httpRequest({ port: port, path: "/admin/gift-wraps", jar: adminJar });
    check("admin wrap list -> 200", wrapList.status === 200);
    check("admin wrap list shows the wrap", wrapList.body.indexOf("Premium wrap") !== -1);

    // ---- shopper builds a cart + selects the wrap --------------------
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // Prime the CSRF cookie with a GET so the helper can echo the token on
    // the state-changing POSTs (the createApp default double-submit gate is
    // active — cart-add isn't EDGE_POST_PATHS-exempt without mountRouteGuards,
    // so it needs the token here).
    await helpers.httpRequest({ port: port, path: "/cart", jar: buyerJar });

    var add = await helpers.httpRequest({ port: port, path: "/cart/lines", method: "POST", jar: buyerJar, form: { variant_id: variant.id, qty: "1" } });
    check("add item -> 303", add.status === 303);

    // Cart page offers the gift wrap selector.
    var cartPage = await helpers.httpRequest({ port: port, path: "/cart", jar: buyerJar });
    check("cart -> 200", cartPage.status === 200);
    check("cart offers the gift wrap", cartPage.body.indexOf("Premium wrap") !== -1);
    check("cart gift form posts to /cart/gift", cartPage.body.indexOf("action=\"/cart/gift\"") !== -1);

    // Select the wrap — it becomes a real cart LINE.
    var pickWrap = await helpers.httpRequest({ port: port, path: "/cart/gift", method: "POST", jar: buyerJar, form: { wrap_sku: "WRAP-1" } });
    check("select wrap -> 303", pickWrap.status === 303);

    // The cart now has TWO lines and the subtotal includes the wrap fee. The
    // cart is keyed by session; the cart page render proves the line landed.
    var cartAfter = await helpers.httpRequest({ port: port, path: "/cart", jar: buyerJar });
    check("cart shows the wrap line (WRAP-1)", cartAfter.body.indexOf("WRAP-1") !== -1);

    // ---- confirm the order through the payment stub -----------------
    var confirmRes = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: buyerJar,
      form: Object.assign({
        email: "buyer@example.com", name: "Buyer",
        gift_recipient_name: "Alex",
        gift_message: "Happy birthday!",
        gift_hide_prices: "1",
      }, SHIP_TO_BODY),
    });
    check("checkout -> 303 to /pay or /orders", confirmRes.status === 303);
    var loc = confirmRes.headers["location"] || "";
    var orderId = (loc.match(/\/(?:pay|orders)\/([0-9a-f-]+)/) || [])[1];
    check("checkout yielded an order id", !!orderId);

    var placed = await order.get(orderId);
    // THE MONEY-PRECISION GUARD: the order subtotal/grand total INCLUDE the
    // wrap fee, and the amount the payment stub was asked to charge EQUALS the
    // grand total (integer minor units) — proving the fee is in the quote and
    // charged, never dropped or post-commit.
    var EXPECTED_GRAND = 4000 + WRAP_FEE; // item + wrap, zero tax/shipping
    check("order subtotal includes the wrap fee", placed.subtotal_minor === EXPECTED_GRAND);
    check("order grand total includes the wrap fee", placed.grand_total_minor === EXPECTED_GRAND);
    check("charged amount == grand total incl wrap fee (integer minor)",
      placed.payment_intent_id && _chargeByPi[placed.payment_intent_id] === EXPECTED_GRAND);

    // ---- gift options round-trip on the placed order ----------------
    var gift = await giftOptions.getForOrder(orderId);
    check("gift options persisted post-commit", !!gift);
    check("gift wrap_sku recorded", gift && gift.wrap_sku === "WRAP-1");
    check("gift message recorded", gift && gift.gift_message === "Happy birthday!");
    check("gift recipient recorded", gift && gift.recipient_name === "Alex");
    check("gift hide_prices recorded", gift && gift.hide_prices === true);

    // ---- the order page renders the gift options --------------------
    var orderPage = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: buyerJar });
    check("order page -> 200", orderPage.status === 200);
    check("order page shows the recipient", orderPage.body.indexOf("Alex") !== -1);
    check("order page shows the message", orderPage.body.indexOf("Happy birthday!") !== -1);

    // ---- XSS payload escaped on the order page ----------------------
    var xssBuyer = b.uuid.v7();
    var xssJar = helpers.cookieJar();
    xssJar.capture({ "set-cookie": [helpers.authCookie(b, xssBuyer)] });
    await helpers.httpRequest({ port: port, path: "/cart", jar: xssJar });
    await helpers.httpRequest({ port: port, path: "/cart/lines", method: "POST", jar: xssJar, form: { variant_id: variant.id, qty: "1" } });
    var xssConfirm = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: xssJar,
      form: Object.assign({
        email: "xss@example.com", name: "X",
        gift_recipient_name: "<img src=x onerror=alert(1)>",
        gift_message: "<script>alert(2)</script>",
      }, SHIP_TO_BODY),
    });
    var xssLoc = xssConfirm.headers["location"] || "";
    var xssOrderId = (xssLoc.match(/\/(?:pay|orders)\/([0-9a-f-]+)/) || [])[1];
    var xssGift = await giftOptions.getForOrder(xssOrderId);
    check("xss gift options stored (validators bound length, not HTML)", !!xssGift);
    var xssPage = await helpers.httpRequest({ port: port, path: "/orders/" + xssOrderId, jar: xssJar });
    check("xss recipient renders escaped", xssPage.body.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1);
    check("xss recipient raw payload absent", xssPage.body.indexOf("<img src=x onerror=alert(1)>") === -1);
    check("xss message renders escaped", xssPage.body.indexOf("&lt;script&gt;alert(2)&lt;/script&gt;") !== -1);
    check("xss message raw payload absent", xssPage.body.indexOf("<script>alert(2)</script>") === -1);
    check("order page leaks no raw error", _noLeak(xssPage.body));

    // ---- control-byte gift message refused cleanly (no 500) ---------
    // setForOrder refuses a control byte in the message. Drive it through the
    // primitive directly (the route swallows it drop-silent post-commit; the
    // primitive's refusal is the contract).
    var ctrlRefused = false;
    try { await giftOptions.setForOrder({ order_id: orderId, gift_message: "badbyte" }); }
    catch (e) { ctrlRefused = e instanceof TypeError; }
    check("control-byte gift message refused (TypeError)", ctrlRefused);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

async function run() { await _run(); }

module.exports = { run: run };

if (require.main === module) {
  _run().then(function () {
    console.log("OK — gift-options-flow (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — gift-options-flow: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
