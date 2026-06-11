"use strict";
/**
 * Gift-card currency — issuing must validate the currency against the
 * ISO 4217 code set, not just its 3-uppercase-letter shape.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * giftcards) and POSTs /admin/gift-cards with a well-formed-but-nonexistent
 * code ("ZZZ"). The fix composes the framework's ISO 4217 catalog
 * (b.money.CURRENCIES, the same surface the currency-rounding + display
 * primitives use) and refuses unknown codes:
 *
 *   - bearer JSON  → 400 bad-request (via _wrap), NO card issued.
 *   - cookie form  → the issue form re-renders with a notice, NO card,
 *                    never a 201/redirect-to-detail.
 *
 * A real ISO code (USD) still issues, proving the gate only rejects the
 * non-existent code.
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

var TOKEN = "admin-token-0123456789abcdef-gciso";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0013_giftcards.sql", "0081_gift_card_ledger.sql", "0220_gift_card_ledger_chain.sql",
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "gciso" });
  var config  = bShop.config.create({ query: query });
  var giftcards = bShop.giftcards.create({ query: query });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-gciso-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, giftcards: giftcards, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // ---- bearer JSON: non-ISO currency → 400, no card issued ----
    var bearerBad = await helpers.httpRequest({
      port: port, path: "/admin/gift-cards", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount_minor: 5000, currency: "ZZZ" }),
    });
    check("non-ISO currency → 400 (not 201)", bearerBad.status === 400);
    check("400 detail names ISO 4217",        bearerBad.body.indexOf("ISO 4217") !== -1);
    var afterBad = await giftcards.list({});
    check("no card issued for non-ISO currency", afterBad.length === 0);

    // ---- cookie form: non-ISO currency → re-rendered notice, no card ----
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);
    var cookieBad = await helpers.httpRequest({
      port: port, path: "/admin/gift-cards", method: "POST", jar: jar,
      form: { amount_minor: "5000", currency: "ZZZ" },
    });
    check("cookie non-ISO currency → 400 page (not 303 to detail)", cookieBad.status === 400);
    check("cookie 400 page carries the notice", cookieBad.body.indexOf("ISO 4217") !== -1);
    check("still no card issued", (await giftcards.list({})).length === 0);

    // ---- a real ISO code still issues ----
    var ok = await helpers.httpRequest({
      port: port, path: "/admin/gift-cards", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount_minor: 5000, currency: "USD" }),
    });
    check("USD gift card → 201", ok.status === 201);
    var issued = JSON.parse(ok.body);
    check("USD card has a code", typeof issued.code === "string" && issued.code.length >= 16);
    check("one card issued", (await giftcards.list({})).length === 1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
