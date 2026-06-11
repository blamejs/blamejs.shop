"use strict";
/**
 * Admin cookie/HTML form path — a thrown storage-engine / parser / unknown
 * error must NOT reach the rendered error banner.
 *
 * The bearer JSON path (admin-db-constraint-error-mapping.test.js) already
 * proves the _wrap chokepoint maps a DB constraint to a clean 409/400 with a
 * generic detail. This drives the COOKIE/SESSION path an operator's browser
 * actually uses: log in for the shop_admin session cookie, then submit the
 * New-Product form with a DUPLICATE slug (and a missing-product media attach
 * for the FOREIGN KEY case). Both share the same classifier (_safeNotice), so
 * the HTML banner can never surface a raw `UNIQUE constraint failed:
 * products.slug` / `FOREIGN KEY constraint failed` / parser-position string.
 *
 * The httpRequest helper echoes the captured CSRF cookie as X-CSRF-Token on a
 * form POST carrying the jar, so the session POSTs satisfy csrfProtect the
 * same way a real browser's `_csrf` field does.
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

var TOKEN = "admin-token-0123456789abcdef-banner";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql"]
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

// Assert a rendered banner body carries NONE of the storage-engine / parser
// internals the pre-fix HTML path leaked.
function _noLeak(label, body) {
  var lower = String(body).toLowerCase();
  check(label + ": no 'constraint failed'", lower.indexOf("constraint failed") === -1);
  check(label + ": no table/column name",   lower.indexOf("products.slug") === -1);
  check(label + ": no 'json at position'",  lower.indexOf("json at position") === -1);
  // No absolute filesystem path bleeding through (a thrown stack/message
  // sometimes names a vendored file). Both POSIX and Windows roots.
  check(label + ": no posix fs path",       !/\/(?:home|users|var|tmp|root)\//i.test(lower));
  check(label + ": no windows fs path",     !/[a-z]:\\/i.test(lower));
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query, cursorSecret: "banner-safe" });
  var order   = bShop.order.create({ query: query, cursorSecret: "banner-safe" });
  var config  = bShop.config.create({ query: query });

  // Seed an existing product so the New-Product form collides on the slug
  // UNIQUE index.
  await catalog.products.create({ slug: "audit-widget", title: "Audit Widget", status: "active" });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-banner-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // Establish the shop_admin session cookie via the login form.
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- (1) duplicate-slug New-Product form → clean banner, no leak ----
    var dup = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", jar: jar,
      form: { title: "Dup", slug: "audit-widget", status: "active" },
    });
    // 409 conflict — the same class the bearer path returns for a UNIQUE
    // collision; the HTML path now agrees instead of leaking a raw 400 banner.
    check("dup-slug form → 409 conflict (not a 500 / not a 303 success)", dup.status === 409);
    check("dup-slug body is the products page HTML",
      (dup.headers["content-type"] || "").indexOf("text/html") === 0);
    check("dup-slug body shows a clean in-use notice",
      dup.body.indexOf("already in use") !== -1);
    check("dup-slug body renders the banner element",
      dup.body.indexOf("banner--err") !== -1);
    _noLeak("dup-slug banner", dup.body);

    // ---- (2) FK miss: attach media to a missing product via the HTML
    //          path → ?err=1 PRG, no raw FOREIGN KEY string anywhere ----
    var ghostId = b.uuid.v7();   // well-formed UUID, no such product row
    var fk = await helpers.httpRequest({
      port: port, path: "/admin/products/" + ghostId + "/media/attach", method: "POST", jar: jar,
      form: { r2_key: "media/ghost.webp", content_type: "image/webp" },
    });
    check("media FK miss → 303 PRG (not a 500)", fk.status === 303);
    check("media FK miss redirects with err flag",
      (fk.headers.location || "").indexOf("err=1") !== -1);
    // Neither the redirect target nor any body carries the raw constraint
    // string — `?err=1` is a flag, not a message.
    _noLeak("media FK miss location", fk.headers.location || "");
    _noLeak("media FK miss body", fk.body || "");

    // ---- a clean create via the same session still succeeds (the
    //      classifier didn't break the happy path) ----
    var ok = await helpers.httpRequest({
      port: port, path: "/admin/products", method: "POST", jar: jar,
      form: { title: "Fresh", slug: "fresh-widget", status: "active" },
    });
    check("clean create via session → 303 to the new product", ok.status === 303);
    check("clean create redirects to the detail with created flag",
      (ok.headers.location || "").indexOf("created=1") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
