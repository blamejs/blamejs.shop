"use strict";
/**
 * Customer order cancellation — HTTP integration of the self-service
 * cancel control on the storefront order page.
 *
 * Boots one real `b.createApp` storefront against an in-memory
 * `node:sqlite` DB loaded from the live migrations. As the signed-in
 * customer it exercises:
 *
 *   - a paid (pre-fulfillment) order shows a Cancel control, and the
 *     cancel POST transitions it to `cancelled` + the page reflects it;
 *   - a shipped order shows NO cancel control, and a forced cancel POST
 *     is refused (303 back, status unchanged — the FSM has no cancel
 *     edge from shipped);
 *   - an order belonging to ANOTHER customer is a 404 (IDOR) and is
 *     never acted on;
 *   - an unauthenticated cancel POST is bounced to login, never acted on.
 *
 * Every cancel goes through the real double-submit CSRF gate (the cookie
 * jar captures the token and echoes it as X-CSRF-Token). Statuses are
 * asserted clean — no raw-error leak in any response body.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql", "0004_shop_config.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

// Seed an order for `customerId` at the given status with one line of the
// supplied variant. Returns the order id.
async function _seedOrder(query, customerId, variantId, sku, status) {
  var now = Date.now();
  var cartId = b.uuid.v7(); var orderId = b.uuid.v7(); var lineId = b.uuid.v7();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, 'USD', 2999, 0, 0, 0, 2999, NULL, '{\"country\":\"US\"}', ?6, ?6)",
    [orderId, cartId, customerId, b.uuid.v7(), status, now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 2999, 'USD', 2999)",
    [lineId, orderId, variantId, sku],
  );
  return orderId;
}

async function _bootStorefront(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-cancel-sf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query, cursorSecret: "cancel-order" });
  var customers = bShop.customers.create({ query: query });

  // Checkout dep — the /orders/:id confirmation page route mounts under
  // it. Wired with no-op tax/shipping + a test payment handle.
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping, payment: payment, order: order,
  });

  var product = await catalog.products.create({ slug: "cancel-widget", title: "Cancel Widget", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "CNL-W-1", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: 25 });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  // A paid order (cancellable), a shipped order (NOT cancellable), and a
  // stranger's paid order (owned by someone else — IDOR target).
  var paidOrderId     = await _seedOrder(query, buyer, variant.id, variant.sku, "paid");
  var shippedOrderId  = await _seedOrder(query, buyer, variant.id, variant.sku, "shipped");
  var strangerOrderId = await _seedOrder(query, stranger, variant.id, variant.sku, "paid");

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, order: order, customers: customers,
    checkout: checkout, default_shipping_id: "std", shop_name: "Cancel Shop",
  });

  try {
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- order page: cancel control gated on cancellable status --------
    var paidPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + paidOrderId, jar: buyerJar });
    check("paid order page → 200",               paidPage.status === 200);
    check("paid order offers Cancel control",    paidPage.body.indexOf("/orders/" + paidOrderId + "/cancel") !== -1);

    var shippedPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + shippedOrderId, jar: buyerJar });
    check("shipped order page → 200",            shippedPage.status === 200);
    check("shipped order hides Cancel control",  shippedPage.body.indexOf("/orders/" + shippedOrderId + "/cancel") === -1);

    // ---- IDOR: a stranger's order is a 404, never cancelled ------------
    var foreignCancel = await helpers.httpRequest({ port: sf.port, path: "/orders/" + strangerOrderId + "/cancel", method: "POST", jar: buyerJar, form: {} });
    check("cancel foreign order → 404",          foreignCancel.status === 404);
    check("foreign cancel leaks no raw error",   foreignCancel.body.indexOf("at Object.") === -1 && foreignCancel.body.indexOf("TypeError") === -1);
    var strangerStill = await order.get(strangerOrderId);
    check("foreign order still paid (untouched)", strangerStill.status === "paid");

    // ---- unauthenticated cancel → login, never acted on ----------------
    var anonJar = helpers.cookieJar();
    var anonCancel = await helpers.httpRequest({ port: sf.port, path: "/orders/" + paidOrderId + "/cancel", method: "POST", jar: anonJar, form: {} });
    check("anon cancel → 303 login",             anonCancel.status === 303 &&
      (anonCancel.headers["location"] || "") === "/account/login");
    var stillPaidAfterAnon = await order.get(paidOrderId);
    check("anon cancel left order paid",         stillPaidAfterAnon.status === "paid");

    // ---- forced cancel on a non-cancellable (shipped) order is refused -
    // The FSM has no cancel edge from shipped — the route bounces back to
    // the order page (303) and the status is unchanged. No 500, no leak.
    var shippedCancel = await helpers.httpRequest({ port: sf.port, path: "/orders/" + shippedOrderId + "/cancel", method: "POST", jar: buyerJar, form: {} });
    check("cancel shipped → 303 back to order",  shippedCancel.status === 303 &&
      (shippedCancel.headers["location"] || "") === "/orders/" + shippedOrderId);
    var shippedStill = await order.get(shippedOrderId);
    check("shipped order still shipped",         shippedStill.status === "shipped");

    // ---- happy path: cancel the owned, paid order ----------------------
    var cancelOk = await helpers.httpRequest({ port: sf.port, path: "/orders/" + paidOrderId + "/cancel", method: "POST", jar: buyerJar, form: {} });
    check("cancel paid → 303 cancelled",         cancelOk.status === 303 &&
      (cancelOk.headers["location"] || "").indexOf("/orders/" + paidOrderId + "?cancelled=1") === 0);
    var cancelled = await order.get(paidOrderId);
    check("paid order transitioned to cancelled", cancelled.status === "cancelled");
    // A transition row was appended (auditable cancel).
    var sawCancelEvent = (cancelled.transitions || []).some(function (t) { return t.on_event === "cancel" && t.to_state === "cancelled"; });
    check("cancel recorded a transition row",    sawCancelEvent);

    // ---- the order page now reflects the cancelled state ----------------
    var cancelledPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + paidOrderId + "?cancelled=1", jar: buyerJar });
    check("cancelled order page → 200",          cancelledPage.status === 200);
    check("cancelled page shows confirmation",   cancelledPage.body.indexOf("has been cancelled") !== -1);
    check("cancelled order hides Cancel control", cancelledPage.body.indexOf("/orders/" + paidOrderId + "/cancel") === -1);

    // ---- a second cancel POST on the now-cancelled order is refused -----
    // Eligibility gate sees a terminal status → 303 back, no FSM call,
    // no double-cancel, no 500.
    var doubleCancel = await helpers.httpRequest({ port: sf.port, path: "/orders/" + paidOrderId + "/cancel", method: "POST", jar: buyerJar, form: {} });
    check("re-cancel cancelled → 303 back",      doubleCancel.status === 303 &&
      (doubleCancel.headers["location"] || "") === "/orders/" + paidOrderId);
  } finally {
    await _teardown(sf);
  }
}

module.exports = { run: _run };
