"use strict";
/**
 * Order confirmation page — a malformed (non-UUID) order id must 404,
 * not 500.
 *
 * GET /orders/:order_id calls deps.order.get(orderId), which runs
 * _uuid(id) and THROWS a TypeError on a non-UUID id. The sibling
 * reorder + cancel routes wrap this exact call (catch → TypeError ⇒
 * o = null ⇒ 404); the GET route did not, so GET /orders/<not-a-uuid>
 * surfaced an uncaught TypeError → a noisy generic 500 with the wrong
 * status. This wraps the GET call the same way.
 *
 * Boots one real b.createApp storefront against an in-memory
 * node:sqlite DB loaded from the live migrations, then asserts:
 *
 *   - GET /orders/<malformed-non-uuid>     → 404 (not 500), no raw leak;
 *   - GET /orders/<well-formed-unknown>    → 404;
 *   - GET /orders/<owned order>            → 200 (renders);
 *   - GET /orders/<another customer's>     → 404 (ownership, unchanged).
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-orderid-sf-"));
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

// A 404 not-found render must not carry a raw TypeError / stack trace.
function _noRawLeak(label, body) {
  check(label + ": no 'TypeError' string", String(body).indexOf("TypeError") === -1);
  check(label + ": no stack frame",        String(body).indexOf("at Object.") === -1);
  check(label + ": no UUID-validator text", String(body).toLowerCase().indexOf("not a valid uuid") === -1);
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "order-id-malformed" });
  var customers = bShop.customers.create({ query: query });

  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping, payment: payment, order: order,
  });

  var product = await catalog.products.create({ slug: "id-widget", title: "ID Widget", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "ID-W-1", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: 25 });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  var ownedOrderId    = await _seedOrder(query, buyer, variant.id, variant.sku, "paid");
  var strangerOrderId = await _seedOrder(query, stranger, variant.id, variant.sku, "paid");

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, order: order, customers: customers,
    checkout: checkout, default_shipping_id: "std", shop_name: "OrderId Shop",
  });

  try {
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- (1) a malformed, non-UUID id → 404 (not 500), no raw leak ----
    var malformed = await helpers.httpRequest({ port: sf.port, path: "/orders/not-a-uuid", jar: buyerJar });
    check("malformed id → 404 (not 500)", malformed.status === 404);
    _noRawLeak("malformed id", malformed.body);

    // A second malformed shape (path-traversal-ish garbage) also 404s,
    // never 500s.
    var malformed2 = await helpers.httpRequest({ port: sf.port, path: "/orders/12345-not-a-real-uuid-xyz", jar: buyerJar });
    check("garbage id → 404 (not 500)", malformed2.status === 404);

    // ---- (2) a well-formed but unknown UUID → 404 ----
    var unknownId = b.uuid.v7();
    var unknown = await helpers.httpRequest({ port: sf.port, path: "/orders/" + unknownId, jar: buyerJar });
    check("well-formed unknown id → 404", unknown.status === 404);

    // ---- (3) the buyer's own order still renders 200 ----
    var owned = await helpers.httpRequest({ port: sf.port, path: "/orders/" + ownedOrderId, jar: buyerJar });
    check("owned order → 200", owned.status === 200);

    // ---- (4) a foreign order is a 404 (ownership gate, unchanged) ----
    var foreign = await helpers.httpRequest({ port: sf.port, path: "/orders/" + strangerOrderId, jar: buyerJar });
    check("foreign order → 404", foreign.status === 404);
    _noRawLeak("foreign order", foreign.body);

    // ---- (5) /pay/:order_id carried the IDENTICAL unguarded order.get —
    // a malformed id must 404 there too, not 500. ------------------------
    var payMalformed = await helpers.httpRequest({ port: sf.port, path: "/pay/not-a-uuid", jar: buyerJar });
    check("/pay malformed id → 404 (not 500)", payMalformed.status === 404);
    _noRawLeak("/pay malformed id", payMalformed.body);
  } finally {
    await _teardown(sf);
  }
}

module.exports = { run: _run };
