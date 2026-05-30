"use strict";
/**
 * Sales tax filings console — the browser-side admin screens for periodic
 * remittance bookkeeping over completed orders.
 *
 * Boots b.createApp with admin.mount wired to the salesTaxFilings primitive
 * (composing taxRates for the per-rate breakdown), seeds a tax rate plus a
 * couple of completed orders that ship to the filing's jurisdiction, then
 * walks the full lifecycle over a browser cookie session — open a period,
 * compute the snapshot, record the submission + payment, amend — asserting
 * the persisted state at each step. Also covers the per-jurisdiction
 * remittance report, the bearer JSON contract, a bad-input 4xx case, and
 * the auth gate. Network: zero.
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
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql",
  "0058_tax_rates.sql", "0184_sales_tax_filings.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeDb() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
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

// Insert a completed order the filing engine will aggregate. Direct SQL —
// the engine reads the orders table raw (subtotal_minor / tax_minor /
// ship_to_json / status / created_at), so the post-checkout reporting path
// never touches cart / checkout / order-pricing code.
function _seedOrder(db, o) {
  // Minimal parent cart row — the orders.cart_id FK requires it. The filing
  // engine never reads carts; this only satisfies the schema constraint.
  db.prepare(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'converted', ?5, ?5, ?5)"
  ).run(o.cart_id, o.session_id, o.customer_id == null ? null : o.customer_id, o.currency, o.created_at);
  db.prepare(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 0, ?9, ?10, ?11, ?11)"
  ).run(
    o.id, o.cart_id, o.customer_id == null ? null : o.customer_id, o.session_id, o.status, o.currency,
    o.subtotal_minor, o.tax_minor, o.subtotal_minor + o.tax_minor,
    JSON.stringify(o.ship_to), o.created_at
  );
}

async function _run() {
  var db      = _makeDb();
  var query   = _queryFor(db);
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "sales-tax-filings" });
  var config  = bShop.config.create({ query: query });
  var taxRates = bShop.taxRates.create({ query: query });
  var salesTaxFilings = bShop.salesTaxFilings.create({ query: query, taxRates: taxRates });

  // A 7.25% rate covering the whole filing window so computeFiling produces
  // a real per-rate breakdown rather than the no-rate fallback.
  var WIN_START = Date.UTC(2026, 0, 1);          // 2026-01-01
  var WIN_END   = Date.UTC(2026, 3, 1);          // 2026-04-01 (exclusive)
  var DUE       = Date.UTC(2026, 3, 20);         // 2026-04-20
  await taxRates.defineRate({ jurisdiction: "US-CA", rate_bps: 725, source: "manual", effective_from: Date.UTC(2025, 0, 1) });

  // Two completed orders inside the window shipping to US-CA + one outside
  // the jurisdiction (must NOT contribute).
  _seedOrder(db, { id: "ord-in-1", cart_id: "c1", customer_id: null, session_id: "s1", status: "paid",
    currency: "USD", subtotal_minor: 10000, tax_minor: 725, created_at: Date.UTC(2026, 0, 15),
    ship_to: { country: "US", region: "CA" } });
  _seedOrder(db, { id: "ord-in-2", cart_id: "c2", customer_id: null, session_id: "s2", status: "delivered",
    currency: "USD", subtotal_minor: 20000, tax_minor: 1450, created_at: Date.UTC(2026, 1, 10),
    ship_to: { country: "US", region: "CA" } });
  _seedOrder(db, { id: "ord-out", cart_id: "c3", customer_id: null, session_id: "s3", status: "paid",
    currency: "USD", subtotal_minor: 50000, tax_minor: 0, created_at: Date.UTC(2026, 1, 12),
    ship_to: { country: "US", region: "NY" } });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-tax-filings-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config, shop_name: "Test Shop",
        taxRates: taxRates, salesTaxFilings: salesTaxFilings,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // Nav link present for the wired section.
    var home = await helpers.httpRequest({ port: port, path: "/admin", jar: jar });
    check("nav includes Tax filings",            home.body.indexOf("\"/admin/tax-filings\"") !== -1);

    // Empty list landing.
    var landing = await helpers.httpRequest({ port: port, path: "/admin/tax-filings", jar: jar });
    check("filings page then 200",               landing.status === 200);
    check("filings shows open-a-period form",     landing.body.indexOf("Open a filing period") !== -1);
    check("filings empty state",                 landing.body.indexOf("No filings") !== -1);

    // ---- open a filing period ----------------------------------------

    var create = await helpers.httpRequest({
      port: port, path: "/admin/tax-filings", method: "POST", jar: jar,
      form: { jurisdiction: "US-CA", kind: "quarterly",
              period_start: String(WIN_START), period_end: String(WIN_END), due_date: String(DUE) },
    });
    check("filing create then 303",              create.status === 303);
    check("filing create redirects to detail",   (create.headers.location || "").indexOf("/admin/tax-filings/") === 0);
    check("filing create redirects created",      (create.headers.location || "").indexOf("created=1") !== -1);

    var listed = await salesTaxFilings.listFilings({ jurisdiction: "US-CA" });
    check("filing persisted as draft",           listed.length === 1 && listed[0].status === "draft");
    var filingId = listed[0].id;
    var detailUrl = "/admin/tax-filings/" + filingId;

    // The list now renders the filing.
    var list = await helpers.httpRequest({ port: port, path: "/admin/tax-filings?jurisdiction=US-CA", jar: jar });
    check("filing list shows the row",           list.body.indexOf("US-CA") !== -1 && list.body.indexOf("quarterly") !== -1);
    check("filing list shows due-soon strip",    list.body.indexOf("Due soon or overdue") !== -1);

    // ---- compute the snapshot ----------------------------------------

    var detailBefore = await helpers.httpRequest({ port: port, path: detailUrl, jar: jar });
    check("detail then 200",                     detailBefore.status === 200);
    check("detail offers compute action",        detailBefore.body.indexOf("/compute\"") !== -1);
    check("detail says not computed yet",        detailBefore.body.indexOf("Not computed yet") !== -1);

    var compute = await helpers.httpRequest({ port: port, path: detailUrl + "/compute", method: "POST", jar: jar });
    check("compute then 303",                    compute.status === 303);
    check("compute redirects computed",          (compute.headers.location || "").indexOf("computed=1") !== -1);

    var afterCompute = await salesTaxFilings.getFiling(filingId);
    check("status moved to computed",            afterCompute.status === "computed");
    // Two in-window US-CA orders: 10000 + 20000 taxable; out-of-jurisdiction
    // order excluded.
    check("gross is the two in-window orders",   afterCompute.gross_revenue_minor === 30000);
    check("taxable equals gross (no exempt)",    afterCompute.taxable_revenue_minor === 30000);
    check("collected sums order tax",            afterCompute.tax_collected_minor === 2175);
    // Owed re-derived from the 725-bps rate: 30000 * 725 / 10000 = 2175.
    check("owed re-derived from rate",           afterCompute.tax_owed_minor === 2175);
    check("breakdown keyed by rate bps",         afterCompute.by_rate_breakdown && afterCompute.by_rate_breakdown["725"] && afterCompute.by_rate_breakdown["725"].order_count === 2);

    // The detail now shows the snapshot + per-rate breakdown.
    var detailComputed = await helpers.httpRequest({ port: port, path: detailUrl, jar: jar });
    check("detail shows by-rate block",          detailComputed.body.indexOf("By rate") !== -1);
    check("detail shows submit form",            detailComputed.body.indexOf("/submit\"") !== -1);

    // ---- record the submission ---------------------------------------

    var submit = await helpers.httpRequest({
      port: port, path: detailUrl + "/submit", method: "POST", jar: jar,
      form: { submission_ref: "DR-2026-Q1-555", submitted_by: "ops@example.com" },
    });
    check("submit then 303",                     submit.status === 303);
    check("submit redirects submitted",          (submit.headers.location || "").indexOf("submitted=1") !== -1);
    var afterSubmit = await salesTaxFilings.getFiling(filingId);
    check("status moved to submitted",           afterSubmit.status === "submitted");
    check("submission_ref persisted",            afterSubmit.submission_ref === "DR-2026-Q1-555");
    check("submitted_by persisted",              afterSubmit.submitted_by === "ops@example.com");

    // ---- record the payment ------------------------------------------

    var pay = await helpers.httpRequest({
      port: port, path: detailUrl + "/pay", method: "POST", jar: jar,
      form: { payment_minor: "2175", payment_ref: "ACH-99887766" },
    });
    check("pay then 303",                        pay.status === 303);
    check("pay redirects paid",                  (pay.headers.location || "").indexOf("paid=1") !== -1);
    var afterPay = await salesTaxFilings.getFiling(filingId);
    check("status moved to paid",                afterPay.status === "paid");
    check("payment_minor persisted",             afterPay.payment_minor === 2175);
    check("payment_ref persisted",               afterPay.payment_ref === "ACH-99887766");

    // ---- amend a paid filing -----------------------------------------

    var amend = await helpers.httpRequest({
      port: port, path: detailUrl + "/amend", method: "POST", jar: jar,
      form: { reason: "A late refund changed the taxable base." },
    });
    check("amend then 303",                      amend.status === 303);
    check("amend redirects amended",             (amend.headers.location || "").indexOf("amended=1") !== -1);
    var afterAmend = await salesTaxFilings.getFiling(filingId);
    check("status moved to amended",             afterAmend.status === "amended");
    check("amended_reason persisted",            afterAmend.amended_reason === "A late refund changed the taxable base.");

    // ---- remittance report -------------------------------------------

    var report = await helpers.httpRequest({
      port: port, path: "/admin/tax-filings/report?jurisdiction=US-CA&from=" + (WIN_START - 1) + "&to=" + (WIN_END + 1), jar: jar,
    });
    check("report then 200",                     report.status === 200);
    check("report shows the jurisdiction",       report.body.indexOf("US-CA") !== -1);
    check("report sums the filing",              report.body.indexOf("Tax owed") !== -1);

    var reportApi = await helpers.httpRequest({
      port: port, path: "/admin/tax-filings/report?jurisdiction=US-CA&from=" + (WIN_START - 1) + "&to=" + (WIN_END + 1), headers: bearer,
    });
    check("report API JSON",                     (reportApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var reportModel = JSON.parse(reportApi.body);
    check("report API totals the filing",        reportModel.filing_count === 1 && reportModel.total_tax_owed_minor === 2175);

    // ---- bearer JSON list contract -----------------------------------

    var listApi = await helpers.httpRequest({ port: port, path: "/admin/tax-filings?jurisdiction=US-CA", headers: bearer });
    check("filings API JSON",                    (listApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("filings API returns the row",         JSON.parse(listApi.body).rows.length === 1);

    var detailApi = await helpers.httpRequest({ port: port, path: detailUrl, headers: bearer });
    check("filing detail API JSON",              (detailApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("filing detail API id matches",        JSON.parse(detailApi.body).id === filingId);
    var missingApi = await helpers.httpRequest({ port: port, path: "/admin/tax-filings/00000000-0000-0000-0000-000000000000", headers: bearer });
    check("unknown filing API 404",              missingApi.status === 404);

    // ---- bad input → 4xx, never 500 ----------------------------------

    // period_end before period_start → the primitive throws TypeError →
    // the create route re-renders with a 400 notice.
    var badCreate = await helpers.httpRequest({
      port: port, path: "/admin/tax-filings", method: "POST", jar: jar,
      form: { jurisdiction: "US-CA", kind: "quarterly",
              period_start: String(WIN_END), period_end: String(WIN_START), due_date: String(DUE) },
    });
    check("bad period then 400",                 badCreate.status === 400);

    // A non-numeric period field → strict-int parse 400.
    var badInt = await helpers.httpRequest({
      port: port, path: "/admin/tax-filings", method: "POST", jar: jar,
      form: { jurisdiction: "US-CA", kind: "monthly",
              period_start: "not-a-number", period_end: String(WIN_END), due_date: String(DUE) },
    });
    check("bad int then 400",                    badInt.status === 400);

    // A present-but-malformed report window is a graceful notice, NEVER a 500.
    var badRange = await helpers.httpRequest({ port: port, path: "/admin/tax-filings/report?jurisdiction=US-CA&from=abc&to=123", jar: jar });
    check("malformed report range → 200 notice not 500", badRange.status === 200 && badRange.body.indexOf("from and a to date") !== -1);

    // A bad transition (compute a paid/amended filing) is a 4xx notice, not
    // a 500. The amended filing can't be computed.
    var badTransition = await helpers.httpRequest({ port: port, path: detailUrl + "/compute", method: "POST", jar: jar });
    check("bad transition redirects err",        badTransition.status === 303 && (badTransition.headers.location || "").indexOf("err=1") !== -1);

    // ---- auth gate ---------------------------------------------------

    var anon = await helpers.httpRequest({ port: port, path: "/admin/tax-filings" });
    check("anon filings → login form",           anon.body.indexOf("Admin API key") !== -1);
    var anonDetail = await helpers.httpRequest({ port: port, path: detailUrl });
    check("anon detail → login form",            anonDetail.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
