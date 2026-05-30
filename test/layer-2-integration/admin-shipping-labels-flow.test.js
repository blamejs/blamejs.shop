"use strict";
/**
 * Shipping-labels admin console — full HTTP integration of the standalone
 * back-office surface AND the order-detail void action.
 *
 * Boots one real `b.createApp` admin server against an in-memory
 * `node:sqlite` DB (loaded from the live migrations incl. 0021_shipments +
 * 0051_shipping_labels). The admin is wired with a token + catalog + order +
 * orderTracking + shippingLabels, so both the inline order-detail label
 * panel AND the standalone /admin/shipping-labels screens mount.
 *
 * Seeds an order + shipment + a purchased label (via the labels primitive),
 * then drives:
 *   - the order detail's per-label Void action (purchased → voided), and
 *     the refusal of a second void / a bad label id (4xx, never 500),
 *   - the standalone list (the voided label shows under the voided filter),
 *   - the broker-spend report (totals the purchased label's cost),
 *   - the mint queue (a pending label renders),
 *   - a malformed date range on /costs (200 + notice, not a 500),
 *   - the bearer JSON contract on the GET routes,
 *   - the auth gate (no session → sign-in form, not the console).
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

var TOKEN = "admin-token-0123456789abcdef-lbl"; // ≥ 16 chars

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
            "0006_customers.sql", "0004_shop_config.sql", "0021_shipments.sql",
            "0051_shipping_labels.sql"]
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

// Seed an order at the given status with one line of the supplied variant.
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

async function _bootAdmin(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-lbl-ad-"));
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
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var order    = bShop.order.create({ query: query, cursorSecret: "lbl-order" });
  var tracking = bShop.orderTracking.create({ query: query, order: order });
  var labels   = bShop.shippingLabels.create({ query: query });
  var config   = bShop.config.create({ query: query });

  var product = await catalog.products.create({ slug: "lbl-widget", title: "Label Widget", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "LBL-W-1", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });

  var buyer = b.uuid.v7();
  var seeded = await _seedOrder(query, buyer, variant.id, variant.sku, "fulfilling");

  // A shipment to hang labels off, then a purchased label (broker-minted)
  // and a separate pending label (queue) — both via the primitive directly.
  var shipment = await tracking.createShipment({ order_id: seeded.orderId, carrier: "ups", tracking_number: "1Z999AA10123456784" });
  var purchasedPending = await labels.requestLabel({
    shipment_id: shipment.id, carrier: "ups", service_level: "Ground",
    weight_grams: 500, length_mm: 200, width_mm: 150, height_mm: 100, package_type: "parcel",
  });
  var purchased = await labels.markPurchased({
    label_id: purchasedPending.id, tracking_number: "1Z999AA10123456784",
    label_url: "https://labels.example.com/a.pdf", cost_minor: 650, currency: "USD", purchased_via: "easypost",
  });
  // A second, still-pending label for the mint queue.
  var queued = await labels.requestLabel({
    shipment_id: shipment.id, carrier: "fedex", service_level: "Express",
    weight_grams: 300, length_mm: 180, width_mm: 120, height_mm: 90, package_type: "envelope",
  });

  var admin = await _bootAdmin({
    token: TOKEN, catalog: catalog, order: order, orderTracking: tracking,
    shippingLabels: labels, config: config, shop_name: "Label Shop",
  });

  try {
    var bearer = { authorization: "Bearer " + TOKEN };
    var bearerJson = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

    // ---- auth gate: no session → sign-in form, not the console ----------
    var anon = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels" });
    check("anon labels list → sign-in form", anon.status === 200 && anon.body.indexOf("Sign in") !== -1 && anon.body.indexOf("Shipping labels") === -1);

    // ---- browser session login ------------------------------------------
    var ajar = helpers.cookieJar();
    var alogin = await helpers.httpRequest({ port: admin.port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: ajar });
    check("admin login → 303", alogin.status === 303);

    // ---- order detail shows the purchased label + a Void action ---------
    var detail = await helpers.httpRequest({ port: admin.port, path: "/admin/orders/" + seeded.orderId, jar: ajar });
    check("order detail → 200", detail.status === 200);
    check("detail shows the label tracking", detail.body.indexOf("1Z999AA10123456784") !== -1);
    check("detail offers a Void action", detail.body.indexOf("/labels/" + purchased.id + "/void") !== -1);
    check("void form carries a reason input", detail.body.indexOf("name=\"reason\"") !== -1);

    // ---- void the label (purchased → voided) ----------------------------
    var doVoid = await helpers.httpRequest({
      port: admin.port, path: "/admin/orders/" + seeded.orderId + "/labels/" + purchased.id + "/void",
      method: "POST", jar: ajar, form: { reason: "Reprinted at a different weight" },
    });
    check("void → 303 label", doVoid.status === 303 && (doVoid.headers["location"] || "").indexOf("label=1") !== -1);
    var afterVoid = await labels.getLabel(purchased.id);
    check("void persisted", afterVoid.status === "voided" && afterVoid.void_reason === "Reprinted at a different weight");

    // ---- a second void of the same label is refused (4xx via JSON) ------
    var voidAgain = await helpers.httpRequest({
      port: admin.port, path: "/admin/orders/" + seeded.orderId + "/labels/" + purchased.id + "/void",
      method: "POST", headers: bearerJson, body: JSON.stringify({ reason: "again" }),
    });
    check("re-void already-voided → 400", voidAgain.status === 400);

    // ---- voiding a malformed label id is a 4xx, never a 500 -------------
    var voidBadId = await helpers.httpRequest({
      port: admin.port, path: "/admin/orders/" + seeded.orderId + "/labels/not-a-uuid/void",
      method: "POST", headers: bearerJson, body: JSON.stringify({ reason: "x" }),
    });
    check("void bad label id → 400 (not 500)", voidBadId.status === 400);

    // ---- standalone list: the voided label shows under the voided filter -
    var voidedList = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels?status=voided", jar: ajar });
    check("voided list → 200", voidedList.status === 200);
    check("voided list shows the label", voidedList.body.indexOf("1Z999AA10123456784") !== -1);
    check("voided list shows a voided pill", voidedList.body.indexOf(">voided<") !== -1);

    // ---- mint queue: the pending labels render --------------------------
    var pendingPage = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels/pending", jar: ajar });
    check("pending queue → 200", pendingPage.status === 200);
    check("pending queue shows the queued label", pendingPage.body.indexOf(">pending<") !== -1);
    check("pending queue mentions the mint queue", pendingPage.body.indexOf("awaiting a broker mint") !== -1);

    // ---- broker-spend report totals the purchased label's cost ----------
    // The label was purchased (650 USD via easypost) BEFORE it was voided;
    // costsByPeriod aggregates on purchased_at, so the spend still counts.
    var costs = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels/costs", jar: ajar });
    check("costs report → 200", costs.status === 200);
    check("costs report shows the broker", costs.body.indexOf("easypost") !== -1);
    check("costs report totals the spend", costs.body.indexOf("$6.50") !== -1);

    // ---- malformed date range on /costs → 200 + notice, not 500 ---------
    var badRange = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels/costs?from-date=not-a-date", jar: ajar });
    check("bad date range → 200 (not 500)", badRange.status === 200);
    check("bad date range shows a notice", badRange.body.indexOf("banner--warn") !== -1);

    // ---- the standalone LIST also degrades a bad range to 200 + notice ---
    var listBadRange = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels?status=voided&from-date=not-a-date", jar: ajar });
    check("list bad date range → 200 (not 500)", listBadRange.status === 200 && listBadRange.body.indexOf("banner--warn") !== -1);

    // ---- bearer JSON contract on the GET routes -------------------------
    var jsonList = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels?status=voided", headers: bearer });
    check("bearer list → 200 JSON", jsonList.status === 200 && (jsonList.headers["content-type"] || "").indexOf("application/json") !== -1);
    var listPayload = JSON.parse(jsonList.body);
    check("bearer list payload has voided label", listPayload.status === "voided" && Array.isArray(listPayload.labels) && listPayload.labels.length === 1);

    var jsonPending = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels/pending", headers: bearer });
    var pendingPayload = JSON.parse(jsonPending.body);
    check("bearer pending payload lists the queued label", jsonPending.status === 200 && pendingPayload.labels.length === 1 && pendingPayload.labels[0].id === queued.id);

    var jsonCosts = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels/costs", headers: bearer });
    var costsPayload = JSON.parse(jsonCosts.body);
    check("bearer costs payload totals spend", jsonCosts.status === 200 &&
      costsPayload.totals.length === 1 && costsPayload.totals[0].currency === "USD" && costsPayload.totals[0].total_minor === 650);

    // ---- malformed status on the standalone list → 4xx JSON -------------
    var badStatus = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels?status=bogus", headers: bearer });
    check("bad status filter → 400 JSON", badStatus.status === 400);

    // ---- the bearer-JSON void SUCCESS contract (locks the 200 branch) ----
    // The earlier void tests only hit error branches (already-voided / bad id).
    // Seed a fresh purchased label and void it over the JSON path so the
    // success response (200 + the voided label) is asserted too. This runs
    // last so the extra voided label doesn't disturb the "1 voided" counts.
    var pending2 = await labels.requestLabel({
      shipment_id: shipment.id, carrier: "ups", service_level: "Ground",
      weight_grams: 400, length_mm: 200, width_mm: 150, height_mm: 100, package_type: "parcel",
    });
    var purchased2 = await labels.markPurchased({
      label_id: pending2.id, tracking_number: "1Z999AA10123456785",
      label_url: "https://labels.example.com/b.pdf", cost_minor: 700, currency: "USD", purchased_via: "easypost",
    });
    var voidJson = await helpers.httpRequest({
      port: admin.port, path: "/admin/orders/" + seeded.orderId + "/labels/" + purchased2.id + "/void",
      method: "POST", headers: bearerJson, body: JSON.stringify({ reason: "json-path void" }),
    });
    check("bearer void → 200 JSON",               voidJson.status === 200);
    check("bearer void returns the voided label", JSON.parse(voidJson.body).status === "voided");

    // ---- bad carrier filter on /costs (JSON) → 400 ----------------------
    var badCarrier = await helpers.httpRequest({ port: admin.port, path: "/admin/shipping-labels/costs?carrier=bogus", headers: bearer });
    check("bad carrier filter → 400 JSON", badCarrier.status === 400);
  } finally {
    await _teardown(admin);
  }
}

module.exports = { run: _run };
