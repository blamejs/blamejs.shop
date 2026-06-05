"use strict";
/**
 * Read-only analytics console — /admin/analytics.
 *
 * Complements /admin/reports: the report screen owns the orders-derived money
 * view (gross/net/AOV/refund-rate, order-FSM status funnel, top products by
 * revenue); this screen owns what the report does NOT — units-ranked SKU
 * performance, the browse→buy funnel + conversion rate, most-viewed products,
 * top search terms, and a revenue-by-day trend sparkline.
 *
 * Two layers, mirroring the audit-console split:
 *   - A deterministic renderer unit test (renderAdminAnalytics) pins row
 *     display, escape-by-default on every cell (the XSS regression), the
 *     honest empty state, and the cross-link to /admin/reports — independent
 *     of any live DB.
 *   - HTTP integration drives the wired route end-to-end over an in-memory
 *     SQLite DB seeded with one order + line + a few events: auth-gates both
 *     shapes (anon → sign-in form, bearer → JSON contract, cookie → HTML),
 *     renders the seeded rows escaped, and 400s a malformed date window on
 *     the JSON surface while the HTML surface degrades to a notice.
 *
 * Network: zero — every request lands on 127.0.0.1. NO worker/ import.
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

// catalog + cart + order + config + the analytics_events table. carts is
// needed because orders carries a FK to carts(id); analytics_events is the
// event-stream source the funnel/viewed/search aggregates read.
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
  "0004_shop_config.sql", "0019_analytics_events.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeDb() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return db;
}
function _queryFor(db) {
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

// Seed one paid order + two lines + a handful of events inside `now`'s
// 30-day default window so every aggregate the screen runs returns a row.
function _seed(db) {
  var now = Date.now();
  var t = now - b.constants.TIME.days(2); // safely inside the 30-day window
  db.prepare(
    "INSERT INTO carts (id, session_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, 'sess-1', 'USD', 'converted', ?2, ?2, ?2)"
  ).run("cart-an-1", t);
  db.prepare(
    "INSERT INTO orders (id, cart_id, session_id, status, currency, subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, 'cart-an-1', 'sess-1', 'paid', 'USD', 3000, 0, 0, 0, 3000, '{}', ?2, ?2)"
  ).run("ord-an-1", t);
  db.prepare(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, 'ord-an-1', 'var-1', 'SKU-ALPHA', 5, 400, 'USD', 2000)"
  ).run("ol-an-1");
  db.prepare(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, 'ord-an-1', 'var-2', 'SKU-BETA', 2, 500, 'USD', 1000)"
  ).run("ol-an-2");
  // Event stream — a PDP view, a search, and the full funnel chain.
  var ev = db.prepare(
    "INSERT INTO analytics_events (id, event_type, session_id_hash, customer_id_hash, payload_json, product_id, search_q, page_url, user_agent_class, occurred_at) " +
    "VALUES (?1, ?2, 'sh', NULL, '{}', ?3, ?4, NULL, 'desktop', ?5)"
  );
  ev.run("ev-1", "pdp_view",          "prod-alpha", null,       t);
  ev.run("ev-2", "pdp_view",          "prod-alpha", null,       t);
  ev.run("ev-3", "search_query",      null,         "blue mug", t);
  ev.run("ev-4", "cart_add",          "prod-alpha", null,       t);
  ev.run("ev-5", "checkout_start",    null,         null,       t);
  ev.run("ev-6", "checkout_complete", null,         null,       t);
}

// ---- renderer unit: display + escape-by-default + empty state (no DB) ---
function _renderUnit() {
  var view = {
    from: 1717200000000, to: 1719792000000, currency: "USD",
    top_skus: [
      { sku: "<script>alert(1)</script>", units_sold: 5, revenue_minor: 2000, currency: "USD" },
    ],
    by_day: [{ day: "2024-06-01", currency: "USD", revenue_minor: 2000 }],
    top_viewed_products: [{ product_id: "<img src=x onerror=alert(1)>", count: 9 }],
    top_search_terms: [{ search_q: "<b>inject</b>", count: 3 }],
    funnel: { pdp_views: 10, cart_adds: 4, checkout_starts: 2, checkout_completes: 1, conversion_rate: 0.1 },
  };
  var html = bShop.admin.renderAdminAnalytics({
    shop_name: "Test Shop", nav_available: { analytics: true }, view: view,
  });
  check("render nav includes /admin/analytics", html.indexOf("\"/admin/analytics\"") !== -1);
  check("render links to /admin/reports",       html.indexOf("/admin/reports") !== -1);
  check("render shows conversion rate",          html.indexOf("10.00%") !== -1);
  check("render shows the SKU units",            html.indexOf("SKU") !== -1 || html.indexOf(">5<") !== -1);

  // XSS regression — every cell is escape-by-default: raw payload ABSENT,
  // escaped form PRESENT, across all three free-text-bearing tables.
  check("render raw <script> absent",            html.indexOf("<script>alert(1)</script>") === -1);
  check("render escaped &lt;script&gt; present", html.indexOf("&lt;script&gt;") !== -1);
  check("render raw <img onerror absent",        html.indexOf("<img src=x onerror=") === -1);
  check("render escaped &lt;img present",        html.indexOf("&lt;img src=x") !== -1);
  check("render raw <b>inject</b> absent",       html.indexOf("<b>inject</b>") === -1);
  check("render escaped &lt;b&gt;inject present", html.indexOf("&lt;b&gt;inject") !== -1);

  // Honest empty state — every aggregate empty → each table shows its own
  // empty message, no 500, no stray rows.
  var empty = bShop.admin.renderAdminAnalytics({
    shop_name: "S", nav_available: { analytics: true },
    view: {
      from: 1717200000000, to: 1719792000000, currency: "USD",
      top_skus: [], by_day: [], top_viewed_products: [], top_search_terms: [],
      funnel: { pdp_views: 0, cart_adds: 0, checkout_starts: 0, checkout_completes: 0, conversion_rate: 0 },
    },
  });
  check("empty SKUs message",          empty.indexOf("No sales in this window.") !== -1);
  check("empty views message",         empty.indexOf("No product views in this window.") !== -1);
  check("empty searches message",      empty.indexOf("No searches in this window.") !== -1);
  check("empty conversion rate 0.00%", empty.indexOf("0.00%") !== -1);

  // Negative net revenue (refund-dominated window) must format, not throw.
  var neg = bShop.admin.renderAdminAnalytics({
    shop_name: "S", nav_available: { analytics: true },
    view: {
      from: 1717200000000, to: 1719792000000, currency: "USD",
      top_skus: [{ sku: "SKU-REF", units_sold: 1, revenue_minor: -500, currency: "USD" }],
      by_day: [], top_viewed_products: [], top_search_terms: [],
      funnel: { pdp_views: 0, cart_adds: 0, checkout_starts: 0, checkout_completes: 0, conversion_rate: 0 },
    },
  });
  check("negative revenue renders with minus sign", neg.indexOf("-$5.00") !== -1);
}

async function _run() {
  // Renderer unit first — deterministic, no server/DB.
  _renderUnit();

  var db      = _makeDb();
  _seed(db);
  var query   = _queryFor(db);
  var catalog = bShop.catalog.create({ query: query });
  var config  = bShop.config.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "an-ord" });
  var analytics = bShop.analytics.create({ query: query });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-analytics-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, config: config, order: order,
        analytics: analytics, shop_name: "Test Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",          login.status === 303);

    // HTML console renders 200 with the nav link + the seeded rows.
    var html = await helpers.httpRequest({ port: port, path: "/admin/analytics", jar: jar });
    check("analytics screen then 200",     html.status === 200);
    check("nav includes /admin/analytics", html.body.indexOf("\"/admin/analytics\"") !== -1);
    check("links to /admin/reports",       html.body.indexOf("/admin/reports") !== -1);
    check("renders seeded SKU-ALPHA",      html.body.indexOf("SKU-ALPHA") !== -1);
    check("renders seeded search term",    html.body.indexOf("blue mug") !== -1);
    check("renders viewed product id",     html.body.indexOf("prod-alpha") !== -1);
    // funnel: 2 PDP views → 1 complete = 50% conversion.
    check("renders conversion rate",       html.body.indexOf("50.00%") !== -1);

    // Bearer GET → JSON contract, 200, the documented view shape.
    var api = await helpers.httpRequest({ port: port, path: "/admin/analytics", headers: bearer });
    check("analytics API is JSON",         (api.headers["content-type"] || "").indexOf("application/json") === 0);
    check("analytics API then 200",        api.status === 200);
    var payload = JSON.parse(api.body);
    check("API exposes funnel",            payload.funnel && typeof payload.funnel.conversion_rate === "number");
    check("API exposes top_skus array",    Array.isArray(payload.top_skus) && payload.top_skus.length >= 1);
    check("API exposes top_search_terms",  Array.isArray(payload.top_search_terms));
    check("API top_skus bounded ≤ 10",     payload.top_skus.length <= 10);

    // Date-window validation: a malformed date 400s on the JSON surface.
    var bad = await helpers.httpRequest({ port: port, path: "/admin/analytics?from-date=not-a-date", headers: bearer });
    check("bad date → 400 (JSON)",         bad.status === 400);
    // An inverted window (from after to) is refused by the primitive → 400.
    var inverted = await helpers.httpRequest({ port: port, path: "/admin/analytics?from=2000&to=1000", headers: bearer });
    check("inverted window → 400 (JSON)",  inverted.status === 400);

    // HTML surface degrades a bad window to the default-window view + a
    // correction notice rather than 500-ing.
    var badHtml = await helpers.httpRequest({ port: port, path: "/admin/analytics?from-date=not-a-date", jar: jar });
    check("bad date HTML then 200",        badHtml.status === 200);
    check("bad date HTML shows notice",    badHtml.body.indexOf("banner--warn") !== -1);

    // The complementary JSON endpoints exist + carry their bounds.
    var terms = await helpers.httpRequest({ port: port, path: "/admin/analytics/top-search-terms", headers: bearer });
    check("top-search-terms JSON 200",     terms.status === 200 && Array.isArray(JSON.parse(terms.body).rows));
    var viewed = await helpers.httpRequest({ port: port, path: "/admin/analytics/top-viewed-products?limit=999", headers: bearer });
    check("viewed limit>max → 400",        viewed.status === 400);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/analytics" });
    check("anon analytics → login form",   anon.body.indexOf("Admin API key") !== -1);
    check("anon analytics hides data",     anon.body.indexOf("SKU-ALPHA") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
    try { db.close(); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
