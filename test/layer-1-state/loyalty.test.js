"use strict";
/**
 * loyalty — customer points-balance + tier accounts.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0022.
 * Covers:
 *   - ensureAccount: idempotent INSERT-OR-IGNORE; returns created flag
 *   - earn: balance + lifetime increment; tier promotion on crossing
 *   - redeem: refuses on insufficient balance; decrements only balance
 *   - adjust: positive credits lifetime; negative does NOT decrement
 *     lifetime (no retroactive tier downgrade); underflow refused
 *   - expire: caps at current balance; lifetime untouched
 *   - balance: returns zeros for unknown customer
 *   - history: pagination via cursor, newest first
 *   - tierLeaderboard: sorts by lifetime DESC, narrows by tier
 *   - computeTier: tier threshold edges (499 -> bronze, 500 -> silver,
 *     501 -> silver)
 *   - factory + validators: bad thresholds, bad input shapes refused
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_LOYALTY = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0022_loyalty.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_LOYALTY, "utf8")).forEach(function (s) {
    db.prepare(s).run();
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

function _uuid() { return bShop.framework.uuid.v7(); }

async function _ensureAccount() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var cid = _uuid();
  var first = await loy.ensureAccount(cid);
  check("ensureAccount created on first call",  first.created === true);
  check("ensureAccount account.customer_id",     first.account.customer_id === cid);
  check("ensureAccount starts at 0 balance",     first.account.balance_points === 0);
  check("ensureAccount starts at 0 lifetime",    first.account.lifetime_points === 0);
  check("ensureAccount starts at bronze",        first.account.tier === "bronze");

  var second = await loy.ensureAccount(cid);
  check("ensureAccount idempotent on repeat",    second.created === false);
  check("ensureAccount returns existing account", second.account.customer_id === cid);

  await assert.rejects(loy.ensureAccount("not-a-uuid"), /customer_id/);
}

async function _earnAndTierPromotion() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var cid = _uuid();

  // 400 points: still bronze.
  var e1 = await loy.earn({
    customer_id: cid, points: 400, source: "order-paid", order_id: _uuid(),
  });
  check("earn returns balance",            e1.balance === 400);
  check("earn returns lifetime",           e1.lifetime === 400);
  check("earn @ 400 → bronze",             e1.tier === "bronze");
  check("earn @ 400 → no tier change",     e1.tier_changed === false);

  // +100 → 500 lifetime → silver promotion.
  var e2 = await loy.earn({
    customer_id: cid, points: 100, source: "order-paid",
  });
  check("earn @ 500 → silver",             e2.tier === "silver");
  check("earn @ 500 → tier_changed true",  e2.tier_changed === true);
  check("earn @ 500 → balance 500",        e2.balance === 500);
  check("earn @ 500 → lifetime 500",       e2.lifetime === 500);

  // +1500 → 2000 lifetime → gold.
  var e3 = await loy.earn({ customer_id: cid, points: 1500, source: "order-paid" });
  check("earn @ 2000 → gold",              e3.tier === "gold");
  check("earn @ 2000 → tier_changed true", e3.tier_changed === true);

  // +8000 → 10000 lifetime → platinum.
  var e4 = await loy.earn({ customer_id: cid, points: 8000, source: "order-paid" });
  check("earn @ 10000 → platinum",         e4.tier === "platinum");
  check("earn → tier_changed true",        e4.tier_changed === true);

  // Earn without tier crossing.
  var e5 = await loy.earn({ customer_id: cid, points: 50, source: "order-paid" });
  check("earn within platinum stable",     e5.tier === "platinum");
  check("earn within tier → no change",    e5.tier_changed === false);

  // Validation.
  await assert.rejects(loy.earn(),                                  /input object required/);
  await assert.rejects(loy.earn({ customer_id: cid }),               /points/);
  await assert.rejects(loy.earn({ customer_id: cid, points: 0, source: "x" }), /points/);
  await assert.rejects(loy.earn({ customer_id: cid, points: -5, source: "x" }), /points/);
  await assert.rejects(loy.earn({ customer_id: cid, points: 10, source: "" }),   /source/);
  await assert.rejects(loy.earn({ customer_id: cid, points: 10, source: "BAD CASE" }), /source/);
}

async function _redeemAndInsufficientRefusal() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var cid = _uuid();

  await loy.earn({ customer_id: cid, points: 300, source: "order-paid" });

  // Redeem 100 → balance 200, lifetime still 300, tier stays bronze.
  var r1 = await loy.redeem({ customer_id: cid, points: 100, order_id: _uuid() });
  check("redeem returns updated balance",  r1.balance === 200);
  check("redeem lifetime untouched",       r1.lifetime === 300);
  check("redeem tier still bronze",        r1.tier === "bronze");

  // Redeem more than balance → refuse.
  await assert.rejects(
    loy.redeem({ customer_id: cid, points: 500 }),
    /insufficient balance/,
  );

  // Validation.
  await assert.rejects(loy.redeem(),                                       /input object required/);
  await assert.rejects(loy.redeem({ customer_id: cid }),                    /points/);
  await assert.rejects(loy.redeem({ customer_id: cid, points: 0 }),         /points/);

  // Drain to exactly zero — allowed.
  var r2 = await loy.redeem({ customer_id: cid, points: 200 });
  check("redeem to zero",                  r2.balance === 0);
}

async function _adjustPositiveAndNegative() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var cid = _uuid();
  await loy.earn({ customer_id: cid, points: 100, source: "order-paid" });

  // Positive adjustment +500 → balance 600, lifetime 600, silver
  // promotion (since lifetime crosses 500 threshold).
  var a1 = await loy.adjust({
    customer_id: cid, points: 500, source: "service-recovery", notes: "comped",
  });
  check("adjust+ balance",                  a1.balance === 600);
  check("adjust+ lifetime increments",      a1.lifetime === 600);
  check("adjust+ tier promotion to silver", a1.tier === "silver");
  check("adjust+ tier_changed true",        a1.tier_changed === true);

  // Negative adjustment -200 → balance 400, lifetime UNCHANGED at 600
  // (no retroactive tier downgrade), tier still silver.
  var a2 = await loy.adjust({
    customer_id: cid, points: -200, source: "clawback",
  });
  check("adjust- balance decremented",      a2.balance === 400);
  check("adjust- lifetime UNCHANGED",       a2.lifetime === 600);
  check("adjust- tier preserved",           a2.tier === "silver");

  // Negative adjustment exceeding balance → refuse.
  await assert.rejects(
    loy.adjust({ customer_id: cid, points: -1000, source: "clawback" }),
    /underflow/,
  );

  // Zero adjustment refused (signed-int validator).
  await assert.rejects(
    loy.adjust({ customer_id: cid, points: 0, source: "noop" }),
    /points/,
  );
}

async function _expireCapsAtBalance() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var cid = _uuid();
  await loy.earn({ customer_id: cid, points: 200, source: "order-paid" });

  // Expire 50 → balance 150, lifetime still 200.
  var x1 = await loy.expire({ customer_id: cid, points: 50, reason: "annual-sweep" });
  check("expire returns expired count",    x1.expired === 50);
  check("expire balance decremented",      x1.balance === 150);
  check("expire lifetime untouched",       x1.lifetime === 200);

  // Expire MORE than balance → caps at balance, doesn't go negative.
  var x2 = await loy.expire({ customer_id: cid, points: 9999, reason: "annual-sweep" });
  check("expire caps at balance",          x2.expired === 150);
  check("expire post-cap balance",         x2.balance === 0);

  // Expire when balance is 0 → no-op with audit row.
  var x3 = await loy.expire({ customer_id: cid, points: 100, reason: "annual-sweep" });
  check("expire on empty balance no-op",   x3.expired === 0);
  check("expire on empty balance is 0",    x3.balance === 0);

  // Validation.
  await assert.rejects(loy.expire(),                                                  /input object required/);
  await assert.rejects(loy.expire({ customer_id: cid, points: 1 }),                    /reason/);
  await assert.rejects(loy.expire({ customer_id: cid, points: -1, reason: "x-y" }),     /points/);
}

async function _balance() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var cid = _uuid();

  // Unknown customer → zeros + bronze, no row created.
  var b0 = await loy.balance(cid);
  check("balance unknown → 0 balance",     b0.balance === 0);
  check("balance unknown → 0 lifetime",    b0.lifetime === 0);
  check("balance unknown → bronze",        b0.tier === "bronze");
  check("balance unknown → null expires",  b0.tier_expires_at === null);

  await loy.earn({ customer_id: cid, points: 750, source: "order-paid" });
  var b1 = await loy.balance(cid);
  check("balance after earn → 750",         b1.balance === 750);
  check("balance after earn → lifetime",    b1.lifetime === 750);
  check("balance after earn → silver",      b1.tier === "silver");

  await assert.rejects(loy.balance("not-a-uuid"), /customer_id/);
}

async function _historyPagination() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var cid = _uuid();

  // Seed 5 transactions, monotonically increasing timestamps. We wait
  // until Date.now() advances between earns so coarse-clock platforms
  // (Windows 15.6ms tick) still produce distinct occurred_at values —
  // the cursor pagination uses strict `<` so tied timestamps would
  // skip rows.
  async function _earnWithDistinctTs() {
    var beforeTs = Date.now();
    await helpers.waitUntil(function () { return Date.now() > beforeTs; }, {
      timeoutMs: 2000, label: "clock advance",
    });
    return loy.earn({ customer_id: cid, points: 10, source: "order-paid" });
  }
  for (var i = 0; i < 5; i += 1) {
    await _earnWithDistinctTs();
  }

  var page1 = await loy.history(cid, { limit: 2 });
  check("history limit:2 returns 2",        page1.rows.length === 2);
  check("history newest first",             page1.rows[0].occurred_at >= page1.rows[1].occurred_at);
  check("history limit:2 has cursor",       typeof page1.next_cursor === "number");

  var page2 = await loy.history(cid, { limit: 2, cursor: page1.next_cursor });
  check("history page2 returns 2",          page2.rows.length === 2);
  check("history page2 strictly older",     page2.rows[0].occurred_at < page1.next_cursor);

  var page3 = await loy.history(cid, { limit: 2, cursor: page2.next_cursor });
  check("history page3 returns 1 (tail)",   page3.rows.length === 1);
  check("history page3 no further cursor",  page3.next_cursor === null);

  // No cursor + default limit returns all 5.
  var all = await loy.history(cid);
  check("history default returns all 5",    all.rows.length === 5);

  // Validation.
  await assert.rejects(loy.history(cid, { limit: 0 }),     /limit/);
  await assert.rejects(loy.history(cid, { limit: 9999 }),   /limit/);
  await assert.rejects(loy.history(cid, { cursor: -1 }),    /cursor/);
}

async function _tierLeaderboard() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });
  var c1 = _uuid();
  var c2 = _uuid();
  var c3 = _uuid();
  var c4 = _uuid();

  // c1: 100 (bronze), c2: 600 (silver), c3: 3000 (gold), c4: 15000 (platinum)
  await loy.earn({ customer_id: c1, points: 100,   source: "order-paid" });
  await loy.earn({ customer_id: c2, points: 600,   source: "order-paid" });
  await loy.earn({ customer_id: c3, points: 3000,  source: "order-paid" });
  await loy.earn({ customer_id: c4, points: 15000, source: "order-paid" });

  var all = await loy.tierLeaderboard();
  check("leaderboard returns 4",           all.length === 4);
  check("leaderboard top is platinum",     all[0].customer_id === c4 && all[0].tier === "platinum");
  check("leaderboard sorted lifetime DESC",
    all[0].lifetime_points >= all[1].lifetime_points
    && all[1].lifetime_points >= all[2].lifetime_points
    && all[2].lifetime_points >= all[3].lifetime_points);

  var silver = await loy.tierLeaderboard({ tier: "silver" });
  check("leaderboard tier filter",         silver.length === 1 && silver[0].customer_id === c2);

  var gold = await loy.tierLeaderboard({ tier: "gold" });
  check("leaderboard gold-only",           gold.length === 1 && gold[0].customer_id === c3);

  var limited = await loy.tierLeaderboard({ limit: 2 });
  check("leaderboard limit narrows",       limited.length === 2);

  // Validation.
  await assert.rejects(loy.tierLeaderboard({ tier: "diamond" }), /tier/);
  await assert.rejects(loy.tierLeaderboard({ limit: 0 }),         /limit/);
}

async function _computeTierEdges() {
  var loy = bShop.loyalty.create({ query: _makeQuery() });

  // The three demanded edges around the silver threshold.
  check("computeTier(499) → bronze",       loy.computeTier(499) === "bronze");
  check("computeTier(500) → silver",       loy.computeTier(500) === "silver");
  check("computeTier(501) → silver",       loy.computeTier(501) === "silver");

  // And the upper-tier edges for completeness.
  check("computeTier(1999) → silver",      loy.computeTier(1999) === "silver");
  check("computeTier(2000) → gold",        loy.computeTier(2000) === "gold");
  check("computeTier(9999) → gold",        loy.computeTier(9999) === "gold");
  check("computeTier(10000) → platinum",   loy.computeTier(10000) === "platinum");
  check("computeTier(0) → bronze",         loy.computeTier(0) === "bronze");

  // Custom thresholds round-trip.
  var custom = bShop.loyalty.create({
    query: _makeQuery(),
    tierThresholds: { bronze: 0, silver: 100, gold: 1000, platinum: 5000 },
  });
  check("custom silver @ 99 → bronze",     custom.computeTier(99) === "bronze");
  check("custom silver @ 100 → silver",    custom.computeTier(100) === "silver");
  check("custom exports thresholds",       custom.TIER_THRESHOLDS.silver === 100);

  // Validation.
  assert.throws(function () { loy.computeTier(-1); },     /non-negative integer/);
  assert.throws(function () { loy.computeTier(1.5); },    /non-negative integer/);
  assert.throws(function () { loy.computeTier("100"); },   /non-negative integer/);

  // Bad threshold shapes refused at factory time.
  assert.throws(function () {
    bShop.loyalty.create({ query: _makeQuery(), tierThresholds: { bronze: 0, silver: 500, gold: 200, platinum: 1000 } });
  }, /strictly increasing/);
  assert.throws(function () {
    bShop.loyalty.create({ query: _makeQuery(), tierThresholds: { bronze: 50, silver: 100, gold: 200, platinum: 1000 } });
  }, /bronze must be 0/);
  assert.throws(function () {
    bShop.loyalty.create({ query: _makeQuery(), pointsPerUsd: 0 });
  }, /pointsPerUsd/);
  assert.throws(function () {
    bShop.loyalty.create({ query: _makeQuery(), redemptionPointsPerUsd: -1 });
  }, /redemptionPointsPerUsd/);

  // Default ratios exposed.
  check("default pointsPerUsd is 10",            loy.POINTS_PER_USD === 10);
  check("default redemptionPointsPerUsd 100",   loy.REDEMPTION_POINTS_PER_USD === 100);
}

async function run() {
  await _ensureAccount();
  await _earnAndTierPromotion();
  await _redeemAndInsufficientRefusal();
  await _adjustPositiveAndNegative();
  await _expireCapsAtBalance();
  await _balance();
  await _historyPagination();
  await _tierLeaderboard();
  await _computeTierEdges();
}

module.exports = { run: run };
