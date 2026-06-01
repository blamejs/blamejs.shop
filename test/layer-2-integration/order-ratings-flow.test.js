"use strict";
/**
 * Order ratings — HTTP integration of the post-purchase fulfillment-CSAT
 * surface across BOTH the customer order page and the admin moderation
 * console, over one in-memory node:sqlite backend.
 *
 * Two apps share one query handle (so a write on one surface is visible to
 * the other): a storefront mount (customer rating form + display) and an
 * admin mount (the /admin/ratings moderation queue). It exercises:
 *
 *   - a signed-in customer rates their OWN delivered order (success); the
 *     three scores render back in place of the form on the order page;
 *   - a customer CANNOT rate ANOTHER customer's order (404 IDOR, no write);
 *   - a duplicate submit is refused (clean 4xx correction, no second row);
 *   - a comment carrying an XSS payload renders ESCAPED on BOTH the customer
 *     order page AND the admin screen (the escaped form present, the raw
 *     payload absent);
 *   - the admin moderation queue surfaces a flagged comment;
 *   - an operator reply (responseToCustomer) renders escaped on the admin
 *     screen AND then appears (escaped) on the customer's order page;
 *   - admin coded-error mapping: not-found id → 404, refused-second-reply
 *     → 409, bad input → 400 (e.code checked before instanceof TypeError);
 *   - an anonymous rating POST is bounced to login, never acted on.
 *
 * Every state-changing POST goes through the real double-submit CSRF gate
 * (the cookie jar captures the token and echoes it). Statuses are asserted
 * clean — no raw-error leak in any response body.
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

var ADMIN_TOKEN = "ratings-admin-token-0123456789abcdef";

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql", "0004_shop_config.sql",
            "0151_order_ratings.sql"]
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

// Direct-INSERT a delivered order owned by `customerId` with one line — the
// rating window is paid → delivered, and a direct insert lets us pin the
// status + owner without driving the whole checkout FSM.
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-ratings-sf-"));
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-ratings-admin-"));
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

// The XSS payload a customer types as their comment. The escaped form
// (every < > " & turned into an entity) MUST be what renders; the raw
// `<script>` / `onerror` tag MUST be absent from every response body.
var XSS_PAYLOAD = "<script>alert(1)</script><img src=x onerror=alert(2)>";
var XSS_ESCAPED = b.template.escapeHtml(XSS_PAYLOAD);

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order      = bShop.order.create({ query: query, cursorSecret: "ratings-order" });
  var customers  = bShop.customers.create({ query: query });
  // ONE shared ratings instance backs both surfaces — exactly how server.js
  // wires it — so a customer submit is visible to the admin queue and an
  // operator reply is visible on the customer order page.
  var orderRatings = bShop.orderRatings.create({ query: query });

  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping, payment: payment, order: order,
  });

  var product = await catalog.products.create({ slug: "rate-widget", title: "Rate Widget", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "RAT-W-1", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: 25 });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  var operator = b.uuid.v7();   // the admin operator's UUID (single-bearer admin model)
  // A delivered order the buyer owns (ratable), a delivered order the
  // stranger owns (the IDOR target), and a second buyer order (rated with
  // the XSS payload below).
  var buyerOrderId    = await _seedOrder(query, buyer,    variant.id, variant.sku, "delivered");
  var strangerOrderId = await _seedOrder(query, stranger, variant.id, variant.sku, "delivered");
  var xssOrderId      = await _seedOrder(query, buyer,    variant.id, variant.sku, "delivered");

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, order: order, customers: customers,
    orderRatings: orderRatings, checkout: checkout, default_shipping_id: "std", shop_name: "Rate Shop",
  });
  var admin = await _bootAdmin({
    token: ADMIN_TOKEN, catalog: catalog, order: order, orderRatings: orderRatings, shop_name: "Rate Shop",
  });

  try {
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- order page offers the rating form on an eligible, unrated order -
    var formPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + buyerOrderId, jar: buyerJar });
    check("buyer order page → 200",              formPage.status === 200);
    check("eligible order offers a rating form", formPage.body.indexOf("/orders/" + buyerOrderId + "/rate") !== -1);
    check("rating form has the three axes",      formPage.body.indexOf("name=\"shipping_rating\"") !== -1 &&
      formPage.body.indexOf("name=\"packaging_rating\"") !== -1 && formPage.body.indexOf("name=\"recommend_rating\"") !== -1);

    // ---- IDOR: a stranger's order can't be rated by the buyer -----------
    var foreignRate = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + strangerOrderId + "/rate", method: "POST", jar: buyerJar,
      form: { shipping_rating: "5", packaging_rating: "5", recommend_rating: "5" },
    });
    check("rate foreign order → 404",            foreignRate.status === 404);
    check("foreign rate leaks no raw error",     foreignRate.body.indexOf("at Object.") === -1 && foreignRate.body.indexOf("TypeError") === -1);
    var foreignStill = await orderRatings.getRating({ order_id: strangerOrderId });
    check("foreign order still unrated",         foreignStill === null);

    // ---- anon rating POST → login, never acted on -----------------------
    var anonJar = helpers.cookieJar();
    var anonRate = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + buyerOrderId + "/rate", method: "POST", jar: anonJar,
      form: { shipping_rating: "5", packaging_rating: "5", recommend_rating: "5" },
    });
    check("anon rate → 303 login",               anonRate.status === 303 &&
      (anonRate.headers["location"] || "") === "/account/login");
    var stillUnratedAfterAnon = await orderRatings.getRating({ order_id: buyerOrderId });
    check("anon rate left order unrated",        stillUnratedAfterAnon === null);

    // ---- bad rating value → clean 4xx correction, no row ----------------
    var badValue = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + buyerOrderId + "/rate", method: "POST", jar: buyerJar,
      form: { shipping_rating: "9", packaging_rating: "5", recommend_rating: "5" },   // 9 is out of [1,5]
    });
    check("out-of-range rating → 303 correction", badValue.status === 303 &&
      (badValue.headers["location"] || "").indexOf("rate_err=value") !== -1);
    check("bad value wrote no rating row",        (await orderRatings.getRating({ order_id: buyerOrderId })) === null);

    // ---- partial / non-integer values are rejected, not silently coerced -
    // parseInt would turn a crafted "5abc"→5 and "1.9"→1; the whole-string
    // check sends both to the clean "value" correction so no value the
    // shopper never chose is persisted.
    var partialNum = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + buyerOrderId + "/rate", method: "POST", jar: buyerJar,
      form: { shipping_rating: "5abc", packaging_rating: "5", recommend_rating: "5" },
    });
    check("partial-numeric rating → 303 correction", partialNum.status === 303 &&
      (partialNum.headers["location"] || "").indexOf("rate_err=value") !== -1);
    var fractional = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + buyerOrderId + "/rate", method: "POST", jar: buyerJar,
      form: { shipping_rating: "1.9", packaging_rating: "5", recommend_rating: "5" },
    });
    check("fractional rating → 303 correction",   fractional.status === 303 &&
      (fractional.headers["location"] || "").indexOf("rate_err=value") !== -1);
    check("partial/fractional wrote no rating row", (await orderRatings.getRating({ order_id: buyerOrderId })) === null);

    // ---- happy path: rate the owned, delivered order --------------------
    var rateOk = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + buyerOrderId + "/rate", method: "POST", jar: buyerJar,
      form: { shipping_rating: "4", packaging_rating: "3", recommend_rating: "5", comment: "Quick delivery, thanks!" },
    });
    check("rate owned order → 303 back",         rateOk.status === 303 &&
      (rateOk.headers["location"] || "") === "/orders/" + buyerOrderId);
    var saved = await orderRatings.getRating({ order_id: buyerOrderId });
    check("rating row persisted",                saved && saved.shipping_rating === 4 && saved.packaging_rating === 3 && saved.recommend_rating === 5);
    check("rating pinned to the session buyer",  saved && saved.customer_id === buyer);

    // ---- order page now shows the scores in place of the form -----------
    var ratedPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + buyerOrderId, jar: buyerJar });
    check("rated order page → 200",              ratedPage.status === 200);
    check("rated page hides the rating form",    ratedPage.body.indexOf("/orders/" + buyerOrderId + "/rate") === -1);
    check("rated page shows the scores",         ratedPage.body.indexOf("4 / 5") !== -1 && ratedPage.body.indexOf("3 / 5") !== -1);
    check("rated page shows the comment",        ratedPage.body.indexOf("Quick delivery, thanks!") !== -1);

    // ---- duplicate submit is refused ------------------------------------
    var dupe = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + buyerOrderId + "/rate", method: "POST", jar: buyerJar,
      form: { shipping_rating: "1", packaging_rating: "1", recommend_rating: "1" },
    });
    check("duplicate rate → 303 correction",     dupe.status === 303 &&
      (dupe.headers["location"] || "").indexOf("rate_err=dupe") !== -1);
    var afterDupe = await orderRatings.getRating({ order_id: buyerOrderId });
    check("duplicate left the first rating intact", afterDupe.shipping_rating === 4);   // not overwritten to 1

    // ---- XSS: a payload comment renders ESCAPED on the customer page ----
    var xssRate = await helpers.httpRequest({
      port: sf.port, path: "/orders/" + xssOrderId + "/rate", method: "POST", jar: buyerJar,
      form: { shipping_rating: "2", packaging_rating: "2", recommend_rating: "1", comment: XSS_PAYLOAD },
    });
    check("xss-comment rate → 303 back",         xssRate.status === 303);
    var xssPage = await helpers.httpRequest({ port: sf.port, path: "/orders/" + xssOrderId, jar: buyerJar });
    check("xss order page → 200",                xssPage.status === 200);
    check("customer page renders the comment ESCAPED", xssPage.body.indexOf(XSS_ESCAPED) !== -1);
    check("customer page never renders the raw payload", xssPage.body.indexOf(XSS_PAYLOAD) === -1);

    // ---- graceful degradation: a failing ratings read (e.g. the table is
    // not migrated on a deploy) hides the form so its POST can't 500 -------
    var degradeOrderId = await _seedOrder(query, buyer, variant.id, variant.sku, "delivered");
    var throwingRatings = {
      getRating:    async function () { throw new Error("no such table: order_ratings"); },
      submitRating: async function () { throw new Error("no such table: order_ratings"); },
    };
    var sfDegraded = await _bootStorefront({
      catalog: catalog, cart: cart, order: order, customers: customers,
      orderRatings: throwingRatings, checkout: checkout, default_shipping_id: "std", shop_name: "Rate Shop",
    });
    try {
      var degradedPage = await helpers.httpRequest({ port: sfDegraded.port, path: "/orders/" + degradeOrderId, jar: buyerJar });
      check("failing ratings read → order page still 200", degradedPage.status === 200);
      check("failing ratings read hides the rating form",  degradedPage.body.indexOf("/orders/" + degradeOrderId + "/rate") === -1);
      check("failing ratings read leaks no raw error",     degradedPage.body.indexOf("no such table") === -1 && degradedPage.body.indexOf("at Object.") === -1);
    } finally {
      await _teardown(sfDegraded);
    }

    // ===================== admin moderation surface =====================
    var adminJar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: admin.port, path: "/admin/login", method: "POST", form: { token: ADMIN_TOKEN }, jar: adminJar });
    check("admin login → 303",                   login.status === 303);
    var bearer = { authorization: "Bearer " + ADMIN_TOKEN };

    // The recent list (bearer JSON) carries both ratings.
    var apiList = await helpers.httpRequest({ port: admin.port, path: "/admin/ratings", headers: bearer });
    check("admin ratings API is JSON",           (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    var lj = JSON.parse(apiList.body);
    check("admin API lists the ratings",         Array.isArray(lj.ratings) && lj.ratings.length >= 2);
    check("admin API exposes a flagged array",   Array.isArray(lj.flagged));

    // The XSS comment renders ESCAPED on the admin screen too.
    var adminScreen = await helpers.httpRequest({ port: admin.port, path: "/admin/ratings", jar: adminJar });
    check("admin ratings screen → 200",          adminScreen.status === 200);
    check("admin screen shows the Ratings heading", adminScreen.body.indexOf("Ratings") !== -1);
    check("nav includes Ratings",                adminScreen.body.indexOf("\"/admin/ratings\"") !== -1);
    check("admin screen renders the comment ESCAPED", adminScreen.body.indexOf(XSS_ESCAPED) !== -1);
    check("admin screen never renders the raw payload", adminScreen.body.indexOf(XSS_PAYLOAD) === -1);

    // ---- flag the XSS comment → it surfaces in the flagged queue --------
    var xssRating = await orderRatings.getRating({ order_id: xssOrderId });
    var flag = await helpers.httpRequest({
      port: admin.port, path: "/admin/ratings/" + xssRating.id + "/flag", method: "POST", jar: adminJar,
      form: { reason: "abusive", flagged_by: operator },
    });
    check("flag comment → 303 moved",            flag.status === 303 &&
      (flag.headers["location"] || "").indexOf("moved=1") !== -1);
    var flaggedScreen = await helpers.httpRequest({ port: admin.port, path: "/admin/ratings?flagged=1", jar: adminJar });
    check("flagged queue → 200",                 flaggedScreen.status === 200);
    check("flagged queue surfaces the flagged rating", flaggedScreen.body.indexOf(String(xssRating.id).slice(0, 8)) !== -1);
    check("flagged queue still escapes the payload", flaggedScreen.body.indexOf(XSS_ESCAPED) !== -1 && flaggedScreen.body.indexOf(XSS_PAYLOAD) === -1);

    // ---- operator reply (XSS-payload reply) renders ESCAPED both places -
    var REPLY_PAYLOAD = "Thanks <b>so</b> much! <img src=x onerror=alert(3)>";
    var REPLY_ESCAPED = b.template.escapeHtml(REPLY_PAYLOAD);
    var buyerRating = await orderRatings.getRating({ order_id: buyerOrderId });
    var respond = await helpers.httpRequest({
      port: admin.port, path: "/admin/ratings/" + buyerRating.id + "/respond", method: "POST", jar: adminJar,
      form: { response: REPLY_PAYLOAD, responded_by: operator },
    });
    check("operator reply → 303 moved",          respond.status === 303 &&
      (respond.headers["location"] || "").indexOf("moved=1") !== -1);
    var afterReply = await orderRatings.getRating({ order_id: buyerOrderId });
    check("reply persisted to the rating",       afterReply.response_text === REPLY_PAYLOAD);

    // The reply renders ESCAPED on the admin screen ...
    var adminAfterReply = await helpers.httpRequest({ port: admin.port, path: "/admin/ratings", jar: adminJar });
    check("admin screen renders the reply ESCAPED", adminAfterReply.body.indexOf(REPLY_ESCAPED) !== -1);
    check("admin screen never renders the raw reply", adminAfterReply.body.indexOf(REPLY_PAYLOAD) === -1);
    // ... AND it appears (escaped) on the customer's own order page.
    var buyerPageAfterReply = await helpers.httpRequest({ port: sf.port, path: "/orders/" + buyerOrderId, jar: buyerJar });
    check("customer page shows the operator reply ESCAPED", buyerPageAfterReply.body.indexOf(REPLY_ESCAPED) !== -1);
    check("customer page never renders the raw reply", buyerPageAfterReply.body.indexOf(REPLY_PAYLOAD) === -1);

    // ---- admin coded-error mapping (bearer JSON) ------------------------
    // A well-formed UUID that names no rating → 404 (not 400).
    var missingFlag = await helpers.httpRequest({
      port: admin.port, path: "/admin/ratings/" + b.uuid.v7() + "/flag", method: "POST", headers: bearer,
      form: { reason: "x", flagged_by: operator },
    });
    check("flag missing rating → 404",           missingFlag.status === 404);
    // A second reply on an already-replied rating → 409 (coded conflict,
    // checked before the generic TypeError → 400).
    var secondReply = await helpers.httpRequest({
      port: admin.port, path: "/admin/ratings/" + buyerRating.id + "/respond", method: "POST", headers: bearer,
      form: { response: "again", responded_by: operator },
    });
    check("second reply → 409 conflict",         secondReply.status === 409);
    // A malformed rating id → 400 (bad request), distinct from the 404.
    var badId = await helpers.httpRequest({
      port: admin.port, path: "/admin/ratings/not-a-uuid/flag", method: "POST", headers: bearer,
      form: { reason: "x", flagged_by: operator },
    });
    check("malformed rating id → 400",           badId.status === 400);
    // Bad input (missing reason) on a real rating → 400.
    var badInput = await helpers.httpRequest({
      port: admin.port, path: "/admin/ratings/" + buyerRating.id + "/flag", method: "POST", headers: bearer,
      form: { flagged_by: operator },   // no reason
    });
    check("missing flag reason → 400",           badInput.status === 400);

    // ---- admin auth gate: anon → sign-in form, never data ---------------
    var anonAdmin = await helpers.httpRequest({ port: admin.port, path: "/admin/ratings" });
    check("anon admin ratings → login form",     anonAdmin.body.indexOf("Admin API key") !== -1);
    check("anon admin does not leak the queue",  anonAdmin.body.indexOf(XSS_ESCAPED) === -1 && anonAdmin.body.indexOf("Recent ratings") === -1);
  } finally {
    await _teardown(sf);
    await _teardown(admin);
  }
}

module.exports = { run: _run };
