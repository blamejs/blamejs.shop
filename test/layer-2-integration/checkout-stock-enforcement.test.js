"use strict";
/**
 * Checkout stock enforcement — oversell refusal, paid debit, cancel
 * release, pre-order exemption, and concurrent-confirm serialization.
 *
 * Stitches the real checkout orchestrator over the real catalog / cart /
 * order / pricing / tax / shipping primitives against in-memory SQLite,
 * with payment outbound stubbed (the webhook VERIFIER is the real HMAC
 * path). This is the buy-path counterpart to the layer-1 inventory math:
 * it proves the holds are placed at confirm, converted to a shelf debit
 * when the order is paid, released when a pending order is cancelled, and
 * skipped for a pre-order SKU — and that two confirms racing for the last
 * unit can't both win.
 *
 * Network: zero — every call is in-process; payment.verifyWebhook is
 * local HMAC, no call to Stripe.
 */

var nodeFs     = require("node:fs");
var nodePath   = require("node:path");
var nodeCrypto = require("node:crypto");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql",
  "0008_inventory_thresholds.sql", "0124_preorder.sql", "0206_orders_email_hash.sql"]
  .map(function (f) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f); });

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

function _fakePayment(webhookSecret, opts) {
  opts = opts || {};
  var real = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: webhookSecret });
  var n = 0;
  var cancels = [];
  var fake = {
    name: "fake-stripe",
    verifyWebhook: real.verifyWebhook,
    cancels: cancels,
    createPaymentIntent: async function (input) {
      n += 1;
      return { id: "pi_test_" + n, client_secret: "pi_test_" + n + "_secret_x", status: "requires_payment_method", amount: input.amount_minor, currency: input.currency };
    },
    // The reaper cancels the PaymentIntent BEFORE cancelling the order so a
    // late authorization can't complete after the reap. `cancelBehavior`
    // lets a test force the "PI already succeeded / not cancelable" branch
    // (throw a coded error → the reaper SKIPS the order, leaving it pending).
    cancelPaymentIntent: async function (id) {
      cancels.push(id);
      if (opts.cancelBehavior === "already-succeeded") {
        var err = new Error("stripe: cannot cancel a PaymentIntent that has succeeded");
        err.code = "payment_intent_unexpected_state";
        err.statusCode = 400;
        throw err;
      }
      return { id: id, status: "canceled" };
    },
  };
  return fake;
}

function _sign(secret, ts, body) { return nodeCrypto.createHmac("sha256", secret).update(ts + "." + body).digest("hex"); }
function _stripeHeaders(secret, body) {
  var ts = Math.floor(Date.now() / 1000);
  return { "stripe-signature": "t=" + ts + ",v1=" + _sign(secret, ts, body), "content-type": "application/json" };
}
function _succeededEvent(piId) {
  return JSON.stringify({ id: "evt_" + nodeCrypto.randomUUID(), type: "payment_intent.succeeded", data: { object: { id: piId } } });
}

// Build a fully-wired checkout over a fresh DB. `preorder` is passed so a
// pre-order SKU's line is exempt from the hold (mirrors server.js wiring).
async function _harness(opts) {
  opts = opts || {};
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var preorder = bShop.preorder.create({ query: query });
  var order   = bShop.order.create({ query: query, inventory: catalog.inventory });
  var tax     = bShop.tax.create({ rules: [{ country: "US", state: "CA", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var webhookSecret = "whsec_test_" + bShop.framework.crypto.generateToken(8);
  var payment = _fakePayment(webhookSecret, { cancelBehavior: opts.cancelBehavior });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
    preorder: opts.withPreorder ? preorder : null,
  });
  return { query: query, catalog: catalog, cart: cart, order: order, preorder: preorder, checkout: checkout, payment: payment, webhookSecret: webhookSecret };
}

// Seed one product + variant + price + inventory row, return the variant.
async function _seedProduct(catalog, slug, sku, onHand, priceMinor) {
  var p = await catalog.products.create({ slug: slug, title: slug, status: "active" });
  var v = await catalog.variants.create(p.id, { sku: sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: priceMinor || 1000 });
  if (onHand != null) await catalog.inventory.create(sku, { stock_on_hand: onHand });
  return v;
}

async function _cartWith(cart, variant, qty) {
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: variant.id, qty: qty });
  return c;
}

