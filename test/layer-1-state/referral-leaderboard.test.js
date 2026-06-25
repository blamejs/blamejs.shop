"use strict";
/**
 * referral-leaderboard — top-referrer reports + tiered rewards on top
 * of the existing referrals primitive (migration 0025). Reads from
 * referral_codes + referral_invitations (stubbed in via the same in-
 * memory node:sqlite handle that runs migration 0025 + 0182).
 *
 * Layer 1 against in-memory node:sqlite. The loyalty + referrals
 * dependencies are stubbed locally; the underlying referral_codes /
 * referral_invitations tables are populated via direct INSERTs to
 * mirror the funnel state the real referrals primitive would have
 * produced.
 *
 * Coverage:
 *   - topReferrers ranks by completed_referrals DESC + applies the
 *     [from, to] window; calls referrals.revenueForCustomer when wired
 *   - referralTier maps rolling-90d count to bronze / silver / gold /
 *     platinum against the configured thresholds
 *   - tierThresholds returns defaults pre-config; setTierThresholds
 *     persists + monotonicity gate refuses silver < bronze
 *   - awardLeaderboardBonus composes loyalty.earn on first call;
 *     UNIQUE (customer_id, period_label, tier) prevents re-award
 *   - awardLeaderboardBonus rolls back the bonus row when loyalty.earn
 *     throws so a retry can re-attempt
 *   - monthlyChampions returns champions for the UTC month window
 *   - historyForCustomer + cleanupExpiredBonuses + validation surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop              = require("../../lib");
var referralLeaderboard = require("../../lib/referral-leaderboard");
var helpers            = require("../helpers");
var check              = helpers.check;
var assert             = helpers.assert;

var MIG_REFERRALS  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0025_referrals.sql");
var MIG_LEADERBOARD = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0182_referral_leaderboard.sql");

var MS_PER_DAY = 24 * 60 * 60 * 1000;

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_REFERRALS, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  _splitSchema(nodeFs.readFileSync(MIG_LEADERBOARD, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return {
          rows:      [],
          rowCount:  Number(info.changes),
          lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// Loyalty stub — captures every earn call so the test can assert the
// tier-bonus composition. Operator can flip `failNext` to drive the
// rollback path.
function _loyaltyStub(opts) {
  opts = opts || {};
  var calls = [];
  return {
    earn: async function (input) {
      calls.push(input);
      if (opts.failNext) {
        opts.failNext = false;
        var e = new Error("loyalty-down");
        e.code = "LOYALTY_STUB_FAILURE";
        throw e;
      }
      return {
        balance:      input.points,
        lifetime:     input.points,
        tier:         "bronze",
        tier_changed: false,
      };
    },
    calls: calls,
  };
}

// Referrals stub — exposes `revenueForCustomer` so topReferrers can
// surface non-zero lifetime_revenue. The map is operator-driven.
function _referralsStub(revenueMap) {
  revenueMap = revenueMap || {};
  return {
    revenueForCustomer: async function (customerId) {
      return revenueMap[customerId] || 0;
    },
  };
}

// Seed referral_codes + referral_invitations to mirror what the real
// referrals primitive would have produced. Each `funnel` describes one
// completed referral (an invitation with `first_purchase_at` set).
var _seedSeq = 0;
function _seedFunnels(db, funnels) {
  for (var i = 0; i < funnels.length; i += 1) {
    var f = funnels[i];
    var codeId = f.code_id || _uuid();
    var invId  = _uuid();
    // The real primitive enforces "one active code per referrer", but
    // for the leaderboard's read-side aggregation we just need the
    // codes + invitations to join cleanly. Each funnel can reuse the
    // same referrer's code id via `code_id`.
    var ts = f.purchased_at - 1;
    _seedSeq += 1;
    var codeStr = "CODE" + _seedSeq.toString(36).toUpperCase().padStart(4, "0");
    db.prepare(
      "INSERT OR IGNORE INTO referral_codes " +
      "(id, referrer_customer_id, code, status, referrals_count, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'active', 0, ?, ?)",
    ).run(codeId, f.referrer_customer_id, codeStr, ts, ts);
    db.prepare(
      "INSERT INTO referral_invitations " +
      "(id, referral_code_id, referred_email_hash, invited_at, signed_up_at, " +
      "signed_up_customer_id, first_purchase_at, first_order_id, reward_status) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'both-rewarded')",
    ).run(
      invId, codeId, "hash-" + i, ts, ts,
      f.referee_customer_id || _uuid(),
      f.purchased_at,
      f.first_order_id || _uuid(),
    );
  }
}

// ---- 1. topReferrers ranking + window -----------------------------------

async function _topReferrersRanksAndWindows() {
  var h = _makeQuery();
  var alice = _uuid();
  var bob   = _uuid();
  var carol = _uuid();
  // Outside the window — should NOT count.
  var dave  = _uuid();

  var now = Date.now();
  var monthAgo = now - 30 * MS_PER_DAY;
  var twoMonthsAgo = now - 60 * MS_PER_DAY;
  var farPast = now - 365 * MS_PER_DAY;

  _seedFunnels(h.db, [
    // Alice: 4 completed in the last 30 days.
    { referrer_customer_id: alice, code_id: _uuid(), purchased_at: monthAgo + 1 * MS_PER_DAY },
    { referrer_customer_id: alice, code_id: _uuid(), purchased_at: monthAgo + 2 * MS_PER_DAY },
    { referrer_customer_id: alice, code_id: _uuid(), purchased_at: monthAgo + 3 * MS_PER_DAY },
    { referrer_customer_id: alice, code_id: _uuid(), purchased_at: monthAgo + 4 * MS_PER_DAY },
    // Bob: 2 completed in the last 30 days.
    { referrer_customer_id: bob, code_id: _uuid(), purchased_at: monthAgo + 5 * MS_PER_DAY },
    { referrer_customer_id: bob, code_id: _uuid(), purchased_at: monthAgo + 6 * MS_PER_DAY },
    // Carol: 3 completed (2 inside, 1 outside).
    { referrer_customer_id: carol, code_id: _uuid(), purchased_at: monthAgo + 7 * MS_PER_DAY },
    { referrer_customer_id: carol, code_id: _uuid(), purchased_at: monthAgo + 8 * MS_PER_DAY },
    { referrer_customer_id: carol, code_id: _uuid(), purchased_at: twoMonthsAgo },
    // Dave: 1 completed but outside the window entirely.
    { referrer_customer_id: dave, code_id: _uuid(), purchased_at: farPast },
  ]);

  var revenueMap = {};
  revenueMap[alice] = 4500; // cents
  revenueMap[bob]   = 1200;
  // Carol intentionally missing — should fall back to 0.

  var lb = referralLeaderboard.create({
    query:     h.query,
    referrals: _referralsStub(revenueMap),
  });

  var top = await lb.topReferrers({
    from:  monthAgo,
    to:    now,
    limit: 10,
  });

  check("topReferrers returns 3 referrers (window excludes Dave)", top.length === 3);
  check("topReferrers ranks Alice first",                          top[0].referrer_customer_id === alice);
  check("topReferrers Alice count = 4",                            top[0].completed_referrals === 4);
  check("topReferrers Alice revenue = 4500",                       top[0].lifetime_revenue === 4500);
  // Bob and Carol both have 2 completed in the window — the ASC
  // referrer_customer_id tiebreaker decides ordering. UUIDs are
  // v7 (lexicographically monotonic), so the referrer minted
  // first wins the tiebreaker.
  var second = top[1].referrer_customer_id;
  var third  = top[2].referrer_customer_id;
  check("topReferrers second + third are Bob and Carol",           [second, third].sort().join(",")
                                                                   === [bob, carol].sort().join(","));
  check("topReferrers tied second count = 2",                      top[1].completed_referrals === 2);
  check("topReferrers tied third count = 2",                       top[2].completed_referrals === 2);
  check("topReferrers ASC referrer tiebreaker",                    top[1].referrer_customer_id < top[2].referrer_customer_id);

  // limit honored — top-1 returns just Alice.
  var topOne = await lb.topReferrers({ from: monthAgo, to: now, limit: 1 });
  check("topReferrers limit=1",                                    topOne.length === 1
                                                                   && topOne[0].referrer_customer_id === alice);

  // No referrals handle wired -> lifetime_revenue is 0 everywhere.
  var lbBare = referralLeaderboard.create({ query: h.query });
  var topBare = await lbBare.topReferrers({ from: monthAgo, to: now, limit: 5 });
  check("topReferrers without referrals -> zero revenue",          topBare.every(function (r) {
                                                                      return r.lifetime_revenue === 0;
                                                                    }));
}

// ---- 2. referralTier mapping --------------------------------------------

async function _referralTierMapsThresholds() {
  var h = _makeQuery();
  var lb = referralLeaderboard.create({ query: h.query });

  var customer = _uuid();
  var now = Date.now();

  // No referrals yet -> bronze (count = 0, threshold = 0 default).
  var t0 = await lb.referralTier({ customer_id: customer, as_of: now });
  check("referralTier zero count -> bronze",          t0.tier === "bronze");
  check("referralTier rolling_completed = 0",          t0.rolling_completed_referrals === 0);
  check("referralTier rolling_window_days = 90",       t0.rolling_window_days === 90);
  check("referralTier thresholds carry defaults",      t0.thresholds.silver === 5
                                                       && t0.thresholds.gold === 15
                                                       && t0.thresholds.platinum === 40);

  // Seed 5 completed referrals inside the rolling 90d window -> silver.
  var seeds = [];
  for (var i = 0; i < 5; i += 1) {
    seeds.push({
      referrer_customer_id: customer,
      code_id:              _uuid(),
      purchased_at:         now - (10 + i) * MS_PER_DAY,
    });
  }
  _seedFunnels(h.db, seeds);

  var t1 = await lb.referralTier({ customer_id: customer, as_of: now });
  check("referralTier 5 in 90d -> silver",            t1.tier === "silver");
  check("referralTier count = 5",                      t1.rolling_completed_referrals === 5);

  // Seed 10 more to reach 15 -> gold.
  var more = [];
  for (var j = 0; j < 10; j += 1) {
    more.push({
      referrer_customer_id: customer,
      code_id:              _uuid(),
      purchased_at:         now - (20 + j) * MS_PER_DAY,
    });
  }
  _seedFunnels(h.db, more);
  var t2 = await lb.referralTier({ customer_id: customer, as_of: now });
  check("referralTier 15 in 90d -> gold",             t2.tier === "gold");

  // Seed 25 more to reach 40 -> platinum. Spread across days 30..80.
  var manyMore = [];
  for (var k = 0; k < 25; k += 1) {
    manyMore.push({
      referrer_customer_id: customer,
      code_id:              _uuid(),
      purchased_at:         now - (30 + k) * MS_PER_DAY,
    });
  }
  _seedFunnels(h.db, manyMore);
  var t3 = await lb.referralTier({ customer_id: customer, as_of: now });
  check("referralTier 40 in 90d -> platinum",         t3.tier === "platinum");

  // Move the as_of forward so the 90d window slides past all referrals.
  var farFuture = now + 200 * MS_PER_DAY;
  var t4 = await lb.referralTier({ customer_id: customer, as_of: farFuture });
  check("referralTier 90d window slides off",         t4.tier === "bronze"
                                                       && t4.rolling_completed_referrals === 0);
}

// ---- 3. tierThresholds + setTierThresholds ------------------------------

async function _tierThresholdsConfig() {
  var h = _makeQuery();
  var lb = referralLeaderboard.create({ query: h.query });

  // Pre-config: returns DEFAULT_THRESHOLDS.
  var defaults = await lb.tierThresholds();
  check("tierThresholds defaults bronze 0",            defaults.bronze === 0);
  check("tierThresholds defaults silver 5",            defaults.silver === 5);
  check("tierThresholds defaults gold 15",             defaults.gold === 15);
  check("tierThresholds defaults platinum 40",         defaults.platinum === 40);

  // Operator overrides — silver lowered to 3, gold to 10, platinum 30.
  var saved = await lb.setTierThresholds({
    bronze:   0,
    silver:   3,
    gold:     10,
    platinum: 30,
  });
  check("setTierThresholds returns saved",             saved.silver === 3
                                                       && saved.gold === 10
                                                       && saved.platinum === 30);
  check("setTierThresholds updated_at set",            typeof saved.updated_at === "number");

  var after = await lb.tierThresholds();
  check("tierThresholds round-trip silver 3",          after.silver === 3);

  // Re-setting overwrites (singleton id = 1).
  await lb.setTierThresholds({ bronze: 0, silver: 7, gold: 20, platinum: 50 });
  var after2 = await lb.tierThresholds();
  check("tierThresholds re-set silver 7",              after2.silver === 7);
  check("tierThresholds re-set platinum 50",           after2.platinum === 50);

  // Refuse monotonicity violation: silver < bronze.
  await assert.rejects(
    lb.setTierThresholds({ bronze: 10, silver: 5, gold: 15, platinum: 40 }),
    /non-decreasing/,
  );
  // Refuse missing key.
  await assert.rejects(
    lb.setTierThresholds({ bronze: 0, silver: 5, gold: 15 }),
    /platinum missing/,
  );
  // Refuse negative.
  await assert.rejects(
    lb.setTierThresholds({ bronze: -1, silver: 5, gold: 15, platinum: 40 }),
    /non-negative/,
  );

  // Tier resolution honours operator-configured thresholds.
  var customer = _uuid();
  var now = Date.now();
  var seeds = [];
  for (var i = 0; i < 8; i += 1) {
    seeds.push({
      referrer_customer_id: customer,
      code_id:              _uuid(),
      purchased_at:         now - (10 + i) * MS_PER_DAY,
    });
  }
  _seedFunnels(h.db, seeds);
  var t = await lb.referralTier({ customer_id: customer, as_of: now });
  // Thresholds now silver=7, gold=20: 8 completed -> silver.
  check("referralTier honours operator thresholds",    t.tier === "silver"
                                                       && t.rolling_completed_referrals === 8);
}

// ---- 4. awardLeaderboardBonus composes loyalty + UNIQUE re-award --------

async function _awardLeaderboardBonusComposesLoyalty() {
  var h = _makeQuery();
  var loy = _loyaltyStub();
  var lb  = referralLeaderboard.create({
    query:   h.query,
    loyalty: loy,
  });

  var customer = _uuid();

  var first = await lb.awardLeaderboardBonus({
    customer_id:  customer,
    tier:         "gold",
    period_label: "2026-05",
  });
  check("award first status = awarded",                first.status === "awarded");
  check("award gold points_awarded = 2000",            first.points_awarded === 2000);
  check("award returns row id",                        typeof first.id === "string");
  check("award occurred_at set",                       typeof first.occurred_at === "number");
  check("loyalty.earn invoked once",                   loy.calls.length === 1);
  check("loyalty.earn customer_id matches",            loy.calls[0].customer_id === customer);
  check("loyalty.earn points matches tier",            loy.calls[0].points === 2000);
  check("loyalty.earn source = bonus log source",      loy.calls[0].source === referralLeaderboard.BONUS_LOG_SOURCE);
  check("loyalty.earn notes carry tier + period",      loy.calls[0].notes.indexOf("tier=gold") !== -1
                                                       && loy.calls[0].notes.indexOf("period=2026-05") !== -1);

  // Re-award with same (customer, period, tier) refused at the
  // UNIQUE constraint. The status reflects the duplicate; loyalty
  // is NOT invoked a second time.
  var dup = await lb.awardLeaderboardBonus({
    customer_id:  customer,
    tier:         "gold",
    period_label: "2026-05",
  });
  check("award duplicate status = already-awarded",    dup.status === "already-awarded");
  check("award duplicate same id",                     dup.id === first.id);
  check("loyalty.earn NOT re-invoked on dup",          loy.calls.length === 1);

  // Different period_label is a fresh award.
  var nextPeriod = await lb.awardLeaderboardBonus({
    customer_id:  customer,
    tier:         "gold",
    period_label: "2026-06",
  });
  check("award next period = awarded",                 nextPeriod.status === "awarded");
  check("loyalty.earn fires again for new period",     loy.calls.length === 2);

  // Different tier (same period) is a fresh award — operator can
  // pay out a bronze bonus AND a gold bonus for the same period
  // (the leaderboard rolls up multiple ranking dimensions).
  var diffTier = await lb.awardLeaderboardBonus({
    customer_id:  customer,
    tier:         "platinum",
    period_label: "2026-05",
  });
  check("award diff tier same period = awarded",       diffTier.status === "awarded");
  check("award platinum points = 10000",               diffTier.points_awarded === 10000);
  check("loyalty.earn fires again for diff tier",      loy.calls.length === 3);

  // Different customer is a fresh award.
  var customer2 = _uuid();
  var other = await lb.awardLeaderboardBonus({
    customer_id:  customer2,
    tier:         "gold",
    period_label: "2026-05",
  });
  check("award diff customer = awarded",               other.status === "awarded");
  check("loyalty.earn fires again for diff customer",  loy.calls.length === 4);
}

// ---- 5. awardLeaderboardBonus rolls back on loyalty failure -------------

async function _awardRollsBackOnLoyaltyFailure() {
  var h = _makeQuery();
  var loy = _loyaltyStub({ failNext: true });
  var lb  = referralLeaderboard.create({
    query:   h.query,
    loyalty: loy,
  });

  var customer = _uuid();

  // First call: loyalty throws -> bonus row rolled back.
  await assert.rejects(
    lb.awardLeaderboardBonus({
      customer_id:  customer,
      tier:         "silver",
      period_label: "2026-05",
    }),
    function (err) { return err && err.code === "LOYALTY_STUB_FAILURE"; },
  );
  // Row should NOT be present.
  var probe = await h.query(
    "SELECT COUNT(*) AS n FROM referral_leaderboard_bonuses WHERE customer_id = ?1",
    [customer],
  );
  check("bonus row rolled back on loyalty failure",    Number(probe.rows[0].n) === 0);

  // Retry succeeds — the rolled-back row no longer blocks the UNIQUE.
  var retry = await lb.awardLeaderboardBonus({
    customer_id:  customer,
    tier:         "silver",
    period_label: "2026-05",
  });
  check("retry after rollback = awarded",              retry.status === "awarded");

  // No loyalty wiring -> bonus row lands without earn invocation.
  var lbNoLoy = referralLeaderboard.create({ query: h.query });
  var c2 = _uuid();
  var bare = await lbNoLoy.awardLeaderboardBonus({
    customer_id:  c2,
    tier:         "bronze",
    period_label: "2026-05",
  });
  check("award without loyalty = awarded",             bare.status === "awarded");
  check("award without loyalty points_awarded = 100",  bare.points_awarded === 100);
}

// ---- 6. monthlyChampions ------------------------------------------------

async function _monthlyChampionsWindow() {
  var h = _makeQuery();
  var alice = _uuid();
  var bob   = _uuid();
  // May 2026 spans [2026-05-01, 2026-05-31] UTC.
  var may15 = Date.UTC(2026, 4, 15, 12, 0, 0, 0); // mid-May
  var apr20 = Date.UTC(2026, 3, 20, 12, 0, 0, 0); // mid-April — outside

  _seedFunnels(h.db, [
    { referrer_customer_id: alice, code_id: _uuid(), purchased_at: may15 },
    { referrer_customer_id: alice, code_id: _uuid(), purchased_at: may15 + 1 * MS_PER_DAY },
    { referrer_customer_id: alice, code_id: _uuid(), purchased_at: may15 + 2 * MS_PER_DAY },
    { referrer_customer_id: bob,   code_id: _uuid(), purchased_at: may15 + 3 * MS_PER_DAY },
    { referrer_customer_id: bob,   code_id: _uuid(), purchased_at: apr20 }, // outside
  ]);

  var lb = referralLeaderboard.create({ query: h.query });

  var champions = await lb.monthlyChampions({
    year:  2026,
    month: 5,
    limit: 10,
  });
  check("monthlyChampions year persisted",             champions.year === 2026);
  check("monthlyChampions month persisted",            champions.month === 5);
  check("monthlyChampions from = may 1 UTC",           champions.from === Date.UTC(2026, 4, 1, 0, 0, 0, 0));
  check("monthlyChampions to ~ may 31 UTC",            champions.to === Date.UTC(2026, 5, 1, 0, 0, 0, 0) - 1);
  check("monthlyChampions champions has 2 referrers",  champions.champions.length === 2);
  check("monthlyChampions ranks Alice first (3)",      champions.champions[0].referrer_customer_id === alice
                                                       && champions.champions[0].completed_referrals === 3);
  check("monthlyChampions Bob second (1 in May)",      champions.champions[1].referrer_customer_id === bob
                                                       && champions.champions[1].completed_referrals === 1);

  // Refuse out-of-range month.
  await assert.rejects(
    lb.monthlyChampions({ year: 2026, month: 13 }),
    /month/,
  );
  await assert.rejects(
    lb.monthlyChampions({ year: 1969, month: 5 }),
    /year/,
  );
}

// ---- 7. historyForCustomer + cleanupExpiredBonuses ---------------------

async function _historyAndCleanup() {
  var h = _makeQuery();
  var loy = _loyaltyStub();
  var lb  = referralLeaderboard.create({ query: h.query, loyalty: loy });

  var customer = _uuid();

  // Issue three bonuses across different (period, tier) triples.
  await lb.awardLeaderboardBonus({ customer_id: customer, tier: "silver",   period_label: "2026-03" });
  await lb.awardLeaderboardBonus({ customer_id: customer, tier: "gold",     period_label: "2026-04" });
  await lb.awardLeaderboardBonus({ customer_id: customer, tier: "platinum", period_label: "2026-05" });

  var hist = await lb.historyForCustomer({ customer_id: customer });
  check("history returns 3 rows",                      hist.length === 3);
  // Monotonic clock guarantees occurred_at is strictly increasing —
  // history is ORDER BY occurred_at DESC so the most recent (platinum)
  // is first.
  check("history ordered most-recent first",           hist[0].tier === "platinum"
                                                       && hist[1].tier === "gold"
                                                       && hist[2].tier === "silver");
  check("history points_awarded reflects tier",        hist[0].points_awarded === 10000
                                                       && hist[1].points_awarded === 2000
                                                       && hist[2].points_awarded === 500);

  // Hand-stamp the silver row's occurred_at to 100 days ago so
  // cleanupExpiredBonuses(60) sweeps it.
  var hundredDaysAgo = Date.now() - 100 * MS_PER_DAY;
  h.db.prepare(
    "UPDATE referral_leaderboard_bonuses SET occurred_at = ? WHERE tier = 'silver' AND customer_id = ?",
  ).run(hundredDaysAgo, customer);

  var clean = await lb.cleanupExpiredBonuses(60);
  check("cleanupExpiredBonuses returns deleted_count", clean.deleted_count === 1);
  check("cleanupExpiredBonuses cutoff_at set",         typeof clean.cutoff_at === "number");

  var histAfter = await lb.historyForCustomer({ customer_id: customer });
  check("history after cleanup is 2 rows",             histAfter.length === 2);
  check("history after cleanup drops silver",          histAfter.every(function (r) {
                                                          return r.tier !== "silver";
                                                       }));

  // history for unknown customer returns [].
  var miss = await lb.historyForCustomer({ customer_id: _uuid() });
  check("history unknown customer -> []",              Array.isArray(miss) && miss.length === 0);
}

// ---- 8. validation surface ---------------------------------------------

async function _validationSurface() {
  var h = _makeQuery();
  var lb = referralLeaderboard.create({ query: h.query });

  // topReferrers
  await assert.rejects(lb.topReferrers(),                                   /input object required/);
  await assert.rejects(lb.topReferrers({}),                                 /from/);
  await assert.rejects(lb.topReferrers({ from: 100, to: 50 }),              /from must be <= to/);
  await assert.rejects(lb.topReferrers({ from: 100, to: 200, limit: 0 }),   /limit/);
  await assert.rejects(lb.topReferrers({ from: 100, to: 200, limit: 200 }), /limit/);
  await assert.rejects(lb.topReferrers({ from: -1, to: 100 }),              /from/);

  // referralTier
  await assert.rejects(lb.referralTier(),                                   /input object required/);
  await assert.rejects(lb.referralTier({}),                                 /customer_id/);
  await assert.rejects(lb.referralTier({ customer_id: "not-a-uuid" }),      /customer_id/);
  await assert.rejects(
    lb.referralTier({ customer_id: _uuid(), as_of: -1 }),
    /as_of/,
  );

  // awardLeaderboardBonus
  await assert.rejects(lb.awardLeaderboardBonus(),                          /input object required/);
  await assert.rejects(lb.awardLeaderboardBonus({}),                        /customer_id/);
  await assert.rejects(
    lb.awardLeaderboardBonus({ customer_id: _uuid(), tier: "bogus" }),
    /tier/,
  );
  await assert.rejects(
    lb.awardLeaderboardBonus({ customer_id: _uuid(), tier: "gold", period_label: "" }),
    /period_label/,
  );
  await assert.rejects(
    lb.awardLeaderboardBonus({
      customer_id:  _uuid(),
      tier:         "gold",
      period_label: "bad period label",
    }),
    /period_label/,
  );

  // historyForCustomer
  await assert.rejects(lb.historyForCustomer(),                             /input object required/);
  await assert.rejects(lb.historyForCustomer({ customer_id: "x" }),         /customer_id/);

  // monthlyChampions
  await assert.rejects(lb.monthlyChampions(),                               /input object required/);
  await assert.rejects(lb.monthlyChampions({ year: 2026 }),                 /month/);
  await assert.rejects(lb.monthlyChampions({ year: 2026, month: 0 }),       /month/);
  await assert.rejects(lb.monthlyChampions({ year: 2026, month: 5, limit: 0 }), /limit/);

  // cleanupExpiredBonuses
  await assert.rejects(lb.cleanupExpiredBonuses(),                          /days/);
  await assert.rejects(lb.cleanupExpiredBonuses(0),                         /days/);
  await assert.rejects(lb.cleanupExpiredBonuses(-1),                        /days/);

  // Factory refusals.
  assert.throws(function () {
    referralLeaderboard.create({ query: h.query, loyalty: { /* missing earn */ } });
  }, /loyalty/);
  assert.throws(function () {
    referralLeaderboard.create({
      query:     h.query,
      referrals: { revenueForCustomer: "not-a-function" },
    });
  }, /revenueForCustomer/);
  assert.throws(function () {
    referralLeaderboard.create({
      query:           h.query,
      tierBonusPoints: { silver: -5 },
    });
  }, /tierBonusPoints\.silver/);

  // Exported constants.
  check("TIERS exported",                              Array.isArray(referralLeaderboard.TIERS)
                                                       && referralLeaderboard.TIERS.indexOf("bronze") !== -1
                                                       && referralLeaderboard.TIERS.indexOf("platinum") !== -1);
  check("DEFAULT_THRESHOLDS exported",                 referralLeaderboard.DEFAULT_THRESHOLDS.silver === 5);
  check("DEFAULT_TIER_BONUS_POINTS exported",          referralLeaderboard.DEFAULT_TIER_BONUS_POINTS.gold === 2000);
  check("ROLLING_WINDOW_DAYS exported",                referralLeaderboard.ROLLING_WINDOW_DAYS === 90);
  check("BONUS_LOG_SOURCE exported",                   typeof referralLeaderboard.BONUS_LOG_SOURCE === "string");

  // Instance also exposes the constants for ergonomic operator use.
  check("instance TIERS",                              lb.TIERS.length === 4);
  check("instance DEFAULT_THRESHOLDS",                 lb.DEFAULT_THRESHOLDS.platinum === 40);
}

