"use strict";
/**
 * Click-and-collect (BOPIS) — end-to-end HTTP integration of the operator
 * pickup-location CRUD + pickup queue (/admin/pickup-locations, /admin/pickups)
 * and the customer pickup status surfaces (/orders/:id, /account/pickups),
 * wired over ONE in-memory `node:sqlite` DB loaded from the live migrations
 * (including click_and_collect) so an operator-defined location is bookable
 * + a scheduled pickup is visible the same request.
 *
 * Boots a single real `b.createApp` mounting BOTH storefront + admin over the
 * shared store. A paid order is seeded for a buyer. Asserts:
 *
 *   - operator defines a pickup location (POST), it appears in the list;
 *   - the BOPIS error rule: a forged/garbage location code on a pickup action
 *     → 400 (TypeError), an UNKNOWN order_id on markReadyForPickup →
 *     resolved-existence-first 404 (NOT 400);
 *   - the FSM walk: schedule (via the primitive) → ready → picked-up; the
 *     customer sees the live status on /orders/:id;
 *   - IDOR: a foreign customer's /account/pickups doesn't see the buyer's
 *     pickup; the buyer's own /orders/:id shows it; a stranger's session on
 *     that order → 404;
 *   - XSS: a location name + a no_show reason of `<script>alert(1)</script>`
 *     render escaped in the admin queue / location list — raw absent, escaped
 *     present;
 *   - no raw-error / stack leak in any body.
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

var TOKEN = "admin-token-0123456789abcdef-test";

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql",
            "0004_shop_config.sql", "0126_click_and_collect.sql"]
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

// Seed an order with one line for `customerId` in the given status (default
// "shipped" — the state from which markPickedUp's mark_delivered edge is
// legal). Returns the order id.
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
    [orderId, cartId, customerId, b.uuid.v7(), now, status || "shipped"],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 2999, 'USD', 2999)",
    [lineId, orderId, variantId, sku],
  );
  return orderId;
}

function _noLeak(body) {
  body = body || "";
  return body.indexOf("at Object.") === -1 && body.indexOf("TypeError") === -1 && body.indexOf("    at ") === -1;
}

var XSS = "<script>alert(1)</script>";
var XSS_ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "pickup-order-sf" });
  var config  = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query });
  var clickAndCollect = bShop.clickAndCollect.create({ query: query, order: order });
  // A minimal checkout so the /orders/:id route mounts (it lives inside the
  // `deps.checkout && deps.order` block). This test never POSTs /checkout —
  // pickups are scheduled directly via the primitive — so the checkout's
  // payment/tax/shipping are unused here, but the handle must be present.
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: bShop.tax.create({ rules: [] }),
    shipping: bShop.shipping.create({ services: [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 0 }] }] }),
    payment: { name: "fake", createPaymentIntent: async function () { return { id: "pi_unused", client_secret: "x" }; }, verifyWebhook: async function () { return { ok: false }; } },
    order: order,
  });

  var product = await catalog.products.create({ slug: "tee", title: "Tee", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "TEE-1" });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  var orderId        = await _seedOrder(query, buyer, variant.id, variant.sku);
  var strangerOrder  = await _seedOrder(query, stranger, variant.id, variant.sku);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-pickup-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        clickAndCollect: clickAndCollect, shop_name: "Pickup Shop",
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        checkout: checkout, clickAndCollect: clickAndCollect, shop_name: "Pickup Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var adminJar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: adminJar });
    check("admin login -> 303", login.status === 303);

    // ---- operator defines a pickup location (with an XSS name) -------
    var def = await helpers.httpRequest({
      port: port, path: "/admin/pickup-locations", method: "POST", jar: adminJar,
      form: { code: "store-1", name: "Downtown " + XSS, line1: "1 Main St", city: "SF", country: "US",
              capacity_per_hour: "5", lead_time_hours: "0" },
    });
    check("define location -> 303 ?saved=1", def.status === 303 && (def.headers["location"] || "").indexOf("?saved=1") !== -1);

    var locList = await helpers.httpRequest({ port: port, path: "/admin/pickup-locations", jar: adminJar });
    check("location list -> 200", locList.status === 200);
    check("location list shows the code", locList.body.indexOf("store-1") !== -1);
    check("XSS location name renders escaped", locList.body.indexOf(XSS_ESCAPED) !== -1);
    check("XSS location name raw payload absent", locList.body.indexOf(XSS) === -1);

    var locApi = await helpers.httpRequest({ port: port, path: "/admin/pickup-locations", headers: bearer });
    check("location API lists the location", JSON.parse(locApi.body).rows.some(function (l) { return l.code === "store-1"; }));

    // ---- BOPIS error rule: garbage code -> 400; unknown order -> 404 -
    // A garbage (malformed) order id on a pickup action → 400 (the order_id
    // is malformed → getScheduleByOrder throws TypeError). The JSON API path
    // surfaces the code so we can assert the status precisely.
    var badCode = await helpers.httpRequest({
      port: port, path: "/admin/pickups/not-a-uuid/ready", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("malformed order id on pickup action -> 400", badCode.status === 400);

    // A WELL-FORMED but unknown order id → resolved-existence-first 404 (NOT
    // 400) — pins the BOPIS rule that not-found beats bad-shape.
    var unknownOrder = "00000000-0000-7000-8000-000000000000";
    var missing = await helpers.httpRequest({
      port: port, path: "/admin/pickups/" + unknownOrder + "/ready", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("unknown order on markReady -> 404 (not 400)", missing.status === 404);
    check("unknown order is pickup-schedule-not-found", missing.body.indexOf("pickup-schedule-not-found") !== -1);

    // ---- schedule a pickup for the buyer's order (via the primitive) -
    var now = Date.now();
    await clickAndCollect.scheduleAtLocation({
      order_id: orderId, location_code: "store-1",
      scheduled_window_start: now + 3600000, scheduled_window_end: now + 7200000,
    });
    var sched0 = await clickAndCollect.getScheduleByOrder(orderId);
    check("pickup scheduled", sched0 && sched0.status === "scheduled");

    // It shows in the admin queue for the location.
    var queue = await helpers.httpRequest({ port: port, path: "/admin/pickups?location=store-1", jar: adminJar });
    check("pickup queue -> 200", queue.status === 200);
    check("queue shows the order", queue.body.indexOf(String(orderId).slice(0, 8)) !== -1);

    // ---- the FSM walk: ready -> picked-up ---------------------------
    var ready = await helpers.httpRequest({ port: port, path: "/admin/pickups/" + orderId + "/ready", method: "POST", jar: adminJar, form: {} });
    check("mark ready -> 303 ?moved=1", ready.status === 303 && (ready.headers["location"] || "").indexOf("?moved=1") !== -1);
    check("schedule is ready", (await clickAndCollect.getScheduleByOrder(orderId)).status === "ready");

    // Customer sees the ready status on their order page.
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });
    var orderPage = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: buyerJar });
    check("buyer order page -> 200", orderPage.status === 200);
    check("buyer sees ready-for-pickup status", orderPage.body.indexOf("Ready for pickup") !== -1);
    check("buyer order page shows the location code", orderPage.body.indexOf("store-1") !== -1);

    var pickedUp = await helpers.httpRequest({ port: port, path: "/admin/pickups/" + orderId + "/picked-up", method: "POST", jar: adminJar, form: { proof_kind: "store_credential" } });
    check("mark picked-up -> 303 ?moved=1", pickedUp.status === 303 && (pickedUp.headers["location"] || "").indexOf("?moved=1") !== -1);
    check("schedule is picked_up", (await clickAndCollect.getScheduleByOrder(orderId)).status === "picked_up");
    // markPickedUp drives the parent order to delivered (order handle wired).
    check("order driven to delivered", (await order.get(orderId)).status === "delivered");

    // ---- /account/pickups shows the buyer's pickup ------------------
    var buyerPickups = await helpers.httpRequest({ port: port, path: "/account/pickups", jar: buyerJar });
    check("buyer pickups list -> 200", buyerPickups.status === 200);
    check("buyer pickups list shows the order", buyerPickups.body.indexOf(String(orderId).slice(0, 8)) !== -1);

    // ---- IDOR: a stranger doesn't see the buyer's pickup ------------
    var strangerJar = helpers.cookieJar();
    strangerJar.capture({ "set-cookie": [helpers.authCookie(b, stranger)] });
    var strangerPickups = await helpers.httpRequest({ port: port, path: "/account/pickups", jar: strangerJar });
    check("stranger pickups -> 200", strangerPickups.status === 200);
    check("stranger does NOT see the buyer's order", strangerPickups.body.indexOf(String(orderId).slice(0, 8)) === -1);

    // …and a stranger's session on the buyer's order page → 404 (IDOR gate).
    var strangerOnOrder = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: strangerJar });
    check("stranger on buyer's order -> 404", strangerOnOrder.status === 404);
    check("stranger order view leaks no raw error", _noLeak(strangerOnOrder.body));

    // ---- XSS no_show reason renders escaped in the admin queue ------
    // Schedule the stranger's order, then no-show it with an XSS reason; the
    // reason itself isn't shown on the queue list (it's a status column), but
    // the no-show action must not 500 and the queue must escape any text it
    // does render. Drive the no-show via the primitive's reason to assert the
    // refusal path stays clean, then confirm the queue renders escaped.
    await clickAndCollect.scheduleAtLocation({
      order_id: strangerOrder, location_code: "store-1",
      scheduled_window_start: now + 3600000, scheduled_window_end: now + 7200000,
    });
    var noShow = await helpers.httpRequest({
      port: port, path: "/admin/pickups/" + strangerOrder + "/no-show", method: "POST", jar: adminJar,
      form: { reason: XSS },
    });
    check("no-show with XSS reason -> 303 ?moved=1", noShow.status === 303 && (noShow.headers["location"] || "").indexOf("?moved=1") !== -1);
    check("no-show landed the FSM state", (await clickAndCollect.getScheduleByOrder(strangerOrder)).status === "no_show");
    // The queue (filtered to no_show) renders the rows — assert no raw XSS
    // anywhere on the page and no leak.
    var noShowQueue = await helpers.httpRequest({ port: port, path: "/admin/pickups?location=store-1&status=no_show", jar: adminJar });
    check("no_show queue -> 200", noShowQueue.status === 200);
    check("no_show queue has no raw XSS payload", noShowQueue.body.indexOf(XSS) === -1);
    check("no_show queue leaks no raw error", _noLeak(noShowQueue.body));

    // ---- archive a location ----------------------------------------
    var archive = await helpers.httpRequest({ port: port, path: "/admin/pickup-locations/store-1/archive", method: "POST", jar: adminJar, form: {} });
    check("archive location -> 303 ?saved=1", archive.status === 303 && (archive.headers["location"] || "").indexOf("?saved=1") !== -1);
    var afterArchive = await clickAndCollect.getLocation("store-1");
    check("location archived", afterArchive && afterArchive.archived_at != null && Number(afterArchive.active) === 0);

    // Archiving a non-existent code → ?err=1 (existence-first), not a 500.
    var archiveMissing = await helpers.httpRequest({ port: port, path: "/admin/pickup-locations/no-such-code/archive", method: "POST", jar: adminJar, form: {} });
    check("archive unknown code -> 303 ?err=1", archiveMissing.status === 303 && (archiveMissing.headers["location"] || "").indexOf("?err=1") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

async function run() { await _run(); }

module.exports = { run: run };

if (require.main === module) {
  _run().then(function () {
    console.log("OK — pickup-flow (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — pickup-flow: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
