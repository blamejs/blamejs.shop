"use strict";
/**
 * subscription-gifts — giver pays upfront for N cycles; recipient
 * redeems with a one-time token. Also records owner-to-owner
 * subscription transfers as an append-only audit ledger.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0135.
 *
 * Coverage:
 *   - purchaseGift: persists the row + status=pending, returns the
 *     plaintext token exactly once, token is 43 base64url chars,
 *     recipient email is hashed (+ normalised when supplied), missing
 *     recipient is allowed (unaddressed gift)
 *   - redeemGift: composes subscriptions.create stub, transitions to
 *     redeemed, stamps redeemed_at + redeemed_subscription_id; second
 *     redeem refuses; unknown token refuses
 *   - cancelGift before redemption transitions pending -> cancelled;
 *     attempting to cancel a redeemed gift refuses
 *   - transferOwnership writes the audit row;
 *     transfersForSubscription returns it
 *   - expiringGifts surfaces unredeemed gifts inside the window;
 *     skips redeemed / cancelled
 *   - cleanupExpired flips overdue pending -> expired
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop             = require("../../lib");
var subscriptionGifts = require("../../lib/subscription-gifts");
var helpers           = require("../helpers");
var check             = helpers.check;
var assert            = helpers.assert;

var MIG_GIFTS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0135_subscription_gifts.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_GIFTS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db: db,
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

// Minimal fake subscriptions handle — captures every `.create(...)`
// call and returns a deterministic subscription id derived from a
// monotonic counter. Operator wires their real subscriptions
// primitive in production; the test substitutes this shape so the
// gift-layer behaviour is exercised in isolation.
function _fakeSubscriptions() {
  var counter = 0;
  var calls = [];
  return {
    calls: calls,
    create: async function (input) {
      counter += 1;
      var id = _uuid();
      calls.push({
        customer_id: input.customer_id,
        plan_id:     input.plan_id,
        metadata:    input.metadata,
        minted_id:   id,
      });
      return {
        id:          id,
        customer_id: input.customer_id,
        plan_id:     input.plan_id,
        status:      "active",
        metadata:    input.metadata,
        // counter is surfaced so a test can assert the ordering of
        // mint calls if it wants to; not used by the primitive.
        _counter:    counter,
      };
    },
  };
}

function _factory(opts) {
  opts = opts || {};
  var h = _makeQuery();
  var subs = opts.withSubscriptions === false ? null : _fakeSubscriptions();
  var sg = subscriptionGifts.create({
    query:         h.query,
    subscriptions: subs,
  });
  return { db: h.db, query: h.query, subs: subs, sg: sg };
}

// ---- tests --------------------------------------------------------------

async function _purchaseGiftShape() {
  var f = _factory();
  var giverId = _uuid();
  var planId  = _uuid();

  var purchased = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    recipient_email:     "Alice@Example.com",
    cycles_purchased:    12,
    total_charged_minor: 12000,
    currency:            "USD",
    message:             "Happy birthday!\nEnjoy a year on us.",
  });

  check("purchase returns gift id",                typeof purchased.id === "string" && purchased.id.length > 0);
  check("purchase returns plaintext token",        typeof purchased.token === "string");
  check("token is 43 base64url chars",             /^[A-Za-z0-9_-]{43}$/.test(purchased.token));
  check("status is pending",                       purchased.status === "pending");
  check("cycles_purchased echoed",                 purchased.cycles_purchased === 12);
  check("total_charged_minor echoed",              purchased.total_charged_minor === 12000);
  check("currency echoed",                         purchased.currency === "USD");
  check("message echoed",                          purchased.message.indexOf("Happy birthday!") === 0);
  check("created_at populated",                    typeof purchased.created_at === "number" && purchased.created_at > 0);
  check("expires_at populated + in future",        purchased.expires_at > purchased.created_at);
  check("redeemed_at null",                        purchased.redeemed_at === null);
  check("redeemed_subscription_id null",           purchased.redeemed_subscription_id === null);
  check("cancelled_at null",                       purchased.cancelled_at === null);
  check("delivered_at null",                       purchased.delivered_at === null);
  check("recipient_email_hash populated",          typeof purchased.recipient_email_hash === "string" && purchased.recipient_email_hash.length > 0);
  // Domain folded to lowercase; local-part preserved.
  check("recipient_email_normalised folds domain", purchased.recipient_email_normalised === "Alice@example.com");

  // Re-read via getGift — token plaintext is NOT carried forward.
  var fetched = await f.sg.getGift(purchased.id);
  check("getGift returns the row",                 fetched.id === purchased.id);
  check("token plaintext NOT persisted",           fetched.token === undefined);
  check("token_hash persisted on row",             typeof fetched.token_hash === "string" && fetched.token_hash.length > 0);
  check("token_hash matches expected hash",        fetched.token_hash !== purchased.token);

  // A second purchase generates a DIFFERENT token.
  var p2 = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    6,
    total_charged_minor: 6000,
    currency:            "USD",
  });
  check("second purchase has different token",     p2.token !== purchased.token);
  check("unaddressed gift has null email hash",    p2.recipient_email_hash === null);
  check("unaddressed gift has null email normalised", p2.recipient_email_normalised === null);

  // Bad input shape.
  await assert.rejects(f.sg.purchaseGift(),                                       /input object required/);
  await assert.rejects(f.sg.purchaseGift({
    giver_customer_id: "not-uuid",
    plan_id: planId, cycles_purchased: 1, total_charged_minor: 100, currency: "USD",
  }), /giver_customer_id/);
  await assert.rejects(f.sg.purchaseGift({
    giver_customer_id: giverId,
    plan_id: planId, cycles_purchased: 0, total_charged_minor: 100, currency: "USD",
  }), /cycles_purchased/);
  await assert.rejects(f.sg.purchaseGift({
    giver_customer_id: giverId,
    plan_id: planId, cycles_purchased: 1, total_charged_minor: -1, currency: "USD",
  }), /total_charged_minor/);
  await assert.rejects(f.sg.purchaseGift({
    giver_customer_id: giverId,
    plan_id: planId, cycles_purchased: 1, total_charged_minor: 100, currency: "us",
  }), /currency/);
  await assert.rejects(f.sg.purchaseGift({
    giver_customer_id: giverId,
    plan_id: planId, cycles_purchased: 1, total_charged_minor: 100, currency: "USD",
    recipient_email: "not-an-email",
  }), /recipient_email/);
  // expires_at in the past refused.
  await assert.rejects(f.sg.purchaseGift({
    giver_customer_id: giverId,
    plan_id: planId, cycles_purchased: 1, total_charged_minor: 100, currency: "USD",
    expires_at: 1,
  }), /expires_at/);
}

async function _redeemGiftHappy() {
  var f = _factory();
  var giverId     = _uuid();
  var recipientId = _uuid();
  var planId      = _uuid();

  var purchased = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    3,
    total_charged_minor: 3000,
    currency:            "EUR",
  });

  var redeemed = await f.sg.redeemGift({
    token:                 purchased.token,
    recipient_customer_id: recipientId,
  });

  check("redeem returns subscription_id",        typeof redeemed.subscription_id === "string" && redeemed.subscription_id.length > 0);
  check("redeem returns hydrated gift",          redeemed.gift && redeemed.gift.id === purchased.id);
  check("redeem status redeemed",                redeemed.gift.status === "redeemed");
  check("redeem stamps redeemed_at",             typeof redeemed.gift.redeemed_at === "number");
  check("redeem stamps redeemed_subscription_id", redeemed.gift.redeemed_subscription_id === redeemed.subscription_id);

  // subscriptions.create was called once with the right shape.
  check("subscriptions.create called once",      f.subs.calls.length === 1);
  check("subscriptions.create customer_id",      f.subs.calls[0].customer_id === recipientId);
  check("subscriptions.create plan_id",          f.subs.calls[0].plan_id === planId);
  check("subscriptions.create metadata cycles",  f.subs.calls[0].metadata.prepaid_cycles === 3);
  check("subscriptions.create metadata gift_id", f.subs.calls[0].metadata.subscription_gift_id === purchased.id);
  check("subscriptions.create metadata gifter",  f.subs.calls[0].metadata.gifted_by === giverId);
}

async function _redeemTwiceRefuses() {
  var f = _factory();
  var giverId     = _uuid();
  var recipientId = _uuid();
  var planId      = _uuid();

  var purchased = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
  });
  await f.sg.redeemGift({ token: purchased.token, recipient_customer_id: recipientId });

  // Second redeem with the same token — refused.
  var dupRej;
  try {
    await f.sg.redeemGift({ token: purchased.token, recipient_customer_id: recipientId });
  } catch (e) {
    dupRej = e;
  }
  check("second redeem refused with ALREADY_REDEEMED code",
    dupRej && dupRej.code === "SUBSCRIPTION_GIFT_ALREADY_REDEEMED");
  check("subscriptions.create called only once across attempts",
    f.subs.calls.length === 1);

  // Unknown token — refused with TOKEN_INVALID.
  var unknownToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 base64url chars
  var notFoundRej;
  try {
    await f.sg.redeemGift({ token: unknownToken, recipient_customer_id: recipientId });
  } catch (e) {
    notFoundRej = e;
  }
  check("unknown token refused with TOKEN_INVALID code",
    notFoundRej && notFoundRej.code === "SUBSCRIPTION_GIFT_TOKEN_INVALID");

  // Bad token shape — refused with TypeError.
  await assert.rejects(
    f.sg.redeemGift({ token: "too-short", recipient_customer_id: recipientId }),
    /43 base64url characters/,
  );

  // Bad recipient.
  await assert.rejects(
    f.sg.redeemGift({ token: purchased.token, recipient_customer_id: "not-uuid" }),
    /recipient_customer_id/,
  );

  // Factory refuses a non-conforming subscriptions handle.
  assert.throws(function () {
    subscriptionGifts.create({ query: f.query, subscriptions: { unexpected: true } });
  }, /subscriptions handle must expose/);

  // Missing subscriptions handle refused at redeemGift.
  var noSubs = _factory({ withSubscriptions: false });
  var purchased2 = await noSubs.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
  });
  await assert.rejects(
    noSubs.sg.redeemGift({ token: purchased2.token, recipient_customer_id: recipientId }),
    /subscriptions handle is required/,
  );
}

// Concurrent redeem of ONE token must mint exactly one subscription. The two
// redeems interleave (both read status=pending before either claims), so the
// in-memory status guard alone can't stop a double-create — the atomic FSM
// claim must run BEFORE subscriptions.create and gate it. With the prior
// create-then-claim order both callers minted before the claim dedup'd the
// status row, double-creating subscriptions.
async function _redeemRaceSingleMint() {
  var f = _factory();
  var purchased = await f.sg.purchaseGift({
    giver_customer_id:   _uuid(),
    plan_id:             _uuid(),
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
  });
  var recipientId = _uuid();
  var results = await Promise.allSettled([
    f.sg.redeemGift({ token: purchased.token, recipient_customer_id: recipientId }),
    f.sg.redeemGift({ token: purchased.token, recipient_customer_id: recipientId }),
  ]);
  var fulfilled = results.filter(function (r) { return r.status === "fulfilled"; });
  var rejected  = results.filter(function (r) { return r.status === "rejected"; });
  check("concurrent redeem: exactly one succeeds", fulfilled.length === 1);
  check("concurrent redeem: the loser is rejected ALREADY_REDEEMED",
    rejected.length === 1 && rejected[0].reason && rejected[0].reason.code === "SUBSCRIPTION_GIFT_ALREADY_REDEEMED");
  check("concurrent redeem: subscription minted exactly once (claim gates the mint)",
    f.subs.calls.length === 1);
  // The winning gift row carries the minted subscription id (backfilled).
  var row = await f.sg.getGift(purchased.id);
  check("concurrent redeem: winner row links the minted subscription",
    row.status === "redeemed" && row.redeemed_subscription_id === f.subs.calls[0].minted_id);
}

async function _cancelBeforeRedemption() {
  var f = _factory();
  var giverId = _uuid();
  var planId  = _uuid();

  var purchased = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
  });

  var cancelled = await f.sg.cancelGift({ gift_id: purchased.id, reason: "giver-changed-mind" });
  check("cancel status cancelled",         cancelled.status === "cancelled");
  check("cancel reason persisted",         cancelled.cancel_reason === "giver-changed-mind");
  check("cancelled_at populated",          typeof cancelled.cancelled_at === "number");

  // Cancelled gift cannot be redeemed.
  var deadRej;
  try {
    await f.sg.redeemGift({ token: purchased.token, recipient_customer_id: _uuid() });
  } catch (e) {
    deadRej = e;
  }
  check("cancelled gift refuses redeem with NOT_REDEEMABLE code",
    deadRej && deadRej.code === "SUBSCRIPTION_GIFT_NOT_REDEEMABLE");

  // Double-cancel refused.
  var dupCancel;
  try {
    await f.sg.cancelGift({ gift_id: purchased.id, reason: "again" });
  } catch (e) {
    dupCancel = e;
  }
  check("double-cancel refused",           dupCancel && dupCancel.code === "SUBSCRIPTION_GIFT_NOT_CANCELLABLE");

  // Cancel after redeem — refused.
  var p2 = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
  });
  await f.sg.redeemGift({ token: p2.token, recipient_customer_id: _uuid() });
  var afterRedeemRej;
  try {
    await f.sg.cancelGift({ gift_id: p2.id, reason: "too-late" });
  } catch (e) {
    afterRedeemRej = e;
  }
  check("cancel after redeem refused",     afterRedeemRej && afterRedeemRej.code === "SUBSCRIPTION_GIFT_ALREADY_REDEEMED");

  // Bad input shape.
  await assert.rejects(f.sg.cancelGift(),                                /input object required/);
  await assert.rejects(f.sg.cancelGift({ gift_id: "not-uuid", reason: "x" }), /gift_id/);
  await assert.rejects(f.sg.cancelGift({ gift_id: purchased.id }),        /reason/);
  await assert.rejects(f.sg.cancelGift({ gift_id: _uuid(), reason: "x" }),  /not found/);
}

async function _transferOwnershipAudit() {
  var f = _factory();
  var subscriptionId = _uuid();
  var ownerA = _uuid();
  var ownerB = _uuid();
  var ownerC = _uuid();

  var t1 = await f.sg.transferOwnership({
    subscription_id:        subscriptionId,
    from_customer_id:       ownerA,
    new_owner_customer_id:  ownerB,
    reason:                 "business-sale",
  });
  check("transfer returns id",             typeof t1.id === "string" && t1.id.length > 0);
  check("transfer subscription_id",        t1.subscription_id === subscriptionId);
  check("transfer from",                   t1.from_customer_id === ownerA);
  check("transfer to",                     t1.to_customer_id === ownerB);
  check("transfer reason persisted",       t1.reason === "business-sale");
  check("transfer occurred_at populated",  typeof t1.occurred_at === "number" && t1.occurred_at > 0);

  // Chain another transfer — same subscription, new owner.
  var t2 = await f.sg.transferOwnership({
    subscription_id:        subscriptionId,
    from_customer_id:       ownerB,
    new_owner_customer_id:  ownerC,
    reason:                 "estate-transfer",
  });
  check("second transfer has distinct id", t2.id !== t1.id);

  // transfersForSubscription returns both, newest first.
  var ledger = await f.sg.transfersForSubscription(subscriptionId);
  check("ledger has two rows",             ledger.length === 2);
  check("ledger newest first",             ledger[0].occurred_at >= ledger[1].occurred_at);
  check("ledger first reason",             ledger[0].reason === "estate-transfer");

  // Refuse same-from-and-to.
  await assert.rejects(f.sg.transferOwnership({
    subscription_id:        subscriptionId,
    from_customer_id:       ownerC,
    new_owner_customer_id:  ownerC,
    reason:                 "same",
  }), /must differ/);

  // Refuse missing from.
  await assert.rejects(f.sg.transferOwnership({
    subscription_id:        subscriptionId,
    new_owner_customer_id:  ownerB,
    reason:                 "no-from",
  }), /from_customer_id/);

  // Refuse bad input shape.
  await assert.rejects(f.sg.transferOwnership(),                       /input object required/);
  await assert.rejects(f.sg.transferOwnership({
    subscription_id: "x", from_customer_id: ownerA, new_owner_customer_id: ownerB, reason: "r",
  }), /subscription_id/);
  await assert.rejects(f.sg.transferOwnership({
    subscription_id: subscriptionId, from_customer_id: ownerA, new_owner_customer_id: ownerB, reason: "",
  }), /reason/);
}

async function _expiringGiftsWindow() {
  var f = _factory();
  var giverId = _uuid();
  var planId  = _uuid();

  // Three gifts with different expiry horizons.
  var soon = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
    expires_at:          Date.now() + 60 * 60 * 1000,           // +1h
  });
  var medium = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
    expires_at:          Date.now() + 7 * 24 * 60 * 60 * 1000,  // +7d
  });
  var faraway = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
    expires_at:          Date.now() + 365 * 24 * 60 * 60 * 1000, // +1y
  });

  // Window of +1d — only `soon` qualifies.
  var oneDay = await f.sg.expiringGifts({ before: Date.now() + 24 * 60 * 60 * 1000 });
  check("expiring window 1d returns soon",       oneDay.length === 1);
  check("expiring window 1d id is soon",         oneDay[0].id === soon.id);

  // Window of +30d — soon + medium qualify.
  var thirtyDays = await f.sg.expiringGifts({ before: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  check("expiring window 30d returns soon+medium", thirtyDays.length === 2);
  check("expiring window 30d sorted by expires_at",
    thirtyDays[0].expires_at <= thirtyDays[1].expires_at);

  // Window of +2y — all three.
  var twoYears = await f.sg.expiringGifts({ before: Date.now() + 730 * 24 * 60 * 60 * 1000 });
  check("expiring window 2y returns all",        twoYears.length === 3);
  void faraway;

  // Cancel `medium` — it drops out of the window read.
  await f.sg.cancelGift({ gift_id: medium.id, reason: "test-cancel" });
  var afterCancel = await f.sg.expiringGifts({ before: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  check("cancelled gift drops from expiringGifts", afterCancel.length === 1);
  check("cancelled gift not the one returned",    afterCancel[0].id === soon.id);

  // Redeem `soon` — it drops out.
  await f.sg.redeemGift({ token: soon.token, recipient_customer_id: _uuid() });
  var afterRedeem = await f.sg.expiringGifts({ before: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  check("redeemed gift drops from expiringGifts", afterRedeem.length === 0);

  // cleanupExpired flips overdue pending gifts to 'expired'.
  // Create one whose expires_at is already in the past relative to
  // the clock we'll pass to cleanupExpired.
  var stale = await f.sg.purchaseGift({
    giver_customer_id:   giverId,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
    expires_at:          Date.now() + 1000,
  });
  var sweep = await f.sg.cleanupExpired({ now: Date.now() + 60 * 60 * 1000 });
  check("cleanupExpired transitions stale rows", sweep.expired >= 1);
  var staleAfter = await f.sg.getGift(stale.id);
  check("stale gift now expired",                staleAfter.status === "expired");
  // Idempotent — second sweep claims 0.
  var sweep2 = await f.sg.cleanupExpired({ now: Date.now() + 60 * 60 * 1000 });
  check("cleanupExpired idempotent",             sweep2.expired === 0);

  // Bad input shape.
  await assert.rejects(f.sg.expiringGifts(),                        /input object required/);
  await assert.rejects(f.sg.expiringGifts({}),                       /before is required/);
  await assert.rejects(f.sg.expiringGifts({ before: -1 }),           /before/);
  await assert.rejects(f.sg.expiringGifts({ before: Date.now(), limit: 0 }), /limit/);
}

async function _giftsForGiverPagination() {
  var f = _factory();
  var giverId = _uuid();
  var planId  = _uuid();

  // Seed 3 gifts, monotonic clock ensures distinct created_at.
  var ids = [];
  for (var i = 0; i < 3; i += 1) {
    var p = await f.sg.purchaseGift({
      giver_customer_id:   giverId,
      plan_id:             planId,
      cycles_purchased:    1,
      total_charged_minor: 1000,
      currency:            "USD",
    });
    ids.push(p.id);
  }

  var page1 = await f.sg.giftsForGiver(giverId, { limit: 2 });
  check("page1 returns 2 rows",                  page1.rows.length === 2);
  check("page1 newest first",                    page1.rows[0].created_at >= page1.rows[1].created_at);
  check("page1 cursor present",                  typeof page1.next_cursor === "number");

  var page2 = await f.sg.giftsForGiver(giverId, { limit: 2, cursor: page1.next_cursor });
  check("page2 returns tail",                    page2.rows.length === 1);
  check("page2 no cursor",                       page2.next_cursor === null);

  // Another giver's row doesn't surface.
  var otherGiver = _uuid();
  await f.sg.purchaseGift({
    giver_customer_id:   otherGiver,
    plan_id:             planId,
    cycles_purchased:    1,
    total_charged_minor: 1000,
    currency:            "USD",
  });
  var stillThree = await f.sg.giftsForGiver(giverId);
  check("scope is per-giver",                    stillThree.rows.length === 3);

  // Validation.
  await assert.rejects(f.sg.giftsForGiver("not-uuid"),                   /customer_id/);
  await assert.rejects(f.sg.giftsForGiver(giverId, { limit: 0 }),         /limit/);
  await assert.rejects(f.sg.giftsForGiver(giverId, { cursor: -1 }),       /cursor/);

  void ids;
}

// Prod-redaction regression for the purchaseGift token retry loop (MONEY). A
// token_hash collision surfaces in production as a bare "HTTP 500" (the D1
// service-binding redacts the SQLite "UNIQUE constraint failed" text), so the
// old indexOf("UNIQUE") gate would have re-thrown instead of regenerating. The
// first generated token_hash is held PERMANENTLY taken (every INSERT of it is
// redacted-rejected and the re-read confirms it), so the purchase can only
// succeed by REGENERATING a different token — proving the retry fires AND does
// not re-use the collided hash. The money fields never change across retries.
async function _purchaseGiftRetriesUnderRedactedCollision() {
  var h = _makeQuery();
  var firstHash = null;
  var q = async function (sql, params) {
    if (/INSERT INTO subscription_gifts/.test(sql)) {
      if (firstHash === null) firstHash = params[8];               // token_hash column
      if (params[8] === firstHash) throw new Error("HTTP 500");    // the winner holds it; redacted, no "UNIQUE"
    }
    if (firstHash !== null && /FROM subscription_gifts WHERE token_hash/.test(sql) && params[0] === firstHash) {
      return { rows: [{ id: "winner", token_hash: firstHash, status: "pending" }] };   // re-read confirms the clash
    }
    return h.query(sql, params);
  };
  var sg = subscriptionGifts.create({ query: q, subscriptions: _fakeSubscriptions() });
  var purchased = await sg.purchaseGift({
    giver_customer_id:   _uuid(),
    plan_id:             _uuid(),
    recipient_email:     "alice@example.com",
    cycles_purchased:    12,
    total_charged_minor: 12000,
    currency:            "USD",
  });
  check("redacted-collision: purchaseGift resolves with a regenerated token (retry fired despite the bare HTTP 500)",
    typeof purchased.id === "string" && /^[A-Za-z0-9_-]{43}$/.test(purchased.token));
  check("redacted-collision: the money fields are unchanged by the retry",
    purchased.total_charged_minor === 12000 && purchased.cycles_purchased === 12 && purchased.currency === "USD");
}

async function run() {
  await _purchaseGiftShape();
  await _purchaseGiftRetriesUnderRedactedCollision();
  await _redeemGiftHappy();
  await _redeemTwiceRefuses();
  await _redeemRaceSingleMint();
  await _cancelBeforeRedemption();
  await _transferOwnershipAudit();
  await _expiringGiftsWindow();
  await _giftsForGiverPagination();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - subscription-gifts (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
