"use strict";
/**
 * Order history + reorder + tracking — full HTTP integration of the
 * customer order surface AND the admin shipment/tracking panel.
 *
 * Boots two real `b.createApp` servers against one shared in-memory
 * `node:sqlite` DB (loaded from the live migrations incl. 0021_shipments):
 *
 *   - storefront, wired with catalog + cart + order + orderTracking +
 *     customers, exercising /account/orders (the history list the returns
 *     CTA points at), the per-order Reorder POST (rebuilds a cart from a
 *     past order's lines), and the order page's status timeline + carrier
 *     tracking panel.
 *   - admin, wired with a token + catalog + order + orderTracking, driving
 *     the order detail's "Add a shipment" + "Record event" forms and
 *     asserting the panel reflects them.
 *
 * Covers the ownership gate on reorder (a stranger's order then 404), the
 * eligibility gate (a pending order isn't reorderable), and the
 * order→FSM drive when a shipment is marked delivered.
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

var TOKEN = "admin-token-0123456789abcdef-trk"; // ≥ 16 chars

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
            "0006_customers.sql", "0004_shop_config.sql", "0021_shipments.sql"]
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
// supplied variant. Returns the order id + line id.
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
    "VALUES (?1, ?2, ?3, ?4, 2, 2999, 'USD', 5998)",
    [lineId, orderId, variantId, sku],
  );
  return { orderId: orderId, lineId: lineId };
}

async function _bootStorefront(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-oht-sf-"));
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

async function _bootAdmin(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-oht-ad-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, deps);
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
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "oht-order" });
  var tracking = bShop.orderTracking.create({ query: query, order: order });
  var config  = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query });

  // Checkout dep — the /orders/:id confirmation page is gated on it (it's
  // the post-checkout receipt). Wired with no-op tax/shipping + a test
  // payment handle so the order page route mounts; reorder is independent
  // (top-level, needs only cart + order).
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping, payment: payment, order: order,
  });

  var product = await catalog.products.create({ slug: "track-widget", title: "Track Widget", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "TRK-W-1", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: 25 });

  var buyer = b.uuid.v7();
  var stranger = b.uuid.v7();
  // A shipped order (eligible for return + reorder + tracking) and a still-
  // pending order (NOT reorderable).
  var shippedOrder = await _seedOrder(query, buyer, variant.id, variant.sku, "shipped");
  var pendingOrder = await _seedOrder(query, buyer, variant.id, variant.sku, "pending");
  var strangerOrder = await _seedOrder(query, stranger, variant.id, variant.sku, "paid");

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, order: order, orderTracking: tracking, customers: customers,
    checkout: checkout, default_shipping_id: "std", shop_name: "Track Shop",
  });
  var admin = await _bootAdmin({
    token: TOKEN, catalog: catalog, order: order, orderTracking: tracking, config: config,
    shop_name: "Track Shop",
  });

  try {
    var cookie = helpers.authCookie(b, buyer);

    // ---- /account/orders history list -----------------------------------
    var anon = await helpers.httpRequest({ port: sf.port, path: "/account/orders" });
    check("anon order list → 303 login",        anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    var list = await helpers.httpRequest({ port: sf.port, path: "/account/orders", headers: { cookie: cookie } });
    check("order list → 200",                   list.status === 200);
    check("order list titled Your orders",      list.body.indexOf("Your orders") !== -1);
    check("order list shows shipped order",     list.body.indexOf("/orders/" + shippedOrder.orderId) !== -1);
    check("order list shows pending order",     list.body.indexOf("/orders/" + pendingOrder.orderId) !== -1);
    // Shipped order offers a Return link; pending one does not (but both
    // offer Reorder except pending which is excluded).
    check("list offers a Return affordance",    list.body.indexOf("/account/orders/" + shippedOrder.orderId + "/return") !== -1);
    check("list offers a Reorder affordance",   list.body.indexOf("/orders/" + shippedOrder.orderId + "/reorder") !== -1);
    check("list omits reorder for pending",     list.body.indexOf("/orders/" + pendingOrder.orderId + "/reorder") === -1);

    // ---- order page: timeline + actions (no tracking yet) ----------------
    var orderPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + shippedOrder.orderId, headers: { cookie: cookie } });
    check("order page → 200",                   orderPage.status === 200);
    check("order page shows status timeline",   orderPage.body.indexOf("order-timeline") !== -1);
    check("timeline marks shipped current",     orderPage.body.indexOf("is-current") !== -1);
    check("order page offers Request a return",  orderPage.body.indexOf("/account/orders/" + shippedOrder.orderId + "/return") !== -1);
    check("order page offers Reorder",           orderPage.body.indexOf("/orders/" + shippedOrder.orderId + "/reorder") !== -1);
    check("no tracking panel before a shipment", orderPage.body.indexOf("order-tracking-panel") === -1);

    // ---- reorder: ownership + eligibility + cart rebuild -----------------
    // Stranger's order → 404 (no leak), pending → bounce, shipped → cart.
    var foreignReorder = await helpers.httpRequest({ port: sf.port, path: "/orders/" + strangerOrder.orderId + "/reorder", method: "POST", headers: { cookie: cookie }, form: {} });
    check("reorder foreign order → 404",        foreignReorder.status === 404);

    var pendingReorder = await helpers.httpRequest({ port: sf.port, path: "/orders/" + pendingOrder.orderId + "/reorder", method: "POST", headers: { cookie: cookie }, form: {} });
    check("reorder pending → 303 back to order", pendingReorder.status === 303 &&
      (pendingReorder.headers["location"] || "") === "/orders/" + pendingOrder.orderId);

    var jar = helpers.cookieJar();
    var reorder = await helpers.httpRequest({ port: sf.port, path: "/orders/" + shippedOrder.orderId + "/reorder", method: "POST", headers: { cookie: cookie }, form: {}, jar: jar });
    check("reorder → 303 reordered",            reorder.status === 303 &&
      (reorder.headers["location"] || "").indexOf("/orders/" + shippedOrder.orderId + "?reordered=1") === 0);
    // The reorder set a session cookie; the rebuilt cart holds the line.
    var sid = jar.get("shop_sid") || jar.get("sid");
    check("reorder set a session cookie",       !!sid);
    // Follow the cart to confirm the line landed.
    var cartPage = await helpers.httpRequest({ port: sf.port, path: "/cart", jar: jar });
    check("reordered cart shows the SKU",        cartPage.body.indexOf("TRK-W-1") !== -1);
    // The redirected order page carries the confirmation banner.
    var reordered = await helpers.httpRequest({ port: sf.port, path: "/orders/" + shippedOrder.orderId + "?reordered=1", headers: { cookie: cookie } });
    check("order page shows reorder banner",     reordered.body.indexOf("added to your cart") !== -1);

    // ---- admin: attach a shipment, record an event ----------------------
    var ajar = helpers.cookieJar();
    var alogin = await helpers.httpRequest({ port: admin.port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: ajar });
    check("admin login → 303",                  alogin.status === 303);

    var detail = await helpers.httpRequest({ port: admin.port, path: "/admin/orders/" + shippedOrder.orderId, jar: ajar });
    check("admin order detail → 200",           detail.status === 200);
    check("detail has shipments panel",          detail.body.indexOf("Shipments &amp; tracking") !== -1);
    check("detail offers Add a shipment",        detail.body.indexOf("/admin/orders/" + shippedOrder.orderId + "/shipments\"") !== -1);
    check("detail shows no shipments yet",       detail.body.indexOf("No shipments yet") !== -1);

    var addShip = await helpers.httpRequest({ port: admin.port, path: "/admin/orders/" + shippedOrder.orderId + "/shipments", method: "POST", jar: ajar, form: { carrier: "ups", tracking_number: "1Z999AA10123456784" } });
    check("add shipment → 303 ship",            addShip.status === 303 && (addShip.headers["location"] || "").indexOf("ship=1") !== -1);
    var shipments = await tracking.listForOrder(shippedOrder.orderId);
    check("shipment persisted",                 shipments.length === 1 && shipments[0].carrier === "ups");
    var shipmentId = shipments[0].id;

    // The detail now shows the carrier + a linked UPS tracking URL.
    var detail2 = await helpers.httpRequest({ port: admin.port, path: "/admin/orders/" + shippedOrder.orderId, jar: ajar });
    check("detail lists the shipment carrier",   detail2.body.indexOf(">ups<") !== -1 || detail2.body.indexOf("ups") !== -1);
    check("detail links the UPS tracking URL",   detail2.body.indexOf("ups.com/track") !== -1);
    check("detail offers Record event",          detail2.body.indexOf("/shipments/" + shipmentId + "/events") !== -1);

    var recordEv = await helpers.httpRequest({ port: admin.port, path: "/admin/orders/" + shippedOrder.orderId + "/shipments/" + shipmentId + "/events", method: "POST", jar: ajar, form: { status: "in-transit", location: "Louisville, KY" } });
    check("record event → 303 ship",            recordEv.status === 303 && (recordEv.headers["location"] || "").indexOf("ship=1") !== -1);
    var hydrated = await tracking.getShipment(shipmentId);
    check("event recorded + status advanced",    hydrated.status === "in-transit" && hydrated.events.length >= 1);

    // ---- customer order page now renders the tracking panel -------------
    var trackedPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + shippedOrder.orderId, headers: { cookie: cookie } });
    check("order page now has tracking panel",   trackedPage.body.indexOf("order-tracking-panel") !== -1);
    check("tracking panel shows the carrier",     trackedPage.body.indexOf("order-shipment__carrier") !== -1);
    check("tracking panel links the carrier URL", trackedPage.body.indexOf("ups.com/track") !== -1);

    // ---- order FSM drive: mark a shipment delivered → order delivered ---
    // Record a delivered event, then markDelivered drives the order FSM.
    await tracking.markDelivered(shipmentId);
    var afterDeliver = await order.get(shippedOrder.orderId);
    check("markDelivered drove order FSM",       afterDeliver.status === "delivered");
  } finally {
    await _teardown(sf);
    await _teardown(admin);
  }
}

module.exports = { run: _run };
