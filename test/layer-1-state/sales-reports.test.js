"use strict";
/**
 * salesReports — operator-dashboard aggregations over orders.
 *
 * Layer 1 against an in-memory node:sqlite database loaded from the
 * order schema (0003) + the sales-report cache schema (0042). Seeds
 * a deterministic set of orders + lines across multiple statuses,
 * dates, currencies, customers, countries, and payment-token shapes,
 * then asserts each surface returns the expected aggregate.
 *
 * Coverage:
 *   - revenueByDay/Week/Month bucketing + gross / net / refund
 *     accounting (cancelled excluded, refunded subtracts net)
 *   - topProducts: order_count + units + gross + average unit
 *   - topCustomers: customer_id only + average order
 *   - revenueByCountry: json_extract on ship_to_json
 *   - revenueByPaymentMethod: processor-token prefix → label
 *   - customerCohort: cohort sized correctly + month-offset retention
 *   - aov: count + gross + aov_minor
 *   - refundRate: bps math
 *   - funnel: each milestone counted independently
 *   - cache memoization: same params → cache hit; purgeExpired
 *   - validation: bad epoch ms, from >= to, window > 1 year, limit
 *     out of range, bad currency, bad cohort_month
 *   - cursor pagination on topProducts: next_cursor + resume
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var salesReports = require("../../lib/sales-reports");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0042_sales_report_cache.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // FK enforcement off — the seed bypasses cart/customer rows and
  // pokes the orders table directly so the test can pin
  // deterministic timestamps + cross-status combinations without
  // walking the FSM.
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

function _seedOrder(db, opts) {
  var uuid = bShop.framework.uuid.v7();
  db.prepare(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)"
  ).run(
    uuid,
    opts.cart_id || bShop.framework.uuid.v7(),
    opts.customer_id == null ? null : opts.customer_id,
    opts.session_id || bShop.framework.uuid.v7(),
    opts.status,
    opts.currency || "USD",
    opts.subtotal_minor || opts.grand_total_minor,
    opts.grand_total_minor,
    opts.payment_intent_id == null ? null : opts.payment_intent_id,
    opts.ship_to_json || '{"country":"US"}',
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

async function _revenueByDay() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });

  var d1 = Date.UTC(2026, 0, 10, 12, 0, 0);
  var d2 = Date.UTC(2026, 0, 11, 12, 0, 0);
  var d3 = Date.UTC(2026, 0, 12, 12, 0, 0);

  _seedOrder(q.raw, { status: "paid",     grand_total_minor: 1000, created_at: d1, updated_at: d1 });
  _seedOrder(q.raw, { status: "paid",     grand_total_minor: 2000, created_at: d1, updated_at: d1 });
  _seedOrder(q.raw, { status: "paid",     grand_total_minor: 5000, created_at: d2, updated_at: d2 });
  _seedOrder(q.raw, { status: "refunded", grand_total_minor: 1500, created_at: d3, updated_at: d3 });
  _seedOrder(q.raw, { status: "cancelled",grand_total_minor: 999,  created_at: d3, updated_at: d3 });

  var rows = await reports.revenueByDay({ from: d1 - DAY, to: d3 + DAY });
  check("revenueByDay returns 3 day buckets",  rows.length === 3);
  check("buckets ASC",                          rows[0].bucket_start === "2026-01-10");
  check("day 1 order_count = 2",                rows[0].order_count === 2);
  check("day 1 gross = 3000",                   rows[0].gross_revenue_minor === 3000);
  check("day 1 net   = 3000 (no refunds)",      rows[0].net_revenue_minor   === 3000);
  check("day 1 refund_total = 0",               rows[0].refund_total_minor  === 0);
  check("day 2 gross = 5000",                   rows[1].gross_revenue_minor === 5000);
  check("day 3 gross = 1500 (refund counts gross)", rows[2].gross_revenue_minor === 1500);
  check("day 3 net   = -1500 (refund subtracts)",   rows[2].net_revenue_minor   === -1500);
  check("day 3 refund_total = 1500",            rows[2].refund_total_minor === 1500);
  check("currency surfaced on each row",        rows.every(function (r) { return r.currency === "USD"; }));
}

async function _revenueByWeekMonth() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });

  // Two days in the same ISO week (Jan 12 2026 is a Monday, Jan 14
  // is the Wednesday of the same week), then a day in the next
  // week, then a day in the next month. The week bucket should
  // collapse the first two into one row; the month bucket collapses
  // all three January entries.
  var w1Mon = Date.UTC(2026, 0, 12, 12, 0, 0);
  var w1Wed = Date.UTC(2026, 0, 14, 12, 0, 0);
  var w2Mon = Date.UTC(2026, 0, 19, 12, 0, 0);
  var feb   = Date.UTC(2026, 1, 3,  12, 0, 0);

  _seedOrder(q.raw, { status: "paid", grand_total_minor: 100, created_at: w1Mon, updated_at: w1Mon });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 200, created_at: w1Wed, updated_at: w1Wed });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 400, created_at: w2Mon, updated_at: w2Mon });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 800, created_at: feb,   updated_at: feb });

  var weeks = await reports.revenueByWeek({ from: w1Mon - DAY, to: feb + DAY });
  check("revenueByWeek returns 3 buckets", weeks.length === 3);
  check("week 1 Monday-aligned 2026-01-12", weeks[0].bucket_start === "2026-01-12");
  check("week 1 gross = 300", weeks[0].gross_revenue_minor === 300);
  check("week 2 gross = 400", weeks[1].gross_revenue_minor === 400);

  var months = await reports.revenueByMonth({ from: w1Mon - DAY, to: feb + DAY });
  check("revenueByMonth returns 2 buckets", months.length === 2);
  check("Jan bucket = 2026-01-01",          months[0].bucket_start === "2026-01-01");
  check("Jan gross = 100 + 200 + 400 = 700", months[0].gross_revenue_minor === 700);
  check("Feb gross = 800",                   months[1].gross_revenue_minor === 800);
}

async function _topProducts() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);

  // SKU-A: 5 + 3 = 8 units across 2 orders (gross 800, avg 100)
  // SKU-B: 2 units * 150 = 300 gross
  // SKU-C: cancelled order → excluded
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 800, created_at: base + 1 * DAY,
    lines: [{ sku: "SKU-A", qty: 5, unit_amount_minor: 100 }] });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 600, created_at: base + 2 * DAY, lines: [
    { sku: "SKU-A", qty: 3, unit_amount_minor: 100 },
    { sku: "SKU-B", qty: 2, unit_amount_minor: 150 },
  ] });
  _seedOrder(q.raw, { status: "cancelled", grand_total_minor: 1000, created_at: base + 3 * DAY,
    lines: [{ sku: "SKU-C", qty: 10, unit_amount_minor: 100 }] });

  var out = await reports.topProducts({ from: base - DAY, to: base + 10 * DAY, limit: 10 });
  check("topProducts returns 2 rows (cancelled excluded)", out.rows.length === 2);
  check("SKU-A sorts first by gross", out.rows[0].sku === "SKU-A" && out.rows[0].gross_revenue_minor === 800);
  check("SKU-A units = 8",            out.rows[0].units_sold === 8);
  check("SKU-A order_count = 2",      out.rows[0].order_count === 2);
  check("SKU-A avg unit price = 100", out.rows[0].average_unit_price_minor === 100);
  check("SKU-B gross = 300",          out.rows[1].gross_revenue_minor === 300);
  check("next_cursor null for full result", out.next_cursor === null);

  // Cursor pagination — limit 1 yields a next_cursor; resume picks
  // up the second row.
  var page1 = await reports.topProducts({ from: base - DAY, to: base + 10 * DAY, limit: 1 });
  check("page1 has 1 row",                       page1.rows.length === 1);
  check("page1.next_cursor is a non-empty string", typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await reports.topProducts({ from: base - DAY, to: base + 10 * DAY, limit: 1, cursor: page1.next_cursor });
  check("page2 resumes onto SKU-B",              page2.rows.length === 1 && page2.rows[0].sku === "SKU-B");
  // Page3 of a fully-drained cursor returns zero rows + null
  // cursor — the convention is `rows.length < limit ⇒ no more`,
  // so a saturated page yields a peek-ahead cursor (page2 here)
  // that the consumer follows to discover the empty tail.
  var page3 = await reports.topProducts({ from: base - DAY, to: base + 10 * DAY, limit: 1, cursor: page2.next_cursor });
  check("page3 has 0 rows (drained)",            page3.rows.length === 0);
  check("page3.next_cursor null (drained)",      page3.next_cursor === null);
}

async function _topCustomers() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);

  var alice = bShop.framework.uuid.v7();
  var bob   = bShop.framework.uuid.v7();
  // Alice: two orders (1000 + 500 = 1500, avg 750)
  // Bob:   one order (2000)
  // Anonymous order (NULL customer_id) — excluded
  _seedOrder(q.raw, { status: "paid", customer_id: alice, grand_total_minor: 1000, created_at: base + 1 * DAY });
  _seedOrder(q.raw, { status: "paid", customer_id: alice, grand_total_minor: 500,  created_at: base + 2 * DAY });
  _seedOrder(q.raw, { status: "paid", customer_id: bob,   grand_total_minor: 2000, created_at: base + 3 * DAY });
  _seedOrder(q.raw, { status: "paid", customer_id: null,  grand_total_minor: 999,  created_at: base + 4 * DAY });

  var out = await reports.topCustomers({ from: base - DAY, to: base + 10 * DAY, limit: 10 });
  check("topCustomers returns 2 rows (anon excluded)", out.rows.length === 2);
  check("Bob sorts first by gross",                     out.rows[0].customer_id === bob);
  check("Bob gross = 2000",                             out.rows[0].gross_revenue_minor === 2000);
  check("Bob order_count = 1",                          out.rows[0].order_count === 1);
  check("Bob avg order = 2000",                         out.rows[0].average_order_minor === 2000);
  check("Alice gross = 1500",                           out.rows[1].gross_revenue_minor === 1500);
  check("Alice order_count = 2",                        out.rows[1].order_count === 2);
  check("Alice avg order = 750",                        out.rows[1].average_order_minor === 750);
  // No PII reaches the caller — customer_id only.
  var keys = Object.keys(out.rows[0]).sort().join(",");
  check("topCustomers row has no PII fields",
    keys === "average_order_minor,currency,customer_id,gross_revenue_minor,order_count");
}

async function _revenueByCountry() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);

  _seedOrder(q.raw, { status: "paid", grand_total_minor: 1000, ship_to_json: '{"country":"US"}', created_at: base + 1 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 2000, ship_to_json: '{"country":"US"}', created_at: base + 2 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 500,  ship_to_json: '{"country":"DE"}', created_at: base + 3 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 100,  ship_to_json: '{}',               created_at: base + 4 * DAY });

  var rows = await reports.revenueByCountry({ from: base - DAY, to: base + 10 * DAY });
  check("revenueByCountry returns 3 rows", rows.length === 3);
  check("US sorts first (highest gross)",  rows[0].country === "US" && rows[0].gross_revenue_minor === 3000);
  check("US order_count = 2",              rows[0].order_count === 2);
  check("DE has 500",                       rows.some(function (r) { return r.country === "DE" && r.gross_revenue_minor === 500; }));
  check("missing country buckets to UNKNOWN", rows.some(function (r) { return r.country === "UNKNOWN" && r.gross_revenue_minor === 100; }));
}

async function _revenueByPaymentMethod() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);

  _seedOrder(q.raw, { status: "paid", grand_total_minor: 1000, payment_intent_id: "pi_abc123",    created_at: base + 1 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 2000, payment_intent_id: "ch_xyz",       created_at: base + 2 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 500,  payment_intent_id: "PAY-foo",      created_at: base + 3 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 300,  payment_intent_id: "B-bar",        created_at: base + 4 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 100,  payment_intent_id: null,           created_at: base + 5 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 50,   payment_intent_id: "weird-token",  created_at: base + 6 * DAY });

  var rows = await reports.revenueByPaymentMethod({ from: base - DAY, to: base + 10 * DAY });
  var byMethod = {};
  rows.forEach(function (r) { byMethod[r.payment_method] = r; });
  check("stripe sums pi_ + ch_ = 3000",     byMethod.stripe && byMethod.stripe.gross_revenue_minor === 3000);
  check("stripe order_count = 2",            byMethod.stripe && byMethod.stripe.order_count === 2);
  check("paypal = 500",                       byMethod.paypal && byMethod.paypal.gross_revenue_minor === 500);
  check("braintree = 300",                    byMethod.braintree && byMethod.braintree.gross_revenue_minor === 300);
  check("unknown captures NULL token = 100",  byMethod.unknown && byMethod.unknown.gross_revenue_minor === 100);
  check("other captures unrecognised = 50",   byMethod.other && byMethod.other.gross_revenue_minor === 50);
}

async function _customerCohort() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });

  // Three customers in the 2026-01 cohort. One returns in 2026-02
  // (offset 1). One returns in 2026-03 (offset 2). One never
  // returns.
  var alice = bShop.framework.uuid.v7();
  var bob   = bShop.framework.uuid.v7();
  var carol = bShop.framework.uuid.v7();
  var jan10 = Date.UTC(2026, 0, 10, 12, 0, 0);
  var jan20 = Date.UTC(2026, 0, 20, 12, 0, 0);
  var feb15 = Date.UTC(2026, 1, 15, 12, 0, 0);
  var mar05 = Date.UTC(2026, 2, 5,  12, 0, 0);

  _seedOrder(q.raw, { status: "paid", customer_id: alice, grand_total_minor: 1000, created_at: jan10, updated_at: jan10 });
  _seedOrder(q.raw, { status: "paid", customer_id: bob,   grand_total_minor: 2000, created_at: jan10, updated_at: jan10 });
  _seedOrder(q.raw, { status: "paid", customer_id: carol, grand_total_minor: 3000, created_at: jan20, updated_at: jan20 });
  // Alice returns in Feb
  _seedOrder(q.raw, { status: "paid", customer_id: alice, grand_total_minor: 500,  created_at: feb15, updated_at: feb15 });
  // Bob returns in Mar
  _seedOrder(q.raw, { status: "paid", customer_id: bob,   grand_total_minor: 700,  created_at: mar05, updated_at: mar05 });
  // A different customer's first order in Feb — must NOT count in
  // the Jan cohort.
  var dave  = bShop.framework.uuid.v7();
  _seedOrder(q.raw, { status: "paid", customer_id: dave,  grand_total_minor: 9999, created_at: feb15, updated_at: feb15 });

  var out = await reports.customerCohort({ cohort_month: "2026-01", months: 4 });
  check("cohort_month echoed back",       out.cohort_month === "2026-01");
  check("cohort_size = 3 (alice/bob/carol)", out.cohort_size === 3);
  check("retention has 4 entries",        out.retention.length === 4);
  check("offset 0 = full cohort",          out.retention[0].returning_customers === 3 && out.retention[0].retention_rate === 1);
  check("offset 1 = alice only",           out.retention[1].returning_customers === 1);
  check("offset 1 retention_rate ≈ 1/3",   Math.abs(out.retention[1].retention_rate - (1 / 3)) < 1e-9);
  check("offset 2 = bob only",             out.retention[2].returning_customers === 1);
  check("offset 3 = none",                  out.retention[3].returning_customers === 0 && out.retention[3].retention_rate === 0);
  check("offset 1 gross = 500 (alice's Feb order)", out.retention[1].gross_revenue_minor === 500);
}

async function _aov() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);

  _seedOrder(q.raw, { status: "paid", grand_total_minor: 1000, created_at: base + 1 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 2000, created_at: base + 2 * DAY });
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 3000, created_at: base + 3 * DAY });
  _seedOrder(q.raw, { status: "cancelled", grand_total_minor: 999, created_at: base + 4 * DAY });

  var out = await reports.aov({ from: base - DAY, to: base + 10 * DAY });
  check("aov.count = 3 (cancelled excluded)", out.count === 3);
  check("aov.gross = 6000",                     out.gross_revenue_minor === 6000);
  check("aov.aov_minor = 2000",                 out.aov_minor === 2000);
  check("aov.currency = USD",                   out.currency === "USD");

  // Currency-filtered empty window — return a zero shape so the
  // dashboard always has something to render.
  var empty = await reports.aov({ from: base - DAY, to: base + 10 * DAY, currency: "GBP" });
  check("empty currency-filter returns zero shape",
    empty.count === 0 && empty.gross_revenue_minor === 0 && empty.aov_minor === 0 && empty.currency === "GBP");
}

async function _refundRate() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);

  // 10 orders, 1 refunded → 10% = 1000 bps.
  for (var i = 0; i < 9; i += 1) {
    _seedOrder(q.raw, { status: "paid", grand_total_minor: 100, created_at: base + i * DAY, updated_at: base + i * DAY });
  }
  _seedOrder(q.raw, { status: "refunded", grand_total_minor: 100, created_at: base + 9 * DAY, updated_at: base + 9 * DAY });
  // Cancelled excluded from the denominator
  _seedOrder(q.raw, { status: "cancelled", grand_total_minor: 100, created_at: base + 10 * DAY, updated_at: base + 10 * DAY });

  var out = await reports.refundRate({ from: base - DAY, to: base + 15 * DAY });
  check("refundRate order_count = 10 (cancelled excluded)", out.order_count === 10);
  check("refundRate refunded_count = 1",                     out.refunded_count === 1);
  check("refundRate bps = 1000 (10%)",                       out.refund_rate_bps === 1000);

  // Empty window → zero, not NaN
  var empty = await reports.refundRate({ from: base - 100 * DAY, to: base - 50 * DAY });
  check("empty refundRate bps = 0", empty.refund_rate_bps === 0 && empty.order_count === 0);
}

async function _funnel() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);

  // 10 checkout_started; 8 have payment_intent; 6 are paid+;
  // 4 are fulfilled; 1 refunded.
  // Two with no payment_intent (status pending, no PI yet)
  _seedOrder(q.raw, { status: "pending", grand_total_minor: 100, payment_intent_id: null, created_at: base + 1 * DAY, updated_at: base + 1 * DAY });
  _seedOrder(q.raw, { status: "pending", grand_total_minor: 100, payment_intent_id: null, created_at: base + 2 * DAY, updated_at: base + 2 * DAY });
  // Two more pending but with payment_intent_created
  _seedOrder(q.raw, { status: "pending", grand_total_minor: 100, payment_intent_id: "pi_a", created_at: base + 3 * DAY, updated_at: base + 3 * DAY });
  _seedOrder(q.raw, { status: "pending", grand_total_minor: 100, payment_intent_id: "pi_b", created_at: base + 4 * DAY, updated_at: base + 4 * DAY });
  // 5 paid (1 stays paid, 4 advance further)
  _seedOrder(q.raw, { status: "paid",       grand_total_minor: 100, payment_intent_id: "pi_c", created_at: base + 5 * DAY, updated_at: base + 5 * DAY });
  _seedOrder(q.raw, { status: "fulfilling", grand_total_minor: 100, payment_intent_id: "pi_d", created_at: base + 6 * DAY, updated_at: base + 6 * DAY });
  _seedOrder(q.raw, { status: "shipped",    grand_total_minor: 100, payment_intent_id: "pi_e", created_at: base + 7 * DAY, updated_at: base + 7 * DAY });
  _seedOrder(q.raw, { status: "shipped",    grand_total_minor: 100, payment_intent_id: "pi_f", created_at: base + 8 * DAY, updated_at: base + 8 * DAY });
  _seedOrder(q.raw, { status: "delivered",  grand_total_minor: 100, payment_intent_id: "pi_g", created_at: base + 9 * DAY, updated_at: base + 9 * DAY });
  _seedOrder(q.raw, { status: "refunded",   grand_total_minor: 100, payment_intent_id: "pi_h", created_at: base + 10 * DAY, updated_at: base + 10 * DAY });

  var out = await reports.funnel({ from: base - DAY, to: base + 15 * DAY });
  check("funnel.checkout_started = 10",        out.checkout_started === 10);
  check("funnel.payment_intent_created = 8",    out.payment_intent_created === 8);
  // paid bucket counts paid / fulfilling / shipped / delivered / refunded = 6
  check("funnel.paid = 6",                      out.paid === 6);
  // fulfilled bucket counts shipped + delivered = 3
  check("funnel.fulfilled = 3",                 out.fulfilled === 3);
  check("funnel.refunded = 1",                  out.refunded === 1);
}

async function _cacheMemoization() {
  var q = _makeQuery();
  var calls = 0;
  var wrapped = {
    query: function (sql, params) {
      // Count the heavy aggregate (not the cache lookup itself)
      if (/FROM\s+orders\b/i.test(sql) && /GROUP BY/i.test(sql)) calls += 1;
      return q.query(sql, params);
    },
  };
  var reports = salesReports.create({ query: wrapped.query });
  var base = Date.UTC(2026, 0, 10, 12, 0, 0);
  _seedOrder(q.raw, { status: "paid", grand_total_minor: 100, created_at: base, updated_at: base });

  var p = { from: base - DAY, to: base + DAY, cache: true };
  var a = await reports.revenueByDay(p);
  var beforeSecond = calls;
  var b = await reports.revenueByDay(p);
  check("cache hit on second call (no extra aggregate)", calls === beforeSecond);
  check("cached result matches first",                    JSON.stringify(a) === JSON.stringify(b));

  // purgeExpired — call with `now + 1d` so the row written above
  // (TTL default 60s) is past its expires_at and gets swept.
  var purge = await reports.purgeExpired(Date.now() + 2 * DAY);
  check("purgeExpired returns deleted count >= 1", purge.deleted >= 1);
}

async function _validation() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  await assert.rejects(reports.revenueByDay({ from: "x", to: Date.now() }),    /from must be/);
  await assert.rejects(reports.revenueByDay({ from: -1,  to: Date.now() }),    /from must be/);
  await assert.rejects(reports.revenueByDay({ from: 100, to: 100 }),            /strictly less/);
  await assert.rejects(reports.revenueByDay({ from: 100, to: 50 }),             /strictly less/);
  await assert.rejects(reports.revenueByDay({ from: 0,   to: 366 * DAY }),       /≤ 1 year/);
  await assert.rejects(reports.topProducts({ from: 100, to: 200, limit: 0 }),   /limit/);
  await assert.rejects(reports.topProducts({ from: 100, to: 200, limit: 101 }), /limit/);
  await assert.rejects(reports.topCustomers({ from: 100, to: 200, limit: 0 }),  /limit/);
  await assert.rejects(reports.revenueByDay({ from: 100, to: 200, currency: "XX" }), /currency/);
  await assert.rejects(reports.customerCohort({ cohort_month: "2026-13" }),     /YYYY-MM/);
  await assert.rejects(reports.customerCohort({ cohort_month: "not-a-month" }), /YYYY-MM/);
  await assert.rejects(reports.customerCohort({ cohort_month: "2026-01", months: 0 }),  /months/);
  await assert.rejects(reports.customerCohort({ cohort_month: "2026-01", months: 25 }), /months/);
  // Cursor-shape refusals on the detail surfaces.
  await assert.rejects(reports.topProducts({ from: 100, to: 200, limit: 5, cursor: "bogus" }), /cursor/);
  await assert.rejects(reports.topProducts({ from: 100, to: 200, limit: 5, cursor: 42 }),      /cursor/);
}

async function _emptyCohort() {
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  // No orders → cohort_size 0, retention array zero-filled.
  var out = await reports.customerCohort({ cohort_month: "2026-01", months: 6 });
  check("empty cohort_size = 0",              out.cohort_size === 0);
  check("retention array still sized to 6",   out.retention.length === 6);
  check("every offset row zeroed",
    out.retention.every(function (r) { return r.returning_customers === 0 && r.retention_rate === 0; }));
}

async function _factoryDefaults() {
  // Factory without an explicit query falls back to externalDb —
  // that path requires the framework wired, so it's exercised by
  // the integration suite, not here. What we DO check is that the
  // factory boots without `cursorSecret` outside production.
  var q = _makeQuery();
  var reports = salesReports.create({ query: q.query });
  check("factory returns object", typeof reports === "object" && typeof reports.revenueByDay === "function");

  // Production gate — `cursorSecret` required.
  var prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  var threw = false;
  try { salesReports.create({ query: q.query }); }
  catch (e) {
    threw = /cursorSecret is required/.test(e.message);
  }
  process.env.NODE_ENV = prevEnv;
  check("production refuses to boot without cursorSecret", threw);
}

async function main() {
  var tests = [
    ["revenueByDay",            _revenueByDay],
    ["revenueByWeekMonth",      _revenueByWeekMonth],
    ["topProducts + cursor",    _topProducts],
    ["topCustomers",            _topCustomers],
    ["revenueByCountry",        _revenueByCountry],
    ["revenueByPaymentMethod",  _revenueByPaymentMethod],
    ["customerCohort",          _customerCohort],
    ["aov",                     _aov],
    ["refundRate",              _refundRate],
    ["funnel",                  _funnel],
    ["cache memoization",       _cacheMemoization],
    ["validation",              _validation],
    ["empty cohort",            _emptyCohort],
    ["factory defaults",        _factoryDefaults],
  ];
  for (var i = 0; i < tests.length; i += 1) {
    var name = tests[i][0];
    var fn   = tests[i][1];
    process.stdout.write("  - " + name + " ... ");
    await fn();
    process.stdout.write("OK\n");
  }
  console.log("OK — sales-reports (" + helpers.getChecks() + " checks)");
}

main().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});