function _confirmInput(cartId) {
  return {
    cart_id: cartId,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
  };
}

// ---- oversell refused at confirm with a friendly coded error ----------

async function _oversellRefused() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "over-1", "OVER-1", 2, 1000);
  var c = await _cartWith(h.cart, v, 5);                 // want 5, only 2 on hand

  var threw = null;
  try { await h.checkout.confirm(_confirmInput(c.id)); }
  catch (e) { threw = e; }
  check("oversell confirm throws",            !!threw);
  check("error is coded INSUFFICIENT_STOCK",  threw && threw.code === "INSUFFICIENT_STOCK");
  check("error message is buyer-friendly",    /in stock/i.test(threw && threw.message || ""));

  // Nothing charged, no order, cart still active, no stock held.
  var inv = await h.catalog.inventory.get("OVER-1");
  check("refused confirm holds no stock",     inv.stock_held === 0);
  var cartAfter = await h.cart.get(c.id);
  check("refused confirm leaves cart active", cartAfter.status === "active");
}

// ---- successful purchase debits stock on the paid transition ----------

async function _purchaseDebitsStock() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "buy-1", "BUY-1", 10, 1000);
  var c = await _cartWith(h.cart, v, 3);

  var res = await h.checkout.confirm(_confirmInput(c.id));
  check("confirm creates pending order",      res.order.status === "pending");

  // Hold placed at confirm — on_hand untouched, held raised.
  var held = await h.catalog.inventory.get("BUY-1");
  check("confirm holds the 3 units",          held.stock_held === 3 && held.stock_on_hand === 10);

  // Stripe says paid → the webhook drives mark_paid → debit.
  var body = _succeededEvent(res.payment_intent.id);
  var wh = await h.checkout.handleStripeEvent({ headers: _stripeHeaders(h.webhookSecret, body), rawBody: body });
  check("webhook advances order to paid",     wh.order.status === "paid");
  var sold = await h.catalog.inventory.get("BUY-1");
  check("paid debits on_hand to 7",           sold.stock_on_hand === 7);
  check("paid clears the hold",               sold.stock_held === 0);

  // Re-delivery of the same event is idempotent — no double debit.
  var wh2 = await h.checkout.handleStripeEvent({ headers: _stripeHeaders(h.webhookSecret, body), rawBody: body });
  check("re-delivery is skipped",             wh2.skipped === "already-advanced");
  var still = await h.catalog.inventory.get("BUY-1");
  check("re-delivery does not double-debit",  still.stock_on_hand === 7 && still.stock_held === 0);
}

// ---- cancel of a pending order releases the hold ----------------------

async function _cancelReleasesHold() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "cxl-1", "CXL-1", 4, 1000);
  var c = await _cartWith(h.cart, v, 4);

  var res = await h.checkout.confirm(_confirmInput(c.id));
  var held = await h.catalog.inventory.get("CXL-1");
  check("confirm holds all 4",                held.stock_held === 4);

  // payment_intent.canceled → cancel transition → release.
  await h.order.transition(res.order.id, "cancel", { reason: "expired" });
  var freed = await h.catalog.inventory.get("CXL-1");
  check("cancel releases the hold",           freed.stock_held === 0);
  check("cancel leaves on_hand intact",       freed.stock_on_hand === 4);

  // The freed stock is purchasable again — a fresh confirm holds it.
  var c2 = await _cartWith(h.cart, v, 4);
  var res2 = await h.checkout.confirm(_confirmInput(c2.id));
  check("freed stock re-sellable",            res2.order.status === "pending");
  var reheld = await h.catalog.inventory.get("CXL-1");
  check("re-confirm holds the freed 4",       reheld.stock_held === 4);
}

// ---- refund does NOT auto-restock (operator restocks by hand) ---------

async function _refundDoesNotRestock() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "rfd-1", "RFD-1", 5, 1000);
  var c = await _cartWith(h.cart, v, 2);
  var res = await h.checkout.confirm(_confirmInput(c.id));
  var body = _succeededEvent(res.payment_intent.id);
  await h.checkout.handleStripeEvent({ headers: _stripeHeaders(h.webhookSecret, body), rawBody: body });
  var afterPaid = await h.catalog.inventory.get("RFD-1");
  check("paid debited to 3",                  afterPaid.stock_on_hand === 3);

  await h.order.transition(res.order.id, "refund", { reason: "return" });
  var afterRefund = await h.catalog.inventory.get("RFD-1");
  check("refund does NOT restock on_hand",    afterRefund.stock_on_hand === 3);
  check("refund leaves held at 0",            afterRefund.stock_held === 0);
}

