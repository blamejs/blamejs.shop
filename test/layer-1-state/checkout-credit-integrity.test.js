"use strict";
/**
 * checkout — single-charge gate + gift-card credit integrity.
 *
 * Layer 1 stitches catalog + cart + pricing + tax + shipping + order +
 * giftcards + gift-card-ledger against in-memory SQLite, with a stub Stripe
 * adapter that counts PaymentIntents. Covers the money-integrity invariants
 * that the per-primitive suites can't see in isolation:
 *
 *   - two genuinely-concurrent confirm() calls for one cart create exactly
 *     ONE PaymentIntent + one order (the atomic cart claim); the loser is
 *     refused with CHECKOUT_IN_PROGRESS and the Stripe idempotency key is
 *     deterministic in the cart id;
 *   - a partial gift-card checkout that's abandoned (order cancelled by the
 *     reaper edge) credits the card balance back — the order FSM's cancel /
 *     refund edges drive the reversal, mirroring the inventory-hold release;
 *   - a post-create gift-card redeem failure does NOT strand the order: the
 *     cart converts, the order stands, and the failure is captured, never a
 *     thrown confirm that leaves an orphaned charge with an active cart.
 *
 * Network: zero — payment is a stub; every query is in-memory.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b       = bShop.framework;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0013_giftcards.sql", "0081_gift_card_ledger.sql", "0220_gift_card_ledger_chain.sql", "0216_giftcard_redemption_reversal.sql", "0221_giftcard_redemption_reversal.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

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

// Stub Stripe adapter — records every PaymentIntent's idempotency key so a
// test can assert single-charge + deterministic-key invariants through it.
function _stubPayment() {
  var keys = [];
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input, idempotencyKey) {
      keys.push(idempotencyKey);
      return { id: "pi_" + keys.length, client_secret: "pi_" + keys.length + "_secret", status: "requires_payment_method" };
    },
    cancelPaymentIntent: async function () { return { status: "canceled" }; },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
    _keys: function () { return keys.slice(); },
  };
}

async function _setup(opts) {
  opts = opts || {};
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var giftcards = bShop.giftcards.create({ query: query });
  var ledger    = bShop.giftCardLedger.create({ query: query });
  var order   = bShop.order.create({
    query: query, cursorSecret: "credit-integrity",
    inventory: catalog.inventory, giftCards: giftcards, giftCardLedger: ledger,
  });
  var tax     = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment = _stubPayment();
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping,
    payment: payment, order: order, giftcards: giftcards, giftCardLedger: ledger,
  });
  var p = await catalog.products.create({ slug: "ci-prod", title: "CI Prod", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "CI-1", weight_grams: 100 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: opts.price_minor || 5000 });
  return { query: query, catalog: catalog, cart: cart, order: order, giftcards: giftcards, ledger: ledger, payment: payment, checkout: checkout, variant: v };
}

async function _freshCart(s, qty) {
  var sid = b.uuid.v7();
  var c = await s.cart.create(sid, { currency: "USD" });
  await s.cart.addLine(c.id, { variant_id: s.variant.id, qty: qty || 1 });
  return c;
}

// Two concurrent confirm() calls for one cart → ONE PaymentIntent + one order.
async function _concurrentConfirmSingleCharge() {
  var s = await _setup();
  var c = await _freshCart(s);
  function doConfirm() {
    return s.checkout.confirm({
      cart_id: c.id, ship_to: { country: "US" }, selected_shipping_id: "std",
      customer: { email: "buyer@example.com" }, idempotency_key: "checkout:" + c.id + ":" + b.uuid.v7(),
    });
  }
  var res = await Promise.allSettled([doConfirm(), doConfirm()]);
  var won  = res.filter(function (x) { return x.status === "fulfilled"; }).length;
  var lost = res.filter(function (x) { return x.status === "rejected"; });
  check("concurrent confirm: exactly one wins",   won === 1);
  check("concurrent confirm: the other is refused", lost.length === 1);
  check("loser is CHECKOUT_IN_PROGRESS",          lost[0].reason && lost[0].reason.code === "CHECKOUT_IN_PROGRESS");
  check("exactly one PaymentIntent created",      s.payment._keys().length === 1);
  check("the idempotency key is cart-deterministic", s.payment._keys()[0] === "checkout:" + c.id);
  check("exactly one order row",                  (await s.query("SELECT id FROM orders", [])).rows.length === 1);
  check("cart is converted",                      (await s.cart.get(c.id)).status === "converted");
}

// A partial gift-card checkout that's abandoned credits the card balance back.
async function _giftCardReversedOnCancel() {
  var s = await _setup({ price_minor: 5000 });
  var card = await s.giftcards.issue({ amount_minor: 2000, currency: "USD" });
  await s.ledger.credit({ gift_card_id: card.id, amount_minor: 2000, source: "manual", source_ref: "seed" });
  var c = await _freshCart(s);

  var result = await s.checkout.confirm({
    cart_id: c.id, ship_to: { country: "US" }, selected_shipping_id: "std",
    customer: { email: "buyer@example.com" }, gift_card_code: card.code,
    idempotency_key: "checkout:" + c.id + ":seed",
  });
  check("partial coverage leaves a PaymentIntent", !!result.payment_intent);
  check("card debited at checkout",                (await s.giftcards.balance(card.code)).balance_minor === 0);

  // Abandon: the reaper / explicit cancel edge releases the credit.
  await s.order.transition(result.order.id, "cancel", { reason: "stale-pending-reap" });
  check("card balance restored on cancel",         (await s.giftcards.balance(card.code)).balance_minor === 2000);
  var hist = await s.ledger.history(card.id, { limit: 10 });
  var hasReversal = hist.rows.some(function (r) { return r.kind === "credit" && r.source === "refund_to_giftcard"; });
  check("ledger records a refund_to_giftcard credit", hasReversal);

  // Idempotent: a re-fired cancel-equivalent reversal never double-credits.
  await s.giftcards.reverseRedemption(result.order.id);
  check("reversal is idempotent",                  (await s.giftcards.balance(card.code)).balance_minor === 2000);

  // The paid → refunded edge also reverses (a separate order).
  var c2 = await _freshCart(s);
  var r2 = await s.checkout.confirm({
    cart_id: c2.id, ship_to: { country: "US" }, selected_shipping_id: "std",
    customer: { email: "buyer@example.com" }, gift_card_code: card.code,
    idempotency_key: "checkout:" + c2.id + ":seed",
  });
  await s.order.transition(r2.order.id, "mark_paid", { reason: "webhook" });
  check("paid order keeps the spend",              (await s.giftcards.balance(card.code)).balance_minor === 0);
  await s.order.transition(r2.order.id, "refund", { reason: "refund-webhook" });
  check("card balance restored on refund",         (await s.giftcards.balance(card.code)).balance_minor === 2000);
}

// A post-create gift-card redeem failure must not strand the order.
async function _postCreateRedeemFailureNeverStrands() {
  var s = await _setup({ price_minor: 5000 });
  // Issue the card but DON'T seed the ledger — the post-create ledger debit
  // throws (insufficient ledger balance), the exact failure that stranded the
  // order before. The card-row debit (authoritative) still lands.
  var card = await s.giftcards.issue({ amount_minor: 2000, currency: "USD" });
  var c = await _freshCart(s);

  var result = await s.checkout.confirm({
    cart_id: c.id, ship_to: { country: "US" }, selected_shipping_id: "std",
    customer: { email: "buyer@example.com" }, gift_card_code: card.code,
    idempotency_key: "checkout:" + c.id + ":seed",
  });
  check("confirm returns an order (not a throw)",  result && result.order && result.order.id);
  check("the PaymentIntent exists",                !!result.payment_intent);
  check("cart converted (never stranded active)",  (await s.cart.get(c.id)).status === "converted");
  check("card-row debit (authoritative) landed",   (await s.giftcards.balance(card.code)).balance_minor === 0);
  check("exactly one order row",                   (await s.query("SELECT id FROM orders", [])).rows.length === 1);
}

async function _fullyCoveredRedeemFailureNeverStrands() {
  var s = await _setup({ price_minor: 2000 });
  // Card FULLY covers the order (amountDue === 0 — the no-PaymentIntent
  // branch). The ledger isn't seeded, so the post-create ledger debit
  // throws — the failure must be captured by the same settlement wrapper
  // as the PaymentIntent branch: the order still advances to paid, the
  // cart converts, and the authoritative card-row debit lands.
  var card = await s.giftcards.issue({ amount_minor: 5000, currency: "USD" });
  var c = await _freshCart(s);

  var result = await s.checkout.confirm({
    cart_id: c.id, ship_to: { country: "US" }, selected_shipping_id: "std",
    customer: { email: "buyer@example.com" }, gift_card_code: card.code,
    idempotency_key: "checkout:" + c.id + ":seed",
  });
  check("fully covered: confirm returns a paid order (not a throw)",
    result && result.order && result.order.status === "paid");
  check("fully covered: no PaymentIntent on the zero-due path", !result.payment_intent);
  check("fully covered: cart converted (never stranded active)",
    (await s.cart.get(c.id)).status === "converted");
  check("fully covered: exactly one order row",
    (await s.query("SELECT id FROM orders", [])).rows.length === 1);
}

// A partial refund re-mints gift-card spend in PROPORTION to the amount
// refunded — not nothing (the pre-fix balance-leaving partial) and not the
// full spend (the pre-fix terminal-edge over-restore). Cumulative partials
// converge, and the terminal refund credits only the remaining delta.
async function _giftCardProRataOnPartialRefund() {
  var s = await _setup({ price_minor: 5000 });
  var card = await s.giftcards.issue({ amount_minor: 5000, currency: "USD" });
  await s.ledger.credit({ gift_card_id: card.id, amount_minor: 5000, source: "manual", source_ref: "seed" });
  var c = await _freshCart(s);
  var result = await s.checkout.confirm({
    cart_id: c.id, ship_to: { country: "US" }, selected_shipping_id: "std",
    customer: { email: "buyer@example.com" }, gift_card_code: card.code,
    idempotency_key: "checkout:" + c.id + ":seed",
  });
  check("pro-rata: fully covered → paid",          result.order.status === "paid");
  check("pro-rata: card drained at checkout",      (await s.giftcards.balance(card.code)).balance_minor === 0);

  // 1500 / 5000 = 30% refunded → 30% of the spend re-minted (1500), not 0, not 5000.
  await s.order.recordPartialRefund(result.order.id, { amount_minor: 1500 });
  check("pro-rata: partial refund re-mints the proportional share",
    (await s.giftcards.balance(card.code)).balance_minor === 1500);

  // A second partial (1000 → cumulative 2500 / 5000 = 50%) advances to exactly
  // 2500 — cumulative convergence, no double-credit.
  await s.order.recordPartialRefund(result.order.id, { amount_minor: 1000 });
  check("pro-rata: cumulative partials converge",
    (await s.giftcards.balance(card.code)).balance_minor === 2500);

  // The terminal refund clears the balance: cumulative reaches the full spend,
  // crediting only the remaining 2500 delta — never over-crediting past 5000.
  await s.order.transition(result.order.id, "refund", { reason: "refund-webhook" });
  check("pro-rata: terminal refund re-mints the remainder to full, no more",
    (await s.giftcards.balance(card.code)).balance_minor === 5000);
}

async function run() {
  await _concurrentConfirmSingleCharge();
  await _giftCardReversedOnCancel();
  await _postCreateRedeemFailureNeverStrands();
  await _fullyCoveredRedeemFailureNeverStrands();
  await _giftCardProRataOnPartialRefund();
}

module.exports = { run: run };
