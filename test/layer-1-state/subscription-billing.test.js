"use strict";
/**
 * subscriptionBilling — invoice + payment + dunning ledger on top of
 * the existing `subscriptions` row.
 *
 * Layer 1 against in-memory node:sqlite loaded from:
 *   0001_catalog.sql                 — variants FK target for plans
 *   0009_subscriptions.sql           — subscriptions + plans
 *   0066_subscription_billing.sql    — invoices + attempts + dunning
 *
 * Direct require of `lib/subscription-billing.js` — the primitive
 * isn't wired into `lib/index.js` yet; the test gate exists ahead
 * of the entry-point edit (same posture as
 * subscription-controls.test.js).
 *
 * Coverage:
 *   - recordInvoice happy path + processor idempotency
 *   - recordPaymentAttempt sequencing + idempotency
 *   - markPaid FSM: pending → paid, failed → paid (recovery), no-op
 *     on already-paid, refuse on voided
 *   - markFailed FSM: pending/failed → failed, refuse on paid /
 *     voided
 *   - enterDunning + exitDunning happy path + duplicate refusal
 *   - invoicesForSubscription ordering newest-first
 *   - failedInvoices window + limit
 *   - dunningRoster open-only filtering
 *   - arpu math: sum(paid)/distinct(subs), currency-bucketed
 *   - validation: bad UUID / bad currency / bad URL / bad enum
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop               = require("../../lib");
var subscriptionBilling = require("../../lib/subscription-billing");
var helpers             = require("../helpers");
var check               = helpers.check;
var assert              = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0009_subscriptions.sql",
  "0066_subscription_billing.sql",
  "0239_subscriptions_plan_transition_claim.sql",
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

// Seed a plan + subscription row directly. Same shape the
// subscription-controls test uses — the billing primitive reads
// `subscriptions.id` only, so the wiring stays minimal.
async function _seedSubscription(query, overrides) {
  overrides = overrides || {};
  var ts = Date.now();
  var pid = _validUUID();
  var vid = _validUUID();
  await query(
    "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', 'active', ?4, ?4)",
    [pid, "sub-bill-" + ts + "-" + Math.random().toString(36).slice(2, 8), "SubBill", ts],
  );
  await query(
    "INSERT INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', '{}', 0, 1, 0, ?4, ?4)",
    [vid, pid, "SUBB-" + ts + "-" + Math.random().toString(36).slice(2, 6), ts],
  );
  var planId = _validUUID();
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'month', 1, 'usd', 1999, 0, 1, ?4, ?4)",
    [planId, vid, "price_" + ts + "_" + Math.random().toString(36).slice(2, 6), ts],
  );
  var subId = _validUUID();
  var stripeId = overrides.stripe_subscription_id || "sub_" + ts + "_" + Math.random().toString(36).slice(2, 8);
  var periodStart = overrides.current_period_start != null ? overrides.current_period_start : ts;
  var periodEnd   = overrides.current_period_end   != null ? overrides.current_period_end   : ts + 30 * 24 * 60 * 60 * 1000;
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, ?7, ?7)",
    [
      subId,
      overrides.customer_id || "cus_test_" + ts,
      planId,
      stripeId,
      periodStart,
      periodEnd,
      ts,
    ],
  );
  return { subscription_id: subId, plan_id: planId, variant_id: vid };
}

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
  var bill = subscriptionBilling.create({
    query:         q,
    subscriptions: _subscriptionsHandle(q),
    payment:       { mark: "stub" },
  });
  return { query: q, bill: bill };
}

// ---- recordInvoice ------------------------------------------------------

async function _recordInvoiceHappy() {
  var ctx = _setup();
  var sub = await _seedSubscription(ctx.query);

  var inv = await ctx.bill.recordInvoice({
    subscription_id:      sub.subscription_id,
    period_start:         1700000000000,
    period_end:           1702592000000,
    amount_minor:         1999,
    currency:             "USD",
    invoice_url:          "https://invoices.example.com/in_abc123/hosted",
    processor_invoice_id: "in_abc123",
  });
  check("recordInvoice returns row with id",         typeof inv.id === "string" && inv.id.length > 0);
  check("recordInvoice persists subscription_id",     inv.subscription_id === sub.subscription_id);
  check("recordInvoice starts in pending",            inv.status === "pending");
  check("recordInvoice persists amount_minor",        inv.amount_minor === 1999);
  check("recordInvoice persists currency",            inv.currency === "USD");
  check("recordInvoice persists invoice_url",         inv.invoice_url === "https://invoices.example.com/in_abc123/hosted");
  check("recordInvoice persists processor_invoice_id",inv.processor_invoice_id === "in_abc123");

  // Idempotent replay: re-recording the same processor_invoice_id
  // returns the existing row instead of inserting a duplicate.
  var replay = await ctx.bill.recordInvoice({
    subscription_id:      sub.subscription_id,
    period_start:         1700000000000,
    period_end:           1702592000000,
    amount_minor:         1999,
    currency:             "USD",
    invoice_url:          "https://invoices.example.com/in_abc123/hosted",
    processor_invoice_id: "in_abc123",
  });
  check("recordInvoice replay returns existing id", replay.id === inv.id);

  // Without processor_invoice_id, every call inserts a new row.
  var noProc1 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1700000000000,
    period_end:      1702592000000,
    amount_minor:    100,
    currency:        "USD",
  });
  var noProc2 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1700000000000,
    period_end:      1702592000000,
    amount_minor:    100,
    currency:        "USD",
  });
  check("no processor_invoice_id inserts two rows", noProc1.id !== noProc2.id);

  // Bad invoice_url refused (non-https).
  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1,
    period_end:      2,
    amount_minor:    1,
    currency:        "USD",
    invoice_url:     "javascript:alert(1)",
  }), /invoice_url/);

  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1,
    period_end:      2,
    amount_minor:    1,
    currency:        "USD",
    invoice_url:     "http://insecure.example.com/x",
  }), /invoice_url/);

  // Bad currency refused.
  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1,
    period_end:      2,
    amount_minor:    1,
    currency:        "dollars",
  }), /currency/);

  // Bad period order refused.
  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    2000,
    period_end:      1000,
    amount_minor:    1,
    currency:        "USD",
  }), /period_end/);

  // Unknown subscription refused.
  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: _validUUID(),
    period_start:    1,
    period_end:      2,
    amount_minor:    1,
    currency:        "USD",
  }), /not found/);
}

// ---- recordPaymentAttempt ----------------------------------------------

async function _paymentAttemptSequencing() {
  var ctx = _setup();
  var sub = await _seedSubscription(ctx.query);
  var inv = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1700000000000,
    period_end:      1702592000000,
    amount_minor:    4999,
    currency:        "USD",
  });

  var a1 = await ctx.bill.recordPaymentAttempt({
    invoice_id:          inv.id,
    attempt_number:      1,
    status:              "failed",
    processor_charge_id: "ch_fail_1",
    failure_code:        "card_declined",
  });
  check("attempt 1 persists status",       a1.status === "failed");
  check("attempt 1 persists attempt_number", a1.attempt_number === 1);
  check("attempt 1 persists charge id",     a1.processor_charge_id === "ch_fail_1");
  check("attempt 1 persists failure_code",  a1.failure_code === "card_declined");

  var a2 = await ctx.bill.recordPaymentAttempt({
    invoice_id:          inv.id,
    attempt_number:      2,
    status:              "succeeded",
    processor_charge_id: "ch_ok_2",
  });
  check("attempt 2 persists status",       a2.status === "succeeded");
  check("attempt 2 attempt_number = 2",      a2.attempt_number === 2);
  check("attempt 2 failure_code is null",    a2.failure_code == null);

  // Replay attempt 1 — should return the existing row, not insert a
  // duplicate (the UNIQUE constraint would refuse a second INSERT
  // anyway).
  var a1Replay = await ctx.bill.recordPaymentAttempt({
    invoice_id:          inv.id,
    attempt_number:      1,
    status:              "failed",
    processor_charge_id: "ch_different",
    failure_code:        "different_code",
  });
  check("attempt replay returns existing row", a1Replay.id === a1.id);
  check("attempt replay preserves original charge id", a1Replay.processor_charge_id === "ch_fail_1");

  // Bad status refused.
  await assert.rejects(ctx.bill.recordPaymentAttempt({
    invoice_id:     inv.id,
    attempt_number: 3,
    status:         "pending",
  }), /status/);

  // Bad attempt_number refused (0 / negative).
  await assert.rejects(ctx.bill.recordPaymentAttempt({
    invoice_id:     inv.id,
    attempt_number: 0,
    status:         "failed",
  }), /attempt_number/);

  // Unknown invoice refused.
  await assert.rejects(ctx.bill.recordPaymentAttempt({
    invoice_id:     _validUUID(),
    attempt_number: 1,
    status:         "failed",
  }), /not found/);
}

// ---- markPaid / markFailed FSM ------------------------------------------

async function _markPaidFsm() {
  var ctx = _setup();
  var sub = await _seedSubscription(ctx.query);
  var inv = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1700000000000,
    period_end:      1702592000000,
    amount_minor:    4999,
    currency:        "USD",
  });

  // pending → paid
  var paid = await ctx.bill.markPaid({ invoice_id: inv.id, paid_at: 1701000000000 });
  check("markPaid flips status to paid", paid.status === "paid");
  check("markPaid persists paid_at",      paid.paid_at === 1701000000000);

  // markPaid replay is no-op.
  var replay = await ctx.bill.markPaid({ invoice_id: inv.id, paid_at: 1701000099999 });
  check("markPaid replay is no-op",       replay.status === "paid");
  check("markPaid replay keeps paid_at",   replay.paid_at === 1701000000000);

  // markFailed on paid invoice refused.
  await assert.rejects(ctx.bill.markFailed({
    invoice_id:     inv.id,
    reason:         "trying to fail a paid invoice",
    attempt_number: 1,
  }), /already paid/);

  // failed → paid (processor automatic-recovery flow).
  var inv2 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1700000000000,
    period_end:      1702592000000,
    amount_minor:    4999,
    currency:        "USD",
  });
  await ctx.bill.markFailed({
    invoice_id:     inv2.id,
    reason:         "card_declined",
    attempt_number: 1,
    next_retry_at:  Date.now() + 24 * 60 * 60 * 1000,
  });
  var failed = await ctx.query("SELECT status FROM subscription_invoices WHERE id = ?1", [inv2.id]);
  check("markFailed flips status to failed", failed.rows[0].status === "failed");

  // markFailed also wrote an attempt row.
  var attempts = await ctx.query("SELECT * FROM subscription_payment_attempts WHERE invoice_id = ?1", [inv2.id]);
  check("markFailed writes attempt row", attempts.rows.length === 1 && attempts.rows[0].status === "failed");

  // recovery: failed → paid
  var recovered = await ctx.bill.markPaid({ invoice_id: inv2.id, paid_at: Date.now() });
  check("failed → paid recovery", recovered.status === "paid");

  // markFailed next_retry_at on returned row.
  var inv3 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1700000000000,
    period_end:      1702592000000,
    amount_minor:    100,
    currency:        "USD",
  });
  var retry = Date.now() + 48 * 60 * 60 * 1000;
  var failedRow = await ctx.bill.markFailed({
    invoice_id:     inv3.id,
    reason:         "insufficient_funds",
    attempt_number: 1,
    next_retry_at:  retry,
  });
  check("markFailed surfaces next_retry_at on returned row", failedRow.next_retry_at === retry);

  // Void path: simulate a void by directly setting status (no
  // public surface yet — operator scripts go through SQL). Confirm
  // markPaid + markFailed refuse on voided.
  var inv4 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1700000000000,
    period_end:      1702592000000,
    amount_minor:    500,
    currency:        "USD",
  });
  await ctx.query("UPDATE subscription_invoices SET status = 'voided', voided_at = ?1 WHERE id = ?2", [Date.now(), inv4.id]);
  await assert.rejects(ctx.bill.markPaid({ invoice_id: inv4.id, paid_at: Date.now() }), /voided/);
  await assert.rejects(ctx.bill.markFailed({
    invoice_id:     inv4.id,
    reason:         "ghost",
    attempt_number: 1,
  }), /voided/);

  // Unknown invoice refused.
  await assert.rejects(ctx.bill.markPaid({ invoice_id: _validUUID(), paid_at: Date.now() }), /not found/);
  await assert.rejects(ctx.bill.markFailed({
    invoice_id:     _validUUID(),
    reason:         "ghost",
    attempt_number: 1,
  }), /not found/);
}

// ---- dunning enter / exit -----------------------------------------------

async function _dunningLifecycle() {
  var ctx = _setup();
  var sub = await _seedSubscription(ctx.query);

  var entered = await ctx.bill.enterDunning({
    subscription_id: sub.subscription_id,
    reason:          "invoice failed × 2",
  });
  check("enterDunning state is dunning",  entered.state === "dunning");
  check("enterDunning stamps entered_at", typeof entered.entered_at === "number" && entered.entered_at > 0);
  check("enterDunning exited_at is null", entered.exited_at == null);
  check("enterDunning persists reason",    entered.reason === "invoice failed × 2");

  // Re-entering refused.
  await assert.rejects(ctx.bill.enterDunning({
    subscription_id: sub.subscription_id,
    reason:          "double enter",
  }), /already in dunning/);

  // Exit happy path.
  var exited = await ctx.bill.exitDunning({
    subscription_id: sub.subscription_id,
    outcome:         "recovered",
  });
  check("exitDunning records outcome state", exited.state === "recovered");
  check("exitDunning stamps exited_at on outcome row", exited.exited_at != null);

  // The prior open row is now closed.
  var allRows = (await ctx.query(
    "SELECT * FROM subscription_dunning_states WHERE subscription_id = ?1 ORDER BY id ASC",
    [sub.subscription_id],
  )).rows;
  check("dunning history has 2 rows", allRows.length === 2);
  // Pair is identifiable by `state` — the two rows can share a
  // millisecond timestamp under the test rig, so leaning on
  // insertion-order rank isn't reliable. The contract that matters
  // is that the original dunning row got its exited_at stamped and
  // a sibling outcome row is present.
  var closedDunning = allRows.filter(function (r) { return r.state === "dunning"; })[0];
  var outcomeRow    = allRows.filter(function (r) { return r.state === "recovered"; })[0];
  check("history has one closed dunning row", closedDunning != null && closedDunning.exited_at != null);
  check("history has one recovered outcome",   outcomeRow != null);

  // Exit when not in dunning refused.
  await assert.rejects(ctx.bill.exitDunning({
    subscription_id: sub.subscription_id,
    outcome:         "recovered",
  }), /not currently in dunning/);

  // Re-enter after recovery allowed.
  var entered2 = await ctx.bill.enterDunning({
    subscription_id: sub.subscription_id,
    reason:          "second-cycle failure",
  });
  check("re-enter after recovery allowed", entered2.state === "dunning");

  // Bad outcome refused.
  await assert.rejects(ctx.bill.exitDunning({
    subscription_id: sub.subscription_id,
    outcome:         "lost",
  }), /outcome must be one of/);

  // Other exit outcomes accepted.
  var sub2 = await _seedSubscription(ctx.query);
  await ctx.bill.enterDunning({ subscription_id: sub2.subscription_id, reason: "bad card" });
  var cancelled = await ctx.bill.exitDunning({ subscription_id: sub2.subscription_id, outcome: "cancelled" });
  check("cancelled outcome accepted", cancelled.state === "cancelled");

  var sub3 = await _seedSubscription(ctx.query);
  await ctx.bill.enterDunning({ subscription_id: sub3.subscription_id, reason: "no recovery" });
  var writtenOff = await ctx.bill.exitDunning({ subscription_id: sub3.subscription_id, outcome: "written_off" });
  check("written_off outcome accepted", writtenOff.state === "written_off");

  // Unknown subscription refused.
  await assert.rejects(ctx.bill.enterDunning({
    subscription_id: _validUUID(),
    reason:          "ghost",
  }), /not found/);
}

// ---- invoicesForSubscription ordering ----------------------------------

async function _invoicesOrdering() {
  var ctx = _setup();
  var sub = await _seedSubscription(ctx.query);

  // Insert three invoices with monotonically increasing created_at —
  // the primitive stamps created_at off Date.now() inside the call,
  // so we let the natural ordering run.
  var inv1 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1,
    period_end:      2,
    amount_minor:    100,
    currency:        "USD",
  });
  // Force a measurable created_at gap.
  await ctx.query("UPDATE subscription_invoices SET created_at = ?1 WHERE id = ?2", [1, inv1.id]);
  var inv2 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    3,
    period_end:      4,
    amount_minor:    200,
    currency:        "USD",
  });
  await ctx.query("UPDATE subscription_invoices SET created_at = ?1 WHERE id = ?2", [2, inv2.id]);
  var inv3 = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    5,
    period_end:      6,
    amount_minor:    300,
    currency:        "USD",
  });
  await ctx.query("UPDATE subscription_invoices SET created_at = ?1 WHERE id = ?2", [3, inv3.id]);

  var list = await ctx.bill.invoicesForSubscription(sub.subscription_id);
  check("invoicesForSubscription returns 3 rows", list.length === 3);
  check("ordered newest first",                    list[0].id === inv3.id);
  check("middle row second",                       list[1].id === inv2.id);
  check("oldest row last",                          list[2].id === inv1.id);

  // Bad uuid refused.
  await assert.rejects(ctx.bill.invoicesForSubscription("not-a-uuid"), /subscription_id/);
}

// ---- failedInvoices window ---------------------------------------------

async function _failedInvoicesWindow() {
  var ctx = _setup();
  var sub = await _seedSubscription(ctx.query);

  // Three failed invoices at known created_at timestamps.
  var ids = [];
  for (var i = 0; i < 3; i += 1) {
    var inv = await ctx.bill.recordInvoice({
      subscription_id: sub.subscription_id,
      period_start:    1,
      period_end:      2,
      amount_minor:    100 * (i + 1),
      currency:        "USD",
    });
    await ctx.bill.markFailed({
      invoice_id:     inv.id,
      reason:         "fail " + i,
      attempt_number: 1,
    });
    var atTs = 1000 * (i + 1);
    await ctx.query("UPDATE subscription_invoices SET created_at = ?1 WHERE id = ?2", [atTs, inv.id]);
    ids.push({ id: inv.id, at: atTs });
  }
  // Plus one paid invoice that must NOT appear.
  var paidInv = await ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1,
    period_end:      2,
    amount_minor:    9999,
    currency:        "USD",
  });
  await ctx.bill.markPaid({ invoice_id: paidInv.id, paid_at: Date.now() });

  // Wide window: all 3 failed.
  var all = await ctx.bill.failedInvoices({ from: 1, to: 10000, limit: 50 });
  check("failedInvoices returns all 3 within wide window", all.length === 3);
  check("failedInvoices excludes paid invoice",            all.every(function (r) { return r.status === "failed"; }));
  check("failedInvoices ordered newest first",             all[0].id === ids[2].id);

  // Narrow window: only the middle row.
  var narrow = await ctx.bill.failedInvoices({ from: 1500, to: 2500, limit: 50 });
  check("failedInvoices narrow window returns 1 row", narrow.length === 1);
  check("failedInvoices narrow window matches expected id", narrow[0].id === ids[1].id);

  // Limit clamps.
  var limited = await ctx.bill.failedInvoices({ from: 1, to: 10000, limit: 2 });
  check("failedInvoices respects limit", limited.length === 2);

  // from > to refused.
  await assert.rejects(ctx.bill.failedInvoices({ from: 100, to: 50 }), /from must be <= to/);

  // Bad limit refused.
  await assert.rejects(ctx.bill.failedInvoices({ from: 1, to: 2, limit: 0 }), /limit/);
  await assert.rejects(ctx.bill.failedInvoices({ from: 1, to: 2, limit: 99999 }), /limit/);
}

// ---- dunningRoster snapshot --------------------------------------------

async function _dunningRosterSnapshot() {
  var ctx = _setup();

  // Three subscriptions; two enter dunning, one recovers.
  var s1 = await _seedSubscription(ctx.query);
  var s2 = await _seedSubscription(ctx.query);
  var s3 = await _seedSubscription(ctx.query);

  await ctx.bill.enterDunning({ subscription_id: s1.subscription_id, reason: "open 1" });
  await ctx.bill.enterDunning({ subscription_id: s2.subscription_id, reason: "open 2" });
  await ctx.bill.enterDunning({ subscription_id: s3.subscription_id, reason: "to recover" });
  await ctx.bill.exitDunning({ subscription_id: s3.subscription_id, outcome: "recovered" });

  var roster = await ctx.bill.dunningRoster({ as_of: Date.now() + 1000 });
  check("dunningRoster returns 2 open rows", roster.length === 2);
  check("dunningRoster excludes recovered subscription",
    roster.every(function (r) { return r.subscription_id !== s3.subscription_id; }));
  check("dunningRoster rows are dunning state",
    roster.every(function (r) { return r.state === "dunning" && r.exited_at == null; }));

  // as_of in the past — entered_at filter excludes rows that haven't happened yet.
  var rosterPast = await ctx.bill.dunningRoster({ as_of: 1 });
  check("dunningRoster as_of in the past returns 0", rosterPast.length === 0);

  // Validation.
  await assert.rejects(ctx.bill.dunningRoster(), /input object required/);
  await assert.rejects(ctx.bill.dunningRoster({ as_of: "now" }), /as_of/);
}

// ---- arpu math ----------------------------------------------------------

async function _arpuMath() {
  var ctx = _setup();
  var s1 = await _seedSubscription(ctx.query);
  var s2 = await _seedSubscription(ctx.query);

  // s1: two paid USD invoices (1000 + 2000); one failed (skipped in arpu).
  var s1a = await ctx.bill.recordInvoice({
    subscription_id: s1.subscription_id, period_start: 1, period_end: 2,
    amount_minor: 1000, currency: "USD",
  });
  await ctx.bill.markPaid({ invoice_id: s1a.id, paid_at: 1500 });
  var s1b = await ctx.bill.recordInvoice({
    subscription_id: s1.subscription_id, period_start: 1, period_end: 2,
    amount_minor: 2000, currency: "USD",
  });
  await ctx.bill.markPaid({ invoice_id: s1b.id, paid_at: 1600 });
  var s1c = await ctx.bill.recordInvoice({
    subscription_id: s1.subscription_id, period_start: 1, period_end: 2,
    amount_minor: 9999, currency: "USD",
  });
  await ctx.bill.markFailed({ invoice_id: s1c.id, reason: "skip me", attempt_number: 1 });

  // s2: one paid USD invoice (4000); one paid EUR invoice (5000).
  var s2a = await ctx.bill.recordInvoice({
    subscription_id: s2.subscription_id, period_start: 1, period_end: 2,
    amount_minor: 4000, currency: "USD",
  });
  await ctx.bill.markPaid({ invoice_id: s2a.id, paid_at: 1700 });
  var s2b = await ctx.bill.recordInvoice({
    subscription_id: s2.subscription_id, period_start: 1, period_end: 2,
    amount_minor: 5000, currency: "EUR",
  });
  await ctx.bill.markPaid({ invoice_id: s2b.id, paid_at: 1800 });

  // Outside the window (paid_at after `to`) — must not be counted.
  var s2c = await ctx.bill.recordInvoice({
    subscription_id: s2.subscription_id, period_start: 1, period_end: 2,
    amount_minor: 999999, currency: "USD",
  });
  await ctx.bill.markPaid({ invoice_id: s2c.id, paid_at: 999999 });

  var result = await ctx.bill.arpu({ from: 1, to: 2000 });
  check("arpu USD total_minor",   result.USD.total_minor === 7000);          // 1000 + 2000 + 4000
  check("arpu USD subscriptions", result.USD.subscriptions === 2);            // s1 + s2
  check("arpu USD arpu_minor",     result.USD.arpu_minor === 3500);            // 7000 / 2

  check("arpu EUR total_minor",   result.EUR.total_minor === 5000);
  check("arpu EUR subscriptions", result.EUR.subscriptions === 1);
  check("arpu EUR arpu_minor",     result.EUR.arpu_minor === 5000);

  // Empty window returns empty map.
  var empty = await ctx.bill.arpu({ from: 999999999999, to: 999999999999 + 1 });
  check("arpu empty window returns empty map", Object.keys(empty).length === 0);

  // Validation.
  await assert.rejects(ctx.bill.arpu(), /input object required/);
  await assert.rejects(ctx.bill.arpu({ from: 2, to: 1 }), /from must be <= to/);
  await assert.rejects(ctx.bill.arpu({ from: 0, to: 1 }), /from/);
}

// ---- validation ---------------------------------------------------------

async function _validation() {
  var ctx = _setup();
  var sub = await _seedSubscription(ctx.query);

  // Factory refuses missing subscriptions handle.
  assert.throws(function () { subscriptionBilling.create({ query: ctx.query }); }, /subscriptions handle required/);

  // recordInvoice: missing input / bad UUID / bad currency.
  await assert.rejects(ctx.bill.recordInvoice(),    /input object required/);
  await assert.rejects(ctx.bill.recordInvoice({}),  /subscription_id/);
  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: "not-a-uuid",
  }), /subscription_id/);
  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
  }), /period_start/);
  await assert.rejects(ctx.bill.recordInvoice({
    subscription_id: sub.subscription_id,
    period_start:    1,
    period_end:      2,
    amount_minor:    -1,
    currency:        "USD",
  }), /amount_minor/);

  // Long reason refused.
  await assert.rejects(ctx.bill.enterDunning({
    subscription_id: sub.subscription_id,
    reason:          "x".repeat(281),
  }), /reason/);

  // Control bytes in reason refused.
  await assert.rejects(ctx.bill.enterDunning({
    subscription_id: sub.subscription_id,
    reason:          "bad\x00byte",
  }), /reason/);

  // recordPaymentAttempt input validation.
  await assert.rejects(ctx.bill.recordPaymentAttempt(), /input object required/);
  await assert.rejects(ctx.bill.recordPaymentAttempt({ invoice_id: "bad" }), /invoice_id/);

  // markPaid input validation.
  await assert.rejects(ctx.bill.markPaid(),                                /input object required/);
  await assert.rejects(ctx.bill.markPaid({ invoice_id: _validUUID() }),     /paid_at/);

  // markFailed input validation.
  await assert.rejects(ctx.bill.markFailed(),                                            /input object required/);
  await assert.rejects(ctx.bill.markFailed({ invoice_id: _validUUID(), reason: "x" }),   /attempt_number/);

  // enterDunning / exitDunning input validation.
  await assert.rejects(ctx.bill.enterDunning(),                                /input object required/);
  await assert.rejects(ctx.bill.exitDunning(),                                 /input object required/);
  await assert.rejects(ctx.bill.exitDunning({ subscription_id: sub.subscription_id }), /outcome/);
}

async function run() {
  await _recordInvoiceHappy();
  await _paymentAttemptSequencing();
  await _markPaidFsm();
  await _dunningLifecycle();
  await _invoicesOrdering();
  await _failedInvoicesWindow();
  await _dunningRosterSnapshot();
  await _arpuMath();
  await _validation();
}

module.exports = { run: run };

// Standalone invocation.
if (require.main === module) {
  run().then(function () {
    console.log("subscription-billing: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