// ---- pre-order SKU is exempt from the hold ----------------------------

async function _preorderExempt() {
  var h = await _harness({ withPreorder: true });
  // Seed a SKU at zero on hand, then open a pre-order campaign for it.
  var v = await _seedProduct(h.catalog, "pre-1", "PRE-1", 0, 1500);
  await h.preorder.defineCampaign({
    slug: "pre-1-launch", sku: "PRE-1", launch_at: Date.now() + 86400000,
    full_price_minor: 1500, currency: "USD",
  });
  var c = await _cartWith(h.cart, v, 3);                 // 3 units, zero shelf

  // A non-exempt SKU at zero would refuse here; the pre-order exemption
  // lets the confirm through with no hold placed.
  var res = await h.checkout.confirm(_confirmInput(c.id));
  check("preorder line confirms despite 0 stock", res.order.status === "pending");
  var inv = await h.catalog.inventory.get("PRE-1");
  check("preorder line places no hold",       inv.stock_held === 0);

  // Paying it does not drive on_hand negative (nothing was held).
  var body = _succeededEvent(res.payment_intent.id);
  await h.checkout.handleStripeEvent({ headers: _stripeHeaders(h.webhookSecret, body), rawBody: body });
  var after = await h.catalog.inventory.get("PRE-1");
  check("preorder paid leaves on_hand at 0",  after.stock_on_hand === 0 && after.stock_held === 0);
}

// ---- concurrent confirms: one wins, one gets the friendly refusal -----

async function _concurrentConfirms() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "race-1", "RACE-1", 1, 1000);   // ONE unit
  var c1 = await _cartWith(h.cart, v, 1);
  var c2 = await _cartWith(h.cart, v, 1);

  var results = await Promise.all([
    h.checkout.confirm(_confirmInput(c1.id)).then(
      function (r) { return { ok: true, r: r }; },
      function (e) { return { ok: false, e: e }; }),
    h.checkout.confirm(_confirmInput(c2.id)).then(
      function (r) { return { ok: true, r: r }; },
      function (e) { return { ok: false, e: e }; }),
  ]);

  var wins = results.filter(function (x) { return x.ok; });
  var losses = results.filter(function (x) { return !x.ok; });
  check("exactly one confirm wins",           wins.length === 1);
  check("exactly one confirm loses",          losses.length === 1);
  check("loser is INSUFFICIENT_STOCK",        losses[0].e && losses[0].e.code === "INSUFFICIENT_STOCK");

  // The shelf holds exactly the one unit the winner reserved — never two.
  var inv = await h.catalog.inventory.get("RACE-1");
  check("exactly one unit held — no oversell", inv.stock_held === 1);
  check("on_hand still 1 (debit waits for paid)", inv.stock_on_hand === 1);
}

// ---- stale-pending-order reaper ---------------------------------------

// A pending order older than the TTL is cancelled (PI cancelled first, then
// the order), its hold released; a RECENT pending order is left untouched; a
// PAID order is never a candidate. The reaper drives `now` forward instead
// of sleeping so the staleness window is deterministic.
async function _reaperCancelsStalePending() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "reap-1", "REAP-1", 10, 1000);
  var c = await _cartWith(h.cart, v, 3);
  var res = await h.checkout.confirm(_confirmInput(c.id));
  check("reaper: confirm holds 3",            (await h.catalog.inventory.get("REAP-1")).stock_held === 3);

  // now = order time + 121 minutes → past the 120-minute default TTL.
  var future = Date.now() + 121 * 60 * 1000;
  var summary = await h.checkout.reapStalePending({ ttl_minutes: 120, now: future });
  check("reaper: ok summary",                 summary.ok === true);
  check("reaper: scanned the stale order",    summary.scanned === 1);
  check("reaper: reaped one",                 summary.reaped === 1);
  check("reaper: cancelled the PI first",     h.payment.cancels.indexOf(res.payment_intent.id) !== -1);

  var order = await h.order.get(res.order.id);
  check("reaper: order is cancelled",         order.status === "cancelled");
  var inv = await h.catalog.inventory.get("REAP-1");
  check("reaper: hold released",              inv.stock_held === 0);
  check("reaper: on_hand intact (never sold)",inv.stock_on_hand === 10);
}