// Prod-redaction regression for the re-award dedup. A UNIQUE(customer, period,
// tier) collision surfaces in production as a bare "HTTP 500" (the D1
// service-binding redacts the SQLite "UNIQUE constraint failed" text), so the
// old indexOf("UNIQUE") gate would have re-thrown instead of returning the
// existing row. Redact EVERY error to "HTTP 500" and prove the second award
// still collapses to already-awarded via the unconditional re-read.
async function _awardLeaderboardBonusDedupUnderRedactedError() {
  var base = _makeQuery();
  var redacting = async function (sql, params) {
    try { return await base.query(sql, params); }
    catch (_e) { throw new Error("HTTP 500"); }   // redact the UNIQUE collision, like prod
  };
  var lb = referralLeaderboard.create({ query: redacting, loyalty: _loyaltyStub() });
  var input = { customer_id: _uuid(), tier: "gold", period_label: "2026-07" };
  var first = await lb.awardLeaderboardBonus(input);
  check("redacted-dedup: first award succeeds", first.status === "awarded");
  // The re-award's INSERT collides on the UNIQUE key; the error is a bare
  // "HTTP 500", yet the re-read still finds the existing row.
  var dup = await lb.awardLeaderboardBonus(input);
  check("redacted-dedup: duplicate collapses to already-awarded despite the bare HTTP 500",
    dup.status === "already-awarded" && dup.id === first.id);
}

async function run() {
  await _topReferrersRanksAndWindows();
  await _referralTierMapsThresholds();
  await _tierThresholdsConfig();
  await _awardLeaderboardBonusComposesLoyalty();
  await _awardLeaderboardBonusDedupUnderRedactedError();
  await _awardRollsBackOnLoyaltyFailure();
  await _monthlyChampionsWindow();
  await _historyAndCleanup();
  await _validationSurface();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - referral-leaderboard (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    },
  );
}
