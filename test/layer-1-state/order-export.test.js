"use strict";
/**
 * order-export — streaming CSV / NDJSON export of orders.
 *
 * Layer 1 against in-memory node:sqlite. Loads the catalog +
 * cart + order migrations so we can seed a realistic orders row,
 * plus the scheduled_exports migration for the queue surface.
 *
 * Coverage:
 *   - csvForRange yields header + rows (header on first chunk)
 *   - RFC-4180 quoting on cells containing comma + double-quote
 *   - CSV-injection refusal: `=cmd|...` gets prefixed with `'`,
 *     signed numerics (`+15.00`) pass through unchanged
 *   - columns filter restricts the header + rows
 *   - ndjsonForRange yields JSON-shape lines
 *   - summaryForRange aggregates by status + currency
 *   - scheduleExport FSM: queued → running → complete
 *   - cancelExport refused once running
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var orderExport = require("../../lib/order-export");
var helpers     = require("../helpers");
var b           = bShop.framework;
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0206_orders_email_hash.sql",
  "0039_scheduled_exports.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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

function _validUUID() { return b.uuid.v7(); }

// Seed N orders inside a known created_at window. Returns the seed
// metadata + the orders so the test can assert against id / total /
// status.
async function _seedOrders(query, count) {
  // Direct-INSERT path so each test controls created_at precisely.
  // The export reads via plain SQL over the orders table, so we
  // bypass the order primitive's createFromCart (which would compute
  // its own created_at).
  var orders = [];
  var baseTs = 1700000000000;                                                    // arbitrary fixed epoch ms
  for (var i = 0; i < count; i += 1) {
    var id = _validUUID();
    var cartId = _validUUID();
    var sessionId = _validUUID();
    var customerId = _validUUID();
    var status = i % 2 === 0 ? "paid" : "delivered";
    var grand  = 1000 + (i * 100);
    // orders.cart_id FKs into carts(id) — seed the parent row first
    // so the FK constraint stays satisfied.
    await query(
      "INSERT INTO carts (id, session_id, customer_id, currency, status, " +
      "created_at, updated_at, expires_at) " +
      "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
      [cartId, sessionId, customerId, baseTs + i, baseTs + i + 86400000],
    );
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
      "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
      "payment_intent_id, ship_to_json, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 'USD', ?6, 0, 0, 0, ?6, NULL, ?7, ?8, ?8)",
      [
        id, cartId, customerId, sessionId, status, grand,
        JSON.stringify({ line1: "500 Market St", line2: "Suite 5", city: "San Francisco", country: "US", state: "CA", postal: "94103" }),
        baseTs + i,
      ],
    );
    orders.push({ id: id, status: status, grand_total_minor: grand, created_at: baseTs + i });
  }
  return { orders: orders, from: baseTs, to: baseTs + count };
}

async function _collect(asyncIter) {
  var out = [];
  for await (var chunk of asyncIter) out.push(chunk);
  return out;
}

async function _csvBasics() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  var seed = await _seedOrders(q, 3);
  var chunks = await _collect(ex.csvForRange({ from: seed.from, to: seed.to + 1 }));
  check("csvForRange yields at least header + data", chunks.length >= 2);
  var header = chunks[0];
  check("csvForRange first chunk is header",
    header.indexOf('"order_id"') === 0 && header.indexOf('"grand_total_minor"') !== -1);
  check("csvForRange header is CRLF-terminated", header.endsWith("\r\n"));
  var allBody = chunks.slice(1).join("");
  // Each row = one CRLF-terminated line; 3 seeded orders.
  var lines = allBody.split("\r\n").filter(function (s) { return s.length > 0; });
  check("csvForRange yields 3 data rows", lines.length === 3);
  // Each row has 27 cells (default columns).
  // Count quote-delimited cells via a count of `","` separators + 1.
  var sepCount = (lines[0].match(/","/g) || []).length;
  check("csvForRange row has 27 columns", sepCount + 1 === 27);
  check("csvForRange header carries the full shipping address",
    header.indexOf('"shipping_line1"') !== -1 &&
    header.indexOf('"shipping_line2"') !== -1 &&
    header.indexOf('"shipping_city"')  !== -1);
  check("csvForRange row carries the seeded street + city",
    allBody.indexOf("500 Market St") !== -1 && allBody.indexOf("San Francisco") !== -1);
}

async function _rfc4180Quoting() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  // Probe the cell helper directly — the projection of stored rows
  // doesn't naturally surface a comma-and-quote payload, so a
  // direct-API call is the cleaner gate.
  var weird = ex._csvCell('hello, "world"');
  check("_csvCell wraps the cell in double quotes",
    weird.charAt(0) === '"' && weird.charAt(weird.length - 1) === '"');
  check("_csvCell doubles embedded double-quotes",
    weird.indexOf('""world""') !== -1);
  check("_csvCell preserves embedded comma",
    weird.indexOf('hello,') !== -1);
}

async function _csvInjectionRefusal() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  // Classic OWASP CSV-injection vector — must be neutralized.
  var attack = ex._neutralizeInjection("=cmd|' /C calc'!A0");
  check("_neutralizeInjection prefixes `=` cell with `'`",
    attack.charAt(0) === "'" && attack.charAt(1) === "=");
  check("_neutralizeInjection prefixes `+SUM(...)`",
    ex._neutralizeInjection("+SUM(A1:A9)").charAt(0) === "'");
  check("_neutralizeInjection prefixes `-2+3+cmd`",
    ex._neutralizeInjection("-2+3+cmd|' /C calc'").charAt(0) === "'");
  check("_neutralizeInjection prefixes `@SUM`",
    ex._neutralizeInjection("@SUM(A1)").charAt(0) === "'");
  // Signed-numeric exemption — `+15.00` is a legitimate amount.
  check("_neutralizeInjection lets `+15.00` through",
    ex._neutralizeInjection("+15.00") === "+15.00");
  check("_neutralizeInjection lets `-3.5` through",
    ex._neutralizeInjection("-3.5") === "-3.5");
  // Anything benign passes unmodified.
  check("_neutralizeInjection lets benign text through",
    ex._neutralizeInjection("Alice Smith") === "Alice Smith");
}

async function _columnsFilter() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  var seed = await _seedOrders(q, 2);
  var chunks = await _collect(ex.csvForRange({
    from: seed.from,
    to:   seed.to + 1,
    columns: ["order_id", "status", "grand_total_minor"],
  }));
  var header = chunks[0];
  // 3 cells = 2 `","` separators between 3 cells.
  var sepCount = (header.match(/","/g) || []).length;
  check("columns filter narrows header to 3 cells", sepCount + 1 === 3);
  check("columns filter keeps order_id first",      header.indexOf('"order_id"') === 0);
  check("columns filter respects COLUMN_ORDER projection (status before grand_total)",
    header.indexOf('"status"') < header.indexOf('"grand_total_minor"'));
  // Unknown column refused — _columns() runs synchronously at
  // iterator-construction time, so wrap in a thunk for rejects().
  await assert.rejects(async function () {
    await _collect(ex.csvForRange({
      from: seed.from, to: seed.to + 1, columns: ["bogus_column"],
    }));
  }, /unknown column/);
}

async function _ndjsonShape() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  var seed = await _seedOrders(q, 2);
  var chunks = await _collect(ex.ndjsonForRange({ from: seed.from, to: seed.to + 1 }));
  var blob = chunks.join("");
  var lines = blob.split("\n").filter(function (s) { return s.length > 0; });
  check("ndjsonForRange yields one line per order", lines.length === 2);
  var parsed = JSON.parse(lines[0]);
  check("ndjsonForRange line is a JSON object",
    parsed && typeof parsed === "object" && !Array.isArray(parsed));
  check("ndjsonForRange has 27 keys by default",
    Object.keys(parsed).length === 27);
  check("ndjsonForRange surfaces the full shipping address",
    parsed.shipping_line1 === "500 Market St" &&
    parsed.shipping_city  === "San Francisco" &&
    parsed.shipping_region === "CA");
  check("ndjsonForRange includes order_id",
    typeof parsed.order_id === "string" && parsed.order_id.length === 36);
  check("ndjsonForRange surfaces hashed email field (empty when no email)",
    Object.prototype.hasOwnProperty.call(parsed, "customer_email_hash"));
}

async function _summaryAggregation() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  var seed = await _seedOrders(q, 4);
  var s = await ex.summaryForRange({ from: seed.from, to: seed.to + 1 });
  check("summary.order_count counts the seeded rows", s.order_count === 4);
  // Sum: 1000 + 1100 + 1200 + 1300 = 4600
  check("summary.revenue_minor sums grand_total",     s.revenue_minor === 4600);
  check("summary.average_order_minor is floor(rev/n)", s.average_order_minor === 1150);
  // Two paid + two delivered.
  check("summary.by_status splits paid vs delivered",
    s.by_status.paid.count === 2 && s.by_status.delivered.count === 2);
  check("summary.by_currency groups USD",
    s.by_currency.USD && s.by_currency.USD.count === 4);
}

async function _scheduleExportFsm() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  var ts0 = 1700000000000;
  var r = await ex.scheduleExport({
    format: "csv",
    from:   ts0,
    to:     ts0 + 86400000,
  });
  check("scheduleExport persists queued row",   r.status === "queued");
  check("scheduleExport returns the row id",     typeof r.id === "string" && r.id.length === 36);
  check("scheduleExport records the format",     r.format === "csv");

  var running = await ex.markExportRunning(r.id);
  check("queued → running",                      running.status === "running");
  check("running stamps started_at",             typeof running.started_at === "number");

  // Re-start refused (only queued can start).
  await assert.rejects(ex.markExportRunning(r.id), /refused|unknown/i);

  var done = await ex.markExportComplete({
    export_id:     r.id,
    row_count:     42,
    byte_size:     1024,
    file_sha3_512: "f".repeat(128),
  });
  check("running → complete",                    done.status === "complete");
  check("complete persists row_count",           done.row_count === 42);
  check("complete persists byte_size",           done.byte_size === 1024);
  check("complete persists file_sha3_512",       done.file_sha3_512 === "f".repeat(128));

  // Bad digest shape refused.
  var r2 = await ex.scheduleExport({ format: "ndjson", from: ts0, to: ts0 + 1 });
  await ex.markExportRunning(r2.id);
  await assert.rejects(ex.markExportComplete({
    export_id: r2.id, row_count: 0, byte_size: 0, file_sha3_512: "deadbeef",
  }), /128-hex/);

  // listExports shape
  var listing = await ex.listExports({ limit: 10 });
  check("listExports returns rows",              Array.isArray(listing.rows) && listing.rows.length >= 2);
}

async function _cancelExportRefusedOnceRunning() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  var ts0 = 1700000000000;
  // Cancel-from-queued is fine.
  var queued = await ex.scheduleExport({ format: "csv", from: ts0, to: ts0 + 1 });
  var cancelled = await ex.cancelExport(queued.id);
  check("queued → cancelled",                    cancelled.status === "cancelled");

  // Cancel-from-running is refused.
  var r2 = await ex.scheduleExport({ format: "csv", from: ts0, to: ts0 + 1 });
  await ex.markExportRunning(r2.id);
  await assert.rejects(ex.cancelExport(r2.id), /refused|unknown/i);

  // Mark-failed on a running row is fine.
  var failed = await ex.markExportFailed({ export_id: r2.id, error: "disk full" });
  check("running → failed",                      failed.status === "failed");
  check("failed persists error text",            failed.error === "disk full");
}

async function _projectionEmailHash() {
  var q  = _makeQuery();
  var ex = orderExport.create({ query: q });
  // The projection helper is exposed for direct test access — feed
  // it a synthetic order row carrying an email and confirm the hash
  // surfaces in the output column without the raw value.
  var projected = ex._projectOrder({
    id:                "00000000-0000-7000-8000-000000000001",
    customer_email:    "alice@example.com",
    grand_total_minor: 5000,
    currency:          "USD",
  }, {});
  check("_projectOrder hashes customer_email",
    typeof projected.customer_email_hash === "string" &&
    projected.customer_email_hash.length === 128);                              // SHA3-512 hex
  check("_projectOrder never surfaces raw email",
    JSON.stringify(projected).indexOf("alice@example.com") === -1);
}

async function run() {
  await _csvBasics();
  await _rfc4180Quoting();
  await _csvInjectionRefusal();
  await _columnsFilter();
  await _ndjsonShape();
  await _summaryAggregation();
  await _scheduleExportFsm();
  await _cancelExportRefusedOnceRunning();
  await _projectionEmailHash();
}

module.exports = { run: run };
