"use strict";
/**
 * Order export console — admin date-range CSV / NDJSON dump + the
 * scheduled-export queue.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + orderExport),
 * seeds a handful of orders across known dates (one carrying a CSV-dangerous
 * shipping-address field), and exercises:
 *   - GET /admin/exports renders the range form + the scheduled-export list
 *   - a range preview shows the order count + total (HTML + bearer JSON)
 *   - the download streams CSV (text/csv + the seeded rows) and NDJSON
 *     (application/x-ndjson) for the chosen window
 *   - a CSV-dangerous customer-controlled cell ("=cmd()") is neutralized
 *     in the CSV output (quoted + `'`-prefixed, never a raw leading `=`)
 *   - an empty / inverted range is a clean 4xx (no leak)
 *   - scheduleExport via the form appears in listExports; cancelExport
 *     flips its status to cancelled
 *   - anon → sign-in form, never data
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
var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0206_orders_email_hash.sql",
  "0039_scheduled_exports.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
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

// Calendar-date → epoch-ms at UTC midnight, mirroring the admin date helper.
function _dayMs(yyyyMmDd) { return Date.parse(yyyyMmDd + "T00:00:00Z"); }

// Direct-INSERT an order at a precise created_at with a chosen ship_to —
// the export reads via plain SQL over the orders table, so the seed bypasses
// the order primitive's createFromCart (which computes its own created_at).
// orders.cart_id FKs into carts(id), so the parent cart row is seeded first.
async function _seedOrder(query, opts) {
  var id = b.uuid.v7();
  var cartId = b.uuid.v7();
  var sessionId = b.uuid.v7();
  var customerId = b.uuid.v7();
  var ts = opts.created_at;
  var grand = opts.grand_total_minor;
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionId, customerId, ts, ts + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', ?5, 0, 0, 0, ?5, NULL, ?6, ?7, ?7)",
    [id, cartId, customerId, sessionId, grand, JSON.stringify(opts.ship_to || { country: "US" }), ts],
  );
  return id;
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "order-export-console-order" });
  var orderExport = bShop.orderExport.create({ query: query, order: order, cursorSecret: "order-export-console-test" });

  // Three orders on 2024-02-10, 02-11, 02-12. The 02-11 order carries a
  // shipping-address line that is a classic CSV-injection payload — a
  // customer-controlled cell beginning with `=`.
  var d10 = _dayMs("2024-02-10") + 3600000;
  var d11 = _dayMs("2024-02-11") + 3600000;
  var d12 = _dayMs("2024-02-12") + 3600000;
  var d20 = _dayMs("2024-02-20") + 3600000;  // out of the test window
  await _seedOrder(query, { created_at: d10, grand_total_minor: 1000, ship_to: { line1: "10 First St", city: "Townsville", country: "US" } });
  await _seedOrder(query, { created_at: d11, grand_total_minor: 2500, ship_to: { line1: "=cmd()|' /C calc'", city: "Cellburg", country: "US" } });
  await _seedOrder(query, { created_at: d12, grand_total_minor: 3000, ship_to: { line1: "30 Third Ave", city: "Cityton", country: "US" } });
  await _seedOrder(query, { created_at: d20, grand_total_minor: 9999, ship_to: { line1: "Out of range", country: "US" } });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-export-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, orderExport: orderExport, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  // The window covering 02-10..02-12 inclusive: from-date=02-10, to-date=02-12
  // (the route advances the inclusive end to the next UTC midnight, so the
  // half-open [from, to) window is 02-10 00:00 .. 02-13 00:00 UTC).
  var winFrom = _dayMs("2024-02-10");
  var winTo   = _dayMs("2024-02-13");

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // ---- screen renders the range form + nav + the scheduled list ----
    var page = await helpers.httpRequest({ port: port, path: "/admin/exports", jar: jar });
    check("exports page then 200",               page.status === 200);
    check("exports page shows the heading",       page.body.indexOf("Exports") !== -1);
    check("exports page shows the range form",    page.body.indexOf("name=\"from-date\"") !== -1 && page.body.indexOf("name=\"to-date\"") !== -1);
    check("exports page shows the schedule form", page.body.indexOf("/admin/exports/schedule") !== -1);
    check("nav includes Exports",                 page.body.indexOf("\"/admin/exports\"") !== -1);
    check("empty queue shows the empty state",    page.body.indexOf("No scheduled exports yet") !== -1);

    // ---- range preview: count + total (HTML) ----
    var preview = await helpers.httpRequest({ port: port, path: "/admin/exports?from-date=2024-02-10&to-date=2024-02-12", jar: jar });
    check("range preview then 200",              preview.status === 200);
    check("range preview shows the order count",  preview.body.indexOf(">3<") !== -1 || preview.body.indexOf("3</strong>") !== -1 || preview.body.indexOf("Orders in range") !== -1);
    check("range preview shows download links",   preview.body.indexOf("/admin/exports/download?") !== -1);

    // ---- range preview: bearer JSON summary ----
    var apiPreview = await helpers.httpRequest({ port: port, path: "/admin/exports?from=" + winFrom + "&to=" + winTo, headers: bearer });
    check("preview API is JSON",                  (apiPreview.headers["content-type"] || "").indexOf("application/json") === 0);
    var pj = JSON.parse(apiPreview.body);
    check("preview API summary counts 3 orders",  pj.summary && pj.summary.order_count === 3);
    check("preview API summary totals 6500",      pj.summary && pj.summary.revenue_minor === 6500);
    check("preview API lists exports array",       Array.isArray(pj.exports));

    // ---- CSV download: content-type, rows, CSV-injection neutralization ----
    var csv = await helpers.httpRequest({ port: port, path: "/admin/exports/download?from=" + winFrom + "&to=" + winTo + "&format=csv", jar: jar });
    check("CSV download then 200",               csv.status === 200);
    check("CSV download is text/csv",            (csv.headers["content-type"] || "").indexOf("text/csv") === 0);
    check("CSV download is an attachment",       (csv.headers["content-disposition"] || "").indexOf("attachment") === 0 && (csv.headers["content-disposition"] || "").indexOf(".csv") !== -1);
    check("CSV header carries the column names", csv.body.indexOf("\"order_id\"") === 0 && csv.body.indexOf("\"shipping_line1\"") !== -1);
    check("CSV body carries the seeded cities",  csv.body.indexOf("Townsville") !== -1 && csv.body.indexOf("Cityton") !== -1);
    // Only the 3 in-window orders + the header (4 CRLF-terminated lines);
    // the 02-20 order is excluded by the window.
    var csvLines = csv.body.split("\r\n").filter(function (s) { return s.length > 0; });
    check("CSV download has header + 3 rows",     csvLines.length === 4);
    check("CSV excludes the out-of-window order", csv.body.indexOf("Out of range") === -1);

    // The CSV-injection assertion: the "=cmd()..." shipping-address cell
    // must be neutralized — the shared b.guardCsv.escapeCell prefixes a
    // dangerous leading metacharacter with a TAB inside the RFC-4180 quotes.
    // So the cell is `"\t=cmd()..."`, NEVER a raw `"=cmd()..."`.
    check("CSV neutralizes the formula cell",     csv.body.indexOf("\"\t=cmd()") !== -1);
    check("CSV never emits a raw leading = cell",  csv.body.indexOf("\"=cmd()") === -1);

    // ---- NDJSON download ----
    var ndj = await helpers.httpRequest({ port: port, path: "/admin/exports/download?from=" + winFrom + "&to=" + winTo + "&format=ndjson", jar: jar });
    check("NDJSON download then 200",            ndj.status === 200);
    check("NDJSON is application/x-ndjson",      (ndj.headers["content-type"] || "").indexOf("application/x-ndjson") === 0);
    var ndjLines = ndj.body.split("\n").filter(function (s) { return s.length > 0; });
    check("NDJSON has one object per in-window order", ndjLines.length === 3);
    var firstObj = JSON.parse(ndjLines[0]);
    check("NDJSON line is a JSON object",        firstObj && typeof firstObj === "object" && !Array.isArray(firstObj));
    check("NDJSON surfaces the shipping address", typeof firstObj.shipping_line1 === "string");

    // ---- bad range → clean 4xx, no leak ----
    var inverted = await helpers.httpRequest({ port: port, path: "/admin/exports/download?from=" + winTo + "&to=" + winFrom + "&format=csv", headers: bearer });
    check("inverted range → 400",                inverted.status === 400);
    check("inverted range body carries no rows", inverted.body.indexOf("Townsville") === -1 && inverted.body.indexOf("order_id") === -1);
    var noRange = await helpers.httpRequest({ port: port, path: "/admin/exports/download?from=" + winFrom + "&format=csv", headers: bearer });
    check("missing-bound range → 400",           noRange.status === 400);
    var badFmt = await helpers.httpRequest({ port: port, path: "/admin/exports/download?from=" + winFrom + "&to=" + winTo + "&format=xml", headers: bearer });
    check("bad format → 400",                    badFmt.status === 400);

    // ---- schedule a new export → appears in listExports ----
    var sched = await helpers.httpRequest({
      port: port, path: "/admin/exports/schedule", method: "POST", jar: jar,
      form: { "from-date": "2024-02-10", "to-date": "2024-02-12", format: "csv" },
    });
    check("schedule export → 303 redirect",      sched.status === 303);
    var afterSched = await orderExport.listExports({ limit: 10 });
    check("scheduled job appears in listExports", afterSched.rows.length === 1 && afterSched.rows[0].status === "queued");
    check("scheduled job records the format",     afterSched.rows[0].format === "csv");
    var jobId = afterSched.rows[0].id;

    // The list page now renders the queued job + a Cancel control.
    var listPage = await helpers.httpRequest({ port: port, path: "/admin/exports", jar: jar });
    check("queued job renders on the screen",     listPage.body.indexOf("queued") !== -1);
    check("queued job has a cancel form",         listPage.body.indexOf("/admin/exports/" + encodeURIComponent(jobId) + "/cancel") !== -1);

    // ---- cancel the queued export → status reflects it ----
    var cancel = await helpers.httpRequest({
      port: port, path: "/admin/exports/" + encodeURIComponent(jobId) + "/cancel", method: "POST", jar: jar,
    });
    check("cancel export → 303 redirect",        cancel.status === 303);
    var afterCancel = await orderExport.getExport(jobId);
    check("cancelled job status is cancelled",    afterCancel && afterCancel.status === "cancelled");

    // A second cancel (already-cancelled, FSM refuses) → browser err redirect,
    // never a 500.
    var reCancel = await helpers.httpRequest({
      port: port, path: "/admin/exports/" + encodeURIComponent(jobId) + "/cancel", method: "POST", jar: jar,
    });
    check("re-cancel → 303 (err redirect, not 500)", reCancel.status === 303 && (reCancel.headers["location"] || "").indexOf("err=1") !== -1);

    // Bearer cancel of a malformed id → 400 (bad request), not a 404/500.
    var badCancel = await helpers.httpRequest({
      port: port, path: "/admin/exports/not-a-uuid/cancel", method: "POST", headers: bearer,
    });
    check("malformed cancel id → 400",           badCancel.status === 400);

    // Bearer cancel of a syntactically valid UUID that names no job → 404
    // (distinct from the malformed-id 400) so API clients can tell a
    // missing job from a bad id.
    var missingCancel = await helpers.httpRequest({
      port: port, path: "/admin/exports/" + b.uuid.v7() + "/cancel", method: "POST", headers: bearer,
    });
    check("missing cancel id → 404",             missingCancel.status === 404);

    // Bearer cancel of the already-cancelled job → 409 conflict: the FSM
    // refuses a cancel from a terminal state, surfaced as a coded conflict
    // (never a 400 or a 500).
    var bearerReCancel = await helpers.httpRequest({
      port: port, path: "/admin/exports/" + encodeURIComponent(jobId) + "/cancel", method: "POST", headers: bearer,
    });
    check("bearer cancel of terminal job → 409", bearerReCancel.status === 409);

    // ---- auth gate: anon → sign-in form, never data ----
    var anon = await helpers.httpRequest({ port: port, path: "/admin/exports" });
    check("anon exports → login form",           anon.body.indexOf("Admin API key") !== -1);
    check("anon does not leak the queue",         anon.body.indexOf("Scheduled exports") === -1);
    var anonDl = await helpers.httpRequest({ port: port, path: "/admin/exports/download?from=" + winFrom + "&to=" + winTo + "&format=csv" });
    check("anon download → login form, no rows",  anonDl.body.indexOf("Townsville") === -1 && anonDl.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
