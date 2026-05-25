"use strict";
/**
 * Self-serve returns — full HTTP integration of the customer RMA flow.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * returns + order + customers deps, against one in-memory `node:sqlite`
 * DB loaded from the live migrations. The customer is read from the
 * sealed `shop_auth` cookie (minted via b.vault.seal after boot). A
 * paid order with a line is seeded for the buyer. Covers request /
 * list / the ownership + malformed-id + empty-selection failure modes.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0006_customers.sql", "0023_returns.sql"]
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

// Seed a paid order with one line for `customerId`. Returns the order id
// and the order_line id (the return form keys checkboxes by line id).
async function _seedOrder(query, customerId, variantId, sku) {
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
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 2999, 0, 0, 0, 2999, NULL, '{}', ?5, ?5)",
    [orderId, cartId, customerId, b.uuid.v7(), now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 2, 2999, 'USD', 5998)",
    [lineId, orderId, variantId, sku],
  );
  return { orderId: orderId, lineId: lineId };
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-ret-"));
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
  return helpers.authCookie(b, customerId);
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "ret-flow-order" });
  var returns   = bShop.returns.create({ query: query, cursorSecret: "ret-flow-returns" });
  var customers = bShop.customers.create({ query: query });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });

  var buyer = b.uuid.v7();
  var stranger = b.uuid.v7();
  var seeded = await _seedOrder(query, buyer, variant.id, variant.sku);
  var strangerOrder = await _seedOrder(query, stranger, variant.id, variant.sku);

  var handle = await _bootApp({ catalog: catalog, cart: cart, order: order, returns: returns, customers: customers });

  try {
    var cookie = _authCookie(buyer);

    // Anon → login.
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/returns" });
    check("anon returns then 303 login",        anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    // Empty list.
    var empty = await helpers.httpRequest({ port: handle.port, path: "/account/returns", headers: { cookie: cookie } });
    check("returns page then 200",              empty.status === 200);
    check("returns empty-state",                empty.body.indexOf("No returns yet") !== -1);

    // Return form for the buyer's own order shows the line.
    var form = await helpers.httpRequest({ port: handle.port, path: "/account/orders/" + seeded.orderId + "/return", headers: { cookie: cookie } });
    check("return form then 200",               form.status === 200);
    check("return form shows the SKU",          form.body.indexOf("WDG-PRO-L") !== -1);
    check("return form has a reason select",    form.body.indexOf("name=\"reason\"") !== -1);
    check("return form keys line by id",        form.body.indexOf("name=\"return_" + seeded.lineId + "\"") !== -1);

    // Malformed order id then 404, not 500.
    var malformed = await helpers.httpRequest({ port: handle.port, path: "/account/orders/not-a-uuid/return", headers: { cookie: cookie } });
    check("malformed order id then 404",        malformed.status === 404);

    // Another customer's order then 404 (no leak).
    var foreign = await helpers.httpRequest({ port: handle.port, path: "/account/orders/" + strangerOrder.orderId + "/return", headers: { cookie: cookie } });
    check("foreign order then 404",             foreign.status === 404);

    // POST with nothing selected then 400 + notice.
    var none = await helpers.httpRequest({ port: handle.port, path: "/account/orders/" + seeded.orderId + "/return", method: "POST", headers: { cookie: cookie }, form: { reason: "defective" } });
    check("no items selected then 400",         none.status === 400);
    check("no-items notice shown",              none.body.indexOf("Select at least one item") !== -1);

    // POST a valid return then 303 + persisted pending.
    var req = {};
    req["return_" + seeded.lineId] = "1";
    req["qty_" + seeded.lineId] = "1";
    req.reason = "defective";
    req.customer_notes = "stopped working";
    var ok = await helpers.httpRequest({ port: handle.port, path: "/account/orders/" + seeded.orderId + "/return", method: "POST", headers: { cookie: cookie }, form: req });
    check("valid return then 303 /account/returns", ok.status === 303 && (ok.headers["location"] || "") === "/account/returns");
    var rmas = await returns.listForCustomer(buyer, { limit: 10 });
    check("RMA persisted pending",              rmas.rows.length === 1 && rmas.rows[0].status === "pending");
    check("RMA carries the reason",             rmas.rows[0].reason === "defective");

    // List shows the RMA.
    var list = await helpers.httpRequest({ port: handle.port, path: "/account/returns", headers: { cookie: cookie } });
    check("list shows the RMA code",            list.body.indexOf(rmas.rows[0].rma_code) !== -1);
    check("list shows pending status",          list.body.indexOf("return-status--pending") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
