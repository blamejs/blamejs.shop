"use strict";
/**
 * subscriptionControls — operator + customer lifecycle surface on top
 * of the existing `subscriptions` row.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 *   0001_catalog.sql        — variants FK target for subscription_plans
 *   0009_subscriptions.sql  — subscriptions + subscription_plans
 *   0045_subscription_controls.sql — control columns + audit ledger
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/subscription-controls.js` directly so the gate exists ahead
 * of the entry-point edit.
 *
 * Coverage:
 *   - pause happy + flips active → paused + writes ledger row
 *   - resume happy + paused → active
 *   - resume refused when subscription is cancelled
 *   - skipNext arithmetic across every frequency enum value
 *   - changeQuantity refuses 0 / negative
 *   - changeFrequency recomputes next_billing_at on the new cadence
 *   - cancel default (paid-through-period) and immediate
 *   - reactivate inside the 90-day grace window
 *   - reactivate outside the grace window refused
 *   - scanAutoResume picks up matured rows + leaves future ones
 *   - historyForSubscription returns every control event newest-first
 *   - actorReport surfaces operator vs system events in a window
 *   - validation refuses bad input at every entry point
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop                = require("../../lib");
var subscriptionControls = require("../../lib/subscription-controls");
var helpers              = require("../helpers");
var check                = helpers.check;
var assert               = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0009_subscriptions.sql",
  "0045_subscription_controls.sql",
].map(function (f) {
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

// Seed a plan + subscription row directly, bypassing the Stripe-backed
// `subscriptions.subscriptions.create` path. The controls primitive
// only reads + writes the row's local columns; the Stripe round-trip
// belongs to the subscriptions primitive's own test surface.
async function _seedRow(query, overrides) {
  overrides = overrides || {};
  var ts = Date.now();
  var pid = _validUUID();
  var vid = _validUUID();
  // products + variants (FK target for subscription_plans.variant_id).
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', 'active', ?4, ?4)",
    [pid, "sub-ctrl-" + ts + "-" + Math.random().toString(36).slice(2, 8), "SubCtrl", ts],
  );
  await query(
    "INSERT INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', '{}', 0, 1, 0, ?4, ?4)",
    [vid, pid, "SUBC-" + ts + "-" + Math.random().toString(36).slice(2, 6), ts],
  );
  // subscription_plans
  var planId = _validUUID();
  var planInterval      = overrides.plan_interval       || "month";
  var planIntervalCount = overrides.plan_interval_count || 1;
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, 'usd', 1999, 0, 1, ?6, ?6)",
    [planId, vid, "price_" + ts + "_" + Math.random().toString(36).slice(2, 6), planInterval, planIntervalCount, ts],
  );
  // subscriptions
  var subId = _validUUID();
  var stripeId = overrides.stripe_subscription_id || "sub_" + ts + "_" + Math.random().toString(36).slice(2, 8);
  var periodStart = overrides.current_period_start != null ? overrides.current_period_start : ts;
  var periodEnd   = overrides.current_period_end   != null ? overrides.current_period_end   : ts + 30 * 24 * 60 * 60 * 1000;
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, " +
    "quantity, frequency, next_billing_at, paused_at, paused_until, cancelled_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, ?7, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    [
      subId,
      overrides.customer_id || "cus_test_" + ts,
      planId,
      stripeId,
      periodStart,
      periodEnd,
      ts,
      overrides.quantity == null ? 1 : overrides.quantity,
      overrides.frequency == null ? null : overrides.frequency,
      overrides.next_billing_at == null ? periodEnd : overrides.next_billing_at,
      overrides.paused_at == null ? null : overrides.paused_at,
      overrides.paused_until == null ? null : overrides.paused_until,
      overrides.cancelled_at == null ? null : overrides.cancelled_at,
    ],
  );
  return { subscription_id: subId, plan_id: planId, variant_id: vid };
}

// Lightweight subscriptions handle — the controls primitive only
// requires `get` to be callable, but we pass a fuller surface so the
// composition contract stays honest.
function _subscriptionsHandle(query) {
  return {
    get: async function (id) {
      var r = await query("SELECT * FROM subscriptions WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },
  };
}

function _setup() {
  var q = _makeQuery();
  var ctl = subscriptionControls.create({
    query:         q,
    subscriptions: _subscriptionsHandle(q),
  });
  return { query: q, ctl: ctl };
}

// A controls instance wired WITH a fake Stripe payment handle so the
// quantity / frequency change paths exercise the processor push. The
// handle records every `update` call so a test can assert the local row
// and the Stripe call agree; `failUpdate` flips it into a rejecting
// adapter so the no-divergence-on-failure invariant is testable.
function _setupWithPayment(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var calls = { retrieve: [], update: [] };
  var payment = {
    subscriptions: {
      retrieve: async function (id) {
        calls.retrieve.push(id);
        if (opts.noItem) return { id: id, items: { data: [] } };
        return { id: id, items: { data: [{ id: "si_" + id }] } };
      },
      update: async function (id, body, key) {
        calls.update.push({ id: id, body: body, key: key });
        if (opts.failUpdate) {
          var e = new Error("card_declined");
          e.code = "STRIPE_HTTP_402";
          throw e;
        }
        return { id: id, status: "active" };
      },
    },
  };
  var ctl = subscriptionControls.create({
    query:         q,
    subscriptions: _subscriptionsHandle(q),
    payment:       payment,
  });
  return { query: q, ctl: ctl, calls: calls };
}

function _operatorActor() {
  return { actor_type: "operator", actor_id: _validUUID() };
}

function _customerActor() {
  return { actor_type: "customer", actor_id: null };
}

// ---- pause / resume happy path -----------------------------------------

async function _pauseAndResume() {
  var ctx = _setup();
  var seed = await _seedRow(ctx.query);

  var until = Date.now() + 7 * 24 * 60 * 60 * 1000;
  var paused = await ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    until:           until,
    reason:          "customer travel — back next week",
    actor:           _customerActor(),
  });
  check("pause flips state to paused",       paused.state === "paused");
  check("pause persists paused_until",       paused.paused_until === until);
  check("pause stamps paused_at",            typeof paused.paused_at === "number" && paused.paused_at > 0);

  // Ledger row written.
  var history = await ctx.ctl.historyForSubscription(seed.subscription_id);
  check("pause writes one ledger row",       history.length === 1);
  check("ledger event is 'pause'",            history[0].event === "pause");
  check("ledger before.state is active",      history[0].before.state === "active");
  check("ledger after.state is paused",       history[0].after.state === "paused");
  check("ledger captures reason",             history[0].reason === "customer travel — back next week");
  check("ledger actor_type is customer",      history[0].actor_type === "customer");

  // Indefinite pause (no until) is legal.
  var seed2 = await _seedRow(ctx.query);
  var paused2 = await ctx.ctl.pause({
    subscription_id: seed2.subscription_id,
    reason:          "indefinite hold",
    actor:           _operatorActor(),
  });
  check("indefinite pause works",             paused2.state === "paused");
  check("indefinite pause has null until",    paused2.paused_until == null);

  // Resume flips back to active.
  var resumed = await ctx.ctl.resume({
    subscription_id: seed.subscription_id,
    reason:          "customer returned",
    actor:           _customerActor(),
  });
  check("resume flips state to active",      resumed.state === "active");
  check("resume clears paused_at",            resumed.paused_at == null);
  check("resume clears paused_until",         resumed.paused_until == null);

  var history2 = await ctx.ctl.historyForSubscription(seed.subscription_id);
  check("resume appends ledger row",          history2.length === 2);
  check("newest ledger row is resume",        history2[0].event === "resume");
}

// ---- FSM refusals ------------------------------------------------------

async function _fsmRefusals() {
  var ctx = _setup();
  var seed = await _seedRow(ctx.query);

  // Cancel the subscription.
  await ctx.ctl.cancel({
    subscription_id: seed.subscription_id,
    reason:          "operator-initiated cancel",
    actor:           _operatorActor(),
    immediate:       true,
  });

  // Resume on a cancelled subscription refused.
  await assert.rejects(ctx.ctl.resume({
    subscription_id: seed.subscription_id,
    reason:          "trying to resume a cancelled sub",
    actor:           _operatorActor(),
  }), /cancelled/);

  // Pause on cancelled refused (use reactivate first).
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    reason:          "trying to pause a cancelled sub",
    actor:           _operatorActor(),
  }), /cancelled/);

  // Cancel twice refused.
  await assert.rejects(ctx.ctl.cancel({
    subscription_id: seed.subscription_id,
    reason:          "double cancel",
    actor:           _operatorActor(),
  }), /already cancelled/);

  // skipNext / changeQuantity / changeFrequency all refuse on cancelled.
  await assert.rejects(ctx.ctl.skipNext({
    subscription_id: seed.subscription_id,
    count:           1,
    reason:          "x",
    actor:           _operatorActor(),
  }), /cancelled/);
  await assert.rejects(ctx.ctl.changeQuantity({
    subscription_id: seed.subscription_id,
    new_quantity:    2,
    reason:          "x",
    actor:           _operatorActor(),
  }), /cancelled/);
  await assert.rejects(ctx.ctl.changeFrequency({
    subscription_id: seed.subscription_id,
    new_frequency:   "quarterly",
    reason:          "x",
    actor:           _operatorActor(),
  }), /cancelled/);

  // Resume on already-active refused.
  var seed2 = await _seedRow(ctx.query);
  await assert.rejects(ctx.ctl.resume({
    subscription_id: seed2.subscription_id,
    reason:          "already active",
    actor:           _operatorActor(),
  }), /already active/);

  // Pause on already-paused refused.
  await ctx.ctl.pause({
    subscription_id: seed2.subscription_id,
    reason:          "first pause",
    actor:           _operatorActor(),
  });
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed2.subscription_id,
    reason:          "second pause",
    actor:           _operatorActor(),
  }), /already paused/);

  // Reactivate on non-cancelled refused.
  await assert.rejects(ctx.ctl.reactivate({
    subscription_id: seed2.subscription_id,
    reason:          "reactivating an active sub",
    actor:           _operatorActor(),
  }), /not cancelled/);
}

// ---- skipNext arithmetic ------------------------------------------------

async function _skipNextArithmetic() {
  var ctx = _setup();
  var PERIOD_MS = subscriptionControls.PERIOD_MS;
  var FREQUENCIES = subscriptionControls.FREQUENCIES;

  // Seed one subscription per frequency, set next_billing_at to a
  // known anchor, skipNext by 1, and assert the new value equals
  // anchor + 1 period.
  var ANCHOR = 1700000000000;
  for (var i = 0; i < FREQUENCIES.length; i += 1) {
    var freq = FREQUENCIES[i];
    var seed = await _seedRow(ctx.query, {
      frequency:       freq,
      next_billing_at: ANCHOR,
    });
    var r = await ctx.ctl.skipNext({
      subscription_id: seed.subscription_id,
      count:           1,
      reason:          "skipping for " + freq,
      actor:           _operatorActor(),
    });
    var expected = ANCHOR + PERIOD_MS[freq];
    check("skipNext " + freq + " adds one period",
      r.next_billing_at === expected);
    check("skipNext " + freq + " snapshot reflects new next_billing_at",
      r.snapshot.next_billing_at === expected);
  }

  // skipNext by count=3 on a weekly cadence.
  var seedMulti = await _seedRow(ctx.query, {
    frequency:       "weekly",
    next_billing_at: ANCHOR,
  });
  var rMulti = await ctx.ctl.skipNext({
    subscription_id: seedMulti.subscription_id,
    count:           3,
    reason:          "skip three weeks",
    actor:           _operatorActor(),
  });
  check("skipNext count=3 weekly adds 3 weeks",
    rMulti.next_billing_at === ANCHOR + 3 * PERIOD_MS.weekly);

  // skipNext falls back to the plan-interval when row.frequency is
  // null. Seed a plan with interval=month, interval_count=1; the
  // primitive should derive "monthly".
  var seedFallback = await _seedRow(ctx.query, {
    plan_interval:       "month",
    plan_interval_count: 1,
    frequency:           null,
    next_billing_at:     ANCHOR,
  });
  var rFallback = await ctx.ctl.skipNext({
    subscription_id: seedFallback.subscription_id,
    count:           1,
    reason:          "plan-fallback",
    actor:           _operatorActor(),
  });
  check("skipNext plan-fallback uses monthly cadence",
    rFallback.next_billing_at === ANCHOR + PERIOD_MS.monthly);

  // Ledger has a 'skip' event for every call.
  var hist = await ctx.ctl.historyForSubscription(seedMulti.subscription_id);
  check("skipNext writes a skip event", hist.length === 1 && hist[0].event === "skip");
}

// ---- changeQuantity ----------------------------------------------------

async function _changeQuantity() {
  var ctx = _setup();
  var seed = await _seedRow(ctx.query, { quantity: 1 });

  var r = await ctx.ctl.changeQuantity({
    subscription_id: seed.subscription_id,
    new_quantity:    3,
    reason:          "upgrade to family size",
    actor:           _customerActor(),
  });
  check("changeQuantity persists new value", r.quantity === 3);
  check("changeQuantity state stays active", r.state === "active");

  // Zero refused.
  await assert.rejects(ctx.ctl.changeQuantity({
    subscription_id: seed.subscription_id,
    new_quantity:    0,
    reason:          "zero is invalid",
    actor:           _customerActor(),
  }), /positive integer/);

  // Negative refused.
  await assert.rejects(ctx.ctl.changeQuantity({
    subscription_id: seed.subscription_id,
    new_quantity:    -1,
    reason:          "negative",
    actor:           _customerActor(),
  }), /positive integer/);

  // Non-integer refused.
  await assert.rejects(ctx.ctl.changeQuantity({
    subscription_id: seed.subscription_id,
    new_quantity:    2.5,
    reason:          "non-integer",
    actor:           _customerActor(),
  }), /positive integer/);

  // Ledger captures the change.
  var hist = await ctx.ctl.historyForSubscription(seed.subscription_id);
  check("changeQuantity writes ledger event",  hist.length === 1);
  check("ledger event type is quantity_change", hist[0].event === "quantity_change");
  check("ledger before.quantity = 1",            hist[0].before.quantity === 1);
  check("ledger after.quantity = 3",             hist[0].after.quantity === 3);
}

// ---- changeFrequency ---------------------------------------------------

async function _changeFrequency() {
  var ctx = _setup();
  var PERIOD_MS = subscriptionControls.PERIOD_MS;
  var ANCHOR = 1700000000000;
  var seed = await _seedRow(ctx.query, {
    current_period_start: ANCHOR,
    current_period_end:   ANCHOR + PERIOD_MS.monthly,
    frequency:            null,
    next_billing_at:      ANCHOR + PERIOD_MS.monthly,
  });

  var r = await ctx.ctl.changeFrequency({
    subscription_id: seed.subscription_id,
    new_frequency:   "quarterly",
    reason:          "operator request — slower cadence",
    actor:           _operatorActor(),
  });
  check("changeFrequency persists new frequency", r.frequency === "quarterly");
  // next_billing_at recomputes from current_period_start + 1 period
  // of new frequency. anchor + quarterly.
  check("changeFrequency recomputes next_billing_at",
    r.next_billing_at === ANCHOR + PERIOD_MS.quarterly);

  // Bad frequency refused.
  await assert.rejects(ctx.ctl.changeFrequency({
    subscription_id: seed.subscription_id,
    new_frequency:   "fortnight",
    reason:          "bad enum",
    actor:           _operatorActor(),
  }), /frequency must be one of/);

  // Every allowed frequency accepted.
  for (var i = 0; i < subscriptionControls.FREQUENCIES.length; i += 1) {
    var freq = subscriptionControls.FREQUENCIES[i];
    var seedF = await _seedRow(ctx.query, {
      current_period_start: ANCHOR,
      current_period_end:   ANCHOR + PERIOD_MS.monthly,
    });
    var rF = await ctx.ctl.changeFrequency({
      subscription_id: seedF.subscription_id,
      new_frequency:   freq,
      reason:          "set " + freq,
      actor:           _operatorActor(),
    });
    check("changeFrequency accepts " + freq,
      rF.frequency === freq && rF.next_billing_at === ANCHOR + PERIOD_MS[freq]);
  }
}

// ---- Stripe-backed quantity push + frequency refusal -------------------

async function _stripeBackedChanges() {
  // Quantity change on a Stripe-backed subscription pushes to Stripe
  // (item-targeted update) BEFORE the local row is touched, so the
  // billed quantity and the shop's row never diverge.
  var ok = _setupWithPayment();
  var seed = await _seedRow(ok.query, { stripe_subscription_id: "sub_live_1" });
  var r = await ok.ctl.changeQuantity({
    subscription_id: seed.subscription_id,
    new_quantity:    4,
    reason:          "customer bumped the box",
    actor:           _customerActor(),
  });
  check("Stripe-backed changeQuantity writes local quantity", r.quantity === 4);
  check("Stripe-backed changeQuantity retrieved the subscription", ok.calls.retrieve.length === 1);
  check("Stripe-backed changeQuantity pushed one update",         ok.calls.update.length === 1);
  check("Stripe update targets the item id + new quantity",
    ok.calls.update[0].body && ok.calls.update[0].body.items &&
    ok.calls.update[0].body.items[0].id === "si_sub_live_1" &&
    ok.calls.update[0].body.items[0].quantity === 4);

  // Processor failure leaves the LOCAL row untouched — no divergence,
  // surfaced error.
  var fail = _setupWithPayment({ failUpdate: true });
  var seedF = await _seedRow(fail.query, { stripe_subscription_id: "sub_live_2", quantity: 1 });
  await assert.rejects(fail.ctl.changeQuantity({
    subscription_id: seedF.subscription_id,
    new_quantity:    9,
    reason:          "bump that fails at Stripe",
    actor:           _customerActor(),
  }), /Stripe/);
  var afterFail = (await _subscriptionsHandle(fail.query).get(seedF.subscription_id));
  check("Stripe failure leaves local quantity unchanged", afterFail.quantity === 1);
  var histFail = await fail.ctl.historyForSubscription(seedF.subscription_id);
  check("Stripe failure writes NO quantity_change ledger row",
    histFail.filter(function (h) { return h.event === "quantity_change"; }).length === 0);

  // A subscription with no billable item at Stripe surfaces a structured
  // error rather than writing a divergent local change.
  var noItem = _setupWithPayment({ noItem: true });
  var seedN = await _seedRow(noItem.query, { stripe_subscription_id: "sub_live_3", quantity: 2 });
  await assert.rejects(noItem.ctl.changeQuantity({
    subscription_id: seedN.subscription_id,
    new_quantity:    5,
    reason:          "no item",
    actor:           _customerActor(),
  }), /no billable item/);
  check("no-item failure leaves local quantity unchanged",
    (await _subscriptionsHandle(noItem.query).get(seedN.subscription_id)).quantity === 2);

  // Frequency change on a Stripe-backed subscription is REFUSED — a
  // Stripe Price's interval is immutable and the shop has no per-
  // frequency price catalog, so the cadence isn't expressible. The
  // local row must stay unchanged.
  var seedFreq = await _seedRow(ok.query, { stripe_subscription_id: "sub_live_4", frequency: null });
  await assert.rejects(ok.ctl.changeFrequency({
    subscription_id: seedFreq.subscription_id,
    new_frequency:   "quarterly",
    reason:          "cadence swap",
    actor:           _customerActor(),
  }), /frequency can't be changed/);
  var freqRow = await _subscriptionsHandle(ok.query).get(seedFreq.subscription_id);
  check("Stripe-backed changeFrequency leaves frequency unchanged", freqRow.frequency == null);

  // With NO payment handle wired at all, a Stripe-shaped row is treated
  // as local-only (the controls aren't Stripe-aware), so frequency change
  // succeeds locally and quantity change touches no processor.
  var localCtx = _setup();
  var seedNoPay = await _seedRow(localCtx.query, { stripe_subscription_id: "sub_live_5", frequency: null });
  var rNoPay = await localCtx.ctl.changeFrequency({
    subscription_id: seedNoPay.subscription_id,
    new_frequency:   "biweekly",
    reason:          "no payment wired",
    actor:           _customerActor(),
  });
  check("no-payment changeFrequency stays local", rNoPay.frequency === "biweekly");
}

// ---- cancel default + immediate ----------------------------------------

async function _cancelModes() {
  var ctx = _setup();
  var periodStart = 1700000000000;
  var periodEnd   = periodStart + 30 * 24 * 60 * 60 * 1000;

  // Default: paid-through-period. cancelled_at stamped at
  // current_period_end (the customer keeps access through that date).
  var seed1 = await _seedRow(ctx.query, {
    current_period_start: periodStart,
    current_period_end:   periodEnd,
  });
  var r1 = await ctx.ctl.cancel({
    subscription_id: seed1.subscription_id,
    reason:          "customer canceled — refund per policy",
    actor:           _operatorActor(),
  });
  check("default cancel stamps at period end",   r1.cancelled_at === periodEnd);
  check("default cancel state is cancelled",     r1.state === "cancelled");

  // Immediate: cancelled_at stamped at now.
  var seed2 = await _seedRow(ctx.query, {
    current_period_start: periodStart,
    current_period_end:   periodEnd,
  });
  var before = Date.now();
  var r2 = await ctx.ctl.cancel({
    subscription_id: seed2.subscription_id,
    reason:          "fraud signal — immediate revoke",
    actor:           _operatorActor(),
    immediate:       true,
  });
  var after = Date.now();
  check("immediate cancel stamps near now",
    r2.cancelled_at >= before && r2.cancelled_at <= after);
  check("immediate cancel state is cancelled", r2.state === "cancelled");

  // Cancel from a paused state clears the pause + sets cancelled.
  var seed3 = await _seedRow(ctx.query, {
    current_period_start: periodStart,
    current_period_end:   periodEnd,
  });
  await ctx.ctl.pause({
    subscription_id: seed3.subscription_id,
    reason:          "first pause",
    actor:           _operatorActor(),
  });
  var r3 = await ctx.ctl.cancel({
    subscription_id: seed3.subscription_id,
    reason:          "cancel from paused",
    actor:           _operatorActor(),
    immediate:       true,
  });
  check("cancel from paused clears paused_at",     r3.paused_at == null);
  check("cancel from paused clears paused_until",   r3.paused_until == null);
  check("cancel from paused sets cancelled state",   r3.state === "cancelled");
}

// ---- reactivate inside / outside grace ---------------------------------

async function _reactivateGrace() {
  var ctx = _setup();
  var seed = await _seedRow(ctx.query);

  // Cancel immediately.
  await ctx.ctl.cancel({
    subscription_id: seed.subscription_id,
    reason:          "test cancel",
    actor:           _operatorActor(),
    immediate:       true,
  });

  // Reactivate inside the grace window — happy path.
  var r = await ctx.ctl.reactivate({
    subscription_id: seed.subscription_id,
    reason:          "customer changed their mind",
    actor:           _customerActor(),
  });
  check("reactivate flips state to active", r.state === "active");
  check("reactivate clears cancelled_at",   r.cancelled_at == null);

  // Reactivate when not cancelled refused (covered in _fsmRefusals,
  // pinned again here for completeness).
  await assert.rejects(ctx.ctl.reactivate({
    subscription_id: seed.subscription_id,
    reason:          "double reactivate",
    actor:           _customerActor(),
  }), /not cancelled/);

  // Outside grace — manually backdate cancelled_at 91 days into the past.
  var seedOld = await _seedRow(ctx.query);
  var oldCancel = Date.now() - 91 * 24 * 60 * 60 * 1000;
  await ctx.query(
    "UPDATE subscriptions SET cancelled_at = ?1, updated_at = ?2 WHERE id = ?3",
    [oldCancel, Date.now(), seedOld.subscription_id],
  );
  await assert.rejects(ctx.ctl.reactivate({
    subscription_id: seedOld.subscription_id,
    reason:          "stale reactivate",
    actor:           _customerActor(),
  }), /grace window/);
}

// ---- scanAutoResume ----------------------------------------------------

async function _scanAutoResume() {
  var ctx = _setup();
  var now = Date.now();

  // Three subscriptions:
  //   - matured (paused_until in the past) — should resume
  //   - future  (paused_until > now)        — should stay paused
  //   - indefinite (paused_until NULL)      — should stay paused
  var seedMatured = await _seedRow(ctx.query, {
    paused_at:    now - 60 * 60 * 1000,
    paused_until: now - 60 * 1000,
  });
  var seedFuture = await _seedRow(ctx.query, {
    paused_at:    now - 60 * 60 * 1000,
    paused_until: now + 60 * 60 * 1000,
  });
  var seedIndef = await _seedRow(ctx.query, {
    paused_at:    now - 60 * 60 * 1000,
    paused_until: null,
  });
  // And one active row that scanAutoResume should never touch.
  var seedActive = await _seedRow(ctx.query);

  var r = await ctx.ctl.scanAutoResume(now);
  check("scanAutoResume resumes 1 row",         r.count === 1);
  check("scanAutoResume returns matured id",    r.resumed[0] === seedMatured.subscription_id);

  // Verify state on each row.
  var maturedRow = (await ctx.query("SELECT * FROM subscriptions WHERE id = ?1", [seedMatured.subscription_id])).rows[0];
  check("matured row is now active",            maturedRow.paused_at == null && maturedRow.paused_until == null);

  var futureRow = (await ctx.query("SELECT * FROM subscriptions WHERE id = ?1", [seedFuture.subscription_id])).rows[0];
  check("future row stays paused",              futureRow.paused_at != null && futureRow.paused_until === now + 60 * 60 * 1000);

  var indefRow = (await ctx.query("SELECT * FROM subscriptions WHERE id = ?1", [seedIndef.subscription_id])).rows[0];
  check("indefinite row stays paused",          indefRow.paused_at != null && indefRow.paused_until == null);

  var activeRow = (await ctx.query("SELECT * FROM subscriptions WHERE id = ?1", [seedActive.subscription_id])).rows[0];
  check("active row untouched",                 activeRow.paused_at == null);

  // Audit ledger captured the system-actor resume.
  var hist = await ctx.ctl.historyForSubscription(seedMatured.subscription_id);
  check("auto-resume writes ledger row",        hist.length === 1);
  check("auto-resume actor is system",          hist[0].actor_type === "system");
  check("auto-resume event is resume",          hist[0].event === "resume");
  check("auto-resume reason captures matured",  /auto-resume/.test(hist[0].reason));

  // Re-running scanAutoResume is idempotent — nothing left to resume.
  var r2 = await ctx.ctl.scanAutoResume(now);
  check("scanAutoResume rerun no-op",           r2.count === 0);
}

// ---- audit trail + actorReport -----------------------------------------

async function _auditTrail() {
  var ctx = _setup();
  var seed = await _seedRow(ctx.query);
  var opActor = _operatorActor();

  // Run every method that mutates the row, building up a 6-event
  // history.
  await ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    until:           Date.now() + 60 * 1000,
    reason:          "step 1: pause",
    actor:           opActor,
  });
  await ctx.ctl.resume({
    subscription_id: seed.subscription_id,
    reason:          "step 2: resume",
    actor:           opActor,
  });
  await ctx.ctl.skipNext({
    subscription_id: seed.subscription_id,
    count:           1,
    reason:          "step 3: skip",
    actor:           opActor,
  });
  await ctx.ctl.changeQuantity({
    subscription_id: seed.subscription_id,
    new_quantity:    2,
    reason:          "step 4: quantity",
    actor:           opActor,
  });
  await ctx.ctl.changeFrequency({
    subscription_id: seed.subscription_id,
    new_frequency:   "quarterly",
    reason:          "step 5: frequency",
    actor:           opActor,
  });
  await ctx.ctl.cancel({
    subscription_id: seed.subscription_id,
    reason:          "step 6: cancel",
    actor:           opActor,
    immediate:       true,
  });

  var hist = await ctx.ctl.historyForSubscription(seed.subscription_id);
  check("history has 6 rows",                hist.length === 6);
  check("history ordered newest first",      hist[0].event === "cancel" && hist[5].event === "pause");
  check("history captures every event type",
    hist.map(function (h) { return h.event; }).sort().join(",") ===
      ["cancel", "frequency_change", "pause", "quantity_change", "resume", "skip"].sort().join(","));
  check("every row has a reason",
    hist.every(function (h) { return typeof h.reason === "string" && h.reason.length > 0; }));
  check("every row has before + after JSON",
    hist.every(function (h) { return h.before && h.after; }));

  // actorReport pinned to the operator window.
  var report = await ctx.ctl.actorReport({
    actor_type: "operator",
    from:       0,
    to:         Date.now() + 1000,
  });
  check("actorReport returns operator events", report.length === 6);
  check("actorReport excludes other actor_types",
    report.every(function (r) { return r.actor_type === "operator"; }));

  // actorReport for `system` returns empty (no system events on this sub).
  var sysReport = await ctx.ctl.actorReport({
    actor_type: "system",
    from:       0,
    to:         Date.now() + 1000,
  });
  check("system actorReport empty for op-only sub", sysReport.length === 0);

  // actorReport refusal: from > to.
  await assert.rejects(ctx.ctl.actorReport({
    actor_type: "operator",
    from:       Date.now(),
    to:         Date.now() - 1000,
  }), /from must be <= to/);

  // actorReport refusal: bad actor_type.
  await assert.rejects(ctx.ctl.actorReport({
    actor_type: "nobody",
    from:       0,
    to:         1,
  }), /actor_type must be one of/);
}

// ---- validation ---------------------------------------------------------

async function _validation() {
  var ctx = _setup();
  var seed = await _seedRow(ctx.query);

  // factory refuses missing subscriptions handle.
  assert.throws(function () { subscriptionControls.create({ query: ctx.query }); }, /subscriptions handle required/);

  // pause: missing input / bad uuid / bad reason / bad actor.
  await assert.rejects(ctx.ctl.pause(),                              /input object required/);
  await assert.rejects(ctx.ctl.pause({}),                            /subscription_id/);
  await assert.rejects(ctx.ctl.pause({ subscription_id: "bad" }),      /subscription_id/);
  await assert.rejects(ctx.ctl.pause({ subscription_id: seed.subscription_id }), /reason/);
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    reason:          "",
  }), /reason/);
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    reason:          "x".repeat(281),
    actor:           _operatorActor(),
  }), /reason/);
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    reason:          "bad\x00byte",
    actor:           _operatorActor(),
  }), /reason/);
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    reason:          "ok",
  }), /actor object required/);
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    reason:          "ok",
    actor:           { actor_type: "alien" },
  }), /actor_type must be one of/);
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    reason:          "ok",
    actor:           { actor_type: "operator", actor_id: "not-a-uuid" },
  }), /actor.actor_id/);
  await assert.rejects(ctx.ctl.pause({
    subscription_id: seed.subscription_id,
    until:           -1,
    reason:          "ok",
    actor:           _operatorActor(),
  }), /until/);

  // skipNext count bounds.
  await assert.rejects(ctx.ctl.skipNext({
    subscription_id: seed.subscription_id,
    count:           0,
    reason:          "zero count",
    actor:           _operatorActor(),
  }), /count must be an integer/);
  await assert.rejects(ctx.ctl.skipNext({
    subscription_id: seed.subscription_id,
    count:           13,
    reason:          "too many",
    actor:           _operatorActor(),
  }), /count must be an integer/);

  // Unknown subscription_id refused with a NOT_FOUND error.
  var bogus = bShop.framework.uuid.v7();
  await assert.rejects(ctx.ctl.pause({
    subscription_id: bogus,
    reason:          "ghost",
    actor:           _operatorActor(),
  }), /not found/);
  await assert.rejects(ctx.ctl.resume({
    subscription_id: bogus,
    reason:          "ghost",
    actor:           _operatorActor(),
  }), /not found/);
  await assert.rejects(ctx.ctl.skipNext({
    subscription_id: bogus,
    count:           1,
    reason:          "ghost",
    actor:           _operatorActor(),
  }), /not found/);
  await assert.rejects(ctx.ctl.changeQuantity({
    subscription_id: bogus,
    new_quantity:    1,
    reason:          "ghost",
    actor:           _operatorActor(),
  }), /not found/);
  await assert.rejects(ctx.ctl.changeFrequency({
    subscription_id: bogus,
    new_frequency:   "monthly",
    reason:          "ghost",
    actor:           _operatorActor(),
  }), /not found/);
  await assert.rejects(ctx.ctl.cancel({
    subscription_id: bogus,
    reason:          "ghost",
    actor:           _operatorActor(),
  }), /not found/);
  await assert.rejects(ctx.ctl.reactivate({
    subscription_id: bogus,
    reason:          "ghost",
    actor:           _operatorActor(),
  }), /not found/);

  // historyForSubscription / actorReport input validation.
  await assert.rejects(ctx.ctl.historyForSubscription("not-a-uuid"), /subscription_id/);
  await assert.rejects(ctx.ctl.actorReport(), /input object required/);
  await assert.rejects(ctx.ctl.scanAutoResume("not-a-number"), /now must be a non-negative integer/);
}

async function run() {
  await _pauseAndResume();
  await _fsmRefusals();
  await _skipNextArithmetic();
  await _changeQuantity();
  await _changeFrequency();
  await _stripeBackedChanges();
  await _cancelModes();
  await _reactivateGrace();
  await _scanAutoResume();
  await _auditTrail();
  await _validation();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/subscription-controls.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("subscription-controls: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
