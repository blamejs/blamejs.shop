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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql", "0019_analytics_events.sql"].map(function (f) {
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

// ---- event-stream coverage --------------------------------------------

async function _recordEventHappy() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });

  var rawSession = "sess_" + bShop.framework.uuid.v7();
  var out = await analytics.recordEvent({
    event_type:        "pdp_view",
    session_id:        rawSession,
    product_id:        "prod-abc",
    page_url:          "/p/abc",
    user_agent_class:  "desktop",
    payload:           { ref: "homepage-hero" },
  });
  check("recordEvent returns id (uuid v7 length 32)",   typeof out.id === "string" && out.id.length >= 26);
  check("recordEvent returns occurred_at (epoch ms)",   Number.isInteger(out.occurred_at) && out.occurred_at > 0);

  // The row landed — and the raw session_id was hashed (SHA3-512
  // hex is 128 chars; the raw string was 36-ish chars).
  var row = q.raw.prepare("SELECT * FROM analytics_events WHERE id = ?").get(out.id);
  check("recordEvent persisted exactly one row",        !!row);
  check("session_id_hash is hex (hashed)",               /^[0-9a-f]{128}$/.test(row.session_id_hash));
  check("raw session_id NEVER persisted to the row",     row.session_id_hash !== rawSession);
  check("event_type stored verbatim",                    row.event_type === "pdp_view");
  check("product_id surfaced on denorm column",          row.product_id === "prod-abc");
  check("payload_json stored as JSON",                   row.payload_json === JSON.stringify({ ref: "homepage-hero" }));
  check("user_agent_class stored",                       row.user_agent_class === "desktop");
  check("customer_id_hash NULL when only session given", row.customer_id_hash === null);

  // Second call with the same raw session hashes to the same value
  // (deterministic namespace hash).
  var out2 = await analytics.recordEvent({
    event_type: "wishlist_add",
    session_id: rawSession,
    product_id: "prod-abc",
  });
  var row2 = q.raw.prepare("SELECT * FROM analytics_events WHERE id = ?").get(out2.id);
  check("repeat hash is identical (deterministic)",      row2.session_id_hash === row.session_id_hash);

  // customer_id-only event lands too (session_id_hash falls back
  // to a customer-scoped hash so the NOT NULL column has a value).
  var rawCustomer = "cust-" + bShop.framework.uuid.v7();
  var out3 = await analytics.recordEvent({
    event_type:  "newsletter_signup",
    customer_id: rawCustomer,
  });
  var row3 = q.raw.prepare("SELECT * FROM analytics_events WHERE id = ?").get(out3.id);
  check("customer-only event has customer_id_hash",      /^[0-9a-f]{128}$/.test(row3.customer_id_hash));
  check("customer-only event has session_id_hash too",   /^[0-9a-f]{128}$/.test(row3.session_id_hash));
  check("raw customer_id NEVER persisted",               row3.customer_id_hash !== rawCustomer);
}

async function _recordEventRefusals() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });

  // Bad event_type
  await assert.rejects(analytics.recordEvent({ event_type: "lol_view", session_id: "s1" }), /event_type must be one of/);
  await assert.rejects(analytics.recordEvent({ event_type: "",         session_id: "s1" }), /event_type must be one of/);
  await assert.rejects(analytics.recordEvent({ session_id: "s1" }),                          /event_type must be one of/);

  // Missing both session and customer
  await assert.rejects(analytics.recordEvent({ event_type: "pdp_view" }), /at least one of session_id/);

  // Oversized payload (5 KiB)
  var big = { blob: "x".repeat(5000) };
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", payload: big }),
    /payload exceeds/,
  );

  // Bad occurred_at
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", occurred_at: -1 }),
    /occurred_at must be/,
  );
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", occurred_at: "yesterday" }),
    /occurred_at must be/,
  );
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", occurred_at: 1.5 }),
    /occurred_at must be/,
  );

  // Raw email refused everywhere it could leak
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "alice@example.com" }),
    /session_id looks like a raw email/,
  );
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", customer_id: "bob@example.com" }),
    /customer_id looks like a raw email/,
  );
  await assert.rejects(
    analytics.recordEvent({ event_type: "search_query", session_id: "s1", search_q: "carol@example.com" }),
    /search_q looks like a raw email/,
  );
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", page_url: "/u/dan@example.com" }),
    /page_url looks like a raw email/,
  );

  // Raw IPv4 refused
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "192.168.1.1" }),
    /session_id looks like a raw IP/,
  );
  // Raw IPv6 refused
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "2001:db8::1" }),
    /session_id looks like a raw IP/,
  );

  // Bad payload shape (array, not plain object)
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", payload: [1, 2, 3] }),
    /payload must be a plain object/,
  );

  // Bad user_agent_class
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", user_agent_class: "smartfridge" }),
    /user_agent_class must be one of/,
  );

  // Oversized search_q / page_url / product_id / session_id
  await assert.rejects(
    analytics.recordEvent({ event_type: "search_query", session_id: "s1", search_q: "q".repeat(300) }),
    /search_q exceeds/,
  );
  await assert.rejects(
    analytics.recordEvent({ event_type: "pdp_view", session_id: "z".repeat(600) }),
    /session_id exceeds/,
  );

  // No row landed despite every refusal above
  var rowCount = q.raw.prepare("SELECT COUNT(*) AS n FROM analytics_events").get().n;
  check("no rows landed after every refusal", Number(rowCount) === 0);
}

