"use strict";
/**
 * store-credit — append-only per-customer credit/debit/expire ledger
 * with denormalized balance snapshots per row.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0094
 * (store_credit_ledger).
 *
 * Coverage:
 *   - credit / debit derive balance correctly across many rows
 *   - debit > available throws STORE_CREDIT_INSUFFICIENT_BALANCE
 *     and writes no row
 *   - balance reads the denormalized `balance_after_minor` snapshot
 *   - history paginates newest-first with cursor on occurred_at
 *   - bulkBalance returns one row per requested id (missing
 *     customers surface as balance_minor: 0)
 *   - expiringWithin returns expiring credit rows in the window,
 *     bounded by the wallet's current balance
 *   - expire reduces balance + caps at current balance (no-op when
 *     already drained, structured noop:true return)
 *   - transactionsForOrder returns every row keyed by order_id
 *   - cleanupExpired walks expired credit rows + writes offsetting
 *     expire entries (idempotent on re-run)
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var storeCredit = require("../../lib/store-credit");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG_CREDIT = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0094_store_credit.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_CREDIT, "utf8")).forEach(function (s) {
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
    credit: storeCredit.create({ query: h.query }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

async function _creditDebitBalanceDerivation() {
  var f = _factory();
  var custId = _uuid();

  // Empty wallet.
  var emptyBal = await f.credit.balance(custId);
  check("balance empty is 0",              emptyBal.balance_minor === 0 && emptyBal.customer_id === custId);
  var emptyHist = await f.credit.history({ customer_id: custId });
  check("history empty",                    emptyHist.rows.length === 0 && emptyHist.next_cursor === null);

  // Credit 5000 — refund.
  var c1 = await f.credit.credit({
    customer_id:  custId,
    amount_minor: 5000,
    source:       "refund",
    source_ref:   _uuid(),
  });
  check("credit returns balance_after",     c1.balance_after_minor === 5000 && c1.kind === "credit");
  check("credit returns id",                 typeof c1.id === "string" && c1.id.length === 36);
  check("credit source persisted",           c1.source === "refund");

  // Credit 200 — goodwill.
  var c2 = await f.credit.credit({
    customer_id:  custId,
    amount_minor: 200,
    source:       "goodwill",
    source_ref:   "VIP-WELCOME",
  });
  check("second credit sums to 5200",       c2.balance_after_minor === 5200);

  // Debit 1500 — order.
  var orderId = _uuid();
  var d1 = await f.credit.debit({
    customer_id:  custId,
    amount_minor: 1500,
    order_id:     orderId,
  });
  check("debit returns balance_after",      d1.balance_after_minor === 3700 && d1.kind === "debit");
  check("debit order_id persisted",          d1.order_id === orderId);

  // Balance read sees the snapshot.
  var bal = await f.credit.balance(custId);
  check("balance after credit+debit",       bal.balance_minor === 3700);

  // Replay-derivability: SUM(credit) - SUM(debit) - SUM(expire) ==
  // current balance.
  var sumRows = f.db.prepare(
    "SELECT kind, SUM(amount_minor) AS s FROM store_credit_ledger WHERE customer_id = ? GROUP BY kind"
  ).all(custId);
  var totals = { credit: 0, debit: 0, expire: 0 };
  for (var i = 0; i < sumRows.length; i += 1) totals[sumRows[i].kind] = sumRows[i].s;
  check("replay-derived balance matches",   totals.credit - totals.debit - totals.expire === 3700);
}

async function _debitOverdraftRefused() {
  var f = _factory();
  var custId = _uuid();
  await f.credit.credit({ customer_id: custId, amount_minor: 1000, source: "manual" });

  var orderId = _uuid();
  var eq = await f.credit.debit({ customer_id: custId, amount_minor: 1000, order_id: orderId });
  check("debit == balance allowed",         eq.balance_after_minor === 0);

  await assert.rejects(
    f.credit.debit({ customer_id: custId, amount_minor: 1, order_id: orderId }),
    function (err) {
      return err && err.code === "STORE_CREDIT_INSUFFICIENT_BALANCE"
          && /exceeds available balance/.test(err.message);
    },
  );

  // No row landed for the refused debit.
  var rowCount = f.db.prepare("SELECT COUNT(*) AS c FROM store_credit_ledger WHERE customer_id = ?").all(custId)[0].c;
  check("refused debit wrote no row",       rowCount === 2);

  // Fresh empty wallet — debit refused immediately.
  var fresh = _uuid();
  await assert.rejects(
    f.credit.debit({ customer_id: fresh, amount_minor: 1, order_id: orderId }),
    /exceeds available balance/,
  );
}

async function _historyPagination() {
  var f = _factory();
  var custId = _uuid();

  var base = 1700000000000;
  await f.credit.credit({ customer_id: custId, amount_minor: 100, source: "manual",             occurred_at: base + 1 });
  await f.credit.credit({ customer_id: custId, amount_minor: 200, source: "goodwill",           occurred_at: base + 2 });
  await f.credit.debit ({ customer_id: custId, amount_minor:  50, order_id: _uuid(),            occurred_at: base + 3 });
  await f.credit.credit({ customer_id: custId, amount_minor: 400, source: "promotional",        occurred_at: base + 4 });
  await f.credit.debit ({ customer_id: custId, amount_minor: 100, order_id: _uuid(),            occurred_at: base + 5 });

  var p1 = await f.credit.history({ customer_id: custId, limit: 2 });
  check("page1 has 2 rows",                 p1.rows.length === 2);
  check("page1 newest is base+5",           p1.rows[0].occurred_at === base + 5);
  check("page1 second is base+4",           p1.rows[1].occurred_at === base + 4);
  check("page1 cursor set",                 p1.next_cursor === base + 4);

  var p2 = await f.credit.history({ customer_id: custId, limit: 2, cursor: p1.next_cursor });
  check("page2 has 2 rows",                 p2.rows.length === 2);
  check("page2 first is base+3",            p2.rows[0].occurred_at === base + 3);
  check("page2 second is base+2",           p2.rows[1].occurred_at === base + 2);

  var p3 = await f.credit.history({ customer_id: custId, limit: 2, cursor: p2.next_cursor });
  check("page3 has tail row",               p3.rows.length === 1 && p3.rows[0].occurred_at === base + 1);
  check("page3 cursor null at tail",        p3.next_cursor === null);
}

async function _bulkBalance() {
  var f = _factory();
  var a = _uuid(), b = _uuid(), c = _uuid(), d = _uuid();

  await f.credit.credit({ customer_id: a, amount_minor: 1000, source: "refund" });
  await f.credit.credit({ customer_id: b, amount_minor: 2500, source: "refund" });
  await f.credit.debit ({ customer_id: b, amount_minor:  500, order_id: _uuid() });
  await f.credit.credit({ customer_id: c, amount_minor:  100, source: "promotional" });
  await f.credit.debit ({ customer_id: c, amount_minor:  100, order_id: _uuid() });
  // d has no rows.

  var result = await f.credit.bulkBalance({ customer_ids: [a, b, c, d] });
  check("bulkBalance row per id",           result.length === 4);

  var byId = {};
  for (var i = 0; i < result.length; i += 1) byId[result[i].customer_id] = result[i].balance_minor;
  check("bulk: a balance 1000",             byId[a] === 1000);
  check("bulk: b balance 2000",             byId[b] === 2000);
  check("bulk: c drained to 0",             byId[c] === 0);
  check("bulk: d (no rows) is 0",            byId[d] === 0);

  var empty = await f.credit.bulkBalance({ customer_ids: [] });
  check("bulkBalance empty → empty",        Array.isArray(empty) && empty.length === 0);
}

async function _expiringWithinWindow() {
  var f = _factory();
  var custId = _uuid();

  var now = Date.now();
  var soon  = now + (3 * 86400 * 1000);     // 3 days
  var later = now + (60 * 86400 * 1000);    // 60 days
  var noExp = null;

  await f.credit.credit({ customer_id: custId, amount_minor: 1000, source: "refund",      expires_at: soon });
  await f.credit.credit({ customer_id: custId, amount_minor:  500, source: "promotional", expires_at: later });
  await f.credit.credit({ customer_id: custId, amount_minor:  300, source: "manual",      expires_at: noExp });

  // 7-day horizon: only the `soon` credit lands.
  var hits = await f.credit.expiringWithin({ customer_id: custId, days: 7 });
  check("expiring hits soon credit",        hits.length === 1);
  check("expiring amount matches",          hits[0].amount_minor === 1000);
  check("expiring carries expires_at",      hits[0].expires_at === soon);

  // 90-day horizon: both `soon` + `later`.
  var wide = await f.credit.expiringWithin({ customer_id: custId, days: 90 });
  check("90d horizon hits 2 credits",       wide.length === 2);
  check("90d horizon ordered by expires",   wide[0].expires_at === soon && wide[1].expires_at === later);

  // Zero days: nothing falls inside (strictly > now and <= now).
  var zero = await f.credit.expiringWithin({ customer_id: custId, days: 0 });
  check("0d horizon is empty",              zero.length === 0);

  // Drain the wallet via a debit — expiringWithin should bound by
  // available balance.
  await f.credit.debit({ customer_id: custId, amount_minor: 1700, order_id: _uuid() });
  var afterDrain = await f.credit.expiringWithin({ customer_id: custId, days: 90 });
  check("drained wallet → no expiring",     afterDrain.length === 1 && afterDrain[0].amount_minor === 100);
}

async function _expireReducesBalance() {
  var f = _factory();
  var custId = _uuid();

  await f.credit.credit({ customer_id: custId, amount_minor: 500, source: "manual" });

  var e1 = await f.credit.expire({ customer_id: custId, amount_minor: 200, reason: "annual-sweep-2026" });
  check("expire returns balance_after",     e1.balance_after_minor === 300);
  check("expire returns amount burned",     e1.amount_minor === 200 && e1.noop === false);

  // Capped expire.
  var e2 = await f.credit.expire({ customer_id: custId, amount_minor: 1000, reason: "annual-sweep-2026" });
  check("expire caps at balance",           e2.amount_minor === 300 && e2.balance_after_minor === 0);
  check("expire reports requested",         e2.requested_minor === 1000);
  check("expire not noop when burned > 0",  e2.noop === false);

  // Already drained.
  var e3 = await f.credit.expire({ customer_id: custId, amount_minor: 50, reason: "annual-sweep-2026" });
  check("expire on drained returns noop",   e3.noop === true && e3.amount_minor === 0 && e3.id === null);

  var bal = await f.credit.balance(custId);
  check("balance after expires is 0",       bal.balance_minor === 0);

  await assert.rejects(
    f.credit.debit({ customer_id: custId, amount_minor: 1, order_id: _uuid() }),
    /exceeds available balance/,
  );
}

async function _transactionsForOrder() {
  var f = _factory();
  var orderId  = _uuid();
  var otherOid = _uuid();
  var custA = _uuid(), custB = _uuid();

  await f.credit.credit({ customer_id: custA, amount_minor: 1000, source: "refund",   source_ref: orderId });
  await f.credit.credit({ customer_id: custB, amount_minor: 2000, source: "refund",   source_ref: otherOid });
  await f.credit.debit ({ customer_id: custA, amount_minor:  300, order_id: orderId });
  await f.credit.debit ({ customer_id: custB, amount_minor:  500, order_id: orderId });
  await f.credit.debit ({ customer_id: custB, amount_minor:  100, order_id: otherOid });

  var rows = await f.credit.transactionsForOrder(orderId);
  check("transactionsForOrder returns 2",   rows.length === 2);
  check("transactionsForOrder kind=debit",  rows.every(function (r) { return r.kind === "debit"; }));

  var none = await f.credit.transactionsForOrder(_uuid());
  check("transactionsForOrder unknown []",   Array.isArray(none) && none.length === 0);
}

async function _cleanupExpiredWalksExpiredRows() {
  var f = _factory();
  var custA = _uuid(), custB = _uuid(), custC = _uuid();
  var now = Date.now();
  var past = now - (10 * 86400 * 1000);     // 10 days ago
  var future = now + (10 * 86400 * 1000);   // 10 days hence

  // custA: 1000 credit that expired in the past, no debits.
  await f.credit.credit({ customer_id: custA, amount_minor: 1000, source: "promotional",
                           expires_at: past, occurred_at: past - 1000 });

  // custB: 800 credit that expired in the past + 300 debit before
  // sweep (wallet at 500 when sweep runs).
  await f.credit.credit({ customer_id: custB, amount_minor: 800, source: "promotional",
                           expires_at: past, occurred_at: past - 1000 });
  await f.credit.debit ({ customer_id: custB, amount_minor: 300, order_id: _uuid(),
                           occurred_at: past + 500 });

  // custC: credit with future expiry — should NOT be swept.
  await f.credit.credit({ customer_id: custC, amount_minor: 500, source: "promotional", expires_at: future });

  var swept = await f.credit.cleanupExpired({ now: now });
  check("cleanup processed 2 customers",    swept.processed.length === 2);
  check("cleanup swept_at echoed",           swept.swept_at === now);

  var byCust = {};
  for (var i = 0; i < swept.processed.length; i += 1) byCust[swept.processed[i].customer_id] = swept.processed[i];

  check("custA fully burned",                byCust[custA].amount_minor === 1000 && byCust[custA].balance_after_minor === 0);
  check("custB burn capped at wallet",       byCust[custB].amount_minor === 500  && byCust[custB].balance_after_minor === 0);

  // custC untouched.
  var custCBal = await f.credit.balance(custC);
  check("custC future-expiry untouched",     custCBal.balance_minor === 500);

  // Idempotent re-run: no new rows.
  var sweep2 = await f.credit.cleanupExpired({ now: now });
  check("cleanup re-run is no-op",           sweep2.processed.length === 0);

  // Underlying wallets still at 0.
  check("custA still drained",               (await f.credit.balance(custA)).balance_minor === 0);
  check("custB still drained",               (await f.credit.balance(custB)).balance_minor === 0);

  // History shows the offsetting expire entries with the
  // scheduler reason.
  var aHist = await f.credit.history({ customer_id: custA });
  var aExpire = aHist.rows.filter(function (r) { return r.kind === "expire"; });
  check("custA expire row recorded",         aExpire.length === 1 && aExpire[0].source_ref === "scheduled-expiry-sweep");
}

// The sweep keys its idempotency on its OWN prior output (expire rows
// stamped 'scheduled-expiry-sweep'), NOT on every expire row. A prior
// operator-initiated `expire()` (or any non-sweep expire) must NOT be
// netted out of the expired-credit pool — doing so suppressed a
// legitimate expiry, leaving genuinely-expired credit spendable.
async function _cleanupExpiredIgnoresOperatorExpires() {
  var f = _factory();
  var now = Date.now();
  var past = now - (10 * 86400 * 1000);

  // 1000 of expired credit + 500 of non-expiring credit + a 300
  // operator-initiated expire (a clawback). Wallet sits at 1200 when the
  // sweep runs; the genuinely-expired 1000 must come out, leaving 200.
  var cust = _uuid();
  await f.credit.credit({ customer_id: cust, amount_minor: 1000, source: "promotional",
                           expires_at: past, occurred_at: past - 2000 });
  await f.credit.credit({ customer_id: cust, amount_minor: 500, source: "goodwill",
                           occurred_at: past - 1000 });
  await f.credit.expire({ customer_id: cust, amount_minor: 300, reason: "operator-clawback",
                           occurred_at: past + 500 });

  check("pre-sweep balance is 1200", (await f.credit.balance(cust)).balance_minor === 1200);

  var swept = await f.credit.cleanupExpired({ now: now });
  var mine = swept.processed.filter(function (p) { return p.customer_id === cust; });
  check("operator-expire does not suppress sweep", mine.length === 1 && mine[0].amount_minor === 1000);
  check("genuine expiry leaves the non-expiring remainder",
    (await f.credit.balance(cust)).balance_minor === 200);

  // Idempotent: a second sweep finds nothing more to burn even though
  // operator-expire rows still exist on the ledger.
  var swept2 = await f.credit.cleanupExpired({ now: now });
  check("re-run after operator-expire is a no-op",
    swept2.processed.filter(function (p) { return p.customer_id === cust; }).length === 0);
  check("balance stable after re-run", (await f.credit.balance(cust)).balance_minor === 200);

  // A non-expiring credit ADDED AFTER a sweep is never burned by a
  // later sweep — the sweep only ever expires the expired-credit pool.
  var cust2 = _uuid();
  await f.credit.credit({ customer_id: cust2, amount_minor: 1000, source: "promotional",
                           expires_at: past, occurred_at: past - 1000 });
  await f.credit.cleanupExpired({ now: now });
  check("post-sweep wallet drained", (await f.credit.balance(cust2)).balance_minor === 0);
  await f.credit.credit({ customer_id: cust2, amount_minor: 400, source: "goodwill" });
  await f.credit.cleanupExpired({ now: now });
  check("non-expiring credit after sweep stays safe",
    (await f.credit.balance(cust2)).balance_minor === 400);
}

// Two sweeps racing over one customer must burn the expired pool
// exactly once. The pending-burn remainder (expired total minus the
// sweep's own prior output) and the balance cap are recomputed INSIDE
// the guarded insert, so the second sweep serializes behind the
// first's committed row, sees zero pending, and matches no rows —
// never burning the still-valid (non-expired) credit the first sweep
// left in the wallet. A JS-side read-then-write here let both sweeps
// read a zero prior-burn before either wrote, then the second's capped
// write drained the valid balance.
async function _cleanupExpiredConcurrentSweepNeverOverBurns() {
  var f = _factory();
  var now = Date.now();
  var past = now - (10 * 86400 * 1000);

  // 1000 expired credit + 500 still-valid credit. Wallet = 1500. Only
  // the expired 1000 may be burned; the 500 must survive.
  var cust = _uuid();
  await f.credit.credit({ customer_id: cust, amount_minor: 1000, source: "promotional",
                           expires_at: past, occurred_at: past - 2000 });
  await f.credit.credit({ customer_id: cust, amount_minor: 500, source: "goodwill",
                           occurred_at: past - 1000 });
  check("pre-sweep balance is 1500",        (await f.credit.balance(cust)).balance_minor === 1500);

  var res = await Promise.all([
    f.credit.cleanupExpired({ now: now }),
    f.credit.cleanupExpired({ now: now }),
  ]);
  var totalBurned = 0;
  res.forEach(function (r) {
    r.processed.forEach(function (p) { if (p.customer_id === cust) totalBurned += p.amount_minor; });
  });
  check("concurrent sweeps burn the expired pool exactly once", totalBurned === 1000);
  check("concurrent sweeps leave the still-valid credit intact",
        (await f.credit.balance(cust)).balance_minor === 500);

  // The ledger carries exactly one sweep-stamped expire row for 1000 —
  // the loser of the race wrote nothing.
  var sweepRows = f.db.prepare(
    "SELECT amount_minor FROM store_credit_ledger " +
    "WHERE customer_id = ? AND kind = 'expire' AND source_ref = 'scheduled-expiry-sweep'"
  ).all(cust);
  check("exactly one sweep expire row landed", sweepRows.length === 1 && sweepRows[0].amount_minor === 1000);

  // A third sweep is still a no-op.
  var third = await f.credit.cleanupExpired({ now: now });
  check("post-race sweep is a no-op",
        third.processed.filter(function (p) { return p.customer_id === cust; }).length === 0);
  check("balance stable after third sweep", (await f.credit.balance(cust)).balance_minor === 500);

  // Partly-drained wallet: a debit between credit and sweep already
  // spent part of the balance. The sweep caps the burn at the live
  // balance (the schema tracks no row-level FIFO, so a debit draws
  // generically against the wallet). The concurrency property under
  // test is that two racing sweeps burn EXACTLY what a single sweep
  // burns — never more. Single-sweep baseline for this fixture: the
  // 1000 expired pool capped at the 800 live balance burns 800.
  var cust2 = _uuid();
  await f.credit.credit({ customer_id: cust2, amount_minor: 1000, source: "promotional",
                           expires_at: past, occurred_at: past - 3000 });
  await f.credit.credit({ customer_id: cust2, amount_minor: 400, source: "goodwill",
                           occurred_at: past - 2000 });
  await f.credit.debit ({ customer_id: cust2, amount_minor: 600, order_id: _uuid(),
                           occurred_at: past - 1000 });   // wallet now 800
  check("cust2 pre-sweep balance is 800",   (await f.credit.balance(cust2)).balance_minor === 800);
  var res2 = await Promise.all([
    f.credit.cleanupExpired({ now: now }),
    f.credit.cleanupExpired({ now: now }),
  ]);
  var burned2 = 0;
  res2.forEach(function (r) {
    r.processed.forEach(function (p) { if (p.customer_id === cust2) burned2 += p.amount_minor; });
  });
  check("partly-drained: concurrent sweeps burn exactly the single-sweep amount", burned2 === 800);
  check("partly-drained: balance lands where a single sweep would (0)",
        (await f.credit.balance(cust2)).balance_minor === 0);
}

async function _validation() {
  var f = _factory();
  var ok = _uuid();
  await f.credit.credit({ customer_id: ok, amount_minor: 100, source: "manual" });

  // credit
  await assert.rejects(f.credit.credit(),                                                                       /input object required/);
  await assert.rejects(f.credit.credit({}),                                                                     /customer_id/);
  await assert.rejects(f.credit.credit({ customer_id: "not-a-uuid", amount_minor: 1, source: "manual" }),       /customer_id/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 0,    source: "manual" }),   /amount_minor/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: -1,   source: "manual" }),   /amount_minor/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 1.5,  source: "manual" }),   /amount_minor/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 100,  source: "bogus" }),    /source/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 100 }),                      /source/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 100,  source: "manual",
                                          source_ref: "" }),                                                     /source_ref/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 100,  source: "manual",
                                          source_ref: "bad\nref" }),                                             /source_ref/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 100,  source: "manual",
                                          expires_at: -1 }),                                                     /expires_at/);
  await assert.rejects(f.credit.credit({ customer_id: _uuid(),       amount_minor: 100,  source: "manual",
                                          occurred_at: -1 }),                                                    /occurred_at/);

  // debit
  await assert.rejects(f.credit.debit(),                                                                        /input object required/);
  await assert.rejects(f.credit.debit({ customer_id: ok, amount_minor: 50 }),                                    /order_id/);
  await assert.rejects(f.credit.debit({ customer_id: ok, amount_minor: 50, order_id: "not-a-uuid" }),            /order_id/);
  await assert.rejects(f.credit.debit({ customer_id: "x", amount_minor: 50, order_id: _uuid() }),                /customer_id/);
  await assert.rejects(f.credit.debit({ customer_id: ok, amount_minor: 0,  order_id: _uuid() }),                 /amount_minor/);

  // expire
  await assert.rejects(f.credit.expire(),                                                                       /input object required/);
  await assert.rejects(f.credit.expire({ customer_id: ok, amount_minor: 50 }),                                   /reason/);
  await assert.rejects(f.credit.expire({ customer_id: ok, amount_minor: 50, reason: "" }),                       /reason/);

  // balance
  await assert.rejects(f.credit.balance("not-a-uuid"),                                                           /customer_id/);

  // history
  await assert.rejects(f.credit.history(),                                                                      /input object required/);
  await assert.rejects(f.credit.history({ customer_id: "not-a-uuid" }),                                          /customer_id/);
  await assert.rejects(f.credit.history({ customer_id: ok, limit: 0 }),                                          /limit/);
  await assert.rejects(f.credit.history({ customer_id: ok, limit: 1000 }),                                       /limit/);
  await assert.rejects(f.credit.history({ customer_id: ok, cursor: -1 }),                                        /cursor/);
  await assert.rejects(f.credit.history({ customer_id: ok, cursor: "yesterday" }),                               /cursor/);

  // transactionsForOrder
  await assert.rejects(f.credit.transactionsForOrder("not-a-uuid"),                                              /order_id/);

  // expiringWithin
  await assert.rejects(f.credit.expiringWithin(),                                                               /input object required/);
  await assert.rejects(f.credit.expiringWithin({ customer_id: "not-a-uuid", days: 30 }),                         /customer_id/);
  await assert.rejects(f.credit.expiringWithin({ customer_id: ok, days: -1 }),                                   /days/);
  await assert.rejects(f.credit.expiringWithin({ customer_id: ok, days: 1.5 }),                                  /days/);
  await assert.rejects(f.credit.expiringWithin({ customer_id: ok }),                                             /days/);

  // bulkBalance
  await assert.rejects(f.credit.bulkBalance(),                                                                  /input object required/);
  await assert.rejects(f.credit.bulkBalance({ customer_ids: "all" }),                                            /customer_ids/);
  await assert.rejects(f.credit.bulkBalance({ customer_ids: [ok, "not-a-uuid"] }),                               /customer_ids\[1\]/);

  var huge = [];
  for (var i = 0; i < 600; i += 1) huge.push(_uuid());
  await assert.rejects(f.credit.bulkBalance({ customer_ids: huge }),                                             /<= 500/);

  // cleanupExpired
  await assert.rejects(f.credit.cleanupExpired({ now: -1 }),                                                     /now/);
}

async function _exportedConstants() {
  check("KINDS exported",                  Array.isArray(storeCredit.KINDS)
                                            && storeCredit.KINDS.indexOf("credit") !== -1
                                            && storeCredit.KINDS.indexOf("debit")  !== -1
                                            && storeCredit.KINDS.indexOf("expire") !== -1);
  check("SOURCES exported",                Array.isArray(storeCredit.SOURCES)
                                            && storeCredit.SOURCES.indexOf("refund")              !== -1
                                            && storeCredit.SOURCES.indexOf("goodwill")            !== -1
                                            && storeCredit.SOURCES.indexOf("promotional")         !== -1
                                            && storeCredit.SOURCES.indexOf("manual")              !== -1
                                            && storeCredit.SOURCES.indexOf("loyalty_redemption") !== -1);
  var inst = storeCredit.create({ query: _makeQuery().query });
  check("instance exposes KINDS",          inst.KINDS.length === 3);
  check("instance exposes SOURCES",        inst.SOURCES.length === 5);
}

// Concurrency: every wallet write computes the live balance and a
// strictly-monotonic occurred_at INSIDE the guarded insert, so concurrent
// writes can never base off the same stale snapshot — two racing debits
// can't co-fulfill against one balance, and two same-millisecond credits
// both land instead of one silently vanishing under a timestamp tie.
async function _concurrentWritesNeverDrift() {
  var f = _factory();

  // Two concurrent 800 debits against a 1000 wallet — exactly one wins.
  var cust1 = _uuid();
  await f.credit.credit({ customer_id: cust1, amount_minor: 1000, source: "manual" });
  var res = await Promise.allSettled([
    f.credit.debit({ customer_id: cust1, amount_minor: 800, order_id: _uuid() }),
    f.credit.debit({ customer_id: cust1, amount_minor: 800, order_id: _uuid() }),
  ]);
  var fulfilled = res.filter(function (x) { return x.status === "fulfilled"; });
  var rejected  = res.filter(function (x) { return x.status === "rejected"; });
  check("concurrent debit: exactly one fulfilled", fulfilled.length === 1);
  check("concurrent debit: loser refused with the insufficient code",
        rejected.length === 1 && rejected[0].reason.code === "STORE_CREDIT_INSUFFICIENT_BALANCE");
  check("concurrent debit: balance is 200, not negative",
        (await f.credit.balance(cust1)).balance_minor === 200);

  // Two concurrent same-timestamp credits — both land, balance sums.
  var cust2 = _uuid();
  var ts = Date.now();
  await Promise.all([
    f.credit.credit({ customer_id: cust2, amount_minor: 1000, source: "goodwill", occurred_at: ts }),
    f.credit.credit({ customer_id: cust2, amount_minor: 1000, source: "goodwill", occurred_at: ts }),
  ]);
  check("concurrent credit: balance sums both grants",
        (await f.credit.balance(cust2)).balance_minor === 2000);
  var rows = f.db.prepare(
    "SELECT occurred_at, balance_after_minor FROM store_credit_ledger WHERE customer_id = ? ORDER BY occurred_at"
  ).all(cust2);
  check("concurrent credit: two rows with distinct occurred_at",
        rows.length === 2 && rows[0].occurred_at !== rows[1].occurred_at);
  check("concurrent credit: snapshots chain (1000 then 2000)",
        rows[0].balance_after_minor === 1000 && rows[1].balance_after_minor === 2000);
}

async function run() {
  await _creditDebitBalanceDerivation();
  await _debitOverdraftRefused();
  await _concurrentWritesNeverDrift();
  await _historyPagination();
  await _bulkBalance();
  await _expiringWithinWindow();
  await _expireReducesBalance();
  await _transactionsForOrder();
  await _cleanupExpiredWalksExpiredRows();
  await _cleanupExpiredIgnoresOperatorExpires();
  await _cleanupExpiredConcurrentSweepNeverOverBurns();
  await _validation();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - store-credit (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
