"use strict";
/**
 * credit-limits — B2B credit accounts + outstanding-balance accounting
 * + aging-report bucketing.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0122
 * (credit_accounts + credit_transactions).
 *
 * Coverage:
 *   - defineAccount creates an active account; second define refuses
 *   - chargeOrder up to the limit; overdraw refuses with
 *     CREDIT_LIMIT_EXCEEDED and writes no row
 *   - releaseHold restores credit; double-release refuses
 *   - recordPayment reduces the outstanding balance; overpayment
 *     refused
 *   - agingReport bucketizes outstanding by age + applies FIFO
 *     settlement of payments against the oldest charges
 *   - FSM: suspend → reinstate; suspended account refuses charges;
 *     closed is terminal
 *   - listAccounts filters by status
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var creditLimits = require("../../lib/credit-limits");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0122_credit_limits.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:     h.db,
    query:  h.query,
    credit: creditLimits.create({ query: h.query }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

async function _defineAccountBasics() {
  var f = _factory();
  var custId = _uuid();

  var acct = await f.credit.defineAccount({
    customer_id:        custId,
    credit_limit_minor: 500000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });
  check("define returns active",            acct.status === "active");
  check("define stores limit",              acct.credit_limit_minor === 500000);
  check("define stores currency",           acct.currency === "USD");
  check("define stores terms",              acct.payment_terms_days === 30);
  check("define stores cycle",              acct.billing_cycle === "monthly");
  check("define created_at present",        typeof acct.created_at === "number" && acct.created_at > 0);

  var fetched = await f.credit.getAccount(custId);
  check("getAccount returns row",           fetched && fetched.customer_id === custId);
  check("get unknown returns null",         (await f.credit.getAccount(_uuid())) === null);

  // Second define refuses.
  await assert.rejects(
    f.credit.defineAccount({
      customer_id:        custId,
      credit_limit_minor: 100000,
      currency:           "USD",
      payment_terms_days: 15,
      billing_cycle:      "weekly",
    }),
    /already exists/,
  );

  // Empty available + outstanding at start.
  var avail = await f.credit.availableCredit(custId);
  check("available equals limit at start",  avail.available_minor === 500000 && avail.outstanding_minor === 0);
  var out = await f.credit.outstandingBalance(custId);
  check("outstanding 0 at start",           out.outstanding_minor === 0);
}

async function _chargeOrderUpToLimit() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id:        custId,
    credit_limit_minor: 1000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });

  var o1 = _uuid();
  var r1 = await f.credit.chargeOrder({ customer_id: custId, order_id: o1, amount_minor: 400 });
  check("first charge balance_after 400",   r1.balance_after_minor === 400 && r1.kind === "charge");
  check("first charge has id",              typeof r1.id === "string" && r1.id.length === 36);

  var o2 = _uuid();
  var r2 = await f.credit.chargeOrder({ customer_id: custId, order_id: o2, amount_minor: 600 });
  check("second charge balance_after 1000", r2.balance_after_minor === 1000);

  // At limit — next charge refused.
  var o3 = _uuid();
  var rejected;
  try {
    await f.credit.chargeOrder({ customer_id: custId, order_id: o3, amount_minor: 1 });
  } catch (e) { rejected = e; }
  check("charge over limit refused",        rejected && rejected.code === "CREDIT_LIMIT_EXCEEDED");
  check("rejected reports outstanding",     rejected.outstanding_minor === 1000);
  check("rejected reports limit",           rejected.credit_limit_minor === 1000);
  check("rejected reports attempted",       rejected.attempted_minor === 1);

  // No row landed for the refused charge.
  var txnCount = f.db.prepare("SELECT COUNT(*) AS c FROM credit_transactions WHERE customer_id = ?").all(custId)[0].c;
  check("refused charge wrote no row",      txnCount === 2);

  var avail = await f.credit.availableCredit(custId);
  check("available drained to 0",           avail.available_minor === 0 && avail.outstanding_minor === 1000);

  // Idempotent: re-charging an order that already has a charge returns the
  // ORIGINAL charge and lands NO second row — the same order_id can't be
  // double-charged against the line (a retried capture is a safe no-op). The
  // per-order dedup wins over the at-limit cap error, since the order was
  // already charged successfully.
  var dup = await f.credit.chargeOrder({ customer_id: custId, order_id: o1, amount_minor: 400 });
  check("re-charge same order returns the original charge", dup.id === r1.id && dup.idempotent === true);
  check("re-charge same order leaves balance at 1000",     (await f.credit.availableCredit(custId)).outstanding_minor === 1000);
  var txnAfterDup = f.db.prepare("SELECT COUNT(*) AS c FROM credit_transactions WHERE customer_id = ?").all(custId)[0].c;
  check("re-charge same order wrote no new row",           txnAfterDup === 2);

  // Idempotency is status-independent: after the account is suspended, a retry
  // of the already-charged order still returns the original charge rather than
  // throwing NOT_ACTIVE — the order-scoped dedup is checked before the
  // active-account gate.
  await f.credit.suspendAccount({ customer_id: custId, reason: "test-suspend" });
  var dupSuspended = await f.credit.chargeOrder({ customer_id: custId, order_id: o1, amount_minor: 400 });
  check("re-charge after suspend still returns the original charge",
    dupSuspended.id === r1.id && dupSuspended.idempotent === true);
  // A NEW order on the suspended account is still refused.
  var refusedSuspended;
  try { await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 1 }); }
  catch (e) { refusedSuspended = e; }
  check("new charge on suspended account refused", refusedSuspended && refusedSuspended.code === "CREDIT_ACCOUNT_NOT_ACTIVE");
}

async function _releaseHoldRestoresCredit() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id:        custId,
    credit_limit_minor: 1000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });

  var o1 = _uuid();
  await f.credit.chargeOrder({ customer_id: custId, order_id: o1, amount_minor: 700 });
  var out1 = await f.credit.outstandingBalance(custId);
  check("outstanding after charge",         out1.outstanding_minor === 700);

  var rel = await f.credit.releaseHold({ customer_id: custId, order_id: o1 });
  check("release returns balance_after 0",  rel.balance_after_minor === 0 && rel.kind === "release");
  check("release amount matches charge",    rel.amount_minor === 700);

  var avail = await f.credit.availableCredit(custId);
  check("available restored after release", avail.available_minor === 1000);

  // Double-release refused.
  var rejected;
  try {
    await f.credit.releaseHold({ customer_id: custId, order_id: o1 });
  } catch (e) { rejected = e; }
  check("double release refused",           rejected && rejected.code === "CREDIT_RELEASE_NOT_FOUND");

  // Release on never-charged order refused.
  var rejected2;
  try {
    await f.credit.releaseHold({ customer_id: custId, order_id: _uuid() });
  } catch (e) { rejected2 = e; }
  check("release unknown order refused",    rejected2 && rejected2.code === "CREDIT_RELEASE_NOT_FOUND");
}

async function _recordPaymentReducesBalance() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id:        custId,
    credit_limit_minor: 5000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });

  await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 1500 });
  await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 800 });

  var pay1 = await f.credit.recordPayment({ customer_id: custId, amount_minor: 1000, payment_ref: "WIRE-2026-001" });
  check("payment returns balance_after",    pay1.balance_after_minor === 1300 && pay1.kind === "payment");
  check("payment_ref persisted",            pay1.payment_ref === "WIRE-2026-001");

  var avail = await f.credit.availableCredit(custId);
  check("available restored by payment",    avail.available_minor === 3700 && avail.outstanding_minor === 1300);

  // Overpayment refused.
  var rejected;
  try {
    await f.credit.recordPayment({ customer_id: custId, amount_minor: 9999, payment_ref: "WIRE-OVER" });
  } catch (e) { rejected = e; }
  check("overpayment refused",              rejected && rejected.code === "CREDIT_PAYMENT_EXCEEDS_OUTSTANDING");
  check("rejected reports outstanding",     rejected.outstanding_minor === 1300);

  // Full pay-off.
  var pay2 = await f.credit.recordPayment({ customer_id: custId, amount_minor: 1300, payment_ref: "WIRE-2026-002" });
  check("payment to zero",                  pay2.balance_after_minor === 0);

  // Replay-derivability: charges - (payments + releases) === outstanding.
  var sumRows = f.db.prepare(
    "SELECT kind, SUM(amount_minor) AS s FROM credit_transactions WHERE customer_id = ? GROUP BY kind"
  ).all(custId);
  var totals = { charge: 0, hold: 0, payment: 0, release: 0, adjustment: 0 };
  for (var i = 0; i < sumRows.length; i += 1) totals[sumRows[i].kind] = sumRows[i].s;
  check("replay-derived balance matches",   totals.charge + totals.hold - totals.payment - totals.release === 0);
}

async function _agingReportBucketing() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id:        custId,
    credit_limit_minor: 1000000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });

  var now = Date.now();
  var DAY = 86400 * 1000;

  // 4 charges, one in each bucket relative to a net-30 account.
  // Bucketing is by days-past-due (ageDays - payment_terms_days):
  //   current  = within terms
  //   d30      = 1-30 days past due
  //   d60      = 31-60 days past due
  //   d90_plus = 60+ days past due
  //
  // Inserted in chronological order so the monotonic-clock bump
  // doesn't collapse out-of-order writes into the same instant:
  //   d90_plus (120d ago, 90d past due)  — 400
  //   d60      (80d ago,  50d past due)  — 300
  //   d30      (40d ago,  10d past due)  — 200
  //   current  (10d ago,  within terms)  — 100
  await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 400, occurred_at: now - 120 * DAY });
  await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 300, occurred_at: now - 80 * DAY });
  await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 200, occurred_at: now - 40 * DAY });
  await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 100, occurred_at: now - 10 * DAY });

  var rep = await f.credit.agingReport({ customer_id: custId, now: now });
  check("aging total outstanding",          rep.total_outstanding_minor === 1000);
  check("aging current bucket",             rep.buckets.current === 100);
  check("aging d30 bucket",                 rep.buckets.d30 === 200);
  check("aging d60 bucket",                 rep.buckets.d60 === 300);
  check("aging d90_plus bucket",            rep.buckets.d90_plus === 400);
  check("aging echoes terms",               rep.payment_terms_days === 30);
  check("aging echoes currency",            rep.currency === "USD");
  check("aging echoes as_of",               rep.as_of === now);

  // Apply a payment — FIFO settles against the oldest charges first.
  // 450 payment drains the 400 (120d, d90_plus) + 50 of the 300
  // (80d, d60), leaving 250 in d60.
  await f.credit.recordPayment({ customer_id: custId, amount_minor: 450, payment_ref: "WIRE-AGE" });
  var rep2 = await f.credit.agingReport({ customer_id: custId, now: now });
  check("FIFO drained d90 bucket",          rep2.buckets.d90_plus === 0);
  check("FIFO partial drained d60",         rep2.buckets.d60 === 250);
  check("FIFO untouched d30",               rep2.buckets.d30 === 200);
  check("FIFO untouched current",           rep2.buckets.current === 100);
  check("FIFO total reduced by 450",        rep2.total_outstanding_minor === 550);

  // Empty account → all zeros.
  var fresh = _uuid();
  await f.credit.defineAccount({
    customer_id:        fresh,
    credit_limit_minor: 1000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "weekly",
  });
  var rep3 = await f.credit.agingReport({ customer_id: fresh });
  check("aging empty: total 0",             rep3.total_outstanding_minor === 0);
  check("aging empty: buckets 0",
        rep3.buckets.current === 0 && rep3.buckets.d30 === 0 && rep3.buckets.d60 === 0 && rep3.buckets.d90_plus === 0);
}

async function _fsmTransitions() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id:        custId,
    credit_limit_minor: 1000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });

  // Suspend.
  var s1 = await f.credit.suspendAccount({ customer_id: custId, reason: "payment-overdue" });
  check("suspended status",                 s1.status === "suspended");
  check("suspended reason persisted",       s1.suspended_reason === "payment-overdue");
  check("suspended_at set",                 typeof s1.suspended_at === "number");

  // Suspended → suspended refused.
  await assert.rejects(
    f.credit.suspendAccount({ customer_id: custId, reason: "duplicate" }),
    /already suspended/,
  );

  // Suspended account refuses charges.
  var rejected;
  try {
    await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 100 });
  } catch (e) { rejected = e; }
  check("suspended refuses charge",         rejected && rejected.code === "CREDIT_ACCOUNT_NOT_ACTIVE");

  // availableCredit on suspended is 0.
  var avail = await f.credit.availableCredit(custId);
  check("suspended available is 0",         avail.available_minor === 0 && avail.status === "suspended");

  // Reinstate.
  var r1 = await f.credit.reinstateAccount(custId);
  check("reinstated active",                r1.status === "active");
  check("reinstated reason cleared",        r1.suspended_reason === null);
  check("reinstated suspended_at cleared",  r1.suspended_at === null);

  // Already-active reinstate refused.
  await assert.rejects(
    f.credit.reinstateAccount(custId),
    /already active/,
  );

  // Charges work again post-reinstate.
  var ok = await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 100 });
  check("post-reinstate charge ok",         ok.balance_after_minor === 100);

  // updateAccount: bump limit.
  var upd = await f.credit.updateAccount(custId, { credit_limit_minor: 2000 });
  check("update limit reflected",           upd.credit_limit_minor === 2000);

  // updateAccount: only allowed status transition is closed.
  await assert.rejects(
    f.credit.updateAccount(custId, { status: "suspended" }),
    /status transition via update is restricted/,
  );

  // Close terminal.
  var closed = await f.credit.updateAccount(custId, { status: "closed" });
  check("closed status",                    closed.status === "closed");

  // Closed account refuses suspend + reinstate + update.
  await assert.rejects(
    f.credit.suspendAccount({ customer_id: custId, reason: "x" }),
    /closed/,
  );
  await assert.rejects(
    f.credit.reinstateAccount(custId),
    /closed/,
  );
  await assert.rejects(
    f.credit.updateAccount(custId, { credit_limit_minor: 9999 }),
    /closed/,
  );

  // Closed refuses charges.
  var rejected2;
  try {
    await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 1 });
  } catch (e) { rejected2 = e; }
  check("closed refuses charge",            rejected2 && rejected2.code === "CREDIT_ACCOUNT_NOT_ACTIVE");

  // recordPayment still works on closed — paying down terminal AR.
  var pay = await f.credit.recordPayment({ customer_id: custId, amount_minor: 100, payment_ref: "FINAL-PAYMENT" });
  check("closed accepts payment",           pay.balance_after_minor === 0);
}

async function _listAccountsFilter() {
  var f = _factory();
  var a = _uuid(), b = _uuid(), c = _uuid();

  // Define three accounts with slight created_at spacing so the
  // ORDER BY created_at ASC ordering is deterministic.
  await f.credit.defineAccount({ customer_id: a, credit_limit_minor: 100, currency: "USD", payment_terms_days: 30, billing_cycle: "monthly" });
  await new Promise(function (r) { setTimeout(r, 2); });    // allow:test-promise-settimeout-sleep — created_at ordering relies on monotonically increasing wall-clock between defines
  await f.credit.defineAccount({ customer_id: b, credit_limit_minor: 200, currency: "USD", payment_terms_days: 15, billing_cycle: "weekly" });
  await new Promise(function (r) { setTimeout(r, 2); });    // allow:test-promise-settimeout-sleep — created_at ordering relies on monotonically increasing wall-clock between defines
  await f.credit.defineAccount({ customer_id: c, credit_limit_minor: 300, currency: "USD", payment_terms_days: 60, billing_cycle: "biweekly" });

  await f.credit.suspendAccount({ customer_id: b, reason: "audit-hold" });

  var all = await f.credit.listAccounts({});
  check("list all returns 3",               all.length === 3);

  var active = await f.credit.listAccounts({ status: "active" });
  check("list active returns 2",            active.length === 2);
  var activeIds = active.map(function (r) { return r.customer_id; });
  check("list active excludes suspended",   activeIds.indexOf(b) === -1);

  var suspended = await f.credit.listAccounts({ status: "suspended" });
  check("list suspended returns 1",         suspended.length === 1 && suspended[0].customer_id === b);

  var closed = await f.credit.listAccounts({ status: "closed" });
  check("list closed empty",                closed.length === 0);
}

async function _customersStubGate() {
  // Optional customers handle: when provided, defineAccount confirms
  // the customer row exists; otherwise it skips the check.
  var h = _makeQuery();
  var known = _uuid();
  var custStub = {
    get: async function (id) {
      return id === known ? { id: known } : null;
    },
  };
  var credit = creditLimits.create({ query: h.query, customers: custStub });

  var ok = await credit.defineAccount({
    customer_id:        known,
    credit_limit_minor: 100,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });
  check("known customer accepted",          ok.status === "active");

  await assert.rejects(
    credit.defineAccount({
      customer_id:        _uuid(),
      credit_limit_minor: 100,
      currency:           "USD",
      payment_terms_days: 30,
      billing_cycle:      "monthly",
    }),
    /not found in customers/,
  );
}

async function _validation() {
  var f = _factory();
  var ok = _uuid();
  await f.credit.defineAccount({
    customer_id:        ok,
    credit_limit_minor: 1000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });

  // defineAccount
  await assert.rejects(f.credit.defineAccount(),                                                                       /input object required/);
  await assert.rejects(f.credit.defineAccount({}),                                                                     /customer_id/);
  await assert.rejects(f.credit.defineAccount({ customer_id: "not-a-uuid", credit_limit_minor: 100, currency: "USD",
                                                  payment_terms_days: 30, billing_cycle: "monthly" }),                  /customer_id/);
  await assert.rejects(f.credit.defineAccount({ customer_id: _uuid(), credit_limit_minor: -1, currency: "USD",
                                                  payment_terms_days: 30, billing_cycle: "monthly" }),                  /credit_limit_minor/);
  await assert.rejects(f.credit.defineAccount({ customer_id: _uuid(), credit_limit_minor: 1.5, currency: "USD",
                                                  payment_terms_days: 30, billing_cycle: "monthly" }),                  /credit_limit_minor/);
  await assert.rejects(f.credit.defineAccount({ customer_id: _uuid(), credit_limit_minor: 100, currency: "",
                                                  payment_terms_days: 30, billing_cycle: "monthly" }),                  /currency/);
  await assert.rejects(f.credit.defineAccount({ customer_id: _uuid(), credit_limit_minor: 100, currency: "USD",
                                                  payment_terms_days: 0,  billing_cycle: "monthly" }),                  /payment_terms_days/);
  await assert.rejects(f.credit.defineAccount({ customer_id: _uuid(), credit_limit_minor: 100, currency: "USD",
                                                  payment_terms_days: 30, billing_cycle: "bogus" }),                    /billing_cycle/);

  // getAccount
  await assert.rejects(f.credit.getAccount("not-a-uuid"),                                                              /customer_id/);

  // listAccounts
  await assert.rejects(f.credit.listAccounts({ status: "bogus" }),                                                     /status/);

  // updateAccount
  await assert.rejects(f.credit.updateAccount("not-a-uuid", {}),                                                       /customer_id/);
  await assert.rejects(f.credit.updateAccount(ok, null),                                                                /patch object required/);
  await assert.rejects(f.credit.updateAccount(ok, {}),                                                                  /at least one updatable field/);
  await assert.rejects(f.credit.updateAccount(_uuid(), { credit_limit_minor: 100 }),                                    /no account for customer/);
  await assert.rejects(f.credit.updateAccount(ok, { billing_cycle: "annual" }),                                         /billing_cycle/);

  // suspendAccount
  await assert.rejects(f.credit.suspendAccount(),                                                                       /input object required/);
  await assert.rejects(f.credit.suspendAccount({ customer_id: ok }),                                                    /reason/);
  await assert.rejects(f.credit.suspendAccount({ customer_id: ok, reason: "" }),                                        /reason/);
  await assert.rejects(f.credit.suspendAccount({ customer_id: ok, reason: "bad\nline" }),                               /reason/);
  await assert.rejects(f.credit.suspendAccount({ customer_id: _uuid(), reason: "x" }),                                  /no account for customer/);

  // reinstateAccount
  await assert.rejects(f.credit.reinstateAccount("not-a-uuid"),                                                         /customer_id/);
  await assert.rejects(f.credit.reinstateAccount(_uuid()),                                                              /no account for customer/);

  // chargeOrder
  await assert.rejects(f.credit.chargeOrder(),                                                                          /input object required/);
  await assert.rejects(f.credit.chargeOrder({ customer_id: "x", order_id: _uuid(), amount_minor: 1 }),                  /customer_id/);
  await assert.rejects(f.credit.chargeOrder({ customer_id: ok, order_id: "x", amount_minor: 1 }),                       /order_id/);
  await assert.rejects(f.credit.chargeOrder({ customer_id: ok, order_id: _uuid(), amount_minor: 0 }),                   /amount_minor/);
  await assert.rejects(f.credit.chargeOrder({ customer_id: ok, order_id: _uuid(), amount_minor: -1 }),                  /amount_minor/);
  await assert.rejects(f.credit.chargeOrder({ customer_id: ok, order_id: _uuid(), amount_minor: 1.5 }),                 /amount_minor/);
  await assert.rejects(f.credit.chargeOrder({ customer_id: ok, order_id: _uuid(), amount_minor: 1, occurred_at: -1 }),  /occurred_at/);

  // chargeOrder on unknown account.
  var unknownAcct;
  try {
    await f.credit.chargeOrder({ customer_id: _uuid(), order_id: _uuid(), amount_minor: 1 });
  } catch (e) { unknownAcct = e; }
  check("charge unknown returns NOT_FOUND code", unknownAcct && unknownAcct.code === "CREDIT_ACCOUNT_NOT_FOUND");

  // releaseHold
  await assert.rejects(f.credit.releaseHold(),                                                                          /input object required/);
  await assert.rejects(f.credit.releaseHold({ customer_id: "x", order_id: _uuid() }),                                   /customer_id/);
  await assert.rejects(f.credit.releaseHold({ customer_id: ok, order_id: "x" }),                                        /order_id/);
  var unknownAcct2;
  try {
    await f.credit.releaseHold({ customer_id: _uuid(), order_id: _uuid() });
  } catch (e) { unknownAcct2 = e; }
  check("release unknown account NOT_FOUND",     unknownAcct2 && unknownAcct2.code === "CREDIT_ACCOUNT_NOT_FOUND");

  // recordPayment
  await assert.rejects(f.credit.recordPayment(),                                                                        /input object required/);
  await assert.rejects(f.credit.recordPayment({ customer_id: ok, amount_minor: 1 }),                                    /payment_ref/);
  await assert.rejects(f.credit.recordPayment({ customer_id: ok, amount_minor: 1, payment_ref: "" }),                   /payment_ref/);
  await assert.rejects(f.credit.recordPayment({ customer_id: ok, amount_minor: 0,  payment_ref: "x" }),                 /amount_minor/);
  await assert.rejects(f.credit.recordPayment({ customer_id: ok, amount_minor: 1,  payment_ref: "bad\nref" }),          /payment_ref/);
  var unknownPay;
  try {
    await f.credit.recordPayment({ customer_id: _uuid(), amount_minor: 1, payment_ref: "x" });
  } catch (e) { unknownPay = e; }
  check("payment unknown account NOT_FOUND",     unknownPay && unknownPay.code === "CREDIT_ACCOUNT_NOT_FOUND");

  // availableCredit / outstandingBalance
  await assert.rejects(f.credit.availableCredit("not-a-uuid"),                                                          /customer_id/);
  await assert.rejects(f.credit.availableCredit(_uuid()),                                                                /no account for customer/);
  await assert.rejects(f.credit.outstandingBalance("not-a-uuid"),                                                       /customer_id/);
  await assert.rejects(f.credit.outstandingBalance(_uuid()),                                                             /no account for customer/);

  // agingReport
  await assert.rejects(f.credit.agingReport(),                                                                          /input object required/);
  await assert.rejects(f.credit.agingReport({ customer_id: "x" }),                                                      /customer_id/);
  await assert.rejects(f.credit.agingReport({ customer_id: _uuid() }),                                                   /no account for customer/);
  await assert.rejects(f.credit.agingReport({ customer_id: ok, now: -1 }),                                              /now/);
}

async function _exportedConstants() {
  check("BILLING_CYCLES exported",          Array.isArray(creditLimits.BILLING_CYCLES)
                                            && creditLimits.BILLING_CYCLES.indexOf("weekly")   !== -1
                                            && creditLimits.BILLING_CYCLES.indexOf("biweekly") !== -1
                                            && creditLimits.BILLING_CYCLES.indexOf("monthly")  !== -1);
  check("STATUSES exported",                Array.isArray(creditLimits.STATUSES)
                                            && creditLimits.STATUSES.indexOf("active")    !== -1
                                            && creditLimits.STATUSES.indexOf("suspended") !== -1
                                            && creditLimits.STATUSES.indexOf("closed")    !== -1);
  check("KINDS exported",                   Array.isArray(creditLimits.KINDS) && creditLimits.KINDS.length === 5);
  check("AGE_BUCKETS exported",             creditLimits.AGE_BUCKETS && creditLimits.AGE_BUCKETS.CURRENT === "current");

  var inst = creditLimits.create({ query: _makeQuery().query });
  check("instance exposes BILLING_CYCLES",  inst.BILLING_CYCLES.length === 3);
  check("instance exposes STATUSES",        inst.STATUSES.length === 3);
  check("instance exposes KINDS",           inst.KINDS.length === 5);
  check("instance exposes AGE_BUCKETS",     inst.AGE_BUCKETS && inst.AGE_BUCKETS.D30 === "d30");
}

async function _monotonicOccurredAt() {
  // Two writes against the same customer in the same epoch-ms tie
  // on `occurred_at` without the monotonic-clock bump. The
  // primitive bumps the second write to `prior + 1` so the
  // denormalized "latest row" read remains unambiguous.
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id:        custId,
    credit_limit_minor: 10000,
    currency:           "USD",
    payment_terms_days: 30,
    billing_cycle:      "monthly",
  });

  var stamp = 1700000000000;
  var r1 = await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 100, occurred_at: stamp });
  var r2 = await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 200, occurred_at: stamp });
  var r3 = await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 300, occurred_at: stamp });
  check("first write at stamp",             r1.occurred_at === stamp);
  check("second write bumped",              r2.occurred_at === stamp + 1);
  check("third write bumped further",       r3.occurred_at === stamp + 2);
  check("balance derivation sound",         r3.balance_after_minor === 600);

  // Out-of-order operator timestamp lands strictly newer than the
  // prior write — even when the requested timestamp is older.
  var r4 = await f.credit.chargeOrder({ customer_id: custId, order_id: _uuid(), amount_minor: 50, occurred_at: stamp - 1000 });
  check("backdated write still monotonic",  r4.occurred_at === stamp + 3);
}

// BUG-1 (HIGH money-loss): releaseHold must cap the release at the order's
// UNPAID exposure, not its gross charge. Payments are revolving (order_id
// NULL) and apply global-FIFO oldest-order-first; a release used to ignore
// them, so in a multi-order account releasing a conceptually-paid order
// consumed balance that belonged to OTHER orders' genuine unpaid charges.
async function _releaseHoldRespectsPaidExposure() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id: custId, credit_limit_minor: 100000, currency: "USD",
    payment_terms_days: 30, billing_cycle: "monthly",
  });
  var a = _uuid(), bOrd = _uuid();
  await f.credit.chargeOrder({ customer_id: custId, order_id: a,    amount_minor: 400, occurred_at: 1000 });
  await f.credit.chargeOrder({ customer_id: custId, order_id: bOrd, amount_minor: 400, occurred_at: 2000 });
  check("two-order outstanding is 800", (await f.credit.outstandingBalance(custId)).outstanding_minor === 800);
  await f.credit.recordPayment({ customer_id: custId, amount_minor: 400, payment_ref: "WIRE-1", occurred_at: 3000 });
  check("after payment outstanding is 400", (await f.credit.outstandingBalance(custId)).outstanding_minor === 400);

  // The payment FIFO-covered the OLDER order A, so A's unpaid exposure is 0:
  // releaseHold(A) must REFUSE and leave order B's genuine 400 debt intact.
  // (The bug released 400, driving outstanding to 0 and erasing B's debt.)
  var refused;
  try { await f.credit.releaseHold({ customer_id: custId, order_id: a }); }
  catch (e) { refused = e; }
  check("releaseHold on a FIFO-paid order refuses", refused && refused.code === "CREDIT_RELEASE_NOT_FOUND");
  check("order B's 400 debt is preserved", (await f.credit.outstandingBalance(custId)).outstanding_minor === 400);

  // The genuinely-unpaid order B releases its full 400 exposure.
  var relB = await f.credit.releaseHold({ customer_id: custId, order_id: bOrd });
  check("the unpaid order releases its full exposure", relB.amount_minor === 400 && relB.balance_after_minor === 0);

  // Partial payment: a payment smaller than the older order leaves a
  // remainder; releaseHold releases only the unpaid part.
  var f2 = _factory();
  var c2 = _uuid();
  await f2.credit.defineAccount({ customer_id: c2, credit_limit_minor: 100000, currency: "USD", payment_terms_days: 30, billing_cycle: "monthly" });
  var x = _uuid(), y = _uuid();
  await f2.credit.chargeOrder({ customer_id: c2, order_id: x, amount_minor: 400, occurred_at: 1000 });
  await f2.credit.chargeOrder({ customer_id: c2, order_id: y, amount_minor: 400, occurred_at: 2000 });
  await f2.credit.recordPayment({ customer_id: c2, amount_minor: 100, payment_ref: "WIRE-2", occurred_at: 3000 });
  var relX = await f2.credit.releaseHold({ customer_id: c2, order_id: x });
  check("partial-paid order releases only its unpaid remainder (300)", relX.amount_minor === 300);
  check("after partial release, outstanding equals the still-unpaid order (400)",
        (await f2.credit.outstandingBalance(c2)).outstanding_minor === 400);
}

// BUG-2 (MED): agingReport must net an order-scoped release against THAT
// order's own charges, not pool it with order-agnostic payments into one
// global FIFO drain — pooling let a release of a recent order settle the
// oldest charge and mask a past-due balance as current.
async function _agingReportSeparatesReleaseFromPayment() {
  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({
    customer_id: custId, credit_limit_minor: 100000, currency: "USD",
    payment_terms_days: 30, billing_cycle: "monthly",
  });
  var now = 100 * MS_PER_DAY;
  var oldOrd = _uuid(), recentOrd = _uuid();
  await f.credit.chargeOrder({ customer_id: custId, order_id: oldOrd,    amount_minor: 400, occurred_at: now - 95 * MS_PER_DAY });
  await f.credit.chargeOrder({ customer_id: custId, order_id: recentOrd, amount_minor: 400, occurred_at: now - 5 * MS_PER_DAY });
  // Cancel the RECENT order — its release must net against its OWN charge,
  // leaving the OLD delinquent charge in its past-due bucket.
  await f.credit.releaseHold({ customer_id: custId, order_id: recentOrd });

  var report = await f.credit.agingReport({ customer_id: custId, now: now });
  check("aging: the delinquent old charge stays past-due, not masked as current",
        report.buckets.d90_plus === 400 && report.buckets.current === 0);
  check("aging: total equals the real outstanding balance (money conserved)",
        report.total_outstanding_minor === (await f.credit.outstandingBalance(custId)).outstanding_minor);
}

// releaseHold stays a single atomic statement, so two concurrent releases of
// the same order can't both write: exactly one releases its exposure, the
// other re-evaluates against the committed row and refuses.
async function _concurrentReleaseHoldExactlyOnce() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.defineAccount({ customer_id: custId, credit_limit_minor: 100000, currency: "USD", payment_terms_days: 30, billing_cycle: "monthly" });
  var o = _uuid();
  await f.credit.chargeOrder({ customer_id: custId, order_id: o, amount_minor: 500 });
  var res = await Promise.allSettled([
    f.credit.releaseHold({ customer_id: custId, order_id: o }),
    f.credit.releaseHold({ customer_id: custId, order_id: o }),
  ]);
  var okRes = res.filter(function (x) { return x.status === "fulfilled"; });
  var noRes = res.filter(function (x) { return x.status === "rejected"; });
  check("concurrent releaseHold: exactly one releases", okRes.length === 1 && okRes[0].value.amount_minor === 500);
  check("concurrent releaseHold: the other refuses", noRes.length === 1 && noRes[0].reason.code === "CREDIT_RELEASE_NOT_FOUND");
  check("concurrent releaseHold: balance is 0, not negative", (await f.credit.outstandingBalance(custId)).outstanding_minor === 0);
}

async function run() {
  await _defineAccountBasics();
  await _chargeOrderUpToLimit();
  await _releaseHoldRestoresCredit();
  await _releaseHoldRespectsPaidExposure();
  await _agingReportSeparatesReleaseFromPayment();
  await _concurrentReleaseHoldExactlyOnce();
  await _recordPaymentReducesBalance();
  await _agingReportBucketing();
  await _fsmTransitions();
  await _listAccountsFilter();
  await _customersStubGate();
  await _validation();
  await _exportedConstants();
  await _monotonicOccurredAt();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - credit-limits (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
