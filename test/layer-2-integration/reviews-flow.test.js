"use strict";
/**
 * Product reviews — full HTTP integration of the verified-buyer flow.
 *
 * Boots a real `b.createApp` HTTP server with the storefront mounted
 * the way `server.js` mounts it, wired with the reviews + order +
 * customers deps so the auth-gated review routes are live. Catalog +
 * cart + order + reviews all run against one in-memory `node:sqlite`
 * database loaded from the live migrations, so every CHECK / FK the
 * production D1 enforces is exercised end-to-end.
 *
 * Auth: review submission requires a logged-in customer AND a verified
 * purchase. The routes read only `{ customer_id, exp }` from the sealed
 * `shop_auth` cookie (they never load the customer row), so the test
 * mints the cookie directly via `b.vault.seal` after boot rather than
 * driving a WebAuthn ceremony. A paid order is seeded for the "buyer"
 * customer; the "stranger" customer has none.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0006_customers.sql", "0011_reviews.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
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

// Raw-insert a paid order + line so `order.hasPurchasedProduct` sees a
// real purchase. The order FSM defaults new orders to 'pending' (which
// the gate excludes), so we stamp 'paid' directly. cart_id satisfies
// the orders→carts FK.
async function _seedPaidOrder(query, customerId, variantId, sku) {
  var now    = Date.now();
  var cartId = b.uuid.v7();
  var orderId = b.uuid.v7();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 2999, 0, 0, 0, 2999, NULL, '{}', ?5, ?5)",
    [orderId, cartId, customerId, b.uuid.v7(), now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 2999, 'USD', 2999)",
    [b.uuid.v7(), orderId, variantId, sku],
  );
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-rev-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

function _authCookie(customerId) {
  // The same sealed-cookie shape the storefront's _setAuthCookie writes.
  return helpers.authCookie(b, customerId);
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
  var order   = bShop.order.create({ query: query, cursorSecret: "rev-flow-order-cursor" });
  var reviews = bShop.reviews.create({ query: query, cursorSecret: "rev-flow-review-cursor" });
  var customers = bShop.customers.create({ query: query });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "Pro widget.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });

  var buyerId    = b.uuid.v7();
  var strangerId = b.uuid.v7();
  await _seedPaidOrder(query, buyerId, variant.id, variant.sku);

  var handle = await _bootApp({ catalog: catalog, cart: cart, order: order, reviews: reviews, customers: customers });

  try {
    var P = "/products/widget-pro/review";

    // PDP shows the reviews section + CTA, empty state before any review.
    var pdp0 = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows reviews section",            pdp0.body.indexOf("Customer reviews") !== -1);
    check("pdp shows write-a-review CTA",         pdp0.body.indexOf("/products/widget-pro/review") !== -1);
    check("pdp empty-reviews state",              pdp0.body.indexOf("No reviews yet") !== -1);

    // GET form, not logged in → redirect to login.
    var anon = await helpers.httpRequest({ port: handle.port, path: P });
    check("form GET anon → 303",                  anon.status === 303);
    check("form GET anon → /account/login",       (anon.headers["location"] || "") === "/account/login");

    // GET form, logged in but no purchase → ineligible.
    var stranger = await helpers.httpRequest({ port: handle.port, path: P, headers: { cookie: _authCookie(strangerId) } });
    check("form GET stranger → 200",              stranger.status === 200);
    check("form GET stranger → ineligible copy",  stranger.body.indexOf("Only verified buyers") !== -1);
    check("form GET stranger → no form",          stranger.body.indexOf("name=\"rating\"") === -1);

    // GET form, logged in + purchased → the form renders.
    var buyerForm = await helpers.httpRequest({ port: handle.port, path: P, headers: { cookie: _authCookie(buyerId) } });
    check("form GET buyer → 200",                 buyerForm.status === 200);
    check("form GET buyer → rating radios",       buyerForm.body.indexOf("name=\"rating\"") !== -1);
    check("form GET buyer → review-form class",   buyerForm.body.indexOf("class=\"review-form\"") !== -1);

    // POST submit, stranger (no purchase) → 403, re-checked on write.
    var strangerPost = await helpers.httpRequest({
      port: handle.port, path: P, method: "POST",
      headers: { cookie: _authCookie(strangerId) },
      form: { rating: 5, title: "Sneaky", body: "no buy" },
    });
    check("submit stranger → 403",                strangerPost.status === 403);

    // POST submit, buyer, invalid rating → 400 + form with notice.
    var badRating = await helpers.httpRequest({
      port: handle.port, path: P, method: "POST",
      headers: { cookie: _authCookie(buyerId) },
      form: { rating: 9, title: "Out of range", body: "x" },
    });
    check("submit bad rating → 400",              badRating.status === 400);
    check("submit bad rating → notice shown",     badRating.body.indexOf("form-notice--error") !== -1);

    // POST submit, buyer, valid → 200 thanks; review lands pending.
    var ok = await helpers.httpRequest({
      port: handle.port, path: P, method: "POST",
      headers: { cookie: _authCookie(buyerId) },
      form: { rating: 5, title: "Excellent widget", body: "Holds up great." },
    });
    check("submit buyer valid → 200",             ok.status === 200);
    check("submit buyer valid → thanks copy",     ok.body.indexOf("pending moderation") !== -1);

    var pending = await reviews.listByStatus("pending", { limit: 10 });
    check("one pending review persisted",         pending.rows.length === 1);
    check("pending review carries verified flag", Number(pending.rows[0].verified_purchase) === 1);
    var reviewId = pending.rows[0].id;

    // Pending review is NOT shown on the PDP.
    var pdpPending = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp hides pending review",             pdpPending.body.indexOf("Excellent widget") === -1);
    check("pdp still empty-state pre-publish",    pdpPending.body.indexOf("No reviews yet") !== -1);

    // Operator publishes → review surfaces on the PDP with aggregate.
    await reviews.publish(reviewId);
    var pdpPublished = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows published review title",     pdpPublished.body.indexOf("Excellent widget") !== -1);
    check("pdp shows aggregate average 5.0",      pdpPublished.body.indexOf("reviews__average-num\">5.0<") !== -1);
    check("pdp shows verified-buyer badge",       pdpPublished.body.indexOf("Verified buyer") !== -1);
    check("pdp emits aggregateRating JSON-LD",    /"aggregateRating":\{"@type":"AggregateRating","ratingValue":"5.0","reviewCount":1/.test(pdpPublished.body));
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
