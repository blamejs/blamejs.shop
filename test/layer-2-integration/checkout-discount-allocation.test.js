"use strict";
/**
 * Checkout discount-allocation wiring — when a placed order carried a
 * cart-level discount, checkout records (post-commit, drop-silent) how
 * that discount split across the order lines, so a later partial refund
 * knows each line's discounted share. All assertions in minor units.
 *
 * The recording is back-office bookkeeping with ZERO impact on the
 * charged amount. This pins that contract:
 *
 *   (a) a confirmed order with a discount has a recorded allocation whose
 *       per-line allocated amounts SUM EXACTLY to discount_minor.
 *   (b) the order total + the amount the payment stub was asked to charge
 *       are UNCHANGED by the allocation recording (no charge impact) — the
 *       charged amount equals the reduced grand total either way.
 *   (c) a recordAllocation that THROWS does not fail or reverse the order
 *       (drop-silent) — the order still places and persists its discount.
 *   (d) a zero-discount order records NOTHING (no-op): no allocation row.
 *   (e) the admin screen renders a recorded allocation's breakdown.
 *
 * Shared one in-memory SQLite handle across catalog + cart + order + the
 * auto-discount engine + the discount-allocation recorder, so a confirmed
 * order's allocation row lands in the same store the test reads back.
 *
 * Network: zero — payment is a stub, no HTTP.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop              = require("../../lib");
var autoDiscount       = require("../../lib/auto-discount");
var discountAllocation = require("../../lib/discount-allocation");
var admin              = require("../../lib/admin");
var helpers            = require("../helpers");
var check              = helpers.check;
var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0107_auto_discount.sql", "0231_auto_discount_application_unique.sql",
  "0209_auto_discount_unlock_code.sql", "0129_discount_allocation.sql",
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
  // two confirms must not collide.
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      _piSeq += 1;
      var _id = "pi_da_" + _piSeq;
      _chargeByPi[_id] = input.amount_minor;
      return { id: _id, client_secret: _id + "_secret", status: "requires_payment_method", _amount: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

function _checkoutDeps(catalog, cart, order) {
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

function _sumAllocated(breakdown) {
  var s = 0;
  for (var i = 0; i < breakdown.length; i += 1) s += breakdown[i].allocated_minor;
  return s;
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "disc-alloc-sf" });
  var engine  = autoDiscount.create({ query: query });
  var alloc   = discountAllocation.create({ query: query });

  // Two products so the discount has more than one line to split across:
  // a $30 widget and a $50 gadget.
  var p1 = await catalog.products.create({ slug: "widget", title: "Widget", status: "active" });
  var v1 = await catalog.variants.create(p1.id, { sku: "WID-1", weight_grams: 100 });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 3000 });
  await catalog.inventory.create("WID-1", { stock_on_hand: 100 });

  var p2 = await catalog.products.create({ slug: "gadget", title: "Gadget", status: "active" });
  var v2 = await catalog.variants.create(p2.id, { sku: "GAD-1", weight_grams: 100 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 5000 });
  await catalog.inventory.create("GAD-1", { stock_on_hand: 100 });

  // A fresh active cart with one of each product (subtotal 8000). Each
  // case gets its own cart so a `converted` status doesn't bleed across.
  async function _freshCart() {
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: v1.id, qty: 1 });
    await cart.addLine(c.id, { variant_id: v2.id, qty: 1 });
    return c.id;
  }

  // Subtotal 8000, tax @8.75% = 8000*875/10000 = 700, shipping 695.
  var SUBTOTAL = 8000;
  var TAX      = 700;            // tax on the full 8000 (the zero-discount case)
  var TAX_DISCOUNTED = 525;      // tax on 6000 after the 2000 discount: 6000*875/10000 = 525
  var SHIP     = 695;

  // A $20.00-off rule that fires on any cart over $40.00.
  await engine.defineRule({
    slug:    "twenty-off-forty",
    title:   "Twenty off orders over forty",
    trigger: { kind: "cart_total_min", min_minor: 4000 },
    value:   { kind: "amount_off_total", minor: 2000 },
  });
  var DISCOUNT = 2000;

  // ---- (a)+(b) discount order: allocation sums to discount; no charge impact ----
  var deps = _checkoutDeps(catalog, cart, order);
  deps.autoDiscount       = engine;
  deps.discountAllocation = alloc;
  var checkout = bShop.checkout.create(deps);

  var cartId = await _freshCart();
  var quote = await checkout.quote({ cart_id: cartId, ship_to: SHIP_TO, selected_shipping_id: "std" });
  check("quote applies the discount",          quote.totals.discount_minor === DISCOUNT);
  check("quote grand total = sub - disc + discounted tax + ship",
    quote.totals.grand_total_minor === SUBTOTAL - DISCOUNT + TAX_DISCOUNTED + SHIP);

  var confirm = await checkout.confirm({
    cart_id: cartId, ship_to: SHIP_TO, selected_shipping_id: "std",
    customer: { email: "buyer@example.com", name: "Buyer" },
    idempotency_key: "disc-alloc-key-0001",
  });
  var placed = await order.get(confirm.order.id);

  // (b) NO charge impact: the order total + the amount the stub was asked
  // to charge equal the reduced grand total — the allocation recording
  // touched neither.
  var expectedGrand = SUBTOTAL - DISCOUNT + TAX_DISCOUNTED + SHIP;
  check("order persists the discount",         placed && placed.discount_minor === DISCOUNT);
  check("order persists the reduced subtotal", placed && placed.subtotal_minor === SUBTOTAL);
  check("order grand total unchanged by recording", placed && placed.grand_total_minor === expectedGrand);
  check("charged amount = reduced grand total (no charge impact)",
    confirm.payment_intent && _chargeByPi[confirm.payment_intent.id] === expectedGrand);

  // (a) the allocation row exists and its per-line amounts SUM EXACTLY to
  // discount_minor.
  var rows = await alloc.allocationsForOrder(placed.id);
  check("one allocation recorded for the discounted order", rows.length === 1);
  var rec = rows[0];
  check("recorded allocation total = discount_minor", rec.total_minor === DISCOUNT);
  check("recorded allocation kind is proportional",   rec.kind === "proportional");
  check("recorded allocation source is auto_discount", rec.source === "auto_discount");
  check("recorded breakdown has one entry per order line", rec.breakdown.length === 2);
  check("breakdown SUMS EXACTLY to discount_minor",   _sumAllocated(rec.breakdown) === DISCOUNT);

  // Proportional split of 2000 across weights [3000, 5000] (sum 8000):
  // floor-half-even shares 750 / 1250, remainder 0 → exact. The higher-
  // subtotal line (gadget) carries the larger share.
  var byId = {};
  for (var i = 0; i < rec.breakdown.length; i += 1) byId[rec.breakdown[i].line_id] = rec.breakdown[i];
  var alloced = rec.breakdown.map(function (l) { return l.allocated_minor; }).sort(function (a, c) { return a - c; });
  check("proportional split is exactly 750 / 1250",   alloced[0] === 750 && alloced[1] === 1250);

  // The breakdown keys on the PERSISTED order-line ids (not cart-line ids), so
  // a later partial refund — which operates on order lines — can apply it
  // directly. The recorded line_ids must be exactly the placed order's lines.
  var orderLineIds     = placed.lines.map(function (l) { return l.id; }).sort();
  var breakdownLineIds = rec.breakdown.map(function (e) { return e.line_id; }).sort();
  check("breakdown keys on the persisted order-line ids",
    JSON.stringify(breakdownLineIds) === JSON.stringify(orderLineIds));

  // ---- (c) a throwing recordAllocation never fails the order ----------
  // evaluate SUCCEEDS so the recorder runs; recordAllocation throws — the
  // order must still place and persist the discount (drop-silent).
  var throwDeps = _checkoutDeps(catalog, cart, order);
  throwDeps.autoDiscount = engine;
  throwDeps.discountAllocation = {
    allocate: function (input) { return alloc.allocate(input); },
    recordAllocation: async function () { throw new Error("alloc record boom"); },
    allocationsForOrder: async function () { return []; },
  };
  var throwCheckout = bShop.checkout.create(throwDeps);
  var throwCartId = await _freshCart();
  var throwConfirm = await throwCheckout.confirm({
    cart_id: throwCartId, ship_to: SHIP_TO, selected_shipping_id: "std",
    customer: { email: "buyer2@example.com", name: "Buyer Two" },
    idempotency_key: "disc-alloc-throw-key-0001",
  });
  var throwPlaced = await order.get(throwConfirm.order.id);
  check("recordAllocation throw does NOT reverse the order", throwPlaced && throwPlaced.id != null);
  check("recordAllocation throw: order still persists the discount", throwPlaced && throwPlaced.discount_minor === DISCOUNT);
  check("recordAllocation throw: charged amount still the reduced grand total",
    throwConfirm.payment_intent && _chargeByPi[throwConfirm.payment_intent.id] === expectedGrand);

  // ---- (d) a zero-discount order records NOTHING ----------------------
  // No autoDiscount dep at all → discount_minor is 0 → the recorder is a
  // no-op, so allocationsForOrder returns an empty list for that order.
  var zeroDeps = _checkoutDeps(catalog, cart, order);
  zeroDeps.discountAllocation = alloc;     // recorder IS wired — it must still no-op on a zero discount
  var zeroCheckout = bShop.checkout.create(zeroDeps);
  var zeroCartId = await _freshCart();
  var zeroQuote = await zeroCheckout.quote({ cart_id: zeroCartId, ship_to: SHIP_TO, selected_shipping_id: "std" });
  check("zero-discount quote has zero discount", zeroQuote.totals.discount_minor === 0);
  var zeroConfirm = await zeroCheckout.confirm({
    cart_id: zeroCartId, ship_to: SHIP_TO, selected_shipping_id: "std",
    customer: { email: "buyer3@example.com", name: "Buyer Three" },
    idempotency_key: "disc-alloc-zero-key-0001",
  });
  var zeroPlaced = await order.get(zeroConfirm.order.id);
  var zeroRows = await alloc.allocationsForOrder(zeroPlaced.id);
  check("zero-discount order records NO allocation", zeroRows.length === 0);
  check("zero-discount charged the full grand total",
    zeroConfirm.payment_intent && _chargeByPi[zeroConfirm.payment_intent.id] === SUBTOTAL + TAX + SHIP);

  // ---- (e) the admin screen renders a recorded allocation -------------
  var html = admin.renderAdminDiscountAllocation({
    shop_name:     "Test Shop",
    nav_available: { discountAllocation: true },
    order_id:      placed.id,
    allocations:   rows,
    notice:        null,
  });
  check("admin screen is a string",            typeof html === "string" && html.length > 0);
  check("admin screen shows the page heading", html.indexOf("Discount splits") !== -1);
  check("admin screen shows the source",       html.indexOf("auto_discount") !== -1);
  check("admin screen shows the discount total", html.indexOf(">" + DISCOUNT + "<") !== -1);
  check("admin screen renders the larger line share", html.indexOf(">1250<") !== -1);
  check("admin screen renders the smaller line share", html.indexOf(">750<") !== -1);

  // The empty-lookup render path stays a 200 page with a notice, never a throw.
  var emptyHtml = admin.renderAdminDiscountAllocation({
    shop_name:     "Test Shop",
    nav_available: { discountAllocation: true },
    order_id:      "no-such-order",
    allocations:   [],
    notice:        "No discount allocations recorded for that order.",
  });
  check("admin empty-lookup renders the notice", emptyHtml.indexOf("No discount allocations recorded") !== -1);
}

async function run() { await _run(); }

module.exports = { run: run };
