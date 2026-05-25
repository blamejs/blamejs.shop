"use strict";
/**
 * Reviews moderation console — full HTTP integration of the browser-side
 * review screens in the admin console.
 *
 * Boots a real `b.createApp` server with `admin.mount` wired with a token
 * + catalog + config + reviews, against one in-memory `node:sqlite` DB. A
 * product is seeded and a review submitted (pending). Exercises the queue
 * (HTML + JSON), the status filter incl. the bad-filter fallback, and the
 * publish / reject moderation driven from the browser — plus a bad id
 * (no-op notice) and the auth gate.
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

var TOKEN = "admin-token-0123456789abcdef-test"; // ≥ 16 chars

var MIGS = ["0001_catalog.sql", "0004_shop_config.sql", "0011_reviews.sql"]
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var config  = bShop.config.create({ query: query });
  var reviews = bShop.reviews.create({ query: query, cursorSecret: "rev-console" });

  var product = await catalog.products.create({ title: "Widget", slug: "widget", status: "active" });
  var submitted = await reviews.submit({
    product_id: product.id, customer_email: "buyer@example.com",
    rating: 5, title: "Great widget", body: "Works exactly as described.",
  });
  var rid = submitted.id;

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-rev-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, config: config,
        order: bShop.order.create({ query: query, cursorSecret: "rev-ord" }),
        reviews: reviews, shop_name: "Test Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",              login.status === 303);

    // Queue: HTML for the browser, JSON for the bearer token.
    var queueHtml = await helpers.httpRequest({ port: port, path: "/admin/reviews", jar: jar });
    check("reviews queue then 200",            queueHtml.status === 200);
    check("queue shows the review body",        queueHtml.body.indexOf("Works exactly as described.") !== -1);
    check("queue offers Publish + Reject",      queueHtml.body.indexOf("Publish") !== -1 && queueHtml.body.indexOf("Reject") !== -1);
    check("queue has status filters",           queueHtml.body.indexOf("order-filters") !== -1);
    check("nav includes Reviews",               queueHtml.body.indexOf("\"/admin/reviews\"") !== -1);
    var queueApi = await helpers.httpRequest({ port: port, path: "/admin/reviews", headers: bearer });
    check("reviews queue API still JSON",        (queueApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("queue API returns the pending row",   JSON.parse(queueApi.body).rows.length === 1);

    // Bad status filter falls back to pending with a notice.
    var badFilter = await helpers.httpRequest({ port: port, path: "/admin/reviews?status=bogus", jar: jar });
    check("bad review filter then 200",        badFilter.status === 200);
    check("bad review filter shows a notice",   badFilter.body.indexOf("Unknown status filter") !== -1);

    // Publish via the browser form → PRG to the queue, status advances.
    var publish = await helpers.httpRequest({ port: port, path: "/admin/reviews/" + rid + "/publish",
      method: "POST", jar: jar, form: {} });
    check("publish then 303",                  publish.status === 303);
    check("publish redirects moved",            (publish.headers.location || "").indexOf("moved=1") !== -1);
    check("review now published",              (await reviews.get(rid)).status === "published");
    // The published filter now lists it.
    var published = await helpers.httpRequest({ port: port, path: "/admin/reviews?status=published", jar: jar });
    check("published filter shows the review",  published.body.indexOf("Great widget") !== -1);

    // Reject via the browser form (with a reason) → status rejected.
    var reject = await helpers.httpRequest({ port: port, path: "/admin/reviews/" + rid + "/reject",
      method: "POST", jar: jar, form: { reason: "off-topic" } });
    check("reject then 303",                   reject.status === 303);
    check("review now rejected",               (await reviews.get(rid)).status === "rejected");

    // A bad id is a no-op notice (redirect with err), never a 500.
    var missing = await helpers.httpRequest({ port: port, path: "/admin/reviews/not-a-real-id/publish",
      method: "POST", jar: jar, form: {} });
    check("bad-id publish then 303",           missing.status === 303);
    check("bad-id publish flags err",           (missing.headers.location || "").indexOf("err=1") !== -1);
    // Following the err redirect surfaces a notice (not a silent refresh).
    var errView = await helpers.httpRequest({ port: port, path: "/admin/reviews?err=1", jar: jar });
    check("err flag shows a notice",            errView.body.indexOf("be completed for the review") !== -1);

    // Auth gate: anon queue → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/reviews" });
    check("anon reviews → login form",          anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
