"use strict";
/**
 * planChanges — subscription plan upgrade / downgrade with proration.
 *
 * Layer 1 against in-memory node:sqlite loaded from:
 *   0001_catalog.sql                 — variants FK target for plans
 *   0009_subscriptions.sql           — subscriptions + plans
 *   0066_subscription_billing.sql    — invoices ledger (executeChange
 *                                      composes subscriptionBilling
 *                                      when injected)
 *   0083_plan_changes.sql            — plan-changes ledger
 *
 * Direct require of `lib/plan-changes.js` — the primitive isn't
 * wired into `lib/index.js` yet; the test gate exists ahead of the
 * entry-point edit (same posture as subscription-controls.test.js
 * and subscription-billing.test.js).
 *
 * Coverage:
 *   - proration math: mid-period upgrade returns correct
 *     credit + first_charge
 *   - change_kind derivation: change_at < period_end → immediate,
 *     change_at >= period_end → next_billing_cycle (zero proration)
 *   - executeChange FSM: immediate writes `executed` and flips
 *     subscriptions.plan_id; future change_at writes `pending`
 *   - executeChange queues a proration invoice through the injected
 *     subscriptionBilling handle
 *   - cancelPendingChange refuses once executed
 *   - applyScheduledChanges window: only flips rows whose
 *     effective_at <= now
 *   - validation: bad UUID / same plan / archived to-plan /
 *     cross-currency / no current period
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop               = require("../../lib");
var planChanges         = require("../../lib/plan-changes");
var subscriptionBilling = require("../../lib/subscription-billing");
var helpers             = require("../helpers");
var check               = helpers.check;
var assert              = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0009_subscriptions.sql",
  "0066_subscription_billing.sql",
  "0083_plan_changes.sql",
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

// Seed a product + variant + two plans (A + B) + a subscription
// bound to plan A. The fixture is shared across every test below;
// individual tests override the period window or the plan amounts
// where they need a specific proration shape.
async function _seed(query, opts) {
  opts = opts || {};
  var ts = Date.now();
  var pid = _validUUID();
  var vid = _validUUID();
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', 'active', ?4, ?4)",
    [pid, "plan-change-" + ts + "-" + Math.random().toString(36).slice(2, 8), "PlanChange", ts],
  );
  await query(
    "INSERT INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', '{}', 0, 1, 0, ?4, ?4)",
    [vid, pid, "PLAN-" + ts + "-" + Math.random().toString(36).slice(2, 6), ts],
  );

  var planA = _validUUID();
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'month', 1, 'usd', ?4, 0, 1, ?5, ?5)",
    [planA, vid, "price_A_" + ts + "_" + Math.random().toString(36).slice(2, 6),
     opts.plan_a_amount == null ? 1000 : opts.plan_a_amount, ts],
  );
  var planB = _validUUID();
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'month', 1, 'usd', ?4, 0, ?5, ?6, ?6)",
    [planB, vid, "price_B_" + ts + "_" + Math.random().toString(36).slice(2, 6),
     opts.plan_b_amount == null ? 3000 : opts.plan_b_amount,
     opts.plan_b_active === false ? 0 : 1, ts],
  );

  var subId = _validUUID();
  var periodStart = opts.period_start == null ? 1000000 : opts.period_start;
  var periodEnd   = opts.period_end   == null ? 1000000 + 30 * 24 * 60 * 60 * 1000 : opts.period_end;
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, ?7, ?7)",
    [
      subId,
      opts.customer_id || ("cus_test_" + ts),
      planA,
      "sub_" + ts + "_" + Math.random().toString(36).slice(2, 8),
      periodStart,
      periodEnd,
      ts,
    ],
  );
  return {
    subscription_id: subId,
    plan_a_id:       planA,
    plan_b_id:       planB,
    variant_id:      vid,
    period_start:    periodStart,
    period_end:      periodEnd,
  };
}

function _subscriptionsHandle(query) {
  return {
    get: async function (id) {
      var r = await query("SELECT * FROM subscriptions WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },
  };
}

// Minimal store-credit capture handle (same injected-handle posture as
// _subscriptionsHandle). Records every credit() call so a downgrade test
// can assert the owed credit was issued with the right amount + source.
// `failTimes` makes the first N credit() calls reject (a transient write
// error) so the revert-on-throw path can be exercised.
function _storeCreditHandle(failTimes) {
  var calls = [];
  var remainingFailures = failTimes || 0;
  return {
    calls: calls,
    credit: async function (input) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        var err = new Error("store-credit: transient write failure");
        err.code = "STORE_CREDIT_WRITE_FAILED";
        throw err;
      }
      calls.push(input);
      return { id: "sc_" + calls.length, amount_minor: input.amount_minor };
    },
  };
}

function _setup(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var subs = _subscriptionsHandle(q);
  var bill = null;
  if (opts.with_billing) {
    bill = subscriptionBilling.create({
      query:         q,
      subscriptions: subs,
    });
  }
  var sc = opts.store_credit_handle || (opts.with_store_credit ? _storeCreditHandle() : null);
  var pc = planChanges.create({
    query:               q,
    subscriptions:       subs,
    subscriptionBilling: bill,
    storeCredit:         sc,
  });
  return { query: q, pc: pc, bill: bill, sc: sc };
}

// ---- 1. proration math --------------------------------------------------

async function _prorationMidPeriod() {
  // Plan A: 1000 minor over [0, 1000]. Plan B: 3000 minor over the
  // same window. Effective at t=300 → 70% of the period remains.
  //   credit = floor(1000 * 700 / 1000) = 700
  //   charge = floor(3000 * 700 / 1000) = 2100
  var pror = planChanges.prorate(1000, 3000, 0, 1000, 300);
  check("prorate mid-period credit",  pror.proration_credit_minor === 700);
  check("prorate mid-period charge",  pror.first_charge_minor     === 2100);

  // Plan A: 3000 → plan B: 1000 (downgrade). Effective at t=500 →
  // 50% remains.
  //   credit = floor(3000 * 500 / 1000) = 1500
  //   charge = floor(1000 * 500 / 1000) = 500
  var down = planChanges.prorate(3000, 1000, 0, 1000, 500);
  check("prorate downgrade credit",  down.proration_credit_minor === 1500);
  check("prorate downgrade charge",  down.first_charge_minor     === 500);

  // Clamp: effective_at before period_start → no usage, full period
  // remains. credit = full from-plan, charge = full to-plan.
  var early = planChanges.prorate(1000, 3000, 100, 200, 50);
  check("prorate clamp early credit", early.proration_credit_minor === 1000);
  check("prorate clamp early charge", early.first_charge_minor     === 3000);

  // Clamp: effective_at past period_end → no remaining.
  var late = planChanges.prorate(1000, 3000, 100, 200, 500);
  check("prorate clamp late credit",  late.proration_credit_minor === 0);
  check("prorate clamp late charge",  late.first_charge_minor     === 0);

  // Zero-length period collapses to zero.
  var zero = planChanges.prorate(1000, 3000, 100, 100, 100);
  check("prorate zero-period credit", zero.proration_credit_minor === 0);
  check("prorate zero-period charge", zero.first_charge_minor     === 0);
}

// ---- 2. proposeChange: immediate vs next_billing_cycle ------------------

async function _proposeImmediate() {
  var ctx = _setup();
  // Period [0, 1000]; plan A = 1000, plan B = 3000.
  var seed = await _seed(ctx.query, {
    plan_a_amount: 1000,
    plan_b_amount: 3000,
    period_start:  0,
    period_end:    1000,
  });

  var proposed = await ctx.pc.proposeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       300,
  });
  check("propose immediate kind",          proposed.change_kind === "immediate");
  check("propose immediate effective_at",  proposed.effective_at === 300);
  check("propose immediate credit",         proposed.proration_credit_minor === 700);
  check("propose immediate charge",         proposed.first_charge_minor === 2100);
  check("propose immediate currency",       proposed.currency === "usd");
  check("propose carries from_plan_id",     proposed.from_plan_id === seed.plan_a_id);
  check("propose carries to_plan_id",       proposed.to_plan_id   === seed.plan_b_id);
}

async function _proposeNextCycle() {
  var ctx = _setup();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 1000,
    plan_b_amount: 3000,
    period_start:  0,
    period_end:    1000,
  });

  // change_at >= period_end → next_billing_cycle, zero proration.
  var proposed = await ctx.pc.proposeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       5000,
  });
  check("propose next-cycle kind",          proposed.change_kind === "next_billing_cycle");
  check("propose next-cycle effective_at",  proposed.effective_at === 1000);
  check("propose next-cycle zero credit",   proposed.proration_credit_minor === 0);
  check("propose next-cycle zero charge",   proposed.first_charge_minor === 0);

  // Exactly at period_end is the boundary — also next_billing_cycle.
  var boundary = await ctx.pc.proposeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       1000,
  });
  check("propose boundary kind",            boundary.change_kind === "next_billing_cycle");
  check("propose boundary effective_at",    boundary.effective_at === 1000);
}

// ---- 3. executeChange FSM -----------------------------------------------

async function _executeImmediateFsm() {
  var ctx = _setup({ with_billing: true });
  // Set the period to cover Date.now() so the executeChange call
  // (which falls through to proposeChange without change_at) lands
  // mid-period and writes `executed` immediately.
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 1000,
    plan_b_amount: 3000,
    period_start:  now - 1000,
    period_end:    now + 9000,
  });

  var row = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
  });
  check("executeChange returns row",          typeof row.id === "string" && row.id.length > 0);
  check("executeChange status executed",      row.status === "executed");
  check("executeChange persists from_plan",   row.from_plan_id === seed.plan_a_id);
  check("executeChange persists to_plan",     row.to_plan_id === seed.plan_b_id);
  check("executeChange persists executed_at", typeof row.executed_at === "number" && row.executed_at > 0);
  check("executeChange kind immediate",        row.change_kind === "immediate");

  // Parent subscriptions.plan_id flipped to the new plan.
  var sub = await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id]);
  check("executeChange flipped subscriptions.plan_id", sub.rows[0].plan_id === seed.plan_b_id);

  // Proration adjustment landed in subscriptionBilling.
  var invoices = await ctx.bill.invoicesForSubscription(seed.subscription_id);
  check("executeChange queued exactly one proration invoice", invoices.length === 1);
  // subscriptionBilling stores currency uppercase; planChanges
  // normalizes at the boundary because plan rows hold it lowercase.
  check("proration invoice currency normalized to upper",     invoices[0].currency === "USD");
  // net = first_charge - credit (clamped to 0 below).
  var expectedNet = row.first_charge_minor - row.proration_credit_minor;
  if (expectedNet < 0) expectedNet = 0;
  check("proration invoice amount = net(first_charge - credit)", invoices[0].amount_minor === expectedNet);

  // Refuse a second executeChange while a pending/proposed row
  // already exists. (Here the existing row is `executed`, so the
  // pending-filter returns null and a second change is allowed.)
  // To exercise the refusal: queue a future change first, then
  // attempt another executeChange — it must refuse.
  var futureExec = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_a_id,
    change_at:       now + 5 * 1000,
  });
  check("executeChange future kind immediate (change_at < period_end)", futureExec.change_kind === "immediate");
  check("executeChange future status pending",                          futureExec.status === "pending");

  await assert.rejects(ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
  }), /pending change/);
}

// ---- 3b. mid-cycle downgrade issues the owed credit as store credit -----

async function _downgradeIssuesStoreCredit() {
  var ctx = _setup({ with_billing: true, with_store_credit: true });
  var now = Date.now();
  var customerId = _validUUID();
  // Plan A (current) = 3000, plan B (target) = 1000 — a downgrade. Period
  // [now-1000, now+9000] (10000ms); change_at = now → 9000ms (90%) remains.
  //   credit = floor(3000 * 9000/10000) = 2700
  //   charge = floor(1000 * 9000/10000) =  900
  //   owed credit (credit - charge) = 1800; net charge clamps to 0.
  var seed = await _seed(ctx.query, {
    plan_a_amount: 3000,
    plan_b_amount: 1000,
    period_start:  now - 1000,
    period_end:    now + 9000,
    customer_id:   customerId,
  });

  var row = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now,
  });
  check("downgrade status executed",       row.status === "executed");
  check("downgrade proration credit 2700", row.proration_credit_minor === 2700);
  check("downgrade proration charge 900",  row.first_charge_minor === 900);
  check("downgrade flipped plan_id",
    (await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id])).rows[0].plan_id === seed.plan_b_id);

  // The owed credit (2700 - 900 = 1800) was issued to store credit.
  check("downgrade issued exactly one store credit",       ctx.sc.calls.length === 1);
  check("downgrade store credit amount = credit - charge", ctx.sc.calls[0].amount_minor === 1800);
  check("downgrade store credit customer",                 ctx.sc.calls[0].customer_id === customerId);
  check("downgrade store credit source refund",            ctx.sc.calls[0].source === "refund");
  check("downgrade store credit correlates the change",    ctx.sc.calls[0].source_ref === "subscription-downgrade:" + row.id);

  // The proration invoice carries the clamped charge (0 here) — no overcharge.
  var invoices = await ctx.bill.invoicesForSubscription(seed.subscription_id);
  check("downgrade queued one proration invoice", invoices.length === 1);
  check("downgrade invoice charge clamped to 0",  invoices[0].amount_minor === 0);
}

async function _downgradeWithoutStoreCreditThrows() {
  var ctx = _setup({ with_billing: true });   // NO store-credit handle wired
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 3000,
    plan_b_amount: 1000,
    period_start:  now - 1000,
    period_end:    now + 9000,
  });
  // An immediate downgrade owes a credit but there is no vehicle to pay it
  // — refuse BEFORE any state changes rather than drop the credit.
  await assert.rejects(ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now,
  }), /downgrade owes/);
  check("refused downgrade left subscription on plan A",
    (await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id])).rows[0].plan_id === seed.plan_a_id);
  check("refused downgrade wrote no plan-change row",
    Number((await ctx.query("SELECT COUNT(*) AS n FROM subscription_plan_changes WHERE subscription_id = ?1", [seed.subscription_id])).rows[0].n) === 0);
}

async function _scheduledDowngradeIssuesStoreCredit() {
  var ctx = _setup({ with_billing: true, with_store_credit: true });
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 3000,
    plan_b_amount: 1000,
    period_start:  now - 1000,
    period_end:    now + 9000,
    customer_id:   _validUUID(),
  });
  // Queue a FUTURE downgrade (within the period) → pending; no credit yet.
  // effective_at = now+2000 → remaining 7000ms (70%):
  //   credit = floor(3000*7000/10000)=2100, charge=floor(1000*7000/10000)=700
  //   owed = 2100 - 700 = 1400
  var pending = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now + 2000,
  });
  check("scheduled downgrade pending",            pending.status === "pending");
  check("scheduled downgrade no credit issued yet", ctx.sc.calls.length === 0);
  // The scheduler clock catches up → the change executes + issues the credit.
  var executed = await ctx.pc.applyScheduledChanges({ now: now + 3000 });
  check("scheduler executed the downgrade",     executed.length === 1 && executed[0].status === "executed");
  check("scheduler issued one store credit",    ctx.sc.calls.length === 1);
  check("scheduler store credit amount = 1400", ctx.sc.calls[0].amount_minor === 1400);
  check("scheduler store credit correlates the change", ctx.sc.calls[0].source_ref === "subscription-downgrade:" + pending.id);
}

async function _downgradeCreditFailureRevertsAndRetries() {
  // A transient store-credit write failure must NOT finalize the downgrade
  // with the credit lost: the transition reverts and the change is retryable.
  var sc = _storeCreditHandle(1);   // first credit() call rejects, then succeeds
  var ctx = _setup({ with_billing: true, store_credit_handle: sc });
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 3000,
    plan_b_amount: 1000,
    period_start:  now - 1000,
    period_end:    now + 9000,
    customer_id:   _validUUID(),
  });

  // First attempt: credit() rejects → executeChange rejects.
  await assert.rejects(ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now,
  }), /transient write failure/);
  // The transition was rolled back: subscription still on plan A, no credit.
  check("credit failure left subscription on plan A",
    (await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id])).rows[0].plan_id === seed.plan_a_id);
  check("credit failure issued no store credit", sc.calls.length === 0);
  // The failed change row is voided (cancelled), so the pending-change guard
  // does not block the retry.
  var rows = await ctx.query("SELECT status FROM subscription_plan_changes WHERE subscription_id = ?1", [seed.subscription_id]);
  check("credit failure voided the change row", rows.rows.length === 1 && rows.rows[0].status === "cancelled");

  // Retry: credit() now succeeds → downgrade settles cleanly.
  var retry = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now,
  });
  check("retry executed the downgrade",    retry.status === "executed");
  check("retry flipped to plan B",
    (await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id])).rows[0].plan_id === seed.plan_b_id);
  check("retry issued the owed credit once", sc.calls.length === 1 && sc.calls[0].amount_minor === 1800);
}

async function _scheduledDowngradeCreditFailureRevertsToPending() {
  var sc = _storeCreditHandle(1);   // first credit() call rejects
  var ctx = _setup({ with_billing: true, store_credit_handle: sc });
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 3000,
    plan_b_amount: 1000,
    period_start:  now - 1000,
    period_end:    now + 9000,
    customer_id:   _validUUID(),
  });
  var pending = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now + 2000,
  });
  check("scheduled downgrade pending", pending.status === "pending");

  // Sweep 1: credit fails → row reverts to pending, sweep does not abort.
  var run1 = await ctx.pc.applyScheduledChanges({ now: now + 3000 });
  check("sweep with failing credit executed nothing", run1.length === 0);
  check("failing credit reverted the row to pending",
    (await ctx.query("SELECT status FROM subscription_plan_changes WHERE id = ?1", [pending.id])).rows[0].status === "pending");
  check("failing credit left subscription on plan A",
    (await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id])).rows[0].plan_id === seed.plan_a_id);

  // Sweep 2: credit now succeeds → the downgrade settles.
  var run2 = await ctx.pc.applyScheduledChanges({ now: now + 4000 });
  check("retry sweep executed the downgrade", run2.length === 1 && run2[0].status === "executed");
  check("retry sweep issued the credit once", sc.calls.length === 1 && sc.calls[0].amount_minor === 1400);
  check("retry sweep flipped to plan B",
    (await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id])).rows[0].plan_id === seed.plan_b_id);
}

async function _scheduledDowngradeWithoutStoreCreditStaysPending() {
  var ctx = _setup({ with_billing: true });   // NO store-credit handle wired
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 3000,
    plan_b_amount: 1000,
    period_start:  now - 1000,
    period_end:    now + 9000,
  });
  // A future downgrade may QUEUE without a credit vehicle (the check fires
  // at execution time, not proposal time).
  var pending = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now + 2000,
  });
  check("uncreditable scheduled downgrade queued pending", pending.status === "pending");
  // The scheduler refuses to transition it (no vehicle) — leaves it pending
  // rather than dropping the credit. It applies on a later sweep once wired.
  var executed = await ctx.pc.applyScheduledChanges({ now: now + 3000 });
  check("scheduler skipped the uncreditable downgrade", executed.length === 0);
  check("uncreditable downgrade left pending",
    (await ctx.query("SELECT status FROM subscription_plan_changes WHERE id = ?1", [pending.id])).rows[0].status === "pending");
  check("uncreditable downgrade did not transition",
    (await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id])).rows[0].plan_id === seed.plan_a_id);
}

// ---- 4. cancelPendingChange refusal once executed -----------------------

async function _cancelPendingFsm() {
  var ctx = _setup();
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 1000,
    plan_b_amount: 3000,
    period_start:  now - 1000,
    period_end:    now + 60 * 1000,
  });

  // Queue a future change → status pending.
  var pending = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now + 30 * 1000,
  });
  check("queued change status pending", pending.status === "pending");

  // pendingChangeFor surfaces it.
  var peek = await ctx.pc.pendingChangeFor(seed.subscription_id);
  check("pendingChangeFor returns the row", peek && peek.id === pending.id);

  // Cancel it.
  var cancelled = await ctx.pc.cancelPendingChange({
    subscription_id: seed.subscription_id,
    reason:          "customer changed mind",
  });
  check("cancelPendingChange flips status",     cancelled.status === "cancelled");
  check("cancelPendingChange persists reason",  cancelled.cancel_reason === "customer changed mind");
  check("cancelPendingChange stamps cancelled_at", typeof cancelled.cancelled_at === "number" && cancelled.cancelled_at > 0);

  // pendingChangeFor now returns null.
  var peek2 = await ctx.pc.pendingChangeFor(seed.subscription_id);
  check("pendingChangeFor returns null after cancel", peek2 == null);

  // Refuse a second cancel — no pending change remains.
  await assert.rejects(ctx.pc.cancelPendingChange({
    subscription_id: seed.subscription_id,
  }), /no pending change/);

  // Execute a change immediately (status executed); cancel must refuse.
  var executed = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
  });
  check("immediate execute status",   executed.status === "executed");
  await assert.rejects(ctx.pc.cancelPendingChange({
    subscription_id: seed.subscription_id,
  }), /no pending change/);
}

// ---- 5. applyScheduledChanges window ------------------------------------

async function _applyScheduledWindow() {
  var ctx = _setup({ with_billing: true });
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 1000,
    plan_b_amount: 2000,
    period_start:  now - 1000,
    period_end:    now + 60 * 60 * 1000,
  });

  // Queue a change for the future.
  var queued = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_at:       now + 10 * 60 * 1000,
  });
  check("queued change is pending", queued.status === "pending");

  // applyScheduledChanges with `now` < effective_at → no-op.
  var none = await ctx.pc.applyScheduledChanges({ now: now });
  check("applyScheduledChanges early returns empty", none.length === 0);

  // Verify the row is still pending.
  var still = await ctx.pc.pendingChangeFor(seed.subscription_id);
  check("queued change still pending", still && still.status === "pending");

  // applyScheduledChanges with `now` >= effective_at → flips it.
  var executed = await ctx.pc.applyScheduledChanges({ now: now + 20 * 60 * 1000 });
  check("applyScheduledChanges executed one row",    executed.length === 1);
  check("applyScheduledChanges flips status",         executed[0].status === "executed");
  check("applyScheduledChanges stamps executed_at",   typeof executed[0].executed_at === "number");

  // Parent subscriptions.plan_id flipped.
  var subRow = await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id]);
  check("applyScheduledChanges flipped parent plan_id", subRow.rows[0].plan_id === seed.plan_b_id);

  // pendingChangeFor returns null now.
  var peek = await ctx.pc.pendingChangeFor(seed.subscription_id);
  check("applyScheduledChanges clears pending queue", peek == null);

  // Idempotent re-run: a second applyScheduledChanges pass (a cron
  // overrun, a retry, or two workers) must NOT re-execute the
  // already-executed change or record a second proration invoice. The
  // pending->executed claim matches zero rows the second time, and the
  // deterministic processor_invoice_id would dedupe even if it didn't.
  var invBefore = await ctx.bill.invoicesForSubscription(seed.subscription_id);
  check("first apply recorded exactly one proration invoice", invBefore.length === 1);
  var reRun = await ctx.pc.applyScheduledChanges({ now: now + 40 * 60 * 1000 });
  check("applyScheduledChanges re-run executes nothing",       reRun.length === 0);
  var invAfter = await ctx.bill.invoicesForSubscription(seed.subscription_id);
  check("applyScheduledChanges re-run records no second invoice", invAfter.length === invBefore.length);

  // Validation.
  await assert.rejects(ctx.pc.applyScheduledChanges(), /input object required/);
  await assert.rejects(ctx.pc.applyScheduledChanges({ now: "soon" }), /now/);
}

// ---- 6. historyForSubscription ordering ---------------------------------

async function _historyOrdering() {
  var ctx = _setup();
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 1000,
    plan_b_amount: 2000,
    period_start:  now - 1000,
    period_end:    now + 60 * 60 * 1000,
  });

  var first = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
  });
  // Subscription is now on plan B. Queue a change back to A — to
  // exercise that history returns multi-row in newest-first order.
  await new Promise(function (r) { setTimeout(r, 5); });   // allow:test-promise-settimeout-sleep — uuid.v7 timestamp resolution
  var second = await ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_a_id,
    change_at:       now + 30 * 60 * 1000,
  });

  var history = await ctx.pc.historyForSubscription(seed.subscription_id);
  check("history returns 2 rows",     history.length === 2);
  check("history newest-first 0",     history[0].id === second.id);
  check("history newest-first 1",     history[1].id === first.id);
}

// ---- 7. validation ------------------------------------------------------

async function _validation() {
  var ctx = _setup();
  var seed = await _seed(ctx.query);

  // Factory refuses missing subscriptions handle.
  assert.throws(function () { planChanges.create({ query: ctx.query }); }, /subscriptions handle required/);

  // proposeChange input validation.
  await assert.rejects(ctx.pc.proposeChange(),    /input object required/);
  await assert.rejects(ctx.pc.proposeChange({}),  /subscription_id/);
  await assert.rejects(ctx.pc.proposeChange({
    subscription_id: "not-a-uuid",
    new_plan_id:     seed.plan_b_id,
  }), /subscription_id/);
  await assert.rejects(ctx.pc.proposeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     "bad",
  }), /new_plan_id/);

  // Unknown subscription refused.
  await assert.rejects(ctx.pc.proposeChange({
    subscription_id: _validUUID(),
    new_plan_id:     seed.plan_b_id,
  }), /not found/);

  // Same-plan change refused.
  await assert.rejects(ctx.pc.proposeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_a_id,
  }), /same as the current plan/);

  // Archived to-plan refused.
  var ctx2 = _setup();
  var seed2 = await _seed(ctx2.query, { plan_b_active: false });
  await assert.rejects(ctx2.pc.proposeChange({
    subscription_id: seed2.subscription_id,
    new_plan_id:     seed2.plan_b_id,
  }), /archived/);

  // Cross-currency refused. Insert a plan in EUR and try to switch.
  var ts = Date.now();
  var eurPlan = _validUUID();
  await ctx.query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'month', 1, 'eur', 2000, 0, 1, ?4, ?4)",
    [eurPlan, seed.variant_id, "price_eur_" + ts, ts],
  );
  await assert.rejects(ctx.pc.proposeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     eurPlan,
  }), /cross-currency/);

  // cancelPendingChange input validation.
  await assert.rejects(ctx.pc.cancelPendingChange(),    /input object required/);
  await assert.rejects(ctx.pc.cancelPendingChange({}),  /subscription_id/);

  // cancelPendingChange reason validation (control bytes).
  var ctx3 = _setup();
  var seed3 = await _seed(ctx3.query, {
    plan_a_amount: 1000, plan_b_amount: 2000,
    period_start:  Date.now() - 1000,
    period_end:    Date.now() + 60 * 1000,
  });
  await ctx3.pc.executeChange({
    subscription_id: seed3.subscription_id,
    new_plan_id:     seed3.plan_b_id,
    change_at:       Date.now() + 30 * 1000,
  });
  await assert.rejects(ctx3.pc.cancelPendingChange({
    subscription_id: seed3.subscription_id,
    reason:          "bad\x00byte",
  }), /reason/);
  await assert.rejects(ctx3.pc.cancelPendingChange({
    subscription_id: seed3.subscription_id,
    reason:          "x".repeat(MAX_REASON_LEN + 1),
  }), /reason/);

  // executeChange input validation.
  await assert.rejects(ctx.pc.executeChange(),                                    /input object required/);
  await assert.rejects(ctx.pc.executeChange({ subscription_id: "bad" }),           /subscription_id/);
  await assert.rejects(ctx.pc.executeChange({
    subscription_id: seed.subscription_id,
    new_plan_id:     seed.plan_b_id,
    change_kind:     "right_now",
  }), /change_kind/);

  // Module-level surface sanity.
  check("module exports CHANGE_KINDS",       Array.isArray(planChanges.CHANGE_KINDS) && planChanges.CHANGE_KINDS.length === 2);
  check("module exports STATUSES",           Array.isArray(planChanges.STATUSES) && planChanges.STATUSES.length === 4);
  check("module exports MAX_REASON_LEN",     planChanges.MAX_REASON_LEN === 280);
  check("module exports prorate",            typeof planChanges.prorate === "function");
}

var MAX_REASON_LEN = planChanges.MAX_REASON_LEN;

// Two concurrent executeChange calls for the same immediate change must charge
// proration ONCE. The _pendingFor guard only blocks PENDING changes, so the
// conditional plan update (WHERE plan_id = the pre-change id) is the
// serialization point: both calls read the old plan id, but only the first
// conditional update transitions the row and records proration; the second
// matches zero rows and skips the invoice. Without the guard both would charge.
async function _concurrentImmediateNoDoubleProration() {
  var ctx = _setup({ with_billing: true });
  var now = Date.now();
  var seed = await _seed(ctx.query, {
    plan_a_amount: 1000,
    plan_b_amount: 3000,
    period_start:  now - 1000,
    period_end:    now + 9000,
  });

  var both = await Promise.all([
    ctx.pc.executeChange({ subscription_id: seed.subscription_id, new_plan_id: seed.plan_b_id }),
    ctx.pc.executeChange({ subscription_id: seed.subscription_id, new_plan_id: seed.plan_b_id }),
  ]);
  check("both concurrent executeChange calls returned a row",
    both.length === 2 && typeof both[0].id === "string" && typeof both[1].id === "string");

  var sub = await ctx.query("SELECT plan_id FROM subscriptions WHERE id = ?1", [seed.subscription_id]);
  check("plan transitioned to the new plan", sub.rows[0].plan_id === seed.plan_b_id);

  var invoices = await ctx.bill.invoicesForSubscription(seed.subscription_id);
  check("concurrent immediate change charged proration exactly once", invoices.length === 1);

  // The losing claim must VOID its row rather than leave a phantom 'executed'
  // change: both calls INSERT 'executed' before the plan_id CAS, only one wins.
  // Exactly one executed row survives; the loser is cancelled with the
  // transition-lost reason (so a SUM(first_charge_minor) WHERE status='executed'
  // revenue rollup can't double-count a change that moved no money).
  var executedRows = await ctx.query(
    "SELECT COUNT(*) AS n FROM subscription_plan_changes WHERE subscription_id = ?1 AND status = 'executed'",
    [seed.subscription_id]);
  check("exactly one executed change survives (no phantom)", Number(executedRows.rows[0].n) === 1);
  var statuses = both.map(function (r) { return r.status; }).sort();
  check("concurrent execute: one executed, one cancelled",
    statuses[0] === "cancelled" && statuses[1] === "executed");
  var loser = both.filter(function (r) { return r.status === "cancelled"; })[0];
  check("concurrent execute: loser voided with transition-lost reason",
    loser && loser.cancel_reason === "transition-lost");
}

async function run() {
  await _prorationMidPeriod();
  await _proposeImmediate();
  await _proposeNextCycle();
  await _executeImmediateFsm();
  await _downgradeIssuesStoreCredit();
  await _downgradeWithoutStoreCreditThrows();
  await _scheduledDowngradeIssuesStoreCredit();
  await _downgradeCreditFailureRevertsAndRetries();
  await _scheduledDowngradeCreditFailureRevertsToPending();
  await _scheduledDowngradeWithoutStoreCreditStaysPending();
  await _concurrentImmediateNoDoubleProration();
  await _cancelPendingFsm();
  await _applyScheduledWindow();
  await _historyOrdering();
  await _validation();
}

module.exports = { run: run };

// Standalone invocation.
if (require.main === module) {
  run().then(function () {
    console.log("plan-changes: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
