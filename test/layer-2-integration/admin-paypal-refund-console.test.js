"use strict";
/**
 * Admin refunds route by PAYMENT PROVIDER — full HTTP integration over
 * b.createApp + admin.mount with BOTH a fake Stripe handle and a fake PayPal
 * handle recording every call.
 *
 * Exercises:
 *   - FULL refund of a PayPal-paid order dials paypal.refund with the
 *     CAPTURE id (never the PayPal order id stored in payment_intent_id,
 *     never the Stripe handle) and stamps paypal_refund_id on the ledger.
 *   - PARTIAL refund maps { capture_id, amount_minor, currency }; two
 *     distinct slices carry DISTINCT idempotency keys (a repeated
 *     PayPal-Request-Id would make PayPal silently replay the first refund
 *     instead of executing the second); a final slice clears the balance and
 *     drives terminal refunded.
 *   - LEGACY recovery: an order placed before the provider/capture columns
 *     existed (payment_provider NULL, capture id only in the mark_paid
 *     transition metadata) routes by the payment_intent_id shape and
 *     recovers + heals the capture id; an order with NO local capture trace
 *     recovers it remotely via paypal.getOrder.
 *   - GATING reflects provider reality: with NO PayPal handle wired, the
 *     PayPal order's detail page offers no refund affordance and the refund
 *     POSTs are clean 422s (nothing dialed) — never a Stripe dial carrying
 *     PayPal identifiers.
 *   - Stripe orders still refund through the Stripe handle (non-regression).
 *
 * Network: zero — both providers are local fakes.
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

var TOKEN = "admin-token-0123456789abcdef-pprefund";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
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

// Seed a paid order. `opts`: { intent, provider, captureId, captureInMeta,
// grand } — captureId lands on the column, captureInMeta only on the
// mark_paid transition metadata (the legacy shape).
async function _seedPaidOrder(query, opts) {
  var now = Date.now();
  var cartId = b.uuid.v7(), orderId = b.uuid.v7(), lineId = b.uuid.v7();
  var grand = opts.grand == null ? 5998 : opts.grand;
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, b.uuid.v7(), now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, payment_provider, " +
    "paypal_capture_id, ship_to_json, customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', ?4, 0, 0, 0, ?4, ?5, ?6, ?7, '{\"country\":\"US\"}', NULL, ?8, ?8)",
    [orderId, cartId, b.uuid.v7(), grand, opts.intent, opts.provider || null, opts.captureId || null, now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, 'WIDGET-1', 1, ?4, 'USD', ?4)",
    [lineId, orderId, b.uuid.v7(), grand],
  );
  await query(
    "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
    "VALUES (?1, ?2, '__init__', 'pending', 'create', NULL, '{}', ?3)",
    [b.uuid.v7(), orderId, now - 2000],
  );
  var paidMeta = opts.captureInMeta
    ? JSON.stringify({ paypal_order_id: opts.intent, paypal_capture_id: opts.captureInMeta })
    : "{}";
  await query(
    "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
    "VALUES (?1, ?2, 'pending', 'paid', 'mark_paid', 'seed', ?3, ?4)",
    [b.uuid.v7(), orderId, paidMeta, now - 1000],
  );
  return orderId;
}

function _fakeStripe() {
  var calls = [];
  return {
    name: "fake-stripe",
    _refunds: calls,
    refund: async function (input, idem) {
      calls.push({ input: input, idem: idem });
      return { id: "re_" + calls.length, amount: input.amount_minor != null ? input.amount_minor : 5998 };
    },
  };
}

function _fakePaypal() {
  var refunds = [];
  var getOrders = [];
  var pp = {
    name: "fake-paypal",
    _refunds: refunds,
    _getOrders: getOrders,
    _remoteCaptureId: null,   // set per test for the remote-recovery path
    refund: async function (input, idem) {
      refunds.push({ input: input, idem: idem });
      var value = input.amount_minor != null
        ? bShop.payment._minorToDecimalString(input.amount_minor, input.currency || "USD")
        : null;
      return {
        id: "PPREF-" + refunds.length, status: "COMPLETED",
        amount: value != null ? { currency_code: input.currency || "USD", value: value } : undefined,
      };
    },
    getOrder: async function (id) {
      getOrders.push(id);
      if (!pp._remoteCaptureId) throw new Error("paypal: GET order → HTTP 404");
      return { id: id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: pp._remoteCaptureId, status: "COMPLETED" }] } }] };
    },
  };
  return pp;
}

function _bearerPost(port, path, body) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

async function _mountApp(query, order, payment, paypal) {
  var catalog = bShop.catalog.create({ query: query });
  var config  = bShop.config.create({ query: query });
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-pprefund-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        payment: payment, paypal: paypal,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _run() {
  var query  = _makeQuery();
  var order  = bShop.order.create({ query: query, cursorSecret: "pprefund-order" });
  var stripe = _fakeStripe();
  var paypal = _fakePaypal();

  var boot = await _mountApp(query, order, stripe, paypal);
  var port = boot.port;

  try {
    // ---- FULL refund of a PayPal order routes to the PayPal handle -----
    var orderA = await _seedPaidOrder(query, { intent: "PPORD-A", provider: "paypal", captureId: "CAP-A" });
    var full = await _bearerPost(port, "/admin/orders/" + orderA + "/refund", {});
    check("paypal full refund then 200",           full.status === 200);
    check("paypal full refund dialed PayPal once", paypal._refunds.length === 1);
    check("paypal full refund used the CAPTURE id (not the order id)",
      paypal._refunds[0].input.capture_id === "CAP-A" && paypal._refunds[0].input.payment_intent === undefined);
    check("paypal full refund sent no amount (full)", paypal._refunds[0].input.amount_minor === undefined);
    check("paypal full refund never touched Stripe",  stripe._refunds.length === 0);
    var afterA = await order.get(orderA);
    check("paypal full refund drove terminal refunded", afterA.status === "refunded");
    var ledgerA = afterA.transitions.filter(function (t) { return t.on_event === "refund"; });
    check("ledger stamps paypal_refund_id",
      ledgerA.length === 1 && JSON.parse(ledgerA[0].metadata_json).paypal_refund_id === "PPREF-1");

    // ---- LEGACY order: provider + capture recovered, partial slices ----
    // payment_provider NULL, capture only in the mark_paid metadata — the
    // pre-column shape every existing PayPal order has.
    var orderB = await _seedPaidOrder(query, { intent: "PPORD-B", provider: null, captureInMeta: "CAP-B" });
    var p1 = await _bearerPost(port, "/admin/orders/" + orderB + "/refund/partial", { amount: "10.00" });
    check("legacy partial refund then 200",         p1.status === 200);
    var ppCall1 = paypal._refunds[paypal._refunds.length - 1];
    check("legacy partial routed to PayPal with the recovered capture id",
      ppCall1.input.capture_id === "CAP-B");
    check("legacy partial mapped { amount_minor, currency }",
      ppCall1.input.amount_minor === 1000 && ppCall1.input.currency === "USD");
    check("legacy partial never touched Stripe",    stripe._refunds.length === 0);
    var healedB = (await query("SELECT paypal_capture_id, payment_provider FROM orders WHERE id = ?1", [orderB])).rows[0];
    check("legacy recovery healed the capture column", healedB.paypal_capture_id === "CAP-B");
    check("legacy recovery stamped the provider",      healedB.payment_provider === "paypal");
    check("legacy partial left the order paid",     (await order.get(orderB)).status === "paid");
    check("legacy partial recorded 1000",           (await order.refundedTotalMinor(orderB)) === 1000);

    // A SECOND distinct slice must carry a DIFFERENT idempotency key — a
    // repeated key would make PayPal replay the first refund silently.
    var p2 = await _bearerPost(port, "/admin/orders/" + orderB + "/refund/partial", { amount: "5.00" });
    check("second slice then 200",                  p2.status === 200);
    var ppCall2 = paypal._refunds[paypal._refunds.length - 1];
    check("two slices carry distinct idempotency keys", ppCall1.idem !== ppCall2.idem);
    check("second slice ledger total 1500",         (await order.refundedTotalMinor(orderB)) === 1500);

    // Refund-after-partial: the slice clearing the balance drives terminal.
    var clearing = ((5998 - 1500) / 100).toFixed(2);
    var p3 = await _bearerPost(port, "/admin/orders/" + orderB + "/refund/partial", { amount: clearing });
    check("balance-clearing slice then 200",        p3.status === 200);
    check("balance-clearing slice drove terminal refunded", (await order.get(orderB)).status === "refunded");
    check("ledger converged on the grand total",    (await order.refundedTotalMinor(orderB)) === 5998);

    // ---- remote capture recovery via getOrder ---------------------------
    // No capture trace locally at all → the console recovers it from PayPal
    // and heals the column before refunding.
    var orderD = await _seedPaidOrder(query, { intent: "PPORD-D", provider: "paypal" });
    paypal._remoteCaptureId = "CAP-D-REMOTE";
    var fullD = await _bearerPost(port, "/admin/orders/" + orderD + "/refund", {});
    check("remote-recovery refund then 200",        fullD.status === 200);
    check("getOrder consulted for the capture id",  paypal._getOrders.indexOf("PPORD-D") !== -1);
    var ppCallD = paypal._refunds[paypal._refunds.length - 1];
    check("refund ran against the remotely-recovered capture", ppCallD.input.capture_id === "CAP-D-REMOTE");
    var healedD = (await query("SELECT paypal_capture_id FROM orders WHERE id = ?1", [orderD])).rows[0];
    check("remote recovery healed the column",      healedD.paypal_capture_id === "CAP-D-REMOTE");
    paypal._remoteCaptureId = null;

    // An unrecoverable capture (no local trace, remote 404) is a clean 422
    // with NOTHING dialed for the refund.
    var orderE = await _seedPaidOrder(query, { intent: "PPORD-E", provider: "paypal" });
    var refundsBefore = paypal._refunds.length;
    var fullE = await _bearerPost(port, "/admin/orders/" + orderE + "/refund", {});
    check("unrecoverable capture then 422",         fullE.status === 422 && JSON.parse(fullE.body).type === "/problems/no-paypal-capture");
    check("unrecoverable capture dialed no refund", paypal._refunds.length === refundsBefore);
    check("unrecoverable capture left the order paid", (await order.get(orderE)).status === "paid");

    // ---- Stripe orders still route to Stripe (non-regression) ----------
    var orderC = await _seedPaidOrder(query, { intent: "pi_test_stripe_C", provider: null });
    var pc = await _bearerPost(port, "/admin/orders/" + orderC + "/refund/partial", { amount: "10.00" });
    check("stripe partial then 200",                pc.status === 200);
    var sCall = stripe._refunds[stripe._refunds.length - 1];
    check("stripe partial dialed the Stripe handle with the intent",
      stripe._refunds.length === 1 && sCall.input.payment_intent === "pi_test_stripe_C" && sCall.input.amount_minor === 1000);
  } finally {
    try { await boot.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(boot.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }

  // ---- gating: PayPal order with NO PayPal handle wired ----------------
  // A separate mount with only the Stripe handle: the PayPal order's detail
  // offers no refund affordance, and the refund POSTs are clean 422s with
  // nothing dialed — never a Stripe dial carrying PayPal identifiers.
  var query2  = _makeQuery();
  var order2  = bShop.order.create({ query: query2, cursorSecret: "pprefund-order2" });
  var stripe2 = _fakeStripe();
  var boot2 = await _mountApp(query2, order2, stripe2, null);
  try {
    var ppOrder = await _seedPaidOrder(query2, { intent: "PPORD-X", provider: "paypal", captureId: "CAP-X" });
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: boot2.port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("gating: admin login then 303",          login.status === 303);
    var detail = await helpers.httpRequest({ port: boot2.port, path: "/admin/orders/" + ppOrder, jar: jar });
    check("gating: detail then 200",               detail.status === 200);
    check("gating: no refund form offered for an unrefundable provider",
      detail.body.indexOf("/refund/partial\"") === -1);

    var fullX = await _bearerPost(boot2.port, "/admin/orders/" + ppOrder + "/refund", {});
    check("gating: full refund then 422 provider-not-configured",
      fullX.status === 422 && JSON.parse(fullX.body).type === "/problems/provider-not-configured");
    var partX = await _bearerPost(boot2.port, "/admin/orders/" + ppOrder + "/refund/partial", { amount: "5.00" });
    check("gating: partial refund then 422",       partX.status === 422);
    check("gating: Stripe handle never dialed with PayPal identifiers", stripe2._refunds.length === 0);
    check("gating: order untouched",               (await order2.get(ppOrder)).status === "paid");
  } finally {
    try { await boot2.app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(boot2.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
