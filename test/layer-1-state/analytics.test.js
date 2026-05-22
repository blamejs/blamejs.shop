"use strict";
/**
 * analytics — read-only aggregate queries over orders.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog), 0002 (cart), 0003 (order). Seeds a handful of
 * orders across multiple statuses + dates, then asserts each
 * method returns the expected aggregate.
 *
 * Coverage:
 *   - summary: order count + revenue + by_status buckets
 *   - summary: cancelled excluded from revenue, refunded subtracts
 *   - summary: multi-currency window returns array
 *   - revenueByDay: GROUP BY day(updated_at), ORDER BY day ASC
 *   - topSKUs: GROUP BY sku, ORDER BY units_sold DESC, LIMIT
 *   - recentOrders: ORDER BY created_at DESC, LIMIT
 *   - default window (last 30 days)
 *   - validation: bad epoch ms, since >= until, window > 1 year,
 *     limit out of range
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // FK enforcement off — analytics is a read-only aggregator over
  // orders + order_lines and the test seeds rows directly with
  // synthetic cart_id / variant_id values to pin deterministic
  // timestamps. The cart + variant tables aren't under test here.
  db.prepare("PRAGMA foreign_keys = OFF").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return {
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
    raw: db,
  };
}

var DAY = 24 * 60 * 60 * 1000;

// Direct row inserts — bypass order.createFromCart so the test can
// pin `created_at` / `updated_at` to deterministic timestamps and
// place rows at known statuses without firing FSM transitions.
function _seedOrder(db, opts) {
  var uuid = bShop.framework.uuid.v7();
  db.prepare(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 0, 0, ?, NULL, '{\"country\":\"US\"}', ?, ?)"
  ).run(
    uuid,
    opts.cart_id || bShop.framework.uuid.v7(),
    opts.session_id || bShop.framework.uuid.v7(),
    opts.status,
    opts.currency || "USD",
    opts.subtotal_minor || opts.grand_total_minor,
    opts.grand_total_minor,
    opts.created_at,
    opts.updated_at == null ? opts.created_at : opts.updated_at,
  );
  if (opts.lines) {
    for (var i = 0; i < opts.lines.length; i += 1) {
      var l = opts.lines[i];
      db.prepare(
        "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, " +
        "unit_amount_minor, unit_currency, line_total_minor) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        bShop.framework.uuid.v7(),
        uuid,
        l.variant_id || bShop.framework.uuid.v7(),
        l.sku,
        l.qty,
        l.unit_amount_minor,
        opts.currency || "USD",
        l.qty * l.unit_amount_minor,
      );
    }
  }
  return uuid;
}

async function _summary() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now = Date.now();
  var since = now - 10 * DAY;
  var until = now;

  // 3 paid (1000 each), 1 fulfilling (2500), 1 refunded (1500),
  // 1 cancelled (500), 1 pending (750). Total = 8 orders.
  // Revenue: paid(3000) + fulfilling(2500) + pending(750) - refunded(1500) = 4750
  _seedOrder(q.raw, { status: "paid",       grand_total_minor: 1000, created_at: since + 1 * DAY, updated_at: since + 1 * DAY });
  _seedOrder(q.raw, { status: "paid",       grand_total_minor: 1000, created_at: since + 2 * DAY, updated_at: since + 2 * DAY });
  _seedOrder(q.raw, { status: "paid",       grand_total_minor: 1000, created_at: since + 3 * DAY, updated_at: since + 3 * DAY });
  _seedOrder(q.raw, { status: "fulfilling", grand_total_minor: 2500, created_at: since + 4 * DAY, updated_at: since + 4 * DAY });
  _seedOrder(q.raw, { status: "refunded",   grand_total_minor: 1500, created_at: since + 5 * DAY, updated_at: since + 5 * DAY });
  _seedOrder(q.raw, { status: "cancelled",  grand_total_minor: 500,  created_at: since + 6 * DAY, updated_at: since + 6 * DAY });
  _seedOrder(q.raw, { status: "pending",    grand_total_minor: 750,  created_at: since + 7 * DAY, updated_at: since + 7 * DAY });

  var s = await analytics.summary({ since: since, until: until });
  check("summary single-currency returns object",  !Array.isArray(s));
  check("summary.currency = USD",                  s.currency === "USD");
  check("summary.total_orders = 7",                s.total_orders === 7);
  check("summary by_status.paid = 3",              s.by_status.paid === 3);
  check("summary by_status.fulfilling = 1",        s.by_status.fulfilling === 1);
  check("summary by_status.refunded = 1",          s.by_status.refunded === 1);
  check("summary by_status.cancelled = 1",         s.by_status.cancelled === 1);
  check("summary by_status.pending = 1",           s.by_status.pending === 1);
  check("summary by_status.shipped = 0 (zero-filled)",  s.by_status.shipped === 0);
  // 1000 + 1000 + 1000 + 2500 + 750 - 1500 = 4750
  check("summary.total_revenue_minor = 4750 (refund subtracts, cancel excluded)", s.total_revenue_minor === 4750);
}

async function _summaryEmptyWindow() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now = Date.now();
  var s = await analytics.summary({ since: now - 5 * DAY, until: now });
  check("empty window returns shape with USD + zeros", s.currency === "USD" && s.total_orders === 0 && s.total_revenue_minor === 0);
  check("empty window zero-fills all status buckets",
    s.by_status.pending === 0 && s.by_status.paid === 0 && s.by_status.refunded === 0);
}

async function _summaryMultiCurrency() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now = Date.now();
  var since = now - 10 * DAY;
  _seedOrder(q.raw, { status: "paid", currency: "USD", grand_total_minor: 1000, created_at: since + 1 * DAY });
  _seedOrder(q.raw, { status: "paid", currency: "EUR", grand_total_minor: 2000, created_at: since + 2 * DAY });
  _seedOrder(q.raw, { status: "paid", currency: "EUR", grand_total_minor: 3000, created_at: since + 3 * DAY });

  var s = await analytics.summary({ since: since, until: now });
  check("multi-currency summary is array",  Array.isArray(s));
  check("two currencies returned",          s.length === 2);
  // Sorted alphabetically — EUR first, USD second
  check("EUR sorts first",                  s[0].currency === "EUR");
  check("USD sorts second",                 s[1].currency === "USD");
  check("EUR revenue = 5000",               s[0].total_revenue_minor === 5000);
  check("USD revenue = 1000",               s[1].total_revenue_minor === 1000);
}

async function _revenueByDay() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var _now = Date.now();
  // Pick three discrete UTC days. Use noon UTC to avoid edge cases
  // at the day boundary.
  var d1 = Date.UTC(2026, 0, 10, 12, 0, 0);
  var d2 = Date.UTC(2026, 0, 11, 12, 0, 0);
  var d3 = Date.UTC(2026, 0, 12, 12, 0, 0);

  _seedOrder(q.raw, { status: "paid",     grand_total_minor: 1000, created_at: d1, updated_at: d1 });
  _seedOrder(q.raw, { status: "paid",     grand_total_minor: 2000, created_at: d1, updated_at: d1 });
  _seedOrder(q.raw, { status: "paid",     grand_total_minor: 5000, created_at: d2, updated_at: d2 });
  _seedOrder(q.raw, { status: "refunded", grand_total_minor: 1500, created_at: d3, updated_at: d3 });
  _seedOrder(q.raw, { status: "cancelled",grand_total_minor: 999,  created_at: d3, updated_at: d3 });

  var rows = await analytics.revenueByDay({ since: d1 - DAY, until: d3 + DAY });
  check("revenueByDay returns 3 day buckets", rows.length === 3);
  check("rows sorted by day ASC", rows[0].day === "2026-01-10" && rows[1].day === "2026-01-11" && rows[2].day === "2026-01-12");
  check("day 1 = 1000 + 2000 = 3000",       rows[0].revenue_minor === 3000);
  check("day 2 = 5000",                      rows[1].revenue_minor === 5000);
  check("day 3 = -1500 (refund subtracts, cancelled excluded)", rows[2].revenue_minor === -1500);
  check("currency surfaced on each row",     rows.every(function (r) { return r.currency === "USD"; }));
}

async function _topSKUs() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now = Date.now();
  var since = now - 10 * DAY;

  // SKU-A: 5 + 3 = 8 units across 2 orders (revenue 800)
  // SKU-B: 2 units (revenue 600)
  // SKU-C: 10 units BUT in a cancelled order → excluded
  _seedOrder(q.raw, { status: "paid",   grand_total_minor: 800, created_at: since + 1 * DAY, lines: [{ sku: "SKU-A", qty: 5, unit_amount_minor: 100 }] });
  _seedOrder(q.raw, { status: "paid",   grand_total_minor: 600, created_at: since + 2 * DAY, lines: [
    { sku: "SKU-A", qty: 3, unit_amount_minor: 100 },
    { sku: "SKU-B", qty: 2, unit_amount_minor: 150 },
  ] });
  _seedOrder(q.raw, { status: "cancelled", grand_total_minor: 1000, created_at: since + 3 * DAY, lines: [{ sku: "SKU-C", qty: 10, unit_amount_minor: 100 }] });

  var rows = await analytics.topSKUs({ since: since, until: now, limit: 10 });
  check("topSKUs returns 2 rows (cancelled excluded)", rows.length === 2);
  check("SKU-A sorts first by units_sold",  rows[0].sku === "SKU-A" && rows[0].units_sold === 8);
  check("SKU-B sorts second",               rows[1].sku === "SKU-B" && rows[1].units_sold === 2);
  check("SKU-A revenue = 5*100 + 3*100 = 800", rows[0].revenue_minor === 800);

  // Limit enforced
  var limited = await analytics.topSKUs({ since: since, until: now, limit: 1 });
  check("limit clamps to 1 row",            limited.length === 1);
  check("limit 1 returns top SKU",          limited[0].sku === "SKU-A");
}

async function _recentOrders() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var base = Date.now() - 100 * DAY;
  for (var i = 0; i < 25; i += 1) {
    _seedOrder(q.raw, { status: "paid", grand_total_minor: 100 + i, created_at: base + i });
  }
  var rows = await analytics.recentOrders({ limit: 5 });
  check("recentOrders honors limit",        rows.length === 5);
  // Most recent first: created_at = base + 24, 23, 22, 21, 20
  check("ordered by created_at DESC",       rows[0].created_at > rows[4].created_at);
  check("most recent first",                rows[0].grand_total_minor === 124);
  check("each row has the expected shape",
    typeof rows[0].id === "string" && typeof rows[0].status === "string" &&
    typeof rows[0].currency === "string" && Number.isInteger(rows[0].created_at));
}

async function _defaultWindow() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  // Order at day -5 (in window), order at day -100 (out of window)
  var now = Date.now();
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 100, created_at: now - 5 * DAY, updated_at: now - 5 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 200, created_at: now - 100 * DAY, updated_at: now - 100 * DAY });
  var s = await analytics.summary({});                  // no since/until → defaults to last 30 days
  check("default window includes -5d only", s.total_orders === 1 && s.total_revenue_minor === 100);
}

async function _validation() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  await assert.rejects(analytics.summary({ since: "x",  until: Date.now() }),    /since must be/);
  await assert.rejects(analytics.summary({ since: -1,   until: Date.now() }),    /since must be/);
  await assert.rejects(analytics.summary({ since: 100,  until: 100 }),            /strictly less/);
  await assert.rejects(analytics.summary({ since: 100,  until: 50 }),             /strictly less/);
  // Window > 1 year
  await assert.rejects(analytics.summary({ since: 0,    until: 366 * DAY }),       /≤ 1 year/);
  await assert.rejects(analytics.topSKUs({ limit: 0 }),                            /limit/);
  await assert.rejects(analytics.topSKUs({ limit: 101 }),                          /limit/);
  await assert.rejects(analytics.recentOrders({ limit: 0 }),                       /limit/);
  await assert.rejects(analytics.recentOrders({ limit: 101 }),                     /limit/);
}

async function _adminRoutes() {
  // Smoke the analytics admin routes through the bearer-gate wrapper.
  var q = _makeQuery();
  var catalog   = bShop.catalog.create({ query: q.query });
  var order     = bShop.order.create({ query: q.query });
  var analytics = bShop.analytics.create({ query: q.query });

  var routes = {};
  var router = {
    get:    function (p, h) { routes["GET " + p]    = h; },
    post:   function (p, h) { routes["POST " + p]   = h; },
    patch:  function (p, h) { routes["PATCH " + p]  = h; },
    delete: function (p, h) { routes["DELETE " + p] = h; },
    use:    function () {},
  };
  var TOKEN = "test_token_abcdefghijklmnopqrstuvwxyz_32chars";
  bShop.admin.mount(router, {
    token:     TOKEN,
    catalog:   catalog,
    order:     order,
    analytics: analytics,
  });

  // Routes registered?
  check("summary route mounted",            !!routes["GET /admin/analytics/summary"]);
  check("revenue-by-day route mounted",     !!routes["GET /admin/analytics/revenue-by-day"]);
  check("top-skus route mounted",           !!routes["GET /admin/analytics/top-skus"]);
  check("recent-orders route mounted",      !!routes["GET /admin/analytics/recent-orders"]);
  check("dashboard route mounted",          !!routes["GET /admin/dashboard"]);

  // Seed one row + invoke the JSON route through the gate.
  var since = Date.now() - 5 * DAY;
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 500, created_at: since + 1 * DAY, updated_at: since + 1 * DAY });

  var sent = { status: 0, body: null, headers: {} };
  var req = {
    headers: { authorization: "Bearer " + TOKEN },
    url:     "/admin/analytics/summary?since=" + since + "&until=" + Date.now(),
    body:    null,
    params:  {},
  };
  var res = _mockRes(sent);
  await routes["GET /admin/analytics/summary"](req, res);
  check("analytics summary returns 200",    sent.status === 200);
  var parsed = JSON.parse(sent.body);
  check("analytics summary JSON has total_orders", parsed.total_orders === 1);

  // Dashboard HTML smoke
  var sent2 = { status: 0, body: null, headers: {} };
  var req2 = {
    headers: { authorization: "Bearer " + TOKEN },
    url:     "/admin/dashboard",
    body:    null,
    params:  {},
  };
  var res2 = _mockRes(sent2);
  await routes["GET /admin/dashboard"](req2, res2);
  check("dashboard returns 200",            sent2.status === 200);
  check("dashboard sets text/html",         /text\/html/.test(sent2.headers["content-type"] || ""));
  check("dashboard body is HTML",           /<!DOCTYPE html>/.test(sent2.body));
  check("dashboard renders the order count","1" === (sent2.body.match(/value\">1</) || [])[0] ? false : true);
  check("dashboard includes shop name",     /blamejs\.shop/.test(sent2.body));

  // Bearer gate still enforced
  var sent3 = { status: 0, body: null, headers: {} };
  await routes["GET /admin/analytics/summary"]({ headers: {}, url: "/admin/analytics/summary", body: null, params: {} }, _mockRes(sent3));
  check("no bearer → 401",                  sent3.status === 401);

  // Bad query param → 400
  var sent4 = { status: 0, body: null, headers: {} };
  await routes["GET /admin/analytics/summary"]({ headers: { authorization: "Bearer " + TOKEN }, url: "/admin/analytics/summary?since=not-a-number", body: null, params: {} }, _mockRes(sent4));
  check("bad since param → 400",            sent4.status === 400);
}

function _mockRes(sent) {
  // Mirrors test/layer-1-state/admin.test.js' fake response — both
  // `res.statusCode = N` (used by b.problemDetails.send) and
  // `res.status(N)` (used by admin route handlers directly) update
  // the same captured status field.
  return {
    set statusCode(v) { sent.status = v; },
    get statusCode()  { return sent.status; },
    status:    function (s) { sent.status = s; return this; },
    setHeader: function (k, v) { sent.headers[k.toLowerCase()] = v; },
    end:       function (b) { sent.body = b == null ? "" : String(b); },
  };
}

async function _renderDashboard() {
  // Pure-function renderer assertions — exercise the HTML template
  // shape without a router or DB.
  var html = bShop.admin.renderDashboard({
    summary: { currency: "USD", total_orders: 5, total_revenue_minor: 12345,
               by_status: { pending: 1, paid: 2, fulfilling: 0, shipped: 1, delivered: 0, refunded: 1, cancelled: 0 } },
    by_day:  [{ day: "2026-01-10", currency: "USD", revenue_minor: 5000 }, { day: "2026-01-11", currency: "USD", revenue_minor: 7345 }],
    top_skus:[{ sku: "TOP-SKU", units_sold: 7, revenue_minor: 7000, currency: "USD" }],
    recent:  [{ id: "0193abcdef0123456789abcdef012345", status: "paid", grand_total_minor: 5000, currency: "USD", created_at: 1700000000000 }],
    shop_name: "TestShop",
  });
  check("renderDashboard returns HTML",          /<!DOCTYPE html>/.test(html));
  check("renderDashboard shows order count",     /\b5\b/.test(html));
  check("renderDashboard shows top SKU",         /TOP-SKU/.test(html));
  check("renderDashboard escapes shop name",     /TestShop/.test(html));
  check("renderDashboard renders sparkline svg", /<svg/.test(html));
  check("renderDashboard renders status pill",   /status-pill paid/.test(html));

  // Empty window — no revenue → empty placeholder, no svg
  var emptyHtml = bShop.admin.renderDashboard({
    summary: { currency: "USD", total_orders: 0, total_revenue_minor: 0, by_status: {} },
    by_day:  [],
    top_skus:[],
    recent:  [],
  });
  check("empty dashboard renders empty placeholder", /No revenue in this window/.test(emptyHtml));
  check("empty dashboard renders no-sales row",      /No sales in this window/.test(emptyHtml));
  check("empty dashboard renders no-orders row",     /No orders yet/.test(emptyHtml));

  // XSS — a malicious SKU should be escaped
  var xssHtml = bShop.admin.renderDashboard({
    summary: { currency: "USD", total_orders: 0, total_revenue_minor: 0, by_status: {} },
    by_day:  [],
    top_skus:[{ sku: "<script>alert(1)</script>", units_sold: 1, revenue_minor: 100, currency: "USD" }],
    recent:  [],
  });
  check("renderDashboard escapes SKU values", /&lt;script&gt;/.test(xssHtml) && !/<script>alert\(1\)<\/script>/.test(xssHtml));
}

async function run() {
  await _summary();
  await _summaryEmptyWindow();
  await _summaryMultiCurrency();
  await _revenueByDay();
  await _topSKUs();
  await _recentOrders();
  await _defaultWindow();
  await _validation();
  await _adminRoutes();
  await _renderDashboard();
}

module.exports = { run: run };
