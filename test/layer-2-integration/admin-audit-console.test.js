"use strict";
/**
 * Read-only audit console — /admin/audit.
 *
 * Two layers, because the audit store (`b.audit`) is a process-global whose
 * backing DB is opened/closed per `createApp` across the smoke suite — a prior
 * test's teardown can leave it closed, so a LIVE query can return empty here.
 * The screen is a read-only observability view that must never 500, so:
 *
 *   - HTTP integration asserts the DB-independent behaviour: the route renders
 *     200 (resilient to an unavailable store), carries the nav link, surfaces
 *     the outcome-filter notice, serves JSON to a bearer, and gates anon.
 *   - A deterministic renderer unit test (renderAdminAudit) pins row display,
 *     escape-by-default on every cell (the XSS regression), and the pager —
 *     independent of the shared audit store's state.
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

// catalog + config + order are the admin.mount minimums; the audit_log table
// is baked into createApp's db.init schema runner, so no extra migration is
// needed for the audit rows.
var MIGS = ["0001_catalog.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql"]
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

// ---- renderer unit: display + escape-by-default + pager (no DB) ---------
function _renderUnit() {
  var auditRows = [
    { recordedAt: 1717200000000, action: "shop_admin.product.create", outcome: "success", actorUserId: "op1", resourceKind: "product", resourceId: "p1", metadata: "{\"id\":\"p1\"}" },
    { recordedAt: 1717200001000, action: "shop_admin.product.update", outcome: "success", actorUserId: "op1", metadata: "{\"note\":\"<script>alert(1)</script>\",\"evil\":\"<img src=x onerror=alert(1)>\"}" },
  ];
  var html = bShop.admin.renderAdminAudit({
    shop_name: "Test Shop", nav_available: { auditLog: true },
    rows: auditRows, filters: { limit: 50, offset: 0 },
  });
  check("render shows the create action",        html.indexOf("shop_admin.product.create") !== -1);
  check("render nav includes /admin/audit",      html.indexOf("\"/admin/audit\"") !== -1);
  // XSS regression — every cell is escape-by-default: raw payload ABSENT,
  // escaped form PRESENT.
  check("render raw <script> absent",            html.indexOf("<script>alert(1)</script>") === -1);
  check("render escaped &lt;script&gt; present",  html.indexOf("&lt;script&gt;") !== -1);
  check("render raw <img onerror absent",        html.indexOf("<img src=x onerror=") === -1);
  check("render escaped &lt;img present",         html.indexOf("&lt;img src=x") !== -1);

  // Pager: Older shown only when the page is full; Newer is a link past offset 0.
  var pageFull = bShop.admin.renderAdminAudit({ shop_name: "S", nav_available: { auditLog: true }, rows: [auditRows[0]], filters: { limit: 1, offset: 0 } });
  check("full page shows Older pager",           pageFull.indexOf("Older →") !== -1);
  var pageNext = bShop.admin.renderAdminAudit({ shop_name: "S", nav_available: { auditLog: true }, rows: [auditRows[0]], filters: { limit: 1, offset: 1 } });
  check("offset>0 shows Newer pager link",       pageNext.indexOf("← Newer</a>") !== -1);
}

async function _run() {
  // Renderer unit first — deterministic, no server/DB.
  _renderUnit();

  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var config  = bShop.config.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "audit-ord" });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-audit-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, config: config, order: order,
        shop_name: "Test Shop",
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

    // An audited admin WRITE — the route emits audit (drop-silent) and still
    // redirects; proves the audited write path is reachable.
    var created = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", jar: jar,
      form: { title: "Audited Widget", slug: "audited-widget", status: "active" },
    });
    check("product create redirected",     created.status === 303);

    // HTML console renders 200 with the nav link — resilient to an unavailable
    // audit store (read-only observability view must never 500).
    var html = await helpers.httpRequest({ port: port, path: "/admin/audit", jar: jar });
    check("audit screen then 200",         html.status === 200);
    check("nav includes /admin/audit",     html.body.indexOf("\"/admin/audit\"") !== -1);

    // Bearer GET → JSON, 200, never a 500.
    var api = await helpers.httpRequest({ port: port, path: "/admin/audit", headers: bearer });
    check("audit API is JSON",             (api.headers["content-type"] || "").indexOf("application/json") === 0);
    check("audit API then 200",            api.status === 200);

    // Outcome filter + bad-filter fallback (no rows needed).
    var byOutcome = await helpers.httpRequest({ port: port, path: "/admin/audit?outcome=success", jar: jar });
    check("outcome=success then 200",      byOutcome.status === 200);
    var bogus = await helpers.httpRequest({ port: port, path: "/admin/audit?outcome=bogus", jar: jar });
    check("bad outcome then 200",          bogus.status === 200);
    check("bad outcome shows a notice",    bogus.body.indexOf("Unknown outcome filter") !== -1);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/audit" });
    check("anon audit → login form",       anon.body.indexOf("Admin API key") !== -1);
    check("anon audit hides data",         anon.body.indexOf("shop_admin.product.create") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
