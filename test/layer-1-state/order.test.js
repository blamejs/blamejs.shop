"use strict";
/**
 * order — FSM-driven post-checkout record.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog), 0002 (cart), 0003 (order). FSM machine itself
 * comes from b.fsm.
 *
 * Coverage:
 *   - createFromCart: persists row, lines, init transition
 *   - get: round-trips with lines + transitions + ship_to JSON
 *   - byPaymentIntent: lookup by payment_intent_id
 *   - transition: legal events succeed, illegal refused
 *   - happy path: pending → paid → fulfilling → shipped → delivered
 *   - cancel + refund branches
 *   - setPaymentIntent: only updates pending orders
 *   - validation: bad inputs at every entry point
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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

function _validUUID() { return bShop.framework.uuid.v7(); }

function _seed(catalog, cart) {
  // Set up: one product, one variant, one cart, with one line.
  return (async function () {
    var p = await catalog.products.create({ slug: "ord-test", title: "OrderTest", status: "active" });
    var v = await catalog.variants.create(p.id, { sku: "ORD-1" });
    await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
    var sessionId = _validUUID();
    var c = await cart.create(sessionId, { currency: "USD" });
    var line = await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
    return { product: p, variant: v, cart: c, line: line, sessionId: sessionId };
  })();
}

function _orderInput(seed) {
  return {
    cart_id:           seed.cart.id,
    session_id:        seed.sessionId,
    currency:          "USD",
    subtotal_minor:    5998,
    discount_minor:    0,
    tax_minor:         525,
    shipping_minor:    695,
    grand_total_minor: 7218,
    ship_to:           { country: "US", state: "CA", postal: "94103" },
    lines: [{
      variant_id:        seed.variant.id,
      sku:               seed.variant.sku,
      qty:               2,
      unit_amount_minor: 2999,
      unit_currency:     "USD",
    }],
  };
}

async function _create() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var seed = await _seed(catalog, cart);

  var o = await order.createFromCart(_orderInput(seed));
  check("order.createFromCart returns id",            typeof o.id === "string" && o.id.length === 36);
  check("order.createFromCart starts in pending",     o.status === "pending");
  check("order.createFromCart sets grand_total",      o.grand_total_minor === 7218);
  check("order.createFromCart embeds lines",          o.lines.length === 1 && o.lines[0].qty === 2);
  check("order.createFromCart computes line_total",   o.lines[0].line_total_minor === 5998);
  check("order.createFromCart parses ship_to_json",   o.ship_to.country === "US" && o.ship_to.state === "CA");
  check("order.createFromCart writes init transition",
    o.transitions.length === 1 && o.transitions[0].from_state === "__init__" && o.transitions[0].to_state === "pending");
}

async function _happyPath() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var seed = await _seed(catalog, cart);
  var o = await order.createFromCart(_orderInput(seed));

  o = await order.transition(o.id, "mark_paid", { reason: "stripe_succeeded" });
  check("pending → paid",          o.status === "paid");
  o = await order.transition(o.id, "start_fulfillment");
  check("paid → fulfilling",        o.status === "fulfilling");
  o = await order.transition(o.id, "mark_shipped", { metadata: { carrier: "ups", tracking: "1Z..." } });
  check("fulfilling → shipped",     o.status === "shipped");
  o = await order.transition(o.id, "mark_delivered");
  check("shipped → delivered",      o.status === "delivered");
  check("delivered is terminal",    bShop.order.TERMINAL_STATES.indexOf(o.status) !== -1);

  check("4 happy-path transitions + init = 5 rows", o.transitions.length === 5);
  check("transition metadata captured",
    JSON.parse(o.transitions[3].metadata_json).carrier === "ups");
}

async function _illegalTransitionRefused() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var seed = await _seed(catalog, cart);
  var o = await order.createFromCart(_orderInput(seed));

  // Can't ship before paying
  await assert.rejects(order.transition(o.id, "mark_shipped"), /refused|unknown/i);
  // Can't deliver from pending
  await assert.rejects(order.transition(o.id, "mark_delivered"), /refused|unknown/i);
  // Unknown event
  await assert.rejects(order.transition(o.id, "teleport"), /refused|unknown/i);
}

async function _cancelAndRefund() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var seed = await _seed(catalog, cart);

  // pending → cancelled
  var o1 = await order.createFromCart(_orderInput(seed));
  o1 = await order.transition(o1.id, "cancel");
  check("pending → cancelled", o1.status === "cancelled");

  // need a new cart (active cart is now used; create a fresh one)
  var sid2 = _validUUID();
  var c2 = await cart.create(sid2, { currency: "USD" });
  await cart.addLine(c2.id, { variant_id: seed.variant.id, qty: 1 });
  var input2 = _orderInput(seed);
  input2.cart_id = c2.id;
  input2.session_id = sid2;
  var o2 = await order.createFromCart(input2);
  o2 = await order.transition(o2.id, "mark_paid");
  o2 = await order.transition(o2.id, "refund", { reason: "customer_request" });
  check("paid → refunded", o2.status === "refunded");
}

async function _setPaymentIntent() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var seed = await _seed(catalog, cart);
  var o = await order.createFromCart(_orderInput(seed));

  var withPi = await order.setPaymentIntent(o.id, "pi_test_abc123");
  check("setPaymentIntent persists pi", withPi.payment_intent_id === "pi_test_abc123");

  // byPaymentIntent finds it
  var found = await order.byPaymentIntent("pi_test_abc123");
  check("byPaymentIntent lookup",        found && found.id === o.id);

  // Once paid, setPaymentIntent refuses (only updates pending)
  await order.transition(o.id, "mark_paid");
  var blocked = await order.setPaymentIntent(o.id, "pi_other");
  check("setPaymentIntent refuses non-pending", blocked === null);
}

async function _listForCustomer() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var seed = await _seed(catalog, cart);
  var customerId = _validUUID();

  // Three orders attached to the same customer — created sequentially
  // so updated_at ordering is meaningful.
  var inputs = [];
  for (var i = 0; i < 3; i += 1) {
    var sid = _validUUID();
    var c   = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: seed.variant.id, qty: 1 });
    var oi = _orderInput(seed);
    oi.cart_id     = c.id;
    oi.session_id  = sid;
    oi.customer_id = customerId;
    var ord = await order.createFromCart(oi);
    inputs.push(ord);
    // Bump updated_at by transitioning so the FIRST inserted order
    // ends up with the LATEST updated_at (and surfaces last in DESC).
    // Reverse the relationship by transitioning earlier orders.
  }
  // Transition the first one (oldest) so its updated_at is bumped
  // past the others — confirms ordering follows updated_at DESC, not
  // created_at. Spin the event loop briefly so Date.now() advances
  // past the previous insert batch's millisecond.
  await helpers.waitUntil(function () { return Date.now() > inputs[2].updated_at; },
    { timeoutMs: 5000, label: "ms tick before transition" });
  await order.transition(inputs[0].id, "mark_paid");

  var page = await order.listForCustomer(customerId, { limit: 10 });
  check("listForCustomer returns 3 rows",       page.rows.length === 3);
  check("listForCustomer rows include lines",    Array.isArray(page.rows[0].lines) && page.rows[0].lines.length === 1);
  check("listForCustomer hydrates ship_to",      page.rows[0].ship_to.country === "US");
  check("listForCustomer next_cursor is null",   page.next_cursor === null);
  // Top row should be the one most recently transitioned (inputs[0]).
  check("listForCustomer orders by updated_at DESC",
    page.rows[0].id === inputs[0].id);

  // Pagination — limit=2 should produce a non-null cursor.
  var pageA = await order.listForCustomer(customerId, { limit: 2 });
  check("listForCustomer paginates",             pageA.rows.length === 2 && typeof pageA.next_cursor === "string");
  var pageB = await order.listForCustomer(customerId, { limit: 2, cursor: pageA.next_cursor });
  check("listForCustomer cursor pages forward",  pageB.rows.length === 1);
  var seen = {};
  pageA.rows.concat(pageB.rows).forEach(function (r) { seen[r.id] = true; });
  check("listForCustomer covers all orders",     Object.keys(seen).length === 3);

  // Other customers' orders are excluded.
  var emptyPage = await order.listForCustomer(_validUUID(), { limit: 10 });
  check("listForCustomer scopes by customer_id", emptyPage.rows.length === 0);

  // Cursor tamper — supply a cursor signed by a different secret
  var otherOrder = bShop.order.create({ query: q, cursorSecret: "different-secret-entirely" });
  // First produce a valid cursor via the OTHER order's secret
  // referencing the same customer (will throw HMAC-mismatch when
  // decoded by our `order` instance).
  await otherOrder.listForCustomer(customerId, { limit: 2 });   // warm up — no cursor needed
  // Forging by hand: flip the first character (always a base64url data
  // char, never padding) to a guaranteed-different one so the cursor is
  // always actually tampered. Replacing trailing chars with a fixed
  // literal could be a no-op when the cursor already ends in them —
  // which left the cursor valid and the rejection missing (a flake).
  var tampered = (pageA.next_cursor.charAt(0) === "A" ? "B" : "A") + pageA.next_cursor.slice(1);
  await assert.rejects(
    order.listForCustomer(customerId, { limit: 2, cursor: tampered }),
    /cursor/i,
  );

  // Limit validation
  await assert.rejects(order.listForCustomer(customerId, { limit: 0 }),    /limit/);
  await assert.rejects(order.listForCustomer(customerId, { limit: 9999 }), /limit/);
}

async function _hasPurchasedProduct() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var seed = await _seed(catalog, cart);
  var customerId = _validUUID();

  // Customer who hasn't bought anything yet → false.
  check("hasPurchasedProduct false before any order",
    (await order.hasPurchasedProduct(customerId, seed.product.id)) === false);

  // Place a paid order for the product → true.
  var o = await order.createFromCart((function () {
    var oi = _orderInput(seed);
    oi.customer_id = customerId;
    return oi;
  })());
  await order.transition(o.id, "mark_paid");
  check("hasPurchasedProduct true after paid order",
    (await order.hasPurchasedProduct(customerId, seed.product.id)) === true);

  // A different customer has not purchased it → false.
  check("hasPurchasedProduct scopes by customer",
    (await order.hasPurchasedProduct(_validUUID(), seed.product.id)) === false);

  // A different product the customer never bought → false.
  var p2 = await catalog.products.create({ slug: "ord-test-2", title: "OrderTest2", status: "active" });
  check("hasPurchasedProduct scopes by product",
    (await order.hasPurchasedProduct(customerId, p2.id)) === false);

  // A pending order does not count as a purchase.
  var sidP = _validUUID();
  var cP   = await cart.create(sidP, { currency: "USD" });
  await cart.addLine(cP.id, { variant_id: seed.variant.id, qty: 1 });
  var custPending = _validUUID();
  var inputP = _orderInput(seed);
  inputP.cart_id     = cP.id;
  inputP.session_id  = sidP;
  inputP.customer_id = custPending;
  await order.createFromCart(inputP);   // stays pending
  check("hasPurchasedProduct excludes pending orders",
    (await order.hasPurchasedProduct(custPending, seed.product.id)) === false);

  // A cancelled order does not count as a purchase.
  var sidC = _validUUID();
  var cC   = await cart.create(sidC, { currency: "USD" });
  await cart.addLine(cC.id, { variant_id: seed.variant.id, qty: 1 });
  var custCancel = _validUUID();
  var inputC = _orderInput(seed);
  inputC.cart_id     = cC.id;
  inputC.session_id  = sidC;
  inputC.customer_id = custCancel;
  var oc = await order.createFromCart(inputC);
  await order.transition(oc.id, "cancel");
  check("hasPurchasedProduct excludes cancelled orders",
    (await order.hasPurchasedProduct(custCancel, seed.product.id)) === false);

  // A refunded order still counts as a purchase (the buyer is verified).
  var sidR = _validUUID();
  var cR   = await cart.create(sidR, { currency: "USD" });
  await cart.addLine(cR.id, { variant_id: seed.variant.id, qty: 1 });
  var custRefund = _validUUID();
  var inputR = _orderInput(seed);
  inputR.cart_id     = cR.id;
  inputR.session_id  = sidR;
  inputR.customer_id = custRefund;
  var orf = await order.createFromCart(inputR);
  orf = await order.transition(orf.id, "mark_paid");
  await order.transition(orf.id, "refund", { reason: "customer_request" });
  check("hasPurchasedProduct includes refunded orders",
    (await order.hasPurchasedProduct(custRefund, seed.product.id)) === true);

  // Bad UUIDs throw TypeError on either argument.
  await assert.rejects(order.hasPurchasedProduct("not-a-uuid", seed.product.id), /customer id/);
  await assert.rejects(order.hasPurchasedProduct(customerId, "not-a-uuid"),       /product id/);
}

async function _validation() {
  var q = _makeQuery();
  var order = bShop.order.create({ query: q });
  await assert.rejects(order.createFromCart(),                              /input object required/);
  await assert.rejects(order.createFromCart({}),                             /cart_id/);
  await assert.rejects(order.createFromCart({ cart_id: "not-a-uuid" }),       /cart_id/);
  var validUUID = _validUUID();
  await assert.rejects(order.createFromCart({
    cart_id:    validUUID,
    session_id: validUUID,
    lines:      [],
  }), /lines must be a non-empty/);
  await assert.rejects(order.transition(),                                   /order id/);
  await assert.rejects(order.transition(validUUID, ""),                       /event must be/);
  await assert.rejects(order.transition(validUUID, "mark_paid"),              /not found/);
}

// ---- settlement is crash-safe (per-SKU try/catch + loud capture) ------
//
// A decrement throw on the paid edge must NOT propagate out of transition
// (the payment already succeeded; the webhook must 2xx or Stripe retries
// forever and the already-advanced guard then strands the hold silently).
// Instead the failure is caught per SKU, the order still advances to paid,
// the OTHER SKUs in the loop still settle, and the failure surfaces loudly
// (audit event + a durable error-log row) for manual reconciliation.
async function _settlementFailureIsCrashSafe() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });

  // Two products so the order holds two SKUs; the failing dep throws for the
  // FIRST and succeeds for the SECOND, proving the loop continues.
  var pA = await catalog.products.create({ slug: "set-a", title: "SetA", status: "active" });
  var vA = await catalog.variants.create(pA.id, { sku: "SET-A" });
  await catalog.prices.set(vA.id, { currency: "USD", amount_minor: 1000 });
  var pB = await catalog.products.create({ slug: "set-b", title: "SetB", status: "active" });
  var vB = await catalog.variants.create(pB.id, { sku: "SET-B" });
  await catalog.prices.set(vB.id, { currency: "USD", amount_minor: 1000 });

  var sid = _validUUID();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: vA.id, qty: 2 });
  await cart.addLine(c.id, { variant_id: vB.id, qty: 1 });

  // Inventory dep: decrement throws for SET-A, succeeds (records) for SET-B.
  var decremented = [];
  var failingInventory = {
    decrement: async function (sku, qty) {
      if (sku === "SET-A") throw new Error("injected: transient DB failure on decrement");
      decremented.push({ sku: sku, qty: qty });
      return { ok: true };
    },
    release: async function () { return { ok: true }; },
  };
  // Error-log stub captures the durable row the settlement failure writes.
  var captured = [];
  var errorLog = {
    captureServerError: async function (input) { captured.push(input); return { id: "e1", occurred_at: Date.now() }; },
  };

  var order = bShop.order.create({ query: q, inventory: failingInventory, errorLog: errorLog });
  var o = await order.createFromCart({
    cart_id: c.id, session_id: sid, currency: "USD",
    subtotal_minor: 3000, discount_minor: 0, tax_minor: 0, shipping_minor: 0, grand_total_minor: 3000,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    lines: [
      { variant_id: vA.id, sku: "SET-A", qty: 2, unit_amount_minor: 1000, unit_currency: "USD", stock_held_qty: 2 },
      { variant_id: vB.id, sku: "SET-B", qty: 1, unit_amount_minor: 1000, unit_currency: "USD", stock_held_qty: 1 },
    ],
  });

  // The transition must RESOLVE (not throw) despite the SET-A decrement throw.
  var settled = null;
  var threw = null;
  try { settled = await order.transition(o.id, "mark_paid", { reason: "stripe_succeeded" }); }
  catch (e) { threw = e; }
  check("settlement: transition does NOT throw on a decrement failure", threw === null);
  check("settlement: order still advances to paid",                     settled && settled.status === "paid");
  check("settlement: the OTHER SKU still settled",
    decremented.length === 1 && decremented[0].sku === "SET-B" && decremented[0].qty === 1);
  check("settlement: failure captured to the error feed",               captured.length === 1);
  check("settlement: capture names the stranded sku/qty/order",
    captured[0].message.indexOf("SET-A") !== -1 &&
    captured[0].message.indexOf("qty=2") !== -1 &&
    captured[0].message.indexOf(o.id) !== -1);
  check("settlement: capture is a 5xx server-error row",                captured[0].status === 500);
}

// ---- transition claim guard: a lost race is a no-op -------------------
//
// transition() is a read-then-write — it SELECTs the order, replays the
// FSM from that snapshot, then writes the new state. The write is guarded
// `WHERE id = ? AND status = <snapshot>`, so a concurrent writer that moved
// the order between the SELECT and the UPDATE wins and this transition
// collapses to a no-op: no state overwrite, no order_transitions row, and —
// critically — no inventory settlement, which would otherwise double-release
// or double-decrement a hold the winning edge already settled. This is the
// guard that closes the stale-order-reaper vs payment-webhook oversell race.
// The race is made deterministic by a query wrapper that moves the order to
// `cancelled` immediately after transition's snapshot SELECT returns pending.
async function _claimGuardLostRace() {
  var base = _makeQuery();
  var armed = false;
  var fired = false;
  var q = async function (sql, params) {
    var isSnapshotSelect = /^\s*SELECT \* FROM orders WHERE id = \?1\s*$/i.test(sql);
    var res = await base(sql, params);
    if (armed && !fired && isSnapshotSelect) {
      // The concurrent writer (e.g. a payment webhook or the reaper) moves
      // the order out of `pending` after we snapshot it but before our
      // guarded UPDATE lands.
      fired = true;
      await base("UPDATE orders SET status = 'cancelled' WHERE id = ?1", [params[0]]);
    }
    return res;
  };

  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var released = [];
  var decremented = [];
  var inventory = {
    release:   async function (sku, qty) { released.push({ sku: sku, qty: qty }); return { ok: true }; },
    decrement: async function (sku, qty) { decremented.push({ sku: sku, qty: qty }); return { ok: true }; },
  };
  var order = bShop.order.create({ query: q, inventory: inventory });
  var seed = await _seed(catalog, cart);

  // A real hold on the line, so settlement WOULD fire absent the guard —
  // the test would regress (release/decrement called) if the guard were lost.
  var oi = _orderInput(seed);
  oi.lines[0].stock_held_qty = 2;
  var o = await order.createFromCart(oi);
  check("claim-guard: order starts pending", o.status === "pending");

  armed = true;
  var result = await order.transition(o.id, "mark_paid", { reason: "stripe_succeeded" });
  armed = false;

  check("claim-guard: lost race returns the winner's state (cancelled, not paid)",
    result && result.status === "cancelled");
  check("claim-guard: no inventory settlement on the losing edge",
    decremented.length === 0 && released.length === 0);
  var trans = await base(
    "SELECT * FROM order_transitions WHERE order_id = ?1 AND on_event = 'mark_paid'", [o.id]);
  check("claim-guard: no mark_paid transition row written on the lost race",
    trans.rows.length === 0);

  // Control: an unraced transition on a fresh order still advances + settles.
  var sid2 = _validUUID();
  var c2 = await cart.create(sid2, { currency: "USD" });
  await cart.addLine(c2.id, { variant_id: seed.variant.id, qty: 1 });
  var oi2 = _orderInput(seed);
  oi2.cart_id = c2.id;
  oi2.session_id = sid2;
  oi2.lines[0].qty = 1;
  oi2.lines[0].stock_held_qty = 1;
  var o2 = await order.createFromCart(oi2);
  var paid = await order.transition(o2.id, "mark_paid");
  check("claim-guard: an unraced transition still advances to paid + settles",
    paid.status === "paid" && decremented.length === 1 && decremented[0].qty === 1);
}

async function run() {
  await _create();
  await _happyPath();
  await _illegalTransitionRefused();
  await _cancelAndRefund();
  await _setPaymentIntent();
  await _listForCustomer();
  await _hasPurchasedProduct();
  await _validation();
  await _settlementFailureIsCrashSafe();
  await _claimGuardLostRace();
}

module.exports = { run: run };
