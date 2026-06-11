"use strict";
/**
 * Subscription-plan edit console — the browser-side detail + edit
 * screen.
 *
 * Boots b.createApp with admin.mount wired to the subscriptions
 * primitive, seeds a standalone monthly plan, then drives the detail
 * screen (GET /admin/subscription-plans/:id — now content-negotiated,
 * previously bearer-JSON-only) and the edit path
 * (POST /admin/subscription-plans/:id/edit, browser + bearer JSON). The
 * edit changes the AMOUNT, the INTERVAL COUNT, and the TRIAL DAYS — the
 * mutable columns subscriptions.plans.update accepts that the console
 * previously had no browser form for (edit was API-only). Asserts the
 * change persisted via plans.get, the immutable Stripe-bound columns are
 * untouched, a bad value is a clean 4xx, and the id is preserved. The
 * plan is standalone, so no Stripe round-trip happens. Network: zero.
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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql", "0009_subscriptions.sql"]
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
  var order   = bShop.order.create({ query: query, cursorSecret: "subs-plan-edit" });
  var config  = bShop.config.create({ query: query });
  var subs    = bShop.subscriptions.create({ query: query });

  // Seed a standalone monthly plan (no variant, no Stripe round-trip).
  var plan = await subs.plans.create({
    stripe_price_id: "price_mirror", interval: "month", currency: "usd",
    amount_minor: 1999, interval_count: 1, trial_days: 14,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-subs-edit-"));
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
    check("admin login then 303",                login.status === 303);

    // The list now offers an Edit affordance per active plan.
    var list = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans", jar: jar });
    check("list then 200",                       list.status === 200);
    check("list shows an Edit affordance",       list.body.indexOf("/admin/subscription-plans/" + plan.id + "\">Edit") !== -1);

    // Detail screen (previously bearer-JSON-only) now renders for the
    // browser session, with the edit form prefilled.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans/" + plan.id, jar: jar });
    check("detail then 200 (was JSON-only)",     detail.status === 200);
    check("detail is HTML for the browser",      (detail.headers["content-type"] || "").indexOf("text/html") === 0);
    check("detail prefills the amount",          detail.body.indexOf("name=\"amount_minor\" value=\"1999\"") !== -1);
    check("detail prefills the trial days",      detail.body.indexOf("name=\"trial_days\" value=\"14\"") !== -1);
    check("detail shows the immutable price id", detail.body.indexOf("price_mirror") !== -1);
    check("detail posts to the edit route",      detail.body.indexOf("/admin/subscription-plans/" + plan.id + "/edit") !== -1);

    // Edit the AMOUNT + INTERVAL COUNT + TRIAL (the mutable columns the
    // console had no browser form for) → PRG to ?updated, change persists.
    var edit = await helpers.httpRequest({
      port: port, path: "/admin/subscription-plans/" + plan.id + "/edit", method: "POST", jar: jar,
      form: { amount_minor: "2499", interval_count: "3", trial_days: "30", variant_id: "", active_present: "1", active: "on" },
    });
    check("plan edit then 303",                  edit.status === 303);
    check("plan edit redirects ?updated",        (edit.headers.location || "").indexOf("updated=1") !== -1);
    var after = await subs.plans.get(plan.id);
    check("amount changed to 2499",              after.amount_minor === 2499);
    check("interval_count changed to 3",         after.interval_count === 3);
    check("trial_days changed to 30",            after.trial_days === 30);
    check("plan id preserved",                   after.id === plan.id);

    // The immutable Stripe-bound columns are untouched by the edit.
    check("stripe_price_id immutable",           after.stripe_price_id === "price_mirror");
    check("interval immutable",                  after.interval === "month");
    check("currency immutable",                  after.currency === "usd");

    // The ?updated detail render shows the ok banner, no raw error leak.
    var afterPage = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans/" + plan.id + "?updated=1", jar: jar });
    check("updated banner shown",                afterPage.body.indexOf("Plan updated.") !== -1);
    check("no raw error text on the page",       afterPage.body.indexOf("subscriptions.plans.update") === -1);

    // Bearer JSON edit returns 200 JSON (the API path through /edit).
    var apiEdit = await helpers.httpRequest({
      port: port, path: "/admin/subscription-plans/" + plan.id + "/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount_minor: "3999" }),
    });
    check("bearer plan edit 200 JSON",           apiEdit.status === 200 && (apiEdit.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer plan edit persisted",          (await subs.plans.get(plan.id)).amount_minor === 3999);

    // Bad value (zero amount) is a clean 4xx, never a 500 or partial write.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/subscription-plans/" + plan.id + "/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount_minor: "0" }),
    });
    check("bad amount then 4xx",                  bad.status >= 400 && bad.status < 500);
    check("bad edit did not persist",             (await subs.plans.get(plan.id)).amount_minor === 3999);

    // Unknown id via the browser → err notice redirect, never a 500.
    var miss = await helpers.httpRequest({
      port: port, path: "/admin/subscription-plans/00000000-0000-7000-8000-000000000000/edit", method: "POST", jar: jar,
      form: { amount_minor: "100", active_present: "1" },
    });
    check("unknown-id edit then 303",            miss.status === 303);
    check("unknown-id flags err",                (miss.headers.location || "").indexOf("err=1") !== -1);

    // Detail JSON over bearer is unchanged for tooling.
    var apiGet = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans/" + plan.id, headers: bearer });
    check("detail API still JSON for bearer",     (apiGet.headers["content-type"] || "").indexOf("application/json") === 0);
    check("detail API returns the plan",          JSON.parse(apiGet.body).id === plan.id);

    // Anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/subscription-plans/" + plan.id });
    check("anon detail → login form",            anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
