"use strict";
/**
 * Webhooks console — browser-side admin endpoint management.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * webhooks) and exercises endpoint create (with the one-time secret
 * reveal), the list (HTML omits the secret; bearer JSON keeps it), https
 * + event validation, enable/disable, the deliveries view, retry of an
 * unknown delivery, and delete. A transport stub keeps retry offline.
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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql", "0005_webhooks.sql", "0017_webhook_dlq.sql"]
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
  var order   = bShop.order.create({ query: query, cursorSecret: "wh-console" });
  var config  = bShop.config.create({ query: query });
  // Offline transport so a retry never touches the network.
  var webhooks = bShop.webhooks.create({ query: query, transport: async function () { return { status: 200 }; } });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-wh-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, webhooks: webhooks, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // Create an endpoint via the browser form → one-time secret reveal.
    var create = await helpers.httpRequest({
      port: port, path: "/admin/webhooks", method: "POST", jar: jar,
      form: { url: "https://hooks.example.com/in", events_all: "on" },
    });
    check("create endpoint then 200 reveal",     create.status === 200);
    check("reveal warns secret shown once",      create.body.indexOf("shown once") !== -1);

    // Bearer list still returns JSON and (by the existing API contract)
    // includes the secret — that's the value we assert is NOT in the HTML.
    var api = await helpers.httpRequest({ port: port, path: "/admin/webhooks", headers: bearer });
    check("webhooks API still JSON",             (api.headers["content-type"] || "").indexOf("application/json") === 0);
    var apiRows = JSON.parse(api.body).rows;
    check("webhooks API returns the endpoint",   apiRows.length === 1 && apiRows[0].url === "https://hooks.example.com/in");
    var secret = apiRows[0].secret;
    var endpointId = apiRows[0].id;
    check("secret present in API + on reveal",    !!secret && create.body.indexOf(secret) !== -1);

    // The HTML list shows the endpoint but never the signing secret.
    var html = await helpers.httpRequest({ port: port, path: "/admin/webhooks", jar: jar });
    check("list page then 200",                  html.status === 200);
    check("list shows the endpoint URL",         html.body.indexOf("hooks.example.com/in") !== -1);
    check("list shows all-events label",         html.body.indexOf("all events") !== -1);
    check("list NEVER shows the secret",         html.body.indexOf(secret) === -1);
    check("nav includes Webhooks",               html.body.indexOf("\"/admin/webhooks\"") !== -1);

    // Validation: http:// is refused, and an empty event set is refused —
    // both re-render the form with the validator's message, not a 500.
    var badUrl = await helpers.httpRequest({
      port: port, path: "/admin/webhooks", method: "POST", jar: jar,
      form: { url: "http://insecure.example.com", events_all: "on" },
    });
    check("http:// endpoint then 400",           badUrl.status === 400);
    check("http:// surfaces https-only msg",     badUrl.body.toLowerCase().indexOf("https") !== -1);
    var noEvents = await helpers.httpRequest({
      port: port, path: "/admin/webhooks", method: "POST", jar: jar,
      form: { url: "https://hooks.example.com/two" },
    });
    check("no-events endpoint then 400",         noEvents.status === 400);
    check("only one endpoint persisted",         JSON.parse((await helpers.httpRequest({ port: port, path: "/admin/webhooks", headers: bearer })).body).rows.length === 1);

    // Toggle active off, then on.
    var off = await helpers.httpRequest({ port: port, path: "/admin/webhooks/" + endpointId + "/toggle", method: "POST", jar: jar });
    check("toggle then 303",                     off.status === 303);
    check("endpoint now disabled",               (await webhooks.endpoints.get(endpointId)).active === 0);
    await helpers.httpRequest({ port: port, path: "/admin/webhooks/" + endpointId + "/toggle", method: "POST", jar: jar });
    check("endpoint re-enabled",                 (await webhooks.endpoints.get(endpointId)).active === 1);

    // Deliveries view (none yet) → 200 with the empty notice.
    var deliv = await helpers.httpRequest({ port: port, path: "/admin/webhooks/" + endpointId + "/deliveries", jar: jar });
    check("deliveries page then 200",            deliv.status === 200);
    check("deliveries shows empty state",        deliv.body.indexOf("No deliveries recorded") !== -1);

    // Retry an unknown delivery (stale/tampered form) → err flag, no 500.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/webhooks/deliveries/00000000-0000-7000-8000-000000000000/retry", method: "POST", jar: jar });
    check("unknown-delivery retry then 303",     miss.status === 303);
    check("unknown-delivery flags err",          (miss.headers.location || "").indexOf("err=1") !== -1);

    // Delete the endpoint via the row form → PRG, gone.
    var del = await helpers.httpRequest({ port: port, path: "/admin/webhooks/" + endpointId + "/delete", method: "POST", jar: jar });
    check("delete then 303",                     del.status === 303);
    check("endpoint removed",                    (await webhooks.endpoints.list()).length === 0);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/webhooks" });
    check("anon webhooks → login form",          anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
