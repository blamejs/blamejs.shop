"use strict";
/**
 * Shipping-zone edit — a malformed regions_json / rates_json paste must
 * degrade to a clean 400 (bearer) / a re-rendered notice (cookie), never
 * a 500 that echoes the JSON parser's position.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * shippingZones), seeds a zone, then POSTs /admin/shipping/:slug/edit with
 * a regions_json / rates_json field that doesn't parse, over BOTH surfaces:
 *
 *   - bearer JSON  → 400 bad-request (via _wrap, from the call-site
 *                    TypeError), body names neither "JSON at position" nor
 *                    a file path.
 *   - cookie form  → the edit redirect carries ?err=1 (the htmlHandler's
 *                    TypeError catch), never a 500.
 *
 * A well-formed rates_json edit still succeeds, proving the guard only
 * rejects the un-parseable paste.
 *
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

var TOKEN = "admin-token-0123456789abcdef-shipjson";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0106_shipping_zones.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

function _noLeak(label, body) {
  var lower = String(body).toLowerCase();
  check(label + ": no 'json at position'",      lower.indexOf("json at position") === -1);
  check(label + ": no parser 'expected ...'",   lower.indexOf("expected property name") === -1);
  check(label + ": no file path",               lower.indexOf(".js:") === -1 && lower.indexOf("\\lib\\") === -1 && lower.indexOf("/lib/") === -1);
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "shipjson" });
  var config  = bShop.config.create({ query: query });
  var shippingZones = bShop.shippingZones.create({ query: query });

  await shippingZones.defineZone({
    slug: "domestic-us", title: "Domestic (US)", active: true,
    regions: [{ country: "US" }],
    rates: [{ rate_minor: 500, currency: "USD", service_label: "Standard" }],
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shipjson-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config, shop_name: "Test Shop",
        shippingZones: shippingZones,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // ---- bearer JSON: malformed regions_json → 400, no parser leak ----
    var bearerBad = await helpers.httpRequest({
      port: port, path: "/admin/shipping/domestic-us/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ regions_json: "{notjson" }),
    });
    check("bearer malformed regions_json → 400 (not 500)", bearerBad.status === 400);
    check("bearer 400 detail names the offending field",
      bearerBad.body.indexOf("regions_json") !== -1);
    _noLeak("bearer regions_json", bearerBad.body);

    // ---- bearer JSON: malformed rates_json → 400, no parser leak ----
    var bearerRates = await helpers.httpRequest({
      port: port, path: "/admin/shipping/domestic-us/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ rates_json: "[{oops" }),
    });
    check("bearer malformed rates_json → 400 (not 500)", bearerRates.status === 400);
    check("bearer 400 detail names the offending field",
      bearerRates.body.indexOf("rates_json") !== -1);
    _noLeak("bearer rates_json", bearerRates.body);

    // The zone is unchanged — a rejected edit didn't partially mutate it.
    var afterBad = await shippingZones.getZone("domestic-us");
    check("rejected edit left the zone unchanged",
      afterBad.rates[0].rate_minor === 500 && afterBad.regions[0].country === "US");

    // ---- cookie form: malformed regions_json → ?err=1 redirect, no 500 ----
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);
    var cookieBad = await helpers.httpRequest({
      port: port, path: "/admin/shipping/domestic-us/edit", method: "POST", jar: jar,
      form: { title: "Renamed", regions_json: "{notjson" },
    });
    check("cookie malformed regions_json → 303 (not 500)", cookieBad.status === 303);
    check("cookie malformed regions_json flags err",
      (cookieBad.headers.location || "").indexOf("err=1") !== -1);

    // ---- well-formed rates_json still applies ----
    var goodEdit = await helpers.httpRequest({
      port: port, path: "/admin/shipping/domestic-us/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ rates_json: "[{\"rate_minor\":700,\"currency\":\"USD\",\"service_label\":\"Ground\"}]" }),
    });
    check("well-formed rates_json edit → 200", goodEdit.status === 200);
    var edited = await shippingZones.getZone("domestic-us");
    check("well-formed rates_json applied", edited.rates[0].rate_minor === 700);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
