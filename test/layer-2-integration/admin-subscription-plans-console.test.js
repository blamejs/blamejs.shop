"use strict";
/**
 * Subscription-plans console — browser-side admin plan catalog.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * subscriptions), seeds an active and an archived plan, and exercises the
 * list (HTML + JSON), the active/archived filter, the create form, the
 * archive row action, the bearer JSON contract, and the auth gate. The
 * plans are standalone (no variant), so no Stripe round-trip happens.
 * Network: zero.
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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql", "0009_subscriptions.sql"]
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "subs-console" });
  var config  = bShop.config.create({ query: query });
  var subs    = bShop.subscriptions.create({ query: query });

  // Seed: an active monthly plan and an archived one.
  var keep = await subs.plans.create({ stripe_price_id: "price_keep", interval: "month", currency: "usd", amount_minor: 1999, trial_days: 14 });
  var gone = await subs.plans.create({ stripe_price_id: "price_gone", interval: "year",  currency: "usd", amount_minor: 9900 });
  await subs.plans.archive(gone.id);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-subs-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, subscriptions: subs, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",               login.status === 303);

    // List: HTML for the browser, JSON for the bearer token.
    var html = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans", jar: jar });
    check("plans page then 200",                html.status === 200);
    check("plans shows the Stripe price ids",   html.body.indexOf("price_keep") !== -1 && html.body.indexOf("price_gone") !== -1);
    check("active plan formats price + interval", html.body.indexOf("$19.99 / month") !== -1);
    check("trial surfaced as a pill",            html.body.indexOf("14d trial") !== -1);
    check("archived plan shows archived pill",   html.body.indexOf(">archived<") !== -1);
    check("nav includes Subscriptions",          html.body.indexOf("\"/admin/subscription-plans\"") !== -1);
    var api = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans", headers: bearer });
    check("plans API still JSON",                (api.headers["content-type"] || "").indexOf("application/json") === 0);
    check("plans API returns rows",              JSON.parse(api.body).rows.length === 2);

    // Active filter shows only the live plan; archived filter only the retired one.
    var act = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans?active=1", jar: jar });
    check("active filter shows the live plan",   act.body.indexOf("price_keep") !== -1);
    check("active filter hides the archived",    act.body.indexOf("price_gone") === -1);
    var arc = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans?active=0", jar: jar });
    check("archived filter shows the retired",   arc.body.indexOf("price_gone") !== -1);
    check("archived filter hides the live",      arc.body.indexOf("price_keep") === -1);

    // Create a plan via the browser form → PRG, plan persists.
    var create = await helpers.httpRequest({
      port: port, path: "/admin/subscription-plans", method: "POST", jar: jar,
      form: { stripe_price_id: "price_new", interval: "month", interval_count: "3", currency: "USD", amount_minor: "4999", trial_days: "0" },
    });
    check("create plan then 303",                create.status === 303);
    var afterCreate = await subs.plans.list({});
    check("plan persisted (3 total)",            afterCreate.length === 3);
    var made = afterCreate.filter(function (p) { return p.stripe_price_id === "price_new"; })[0];
    check("new plan stored currency lowercase",  made && made.currency === "usd");
    check("new plan stored interval_count",      made && made.interval_count === 3);

    // A bad-shape create (zero amount) re-renders the form with the
    // validator's message, not a 500.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/subscription-plans", method: "POST", jar: jar,
      form: { stripe_price_id: "price_bad", interval: "month", currency: "USD", amount_minor: "0" },
    });
    check("bad create then 400",                 bad.status === 400);
    check("bad create surfaces validator msg",   bad.body.indexOf("amount_minor") !== -1);
    check("bad create did not persist",          (await subs.plans.list({})).length === 3);

    // Archive the live plan via the row form → PRG, plan goes inactive.
    var archive = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans/" + keep.id + "/archive", method: "POST", jar: jar });
    check("archive then 303",                    archive.status === 303);
    check("plan now inactive",                   (await subs.plans.get(keep.id)).active === 0);

    // Bearer create still returns JSON (API unchanged).
    var apiCreate = await helpers.httpRequest({
      port: port, path: "/admin/subscription-plans", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ stripe_price_id: "price_api", interval: "week", currency: "usd", amount_minor: 500 }),
    });
    check("bearer create returns 201 JSON",      apiCreate.status === 201 && (apiCreate.headers["content-type"] || "").indexOf("application/json") === 0);

    // Archive a non-existent plan (stale/tampered form) → err flag, not a
    // false "archived" success.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans/00000000-0000-7000-8000-000000000000/archive", method: "POST", jar: jar });
    check("unknown-plan archive then 303",       miss.status === 303);
    check("unknown-plan flags err not archived", (miss.headers.location || "").indexOf("err=1") !== -1);

    // No payment handle wired here, so the Stripe-backed cancel route is
    // not mounted — a POST to it is a 404 (feature unavailable), never a
    // misleading 400 from dereferencing a null payment. Plan CRUD above
    // needed no Stripe and worked.
    var cancel = await helpers.httpRequest({ port: port, path: "/admin/subscriptions/00000000-0000-7000-8000-000000000000/cancel", method: "POST", headers: bearer });
    check("cancel route unmounted without Stripe", cancel.status === 404);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans" });
    check("anon plans → login form",             anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
