"use strict";
/**
 * Admin console table reflow (WCAG 1.4.10).
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * customers), seeds one customer + one order, and verifies that admin DATA
 * tables ship inside a `.table-wrap` horizontal-scroll container while the
 * order-summary LAYOUT table (`.order-totals`) does NOT — a wrongly-wrapped
 * layout table would be a cosmetic regression. Also asserts the `.table-wrap`
 * rule shipped in admin.css and that `th[scope]` survived the wrap.
 *
 * Reads admin.css from disk (a theme asset, not under worker/ — no
 * fs.existsSync guard / in-image deploy-brick risk). Network: zero.
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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql", "0004_shop_config.sql", "0006_customers.sql", "0205_customer_oauth_identities.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
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

// A minimal valid order for a customer — createFromCart needs a cart_id +
// session_id (UUID-shaped), one line, totals, and a ship_to with a country.
async function _seedOrder(query, order, customerId) {
  var cartId = b.uuid.v7();
  var sessionId = b.uuid.v7();
  var now = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionId, customerId, now, now + 86400000],
  );
  return order.createFromCart({
    cart_id:           cartId,
    session_id:        sessionId,
    customer_id:       customerId,
    lines:             [{ variant_id: b.uuid.v7(), sku: "SKU-1", qty: 1, unit_amount_minor: 1000 }],
    currency:          "USD",
    subtotal_minor:    1000,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 1000,
    ship_to:           { country: "US" },
  });
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var order    = bShop.order.create({ query: query, cursorSecret: "table-reflow-order" });
  var config   = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query, cursorSecret: "table-reflow" });

  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Anderson" });
  var seeded = await _seedOrder(query, order, alice.id);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-table-reflow-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, customers: customers, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // A DATA table (the customer roster) ships inside a .table-wrap container.
    var roster = await helpers.httpRequest({ port: port, path: "/admin/customers", jar: jar });
    check("customers page then 200",             roster.status === 200);
    check("roster renders a data table",         roster.body.indexOf("Alice Anderson") !== -1);
    check("data table wrapped for reflow",       roster.body.indexOf("<div class=\"table-wrap\"><table") !== -1);
    // The wrap must not strip header-cell scoping (WCAG 1.3.1).
    check("th scope attributes preserved",       roster.body.indexOf("scope=\"col\"") !== -1);

    // The order-totals LAYOUT table is NOT wrapped (it never overflows).
    var detail = await helpers.httpRequest({ port: port, path: "/admin/orders/" + seeded.id, jar: jar });
    check("order detail then 200",               detail.status === 200);
    check("order-totals table renders",          detail.body.indexOf("<table class=\"order-totals\"") !== -1);
    check("layout order-totals NOT wrapped",     detail.body.indexOf("<div class=\"table-wrap\"><table class=\"order-totals\"") === -1);
    // The order line-items table on the same page IS a data table, so it is
    // wrapped — proves data/layout are classified, not blanket-wrapped.
    check("order line-items data table wrapped",  detail.body.indexOf("<div class=\"table-wrap\"><table") !== -1);

    // The .table-wrap rule shipped in admin.css (read the theme asset off disk).
    var cssPath = nodePath.resolve(__dirname, "..", "..", "themes", "default", "assets", "css", "admin.css");
    var cssText = nodeFs.readFileSync(cssPath, "utf8");
    check("table-wrap rule present in admin.css", cssText.indexOf(".table-wrap") !== -1 && cssText.indexOf("overflow-x") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };

// Allow direct invocation.
if (require.main === module) {
  _run().then(function () {
    console.log("OK — admin-table-reflow (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — admin-table-reflow: " + (err && err.message || err));
    process.exit(1);
  });
}
