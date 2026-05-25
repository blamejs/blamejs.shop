"use strict";
/**
 * Order-confirmation recommendations rail.
 *
 * Boots a real b.createApp with the storefront mounted with checkout +
 * order + recommendations, seeds three in-stock products, pins an
 * operator override (product A → product B), records a paid order
 * containing A, and asserts the /orders/:id confirmation page renders a
 * "Customers also bought" rail that surfaces B and never the just-bought
 * A. A missing-engine path degrades to no rail (best-effort). Network: zero.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0043_collections.sql", "0050_recently_viewed.sql", "0105_recommendations.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
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

async function _seedProduct(catalog, slug, title, price) {
  var p = await catalog.products.create({ slug: slug, title: title, status: "active" });
  var sku = "REC-" + slug.toUpperCase();
  var v = await catalog.variants.create(p.id, { sku: sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: price });
  await catalog.inventory.create(sku, { stock_on_hand: 25 });
  return { product: p, variant: v, sku: sku };
}

// Record a paid order containing the supplied (variant, sku) line.
async function _recordOrder(query, variantId, sku) {
  var orderId = b.uuid.v7();
  var cartId  = b.uuid.v7();
  var ts = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, "rec-conf-" + orderId.slice(0, 8), ts, ts + 3600000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 2000, 0, 0, 0, 2000, NULL, '{}', ?4, ?4)",
    [orderId, cartId, "rec-conf-" + orderId.slice(0, 8), ts],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 2000, 'USD', 2000)",
    [b.uuid.v7(), orderId, variantId, sku],
  );
  return orderId;
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query, cursorSecret: "rec-conf" });
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping, payment: payment, order: order,
  });
  var recommendations = bShop.recommendations.create({ query: query, catalog: catalog });

  // A = anchor (bought), B = pinned recommendation, C = decoy filler.
  var A = await _seedProduct(catalog, "anchor", "Anchor Widget", 2000);
  var B = await _seedProduct(catalog, "rec-pinned", "Pinned Companion", 1500);
  await _seedProduct(catalog, "decoy", "Decoy Product", 900);

  // Operator pins A → B on the cart-rail scope (the order confirmation
  // uses recommendForCart, whose override layer is kind "cart") so the
  // rail is deterministic regardless of co-purchase history.
  await recommendations.setOverride({ kind: "cart", source_id: A.product.id, recommended_product_id: B.product.id, weight: 500, position: 0 });

  var orderId = await _recordOrder(query, A.variant.id, A.sku);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-recconf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, checkout: checkout,
        recommendations: recommendations, default_shipping_id: "std",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var page = await helpers.httpRequest({ port: port, path: "/orders/" + orderId });
    check("order confirmation then 200",        page.status === 200);
    check("rail heading rendered",              page.body.indexOf("Customers also bought") !== -1);
    check("rail surfaces the pinned rec (B)",   page.body.indexOf("Pinned Companion") !== -1);
    check("rail links to the rec product",      page.body.indexOf("/products/rec-pinned") !== -1);
    check("rail shows the rec price",           page.body.indexOf("$15.00") !== -1);
    // The just-bought anchor is excluded from the RAIL — never recommend
    // what they bought. (Its product link still appears in the order's own
    // line-item summary above, so scope the check to the rail section.)
    var railPart = page.body.slice(page.body.indexOf("Customers also bought"));
    check("rail excludes the bought anchor",    railPart.indexOf("/products/anchor\"") === -1);
    // The order's own items still render (the rail is additive).
    check("order still shows its line (A sku)", page.body.indexOf(A.sku) !== -1);

    // Unknown order id → 404, not a 500 (rail logic never runs).
    var miss = await helpers.httpRequest({ port: port, path: "/orders/00000000-0000-7000-8000-000000000000" });
    check("unknown order then 404",             miss.status === 404);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