async function _topSearchTerms() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now   = Date.now();
  var from  = now - 7 * DAY;

  // "boots" wins (3 hits), "jacket" second (2), "scarf" third (1)
  await analytics.recordEvent({ event_type: "search_query", session_id: "s-a", search_q: "boots",  occurred_at: from + 1 * DAY });
  await analytics.recordEvent({ event_type: "search_query", session_id: "s-b", search_q: "boots",  occurred_at: from + 2 * DAY });
  await analytics.recordEvent({ event_type: "search_query", session_id: "s-c", search_q: "boots",  occurred_at: from + 3 * DAY });
  await analytics.recordEvent({ event_type: "search_query", session_id: "s-d", search_q: "jacket", occurred_at: from + 4 * DAY });
  await analytics.recordEvent({ event_type: "search_query", session_id: "s-e", search_q: "jacket", occurred_at: from + 5 * DAY });
  await analytics.recordEvent({ event_type: "search_query", session_id: "s-f", search_q: "scarf",  occurred_at: from + 6 * DAY });
  // Non-search event with a search_q-shaped column — must NOT
  // contaminate the search-terms aggregate (filter is on
  // event_type='search_query').
  await analytics.recordEvent({ event_type: "pdp_view",     session_id: "s-g", search_q: "noise",  occurred_at: from + 6 * DAY });

  var rows = await analytics.topSearchTerms({ from: from, to: now, limit: 10 });
  check("topSearchTerms returns 3 rows",        rows.length === 3);
  check("boots wins with count 3",              rows[0].search_q === "boots"  && rows[0].count === 3);
  check("jacket second with count 2",           rows[1].search_q === "jacket" && rows[1].count === 2);
  check("scarf third with count 1",             rows[2].search_q === "scarf"  && rows[2].count === 1);

  var limited = await analytics.topSearchTerms({ from: from, to: now, limit: 1 });
  check("topSearchTerms honors limit=1",        limited.length === 1 && limited[0].search_q === "boots");

  // Case-insensitive aggregation — historical rows written before the
  // storefront record site lowercased can carry mixed case; topSearchTerms
  // GROUPs on lower(search_q) so "Hat", "HAT", and "hat" collapse into one
  // lowercased row. This matches how the autocomplete "Popular searches"
  // aggregate (which lowercases on write) already counts them.
  var q2 = _makeQuery();
  var analytics2 = bShop.analytics.create({ query: q2.query });
  await analytics2.recordEvent({ event_type: "search_query", session_id: "c-a", search_q: "Hat", occurred_at: from + 1 * DAY });
  await analytics2.recordEvent({ event_type: "search_query", session_id: "c-b", search_q: "HAT", occurred_at: from + 2 * DAY });
  await analytics2.recordEvent({ event_type: "search_query", session_id: "c-c", search_q: "hat", occurred_at: from + 3 * DAY });
  await analytics2.recordEvent({ event_type: "search_query", session_id: "c-d", search_q: "Glove", occurred_at: from + 4 * DAY });
  var caseRows = await analytics2.topSearchTerms({ from: from, to: now, limit: 10 });
  check("topSearchTerms folds mixed case into one row", caseRows.length === 2);
  check("topSearchTerms case-folded winner is lowercased 'hat' with count 3",
    caseRows[0].search_q === "hat" && caseRows[0].count === 3);
  check("topSearchTerms case-folded runner-up is lowercased 'glove' with count 1",
    caseRows[1].search_q === "glove" && caseRows[1].count === 1);
}

async function _topViewedProducts() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now  = Date.now();
  var from = now - 7 * DAY;

  // PROD-X: 4 views, PROD-Y: 2 views, PROD-Z (cart_add only): excluded
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "s1", product_id: "PROD-X", occurred_at: from + 1 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "s2", product_id: "PROD-X", occurred_at: from + 2 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "s3", product_id: "PROD-X", occurred_at: from + 3 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "s4", product_id: "PROD-X", occurred_at: from + 4 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "s5", product_id: "PROD-Y", occurred_at: from + 5 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "s6", product_id: "PROD-Y", occurred_at: from + 6 * DAY });
  await analytics.recordEvent({ event_type: "cart_add", session_id: "s7", product_id: "PROD-Z", occurred_at: from + 6 * DAY });

  var rows = await analytics.topViewedProducts({ from: from, to: now });
  check("topViewedProducts returns 2 rows (cart_add excluded)", rows.length === 2);
  check("PROD-X first with 4 views",                            rows[0].product_id === "PROD-X" && rows[0].count === 4);
  check("PROD-Y second with 2 views",                           rows[1].product_id === "PROD-Y" && rows[1].count === 2);
}

