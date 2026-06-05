"use strict";
/**
 * Error feed console — operator-readable surface for the server-side
 * 5xx-class failure messages lib/error-log.js captures into D1.
 *
 * The operational gap this closes: a failing request (checkout-confirm
 * 500, the catalog-API scrub, the admin unknown-error path) sends its
 * scrubbed detail to the container's LOCAL audit sink, which
 * `wrangler tail` doesn't carry — so an operator (or tooling) had no
 * CLI/HTTP way to read production errors. /admin/errors fixes that with
 * BOTH a rendered console screen (browser cookie) and a JSON contract
 * (bearer token, for `curl`).
 *
 * Boots one b.createApp with admin.mount wired with a captured-error
 * `errorLog` handle backed by one in-memory node:sqlite DB loaded from
 * the live error-log migrations (0100 + 0208).
 *
 * Exercises:
 *   - AUTH: anon GET → the sign-in form (never 5xx); a bearer GET with a
 *     WRONG key → the sign-in form with NO captured rows leaked (the
 *     _pageOrApi dual route treats a bad token as not-authed, not 401);
 *     a bearer GET with the RIGHT key → JSON rows
 *   - the JSON contract: newest-first { rows, limit }, route+message+status
 *   - the HTML console screen: newest-first table, time + route + message
 *   - XSS: a captured message carrying a <script> payload renders ESCAPED
 *     in both the HTML screen and (as a JSON string) the API
 *   - the nav link appears only when the feed is wired
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

var TOKEN = "admin-token-0123456789abcdef-errors";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql",
  "0100_error_log.sql", "0208_error_log_message.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeDb() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  var query = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  return { db: db, query: query };
}

var XSS = "<script>alert('pwn')</script>";

async function _run() {
  var d = _makeDb();
  var catalog = bShop.catalog.create({ query: d.query });
  var order   = bShop.order.create({ query: d.query, cursorSecret: "err-console-order" });
  var config  = bShop.config.create({ query: d.query });
  var errorLog = bShop.errorLog.create({ query: d.query });

  // Seed three captured errors at distinct timestamps (newest last) so
  // the newest-first ordering is unambiguous. One carries an XSS payload.
  var base = Date.now() - 60000;
  await errorLog.captureServerError({ route: "/api/catalog/products", message: "DB read timeout", method: "GET", status: 500, occurred_at: base });
  await errorLog.captureServerError({ route: "/checkout", message: "Stripe confirm failed: card_declined", method: "POST", status: 500, occurred_at: base + 1000 });
  await errorLog.captureServerError({ route: "/checkout", message: "boom " + XSS, method: "POST", status: 500, occurred_at: base + 2000 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-err-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        errorLog: errorLog,
      });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    // ---- AUTH: anon GET → sign-in form, never a 5xx --------------------
    var anon = await helpers.httpRequest({ port: port, path: "/admin/errors" });
    check("anon errors console does not 5xx", anon.status < 500);
    check("anon errors console → sign-in form", anon.body.indexOf("Admin API key") !== -1);
    check("anon errors console leaks no captured message", anon.body.indexOf("card_declined") === -1);

    // ---- AUTH: wrong bearer key never leaks ----------------------------
    // A dual HTML/JSON admin route (_pageOrApi) treats a non-matching
    // bearer token as "not authed": a GET falls through to the sign-in
    // form (200), it does NOT route to the JSON handler. The guarantee
    // that matters is that NO captured row reaches an unauthenticated
    // caller — assert that, and that the response never 5xxes.
    var wrong = await helpers.httpRequest({
      port: port, path: "/admin/errors",
      headers: { authorization: "Bearer wrong-key-0123456789abcdef-nope" },
    });
    check("wrong bearer key does not 5xx", wrong.status < 500);
    check("wrong bearer key → sign-in form", wrong.body.indexOf("Admin API key") !== -1);
    check("wrong bearer key leaks no captured message", wrong.body.indexOf("card_declined") === -1 && wrong.body.indexOf("DB read timeout") === -1);

    // ---- API: right bearer key → JSON rows, newest-first ---------------
    var api = await helpers.httpRequest({ port: port, path: "/admin/errors", headers: bearer });
    check("errors API → 200", api.status === 200);
    check("errors API is JSON", (api.headers["content-type"] || "").indexOf("application/json") === 0);
    var payload = JSON.parse(api.body);
    check("errors API returns all 3 rows", Array.isArray(payload.rows) && payload.rows.length === 3);
    check("errors API newest-first", payload.rows[0].route === "/checkout" && payload.rows[0].occurred_at === base + 2000);
    check("errors API row carries route", payload.rows[1].route === "/checkout" && payload.rows[1].message === "Stripe confirm failed: card_declined");
    check("errors API row carries status + method", payload.rows[1].status === 500 && payload.rows[1].method === "POST");
    check("errors API oldest row last", payload.rows[2].route === "/api/catalog/products");
    // The XSS payload is a JSON string value — inert in a JSON response
    // (no HTML context), surfaced verbatim for the operator's tooling.
    check("errors API carries the raw message for tooling", payload.rows[0].message.indexOf(XSS) !== -1);

    // ---- API: ?limit= clamps + caps -----------------------------------
    var apiLimited = await helpers.httpRequest({ port: port, path: "/admin/errors?limit=1", headers: bearer });
    var lp = JSON.parse(apiLimited.body);
    check("errors API honours ?limit=1", lp.rows.length === 1 && lp.limit === 1);
    check("errors API limit=1 returns the newest", lp.rows[0].occurred_at === base + 2000);
    var apiBadLimit = await helpers.httpRequest({ port: port, path: "/admin/errors?limit=99999", headers: bearer });
    check("errors API clamps an oversized limit", apiBadLimit.status === 200 && JSON.parse(apiBadLimit.body).limit === 500);

    // ---- HTML console screen (browser cookie) --------------------------
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    var page = await helpers.httpRequest({ port: port, path: "/admin/errors", jar: jar });
    check("errors console → 200", page.status === 200);
    check("errors console is HTML", (page.headers["content-type"] || "").indexOf("text/html") === 0);
    check("errors console heading", page.body.indexOf("<h2>Errors</h2>") !== -1);
    check("nav includes Errors link", page.body.indexOf("\"/admin/errors\"") !== -1);
    check("errors console shows the routes", page.body.indexOf("/checkout") !== -1 && page.body.indexOf("/api/catalog/products") !== -1);
    check("errors console shows a message", page.body.indexOf("Stripe confirm failed: card_declined") !== -1);
    check("errors console documents the JSON contract", page.body.indexOf("Authorization: Bearer") !== -1);

    // ---- XSS: the captured payload renders ESCAPED ---------------------
    check("errors console escapes the captured <script>", page.body.indexOf("<script>alert('pwn')</script>") === -1);
    check("errors console renders the payload as escaped entities",
      page.body.indexOf("&lt;script&gt;alert(&#x27;pwn&#x27;)&lt;/script&gt;") !== -1);

    // ---- empty feed degrades cleanly -----------------------------------
    var d2 = _makeDb();
    var emptyErrorLog = bShop.errorLog.create({ query: d2.query });
    var app2 = await b.createApp({
      dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-err-empty-")),
      vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
      middleware: { botGuard: false, rateLimit: false },
      routes: function (r) {
        r.use(b.middleware.bodyParser());
        bShop.admin.mount(r, { token: TOKEN, shop_name: "Empty Shop", catalog: catalog, order: order, config: config, errorLog: emptyErrorLog });
      },
    });
    var bound2 = await app2.listen({ port: 0, host: "127.0.0.1" });
    try {
      var emptyApi = await helpers.httpRequest({ port: bound2.port, path: "/admin/errors", headers: bearer });
      check("empty feed API → 200 with no rows", emptyApi.status === 200 && JSON.parse(emptyApi.body).rows.length === 0);
      var jar2 = helpers.cookieJar();
      await helpers.httpRequest({ port: bound2.port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar2 });
      var emptyPage = await helpers.httpRequest({ port: bound2.port, path: "/admin/errors", jar: jar2 });
      check("empty feed console shows the empty state", emptyPage.status === 200 && emptyPage.body.indexOf("No server errors recorded.") !== -1);
    } finally {
      try { await app2.shutdown(); } catch (_e) { /* */ }
    }
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
