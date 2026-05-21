"use strict";
/**
 * subscriptions — Stripe-backed recurring billing primitive.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0001_catalog.sql (for variant FK) + 0009_subscriptions.sql. The
 * Stripe API surface is stubbed; the test pins:
 *
 *   - plans CRUD (create / get / list / update / archive)
 *   - subscriptions.create dispatches to payment.subscriptions.create
 *     and persists the Stripe-shaped response
 *   - subscriptions.cancel routes at_period_end through the stub
 *   - subscriptions.byStripeId looks up by Stripe id
 *   - handleStripeEvent updates the local row from
 *     customer.subscription.created/updated/deleted payloads
 *   - validation refuses bad input at every entry point
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0009_subscriptions.sql"].map(function (f) {
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

// Mock the payment.subscriptions surface. The test records every
// call so assertions can pin arguments + idempotency keys.
function _makePaymentStub() {
  var calls = [];
  var seq = 0;
  return {
    calls: calls,
    subscriptions: {
      create: async function (input, idemKey) {
        calls.push({ method: "create", input: input, idem: idemKey });
        seq += 1;
        return {
          id:                     "sub_test_" + seq,
          status:                 "active",
          current_period_start:   1700000000,
          current_period_end:     1702592000,
          cancel_at_period_end:   false,
          items:                  { data: [{ price: { id: input.items[0].price } }] },
          latest_invoice:         { payment_intent: { client_secret: "pi_secret_x" } },
        };
      },
      retrieve: async function (id) {
        calls.push({ method: "retrieve", id: id });
        return { id: id, status: "active" };
      },
      update: async function (id, input, idemKey) {
        calls.push({ method: "update", id: id, input: input, idem: idemKey });
        return { id: id, status: "active", cancel_at_period_end: !!input.cancel_at_period_end };
      },
      cancel: async function (id, opts, idemKey) {
        calls.push({ method: "cancel", id: id, opts: opts, idem: idemKey });
        if (opts && opts.at_period_end) {
          return {
            id:                   id,
            status:               "active",
            current_period_start: 1700000000,
            current_period_end:   1702592000,
            cancel_at_period_end: true,
          };
        }
        return {
          id:                   id,
          status:               "canceled",
          current_period_start: 1700000000,
          current_period_end:   1702592000,
          cancel_at_period_end: false,
        };
      },
    },
  };
}

async function _seedVariant(query) {
  // Insert a product + variant directly so the FK on
  // subscription_plans.variant_id resolves. Catalog primitive isn't
  // imported here — the variant is a passive FK target.
  var pid = _validUUID();
  var vid = _validUUID();
  var ts = Date.now();
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', 'active', ?4, ?4)",
    [pid, "sub-test-" + ts, "SubTest", ts],
  );
  await query(
    "INSERT INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', '{}', 0, 1, 0, ?4, ?4)",
    [vid, pid, "SUB-" + ts, ts],
  );
  return { product_id: pid, variant_id: vid };
}

function _planInput(seed, overrides) {
  var base = {
    variant_id:      seed.variant_id,
    stripe_price_id: "price_test_123",
    interval:        "month",
    interval_count:  1,
    currency:        "usd",
    amount_minor:    1999,
    trial_days:      7,
    active:          true,
  };
  if (overrides) Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
  return base;
}

// ---- plans CRUD ---------------------------------------------------------

async function _plansCrud() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var subs = bShop.subscriptions.create({ query: q });

  var plan = await subs.plans.create(_planInput(seed));
  check("plans.create returns id",            typeof plan.id === "string" && plan.id.length === 36);
  check("plans.create persists stripe_price",  plan.stripe_price_id === "price_test_123");
  check("plans.create stores interval",        plan.interval === "month");
  check("plans.create stores trial",           plan.trial_days === 7);
  check("plans.create active=1 by default",    plan.active === 1);

  var got = await subs.plans.get(plan.id);
  check("plans.get round-trip",                got && got.id === plan.id);

  var list = await subs.plans.list({ variant_id: seed.variant_id });
  check("plans.list filter by variant",        list.length === 1);

  var listActive = await subs.plans.list({ active: true });
  check("plans.list filter by active=true",    listActive.length === 1);

  var updated = await subs.plans.update(plan.id, { amount_minor: 2499, trial_days: 14 });
  check("plans.update amount",                 updated.amount_minor === 2499);
  check("plans.update trial",                  updated.trial_days === 14);

  var archived = await subs.plans.archive(plan.id);
  check("plans.archive sets active=0",         archived.active === 0);

  var listActiveAfter = await subs.plans.list({ active: true });
  check("plans.list active after archive empty", listActiveAfter.length === 0);

  // Standalone plan (no variant) — variant_id null is legal.
  var standalone = await subs.plans.create(_planInput(seed, { variant_id: undefined, stripe_price_id: "price_standalone" }));
  check("plans.create accepts null variant_id", standalone.variant_id == null);
}

// ---- subscriptions.create ----------------------------------------------

async function _subscriptionsCreate() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var payment = _makePaymentStub();
  var subs = bShop.subscriptions.create({ query: q, payment: payment });

  var plan = await subs.plans.create(_planInput(seed));
  var sub = await subs.subscriptions.create({
    customer_id:       "cus_test_1",
    plan_id:           plan.id,
    payment_method_id: "pm_test_card",
  });
  check("subscriptions.create returns id",            typeof sub.id === "string" && sub.id.length === 36);
  check("subscriptions.create stores stripe id",       sub.stripe_subscription_id === "sub_test_1");
  check("subscriptions.create persists status",        sub.status === "active");
  check("subscriptions.create persists period start",  sub.current_period_start === 1700000000 * 1000);
  check("subscriptions.create persists period end",    sub.current_period_end === 1702592000 * 1000);

  check("Stripe stub called once",                     payment.calls.length === 1);
  var call = payment.calls[0];
  check("Stripe stub got customer",                    call.input.customer === "cus_test_1");
  check("Stripe stub got items[0].price",              call.input.items[0].price === "price_test_123");
  check("Stripe stub got payment_method",              call.input.default_payment_method === "pm_test_card");
  check("Stripe stub got trial_period_days",           call.input.trial_period_days === 7);
  check("Stripe stub got idempotency-key",              typeof call.idem === "string" && call.idem.length > 0);

  var byStripe = await subs.subscriptions.byStripeId("sub_test_1");
  check("byStripeId lookup",                            byStripe && byStripe.id === sub.id);

  var list = await subs.subscriptions.list({ customer_id: "cus_test_1" });
  check("list filter by customer",                      list.length === 1);

  var listByStatus = await subs.subscriptions.list({ status: "active" });
  check("list filter by status",                        listByStatus.length === 1);
}

async function _subscriptionsCreateRejectsArchivedPlan() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var payment = _makePaymentStub();
  var subs = bShop.subscriptions.create({ query: q, payment: payment });

  var plan = await subs.plans.create(_planInput(seed));
  await subs.plans.archive(plan.id);

  await assert.rejects(subs.subscriptions.create({
    customer_id:       "cus_test_1",
    plan_id:           plan.id,
    payment_method_id: "pm_test_card",
  }), /archived/);
  check("Stripe stub NOT called for archived plan",     payment.calls.length === 0);
}

// ---- subscriptions.cancel ----------------------------------------------

async function _subscriptionsCancel() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var payment = _makePaymentStub();
  var subs = bShop.subscriptions.create({ query: q, payment: payment });

  var plan = await subs.plans.create(_planInput(seed));
  var sub = await subs.subscriptions.create({
    customer_id:       "cus_test_1",
    plan_id:           plan.id,
    payment_method_id: "pm_test_card",
  });

  var capeResult = await subs.subscriptions.cancel(sub.id, { at_period_end: true });
  check("cancel at_period_end sets flag",               capeResult.cancel_at_period_end === 1);
  check("cancel at_period_end keeps status active",     capeResult.status === "active");
  var lastCall = payment.calls[payment.calls.length - 1];
  check("cancel routes to Stripe cancel",                lastCall.method === "cancel");
  check("cancel forwards at_period_end",                 lastCall.opts.at_period_end === true);

  // Cancel immediately — Stripe returns status=canceled
  var sub2 = await subs.subscriptions.create({
    customer_id:       "cus_test_2",
    plan_id:           plan.id,
    payment_method_id: "pm_test_card",
  });
  var nowResult = await subs.subscriptions.cancel(sub2.id, { at_period_end: false });
  check("cancel immediate sets status canceled",         nowResult.status === "canceled");
  check("cancel immediate cancel_at_period_end=0",       nowResult.cancel_at_period_end === 0);
}

// ---- handleStripeEvent -------------------------------------------------

async function _handleStripeEventUpsert() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var payment = _makePaymentStub();
  var subs = bShop.subscriptions.create({ query: q, payment: payment });

  var plan = await subs.plans.create(_planInput(seed));
  var sub = await subs.subscriptions.create({
    customer_id:       "cus_test_1",
    plan_id:           plan.id,
    payment_method_id: "pm_test_card",
  });

  // customer.subscription.updated → past_due
  var r = await subs.subscriptions.handleStripeEvent({
    id:   "evt_updated_1",
    type: "customer.subscription.updated",
    data: { object: {
      id:                   "sub_test_1",
      status:               "past_due",
      current_period_start: 1700100000,
      current_period_end:   1702692000,
      cancel_at_period_end: false,
    } },
  });
  check("handleStripeEvent updated handled",     r.handled === true);
  check("handleStripeEvent updated action",      r.action === "upsert");
  check("handleStripeEvent updated status",      r.subscription.status === "past_due");
  check("handleStripeEvent updated period_end",  r.subscription.current_period_end === 1702692000 * 1000);

  var refetch = await subs.subscriptions.get(sub.id);
  check("local row reflects past_due",            refetch.status === "past_due");

  // customer.subscription.created — for an existing local row this
  // also upserts (defensive on out-of-order delivery).
  var r2 = await subs.subscriptions.handleStripeEvent({
    id:   "evt_created_1",
    type: "customer.subscription.created",
    data: { object: {
      id:                   "sub_test_1",
      status:               "trialing",
      current_period_start: 1700200000,
      current_period_end:   1702792000,
      cancel_at_period_end: false,
    } },
  });
  check("handleStripeEvent created handled",      r2.handled === true);
  check("handleStripeEvent created → trialing",   r2.subscription.status === "trialing");
}

async function _handleStripeEventDelete() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var payment = _makePaymentStub();
  var subs = bShop.subscriptions.create({ query: q, payment: payment });

  var plan = await subs.plans.create(_planInput(seed));
  var sub = await subs.subscriptions.create({
    customer_id:       "cus_test_1",
    plan_id:           plan.id,
    payment_method_id: "pm_test_card",
  });

  var r = await subs.subscriptions.handleStripeEvent({
    id:   "evt_deleted_1",
    type: "customer.subscription.deleted",
    data: { object: {
      id:     "sub_test_1",
      status: "canceled",
      current_period_start: 1700000000,
      current_period_end:   1702592000,
      cancel_at_period_end: false,
    } },
  });
  check("handleStripeEvent deleted handled",      r.handled === true);
  check("handleStripeEvent deleted status",       r.subscription.status === "canceled");

  var refetch = await subs.subscriptions.get(sub.id);
  check("local row reflects canceled",             refetch.status === "canceled");
}

async function _handleStripeEventUnknown() {
  var q = _makeQuery();
  var subs = bShop.subscriptions.create({ query: q });
  var r = await subs.subscriptions.handleStripeEvent({ id: "evt_x", type: "invoice.paid", data: { object: { id: "in_1" } } });
  check("unknown event type → handled false",      r.handled === false);

  var r2 = await subs.subscriptions.handleStripeEvent({
    id:   "evt_y",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_does_not_exist", status: "active" } },
  });
  check("unknown stripe id → handled false",       r2.handled === false);
}

// ---- validation --------------------------------------------------------

async function _validation() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var subs = bShop.subscriptions.create({ query: q });

  // plans.create
  await assert.rejects(subs.plans.create(),                          /input object required/);
  await assert.rejects(subs.plans.create({}),                         /stripe_price_id/);
  await assert.rejects(subs.plans.create(_planInput(seed, { interval: "fortnight" })),  /interval must be/);
  await assert.rejects(subs.plans.create(_planInput(seed, { interval_count: 13 })),     /interval_count/);
  await assert.rejects(subs.plans.create(_planInput(seed, { interval_count: 0 })),      /interval_count/);
  await assert.rejects(subs.plans.create(_planInput(seed, { trial_days: 1000 })),       /trial_days/);
  await assert.rejects(subs.plans.create(_planInput(seed, { trial_days: -1 })),         /trial_days/);
  await assert.rejects(subs.plans.create(_planInput(seed, { currency: "USD" })),        /lowercase ISO 4217/);
  await assert.rejects(subs.plans.create(_planInput(seed, { amount_minor: 0 })),         /amount_minor/);
  await assert.rejects(subs.plans.create(_planInput(seed, { variant_id: "not-a-uuid" })), /variant_id/);

  // plans.get / list with bad ids
  await assert.rejects(subs.plans.get("bad"),                         /plan id/);

  // subscriptions.create
  await assert.rejects(subs.subscriptions.create(),                                                          /input object required/);
  await assert.rejects(subs.subscriptions.create({}),                                                         /customer_id/);
  await assert.rejects(subs.subscriptions.create({ customer_id: "cus_1" }),                                    /plan_id/);
  await assert.rejects(subs.subscriptions.create({ customer_id: "cus_1", plan_id: "not-a-uuid" }),             /plan_id/);
  var uuid = _validUUID();
  await assert.rejects(subs.subscriptions.create({ customer_id: "cus_1", plan_id: uuid }),                     /payment_method_id/);
  await assert.rejects(subs.subscriptions.create({ customer_id: "cus_1", plan_id: uuid, payment_method_id: "pm_1" }), /not found/);

  // subscriptions.cancel
  await assert.rejects(subs.subscriptions.cancel(),                   /subscription id/);
  await assert.rejects(subs.subscriptions.cancel("not-a-uuid"),         /subscription id/);

  // byStripeId
  await assert.rejects(subs.subscriptions.byStripeId(),                 /stripe subscription id/);
  await assert.rejects(subs.subscriptions.byStripeId(""),                /stripe subscription id/);

  // list status
  await assert.rejects(subs.subscriptions.list({ status: "not-a-status" }), /status must be/);

  // handleStripeEvent
  await assert.rejects(subs.subscriptions.handleStripeEvent(),           /event object required/);
}

async function _payerSubscriptionsValidation() {
  // payment.subscriptions input validation lives in payment.js — pin
  // the shape so adapter swaps don't drift the contract.
  var payment = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx" });
  assert.throws(function () { payment.subscriptions.create(); },                                /input object required/);
  assert.throws(function () { payment.subscriptions.create({}); },                                  /customer/);
  assert.throws(function () { payment.subscriptions.create({ customer: "cus_test_x" }); },           /items/);
  assert.throws(function () { payment.subscriptions.create({ customer: "cus_test_x", items: [] }); }, /items/);
  assert.throws(function () { payment.subscriptions.retrieve(); },                                /subscription id/);
  assert.throws(function () { payment.subscriptions.update("sub_test_x"); },                        /input object required/);
  assert.throws(function () { payment.subscriptions.cancel(); },                                   /subscription id/);
}

// ---- checkout webhook routing ------------------------------------------

async function _checkoutRoutesSubscriptionEvent() {
  var q = _makeQuery();
  var seed = await _seedVariant(q);
  var payment = _makePaymentStub();
  // payment used as both Stripe stub for subs.create AND the
  // verifyWebhook source for checkout. Wire a verifier that returns
  // ok=true so the test pins the routing layer, not signature math
  // (already covered by payment.test.js).
  var verifierShim = {
    verifyWebhook: async function (_h, body) {
      return { ok: true, event: JSON.parse(body) };
    },
    subscriptions: payment.subscriptions,
  };
  var subs = bShop.subscriptions.create({ query: q, payment: payment });
  var plan = await subs.plans.create(_planInput(seed));
  await subs.subscriptions.create({
    customer_id:       "cus_test_1",
    plan_id:           plan.id,
    payment_method_id: "pm_test_card",
  });

  // Compose checkout with stub deps for everything except payment +
  // subscriptions, which are the only collaborators handleStripeEvent
  // touches for a subscription event.
  var stubNoop = {};
  var checkout = bShop.checkout.create({
    catalog:       stubNoop,
    cart:          stubNoop,
    pricing:       stubNoop,
    tax:           stubNoop,
    shipping:      stubNoop,
    payment:       verifierShim,
    order:         { byPaymentIntent: async function () { return null; }, transition: async function () { return null; } },
    subscriptions: subs.subscriptions,
  });

  var body = JSON.stringify({
    id:   "evt_route_1",
    type: "customer.subscription.updated",
    data: { object: {
      id:                   "sub_test_1",
      status:               "past_due",
      current_period_start: 1700100000,
      current_period_end:   1702692000,
      cancel_at_period_end: false,
    } },
  });
  var r = await checkout.handleStripeEvent({ headers: {}, rawBody: body });
  check("checkout routes subscription event",      r.handled === true);
  check("checkout returns updated subscription",   r.subscription && r.subscription.status === "past_due");
}

async function _checkoutSkipsSubscriptionWithoutHandler() {
  var verifierShim = {
    verifyWebhook: async function (_h, body) {
      return { ok: true, event: JSON.parse(body) };
    },
  };
  var checkout = bShop.checkout.create({
    catalog: {}, cart: {}, pricing: {}, tax: {}, shipping: {},
    payment: verifierShim,
    order:   { byPaymentIntent: async function () { return null; }, transition: async function () { return null; } },
    // no subscriptions
  });
  var body = JSON.stringify({
    id:   "evt_no_handler",
    type: "customer.subscription.created",
    data: { object: { id: "sub_x", status: "active" } },
  });
  var r = await checkout.handleStripeEvent({ headers: {}, rawBody: body });
  check("no subscriptions handler → handled false", r.handled === false);
  check("reason is no-subscriptions-handler",        r.reason === "no-subscriptions-handler");
}

async function run() {
  await _plansCrud();
  await _subscriptionsCreate();
  await _subscriptionsCreateRejectsArchivedPlan();
  await _subscriptionsCancel();
  await _handleStripeEventUpsert();
  await _handleStripeEventDelete();
  await _handleStripeEventUnknown();
  await _validation();
  await _payerSubscriptionsValidation();
  await _checkoutRoutesSubscriptionEvent();
  await _checkoutSkipsSubscriptionWithoutHandler();
}

module.exports = { run: run };