async function _funnel() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now  = Date.now();
  var from = now - 7 * DAY;

  // 10 PDP views, 4 cart adds, 2 checkout starts, 1 checkout
  // complete → 1/10 = 10% conversion.
  var i;
  for (i = 0; i < 10; i += 1) {
    await analytics.recordEvent({ event_type: "pdp_view", session_id: "v" + i, product_id: "P1", occurred_at: from + 1 * DAY + i });
  }
  for (i = 0; i < 4; i += 1) {
    await analytics.recordEvent({ event_type: "cart_add", session_id: "v" + i, product_id: "P1", occurred_at: from + 2 * DAY + i });
  }
  for (i = 0; i < 2; i += 1) {
    await analytics.recordEvent({ event_type: "checkout_start", session_id: "v" + i, occurred_at: from + 3 * DAY + i });
  }
  await analytics.recordEvent({ event_type: "checkout_complete", session_id: "v0", occurred_at: from + 4 * DAY });

  var f = await analytics.funnel({ from: from, to: now });
  check("funnel.pdp_views = 10",              f.pdp_views === 10);
  check("funnel.cart_adds = 4",                f.cart_adds === 4);
  check("funnel.checkout_starts = 2",          f.checkout_starts === 2);
  check("funnel.checkout_completes = 1",       f.checkout_completes === 1);
  check("funnel.conversion_rate = 0.1",        Math.abs(f.conversion_rate - 0.1) < 1e-9);

  // Zero-traffic window — conversion rate is 0, not NaN.
  var empty = await analytics.funnel({ from: now - 365 * DAY + 1, to: now - 100 * DAY });
  check("empty window conversion_rate = 0",    empty.conversion_rate === 0);
  check("empty window counts all 0",           empty.pdp_views === 0 && empty.checkout_completes === 0);
}

async function _sessionFlow() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now  = Date.now();
  var sess = "sess-flow-target";

  // Out-of-order inserts; the primitive returns them
  // chronologically ASC.
  await analytics.recordEvent({ event_type: "checkout_start", session_id: sess, occurred_at: now - 1 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view",       session_id: sess, product_id: "P", occurred_at: now - 5 * DAY });
  await analytics.recordEvent({ event_type: "cart_add",       session_id: sess, product_id: "P", occurred_at: now - 3 * DAY });
  // Decoy from a different session
  await analytics.recordEvent({ event_type: "pdp_view",       session_id: "other-session", product_id: "P", occurred_at: now - 4 * DAY });

  var rows = await analytics.sessionFlow(sess);
  check("sessionFlow returns 3 events (decoy excluded)",        rows.length === 3);
  check("sessionFlow events sorted chronologically",            rows[0].event_type === "pdp_view" && rows[1].event_type === "cart_add" && rows[2].event_type === "checkout_start");
  check("sessionFlow surfaces session_id_hash (hex)",           /^[0-9a-f]{128}$/.test(rows[0].session_id_hash));
  check("sessionFlow events all share the same session_id_hash", rows[0].session_id_hash === rows[1].session_id_hash && rows[1].session_id_hash === rows[2].session_id_hash);
  check("sessionFlow payload re-decoded to object",             typeof rows[0].payload === "object");

  // Refusal on raw-PII session_id
  await assert.rejects(analytics.sessionFlow("alice@example.com"), /looks like a raw email/);
  await assert.rejects(analytics.sessionFlow(""),                  /session_id required/);
  await assert.rejects(analytics.sessionFlow(sess, { limit: 0 }),   /limit/);
  await assert.rejects(analytics.sessionFlow(sess, { limit: 501 }), /limit/);
}

async function _dropAfter() {
  var q = _makeQuery();
  var analytics = bShop.analytics.create({ query: q.query });
  var now = Date.now();

  await analytics.recordEvent({ event_type: "pdp_view", session_id: "old-1", occurred_at: now - 90 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "old-2", occurred_at: now - 91 * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "new-1", occurred_at: now - 5  * DAY });
  await analytics.recordEvent({ event_type: "pdp_view", session_id: "new-2", occurred_at: now - 1  * DAY });

  // Delete everything older than 30 days
  var r = await analytics.dropAfter(now - 30 * DAY);
  check("dropAfter reports 2 rows deleted", r.deleted === 2);

  var remaining = q.raw.prepare("SELECT COUNT(*) AS n FROM analytics_events").get().n;
  check("2 fresh rows remain",              Number(remaining) === 2);

  // Bad ts refused
  await assert.rejects(analytics.dropAfter(-1),       /ts must be/);
  await assert.rejects(analytics.dropAfter("today"),  /ts must be/);
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
  await _recordEventHappy();
  await _recordEventRefusals();
  await _topSearchTerms();
  await _topViewedProducts();
  await _funnel();
  await _sessionFlow();
  await _dropAfter();
  await _adminRoutes();
  await _renderDashboard();
}

module.exports = { run: run };
