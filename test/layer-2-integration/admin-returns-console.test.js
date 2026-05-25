"use strict";
/**
 * Returns moderation console — full HTTP integration of the browser-side
 * RMA screens in the admin console.
 *
 * Boots a real `b.createApp` server with `admin.mount` wired with a token
 * + catalog + order + config + returns, against one in-memory `node:sqlite`
 * DB. A paid order with a line is seeded, then an RMA is requested so it
 * starts in `pending`. Exercises the queue list (HTML + JSON), the status
 * filter incl. the bad-filter fallback, the detail page's action forms,
 * and the full approve → received → refund walk driven from the browser —
 * plus an illegal action (refused → notice, status unchanged), a bad id
 * (404 page), and the auth gate.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
            "0004_shop_config.sql", "0023_returns.sql"]
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

// Seed a paid order with one line, then request a return (pending).
async function _seedReturn(query, returns) {
  var now = Date.now();
  var cartId = b.uuid.v7(), orderId = b.uuid.v7(), lineId = b.uuid.v7();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, b.uuid.v7(), now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, " +
    "customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 5998, 0, 0, 0, 5998, NULL, '{}', NULL, ?4, ?4)",
    [orderId, cartId, b.uuid.v7(), now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, 'WIDGET-1', 1, 5998, 'USD', 5998)",
    [lineId, orderId, b.uuid.v7()],
  );
  var rma = await returns.request({
    order_id: orderId, reason: "defective",
    customer_notes: "Arrived cracked.",
    lines: [{ sku: "WIDGET-1", qty: 1, order_line_id: lineId }],
  });
  return { orderId: orderId, rmaId: rma.id, rmaCode: rma.rma_code };
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "ret-console" });
  var config  = bShop.config.create({ query: query });
  var returns = bShop.returns.create({ query: query, cursorSecret: "ret-console-rma" });

  var seeded = await _seedReturn(query, returns);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-ret-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        returns: returns, shop_name: "Test Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var rid = seeded.rmaId;

  try {
    // Sign in → sealed admin cookie.
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",              login.status === 303);
    check("admin cookie set",                  !!jar.get("shop_admin"));

    // Queue: HTML for the browser, JSON for the bearer token.
    var queueHtml = await helpers.httpRequest({ port: port, path: "/admin/returns", jar: jar });
    check("returns queue then 200",            queueHtml.status === 200);
    check("queue shows the RMA",                queueHtml.body.indexOf(seeded.rmaCode) !== -1);
    check("queue has status filters",           queueHtml.body.indexOf("order-filters") !== -1);
    var queueApi = await helpers.httpRequest({ port: port, path: "/admin/returns", headers: bearer });
    check("returns queue API still JSON",        (queueApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("queue API returns the pending row",   JSON.parse(queueApi.body).rows.length === 1);

    // Bad status filter falls back to pending with a notice (never a 500).
    var badFilter = await helpers.httpRequest({ port: port, path: "/admin/returns?status=bogus", jar: jar });
    check("bad return filter then 200",        badFilter.status === 200);
    check("bad return filter shows a notice",   badFilter.body.indexOf("Unknown status filter") !== -1);

    // Detail: pending → Approve + Reject forms; JSON for the bearer token.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid, jar: jar });
    check("return detail then 200",            detail.status === 200);
    check("detail shows the reason",            detail.body.indexOf("defective") !== -1);
    check("detail offers Approve",              detail.body.indexOf("Approve return") !== -1);
    check("detail offers Reject",               detail.body.indexOf("Reject return") !== -1);
    check("detail has no Refund yet",           detail.body.indexOf("/refund\"") === -1);
    var detailApi = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid, headers: bearer });
    check("return detail API still JSON",        (detailApi.headers["content-type"] || "").indexOf("application/json") === 0);
    // Bad id renders the 404 queue page, not a 500.
    var missing = await helpers.httpRequest({ port: port, path: "/admin/returns/not-a-real-id", jar: jar });
    check("missing return then 404",           missing.status === 404);

    // Approve via the browser form → PRG to detail, status advances.
    var approve = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid + "/approve",
      method: "POST", jar: jar, form: { refund_amount_minor: "5998", refund_currency: "USD", operator_notes: "ok" } });
    check("approve then 303",                  approve.status === 303);
    check("approve redirects moved",            (approve.headers.location || "").indexOf("moved=1") !== -1);
    check("RMA now approved",                  (await returns.get(rid)).status === "approved");

    // Approved detail now offers Mark received + Reject, not Approve.
    var approved = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid, jar: jar });
    check("approved detail offers received",    approved.body.indexOf("Mark received") !== -1);
    check("approved detail drops Approve",       approved.body.indexOf("Approve return") === -1);

    // An illegal action from approved (refund needs received first) is
    // refused → redirect with err flag, status unchanged.
    var illegal = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid + "/refund",
      method: "POST", jar: jar, form: {} });
    check("illegal action then 303",           illegal.status === 303);
    check("illegal action flags err",           (illegal.headers.location || "").indexOf("err=1") !== -1);
    check("status unchanged after refusal",    (await returns.get(rid)).status === "approved");

    // Mark received → Refund completes the walk.
    var received = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid + "/received",
      method: "POST", jar: jar, form: {} });
    check("received then 303",                 received.status === 303);
    check("RMA now received",                  (await returns.get(rid)).status === "received");
    var refund = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid + "/refund",
      method: "POST", jar: jar, form: {} });
    check("refund then 303",                   refund.status === 303);
    check("RMA now refunded",                  (await returns.get(rid)).status === "refunded");

    // Terminal: no action forms remain.
    var terminal = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid, jar: jar });
    check("refunded detail is terminal",        terminal.body.indexOf("final state") !== -1);

    // Auth gate: anon queue → login form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/returns" });
    check("anon returns → login form",          anon.body.indexOf("Admin API key") !== -1);
    // Console nav includes Returns.
    check("nav includes Returns",               queueHtml.body.indexOf("\"/admin/returns\"") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
