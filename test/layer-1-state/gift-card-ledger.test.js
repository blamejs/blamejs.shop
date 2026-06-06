"use strict";
/**
 * gift-card-ledger — append-only credit/debit/expire ledger keyed by
 * gift_card_id with denormalized balance snapshots per row.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0081
 * (gift_card_ledger) and 0013 (giftcards — required for the
 * expiringBalance JOIN against gc.expires_at).
 *
 * Coverage:
 *   - credit / debit derive balance correctly across many rows
 *   - debit > available throws GIFT_CARD_LEDGER_INSUFFICIENT_BALANCE
 *     and writes no row
 *   - balance reads the denormalized `balance_after_minor` snapshot
 *   - history paginates newest-first with cursor on occurred_at
 *   - bulkBalance returns one row per requested id (missing cards
 *     surface as balance_minor: 0)
 *   - expiringBalance filters by expires_at and min_amount_minor
 *   - expire reduces balance + caps at current balance (no-op when
 *     already drained, structured noop:true return)
 *   - transactionsForOrder returns every row keyed by order_id
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var giftCardLedger = require("../../lib/gift-card-ledger");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_GIFTCARDS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0013_giftcards.sql");
var MIG_LEDGER    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0081_gift_card_ledger.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  // Load giftcards first (the ledger's expiringBalance JOINs against
  // it). Both migrations are idempotent (CREATE TABLE IF NOT EXISTS).
  _splitSchema(nodeFs.readFileSync(MIG_GIFTCARDS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  _splitSchema(nodeFs.readFileSync(MIG_LEDGER, "utf8")).forEach(function (s) {
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
    ledger: giftCardLedger.create({ query: h.query }),
    gc:     bShop.giftcards.create({ query: h.query }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

async function _creditDebitBalanceDerivation() {
  var f = _factory();
  var cardId = _uuid();

  // Empty card: zero balance, zero history.
  var emptyBal = await f.ledger.balance(cardId);
  check("balance for empty card is 0",     emptyBal.balance_minor === 0 && emptyBal.gift_card_id === cardId);
  var emptyHist = await f.ledger.history(cardId);
  check("history for empty card empty",    emptyHist.rows.length === 0 && emptyHist.next_cursor === null);

  // Credit 5000 — purchase.
  var c1 = await f.ledger.credit({
    gift_card_id: cardId,
    amount_minor: 5000,
    source:       "purchase",
    source_ref:   _uuid(),
  });
  check("credit returns balance_after",    c1.balance_after_minor === 5000 && c1.kind === "credit");
  check("credit returns id",                typeof c1.id === "string" && c1.id.length === 36);
  check("credit source persisted",          c1.source === "purchase");

  // Credit 200 — promotional.
  var c2 = await f.ledger.credit({
    gift_card_id: cardId,
    amount_minor: 200,
    source:       "promotional",
    source_ref:   "BLACK-FRIDAY-2026",
  });
  check("second credit sums to 5200",      c2.balance_after_minor === 5200);

  // Debit 1500 — order.
  var orderId = _uuid();
  var d1 = await f.ledger.debit({
    gift_card_id: cardId,
    amount_minor: 1500,
    order_id:     orderId,
  });
  check("debit returns balance_after",     d1.balance_after_minor === 3700 && d1.kind === "debit");
  check("debit order_id persisted",         d1.order_id === orderId);

  // Balance read sees the snapshot.
  var bal = await f.ledger.balance(cardId);
  check("balance after credit+debit",      bal.balance_minor === 3700);

  // Replay-derivability: SUM(credit) - SUM(debit) - SUM(expire) ==
  // current balance. The denormalization column is consistent.
  var sumRows = f.db.prepare(
    "SELECT kind, SUM(amount_minor) AS s FROM gift_card_ledger WHERE gift_card_id = ? GROUP BY kind"
  ).all(cardId);
  var totals = { credit: 0, debit: 0, expire: 0 };
  for (var i = 0; i < sumRows.length; i += 1) totals[sumRows[i].kind] = sumRows[i].s;
  check("replay-derived balance matches",  totals.credit - totals.debit - totals.expire === 3700);
}

async function _debitOverdraftRefused() {
  var f = _factory();
  var cardId = _uuid();
  await f.ledger.credit({ gift_card_id: cardId, amount_minor: 1000, source: "manual" });

  var orderId = _uuid();
  // Exactly equal: allowed.
  var eq = await f.ledger.debit({ gift_card_id: cardId, amount_minor: 1000, order_id: orderId });
  check("debit == balance allowed",         eq.balance_after_minor === 0);

  // Over: refused, with a structured error code.
  await assert.rejects(
    f.ledger.debit({ gift_card_id: cardId, amount_minor: 1, order_id: orderId }),
    function (err) {
      return err && err.code === "GIFT_CARD_LEDGER_INSUFFICIENT_BALANCE"
          && /exceeds available balance/.test(err.message);
    },
  );

  // No row landed for the refused debit — count rows.
  var rowCount = f.db.prepare("SELECT COUNT(*) AS c FROM gift_card_ledger WHERE gift_card_id = ?").all(cardId)[0].c;
  check("refused debit wrote no row",       rowCount === 2);  // 1 credit + 1 debit, no third row

  // Fresh empty card — debit refused immediately.
  var fresh = _uuid();
  await assert.rejects(
    f.ledger.debit({ gift_card_id: fresh, amount_minor: 1, order_id: orderId }),
    /exceeds available balance/,
  );
}

// The overdraft check and the row write are ONE atomic guarded INSERT,
// so two concurrent debits that would together overdraw can't both pass
// the check and both write (the read-then-write race that corrupted
// balance_after_minor). Exactly one of two racing debits for more than
// half the balance lands.
async function _concurrentDebitAtomic() {
  var f = _factory();
  var cardId = _uuid();
  await f.ledger.credit({ gift_card_id: cardId, amount_minor: 1000, source: "manual" });

  // Two concurrent debits of 600 against a 1000 balance: only ONE can
  // succeed (1200 > 1000).
  var settled = await Promise.allSettled([
    f.ledger.debit({ gift_card_id: cardId, amount_minor: 600, order_id: _uuid() }),
    f.ledger.debit({ gift_card_id: cardId, amount_minor: 600, order_id: _uuid() }),
  ]);
  var fulfilled = settled.filter(function (s) { return s.status === "fulfilled"; });
  var rejected  = settled.filter(function (s) { return s.status === "rejected"; });
  check("concurrent debit: exactly one succeeds", fulfilled.length === 1);
  check("concurrent debit: one refused",          rejected.length === 1);
  check("concurrent debit: refusal coded",
    rejected[0] && rejected[0].reason && rejected[0].reason.code === "GIFT_CARD_LEDGER_INSUFFICIENT_BALANCE");

  // Balance is the single successful debit's result — never an
  // overdrawn / double-applied figure.
  var bal = await f.ledger.balance(cardId);
  check("concurrent debit: balance reflects one debit", bal.balance_minor === 400);

  // Exactly two ledger rows: the credit + the one winning debit.
  var rowCount = f.db.prepare("SELECT COUNT(*) AS c FROM gift_card_ledger WHERE gift_card_id = ?").all(cardId)[0].c;
  check("concurrent debit: only the winning row landed", rowCount === 2);

  // The winning debit's balance_after_minor is correct (1000 - 600).
  var debitRow = f.db.prepare(
    "SELECT balance_after_minor FROM gift_card_ledger WHERE gift_card_id = ? AND kind = 'debit'"
  ).all(cardId);
  check("concurrent debit: balance_after_minor not corrupted",
    debitRow.length === 1 && debitRow[0].balance_after_minor === 400);
}

async function _historyPagination() {
  var f = _factory();
  var cardId = _uuid();

  // Land 5 rows with strictly increasing occurred_at so cursor
  // pagination has a deterministic order.
  var base = 1700000000000;
  await f.ledger.credit({ gift_card_id: cardId, amount_minor: 100, source: "manual",      occurred_at: base + 1 });
  await f.ledger.credit({ gift_card_id: cardId, amount_minor: 200, source: "promotional", occurred_at: base + 2 });
  await f.ledger.debit ({ gift_card_id: cardId, amount_minor:  50, order_id: _uuid(),     occurred_at: base + 3 });
  await f.ledger.credit({ gift_card_id: cardId, amount_minor: 400, source: "refund_to_giftcard", occurred_at: base + 4 });
  await f.ledger.debit ({ gift_card_id: cardId, amount_minor: 100, order_id: _uuid(),     occurred_at: base + 5 });

  // First page: newest first (occurred_at desc).
  var p1 = await f.ledger.history(cardId, { limit: 2 });
  check("page1 has 2 rows",                 p1.rows.length === 2);
  check("page1 newest is base+5",           p1.rows[0].occurred_at === base + 5);
  check("page1 second is base+4",           p1.rows[1].occurred_at === base + 4);
  check("page1 cursor set",                 p1.next_cursor === base + 4);

  // Page 2: rows STRICTLY OLDER than cursor.
  var p2 = await f.ledger.history(cardId, { limit: 2, cursor: p1.next_cursor });
  check("page2 has 2 rows",                 p2.rows.length === 2);
  check("page2 first is base+3",            p2.rows[0].occurred_at === base + 3);
  check("page2 second is base+2",           p2.rows[1].occurred_at === base + 2);

  // Page 3: tail, cursor exhausts.
  var p3 = await f.ledger.history(cardId, { limit: 2, cursor: p2.next_cursor });
  check("page3 has final 1 row",            p3.rows.length === 1 && p3.rows[0].occurred_at === base + 1);
  check("page3 cursor null at tail",        p3.next_cursor === null);
}

async function _bulkBalance() {
  var f = _factory();
  var a = _uuid(), b = _uuid(), c = _uuid(), d = _uuid();

  await f.ledger.credit({ gift_card_id: a, amount_minor: 1000, source: "purchase" });
  await f.ledger.credit({ gift_card_id: b, amount_minor: 2500, source: "purchase" });
  await f.ledger.debit ({ gift_card_id: b, amount_minor:  500, order_id: _uuid() });
  await f.ledger.credit({ gift_card_id: c, amount_minor:  100, source: "promotional" });
  await f.ledger.debit ({ gift_card_id: c, amount_minor:  100, order_id: _uuid() });
  // `d` has no ledger rows at all — must come back as zero.

  var result = await f.ledger.bulkBalance({ gift_card_ids: [a, b, c, d] });
  check("bulkBalance returns row per id",   result.length === 4);

  var byId = {};
  for (var i = 0; i < result.length; i += 1) byId[result[i].gift_card_id] = result[i].balance_minor;

  check("bulk: a balance 1000",             byId[a] === 1000);
  check("bulk: b balance 2000",             byId[b] === 2000);
  check("bulk: c drained to 0",             byId[c] === 0);
  check("bulk: d (no rows) is 0",            byId[d] === 0);

  // Empty input list returns empty array (not an error).
  var empty = await f.ledger.bulkBalance({ gift_card_ids: [] });
  check("bulkBalance empty input → empty",  Array.isArray(empty) && empty.length === 0);
}

async function _expiringBalanceWindow() {
  var f = _factory();

  // Issue three real cards via the giftcards primitive so the JOIN
  // against giftcards.expires_at finds rows. expires_at is epoch-ms.
  var now = Date.now();
  var soon   = await f.gc.issue({ amount_minor: 1000, currency: "USD", expires_at: now + 1000 });        // expires in 1s
  var later  = await f.gc.issue({ amount_minor: 1000, currency: "USD", expires_at: now + 1000000 });     // far future
  var noExp  = await f.gc.issue({ amount_minor: 1000, currency: "USD" });                                // null expires_at

  // Land ledger rows reflecting current balances.
  await f.ledger.credit({ gift_card_id: soon.id,  amount_minor: 1000, source: "purchase" });
  await f.ledger.credit({ gift_card_id: later.id, amount_minor: 1000, source: "purchase" });
  await f.ledger.credit({ gift_card_id: noExp.id, amount_minor: 1000, source: "purchase" });

  // Sweep horizon at now+2000 — `soon` should appear; `later` +
  // `noExp` should NOT.
  var hits = await f.ledger.expiringBalance({ before: now + 2000, min_amount_minor: 1 });
  check("expiring hits exactly soon card",  hits.length === 1 && hits[0].gift_card_id === soon.id);
  check("expiring carries balance",         hits[0].balance_minor === 1000);
  check("expiring carries expires_at",      hits[0].expires_at === now + 1000);

  // min_amount_minor filters small balances out.
  var bigger = await f.ledger.expiringBalance({ before: now + 2000, min_amount_minor: 5000 });
  check("expiring filters under min",       bigger.length === 0);

  // Drain `soon` via a debit — should drop out of the next sweep.
  await f.ledger.debit({ gift_card_id: soon.id, amount_minor: 1000, order_id: _uuid() });
  var afterDrain = await f.ledger.expiringBalance({ before: now + 2000, min_amount_minor: 1 });
  check("drained card excluded from sweep", afterDrain.length === 0);
}

async function _expireReducesBalance() {
  var f = _factory();
  var cardId = _uuid();

  await f.ledger.credit({ gift_card_id: cardId, amount_minor: 500, source: "manual" });

  var e1 = await f.ledger.expire({ gift_card_id: cardId, amount_minor: 200, reason: "annual-sweep-2026" });
  check("expire returns balance_after",     e1.balance_after_minor === 300);
  check("expire returns amount burned",     e1.amount_minor === 200 && e1.noop === false);

  // Capped expire: try to burn 1000 when only 300 left.
  var e2 = await f.ledger.expire({ gift_card_id: cardId, amount_minor: 1000, reason: "annual-sweep-2026" });
  check("expire caps at balance",           e2.amount_minor === 300 && e2.balance_after_minor === 0);
  check("expire reports requested",         e2.requested_minor === 1000);
  check("expire not noop when burned > 0",  e2.noop === false);

  // Already drained: structured noop.
  var e3 = await f.ledger.expire({ gift_card_id: cardId, amount_minor: 50, reason: "annual-sweep-2026" });
  check("expire on drained returns noop",   e3.noop === true && e3.amount_minor === 0 && e3.id === null);

  // Confirm the underlying balance.
  var bal = await f.ledger.balance(cardId);
  check("balance after expires is 0",       bal.balance_minor === 0);

  // Debit after expire: refused.
  await assert.rejects(
    f.ledger.debit({ gift_card_id: cardId, amount_minor: 1, order_id: _uuid() }),
    /exceeds available balance/,
  );
}

async function _transactionsForOrder() {
  var f = _factory();
  var orderId  = _uuid();
  var otherOid = _uuid();
  var cardA = _uuid(), cardB = _uuid();

  // Two cards, both seeing debit activity for the same order +
  // ambient activity that should NOT come back.
  await f.ledger.credit({ gift_card_id: cardA, amount_minor: 1000, source: "purchase",  source_ref: orderId });
  await f.ledger.credit({ gift_card_id: cardB, amount_minor: 2000, source: "purchase",  source_ref: otherOid });
  await f.ledger.debit ({ gift_card_id: cardA, amount_minor:  300, order_id: orderId });
  await f.ledger.debit ({ gift_card_id: cardB, amount_minor:  500, order_id: orderId });
  await f.ledger.debit ({ gift_card_id: cardB, amount_minor:  100, order_id: otherOid });

  var rows = await f.ledger.transactionsForOrder(orderId);
  check("transactionsForOrder returns 2",   rows.length === 2);
  // Credit rows have source_ref set to the order id but order_id
  // column is NULL — only debits land in this lookup.
  check("transactionsForOrder kind=debit",  rows.every(function (r) { return r.kind === "debit"; }));
  check("transactionsForOrder ids correct", (rows[0].gift_card_id === cardA && rows[1].gift_card_id === cardB)
                                             || (rows[0].gift_card_id === cardB && rows[1].gift_card_id === cardA));

  // Unknown order id returns empty (not null).
  var none = await f.ledger.transactionsForOrder(_uuid());
  check("transactionsForOrder unknown []",   Array.isArray(none) && none.length === 0);
}

async function _validation() {
  var f = _factory();
  var ok = _uuid();
  await f.ledger.credit({ gift_card_id: ok, amount_minor: 100, source: "manual" });

  // credit
  await assert.rejects(f.ledger.credit(),                                                                  /input object required/);
  await assert.rejects(f.ledger.credit({}),                                                                /gift_card_id/);
  await assert.rejects(f.ledger.credit({ gift_card_id: "not-a-uuid", amount_minor: 1, source: "manual" }), /gift_card_id/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: 0, source: "manual" }), /amount_minor/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: -1, source: "manual" }), /amount_minor/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: 1.5, source: "manual" }), /amount_minor/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: 100, source: "bogus" }),  /source/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: 100 }),                  /source/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: 100, source: "manual",
                                          source_ref: "" }),                                                  /source_ref/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: 100, source: "manual",
                                          source_ref: "bad\nref" }),                                          /source_ref/);
  await assert.rejects(f.ledger.credit({ gift_card_id: _uuid(),       amount_minor: 100, source: "manual",
                                          occurred_at: -1 }),                                                 /occurred_at/);

  // debit
  await assert.rejects(f.ledger.debit(),                                                                   /input object required/);
  await assert.rejects(f.ledger.debit({ gift_card_id: ok, amount_minor: 50 }),                              /order_id/);
  await assert.rejects(f.ledger.debit({ gift_card_id: ok, amount_minor: 50, order_id: "not-a-uuid" }),       /order_id/);
  await assert.rejects(f.ledger.debit({ gift_card_id: "x", amount_minor: 50, order_id: _uuid() }),           /gift_card_id/);
  await assert.rejects(f.ledger.debit({ gift_card_id: ok, amount_minor: 0,  order_id: _uuid() }),            /amount_minor/);

  // expire
  await assert.rejects(f.ledger.expire(),                                                                  /input object required/);
  await assert.rejects(f.ledger.expire({ gift_card_id: ok, amount_minor: 50 }),                             /reason/);
  await assert.rejects(f.ledger.expire({ gift_card_id: ok, amount_minor: 50, reason: "" }),                 /reason/);

  // balance
  await assert.rejects(f.ledger.balance("not-a-uuid"),                                                      /gift_card_id/);

  // history
  await assert.rejects(f.ledger.history("not-a-uuid"),                                                      /gift_card_id/);
  await assert.rejects(f.ledger.history(ok, { limit: 0 }),                                                  /limit/);
  await assert.rejects(f.ledger.history(ok, { limit: 1000 }),                                               /limit/);
  await assert.rejects(f.ledger.history(ok, { cursor: -1 }),                                                /cursor/);
  await assert.rejects(f.ledger.history(ok, { cursor: "yesterday" }),                                       /cursor/);

  // transactionsForOrder
  await assert.rejects(f.ledger.transactionsForOrder("not-a-uuid"),                                          /order_id/);

  // bulkBalance
  await assert.rejects(f.ledger.bulkBalance(),                                                              /input object required/);
  await assert.rejects(f.ledger.bulkBalance({ gift_card_ids: "all" }),                                       /gift_card_ids/);
  await assert.rejects(f.ledger.bulkBalance({ gift_card_ids: [ok, "not-a-uuid"] }),                          /gift_card_ids\[1\]/);

  // expiringBalance
  await assert.rejects(f.ledger.expiringBalance(),                                                          /input object required/);
  await assert.rejects(f.ledger.expiringBalance({}),                                                        /before/);
  await assert.rejects(f.ledger.expiringBalance({ before: -1 }),                                            /before/);
  await assert.rejects(f.ledger.expiringBalance({ before: Date.now(), min_amount_minor: -5 }),              /min_amount_minor/);
  await assert.rejects(f.ledger.expiringBalance({ before: Date.now(), min_amount_minor: 1.5 }),             /min_amount_minor/);

  // Bulk size cap.
  var huge = [];
  for (var i = 0; i < 600; i += 1) huge.push(_uuid());
  await assert.rejects(f.ledger.bulkBalance({ gift_card_ids: huge }),                                       /<= 500/);
}

async function _exportedConstants() {
  check("KINDS exported",                  Array.isArray(giftCardLedger.KINDS)
                                            && giftCardLedger.KINDS.indexOf("credit") !== -1
                                            && giftCardLedger.KINDS.indexOf("debit")  !== -1
                                            && giftCardLedger.KINDS.indexOf("expire") !== -1);
  check("SOURCES exported",                Array.isArray(giftCardLedger.SOURCES)
                                            && giftCardLedger.SOURCES.indexOf("purchase") !== -1
                                            && giftCardLedger.SOURCES.indexOf("refund_to_giftcard") !== -1
                                            && giftCardLedger.SOURCES.indexOf("promotional") !== -1
                                            && giftCardLedger.SOURCES.indexOf("manual") !== -1);
  // Factory also exposes them on the instance.
  var inst = giftCardLedger.create({ query: _makeQuery().query });
  check("instance exposes KINDS",          inst.KINDS.length === 3);
  check("instance exposes SOURCES",        inst.SOURCES.length === 4);
}

async function run() {
  await _creditDebitBalanceDerivation();
  await _debitOverdraftRefused();
  await _concurrentDebitAtomic();
  await _historyPagination();
  await _bulkBalance();
  await _expiringBalanceWindow();
  await _expireReducesBalance();
  await _transactionsForOrder();
  await _validation();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - gift-card-ledger (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