async function _reaperLeavesRecentPending() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "reap-2", "REAP-2", 5, 1000);
  var c = await _cartWith(h.cart, v, 2);
  var res = await h.checkout.confirm(_confirmInput(c.id));

  // now = just after the order; well inside the TTL window → not stale.
  var summary = await h.checkout.reapStalePending({ ttl_minutes: 120, now: Date.now() + 60 * 1000 });
  check("reaper: recent order not scanned",   summary.scanned === 0);
  check("reaper: recent order not reaped",    summary.reaped === 0);
  var order = await h.order.get(res.order.id);
  check("reaper: recent order still pending", order.status === "pending");
  check("reaper: recent hold intact",         (await h.catalog.inventory.get("REAP-2")).stock_held === 2);
}

async function _reaperSkipsPaidOrder() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "reap-3", "REAP-3", 5, 1000);
  var c = await _cartWith(h.cart, v, 2);
  var res = await h.checkout.confirm(_confirmInput(c.id));
  // Pay it — now it's no longer pending, so it can't be a reap candidate.
  var body = _succeededEvent(res.payment_intent.id);
  await h.checkout.handleStripeEvent({ headers: _stripeHeaders(h.webhookSecret, body), rawBody: body });

  var future = Date.now() + 121 * 60 * 1000;
  var summary = await h.checkout.reapStalePending({ ttl_minutes: 120, now: future });
  check("reaper: paid order not a candidate", summary.scanned === 0 && summary.reaped === 0);
  var order = await h.order.get(res.order.id);
  check("reaper: paid order stays paid",      order.status === "paid");
  check("reaper: paid debit untouched",       (await h.catalog.inventory.get("REAP-3")).stock_on_hand === 3);
}

// A stale order whose PI cancel reports already-succeeded is LEFT pending —
// the webhook owns its settlement; cancelling would lose a real sale.
async function _reaperSkipsAlreadySucceededPi() {
  var h = await _harness({ cancelBehavior: "already-succeeded" });
  var v = await _seedProduct(h.catalog, "reap-4", "REAP-4", 5, 1000);
  var c = await _cartWith(h.cart, v, 2);
  var res = await h.checkout.confirm(_confirmInput(c.id));

  var future = Date.now() + 121 * 60 * 1000;
  var summary = await h.checkout.reapStalePending({ ttl_minutes: 120, now: future });
  check("reaper: scanned the order",          summary.scanned === 1);
  check("reaper: skipped as paid",            summary.skipped_paid === 1);
  check("reaper: did NOT reap",               summary.reaped === 0);
  var order = await h.order.get(res.order.id);
  check("reaper: order left pending",         order.status === "pending");
  check("reaper: hold NOT released",          (await h.catalog.inventory.get("REAP-4")).stock_held === 2);
}

// Garbage TTL is refused at the entry point (config-time tier).
async function _reaperRejectsBadTtl() {
  var h = await _harness();
  var threw = null;
  try { await h.checkout.reapStalePending({ ttl_minutes: 1 }); }   // below the 5-minute floor
  catch (e) { threw = e; }
  check("reaper: sub-floor TTL throws",       !!threw && threw instanceof TypeError);
}

// ---- conditional rollback — a created order owns its holds -------------

// A throw AFTER the pending order is created must NOT release the holds (the
// order owns them; the reaper/cancel/paid edge settles them). We force a
// post-createFromCart throw by making the cart's setStatus blow up — it runs
// after createFromCart + the PI in _confirmAfterHolds.
async function _rollbackKeepsHoldsAfterOrderCreated() {
  var h = await _harness();
  var v = await _seedProduct(h.catalog, "roll-1", "ROLL-1", 6, 1000);
  var c = await _cartWith(h.cart, v, 4);

  var realSetStatus = h.cart.setStatus.bind(h.cart);
  var orderIdSeen = null;
  h.cart.setStatus = async function (cartId, status) {
    // Capture the just-created order so the test can assert it persisted.
    var recent = await h.order.listRecent({ limit: 1 });
    orderIdSeen = recent.rows.length ? recent.rows[0].id : null;
    throw new Error("injected: setStatus failed AFTER the order was created");
  };

  var threw = null;
  try { await h.checkout.confirm(_confirmInput(c.id)); }
  catch (e) { threw = e; }
  h.cart.setStatus = realSetStatus;

  check("rollback: confirm surfaced the throw", !!threw);
  check("rollback: a pending order WAS created", typeof orderIdSeen === "string");
  // The order owns the holds — they must NOT have been blanket-released.
  var inv = await h.catalog.inventory.get("ROLL-1");
  check("rollback: holds NOT released (order owns them)", inv.stock_held === 4);
  // And the order really exists in pending with its hold metadata.
  var order = await h.order.get(orderIdSeen);
  check("rollback: order is pending",          order.status === "pending");
}

