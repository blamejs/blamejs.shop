"use strict";
/**
 * Admin setup wizard — full HTTP integration of the browser-session
 * admin pages.
 *
 * Boots a real `b.createApp` server with `admin.mount` wired with a
 * token + catalog + order + config + analytics, against one in-memory
 * `node:sqlite` DB. Exercises the sign-in gate (sealed `shop_admin`
 * cookie minted on a correct token, refused on a wrong one), the setup
 * wizard's read + save + validation, the setup-complete landing, and
 * the dashboard reachable by EITHER the cookie or the bearer token.
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

var TOKEN = "admin-token-0123456789abcdef-test"; // ≥ 16 chars

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql", "0004_shop_config.sql"]
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
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var order     = bShop.order.create({ query: query, cursorSecret: "admin-flow" });
  var config    = bShop.config.create({ query: query });
  var analytics = bShop.analytics.create({ query: query });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-admin-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        analytics: analytics, shop_name: "Test Shop",
        integrations: { stripe: "enabled", express_checkout: "action", google_signin: "off" },
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    // Unauthenticated landing renders the sign-in form, not the admin.
    var anon = await helpers.httpRequest({ port: port, path: "/admin" });
    check("anon /admin then 200",              anon.status === 200);
    check("anon sees the sign-in form",         anon.body.indexOf("Admin API key") !== -1);
    check("anon does NOT see the dashboard nav", anon.body.indexOf("Setup wizard") === -1);

    // Wrong token is refused.
    var bad = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: "wrong-token-wrong-token-xx" } });
    check("bad login then 401",                bad.status === 401);
    check("no admin cookie on bad login",       !/shop_admin=/.test(String(bad.headers["set-cookie"] || "")));

    // Correct token signs in → sealed cookie + redirect to setup
    // (setup not yet complete).
    var jar = helpers.cookieJar();
    var ok = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("good login then 303",               ok.status === 303);
    check("admin cookie set",                  !!jar.get("shop_admin"));
    check("login redirects to setup",          (ok.headers.location || "") === "/admin/setup");

    // The wizard renders (cookie-authed), prefilled from the shop_name default.
    var form = await helpers.httpRequest({ port: port, path: "/admin/setup", jar: jar });
    check("setup form then 200",               form.status === 200);
    check("setup form shows the fields",        form.body.indexOf("Default currency") !== -1);

    // Bad currency re-renders with a notice (400), never a 500.
    var badSave = await helpers.httpRequest({ port: port, path: "/admin/setup", method: "POST", jar: jar,
      form: { shop_name: "My Shop", currency: "DOLLARS" } });
    check("bad currency then 400",             badSave.status === 400);
    check("bad currency shows a notice",        badSave.body.indexOf("3-letter ISO") !== -1);

    // Valid save persists to shop_config + redirects (PRG).
    var save = await helpers.httpRequest({ port: port, path: "/admin/setup", method: "POST", jar: jar,
      form: { shop_name: "My Shop", contact_email: "ops@example.com", currency: "usd", support_url: "https://help.example.com" } });
    check("valid save then 303",               save.status === 303);
    check("save redirects with saved flag",     (save.headers.location || "").indexOf("/admin/setup?saved=1") === 0);
    check("shop.name persisted",               (await config.getFresh("shop.name")) === "My Shop");
    check("currency upper-cased + persisted",   (await config.getFresh("shop.currency")) === "USD");
    check("setup marked complete",             (await config.getFresh("setup.completed")) === true);

    // Landing no longer nags about setup, and shows the nav.
    var landing = await helpers.httpRequest({ port: port, path: "/admin", jar: jar });
    check("landing then 200",                  landing.status === 200);
    check("landing shows nav",                 landing.body.indexOf("Setup wizard") !== -1);
    check("landing setup banner gone",          landing.body.indexOf("isn't set up yet") === -1);

    // Dashboard reachable by the cookie (browser) ...
    var dashCookie = await helpers.httpRequest({ port: port, path: "/admin/dashboard", jar: jar });
    check("dashboard via cookie then 200",     dashCookie.status === 200);
    check("dashboard renders the shell",        dashCookie.body.indexOf("/ admin") !== -1);

    // ... and by the bearer token (tooling), with no cookie.
    var dashBearer = await helpers.httpRequest({ port: port, path: "/admin/dashboard", headers: bearer });
    check("dashboard via bearer then 200",     dashBearer.status === 200);

    // Integrations status page reflects the live on/off map.
    var integ = await helpers.httpRequest({ port: port, path: "/admin/integrations", jar: jar });
    check("integrations page then 200",        integ.status === 200);
    check("integrations shows enabled Stripe",  integ.body.indexOf("Card checkout (Stripe)") !== -1 && integ.body.indexOf("Enabled") !== -1);
    check("wallets show action-needed",         integ.body.indexOf("Action needed") !== -1);
    check("integrations shows what to set",      integ.body.indexOf("GOOGLE_OAUTH_CLIENT_ID") !== -1 && integ.body.indexOf("Not configured") !== -1);
    // Unauthenticated integrations page renders the login form, not status.
    var integAnon = await helpers.httpRequest({ port: port, path: "/admin/integrations" });
    check("anon integrations → login form",     integAnon.body.indexOf("Admin API key") !== -1);

    // Console nav is present on authed pages.
    check("authed page has console nav",        dashCookie.body.indexOf("admin-nav") !== -1 && dashCookie.body.indexOf("\"/admin/products\"") !== -1);

    // Products console: HTML for the browser cookie, JSON for the bearer
    // token (the API contract is unchanged).
    var prodHtml = await helpers.httpRequest({ port: port, path: "/admin/products", jar: jar });
    check("products page then 200",            prodHtml.status === 200);
    check("products page shows create form",    prodHtml.body.indexOf("New product") !== -1);
    var prodApi = await helpers.httpRequest({ port: port, path: "/admin/products", headers: bearer });
    check("products API still JSON for bearer",  (prodApi.headers["content-type"] || "").indexOf("application/json") === 0);

    // Create a product via the browser form → PRG redirect, then it shows.
    var createP = await helpers.httpRequest({ port: port, path: "/admin/products", method: "POST", jar: jar,
      form: { title: "Console Widget", slug: "console-widget", status: "active" } });
    check("product create then 303",           createP.status === 303);
    check("product create redirects created",   (createP.headers.location || "").indexOf("/admin/products?created=1") === 0);
    var prodList = await helpers.httpRequest({ port: port, path: "/admin/products?created=1", jar: jar });
    check("created product in the list",        prodList.body.indexOf("Console Widget") !== -1);
    check("created banner shows",               prodList.body.indexOf("Product created") !== -1);
    // Bad create (missing slug) re-renders with a notice, not a 500.
    var badCreate = await helpers.httpRequest({ port: port, path: "/admin/products", method: "POST", jar: jar, form: { title: "No Slug" } });
    check("bad product create then 400",        badCreate.status === 400);
    // Unauthenticated products page → sign-in form, not data.
    var prodAnon = await helpers.httpRequest({ port: port, path: "/admin/products" });
    check("anon products → login form",         prodAnon.body.indexOf("Admin API key") !== -1);

    // ---- orders console -------------------------------------------------
    // Seed a paid order (direct insert against a real cart so the cart FK
    // holds) with one line, to exercise the list + detail + transition UI.
    var cart = bShop.cart.create({ query: query, catalog: catalog });
    var seededCart = await cart.create("admin-order-sess", { currency: "USD" });
    var orderId = b.uuid.v7();
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
      "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
      "payment_intent_id, ship_to_json, customer_email_hash, created_at, updated_at) " +
      "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 2999, 0, 240, 500, 3739, ?4, ?5, NULL, ?6, ?6)",
      [orderId, seededCart.id, "admin-order-sess", "pi_test_123",
       JSON.stringify({ name: "Buyer", line1: "1 Main St", city: "Town", country: "US" }), Date.now()],
    );
    await query(
      "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
      "VALUES (?1, ?2, ?3, ?4, 1, 2999, 'USD', 2999)",
      [b.uuid.v7(), orderId, b.uuid.v7(), "WIDGET-1"],
    );

    // List: HTML for the browser, JSON for the bearer token.
    var ordersHtml = await helpers.httpRequest({ port: port, path: "/admin/orders", jar: jar });
    check("orders page then 200",              ordersHtml.status === 200);
    check("orders list shows the order",        ordersHtml.body.indexOf(orderId.slice(0, 8)) !== -1);
    check("orders list has status filters",     ordersHtml.body.indexOf("order-filters") !== -1);
    var ordersApi = await helpers.httpRequest({ port: port, path: "/admin/orders", headers: bearer });
    check("orders API still JSON for bearer",    (ordersApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("orders API returns the row",          JSON.parse(ordersApi.body).rows.length === 1);

    // Status filter narrows; a bad filter falls back to all with a notice.
    var paidOnly = await helpers.httpRequest({ port: port, path: "/admin/orders?status=paid", jar: jar });
    check("paid filter shows the order",        paidOnly.body.indexOf(orderId.slice(0, 8)) !== -1);
    var shippedOnly = await helpers.httpRequest({ port: port, path: "/admin/orders?status=shipped", jar: jar });
    check("shipped filter hides the paid order", shippedOnly.body.indexOf(orderId.slice(0, 8)) === -1);
    var badFilter = await helpers.httpRequest({ port: port, path: "/admin/orders?status=bogus", jar: jar });
    check("bad status filter then 200",         badFilter.status === 200);
    check("bad status filter shows a notice",    badFilter.body.indexOf("Unknown status filter") !== -1);

    // Detail: shows line items + the legal next actions (paid → fulfil / cancel / refund).
    var detail = await helpers.httpRequest({ port: port, path: "/admin/orders/" + orderId, jar: jar });
    check("order detail then 200",             detail.status === 200);
    check("order detail shows the SKU",         detail.body.indexOf("WIDGET-1") !== -1);
    check("order detail offers fulfil action",  detail.body.indexOf("Start fulfilment") !== -1);
    var detailApi = await helpers.httpRequest({ port: port, path: "/admin/orders/" + orderId, headers: bearer });
    check("order detail API still JSON",         (detailApi.headers["content-type"] || "").indexOf("application/json") === 0);
    // A bad id renders the 404 list page, not a 500.
    var missing = await helpers.httpRequest({ port: port, path: "/admin/orders/not-a-real-id", jar: jar });
    check("missing order then 404",            missing.status === 404);

    // Transition via the browser form → PRG to the detail, status advances.
    var move = await helpers.httpRequest({ port: port, path: "/admin/orders/" + orderId + "/transition",
      method: "POST", jar: jar, form: { event: "start_fulfillment" } });
    check("transition then 303",               move.status === 303);
    check("transition redirects to detail",     (move.headers.location || "").indexOf("/admin/orders/" + orderId) === 0);
    check("order advanced to fulfilling",      (await order.get(orderId)).status === "fulfilling");

    // An illegal transition from the new status is refused (redirect with
    // an error flag), never a 500, and leaves the status unchanged.
    var illegal = await helpers.httpRequest({ port: port, path: "/admin/orders/" + orderId + "/transition",
      method: "POST", jar: jar, form: { event: "mark_paid" } });
    check("illegal transition then 303",       illegal.status === 303);
    check("illegal transition flags err",       (illegal.headers.location || "").indexOf("err=1") !== -1);
    check("status unchanged after refusal",    (await order.get(orderId)).status === "fulfilling");

    // Orders nav + page gated to authed users.
    var ordersAnon = await helpers.httpRequest({ port: port, path: "/admin/orders" });
    check("anon orders → login form",           ordersAnon.body.indexOf("Admin API key") !== -1);

    // Setup POST without auth bounces to the landing (no write).
    var noAuth = await helpers.httpRequest({ port: port, path: "/admin/setup", method: "POST", form: { shop_name: "Hijack" } });
    check("unauth setup POST then 303",        noAuth.status === 303);
    check("unauth setup redirects to /admin",   (noAuth.headers.location || "") === "/admin");
    check("unauth POST did not overwrite",      (await config.getFresh("shop.name")) === "My Shop");

    // Sign out clears the cookie.
    var out = await helpers.httpRequest({ port: port, path: "/admin/logout", method: "POST", jar: jar });
    check("logout then 303",                   out.status === 303);
    check("logout clears the cookie",          /shop_admin=;|shop_admin=;? ?Max-Age=0|shop_admin=\s*;/.test(String(out.headers["set-cookie"] || "")) || jar.get("shop_admin") === "");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
