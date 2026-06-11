"use strict";
/**
 * Checkout auto-discount wiring — quote + confirm against a real
 * booted checkout, all assertions in minor units.
 *
 * The auto-discount engine is operator-authored: rules live in
 * `auto_discount_rules` and are consulted during the quote. This pins
 * the checkout side of that wiring:
 *
 *   (a) NO rules defined  -> discount_minor is 0 and every total is
 *       byte-identical to a checkout built WITHOUT the engine wired.
 *       Production (which ships with no rules) is unchanged.
 *   (b) a matching rule    -> discount_minor equals the engine savings,
 *       the quote grand total drops by exactly that, and a CONFIRMED
 *       order persists both the reduced grand total and discount_minor.
 *   (c) a savings that would exceed the subtotal is clamped to the
 *       subtotal — the order total never goes negative.
 *   (d) an engine whose evaluate THROWS falls back to discount 0; the
 *       cart still quotes and confirms (never a 5xx on the buy path).
 *
 * Shared one in-memory SQLite handle across catalog + cart + order +
 * the auto-discount engine, so a confirmed order's discount row is
 * the same store the engine recorded the redemption against.
 *
 * Network: zero — payment is a stub, no HTTP.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var autoDiscount = require("../../lib/auto-discount");
var helpers      = require("../helpers");
var check        = helpers.check;
var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0107_auto_discount.sql",
  "0209_auto_discount_unlock_code.sql",
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

var _piSeq = 0;
var _chargeByPi = {};   // PaymentIntent id -> the amount the stub was asked to charge
function _stubPayment() {
  // Each PaymentIntent id is globally unique across stub instances —
  // the orders table enforces a UNIQUE index on payment_intent_id, so
  // two confirms (one per case) must not collide.
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      _piSeq += 1;
      var _id = "pi_" + _piSeq;
      _chargeByPi[_id] = input.amount_minor;
      return { id: _id, client_secret: _id + "_secret", status: "requires_payment_method", _amount: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

// Common deps for a checkout built on the shared store. The optional
// `autoDiscount` handle is the only thing that varies across the cases.
function _checkoutDeps(query, catalog, cart, order) {
  return {
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: bShop.tax.create({ rules: [{ country: "US", rate_bps: 875 }] }),
    shipping: bShop.shipping.create({ services: [
      { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] },
    ] }),
    payment: _stubPayment(),
    order: order,
  };
}

var SHIP_TO = { line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103" };

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "auto-disc-sf" });
  var engine  = autoDiscount.create({ query: query });

  // A single $50.00 product, well-stocked.
  var p1 = await catalog.products.create({ slug: "widget", title: "Widget", status: "active" });
  var v1 = await catalog.variants.create(p1.id, { sku: "WID-1", weight_grams: 100 });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 5000 });
  await catalog.inventory.create("WID-1", { stock_on_hand: 100 });

  // Build a fresh active cart with one unit of the $50 product. Each
  // case gets its own cart so a `converted` status from confirm()
  // doesn't bleed across cases.
  async function _freshCart() {
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: v1.id, qty: 1 });
    return c.id;
  }

  // Subtotal 5000, tax @8.75% = 5000*875/10000 = 437.5 -> 438 (banker's
  // round on .5 to even -> 438), shipping 695.
  var SUBTOTAL = 5000;
  var TAX      = 438;
  var SHIP     = 695;

  // ---- (a) no rules: identical to a checkout without the engine -----
  // Baseline: a checkout with NO autoDiscount dep at all.
  var baseCheckout = bShop.checkout.create(_checkoutDeps(query, catalog, cart, order));
  var baseQuote = await baseCheckout.quote({ cart_id: await _freshCart(), ship_to: SHIP_TO, selected_shipping_id: "std" });

  // Same store, engine wired, but zero rules defined.
  var wiredDeps = _checkoutDeps(query, catalog, cart, order);
  wiredDeps.autoDiscount = engine;
  var wiredCheckout = bShop.checkout.create(wiredDeps);
  var noRuleQuote = await wiredCheckout.quote({ cart_id: await _freshCart(), ship_to: SHIP_TO, selected_shipping_id: "std" });

  check("baseline quote has zero discount",            baseQuote.totals.discount_minor === 0);
  check("engine-wired no-rule quote has zero discount", noRuleQuote.totals.discount_minor === 0);
  check("no-rule subtotal byte-identical to baseline",  noRuleQuote.totals.subtotal_minor === baseQuote.totals.subtotal_minor);
  check("no-rule tax byte-identical to baseline",       noRuleQuote.totals.tax_minor === baseQuote.totals.tax_minor);
  check("no-rule shipping byte-identical to baseline",  noRuleQuote.totals.shipping_minor === baseQuote.totals.shipping_minor);
  check("no-rule grand total byte-identical to baseline", noRuleQuote.totals.grand_total_minor === baseQuote.totals.grand_total_minor);
  check("no-rule grand total = sub+tax+ship",           noRuleQuote.totals.grand_total_minor === SUBTOTAL + TAX + SHIP);

  // ---- (b) a matching rule reduces the quote + persists on confirm --
  // $5.00 off any cart over $40.00 — fires (subtotal 5000 >= 4000).
  await engine.defineRule({
    slug:    "five-off-forty",
    title:   "Five off orders over forty",
    trigger: { kind: "cart_total_min", min_minor: 4000 },
    value:   { kind: "amount_off_total", minor: 500 },
  });

  var ruleCartId = await _freshCart();
  var ruleQuote = await wiredCheckout.quote({ cart_id: ruleCartId, ship_to: SHIP_TO, selected_shipping_id: "std" });
  check("matching rule sets discount = engine savings", ruleQuote.totals.discount_minor === 500);
  check("matching rule subtotal unchanged",             ruleQuote.totals.subtotal_minor === SUBTOTAL);
  check("matching rule tax unchanged",                  ruleQuote.totals.tax_minor === TAX);
  check("matching rule shipping unchanged",             ruleQuote.totals.shipping_minor === SHIP);
  check("matching rule grand total drops by the discount",
    ruleQuote.totals.grand_total_minor === SUBTOTAL - 500 + TAX + SHIP);
  check("matching rule grand total < no-rule grand total",
    ruleQuote.totals.grand_total_minor === noRuleQuote.totals.grand_total_minor - 500);

  // Confirm the order and assert the persisted row carries the reduced
  // total + the discount.
  var ruleConfirm = await wiredCheckout.confirm({
    cart_id: ruleCartId, ship_to: SHIP_TO, selected_shipping_id: "std",
    customer: { email: "buyer@example.com", name: "Buyer" },
    idempotency_key: "auto-disc-match-key-0001",
  });
  var placed = await order.get(ruleConfirm.order.id);
  check("confirmed order persists the discount",        placed && placed.discount_minor === 500);
  check("confirmed order persists the reduced subtotal", placed && placed.subtotal_minor === SUBTOTAL);
  check("confirmed order persists the reduced grand total",
    placed && placed.grand_total_minor === SUBTOTAL - 500 + TAX + SHIP);
  // The PaymentIntent is created for the reduced grand total — assert the
  // ACTUAL amount the stub was asked to charge, not merely that it exists.
  check("charged amount = reduced grand total",
    ruleConfirm.payment_intent && _chargeByPi[ruleConfirm.payment_intent.id] === placed.grand_total_minor);

  // recordApplication ran post-commit: the rule's redemption counter
  // bumped and an application row exists for this order.
  var ruleAfter = await engine.getRule("five-off-forty");
  check("recordApplication bumped redemptions_used",    ruleAfter && ruleAfter.redemptions_used === 1);
  var metrics = await engine.metricsForRule({ rule_slug: "five-off-forty" });
  check("recordApplication logged one application",     metrics.applications === 1);
  check("recordApplication logged the savings",         metrics.gross_savings_minor === 500);

  // ---- (c) savings exceeding subtotal is clamped to the subtotal ----
  // A stub engine returning a savings larger than the subtotal: the
  // checkout layer must clamp to [0, subtotal] so the total never goes
  // negative. (The real engine self-clamps amount_off_total; the stub
  // proves the checkout-side clamp independently.)
  var overDeps = _checkoutDeps(query, catalog, cart, order);
  overDeps.autoDiscount = {
    evaluate: async function () {
      return { applied: [{ rule_slug: "over", title: "Over", value_kind: "amount_off_total", savings_minor: 999999 }], skipped: [] };
    },
    recordApplication: async function () { return {}; },
  };
  var overCheckout = bShop.checkout.create(overDeps);
  var overQuote = await overCheckout.quote({ cart_id: await _freshCart(), ship_to: SHIP_TO, selected_shipping_id: "std" });
  check("over-subtotal savings clamped to subtotal",    overQuote.totals.discount_minor === SUBTOTAL);
  check("clamped quote grand total never negative",     overQuote.totals.grand_total_minor >= 0);
  check("clamped quote grand total = tax + shipping",   overQuote.totals.grand_total_minor === TAX + SHIP);

  // ---- (d) a throwing engine falls back to discount 0 ---------------
  var throwDeps = _checkoutDeps(query, catalog, cart, order);
  throwDeps.autoDiscount = {
    evaluate: async function () { throw new Error("engine boom"); },
    recordApplication: async function () { throw new Error("record boom"); },
  };
  var throwCheckout = bShop.checkout.create(throwDeps);
  var throwCartId = await _freshCart();
  var throwQuote = await throwCheckout.quote({ cart_id: throwCartId, ship_to: SHIP_TO, selected_shipping_id: "std" });
  check("throwing engine falls back to zero discount",  throwQuote.totals.discount_minor === 0);
  check("throwing engine grand total = baseline grand",
    throwQuote.totals.grand_total_minor === baseQuote.totals.grand_total_minor);

  // The order still confirms even though the engine throws — and the
  // post-commit recorder swallows its own throw too.
  var throwConfirm = await throwCheckout.confirm({
    cart_id: throwCartId, ship_to: SHIP_TO, selected_shipping_id: "std",
    customer: { email: "buyer2@example.com", name: "Buyer Two" },
    idempotency_key: "auto-disc-throw-key-0001",
  });
  var throwPlaced = await order.get(throwConfirm.order.id);
  check("throwing-engine order still confirms",         throwPlaced && throwPlaced.id != null);
  check("throwing-engine order persists zero discount", throwPlaced && throwPlaced.discount_minor === 0);

  // ---- (e) a post-commit recordApplication throw never reverses the order --
  // evaluate SUCCEEDS (so the recorder DOES run, unlike (d) where the engine
  // throws first and there is nothing to record), but recordApplication
  // throws — the order must still place and persist the applied discount,
  // proving the post-commit recorder is drop-silent.
  var recDeps = _checkoutDeps(query, catalog, cart, order);
  recDeps.autoDiscount = {
    evaluate: async function () {
      return { applied: [{ rule_slug: "rec", title: "Rec", value_kind: "amount_off_total", savings_minor: 300 }], skipped: [] };
    },
    recordApplication: async function () { throw new Error("recorder boom"); },
  };
  var recCheckout = bShop.checkout.create(recDeps);
  var recCartId = await _freshCart();
  var recQuote = await recCheckout.quote({ cart_id: recCartId, ship_to: SHIP_TO, selected_shipping_id: "std" });
  check("recorder case: discount applied in the quote", recQuote.totals.discount_minor === 300);
  var recConfirm = await recCheckout.confirm({
    cart_id: recCartId, ship_to: SHIP_TO, selected_shipping_id: "std",
    customer: { email: "buyer3@example.com", name: "Buyer Three" },
    idempotency_key: "auto-disc-rec-key-0001",
  });
  var recPlaced = await order.get(recConfirm.order.id);
  check("recordApplication throw does NOT reverse the order",          recPlaced && recPlaced.id != null);
  check("recordApplication throw: order still persists the discount",  recPlaced && recPlaced.discount_minor === 300);

  // ---- (f) a code-gated rule is dormant without its code -------------
  // $7.00 off, but ONLY when the shopper presents code "SAVE7". The same
  // engine the cart-page coupon entry consults: no code → the rule never
  // fires (totals identical to no-rule); code present → the savings apply,
  // and a CONFIRMED order carrying the code persists the reduced total.
  await engine.defineRule({
    slug:        "save7-code",
    title:       "Seven off with code",
    trigger:     { kind: "cart_total_min", min_minor: 1 },
    value:       { kind: "amount_off_total", minor: 700 },
    unlock_code: "SAVE7",
  });
  // ruleForCode resolves a typed code case-insensitively; an unknown code
  // resolves to null (the uniform "no" the cart route relies on).
  var byCode      = await engine.ruleForCode("save7");
  var byUnknown   = await engine.ruleForCode("NOPE-404");
  check("ruleForCode resolves a known code (case-insensitive)", byCode && byCode.slug === "save7-code");
  check("ruleForCode returns null for an unknown code",         byUnknown === null);

  // No code presented → the code-gated rule stays dormant. (The earlier
  // five-off-forty rule still fires automatically, so the discount here is
  // exactly that rule's 500, NOT 500+700.)
  var noCodeCartId = await _freshCart();
  var noCodeQuote  = await wiredCheckout.quote({ cart_id: noCodeCartId, ship_to: SHIP_TO, selected_shipping_id: "std" });
  check("code-gated rule dormant without its code", noCodeQuote.totals.discount_minor === 500);

  // Code presented → the code-gated rule fires on TOP of the automatic.
  var codeCartId = await _freshCart();
  var codeQuote  = await wiredCheckout.quote({ cart_id: codeCartId, ship_to: SHIP_TO, selected_shipping_id: "std", codes: ["SAVE7"] });
  check("code unlocks the gated rule's savings",    codeQuote.totals.discount_minor === 1200);
  check("code grand total drops by the full discount",
    codeQuote.totals.grand_total_minor === SUBTOTAL - 1200 + TAX + SHIP);

  // A confirmed order carrying the code persists the reduced total.
  var codeConfirm = await wiredCheckout.confirm({
    cart_id: codeCartId, ship_to: SHIP_TO, selected_shipping_id: "std",
    customer: { email: "coder@example.com", name: "Coder" },
    codes: ["SAVE7"],
    idempotency_key: "auto-disc-code-key-0001",
  });
  var codePlaced = await order.get(codeConfirm.order.id);
  check("confirmed coded order persists the reduced discount", codePlaced && codePlaced.discount_minor === 1200);
  check("confirmed coded order grand total honours the code",
    codePlaced && codePlaced.grand_total_minor === SUBTOTAL - 1200 + TAX + SHIP);

  // An unknown code presented at quote behaves like no code (the engine
  // simply finds no rule for it) — never a throw, never a phantom discount.
  var badCodeCartId = await _freshCart();
  var badCodeQuote  = await wiredCheckout.quote({ cart_id: badCodeCartId, ship_to: SHIP_TO, selected_shipping_id: "std", codes: ["NOPE-404"] });
  check("unknown code yields only the automatic discount", badCodeQuote.totals.discount_minor === 500);

  // A second active rule can't claim the same code (case-insensitive).
  var dupClaim = false;
  try {
    await engine.defineRule({
      slug: "save7-dupe", title: "Dup", trigger: { kind: "cart_total_min", min_minor: 1 },
      value: { kind: "amount_off_total", minor: 100 }, unlock_code: "save7",
    });
  } catch (_e) { dupClaim = true; }
  check("a second rule can't claim an active code", dupClaim);
}

async function run() { await _run(); }

module.exports = { run: run };