// A throw BEFORE any order is created (insufficient stock for a SECOND line
// after the first holds) releases every placed hold — the existing rollback
// behavior, preserved. Two lines: line A holds, line B oversells → the whole
// pass rolls back, line A's hold freed, no order created.
async function _rollbackReleasesHoldsBeforeOrderCreated() {
  var h = await _harness();
  var vA = await _seedProduct(h.catalog, "rba-1", "RBA-1", 5, 1000);
  var vB = await _seedProduct(h.catalog, "rbb-1", "RBB-1", 1, 1000);
  var sid = bShop.framework.uuid.v7();
  var c = await h.cart.create(sid, { currency: "USD" });
  await h.cart.addLine(c.id, { variant_id: vA.id, qty: 2 });   // holds 2
  await h.cart.addLine(c.id, { variant_id: vB.id, qty: 3 });   // oversells (1 on hand)

  var threw = null;
  try { await h.checkout.confirm(_confirmInput(c.id)); }
  catch (e) { threw = e; }
  check("rollback-pre: oversell refused",      !!threw && threw.code === "INSUFFICIENT_STOCK");
  check("rollback-pre: line-A hold released",  (await h.catalog.inventory.get("RBA-1")).stock_held === 0);
  check("rollback-pre: line-B held nothing",   (await h.catalog.inventory.get("RBB-1")).stock_held === 0);
  check("rollback-pre: no order created",      (await h.order.listRecent({ limit: 5 })).rows.length === 0);
}

// ---- preorder past launch_at enforces holds ---------------------------

async function _preorderPastLaunchEnforcesHolds() {
  var h = await _harness({ withPreorder: true });
  var v = await _seedProduct(h.catalog, "pre-past", "PRE-PAST", 1, 1500);   // ONE real unit
  // launch_at in the PAST → the SKU sells against real stock now; the hold
  // exemption no longer applies, so a 3-unit order against 1 on-hand refuses.
  await h.preorder.defineCampaign({
    slug: "pre-past-launch", sku: "PRE-PAST", launch_at: Date.now() - 86400000,
    full_price_minor: 1500, currency: "USD",
  });
  var c = await _cartWith(h.cart, v, 3);

  var threw = null;
  try { await h.checkout.confirm(_confirmInput(c.id)); }
  catch (e) { threw = e; }
  check("preorder past-launch: oversell refused", !!threw && threw.code === "INSUFFICIENT_STOCK");
  check("preorder past-launch: no stranded hold", (await h.catalog.inventory.get("PRE-PAST")).stock_held === 0);

  // A single unit (within stock) DOES go through and places a real hold —
  // proving the line is now hold-ENFORCED, not exempt.
  var c2 = await _cartWith(h.cart, v, 1);
  var res = await h.checkout.confirm(_confirmInput(c2.id));
  check("preorder past-launch: in-stock confirm OK", res.order.status === "pending");
  check("preorder past-launch: real hold placed",    (await h.catalog.inventory.get("PRE-PAST")).stock_held === 1);
}

async function run() {
  await _oversellRefused();
  await _purchaseDebitsStock();
  await _cancelReleasesHold();
  await _refundDoesNotRestock();
  await _preorderExempt();
  await _concurrentConfirms();
  await _reaperCancelsStalePending();
  await _reaperLeavesRecentPending();
  await _reaperSkipsPaidOrder();
  await _reaperSkipsAlreadySucceededPi();
  await _reaperRejectsBadTtl();
  await _rollbackKeepsHoldsAfterOrderCreated();
  await _rollbackReleasesHoldsBeforeOrderCreated();
  await _preorderPastLaunchEnforcesHolds();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("checkout-stock-enforcement OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("checkout-stock-enforcement FAIL: " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
