"use strict";
/**
 * Inventory moderation console — browser-side admin inventory screen.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config),
 * seeds a few inventory rows (one below its low-stock threshold), and
 * exercises the queue (HTML + JSON), the low-stock filter, the restock +
 * threshold row form, the track-new-SKU form, the bearer JSON contract, and
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
var MIGS = ["0001_catalog.sql", "0008_inventory_thresholds.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql"]
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
  var order   = bShop.order.create({ query: query, cursorSecret: "inv-console" });
  var config  = bShop.config.create({ query: query });

  // Seed: a healthy SKU and a low one (threshold 10, on-hand 3).
  await catalog.inventory.create("WIDGET-1", { stock_on_hand: 100 });
  await catalog.inventory.create("WIDGET-LOW", { stock_on_hand: 3 });
  await catalog.inventory.setThreshold("WIDGET-LOW", 10);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-inv-"));
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
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",              login.status === 303);

    // List: HTML for the browser, JSON for the bearer token.
    var html = await helpers.httpRequest({ port: port, path: "/admin/inventory", jar: jar });
    check("inventory page then 200",           html.status === 200);
    check("inventory shows both SKUs",          html.body.indexOf("WIDGET-1") !== -1 && html.body.indexOf("WIDGET-LOW") !== -1);
    check("low SKU flagged low",                html.body.indexOf("row--low") !== -1);
    check("nav includes Inventory",             html.body.indexOf("\"/admin/inventory\"") !== -1);
    var api = await helpers.httpRequest({ port: port, path: "/admin/inventory", headers: bearer });
    check("inventory API still JSON",            (api.headers["content-type"] || "").indexOf("application/json") === 0);
    check("inventory API returns rows",          JSON.parse(api.body).rows.length === 2);

    // Low-stock filter shows only the low SKU.
    var low = await helpers.httpRequest({ port: port, path: "/admin/inventory?low=1", jar: jar });
    check("low filter shows the low SKU",        low.body.indexOf("WIDGET-LOW") !== -1);
    check("low filter hides the healthy SKU",    low.body.indexOf("WIDGET-1") === -1);

    // Restock via the browser row form → PRG, stock increases.
    var restock = await helpers.httpRequest({ port: port, path: "/admin/inventory/WIDGET-1/restock", method: "POST", jar: jar, form: { qty: "25" } });
    check("restock then 303",                  restock.status === 303);
    check("stock increased",                   (await catalog.inventory.get("WIDGET-1")).stock_on_hand === 125);

    // Set threshold via the same row form (qty blank, threshold given).
    await helpers.httpRequest({ port: port, path: "/admin/inventory/WIDGET-1/restock", method: "POST", jar: jar, form: { qty: "", threshold: "20" } });
    check("threshold set via row form",        (await catalog.inventory.get("WIDGET-1")).low_stock_threshold === 20);

    // Track a new SKU via the create form.
    var create = await helpers.httpRequest({ port: port, path: "/admin/inventory", method: "POST", jar: jar, form: { sku: "WIDGET-NEW", stock_on_hand: "50" } });
    check("create SKU then 303",               create.status === 303);
    check("new SKU tracked",                   (await catalog.inventory.get("WIDGET-NEW")).stock_on_hand === 50);

    // Bearer restock still returns JSON (API unchanged).
    var apiRestock = await helpers.httpRequest({ port: port, path: "/admin/inventory/WIDGET-LOW/restock", method: "POST", headers: bearer, form: { qty: "5" } });
    check("bearer restock returns JSON",         (apiRestock.headers["content-type"] || "").indexOf("application/json") === 0 && JSON.parse(apiRestock.body).stock_on_hand === 8);

    // Restock a non-existent SKU (stale/tampered form) → err flag, not a
    // false "updated" success.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/inventory/NOPE-404/restock", method: "POST", jar: jar, form: { qty: "5" } });
    check("unknown-SKU restock then 303",      miss.status === 303);
    check("unknown-SKU flags err not updated",  (miss.headers.location || "").indexOf("err=1") !== -1);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/inventory" });
    check("anon inventory → login form",        anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
