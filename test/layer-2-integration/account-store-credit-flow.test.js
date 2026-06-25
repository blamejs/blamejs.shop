"use strict";
/**
 * Customer store-credit wallet — HTTP integration of the read-only
 * /account/credit surface.
 *
 * Boots one real `b.createApp` storefront against an in-memory
 * `node:sqlite` DB loaded from the live store-credit migration, wires the
 * SAME store-credit primitive the admin customer-detail screen grants
 * against, and exercises the customer-facing wallet:
 *
 *   - a customer granted credit (with an expiry) sees the formatted
 *     balance, the ledger entry, AND the expiring-soon callout;
 *   - the Accept: application/json path returns the balance + ledger
 *     payload (same session customer);
 *   - a customer with NO credit sees a clean empty-state 200 (no error);
 *   - an unauthenticated request is bounced to login (303), never a 200
 *     with another customer's data;
 *   - two different signed-in customers each see only THEIR own balance
 *     (the route reads the SESSION customer id — no `:id` param, no IDOR);
 *   - no response body leaks a raw error / stack.
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

var MIGS = ["0006_customers.sql", "0094_store_credit.sql",
  "0235_store_credit_ledger_chain.sql", "0236_store_credit_ledger_chain_fence.sql"]
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
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _bootStorefront(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-credit-sf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

function _noLeak(body) {
  return body.indexOf("at Object.") === -1 &&
         body.indexOf("TypeError") === -1 &&
         body.indexOf("    at ") === -1;
}

async function _run() {
  var query       = _makeQuery();
  var catalog     = bShop.catalog.create({ query: query });
  var cart        = bShop.cart.create({ query: query, catalog: catalog });
  var customers   = bShop.customers.create({ query: query });
  // The SAME store-credit primitive the admin customer-detail screen uses
  // to grant/deduct — the storefront only reads through it.
  var storeCredit = bShop.storeCredit.create({ query: query });

  // Two customers: one funded (with an expiring grant + a spent debit),
  // one with an empty wallet. Real customer rows so the /account
  // dashboard (where the wallet link lives) renders.
  var funded = b.uuid.v7();
  var empty  = b.uuid.v7();
  var nowTs  = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [funded, "hash-funded-" + funded, "Funded Shopper", nowTs],
  );
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [empty, "hash-empty-" + empty, "Empty Shopper", nowTs],
  );

  // Grant: $50 goodwill that expires in ~10 days (inside the 30-day
  // warning window) with an operator-authored reason, plus $20 refund
  // (no expiry). Then a $15 debit against an order so the ledger carries
  // all three kinds.
  var orderRef = b.uuid.v7();
  await storeCredit.credit({
    customer_id:  funded,
    amount_minor: 5000,
    source:       "goodwill",
    source_ref:   "Sorry about the delay <reason & test>",
    expires_at:   Date.now() + (10 * 86400 * 1000),
  });
  await storeCredit.credit({
    customer_id:  funded,
    amount_minor: 2000,
    source:       "refund",
    source_ref:   "RF-1001",
  });
  await storeCredit.debit({
    customer_id:  funded,
    amount_minor: 1500,
    order_id:     orderRef,
  });
  // Net balance: 5000 + 2000 - 1500 = 5500 minor = $55.00.

  var sf = await _bootStorefront({
    catalog: catalog, cart: cart, customers: customers,
    storeCredit: storeCredit, shop_name: "Credit Shop",
  });

  try {
    var fundedJar = helpers.cookieJar();
    fundedJar.capture({ "set-cookie": [helpers.authCookie(b, funded)] });
    var emptyJar = helpers.cookieJar();
    emptyJar.capture({ "set-cookie": [helpers.authCookie(b, empty)] });

    // ---- dashboard link reachability ----------------------------------
    var dash = await helpers.httpRequest({ port: sf.port, path: "/account", jar: fundedJar });
    check("account dashboard → 200",            dash.status === 200);
    check("dashboard links to /account/credit", dash.body.indexOf("/account/credit") !== -1);

    // ---- funded wallet page: balance + ledger + expiring callout ------
    var page = await helpers.httpRequest({ port: sf.port, path: "/account/credit", jar: fundedJar });
    check("funded wallet → 200",                page.status === 200);
    check("funded wallet shows the balance",    page.body.indexOf("$55.00") !== -1);
    check("funded wallet shows expiring callout", page.body.indexOf("expires soon") !== -1);
    check("funded wallet shows a credit row",   page.body.indexOf("store-credit-tx--credit") !== -1);
    check("funded wallet shows a debit row",    page.body.indexOf("store-credit-tx--debit") !== -1);
    check("funded wallet shows the +amount",    page.body.indexOf("+$50.00") !== -1);
    check("funded wallet shows the −amount",    page.body.indexOf("−$15.00") !== -1);
    // The operator-authored reason is rendered ESCAPED (the `&` / `<` / `>`
    // become entities; the raw markup never reaches the page).
    check("reason rendered escaped",            page.body.indexOf("reason &amp; test") !== -1 &&
                                                page.body.indexOf("<reason & test>") === -1);
    check("funded wallet leaks no raw error",   _noLeak(page.body));

    // ---- bearer JSON path: balance + ledger payload -------------------
    var json = await helpers.httpRequest({
      port: sf.port, path: "/account/credit", jar: fundedJar,
      headers: { accept: "application/json" },
    });
    check("JSON wallet → 200",                  json.status === 200);
    check("JSON content-type",                  (json.headers["content-type"] || "").indexOf("application/json") !== -1);
    var payload = JSON.parse(json.body);
    check("JSON balance_minor is 5500",         payload.balance_minor === 5500);
    check("JSON carries the ledger",            Array.isArray(payload.ledger) && payload.ledger.length === 3);
    check("JSON carries the expiring set",      Array.isArray(payload.expiring) && payload.expiring.length >= 1);
    check("JSON leaks no raw error",            _noLeak(json.body));

    // ---- empty wallet: clean empty-state 200, no error ----------------
    var emptyPage = await helpers.httpRequest({ port: sf.port, path: "/account/credit", jar: emptyJar });
    check("empty wallet → 200",                 emptyPage.status === 200);
    check("empty wallet shows $0.00",           emptyPage.body.indexOf("$0.00") !== -1);
    check("empty wallet shows empty state",     emptyPage.body.indexOf("No store credit yet") !== -1);
    check("empty wallet no expiring callout",   emptyPage.body.indexOf("expires soon") === -1);
    check("empty wallet leaks no raw error",    _noLeak(emptyPage.body));

    var emptyJson = await helpers.httpRequest({
      port: sf.port, path: "/account/credit", jar: emptyJar,
      headers: { accept: "application/json" },
    });
    var emptyPayload = JSON.parse(emptyJson.body);
    check("empty wallet JSON balance is 0",     emptyPayload.balance_minor === 0);
    check("empty wallet JSON ledger empty",     Array.isArray(emptyPayload.ledger) && emptyPayload.ledger.length === 0);

    // ---- session-scoped: each customer sees only THEIR balance --------
    // The funded customer's session never leaks into the empty customer's
    // view and vice-versa — the route keys on the session customer id,
    // there is no `:id` param to point at someone else.
    check("empty session never sees $55.00",    emptyPage.body.indexOf("$55.00") === -1);
    check("funded session never sees only $0",  page.body.indexOf("No store credit yet") === -1);

    // ---- unauthenticated → login, never another customer's data -------
    var anonJar = helpers.cookieJar();
    var anon = await helpers.httpRequest({ port: sf.port, path: "/account/credit", jar: anonJar });
    check("anon wallet → 303 login",            anon.status === 303 &&
      (anon.headers["location"] || "") === "/account/login");
    check("anon wallet body carries no balance", anon.body.indexOf("$55.00") === -1);
  } finally {
    await _teardown(sf);
  }
}

module.exports = { run: _run };
