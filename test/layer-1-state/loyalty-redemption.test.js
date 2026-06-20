"use strict";
/**
 * loyalty-redemption — customer-facing redemption layer on top of the
 * loyalty points ledger.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations 0022
 * (loyalty) and 0085 (loyalty_redemptions).
 *
 * Coverage:
 *   - defineReward: refuses redefinition, refuses bad kind, refuses
 *     value_json that doesn't match the kind, refuses bad point_cost
 *   - redeemForCustomer: happy path returns redemption_id +
 *     coupon_code (when coupons handle injected) + expires_at;
 *     insufficient-points refusal propagates from loyalty.redeem;
 *     archived / inactive reward refused with REWARD_NOT_REDEEMABLE
 *   - max_per_customer: count enforces the cap across active +
 *     consumed redemptions; cancelled redemptions don't count
 *   - markConsumed: active → consumed, sets order_id; refuses anything
 *     other than 'active'
 *   - cancelRedemption: active → cancelled refunds points to the
 *     spendable balance via loyalty.creditBalance (lifetime untouched,
 *     so a redeem→cancel loop can't ratchet the tier); consumed
 *     redemption refused (no auto refund after consumption)
 *   - updateReward / archiveReward / listRewards
 *   - redemptionsForCustomer pagination
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop             = require("../../lib");
var loyaltyRedemption = require("../../lib/loyalty-redemption");
var helpers           = require("../helpers");
var check             = helpers.check;
var assert            = helpers.assert;

var MIG_LOYALTY     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0022_loyalty.sql");
// Adds loyalty_transactions.restored_points — the column reverseRedemptionById
// claims against when a redemption is rolled back (lost cap claim / mint failure).
var MIG_RESTORED    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0223_loyalty_txn_restored_points.sql");
var MIG_REDEMPTIONS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0085_loyalty_redemptions.sql");

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
  _splitSchema(nodeFs.readFileSync(MIG_RESTORED, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  _splitSchema(nodeFs.readFileSync(MIG_REDEMPTIONS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db: db,
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

function _uuid() { return bShop.framework.uuid.v7(); }

// Minimal fake coupons handle — captures every mint call and returns a
// deterministic single-use code derived from the reward slug + a
// monotonic counter. Operator wires their real coupons primitive in
// production; the test substitutes this shape so the redemption-layer
// behavior is exercised in isolation.
function _fakeCoupons() {
  var counter = 0;
  var mints = [];
  return {
    mints: mints,
    issueSingleUseFromReward: async function (input) {
      counter += 1;
      mints.push({
        customer_id: input.customer_id,
        reward_slug: input.reward_slug,
        value_json:  input.value_json,
        expires_at:  input.expires_at,
      });
      return { code: "LRR-" + input.reward_slug.toUpperCase() + "-" + counter };
    },
  };
}

function _factory(opts) {
  opts = opts || {};
  var h = _makeQuery();
  var loy = bShop.loyalty.create({ query: h.query });
  var couponsHandle = opts.withCoupons === false ? null : _fakeCoupons();
  var lr = loyaltyRedemption.create({
    query:   h.query,
    loyalty: loy,
    coupons: couponsHandle,
  });
  return { db: h.db, query: h.query, loyalty: loy, coupons: couponsHandle, lr: lr };
}

// ---- tests --------------------------------------------------------------

async function _defineRewardRefusals() {
  var f = _factory();

  // Happy define — discount_percent.
  var r1 = await f.lr.defineReward({
    slug:        "save-ten",
    kind:        "discount_percent",
    title:       "10% off your next order",
    point_cost:  500,
    value_json:  { percent: 10 },
    active:      true,
  });
  check("defineReward returns hydrated row",         r1.slug === "save-ten");
  check("defineReward kind discount_percent",        r1.kind === "discount_percent");
  check("defineReward point_cost",                   r1.point_cost === 500);
  check("defineReward value_json round-trips",       r1.value_json.percent === 10);
  check("defineReward active true",                  r1.active === true);
  check("defineReward archived_at null",             r1.archived_at === null);
  check("defineReward no max_per_customer",          r1.max_per_customer === null);
  check("defineReward no expires window",            r1.expires_days_after_redemption === null);

  // Define each remaining kind for shape coverage.
  var r2 = await f.lr.defineReward({
    slug: "save-500", kind: "discount_amount", title: "$5 off",
    point_cost: 600, value_json: { amount_minor: 500 }, active: true,
  });
  check("defineReward discount_amount value_json",   r2.value_json.amount_minor === 500);

  var freeProdId = _uuid();
  var r3 = await f.lr.defineReward({
    slug: "free-mug", kind: "free_product", title: "Free mug",
    point_cost: 1000, value_json: { product_id: freeProdId }, active: true,
  });
  check("defineReward free_product value_json",      r3.value_json.product_id === freeProdId);

  var r4 = await f.lr.defineReward({
    slug: "free-ship", kind: "free_shipping", title: "Free shipping",
    point_cost: 200, value_json: {}, active: true,
  });
  check("defineReward free_shipping empty payload",  Object.keys(r4.value_json).length === 0);

  // Refuse redefinition.
  await assert.rejects(
    f.lr.defineReward({ slug: "save-ten", kind: "discount_percent", title: "dup", point_cost: 100, value_json: { percent: 5 }, active: true }),
    /already exists/,
  );

  // Refuse bad kind.
  await assert.rejects(
    f.lr.defineReward({ slug: "bogus", kind: "free_lunch", title: "x", point_cost: 100, value_json: {}, active: true }),
    /kind must be one of/,
  );

  // Refuse value_json that doesn't match kind.
  await assert.rejects(
    f.lr.defineReward({ slug: "bad-pct", kind: "discount_percent", title: "x", point_cost: 100, value_json: { percent: 150 }, active: true }),
    /percent must be an integer in \[1, 100\]/,
  );
  await assert.rejects(
    f.lr.defineReward({ slug: "bad-amt", kind: "discount_amount", title: "x", point_cost: 100, value_json: { amount_minor: -1 }, active: true }),
    /amount_minor/,
  );
  await assert.rejects(
    f.lr.defineReward({ slug: "bad-prod", kind: "free_product", title: "x", point_cost: 100, value_json: {}, active: true }),
    /product_id/,
  );
  await assert.rejects(
    f.lr.defineReward({ slug: "bad-ship", kind: "free_shipping", title: "x", point_cost: 100, value_json: { unexpected: true }, active: true }),
    /empty object/,
  );

  // Refuse bad point_cost.
  await assert.rejects(
    f.lr.defineReward({ slug: "free-thing", kind: "discount_percent", title: "x", point_cost: 0, value_json: { percent: 5 }, active: true }),
    /point_cost/,
  );

  // Refuse bad slug.
  await assert.rejects(
    f.lr.defineReward({ slug: "BAD SLUG", kind: "discount_percent", title: "x", point_cost: 100, value_json: { percent: 5 }, active: true }),
    /slug/,
  );

  // Refuse missing input.
  await assert.rejects(f.lr.defineReward(), /input object required/);

  // Factory refuses missing loyalty handle.
  assert.throws(function () { loyaltyRedemption.create({ query: f.query }); }, /loyalty handle required/);

  // Factory refuses bad coupons handle shape.
  assert.throws(function () {
    loyaltyRedemption.create({ query: f.query, loyalty: f.loyalty, coupons: { unexpected: true } });
  }, /coupons handle must expose/);
}

async function _redeemHappyAndInsufficient() {
  var f = _factory();
  var cid = _uuid();

  await f.lr.defineReward({
    slug: "save-ten", kind: "discount_percent", title: "10% off",
    point_cost: 500, value_json: { percent: 10 },
    expires_days_after_redemption: 30, active: true,
  });

  // Customer earns 600 points.
  await f.loyalty.earn({ customer_id: cid, points: 600, source: "order-paid" });

  // Redeem the 500-point reward — happy path.
  var redeemed = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "save-ten" });
  check("redeem returns redemption_id",         typeof redeemed.redemption_id === "string" && redeemed.redemption_id.length > 0);
  check("redeem returns coupon_code",           typeof redeemed.coupon_code === "string" && redeemed.coupon_code.indexOf("LRR-SAVE-TEN") === 0);
  check("redeem returns expires_at",            typeof redeemed.expires_at === "number" && redeemed.expires_at > Date.now());

  // The points ledger reflects the debit.
  var bal = await f.loyalty.balance(cid);
  check("loyalty balance after redeem = 100",   bal.balance === 100);
  check("loyalty lifetime untouched by redeem", bal.lifetime === 600);

  // The coupons handle was called with the right shape.
  check("coupons.issueSingleUseFromReward called once", f.coupons.mints.length === 1);
  check("coupons mint carries customer_id",      f.coupons.mints[0].customer_id === cid);
  check("coupons mint carries reward_slug",      f.coupons.mints[0].reward_slug === "save-ten");
  check("coupons mint carries value_json",       f.coupons.mints[0].value_json.percent === 10);
  check("coupons mint carries expires_at",       f.coupons.mints[0].expires_at === redeemed.expires_at);

  // Redemption row is queryable.
  var row = await f.lr.getRedemption(redeemed.redemption_id);
  check("getRedemption status active",           row.status === "active");
  check("getRedemption customer_id",             row.customer_id === cid);
  check("getRedemption reward_slug",             row.reward_slug === "save-ten");
  check("getRedemption points_debited",          row.points_debited === 500);
  check("getRedemption coupon_code persisted",   row.coupon_code === redeemed.coupon_code);
  check("getRedemption expires_at persisted",    row.expires_at === redeemed.expires_at);

  // Now a second redemption would underflow the balance (100 < 500).
  // The error propagates from loyalty.redeem.
  await assert.rejects(
    f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "save-ten" }),
    /insufficient balance/,
  );

  // The redemption ledger is unchanged — no row written for the
  // refused redemption.
  var list = await f.lr.redemptionsForCustomer(cid);
  check("refused redeem wrote no redemption row", list.rows.length === 1);

  // Archived reward — refuse with REWARD_NOT_REDEEMABLE.
  await f.lr.archiveReward("save-ten");
  await f.loyalty.earn({ customer_id: cid, points: 1000, source: "order-paid" });
  var archivedRejection;
  try {
    await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "save-ten" });
  } catch (e) {
    archivedRejection = e;
  }
  check("archived reward → REWARD_NOT_REDEEMABLE code",
    archivedRejection && archivedRejection.code === "REWARD_NOT_REDEEMABLE");

  // Inactive (non-archived) — also refused.
  await f.lr.defineReward({
    slug: "off-tomorrow", kind: "free_shipping", title: "x",
    point_cost: 50, value_json: {}, active: false,
  });
  var inactiveRejection;
  try {
    await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "off-tomorrow" });
  } catch (e) {
    inactiveRejection = e;
  }
  check("inactive reward → REWARD_NOT_REDEEMABLE code",
    inactiveRejection && inactiveRejection.code === "REWARD_NOT_REDEEMABLE");

  // Unknown reward — TypeError.
  await assert.rejects(
    f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "nope-slug" }),
    /not found/,
  );

  // Bad input shape.
  await assert.rejects(f.lr.redeemForCustomer(),                                   /input object required/);
  await assert.rejects(f.lr.redeemForCustomer({ customer_id: "not-uuid" }),         /customer_id/);
  await assert.rejects(f.lr.redeemForCustomer({ customer_id: cid }),                /slug/);
}

async function _maxPerCustomerCap() {
  var f = _factory();
  var cid = _uuid();

  // 2-per-customer cap reward.
  await f.lr.defineReward({
    slug: "bday-treat", kind: "free_shipping", title: "Birthday treat",
    point_cost: 100, value_json: {}, max_per_customer: 2, active: true,
  });

  await f.loyalty.earn({ customer_id: cid, points: 500, source: "order-paid" });

  var r1 = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "bday-treat" });
  var r2 = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "bday-treat" });
  check("cap=2 first redeem id present",  typeof r1.redemption_id === "string");
  check("cap=2 second redeem id present", typeof r2.redemption_id === "string");

  // Third attempt — refused with REDEMPTION_CAP_REACHED.
  var capRejection;
  try {
    await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "bday-treat" });
  } catch (e) {
    capRejection = e;
  }
  check("cap=2 third refused",            capRejection && capRejection.code === "REDEMPTION_CAP_REACHED");

  // The refused redemption didn't burn points or create a row.
  var bal = await f.loyalty.balance(cid);
  check("cap refusal didn't debit points", bal.balance === 300);

  // Cancelling one of the two existing redemptions opens a slot —
  // cancelled redemptions don't count toward the cap.
  await f.lr.cancelRedemption({ redemption_id: r1.redemption_id, reason: "operator-rollback" });
  var afterCancel = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "bday-treat" });
  check("cancel frees a cap slot",         typeof afterCancel.redemption_id === "string");

  // Another customer is unaffected.
  var cid2 = _uuid();
  await f.loyalty.earn({ customer_id: cid2, points: 500, source: "order-paid" });
  var otherCust = await f.lr.redeemForCustomer({ customer_id: cid2, reward_slug: "bday-treat" });
  check("cap is per-customer",             typeof otherCust.redemption_id === "string");
}

async function _markConsumedFsm() {
  var f = _factory();
  var cid = _uuid();

  await f.lr.defineReward({
    slug: "save-five", kind: "discount_percent", title: "5% off",
    point_cost: 250, value_json: { percent: 5 }, active: true,
  });
  await f.loyalty.earn({ customer_id: cid, points: 1000, source: "order-paid" });
  var redeemed = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "save-five" });

  // Active → consumed.
  var orderId = _uuid();
  var consumed = await f.lr.markConsumed({ redemption_id: redeemed.redemption_id, order_id: orderId });
  check("markConsumed sets status",        consumed.status === "consumed");
  check("markConsumed sets order_id",      consumed.order_id === orderId);
  check("markConsumed sets consumed_at",   typeof consumed.consumed_at === "number");

  // Consumed → consumed (double-consume refused).
  var rebadRej;
  try {
    await f.lr.markConsumed({ redemption_id: redeemed.redemption_id, order_id: _uuid() });
  } catch (e) {
    rebadRej = e;
  }
  check("double-consume → REDEMPTION_NOT_ACTIVE",
    rebadRej && rebadRej.code === "REDEMPTION_NOT_ACTIVE");

  // Cancelled cannot be consumed.
  var redeemed2 = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "save-five" });
  await f.lr.cancelRedemption({ redemption_id: redeemed2.redemption_id, reason: "shopper-changed-mind" });
  var cancelledRej;
  try {
    await f.lr.markConsumed({ redemption_id: redeemed2.redemption_id, order_id: _uuid() });
  } catch (e) {
    cancelledRej = e;
  }
  check("cancelled → REDEMPTION_NOT_ACTIVE on markConsumed",
    cancelledRej && cancelledRej.code === "REDEMPTION_NOT_ACTIVE");

  // Unknown redemption_id.
  await assert.rejects(
    f.lr.markConsumed({ redemption_id: _uuid(), order_id: _uuid() }),
    /not found/,
  );

  // Bad input shape.
  await assert.rejects(f.lr.markConsumed(),                                  /input object required/);
  await assert.rejects(f.lr.markConsumed({ redemption_id: "x" }),             /redemption_id/);
}

async function _cancelRefundsOnlyActive() {
  var f = _factory();
  var cid = _uuid();

  await f.lr.defineReward({
    slug: "ten-off", kind: "discount_percent", title: "10% off",
    point_cost: 400, value_json: { percent: 10 }, active: true,
  });
  await f.loyalty.earn({ customer_id: cid, points: 1000, source: "order-paid" });
  var balAfterEarn = await f.loyalty.balance(cid);
  check("post-earn balance",              balAfterEarn.balance === 1000);

  // Redeem → balance 600.
  var r = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "ten-off" });
  var balAfterRedeem = await f.loyalty.balance(cid);
  check("post-redeem balance debited",    balAfterRedeem.balance === 600);

  // Cancel while active → refunds points back to 1000.
  var cancelled = await f.lr.cancelRedemption({ redemption_id: r.redemption_id, reason: "operator-rollback" });
  check("cancel status",                  cancelled.status === "cancelled");
  check("cancel reason persisted",        cancelled.cancel_reason === "operator-rollback");
  var balAfterCancel = await f.loyalty.balance(cid);
  check("cancel refunded points",         balAfterCancel.balance === 1000);

  // A SECOND redemption — mark it consumed, THEN attempt to cancel.
  // Cancel must refuse because status is no longer 'active'.
  var r2 = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "ten-off" });
  await f.lr.markConsumed({ redemption_id: r2.redemption_id, order_id: _uuid() });
  var balAfterConsume = await f.loyalty.balance(cid);
  check("consumed redemption holds debit", balAfterConsume.balance === 600);

  var consumedCancelRej;
  try {
    await f.lr.cancelRedemption({ redemption_id: r2.redemption_id, reason: "too-late" });
  } catch (e) {
    consumedCancelRej = e;
  }
  check("cancel after consume refused",   consumedCancelRej && consumedCancelRej.code === "REDEMPTION_NOT_ACTIVE");
  var balUnchanged = await f.loyalty.balance(cid);
  check("refused cancel didn't refund",   balUnchanged.balance === 600);

  // Cancel the same (already-cancelled) one — refused, balance untouched.
  var doubleCancelRej;
  try {
    await f.lr.cancelRedemption({ redemption_id: r.redemption_id, reason: "duplicate" });
  } catch (e) {
    doubleCancelRej = e;
  }
  check("double-cancel refused",          doubleCancelRej && doubleCancelRej.code === "REDEMPTION_NOT_ACTIVE");

  // Unknown redemption.
  await assert.rejects(
    f.lr.cancelRedemption({ redemption_id: _uuid(), reason: "nothing" }),
    /not found/,
  );

  // Bad input shape.
  await assert.rejects(f.lr.cancelRedemption(),                                       /input object required/);
  await assert.rejects(f.lr.cancelRedemption({ redemption_id: r.redemption_id }),      /reason/);
}

async function _cancelDoesNotInflateLifetime() {
  // redeem debits the spendable balance and leaves lifetime alone;
  // cancelRedemption must give the points back to the balance WITHOUT
  // crediting lifetime. Otherwise a redeem→cancel loop ratchets the
  // tier-driving lifetime total upward without bound.
  var f = _factory();
  var cid = _uuid();

  await f.lr.defineReward({
    slug: "fifty-off", kind: "discount_percent", title: "50% off",
    point_cost: 400, value_json: { percent: 50 }, active: true,
  });

  // Earn 1000 → lifetime 1000, balance 1000, tier silver (>=500).
  await f.loyalty.earn({ customer_id: cid, points: 1000, source: "order-paid" });
  var earned = await f.loyalty.balance(cid);
  check("baseline lifetime == earned",      earned.lifetime === 1000);
  check("baseline balance == earned",       earned.balance === 1000);
  check("baseline tier silver",             earned.tier === "silver");

  // Loop redeem→cancel many times. Each cancel refunds 400 points.
  // Lifetime must stay pinned at 1000 across the whole loop, and the
  // balance must return to 1000 after each cancel.
  for (var i = 0; i < 6; i += 1) {
    var r = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "fifty-off" });
    var afterRedeem = await f.loyalty.balance(cid);
    check("loop redeem debits balance to 600",       afterRedeem.balance === 600);
    check("loop redeem leaves lifetime at 1000",     afterRedeem.lifetime === 1000);

    await f.lr.cancelRedemption({ redemption_id: r.redemption_id, reason: "operator-rollback" });
    var afterCancel = await f.loyalty.balance(cid);
    check("loop cancel restores balance to 1000",    afterCancel.balance === 1000);
    check("loop cancel does NOT grow lifetime",      afterCancel.lifetime === 1000);
    check("loop cancel does NOT escalate tier",      afterCancel.tier === "silver");
  }

  // Final state: lifetime never moved off the earned total, so the
  // tier never escalated past where the genuine earn placed it.
  var final = await f.loyalty.balance(cid);
  check("final lifetime unchanged == 1000",  final.lifetime === 1000);
  check("final balance restored == 1000",    final.balance === 1000);
  check("final tier still silver",           final.tier === "silver");
}

async function _updateAndArchiveReward() {
  var f = _factory();

  await f.lr.defineReward({
    slug: "tier-perk", kind: "discount_amount", title: "Original",
    point_cost: 500, value_json: { amount_minor: 200 }, active: true,
  });

  var updated = await f.lr.updateReward("tier-perk", {
    title: "Updated title",
    point_cost: 700,
    value_json: { amount_minor: 500 },
  });
  check("updateReward title",       updated.title === "Updated title");
  check("updateReward point_cost",  updated.point_cost === 700);
  check("updateReward value_json",  updated.value_json.amount_minor === 500);

  // updateReward refuses unsupported column.
  await assert.rejects(f.lr.updateReward("tier-perk", { kind: "free_shipping" }), /unsupported column/);

  // updateReward enforces kind-vs-value_json contract on patch.
  await assert.rejects(
    f.lr.updateReward("tier-perk", { value_json: { percent: 10 } }),
    /amount_minor/,
  );

  // Unknown slug.
  await assert.rejects(f.lr.updateReward("nope", { title: "x" }), /not found/);

  // Toggle active off via patch.
  var inactive = await f.lr.updateReward("tier-perk", { active: false });
  check("updateReward active false",   inactive.active === false);

  // archiveReward.
  var archived = await f.lr.archiveReward("tier-perk");
  check("archiveReward sets archived_at", archived.archived_at !== null);
  check("archiveReward sets active 0",    archived.active === false);

  // Idempotent re-archive returns the existing row.
  var rearchived = await f.lr.archiveReward("tier-perk");
  check("archiveReward idempotent",       rearchived.archived_at === archived.archived_at);

  // archiveReward refuses unknown slug.
  await assert.rejects(f.lr.archiveReward("nope-slug"), /not found/);
}

async function _listAndPaginate() {
  var f = _factory();
  var cid = _uuid();

  // Author three rewards, one archived.
  await f.lr.defineReward({ slug: "a-perk", kind: "free_shipping", title: "A", point_cost: 100, value_json: {}, active: true });
  await f.lr.defineReward({ slug: "b-perk", kind: "free_shipping", title: "B", point_cost: 200, value_json: {}, active: true });
  await f.lr.defineReward({ slug: "c-perk", kind: "free_shipping", title: "C", point_cost: 300, value_json: {}, active: true });
  await f.lr.archiveReward("c-perk");

  var allRewards = await f.lr.listRewards();
  check("listRewards default returns all",       allRewards.length === 3);

  var activeOnly = await f.lr.listRewards({ active_only: true });
  check("listRewards active_only excludes archived", activeOnly.length === 2);
  check("listRewards active_only sorted by point_cost",
    activeOnly[0].point_cost <= activeOnly[1].point_cost);

  // Seed 3 redemptions for `cid` against a-perk.
  await f.loyalty.earn({ customer_id: cid, points: 1000, source: "order-paid" });
  var redeemedIds = [];
  for (var i = 0; i < 3; i += 1) {
    var beforeTs = Date.now();
    await helpers.waitUntil(function () { return Date.now() > beforeTs; }, {
      timeoutMs: 2000, label: "clock advance",
    });
    var r = await f.lr.redeemForCustomer({ customer_id: cid, reward_slug: "a-perk" });
    redeemedIds.push(r.redemption_id);
  }

  var page1 = await f.lr.redemptionsForCustomer(cid, { limit: 2 });
  check("redemptionsForCustomer limit:2 returns 2",   page1.rows.length === 2);
  check("redemptionsForCustomer newest first",
    page1.rows[0].redeemed_at >= page1.rows[1].redeemed_at);
  check("redemptionsForCustomer cursor present",       typeof page1.next_cursor === "number");

  var page2 = await f.lr.redemptionsForCustomer(cid, { limit: 2, cursor: page1.next_cursor });
  check("redemptionsForCustomer page2 returns tail",   page2.rows.length === 1);
  check("redemptionsForCustomer page2 no cursor",      page2.next_cursor === null);

  // Without coupons handle, redemption proceeds without coupon_code.
  var noCouponF = _factory({ withCoupons: false });
  await noCouponF.lr.defineReward({
    slug: "ship-only", kind: "free_shipping", title: "Ship only",
    point_cost: 100, value_json: {}, active: true,
  });
  var cid2 = _uuid();
  await noCouponF.loyalty.earn({ customer_id: cid2, points: 200, source: "order-paid" });
  var noCouponRedeem = await noCouponF.lr.redeemForCustomer({ customer_id: cid2, reward_slug: "ship-only" });
  check("redeem w/o coupons handle coupon_code null",  noCouponRedeem.coupon_code === null);

  // Validation on redemptionsForCustomer.
  await assert.rejects(f.lr.redemptionsForCustomer(cid, { limit: 0 }),       /limit/);
  await assert.rejects(f.lr.redemptionsForCustomer(cid, { cursor: -1 }),     /cursor/);

  // Validation on listRewards.
  await assert.rejects(f.lr.listRewards({ active_only: "yes" }),              /active_only/);
  await assert.rejects(f.lr.listRewards({ limit: 0 }),                        /limit/);
}

// The per-customer cap is enforced ATOMICALLY by the redemption INSERT,
// not only the pre-check: even when the pre-check count is stale (a
// concurrent redeem filled the slot after it read), the INSERT...SELECT
// recomputes the live count and the loser inserts zero rows. Simulate the
// stale pre-check by forcing the standalone COUNT to read 0, and prove the
// INSERT still refuses the over-cap redemption AND returns the points.
async function _capEnforcedAtomicallyDespiteStalePrecheck() {
  var h = _makeQuery();
  var loy = bShop.loyalty.create({ query: h.query });
  var coupons = _fakeCoupons();
  // Pre-check COUNT always reads 0 (stale); the INSERT...SELECT (verb
  // INSERT) passes through and sees the real count.
  var staleQuery = async function (sql, params) {
    if (/^\s*SELECT\s+COUNT\(\*\)\s+AS\s+n\s+FROM\s+loyalty_redemptions/i.test(sql)) {
      return { rows: [{ n: 0 }], rowCount: 1 };
    }
    return h.query(sql, params);
  };
  var lr = loyaltyRedemption.create({ query: staleQuery, loyalty: loy, coupons: coupons });

  await lr.defineReward({
    slug: "one-only", kind: "free_shipping", title: "One only",
    point_cost: 100, value_json: {}, max_per_customer: 1, active: true,
  });
  var cid = _uuid();
  await loy.earn({ customer_id: cid, points: 500, source: "order-paid" });

  var r1 = await lr.redeemForCustomer({ customer_id: cid, reward_slug: "one-only" });
  check("atomic-cap: first redemption succeeds",          typeof r1.redemption_id === "string");
  check("atomic-cap: one debit after first",              (await loy.balance(cid)).balance === 400);

  // Second redemption: pre-check is stale-0 (would wrongly pass), but the
  // atomic INSERT sees the live count (1) and refuses.
  var capErr = null;
  try { await lr.redeemForCustomer({ customer_id: cid, reward_slug: "one-only" }); }
  catch (e) { capErr = e; }
  check("atomic-cap: second refused by the INSERT guard",
    capErr && capErr.code === "REDEMPTION_CAP_REACHED");
  check("atomic-cap: refused redemption's points restored", (await loy.balance(cid)).balance === 400);
  var rows = h.db.prepare("SELECT COUNT(*) AS n FROM loyalty_redemptions WHERE customer_id = ?").all(cid);
  check("atomic-cap: exactly one redemption row",         Number(rows[0].n) === 1);
}

// If the coupon mint fails AFTER the points are debited and the slot is
// claimed, BOTH are rolled back: the points are returned and no redemption
// row is left behind — the customer is never charged for a reward they
// didn't receive and the burn isn't orphaned.
async function _orphanedDebitRolledBackOnMintFailure() {
  var h = _makeQuery();
  var loy = bShop.loyalty.create({ query: h.query });
  var throwingCoupons = {
    issueSingleUseFromReward: async function () { throw new Error("coupon mint failed"); },
  };
  var lr = loyaltyRedemption.create({ query: h.query, loyalty: loy, coupons: throwingCoupons });

  await lr.defineReward({
    slug: "mint-fail", kind: "free_shipping", title: "Mint fail",
    point_cost: 250, value_json: {}, active: true,
  });
  var cid = _uuid();
  await loy.earn({ customer_id: cid, points: 1000, source: "order-paid" });

  var threw = false;
  try { await lr.redeemForCustomer({ customer_id: cid, reward_slug: "mint-fail" }); }
  catch (_e) { threw = true; }
  check("orphan-debit: mint failure propagates",          threw);
  check("orphan-debit: points fully restored",            (await loy.balance(cid)).balance === 1000);
  var rows = h.db.prepare("SELECT COUNT(*) AS n FROM loyalty_redemptions WHERE customer_id = ?").all(cid);
  check("orphan-debit: no redemption row left behind",    Number(rows[0].n) === 0);
}

async function run() {
  await _defineRewardRefusals();
  await _redeemHappyAndInsufficient();
  await _maxPerCustomerCap();
  await _capEnforcedAtomicallyDespiteStalePrecheck();
  await _orphanedDebitRolledBackOnMintFailure();
  await _markConsumedFsm();
  await _cancelRefundsOnlyActive();
  await _cancelDoesNotInflateLifetime();
  await _updateAndArchiveReward();
  await _listAndPaginate();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - loyalty-redemption (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
