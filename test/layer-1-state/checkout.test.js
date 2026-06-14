"use strict";
/**
 * checkout — orchestrator quote + confirm + webhook dispatch.
 *
 * Layer 1 stitches every prior primitive (catalog, cart, pricing,
 * tax, shipping, payment, order) against in-memory SQLite. Payment
 * outbound HTTP is stubbed via a fake adapter (we test the
 * orchestration, not the Stripe API integration — that's covered by
 * payment.test.js).
 *
 * Coverage:
 *   - quote returns lines + totals + shipping_rates + tax_jurisdiction
 *   - confirm creates a PaymentIntent + order in pending
 *   - confirm marks the cart converted
 *   - confirm refuses zero-total carts
 *   - handleStripeEvent maps payment_intent.succeeded → mark_paid
 *   - handleStripeEvent is idempotent on re-delivery
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");
var nodeCrypto = require("node:crypto");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0218_stripe_webhook_events.sql"].map(function (f) {
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

function _fakePayment(webhookSecret) {
  // Tracks calls for assertion + returns canned responses. Verifier
  // is the real one (via the real payment.create against the secret)
  // so webhook tests exercise the actual HMAC-SHA256 path.
  var real = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: webhookSecret });
  var pi_counter = 0;
  return {
    name: "fake-stripe",
    verifyWebhook: real.verifyWebhook,
    createPaymentIntent: async function (input, idempotencyKey) {
      pi_counter += 1;
      return {
        id:            "pi_test_" + pi_counter,
        client_secret: "pi_test_" + pi_counter + "_secret_xxx",
        status:        "requires_payment_method",
        amount:        input.amount_minor,
        currency:      input.currency,
        metadata:      input.metadata,
        _idempotencyKey: idempotencyKey,
      };
    },
  };
}

async function _setup(opts) {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var tax     = bShop.tax.create({ rules: [
    { country: "US", state: "CA", rate_bps: 875 },
  ]});
  var shipping = bShop.shipping.create({ services: [
    { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] },
  ]});
  var webhookSecret = "whsec_test_" + bShop.framework.crypto.generateToken(8);
  var payment = _fakePayment(webhookSecret);
  // `opts.webhookReplay` (default off) lets a caller opt the replay-defense
  // store in. Off keeps the happy-path test exercising the ORDER-STATE
  // idempotency (a distinct, still-live defense) without the event-id
  // dedupe catching the re-delivery first.
  var checkoutOpts = {
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
  };
  if (opts && opts.webhookReplay) checkoutOpts.webhookReplayQuery = query;
  var checkout = bShop.checkout.create(checkoutOpts);

  // Seed product + variant + price + cart with one line.
  var p = await catalog.products.create({ slug: "co-test", title: "Checkout Test", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "CO-1", weight_grams: 250 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
  var sid = bShop.framework.uuid.v7();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
  return { query: query, catalog: catalog, cart: cart, order: order, payment: payment, checkout: checkout, cartRow: c, sessionId: sid, webhookSecret: webhookSecret, variant: v };
}

async function _quote() {
  var s = await _setup();
  var q = await s.checkout.quote({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
  });
  check("quote returns lines",            q.lines.length === 1);
  check("quote includes shipping rates",   q.shipping_rates.length === 1);
  check("quote selects shipping",          q.selected_shipping.id === "std");
  // subtotal 5998 + tax (5998×875/10000 = 524.825 → banker's 525) + shipping 695 = 7218
  check("quote totals.subtotal",           q.totals.subtotal_minor === 5998);
  check("quote totals.tax",                q.totals.tax_minor === 525);
  check("quote totals.shipping",            q.totals.shipping_minor === 695);
  check("quote totals.grand_total",         q.totals.grand_total_minor === 7218);
  check("quote tax_jurisdiction CA",        q.tax_jurisdiction === "US/CA");
}

async function _confirm() {
  var s = await _setup();
  var idempotencyKey = "idemp_" + nodeCrypto.randomUUID();
  var result = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: idempotencyKey,
  });
  check("confirm returns order",                result.order && result.order.id);
  check("confirm starts in pending",             result.order.status === "pending");
  check("confirm captures payment_intent_id",    result.order.payment_intent_id === result.payment_intent.id);
  check("confirm returns client_secret",         result.payment_intent.client_secret.indexOf("_secret_") !== -1);

  // Cart should now be 'converted'
  var c = await s.cart.get(s.cartRow.id);
  check("confirm marks cart converted",          c.status === "converted");
}

async function _confirmPersistsFullAddress() {
  var s = await _setup();
  var result = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: {
      line1: "500 Market St", line2: "Suite 5", city: "San Francisco",
      country: "US", state: "CA", postal: "94103",
    },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com", name: "Ada Lovelace" },
    idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
  });
  // Re-read through the order model so we exercise the ship_to_json
  // round-trip, not just the in-flight object.
  var stored = await s.order.get(result.order.id);
  check("confirm persists ship_to.line1",  stored.ship_to.line1 === "500 Market St");
  check("confirm persists ship_to.line2",  stored.ship_to.line2 === "Suite 5");
  check("confirm persists ship_to.city",   stored.ship_to.city  === "San Francisco");
  check("confirm persists ship_to.country", stored.ship_to.country === "US");
}

async function _confirmRejectsMalformedAddress() {
  var s = await _setup();
  // A street line beyond the 200-char cap is refused as a client error
  // (TypeError), not silently stored.
  await assert.rejects(s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { line1: "x".repeat(201), city: "Town", country: "US" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
  }), /ship_to\.line1/);
}

async function _confirmRejectsInvalidAddressFormats() {
  var s = await _setup();
  // A rejected confirm never converts the cart, so one setup hosts every
  // reject case; quote (same _shipTo validator, no charge) hosts the
  // accept cases so a missing shipping zone for a non-US destination
  // can't fail an address assertion for the wrong reason.
  function _confirmWith(shipTo, customer) {
    return s.checkout.confirm({
      cart_id: s.cartRow.id,
      ship_to: shipTo,
      selected_shipping_id: "std",
      customer: customer || { email: "buyer@example.com" },
      idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
    });
  }
  // The validator must pass the address BEFORE shipping/zone resolution —
  // accept = quote throws nothing, or throws something that isn't a
  // ship_to error (e.g. no shipping zone for that country).
  async function _addressOk(shipTo) {
    try {
      await s.checkout.quote({ cart_id: s.cartRow.id, ship_to: shipTo, selected_shipping_id: "std" });
      return true;
    } catch (e) {
      return !/ship_to\./.test((e && e.message) || "");
    }
  }

  // Country must be a REAL ISO 3166-1 alpha-2 code, not just two letters —
  // including CLDR-named sentinels that aren't assigned countries (ZZ is
  // the unknown-region sentinel; UK is reserved, the code is GB).
  await assert.rejects(_confirmWith({ country: "XX" }), /ship_to\.country/);
  await assert.rejects(_confirmWith({ country: "ZZ" }), /ship_to\.country/);
  await assert.rejects(_confirmWith({ country: "UK" }), /ship_to\.country/);
  await assert.rejects(_confirmWith({ country: "EU" }), /ship_to\.country/);
  check("country GB accepted", await _addressOk({ country: "GB" }));
  check("country DE accepted", await _addressOk({ country: "DE" }));
  check("country XK (user-assigned, ships) accepted", await _addressOk({ country: "XK" }));

  // US: state must be a real USPS code, postal a real ZIP shape.
  await assert.rejects(_confirmWith({ country: "US", state: "ZZ", postal: "94103" }), /ship_to\.state/);
  await assert.rejects(_confirmWith({ country: "US", state: "CA", postal: "abc" }),   /ship_to\.postal/);
  await assert.rejects(_confirmWith({ country: "US", state: "CA", postal: "99" }),    /ship_to\.postal/);
  check("US ZIP+4 accepted", await _addressOk({ country: "US", state: "CA", postal: "94103-1234" }));

  // Canada: province codes + A1A 1A1 postal (space optional, any case).
  await assert.rejects(_confirmWith({ country: "CA", state: "ON", postal: "99999" }), /ship_to\.postal/);
  await assert.rejects(_confirmWith({ country: "CA", state: "XX", postal: "K1A 0B1" }), /ship_to\.state/);
  check("CA postal with space accepted",  await _addressOk({ country: "CA", state: "ON", postal: "K1A 0B1" }));
  check("CA postal without space accepted", await _addressOk({ country: "CA", state: "ON", postal: "K1A0B1" }));

  // Everywhere else stays lenient — no postal/region format opinions.
  check("GB postcode accepted",          await _addressOk({ country: "GB", postal: "SW1A 1AA" }));
  check("GB without state accepted",     await _addressOk({ country: "GB", city: "London" }));

  // Email shape gate: guardEmail passes plain strings through, so confirm
  // itself must reject a non-address.
  await assert.rejects(_confirmWith({ country: "US", state: "CA", postal: "94103" },
    { email: "not-an-email" }), /customer\.email/);
  await assert.rejects(_confirmWith({ country: "US", state: "CA", postal: "94103" },
    { email: "a@b" }), /customer\.email/);
  // Customer name length cap.
  await assert.rejects(_confirmWith({ country: "US", state: "CA", postal: "94103" },
    { email: "buyer@example.com", name: "x".repeat(121) }), /customer\.name/);
}

async function _digitalOnlyCartCompletesWithoutShippingService() {
  // An all-digital cart (requires_shipping = 0 on every line) gets the
  // physical services filtered out of shipping.rates(), so the caller's
  // default physical id ("std") can never resolve — checkout must fall
  // back to the zero-cost no-shipping selection instead of refusing the
  // order. (The live shape: a $5 digital thank-you product was
  // un-buyable because the shop configures no digital_only service.)
  var s = await _setup();
  var p = await s.catalog.products.create({ slug: "digital-good", title: "Digital Good", status: "active" });
  var v = await s.catalog.variants.create(p.id, { sku: "DIG-1", requires_shipping: false });
  await s.catalog.prices.set(v.id, { currency: "USD", amount_minor: 500 });
  var c = await s.cart.create(bShop.framework.uuid.v7(), { currency: "USD" });
  await s.cart.addLine(c.id, { variant_id: v.id, qty: 1 });

  var q = await s.checkout.quote({
    cart_id: c.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
  });
  check("digital cart quote selects the no-shipping fallback", q.selected_shipping.id === "digital_none");
  check("digital cart ships for zero",                          q.totals.shipping_minor === 0);

  var result = await s.checkout.confirm({
    cart_id: c.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "digital@example.com" },
    idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
  });
  check("digital cart confirm creates the order",  result.order && result.order.id);
  check("digital order records zero shipping",     result.order.shipping_minor === 0);

  // A PHYSICAL cart with an unresolvable service id still throws —
  // that is a real config typo and must surface at the boundary.
  var s2 = await _setup();
  await assert.rejects(s2.checkout.confirm({
    cart_id: s2.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "no-such-service",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_" + nodeCrypto.randomUUID(),
  }), /selected_shipping_id .* not available/);
}

async function _confirmRefusesZeroTotal() {
  // Build a setup where every cost component is zero:
  //   - cart line at 0 minor units
  //   - shipping zone at 0 minor units
  //   - tax 0% (no rules)
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var tax     = bShop.tax.create({ rules: [] });
  var shipping = bShop.shipping.create({ services: [
    { id: "free", label: "Free", zones: [{ country: "US", flat_amount_minor: 0 }] },
  ]});
  var payment = _fakePayment("whsec_zt_xxxxxxxx");
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
  });
  var p = await catalog.products.create({ slug: "zt", title: "ZT", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "ZT-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 0 });
  var c = await cart.create(bShop.framework.uuid.v7(), { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1, unit_amount_minor: 0, unit_currency: "USD" });

  await assert.rejects(checkout.confirm({
    cart_id: c.id,
    ship_to: { country: "US" },
    selected_shipping_id: "free",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_zerototal_xxxxxxxx",
  }), /grand_total_minor must be > 0/);
}

async function _webhookDispatchHappyPath() {
  var s = await _setup();
  var result = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_happy_xxxxxxxx",
  });

  // Build a Stripe webhook event manually.
  var event = {
    id:   "evt_test_1",
    type: "payment_intent.succeeded",
    data: { object: { id: result.payment_intent.id, payment_intent: result.payment_intent.id } },
  };
  var rawBody = JSON.stringify(event);
  var ts = Math.floor(Date.now() / 1000);
  var sig = nodeCrypto.createHmac("sha256", s.webhookSecret).update(ts + "." + rawBody).digest("hex");
  var headers = { "stripe-signature": "t=" + ts + ",v1=" + sig };

  var dispatched = await s.checkout.handleStripeEvent({ headers: headers, rawBody: rawBody });
  check("webhook dispatched ok",              dispatched.handled === true);
  check("webhook fired mark_paid",             dispatched.order.status === "paid");

  // Idempotency: re-deliver the same event.
  var redelivered = await s.checkout.handleStripeEvent({ headers: headers, rawBody: rawBody });
  check("re-delivered webhook is idempotent",  redelivered.handled === true && redelivered.skipped === "already-advanced");
}

async function _webhookBadSig() {
  var s = await _setup();
  var rawBody = "{}";
  var headers = { "stripe-signature": "t=" + Math.floor(Date.now() / 1000) + ",v1=" + "00".repeat(32) };
  await assert.rejects(s.checkout.handleStripeEvent({ headers: headers, rawBody: rawBody }),
    /webhook signature invalid/);
}

// Replay defense: a validly-signed event replayed within the signature
// tolerance window is refused by the event-id dedupe — independent of, and
// AHEAD of, the order-state idempotency. The dedupe is what catches a
// replay the order-state check can't (a refund replay, or a race where the
// order hasn't yet advanced). A DIFFERENT event id is unaffected.
async function _webhookReplayDefense() {
  var s = await _setup({ webhookReplay: true });
  var result = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_replay_xxxxxxxx",
  });

  function _signed(eventId, type) {
    var event = {
      id:   eventId, type: type,
      data: { object: { id: result.payment_intent.id, payment_intent: result.payment_intent.id } },
    };
    var rawBody = JSON.stringify(event);
    var ts = Math.floor(Date.now() / 1000);
    var sig = nodeCrypto.createHmac("sha256", s.webhookSecret).update(ts + "." + rawBody).digest("hex");
    return { headers: { "stripe-signature": "t=" + ts + ",v1=" + sig }, rawBody: rawBody };
  }

  // First delivery of evt_replay_1 → processed (order → paid).
  var d1 = _signed("evt_replay_1", "payment_intent.succeeded");
  var first = await s.checkout.handleStripeEvent(d1);
  check("replay: first delivery processed", first.handled === true && first.order && first.order.status === "paid");
  // The event id is now recorded in the dedupe table.
  var rec = await s.query("SELECT COUNT(*) AS n FROM stripe_webhook_events WHERE event_id = ?1", ["evt_replay_1"]);
  check("replay: first delivery recorded the event id", Number(rec.rows[0].n) === 1);

  // A verbatim replay of the SAME signed event id → refused as a replay
  // no-op (the event-id dedupe short-circuits BEFORE any transition).
  var replayDup = await s.checkout.handleStripeEvent(d1);
  check("replay: re-delivered same event id is a replay no-op",
    replayDup.handled === true && replayDup.skipped === "replay" && replayDup.event_id === "evt_replay_1");

  // A replay carrying a DIFFERENT event id is NOT blocked by the dedupe —
  // it reaches the handler (here it's absorbed by the order-state
  // idempotency since the order is already paid, but it is NOT a replay
  // skip — proving the dedupe keys on event id, not a blanket block).
  var d2 = _signed("evt_replay_2", "payment_intent.succeeded");
  var other = await s.checkout.handleStripeEvent(d2);
  check("replay: a distinct event id is not dedupe-blocked",
    other.handled === true && other.skipped !== "replay");
}

// A refund webhook must record THIS refund's own amount, not the cumulative-
// minus-ledger delta. When two refunds happen close together and refund B's
// webhook is processed while refund A's hasn't recorded yet, the charge shows
// the cumulative (3000 = A's 1000 + B's 2000) but B's own amount is 2000. A
// delta-based mirror records 3000 here (the stale read drives it to the
// cumulative), so when A's delayed webhook then records its own 1000 the ledger
// reaches 4000 — over-counting. Keying on the event's own refund amount records
// 2000 now and 1000 later, converging on the true 3000.
async function _stripeRefundMirrorRecordsOwnAmount() {
  var s = await _setup();
  var conf = await s.checkout.confirm({
    cart_id: s.cartRow.id,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    selected_shipping_id: "std",
    customer: { email: "buyer@example.com" },
    idempotency_key: "idemp_refund_ownamount",
  });
  var pi = conf.payment_intent.id;
  var orderId = conf.order.id;

  function _signed(event) {
    var rawBody = JSON.stringify(event);
    var ts = Math.floor(Date.now() / 1000);
    var sig = nodeCrypto.createHmac("sha256", s.webhookSecret).update(ts + "." + rawBody).digest("hex");
    return { headers: { "stripe-signature": "t=" + ts + ",v1=" + sig }, rawBody: rawBody };
  }

  // Mark the order paid first (grand total 7218, well above the refunds below).
  await s.checkout.handleStripeEvent(_signed({
    id: "evt_paid_refund", type: "payment_intent.succeeded",
    data: { object: { id: pi, payment_intent: pi } },
  }));

  // Refund B's webhook arrives while refund A's is still in flight: cumulative
  // 3000 but B's own amount is 2000, and the ledger has recorded neither yet.
  await s.checkout.handleStripeEvent(_signed({
    id: "evt_refund_b", type: "charge.refunded",
    data: { object: { id: "ch_x", payment_intent: pi, amount_refunded: 3000,
      refunds: { data: [{ id: "re_b", amount: 2000 }] } } },
  }));
  check("mirror records the refund's OWN amount (2000), not the cumulative delta (3000)",
    (await s.order.refundedTotalMinor(orderId)) === 2000);

  // Refund A's delayed webhook then records its own 1000 → the ledger converges
  // on the true cumulative 3000, never the 4000 a delta-based mirror would reach.
  await s.checkout.handleStripeEvent(_signed({
    id: "evt_refund_a", type: "charge.refunded",
    data: { object: { id: "ch_x", payment_intent: pi, amount_refunded: 3000,
      refunds: { data: [{ id: "re_a", amount: 1000 }] } } },
  }));
  check("delayed sibling refund converges the ledger on the true total (3000, not 4000)",
    (await s.order.refundedTotalMinor(orderId)) === 3000);
}

async function run() {
  await _quote();
  await _confirm();
  await _confirmPersistsFullAddress();
  await _confirmRejectsMalformedAddress();
  await _confirmRejectsInvalidAddressFormats();
  await _digitalOnlyCartCompletesWithoutShippingService();
  await _confirmRefusesZeroTotal();
  await _webhookDispatchHappyPath();
  await _webhookBadSig();
  await _webhookReplayDefense();
  await _stripeRefundMirrorRecordsOwnAmount();
}

module.exports = { run: run };
