"use strict";
/**
 * Order exchanges — end-to-end HTTP integration of the customer request
 * surface (/account/orders/:id/exchange + /account/exchanges) and the
 * operator queue + FSM-action console (/admin/exchanges), wired over ONE
 * in-memory `node:sqlite` DB loaded from the live migrations (including
 * order_exchanges) so an exchange a shopper opens is visible to the
 * operator the same request.
 *
 * Boots a single real `b.createApp` mounting BOTH the storefront and the
 * admin console against the shared store. A paid (exchange-eligible) order
 * with a line is seeded for the buyer. The flow asserts:
 *
 *   - the customer opens an exchange against their own order; it appears
 *     in their /account/exchanges list AND in the admin open queue;
 *   - the operator walks the FSM (approve → mark-shipped → mark-delivered
 *     → mark-received → close) and the customer sees the live status on
 *     their exchange detail;
 *   - a FOREIGN customer cannot read the exchange (404) nor open one
 *     against the buyer's order (404) — the IDOR / ownership defense;
 *   - a request against a NOT-eligible (still-pending) order is refused
 *     with a clean 4xx, no leak;
 *   - an illegal FSM transition (close before both sides land) is refused
 *     (?err=1), no state change;
 *   - bad input (missing reason) is a clean 400 re-render, no leak.
 *
 * Every state-changing POST goes through the real double-submit CSRF gate
 * (the cookie jar captures the token and echoes it as X-CSRF-Token).
 * Statuses are asserted clean — no raw-error / stack leak in any body.
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

var TOKEN = "admin-token-0123456789abcdef-test"; // >= 16 chars

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql",
            "0004_shop_config.sql", "0164_order_exchanges.sql"]
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

// Seed an order with one line for `customerId` in the given status.
// Returns the order id + the order_line id (the exchange form keys the
// line radio by id).
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
    "VALUES (?1, ?2, ?3, ?4, ?6, 'USD', 2999, 0, 0, 0, 2999, NULL, '{}', ?5, ?5)",
    [orderId, cartId, customerId, b.uuid.v7(), now, status],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 2, 2999, 'USD', 5998)",
    [lineId, orderId, variantId, sku],
  );
  return { orderId: orderId, lineId: lineId };
}

// The exchange id round-trips nowhere on the create redirect (it lands on
// /account/exchanges?ok=1), so the test reads it back off the primitive.
function _noLeak(body) {
  body = body || "";
  return body.indexOf("at Object.") === -1 &&
         body.indexOf("TypeError") === -1 &&
         body.indexOf("    at ") === -1;
}

async function _run() {
  var query          = _makeQuery();
  var catalog        = bShop.catalog.create({ query: query });
  var cart           = bShop.cart.create({ query: query, catalog: catalog });
  var order          = bShop.order.create({ query: query, cursorSecret: "exch-order" });
  var config         = bShop.config.create({ query: query });
  var customers      = bShop.customers.create({ query: query });
  var orderExchanges = bShop.orderExchanges.create({ query: query, order: order });

  var product   = await catalog.products.create({ slug: "tee", title: "Tee", description: "x", status: "active" });
  var variantL  = await catalog.variants.create(product.id, { sku: "TEE-L", options: { size: "L" } });
  var variantXL = await catalog.variants.create(product.id, { sku: "TEE-XL", options: { size: "XL" } });
  // A variant from a DIFFERENT product — a forged replacement_<lineId>
  // pointing here must be REJECTED, never let a shopper swap a cheap item
  // for an unrelated (pricier) variant elsewhere in the catalog.
  var otherProduct = await catalog.products.create({ slug: "jacket", title: "Jacket", description: "y", status: "active" });
  var otherVariant = await catalog.variants.create(otherProduct.id, { sku: "JKT-1", options: { size: "M" } });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  var seeded         = await _seedOrder(query, buyer, variantL.id, variantL.sku, "paid");
  var pendingOrder   = await _seedOrder(query, buyer, variantL.id, variantL.sku, "pending");
  var strangerOrder  = await _seedOrder(query, stranger, variantL.id, variantL.sku, "paid");

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-exch-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        orderExchanges: orderExchanges, shop_name: "Exchange Shop",
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        orderExchanges: orderExchanges, shop_name: "Exchange Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- the exchange form for the buyer's own eligible order ---------
    var form = await helpers.httpRequest({ port: port, path: "/account/orders/" + seeded.orderId + "/exchange", jar: buyerJar });
    check("exchange form -> 200",               form.status === 200);
    check("form shows the order SKU",           form.body.indexOf("TEE-L") !== -1);
    check("form keys the line radio by id",     form.body.indexOf("value=\"" + seeded.lineId + "\"") !== -1);
    check("form offers the sibling variant",    form.body.indexOf("TEE-XL") !== -1);
    check("form has a reason select",           form.body.indexOf("name=\"reason\"") !== -1);

    // ---- malformed / foreign / not-eligible order all refuse cleanly ---
    var malformed = await helpers.httpRequest({ port: port, path: "/account/orders/not-a-uuid/exchange", jar: buyerJar });
    check("malformed order id -> 404",          malformed.status === 404);

    var foreignForm = await helpers.httpRequest({ port: port, path: "/account/orders/" + strangerOrder.orderId + "/exchange", jar: buyerJar });
    check("foreign order form -> 404",          foreignForm.status === 404);

    var notEligible = await helpers.httpRequest({ port: port, path: "/account/orders/" + pendingOrder.orderId + "/exchange", jar: buyerJar });
    check("pending order not eligible -> 400",  notEligible.status === 400);
    check("not-eligible notice shown",          notEligible.body.indexOf("eligible for an exchange") !== -1);
    check("not-eligible leaks no raw error",    _noLeak(notEligible.body));

    // ---- bad input (missing reason) -> clean 400 re-render -------------
    var badInput = {};
    badInput.line_id = seeded.lineId;
    badInput["qty_" + seeded.lineId] = "1";
    badInput["replacement_" + seeded.lineId] = variantXL.id;
    // reason omitted
    var bad = await helpers.httpRequest({ port: port, path: "/account/orders/" + seeded.orderId + "/exchange", method: "POST", jar: buyerJar, form: badInput });
    check("missing reason -> 400",              bad.status === 400);
    check("bad input re-renders the form",      bad.body.indexOf("Request an exchange") !== -1);
    check("bad input leaks no raw error",       _noLeak(bad.body));
    var noneYet = await orderExchanges.exchangesForCustomer(buyer, { limit: 10 });
    check("bad input created nothing",          noneYet.length === 0);

    // ---- a forged cross-product replacement is REJECTED ----------------
    // The replacement select only offers siblings of the purchased product;
    // a hand-forged replacement_<lineId> pointing at a variant of ANOTHER
    // product must not be accepted (no cheap-to-expensive cross-product swap).
    var crossInput = {};
    crossInput.line_id = seeded.lineId;
    crossInput["qty_" + seeded.lineId] = "1";
    crossInput["replacement_" + seeded.lineId] = otherVariant.id;
    crossInput.reason = "wrong-size";
    var cross = await helpers.httpRequest({ port: port, path: "/account/orders/" + seeded.orderId + "/exchange", method: "POST", jar: buyerJar, form: crossInput });
    check("cross-product replacement -> 400",   cross.status === 400);
    check("cross-product re-renders the form",  cross.body.indexOf("Request an exchange") !== -1);
    check("cross-product leaks no raw error",   _noLeak(cross.body));
    var stillNone = await orderExchanges.exchangesForCustomer(buyer, { limit: 10 });
    check("cross-product created nothing",      stillNone.length === 0);

    // ---- POST a valid exchange request --------------------------------
    var reqForm = {};
    reqForm.line_id = seeded.lineId;
    reqForm["qty_" + seeded.lineId] = "1";
    reqForm["replacement_" + seeded.lineId] = variantXL.id;
    reqForm.reason = "wrong-size";
    var created = await helpers.httpRequest({ port: port, path: "/account/orders/" + seeded.orderId + "/exchange", method: "POST", jar: buyerJar, form: reqForm });
    check("valid exchange -> 303 /account/exchanges", created.status === 303 && (created.headers["location"] || "").indexOf("/account/exchanges?ok=1") === 0);

    var mine = await orderExchanges.exchangesForCustomer(buyer, { limit: 10 });
    check("exchange persisted pending",         mine.length === 1 && mine[0].status === "pending");
    check("exchange pins the order line",        mine[0].line_id === seeded.lineId);
    check("exchange swaps to the chosen variant", mine[0].replacement_sku === "TEE-XL" && mine[0].replacement_variant_id === variantXL.id);
    check("exchange carries the reason",         mine[0].reason === "wrong-size");
    var exchangeId = mine[0].id;

    // ---- it appears in the customer's list ----------------------------
    var custList = await helpers.httpRequest({ port: port, path: "/account/exchanges", jar: buyerJar });
    check("customer exchange list -> 200",      custList.status === 200);
    check("customer list shows the swap",       custList.body.indexOf("TEE-XL") !== -1);
    check("customer list links the detail",     custList.body.indexOf("/account/exchanges/" + exchangeId) !== -1);

    // ---- and in the admin open queue (HTML + JSON) --------------------
    var adminJar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: adminJar });
    check("admin login -> 303",                 login.status === 303);

    var queueHtml = await helpers.httpRequest({ port: port, path: "/admin/exchanges", jar: adminJar });
    check("admin queue -> 200",                 queueHtml.status === 200);
    check("admin queue shows the exchange",     queueHtml.body.indexOf(String(exchangeId).slice(0, 8)) !== -1);
    check("admin queue has status chips",       queueHtml.body.indexOf("order-filters") !== -1);

    var queueApi = await helpers.httpRequest({ port: port, path: "/admin/exchanges", headers: bearer });
    check("admin queue API is JSON",            (queueApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("admin queue API lists the exchange", JSON.parse(queueApi.body).rows.some(function (x) { return x.id === exchangeId; }));

    // ---- a missing exchange id via the JSON API maps to 404, not 400 ---
    // EXCHANGE_NOT_FOUND is thrown as a TypeError that also carries a code,
    // so the API error mapper must test the code before the generic
    // TypeError->400 branch, or a well-formed-but-missing id mis-maps to 400.
    // The id is a well-formed (but nonexistent) uuid + the action input is
    // otherwise valid, so the ONLY error is the missing row → it must map to
    // 404, not the generic 400.
    var bogusExchangeId = "00000000-0000-7000-8000-000000000000";
    var apiMissing = await helpers.httpRequest({
      port: port, path: "/admin/exchanges/" + bogusExchangeId + "/approve", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ approver_id: b.uuid.v7() }),
    });
    check("API action on a missing exchange -> 404",     apiMissing.status === 404);
    check("API missing exchange is exchange-not-found",  apiMissing.body.indexOf("exchange-not-found") !== -1);

    // ---- IDOR: a stranger can't read the exchange ---------------------
    var strangerJar = helpers.cookieJar();
    strangerJar.capture({ "set-cookie": [helpers.authCookie(b, stranger)] });

    var foreignView = await helpers.httpRequest({ port: port, path: "/account/exchanges/" + exchangeId, jar: strangerJar });
    check("foreign exchange view -> 404",       foreignView.status === 404);
    check("foreign view leaks no raw error",    _noLeak(foreignView.body));

    // …nor open one against the buyer's order.
    var strangerOpen = await helpers.httpRequest({ port: port, path: "/account/orders/" + seeded.orderId + "/exchange", method: "POST", jar: strangerJar, form: reqForm });
    check("stranger opens on foreign order -> 404", strangerOpen.status === 404);
    var stillOne = await orderExchanges.exchangesForCustomer(buyer, { limit: 10 });
    check("stranger created nothing",           stillOne.length === 1);

    // ---- the owner can read the detail --------------------------------
    var ownerView = await helpers.httpRequest({ port: port, path: "/account/exchanges/" + exchangeId, jar: buyerJar });
    check("owner exchange view -> 200",         ownerView.status === 200);
    check("owner view shows Requested status",  ownerView.body.indexOf("Requested") !== -1);

    // ---- illegal FSM transition refused (close before approval) -------
    var earlyClose = await helpers.httpRequest({ port: port, path: "/admin/exchanges/" + exchangeId + "/close", method: "POST", jar: adminJar, form: {} });
    check("early close -> 303 ?err=1",          earlyClose.status === 303 && (earlyClose.headers["location"] || "").indexOf("?err=1") !== -1);
    check("early close left status pending",    (await orderExchanges.getExchange(exchangeId)).status === "pending");

    // ---- operator walks the FSM ---------------------------------------
    var approverId = b.uuid.v7();
    var approve = await helpers.httpRequest({ port: port, path: "/admin/exchanges/" + exchangeId + "/approve", method: "POST", jar: adminJar, form: { approver_id: approverId } });
    check("approve -> 303 ?moved=1",            approve.status === 303 && (approve.headers["location"] || "").indexOf("?moved=1") !== -1);
    check("exchange is approved",               (await orderExchanges.getExchange(exchangeId)).status === "approved");

    var shipped = await helpers.httpRequest({ port: port, path: "/admin/exchanges/" + exchangeId + "/mark-shipped", method: "POST", jar: adminJar, form: { tracking_number: "1Z999AA10123456784", carrier: "ups" } });
    check("mark-shipped -> 303",                shipped.status === 303);
    var afterShip = await orderExchanges.getExchange(exchangeId);
    check("exchange is shipped",                afterShip.status === "shipped");
    check("tracking captured",                  afterShip.tracking_number === "1Z999AA10123456784");

    // Customer sees the tracking on their detail.
    var custTrack = await helpers.httpRequest({ port: port, path: "/account/exchanges/" + exchangeId, jar: buyerJar });
    check("customer sees shipped status",       custTrack.body.indexOf("Replacement shipped") !== -1);
    check("customer sees the tracking number",  custTrack.body.indexOf("1Z999AA10123456784") !== -1);

    var delivered = await helpers.httpRequest({ port: port, path: "/admin/exchanges/" + exchangeId + "/mark-delivered", method: "POST", jar: adminJar, form: {} });
    check("mark-delivered -> 303",              delivered.status === 303);
    check("exchange is delivered",              (await orderExchanges.getExchange(exchangeId)).status === "delivered");

    var received = await helpers.httpRequest({ port: port, path: "/admin/exchanges/" + exchangeId + "/mark-received", method: "POST", jar: adminJar, form: {} });
    check("mark-received -> 303",               received.status === 303);
    check("exchange is received",               (await orderExchanges.getExchange(exchangeId)).status === "received");

    var close = await helpers.httpRequest({ port: port, path: "/admin/exchanges/" + exchangeId + "/close", method: "POST", jar: adminJar, form: {} });
    check("close -> 303 ?moved=1",              close.status === 303 && (close.headers["location"] || "").indexOf("?moved=1") !== -1);
    check("exchange is closed",                 (await orderExchanges.getExchange(exchangeId)).status === "closed");

    // The closed exchange drops out of the open queue.
    var openAfter = await helpers.httpRequest({ port: port, path: "/admin/exchanges", headers: bearer });
    check("closed exchange leaves open queue",  !JSON.parse(openAfter.body).rows.some(function (x) { return x.id === exchangeId; }));

    // Customer sees the completed status.
    var custDone = await helpers.httpRequest({ port: port, path: "/account/exchanges/" + exchangeId, jar: buyerJar });
    check("customer sees Completed status",     custDone.body.indexOf("Completed") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };

// Allow direct invocation.
if (require.main === module) {
  _run().then(function () {
    console.log("OK — exchanges-flow (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — exchanges-flow: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
