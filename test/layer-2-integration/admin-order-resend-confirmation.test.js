"use strict";
/**
 * Admin order detail — "Resend confirmation" action.
 *
 * The original order-confirmation receipt is sent by the payment provider
 * at confirm time using the plaintext address the buyer typed; that address
 * is never persisted (the order row keeps only `customer_email_hash`). A
 * one-way hash can't be reversed into a deliverable address, so the resend
 * action takes the recipient the OPERATOR supplies and sends a fresh receipt
 * rendered from the stored order totals.
 *
 * Boots b.createApp with admin.mount wired to a recording fake mailer (the
 * lib/email.js factory shape — `.orderReceipt({ order, customer })`), seeds a
 * paid order, then drives:
 *
 *   - the detail renders the resend panel with a recipient field
 *   - a resend with a valid recipient sends ONE receipt to that address +
 *     PRGs with ?resent=1 + records a shop_admin.order.receipt.resend audit row
 *   - the receipt greets the linked customer's display name + carries the
 *     order id (rendered from the stored order, not a reconstructed address)
 *   - a blank / malformed recipient is a clean redirect to ?resend_err=email
 *     (browser) / 400 (bearer JSON) with no send
 *   - the per-order hourly cap refuses the 4th send (?resend_err=rate / 429)
 *   - with NO mailer wired the panel renders a disabled note + the route 404s
 *   - anon -> the sign-in form, never a send
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

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql", "0006_customers.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
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

// A recording fake mailer matching the lib/email.js factory surface the
// resend action calls — `.orderReceipt({ order, customer })`.
function _fakeMailer() {
  var sent = [];
  return {
    sent: sent,
    orderReceipt: async function (input) {
      sent.push({ order: input.order, customer: input.customer });
      return { ok: true, id: "msg_" + sent.length };
    },
  };
}

// Seed a paid order for a linked customer so the receipt can greet them.
async function _seedOrder(query, order, customerId) {
  var cartId = b.uuid.v7();
  var sessionId = b.uuid.v7();
  var now = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionId, customerId, now, now + 86400000],
  );
  return order.createFromCart({
    cart_id:           cartId,
    session_id:        sessionId,
    customer_id:       customerId,
    lines:             [{ variant_id: b.uuid.v7(), sku: "SKU-1", qty: 1, unit_amount_minor: 4200 }],
    currency:          "USD",
    subtotal_minor:    4200,
    discount_minor:    0,
    tax_minor:         300,
    shipping_minor:    500,
    grand_total_minor: 5000,
    ship_to:           { country: "US" },
  });
}

async function _boot(opts) {
  opts = opts || {};
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var order     = bShop.order.create({ query: query, cursorSecret: "resend-order" });
  var config    = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query, cursorSecret: "resend-customers" });

  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Anderson" });
  var ord = await _seedOrder(query, order, alice.id);

  var mailer = opts.noMailer ? null : _fakeMailer();
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-resend-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      var deps = {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        customers: customers,
      };
      if (mailer) deps.mailer = mailer;
      bShop.admin.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir, mailer: mailer, order: ord };
}

async function _run() {
  // ---- mailer wired: the happy path + validation + rate-bound ----------
  var env = await _boot({});
  var port = env.port;
  var orderId = env.order.id;
  var enc = encodeURIComponent(orderId);
  var bearer = { authorization: "Bearer " + TOKEN };

  // Spy on b.audit.safeEmit so the resend-event assertion is deterministic
  // and touches no DB / chain read path (which is fragile across the
  // shared-process smoke ordering). Every admin mutation — including this
  // route — records via safeEmit, so the spy sees the resend row.
  var auditCaptured = [];
  var _origSafeEmit = b.audit.safeEmit;
  b.audit.safeEmit = function (ev) { auditCaptured.push(ev); return _origSafeEmit.apply(this, arguments); };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // Detail renders the resend panel with a recipient field.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/orders/" + enc, jar: jar });
    check("order detail 200", detail.status === 200);
    check("resend panel present", detail.body.indexOf("Resend confirmation") !== -1);
    check("resend field present", detail.body.indexOf("name=\"email\"") !== -1);
    check("resend posts to the route", detail.body.indexOf("action=\"/admin/orders/" + orderId + "/resend-confirmation\"") !== -1);

    // A valid recipient sends one receipt + PRGs + records an audit row.
    var resend = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST", jar: jar,
      form: { email: "support-supplied@example.com" },
    });
    check("resend then 303", resend.status === 303);
    check("resend redirects ?resent=1", (resend.headers.location || "").indexOf("resent=1") !== -1);
    check("exactly one receipt sent", env.mailer.sent.length === 1);
    check("receipt went to the operator-supplied address", env.mailer.sent[0].customer.email === "support-supplied@example.com");
    check("receipt greets the linked customer name", env.mailer.sent[0].customer.name === "Alice Anderson");
    check("receipt renders from the stored order", env.mailer.sent[0].order.id === orderId);

    // The resend was audited (without the recipient PII). The spy captured
    // the safeEmit the route fired.
    var mine = auditCaptured.filter(function (r) {
      return r.action === "shop_admin.order.receipt.resend" && r.metadata && r.metadata.id === orderId;
    });
    check("resend recorded an audit row", mine.length === 1);
    check("audit row carries no recipient", JSON.stringify(mine[0].metadata).indexOf("support-supplied@example.com") === -1);

    // A blank recipient -> clean redirect to ?resend_err=email, no send.
    var blank = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST", jar: jar,
      form: { email: "" },
    });
    check("blank recipient then 303", blank.status === 303);
    check("blank -> resend_err=email", (blank.headers.location || "").indexOf("resend_err=email") !== -1);
    check("blank sent nothing", env.mailer.sent.length === 1);

    // A malformed recipient on the bearer JSON path -> 400, no send.
    var badJson = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    check("bad bearer recipient then 400", badJson.status === 400);
    check("bad bearer body has no stack frame", !/\n\s+at\s+\S+\s*\(/.test(badJson.body));
    check("bad bearer sent nothing", env.mailer.sent.length === 1);

    // The detail page surfaces the email-error banner.
    var afterErr = await helpers.httpRequest({ port: port, path: "/admin/orders/" + enc + "?resend_err=email", jar: jar });
    check("detail shows the email-error banner", afterErr.body.indexOf("valid recipient email") !== -1);

    // ---- per-order hourly cap: 3 succeed, the 4th is refused -----------
    // One send already landed above; two more take us to the cap of 3.
    var r2 = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST", jar: jar,
      form: { email: "again@example.com" },
    });
    check("2nd resend 303", r2.status === 303 && (r2.headers.location || "").indexOf("resent=1") !== -1);
    var r3 = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST", jar: jar,
      form: { email: "again2@example.com" },
    });
    check("3rd resend 303", r3.status === 303 && (r3.headers.location || "").indexOf("resent=1") !== -1);
    check("three receipts sent total", env.mailer.sent.length === 3);

    // The 4th within the hour is refused — browser path -> ?resend_err=rate.
    var r4 = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST", jar: jar,
      form: { email: "again3@example.com" },
    });
    check("4th resend then 303", r4.status === 303);
    check("4th -> resend_err=rate", (r4.headers.location || "").indexOf("resend_err=rate") !== -1);
    check("rate-limited send did not fire", env.mailer.sent.length === 3);

    // Bearer JSON path of the cap is a 429.
    var r5 = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ email: "again4@example.com" }),
    });
    check("bearer over-cap then 429", r5.status === 429);
    check("bearer rate-limited sent nothing more", env.mailer.sent.length === 3);

    // Anon -> the sign-in form, never a send.
    var anon = await helpers.httpRequest({
      port: port, path: "/admin/orders/" + enc + "/resend-confirmation", method: "POST",
      form: { email: "anon@example.com" },
    });
    check("anon resend -> redirect to /admin", anon.status === 303 && (anon.headers.location || "").indexOf("/admin") !== -1);
    check("anon sent nothing", env.mailer.sent.length === 3);
  } finally {
    try { b.audit.safeEmit = _origSafeEmit; } catch (_e) { /* */ }
    try { await env.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(env.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }

  // ---- no mailer wired: disabled note + the route 404s -----------------
  var env2 = await _boot({ noMailer: true });
  try {
    var jar2 = helpers.cookieJar();
    await helpers.httpRequest({ port: env2.port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar2 });
    var enc2 = encodeURIComponent(env2.order.id);
    var detail2 = await helpers.httpRequest({ port: env2.port, path: "/admin/orders/" + enc2, jar: jar2 });
    check("no-mailer detail 200", detail2.status === 200);
    check("no-mailer shows a disabled note", detail2.body.indexOf("Email isn't configured") !== -1);
    check("no-mailer has no resend form", detail2.body.indexOf("/resend-confirmation\"") === -1);
    // The route was never mounted -> a POST falls through to a non-2xx.
    var post2 = await helpers.httpRequest({
      port: env2.port, path: "/admin/orders/" + enc2 + "/resend-confirmation", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ email: "x@example.com" }),
    });
    check("no-mailer route unmounted -> 404", post2.status === 404);
  } finally {
    try { await env2.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(env2.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
