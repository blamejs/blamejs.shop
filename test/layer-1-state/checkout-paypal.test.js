"use strict";
/**
 * Checkout — PayPal (Orders v2) orchestration. Stubs the PayPal adapter (no
 * network) and exercises createPaypalOrder → capturePaypalOrder → paid, plus
 * the handlePaypalEvent webhook backstop:
 *
 *   - capture persists the CAPTURE id + provider on the order row (refunds
 *     dial the capture, never the PayPal order id);
 *   - PAYMENT.CAPTURE.REFUNDED is AMOUNT-AWARE: a partial refund appends a
 *     partial ledger row (gift-card re-credit stays proportional — never the
 *     full re-credit a terminal refund runs); only a balance-clearing amount
 *     drives the terminal refund edge; a missing/garbled/mismatched amount
 *     THROWS (the route 5xxes so PayPal redelivers) instead of guessing;
 *   - replay defense: a re-delivered event id is claimed in the shared
 *     webhook-replay store and skipped; the same REFUND id under a fresh
 *     event id is deduped off the ledger (paypal_refund_id).
 *
 * Uses one in-memory node:sqlite DB.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0013_giftcards.sql", "0081_gift_card_ledger.sql", "0220_gift_card_ledger_chain.sql", "0230_gift_card_ledger_chain_fence.sql",
  "0216_giftcard_redemption_reversal.sql", "0221_giftcard_redemption_reversal.sql",
  "0218_stripe_webhook_events.sql", "0022_loyalty.sql",
].map(function (f) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f); });

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

function _fakePaypal() {
  var n = 0;
  var pp = {
    name: "fake-paypal",
    captureCalls: 0,
    createCalls:  0,
    createOrder: async function (input) { pp.createCalls += 1; pp.lastCreateInput = input; n += 1; return { id: "PP-ORDER-" + n, status: "CREATED", _amount: input.amount_minor, _currency: input.currency }; },
    captureOrder: async function (id) {
      pp.captureCalls += 1;
      return { id: id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "PP-CAP-" + id, status: "COMPLETED" }] } }] };
    },
    getOrder: async function (id) { return { id: id, status: "APPROVED" }; },
    refund: async function () { return { id: "PP-REF-1", status: "COMPLETED" }; },
    verifyWebhook: async function (_headers, rawBody) {
      try { return { ok: true, event: JSON.parse(rawBody) }; } catch (_e) { return { ok: false, reason: "malformed-body" }; }
    },
  };
  return pp;
}

// `opts.priceMinor` overrides the single variant's USD price;
// `opts.flatRates` swaps tax to 0bps + free shipping so credit/refund
// arithmetic stays exact in the split-tender scenarios.
async function _setup(opts) {
  opts = opts || {};
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var giftcards = bShop.giftcards.create({ query: query });
  var ledger    = bShop.giftCardLedger.create({ query: query });
  var order     = bShop.order.create({
    query: query, cursorSecret: "co-pp",
    giftCards: giftcards, giftCardLedger: ledger,
  });
  var tax      = opts.flatRates
    ? bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] })
    : bShop.tax.create({ rules: [{ country: "US", state: "CA", rate_bps: 875 }] });
  var shipping = opts.flatRates
    ? bShop.shipping.create({ services: [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 0 }] }] })
    : bShop.shipping.create({ services: [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_" + b.crypto.generateToken(8) });
  var loyalty  = bShop.loyalty.create({ query: query });   // default ratio: 100 points = $1
  var paypal   = _fakePaypal();
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order, paypal: paypal,
    giftcards: giftcards, giftCardLedger: ledger, loyalty: loyalty,
    webhookReplayQuery: query,   // replay claims recorded — same wiring as production
  });
  var p = await catalog.products.create({ slug: "pp-test", title: "PP Test", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "PP-1", weight_grams: 250 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: opts.priceMinor || 2999 });
  return { query: query, cart: cart, order: order, giftcards: giftcards, loyalty: loyalty, checkout: checkout, variant: v, paypal: paypal };
}

async function _newCart(s, qty) {
  var sid = b.uuid.v7();
  var c = await s.cart.create(sid, { currency: "USD" });
  await s.cart.addLine(c.id, { variant_id: s.variant.id, qty: qty == null ? 2 : qty });
  return c;
}

function _input(cartId, extra) {
  return Object.assign({
    cart_id: cartId,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "pp-key-" + b.uuid.v7(),
  }, extra || {});
}

// Build a REFUNDED webhook event for the given paypal order. `amount` is the
// `{ currency_code, value }` object (or undefined to omit it).
function _refundEvt(eventId, refundId, ppOrderId, amount) {
  return JSON.stringify({
    id: eventId, event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: {
      id: refundId,
      amount: amount,
      supplementary_data: { related_ids: { order_id: ppOrderId } },
    },
  });
}

async function _createAndCapture() {
  var s = await _setup();
  var c = await _newCart(s);
  var created = await s.checkout.createPaypalOrder(_input(c.id));
  check("createPaypalOrder returns a paypal order id", /^PP-ORDER-/.test(created.paypal_order_id));
  check("local order is pending",                      created.order.status === "pending");
  check("order links the paypal order id",             created.order.payment_intent_id === created.paypal_order_id);
  check("order stamped with the paypal provider",      created.order.payment_provider === "paypal");
  check("cart marked converted",                      (await s.cart.get(c.id)).status === "converted");

  var cap = await s.checkout.capturePaypalOrder(created.paypal_order_id);
  check("capture handled",                             cap.handled === true);
  check("capture id surfaced",                         /^PP-CAP-/.test(cap.capture_id));
  check("order advanced to paid",                      cap.order.status === "paid");
  // The capture id is PERSISTED on the order row — refunds dial
  // /v2/payments/captures/<capture-id>/refund, never the order id.
  check("capture id persisted on the order row",       cap.order.paypal_capture_id === cap.capture_id);
  check("paypalCaptureId resolves the column",         (await s.order.paypalCaptureId(cap.order.id)) === cap.capture_id);

  // Re-capture (retry) is idempotent AND must NOT hit PayPal again (a second
  // remote capture would be rejected — orders capture once).
  var recap = await s.checkout.capturePaypalOrder(created.paypal_order_id);
  check("re-capture leaves order paid",                recap.order.status === "paid" && recap.skipped === "already-advanced");
  check("re-capture did not call PayPal again",        s.paypal.captureCalls === 1);
}

// Pre-existing orders (captured before the column shipped) recover the
// capture id from the mark_paid transition metadata — and heal the column.
async function _captureIdRecovery() {
  var s = await _setup();
  var c = await _newCart(s);
  var created = await s.checkout.createPaypalOrder(_input(c.id));
  await s.checkout.capturePaypalOrder(created.paypal_order_id);
  // Simulate the legacy row: blank the column (the metadata stamp remains).
  await s.query("UPDATE orders SET paypal_capture_id = NULL WHERE id = ?1", [created.order.id]);
  var recovered = await s.order.paypalCaptureId(created.order.id);
  check("capture id recovered from transition metadata", recovered === "PP-CAP-" + created.paypal_order_id);
  var row = (await s.query("SELECT paypal_capture_id FROM orders WHERE id = ?1", [created.order.id])).rows[0];
  check("recovery heals the column",                     row.paypal_capture_id === recovered);
}

async function _webhookBackstop() {
  var s = await _setup();
  var c = await _newCart(s);
  var created = await s.checkout.createPaypalOrder(_input(c.id));
  var ppId = created.paypal_order_id;

  // A CAPTURE.COMPLETED webhook (buyer captured out of band) marks it paid.
  var evt = JSON.stringify({
    id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "CAP-X", supplementary_data: { related_ids: { order_id: ppId } } },
  });
  var r1 = await s.checkout.handlePaypalEvent({ headers: { "paypal-transmission-id": "t" }, rawBody: evt });
  check("webhook capture-completed handled",           r1.handled === true);
  check("webhook advanced order to paid",              r1.order.status === "paid");
  check("webhook persisted the capture id",            (await s.order.get(created.order.id)).paypal_capture_id === "CAP-X");

  // Re-delivery of the SAME event id is claimed by the replay store.
  var r2 = await s.checkout.handlePaypalEvent({ headers: {}, rawBody: evt });
  check("webhook re-delivery skipped as replay",       r2.handled === true && r2.skipped === "replay");
  var claims = await s.query("SELECT event_id FROM stripe_webhook_events", []);
  check("replay claim recorded under the paypal namespace",
    claims.rows.some(function (row) { return row.event_id === "paypal:WH-1"; }));

  // An unknown event type is a no-op.
  var r3 = await s.checkout.handlePaypalEvent({ headers: {}, rawBody: JSON.stringify({ id: "WH-UNK", event_type: "BILLING.SUBSCRIPTION.CREATED", resource: {} }) });
  check("unknown event type not handled",              r3.handled === false);

  // A full-amount refund webhook on the paid order drives the terminal edge.
  var c2 = await _newCart(s);
  var created2 = await s.checkout.createPaypalOrder(_input(c2.id));
  await s.checkout.capturePaypalOrder(created2.paypal_order_id);
  var paid2 = await s.order.get(created2.order.id);
  var fullValue = bShop.payment._minorToDecimalString(Number(paid2.grand_total_minor), "USD");
  var r4 = await s.checkout.handlePaypalEvent({
    headers: {},
    rawBody: _refundEvt("WH-2", "REF-X", created2.paypal_order_id, { currency_code: "USD", value: fullValue }),
  });
  check("full-amount refund webhook refunds the order", r4.handled === true && r4.order.status === "refunded");
  check("full refund recorded in the ledger",          (await s.order.refundedTotalMinor(created2.order.id)) === Number(paid2.grand_total_minor));
}

// The probe scenario: a split-tender order (gift card + PayPal) hit with a
// PARTIAL dashboard refund must NOT re-credit the whole gift spend — the
// amount-blind mirror was customer-influenceable value creation.
async function _partialRefundMirror() {
  var s = await _setup({ priceMinor: 5000, flatRates: true });   // $50.00 order, 0 tax, 0 ship
  var card = await s.giftcards.issue({ amount_minor: 2000, currency: "USD" });
  var code = card.code_plain || card.code || (card.card && card.card.code_plain);
  var c = await _newCart(s, 1);
  var created = await s.checkout.createPaypalOrder(_input(c.id, { gift_card_code: code }));
  check("split-tender: PayPal opened for the credit-reduced amount", created.gift_card && created.gift_card.amount_due_minor === 3000);
  await s.checkout.capturePaypalOrder(created.paypal_order_id);
  check("split-tender: card fully spent",            (await s.giftcards.balance(code)).balance_minor === 0);
  var orderId = created.order.id;
  var ppId    = created.paypal_order_id;

  // A $5.00 partial refund event → a $5 partial ledger row, order stays
  // paid, gift re-credit is PROPORTIONAL (500/5000 of the 2000 spend).
  var r1 = await s.checkout.handlePaypalEvent({
    headers: {}, rawBody: _refundEvt("WH-P1", "REF-P1", ppId, { currency_code: "USD", value: "5.00" }),
  });
  check("partial refund handled as partial",         r1.handled === true && r1.partial === true && r1.amount_minor === 500);
  check("partial refund leaves the order paid",      (await s.order.get(orderId)).status === "paid");
  check("partial refund ledger records 500",         (await s.order.refundedTotalMinor(orderId)) === 500);
  check("gift re-credit proportional (200), not the full 2000",
    (await s.giftcards.balance(code)).balance_minor === 200);

  // Re-delivery of the SAME event id: claimed, nothing double-appended.
  var r2 = await s.checkout.handlePaypalEvent({
    headers: {}, rawBody: _refundEvt("WH-P1", "REF-P1", ppId, { currency_code: "USD", value: "5.00" }),
  });
  check("replayed partial event skipped",            r2.handled === true && r2.skipped === "replay");
  check("replay did not double-append the ledger",   (await s.order.refundedTotalMinor(orderId)) === 500);
  check("replay did not re-credit the card again",   (await s.giftcards.balance(code)).balance_minor === 200);

  // The SAME refund id under a FRESH event id (e.g. redelivered after the
  // claim TTL, or mirrored after a console-issued refund): deduped off the
  // ledger's paypal_refund_id stamp.
  var r3 = await s.checkout.handlePaypalEvent({
    headers: {}, rawBody: _refundEvt("WH-P1-RETRY", "REF-P1", ppId, { currency_code: "USD", value: "5.00" }),
  });
  check("same refund id under a new event id deduped", r3.handled === true && r3.skipped === "already-recorded");
  check("dedupe did not append the ledger",            (await s.order.refundedTotalMinor(orderId)) === 500);

  // A missing amount must THROW (the route 5xxes so PayPal redelivers) —
  // never guess a full refund.
  await helpers.assert.rejects(
    s.checkout.handlePaypalEvent({ headers: {}, rawBody: _refundEvt("WH-P2", "REF-P2", ppId, undefined) }),
    /resource\.amount is missing or unparseable/,
  );
  // A currency-mismatched amount is equally garbled.
  await helpers.assert.rejects(
    s.checkout.handlePaypalEvent({ headers: {}, rawBody: _refundEvt("WH-P3", "REF-P3", ppId, { currency_code: "EUR", value: "5.00" }) }),
    /resource\.amount is missing or unparseable/,
  );
  check("garbled events appended nothing",           (await s.order.refundedTotalMinor(orderId)) === 500);

  // A balance-clearing amount drives the terminal edge and re-credits the
  // remaining gift spend in full.
  var r4 = await s.checkout.handlePaypalEvent({
    headers: {}, rawBody: _refundEvt("WH-P4", "REF-P4", ppId, { currency_code: "USD", value: "45.00" }),
  });
  check("balance-clearing refund drives terminal refunded", r4.handled === true && r4.order.status === "refunded");
  check("ledger converges on the grand total",       (await s.order.refundedTotalMinor(orderId)) === 5000);
  check("terminal refund re-credits the gift spend in full",
    (await s.giftcards.balance(code)).balance_minor === 2000);
}

// A fully-credit-covered cart returns the PAID_BY_GIFT_CARD shape with no
// PayPal order opened and no provider stamped (nothing a provider could
// refund).
async function _fullCoverageNoPaypalDial() {
  var s = await _setup({ priceMinor: 5000, flatRates: true });
  var card = await s.giftcards.issue({ amount_minor: 10000, currency: "USD" });
  var code = card.code_plain || card.code || (card.card && card.card.code_plain);
  var c = await _newCart(s, 1);
  var res = await s.checkout.createPaypalOrder(_input(c.id, { gift_card_code: code }));
  check("full coverage: PAID_BY_GIFT_CARD status",    res.status === "PAID_BY_GIFT_CARD");
  check("full coverage: no PayPal order id",          res.paypal_order_id === null);
  check("full coverage: no PayPal dial",              s.paypal.createCalls === 0);
  check("full coverage: order paid",                  res.order.status === "paid");
  check("full coverage: no provider stamped",         res.order.payment_provider == null);
  check("full coverage: card debited the order total", (await s.giftcards.balance(code)).balance_minor === 5000);
}

// Loyalty points ride the PayPal button like the card form: the PayPal
// order opens for the points-reduced amount and the points are debited
// against the placed order.
async function _loyaltyRidesPaypal() {
  var s = await _setup({ priceMinor: 3000, flatRates: true });   // $30.00 order
  var buyer = b.uuid.v7();
  await s.loyalty.earn({ customer_id: buyer, points: 1000, source: "test-seed" });   // $10 of credit
  var sid = b.uuid.v7();
  var c = await s.cart.create(sid, { currency: "USD" });
  await s.cart.addLine(c.id, { variant_id: s.variant.id, qty: 1 });
  await s.cart.setCustomer(c.id, buyer);
  var created = await s.checkout.createPaypalOrder(_input(c.id, { loyalty_redeem_points: 1000 }));
  check("loyalty: PayPal order opened for the points-reduced amount",
    created.loyalty && created.loyalty.applied_minor === 1000 && created.loyalty.amount_due_minor === 2000);
  check("loyalty: the remote dial carried the reduced amount",
    s.paypal.lastCreateInput && s.paypal.lastCreateInput.amount_minor === 2000);
  check("loyalty: points debited against the order",
    (await s.loyalty.balance(buyer)).balance === 0);
}

async function _validation() {
  var s = await _setup();
  var c = await _newCart(s);
  await helpers.assert.rejects(s.checkout.createPaypalOrder({ cart_id: c.id, selected_shipping_id: "std", customer: { email: "x@y.com" } }), /idempotency_key/);
  // Loyalty points on a guest cart are refused with the coded error the
  // route maps to a 400 (mirrors the card-form confirm path).
  await helpers.assert.rejects(
    s.checkout.createPaypalOrder(_input(c.id, { loyalty_redeem_points: 100 })),
    /sign in to redeem/i,
  );
  // Adapter absent → methods throw.
  var bare = bShop.checkout.create({
    catalog: bShop.catalog.create({ query: s.query }), cart: s.cart, pricing: bShop.pricing,
    tax: bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] }),
    shipping: bShop.shipping.create({ services: [{ id: "std", label: "S", zones: [{ country: "US", flat_amount_minor: 0 }] }] }),
    payment: bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" }), order: s.order,
    // no `paypal` dep → the PayPal methods must throw.
  });
  await helpers.assert.rejects(bare.createPaypalOrder(_input(c.id)), /paypal adapter not wired/);
}

async function _captureIncomplete() {
  // A capture that PayPal does NOT complete must leave the order pending and
  // report handled:false (so the route surfaces an error, not a fake success).
  var s = await _setup();
  // Swap in a stub whose captureOrder returns a non-COMPLETED status.
  s.paypal.captureOrder = async function (id) {
    return { id: id, status: "PENDING", purchase_units: [{ payments: { captures: [{ id: "PP-CAP-" + id, status: "PENDING" }] } }] };
  };
  var c = await _newCart(s);
  var created = await s.checkout.createPaypalOrder(_input(c.id));
  var cap = await s.checkout.capturePaypalOrder(created.paypal_order_id);
  check("incomplete capture not handled",          cap.handled === false);
  check("incomplete capture leaves order pending", cap.order.status === "pending");
}

async function run() {
  await _createAndCapture();
  await _captureIdRecovery();
  await _webhookBackstop();
  await _partialRefundMirror();
  await _fullCoverageNoPaypalDial();
  await _loyaltyRidesPaypal();
  await _captureIncomplete();
  await _validation();
}

module.exports = { run: run };
