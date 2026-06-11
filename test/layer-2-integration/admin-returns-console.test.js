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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
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

// Seed a paid order WITH a captured payment intent + an approved-then-
// received RMA so the next legal RMA action is refund. Returns the ids.
async function _seedRefundableReturn(query, returns, ccyOpts) {
  ccyOpts = ccyOpts || {};
  var orderCcy = ccyOpts.order_currency || "USD";
  var rmaCcy   = ccyOpts.rma_currency || "USD";
  var now = Date.now();
  var cartId = b.uuid.v7(), orderId = b.uuid.v7(), lineId = b.uuid.v7();
  // Derive the captured-intent id from the FULL order id, not a 12-char
  // prefix: a v7 UUID's leading characters are the millisecond timestamp,
  // so two seeds in the same millisecond would share a prefix and collide
  // on the orders.payment_intent_id UNIQUE constraint. The full id carries
  // the random bits, so every seed gets a distinct intent.
  var intent = "pi_test_" + orderId;
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, ?5, 'converted', ?3, ?3, ?4)",
    [cartId, b.uuid.v7(), now, now + 86400000, orderCcy],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, " +
    "customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', ?6, 5998, 0, 0, 0, 5998, ?4, '{}', NULL, ?5, ?5)",
    [orderId, cartId, b.uuid.v7(), intent, now, orderCcy],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, 'WIDGET-1', 1, 5998, ?4, 5998)",
    [lineId, orderId, b.uuid.v7(), orderCcy],
  );
  var rma = await returns.request({
    order_id: orderId, reason: "defective",
    customer_notes: "Cracked.", lines: [{ sku: "WIDGET-1", qty: 1, order_line_id: lineId }],
  });
  await returns.approve(rma.id, { refund_amount_minor: 5998, refund_currency: rmaCcy });
  await returns.markReceived(rma.id, {});
  return { orderId: orderId, rmaId: rma.id, rmaCode: rma.rma_code, intent: intent };
}

// The RMA refund money-gap fix: when a payment provider is wired AND the
// linked order has a captured intent, the console's Refund action issues
// the provider refund (via a confirm interstitial) THEN records the RMA
// refund — never a bare state change with the customer un-refunded. A fake
// payment exposes refund() so the flow runs without a network call.
async function _runProviderRefund() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "ret-prov" });
  var config  = bShop.config.create({ query: query });
  var returns = bShop.returns.create({ query: query, cursorSecret: "ret-prov-rma" });

  var refundCalls = [];
  var payment = {
    refund: async function (input, idem) {
      refundCalls.push({ input: input, idem: idem });
      return { id: "re_test_1", amount: input.amount_minor || 5998 };
    },
  };

  var seeded = await _seedRefundableReturn(query, returns);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-retp-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        returns: returns, payment: payment, shop_name: "Test Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var rid = seeded.rmaId;

  try {
    var jar = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });

    // The received RMA's detail now offers a provider-backed Refund — it
    // posts to the confirm interstitial, not the bare record endpoint.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid, jar: jar });
    check("provider refund button shown",        detail.body.indexOf("Refund through provider") !== -1);
    check("refund posts to confirm interstitial", detail.body.indexOf("/admin/returns/" + rid + "/refund/confirm") !== -1);
    check("detail is not record-only",            detail.body.indexOf("Record-only") === -1);

    // The confirm interstitial states the amount + warns it's irreversible.
    var confirm = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid + "/refund/confirm", method: "POST", jar: jar, form: {} });
    check("confirm interstitial then 200",       confirm.status === 200);
    check("interstitial states the amount",       confirm.body.indexOf("$59.98") !== -1);
    check("interstitial warns irreversible",      confirm.body.indexOf("cannot be undone") !== -1);

    // Confirming issues the provider refund THEN records the RMA refund.
    var doRefund = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid + "/refund", method: "POST", jar: jar, form: {} });
    check("provider refund then 303 moved",      doRefund.status === 303 && (doRefund.headers.location || "").indexOf("moved=1") !== -1);
    check("provider.refund was called",          refundCalls.length === 1);
    check("refund used the order's intent",       refundCalls[0].input.payment_intent === seeded.intent);
    check("refund used the RMA amount",           refundCalls[0].input.amount_minor === 5998);
    check("RMA now refunded",                    (await returns.get(rid)).status === "refunded");
    // The Stripe idempotency key is DETERMINISTIC in the return id (no
    // per-request uuid) so a double-fire collapses onto one Refund on
    // Stripe's side — even a logic regression can't double-charge.
    check("idempotency key is rma-deterministic", refundCalls[0].idem === "rma-refund:" + rid);

    // A refund on an already-refunded RMA is refused (the atomic claim) —
    // the provider is NOT called a second time.
    var reRefund = await helpers.httpRequest({ port: port, path: "/admin/returns/" + rid + "/refund", method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {} });
    check("re-refund of a refunded RMA is 409",  reRefund.status === 409);
    check("provider not called again on re-refund", refundCalls.length === 1);

    // JSON API path: a second RMA on a refundable order refunds via the
    // canonical endpoint with a bearer token (no interstitial).
    var seeded2 = await _seedRefundableReturn(query, returns);
    var apiRefund = await helpers.httpRequest({ port: port, path: "/admin/returns/" + seeded2.rmaId + "/refund", method: "POST", headers: { authorization: "Bearer " + TOKEN }, form: {} });
    check("API refund then 200 JSON",            apiRefund.status === 200 && (apiRefund.headers["content-type"] || "").indexOf("application/json") === 0);
    check("API RMA now refunded",                (await returns.get(seeded2.rmaId)).status === "refunded");
    check("provider.refund called for API too",   refundCalls.length === 2);

    // Currency display: the confirm interstitial must show the ORDER'S charge
    // currency, not the RMA's approved refund_currency. A Stripe refund
    // against a captured intent settles in the charge currency — so an EUR
    // order with a USD-approved RMA must display the EUR figure (the amount
    // the provider actually refunds), never the USD one.
    var seededEur = await _seedRefundableReturn(query, returns, { order_currency: "EUR", rma_currency: "USD" });
    var eurConfirm = await helpers.httpRequest({ port: port, path: "/admin/returns/" + seededEur.rmaId + "/refund/confirm", method: "POST", jar: jar, form: {} });
    check("EUR confirm interstitial then 200",   eurConfirm.status === 200);
    check("interstitial shows the EUR charge currency", eurConfirm.body.indexOf("€59.98") !== -1 || eurConfirm.body.indexOf("€") !== -1);
    check("interstitial does NOT show the RMA's USD currency", eurConfirm.body.indexOf("$59.98") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

async function run() {
  await _run();
  await _runProviderRefund();
}

module.exports = { run: run };
