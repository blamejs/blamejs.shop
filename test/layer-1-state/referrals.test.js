"use strict";
/**
 * referrals — refer-a-friend with two-sided rewards.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0025.
 * Confirms the code-generation surface (8-char uppercase, draw from
 * the confusion-resistant alphabet), the one-active-code-per-referrer
 * invariant, the invitation funnel transitions (invite -> visit ->
 * signup -> purchase), the reward FSM (pending -> referrer-rewarded
 * -> both-rewarded), the case-insensitive lookup, the referrer
 * stats aggregator, and the leaderboard sort.
 *
 * Coverage:
 *   - issueCode: returns {id, code, link}; one active code per customer
 *   - issueCode: stored uppercase, format matches alphabet
 *   - invite: refuses unknown codes; idempotent on (code, email_hash)
 *   - invite: stores email_hash, never the plaintext address
 *   - trackVisit/trackSignup/trackPurchase: funnel transitions
 *   - rewardReferrer/rewardReferee: FSM transitions, terminal refusal
 *   - byCode: case-insensitive lookup, hyphens-stripped lookup
 *   - statsForReferrer: aggregate counts across the funnel
 *   - leaderboard: ORDER BY completed_referrals DESC, LIMIT cap
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_REFERRALS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0025_referrals.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // FK enforcement on — the migration declares a FK from invitations
  // to codes. The test inserts via the primitive (which always
  // resolves the code row first), so every FK reference is real.
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_REFERRALS, "utf8")).forEach(function (s) {
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

var ALPHABET_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;

async function _issueCode() {
  var refs = bShop.referrals.create({ query: _makeQuery() });
  var referrerId = bShop.framework.uuid.v7();
  var c = await refs.issueCode({ referrer_customer_id: referrerId });
  check("issueCode returns uuid",       typeof c.id === "string" && c.id.length === 36);
  check("issueCode code length",        c.code.length === 8);
  check("issueCode uppercase",          c.code === c.code.toUpperCase());
  check("issueCode alphabet",           ALPHABET_RE.test(c.code));
  check("issueCode link prefix",        c.link.indexOf("https://blamejs.shop/?ref=") === 0);
  check("issueCode link contains code", c.link.indexOf(c.code) !== -1);

  // Second issuance for the same customer is refused.
  await assert.rejects(
    refs.issueCode({ referrer_customer_id: referrerId }),
    /already has an active code/i,
  );

  // A different customer can issue.
  var other = bShop.framework.uuid.v7();
  var c2 = await refs.issueCode({ referrer_customer_id: other });
  check("issueCode independent per customer", c2.code !== c.code);

  // Rotation: disable + issue again works.
  var disabled = await refs.disableCode(c.id);
  check("disableCode flips status",     disabled && disabled.status === "disabled");
  var c3 = await refs.issueCode({ referrer_customer_id: referrerId });
  check("issueCode after disable works", c3.code !== c.code);
}

async function _issueCodeValidation() {
  var refs = bShop.referrals.create({ query: _makeQuery() });
  await assert.rejects(refs.issueCode(),                                                /input object required/);
  await assert.rejects(refs.issueCode({}),                                              /referrer_customer_id/);
  await assert.rejects(refs.issueCode({ referrer_customer_id: "not-a-uuid" }),          /referrer_customer_id/);

  // Custom alphabet rejected when not 32 / has lowercase / has dupes.
  assert.throws(
    function () { bShop.referrals.create({ query: _makeQuery(), codeAlphabet: "TOO-SHORT" }); },
    /32 characters/,
  );
  assert.throws(
    function () { bShop.referrals.create({ query: _makeQuery(), codeAlphabet: "abcdefghjklmnpqrstuvwxyz23456789" }); },
    /uppercase/,
  );
  assert.throws(
    function () { bShop.referrals.create({ query: _makeQuery(), codeAlphabet: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }); },
    /duplicate/,
  );
}

async function _inviteIdempotent() {
  var refs = bShop.referrals.create({ query: _makeQuery() });
  var referrer = bShop.framework.uuid.v7();
  var c = await refs.issueCode({ referrer_customer_id: referrer });

  var inv1 = await refs.invite({ code: c.code, referee_email: "friend@example.com" });
  check("invite first call returns new", inv1.status === "new");
  // No plaintext email leaks into the returned shape.
  check("invite no plaintext email",     JSON.stringify(inv1).indexOf("friend@example.com") === -1);
  check("invite stores email hash",      /^[0-9a-f]{128}$/.test(inv1.referred_email_hash));

  var inv2 = await refs.invite({ code: c.code, referee_email: "friend@example.com" });
  check("invite duplicate -> dedup",      inv2.status === "dedup");
  check("invite duplicate same row id",   inv2.id === inv1.id);

  // Case-fold on domain — same recipient, different casing.
  var inv3 = await refs.invite({ code: c.code, referee_email: "FRIEND@EXAMPLE.com" });
  check("invite case-fold dedups domain", inv3.id === inv1.id && inv3.status === "dedup");

  // Distinct address gets a new row.
  var inv4 = await refs.invite({ code: c.code, referee_email: "other@example.com" });
  check("invite distinct -> new row",     inv4.id !== inv1.id && inv4.status === "new");

  // Unknown code refused.
  await assert.rejects(
    refs.invite({ code: "ZZZZZZZZ", referee_email: "x@example.com" }),
    /not recognized/,
  );

  // Disabled code refused.
  await refs.disableCode(c.id);
  await assert.rejects(
    refs.invite({ code: c.code, referee_email: "late@example.com" }),
    /disabled/,
  );

  // Email validation runs through guardEmail (strict profile).
  var c2 = await refs.issueCode({ referrer_customer_id: bShop.framework.uuid.v7() });
  await assert.rejects(refs.invite({ code: c2.code, referee_email: "" }),               /referee_email/);
  await assert.rejects(refs.invite({ code: c2.code, referee_email: "no-at-sign" }),     /referee_email/);
  await assert.rejects(
    refs.invite({ code: c2.code, referee_email: "x@example.com\r\nBcc: evil@x" }),
    /referee_email/,
  );
}

async function _funnel() {
  var refs = bShop.referrals.create({ query: _makeQuery() });
  var referrer = bShop.framework.uuid.v7();
  var c = await refs.issueCode({ referrer_customer_id: referrer });
  var inv = await refs.invite({ code: c.code, referee_email: "alice@example.com" });

  // Visit.
  var v = await refs.trackVisit({ code: c.code });
  check("trackVisit updates pending row", v.updated === 1);

  // Second visit doesn't overwrite the populated timestamp.
  var v2 = await refs.trackVisit({ code: c.code });
  check("trackVisit idempotent",          v2.updated === 0);

  // Signup.
  var newCustomer = bShop.framework.uuid.v7();
  var su = await refs.trackSignup({ code: c.code, customer_id: newCustomer });
  check("trackSignup pins customer",       su && su.signed_up_customer_id === newCustomer);
  check("trackSignup matches invitation",  su.id === inv.id);
  check("trackSignup reward_status pending", su.reward_status === "pending");

  // Signup with no pending invitation returns null (organic
  // arrival — the friend signed up but wasn't on the pending list).
  var c2 = await refs.issueCode({ referrer_customer_id: bShop.framework.uuid.v7() });
  var organic = await refs.trackSignup({ code: c2.code, customer_id: bShop.framework.uuid.v7() });
  check("trackSignup no pending -> null", organic === null);

  // Purchase.
  var orderId = bShop.framework.uuid.v7();
  var pur = await refs.trackPurchase({ customer_id: newCustomer, order_id: orderId });
  check("trackPurchase transitions FSM",   pur && pur.reward_status === "both-rewarded");
  check("trackPurchase pins order",        pur.first_order_id === orderId);
  check("trackPurchase marks completed",   pur.status === "completed");

  // referrals_count bumped on the code row.
  var refreshed = await refs.byCode(c.code);
  check("byCode reflects count bump",      Number(refreshed.referrals_count) === 1);

  // Second purchase is a no-op for the funnel.
  var dup = await refs.trackPurchase({
    customer_id: newCustomer,
    order_id:    bShop.framework.uuid.v7(),
  });
  check("trackPurchase idempotent",        dup.status === "already-recorded");
  var refreshed2 = await refs.byCode(c.code);
  check("count unchanged on second purchase", Number(refreshed2.referrals_count) === 1);

  // Purchase by unknown customer returns null (no invitation).
  var orphan = await refs.trackPurchase({
    customer_id: bShop.framework.uuid.v7(),
    order_id:    bShop.framework.uuid.v7(),
  });
  check("trackPurchase no invitation -> null", orphan === null);
}

async function _concurrentFunnel() {
  // Two concurrent trackPurchase calls for the same customer (a
  // double-submit or a re-delivered purchase webhook) must complete
  // the funnel exactly once — only one bumps referrals_count.
  var refs = bShop.referrals.create({ query: _makeQuery() });
  var referrer = bShop.framework.uuid.v7();
  var c = await refs.issueCode({ referrer_customer_id: referrer });
  await refs.invite({ code: c.code, referee_email: "race@example.com" });
  var cust = bShop.framework.uuid.v7();
  await refs.trackSignup({ code: c.code, customer_id: cust });

  var order = bShop.framework.uuid.v7();
  var results = await Promise.all([
    refs.trackPurchase({ customer_id: cust, order_id: order }),
    refs.trackPurchase({ customer_id: cust, order_id: order }),
  ]);
  var completed = results.filter(function (r) { return r && r.status === "completed"; });
  var recorded  = results.filter(function (r) { return r && r.status === "already-recorded"; });
  check("concurrent purchase one completes",        completed.length === 1);
  check("concurrent purchase loser already-recorded", recorded.length === 1);
  // The leaderboard counter — the money/integrity-relevant field — is
  // bumped exactly once despite both calls passing the null check.
  var after = await refs.byCode(c.code);
  check("concurrent purchase counts once",          Number(after.referrals_count) === 1);

  // Two different customers signing up concurrently can't both claim
  // the same oldest pending invitation — each lands on a distinct row.
  var refs2 = bShop.referrals.create({ query: _makeQuery() });
  var ref2  = bShop.framework.uuid.v7();
  var c2    = await refs2.issueCode({ referrer_customer_id: ref2 });
  await refs2.invite({ code: c2.code, referee_email: "s1@example.com" });
  await refs2.invite({ code: c2.code, referee_email: "s2@example.com" });
  var custA = bShop.framework.uuid.v7();
  var custB = bShop.framework.uuid.v7();
  var signups = await Promise.all([
    refs2.trackSignup({ code: c2.code, customer_id: custA }),
    refs2.trackSignup({ code: c2.code, customer_id: custB }),
  ]);
  check("concurrent signup both pinned",            signups[0] && signups[1]);
  check("concurrent signup distinct invitations",   signups[0].id !== signups[1].id);
  check("concurrent signup distinct customers",
    signups[0].signed_up_customer_id !== signups[1].signed_up_customer_id);

  // A double-submit signup by the SAME customer is a no-op (returns null)
  // and does NOT consume a second pending invitation — the friend stays
  // pinned to exactly one invitation.
  var custC = bShop.framework.uuid.v7();
  var refs3 = bShop.referrals.create({ query: _makeQuery() });
  var ref3  = bShop.framework.uuid.v7();
  var c3    = await refs3.issueCode({ referrer_customer_id: ref3 });
  await refs3.invite({ code: c3.code, referee_email: "d1@example.com" });
  await refs3.invite({ code: c3.code, referee_email: "d2@example.com" });
  var first  = await refs3.trackSignup({ code: c3.code, customer_id: custC });
  var second = await refs3.trackSignup({ code: c3.code, customer_id: custC });
  check("signup double-submit is a no-op (null)",   second === null);
  check("double-submit kept the friend pinned once", first && first.signed_up_customer_id === custC);
}

async function _rewards() {
  var refs = bShop.referrals.create({ query: _makeQuery() });
  var referrer = bShop.framework.uuid.v7();
  var c = await refs.issueCode({ referrer_customer_id: referrer });
  var inv = await refs.invite({ code: c.code, referee_email: "rewardee@example.com" });

  // Reward the referrer first — FSM advances to "referrer-rewarded".
  var r1 = await refs.rewardReferrer(inv.id, { reward_id: "giftcard-1" });
  check("rewardReferrer pins reward_id",     r1.referrer_reward_id === "giftcard-1");
  check("rewardReferrer status transition",  r1.reward_status === "referrer-rewarded");

  // Reward the referee — FSM advances to "both-rewarded".
  var r2 = await refs.rewardReferee(inv.id, { reward_id: "giftcard-2" });
  check("rewardReferee pins reward_id",      r2.referee_reward_id === "giftcard-2");
  check("rewardReferee status to both",      r2.reward_status === "both-rewarded");

  // Validation.
  await assert.rejects(refs.rewardReferrer(inv.id),                                 /reward_id/);
  await assert.rejects(refs.rewardReferrer(inv.id, {}),                              /reward_id/);
  await assert.rejects(refs.rewardReferrer(inv.id, { reward_id: "" }),               /reward_id/);
  await assert.rejects(refs.rewardReferrer("not-a-uuid", { reward_id: "x" }),        /invitation_id/);
  await assert.rejects(refs.rewardReferee(inv.id, {}),                               /reward_id/);

  // Unknown invitation -> null (not a throw — symmetric with byCode).
  var nullReferrer = await refs.rewardReferrer(bShop.framework.uuid.v7(), { reward_id: "x" });
  check("rewardReferrer unknown -> null",     nullReferrer === null);
  var nullReferee = await refs.rewardReferee(bShop.framework.uuid.v7(), { reward_id: "x" });
  check("rewardReferee unknown -> null",      nullReferee === null);

  // Referee-first ordering: pay the referee before the referrer.
  // Status should not advance past "pending" until the referrer is
  // also paid (operator's outstanding-referrer-payouts queue stays
  // visible).
  var refs2 = bShop.referrals.create({ query: _makeQuery() });
  var ref2  = bShop.framework.uuid.v7();
  var c2    = await refs2.issueCode({ referrer_customer_id: ref2 });
  var inv2  = await refs2.invite({ code: c2.code, referee_email: "early@example.com" });
  var early = await refs2.rewardReferee(inv2.id, { reward_id: "gc-early" });
  check("rewardReferee-first stays pending",  early.reward_status === "pending");
  check("rewardReferee-first records id",      early.referee_reward_id === "gc-early");
  var late = await refs2.rewardReferrer(inv2.id, { reward_id: "gc-late" });
  check("rewardReferrer after referee both",   late.reward_status === "both-rewarded");
}

async function _byCodeCaseInsensitive() {
  var refs = bShop.referrals.create({ query: _makeQuery() });
  var referrer = bShop.framework.uuid.v7();
  var c = await refs.issueCode({ referrer_customer_id: referrer });

  var upper = await refs.byCode(c.code);
  check("byCode upper hits",       upper && upper.code === c.code);

  var lower = await refs.byCode(c.code.toLowerCase());
  check("byCode lowercase hits",   lower && lower.id === upper.id);

  // Hyphens + whitespace stripped before lookup.
  var spaced = c.code.slice(0, 4) + "-" + c.code.slice(4, 8);
  var spacedHit = await refs.byCode(spaced);
  check("byCode strips hyphens",   spacedHit && spacedHit.id === upper.id);
  var whitespace = " " + c.code + "  ";
  var wsHit = await refs.byCode(whitespace);
  check("byCode strips whitespace", wsHit && wsHit.id === upper.id);

  var miss = await refs.byCode("ZZZZZZZZ");
  check("byCode miss -> null",     miss === null);

  // Bad shapes throw.
  await assert.rejects(refs.byCode(""),         /non-empty string/);
  await assert.rejects(refs.byCode("short"),     /8 alphabet/);
  await assert.rejects(refs.byCode("OOOOOOOO"),  /outside the referral alphabet/);
}

async function _statsForReferrer() {
  var refs = bShop.referrals.create({ query: _makeQuery() });
  var referrer = bShop.framework.uuid.v7();
  var c = await refs.issueCode({ referrer_customer_id: referrer });

  // Seed three invitations across the funnel.
  await refs.invite({ code: c.code, referee_email: "a@example.com" });
  await refs.invite({ code: c.code, referee_email: "b@example.com" });
  await refs.invite({ code: c.code, referee_email: "c@example.com" });

  // a@ visits + signs up + purchases.
  await refs.trackVisit({ code: c.code });
  var custA = bShop.framework.uuid.v7();
  await refs.trackSignup({ code: c.code, customer_id: custA });
  await refs.trackPurchase({
    customer_id: custA,
    order_id:    bShop.framework.uuid.v7(),
  });

  // b@ signs up but doesn't purchase.
  var custB = bShop.framework.uuid.v7();
  await refs.trackSignup({ code: c.code, customer_id: custB });

  var stats = await refs.statsForReferrer(referrer);
  check("stats invitations_total",     stats.invitations_total    === 3);
  check("stats invitations_visited",   stats.invitations_visited  === 3);
  check("stats invitations_signed_up", stats.invitations_signed_up === 2);
  check("stats invitations_purchased", stats.invitations_purchased === 1);
  check("stats completed_referrals",   stats.completed_referrals  === 1);
  check("stats codes array",            Array.isArray(stats.codes) && stats.codes.length === 1);

  // Empty referrer -> zeros.
  var empty = await refs.statsForReferrer(bShop.framework.uuid.v7());
  check("stats empty total",           empty.invitations_total === 0);
  check("stats empty completed",       empty.completed_referrals === 0);

  // Validation.
  await assert.rejects(refs.statsForReferrer("nope"), /customer_id/);
}

async function _leaderboard() {
  var refs = bShop.referrals.create({ query: _makeQuery() });

  // Three referrers; seed completed referrals at different counts.
  async function _seedRefs(referrerId, completedCount) {
    var c = await refs.issueCode({ referrer_customer_id: referrerId });
    for (var i = 0; i < completedCount; i += 1) {
      var email = "n" + i + "-" + referrerId.slice(0, 8) + "@example.com";
      await refs.invite({ code: c.code, referee_email: email });
      var cust = bShop.framework.uuid.v7();
      await refs.trackSignup({ code: c.code, customer_id: cust });
      await refs.trackPurchase({
        customer_id: cust,
        order_id:    bShop.framework.uuid.v7(),
      });
    }
  }

  var topId    = bShop.framework.uuid.v7();
  var midId    = bShop.framework.uuid.v7();
  var lowId    = bShop.framework.uuid.v7();
  var zeroId   = bShop.framework.uuid.v7();
  await _seedRefs(topId, 3);
  await _seedRefs(midId, 2);
  await _seedRefs(lowId, 1);
  // zeroId issues a code but never completes — should NOT appear.
  await refs.issueCode({ referrer_customer_id: zeroId });

  var board = await refs.leaderboard({ limit: 10 });
  check("leaderboard length excludes zero", board.length === 3);
  check("leaderboard top sorted",            board[0].referrer_customer_id === topId);
  check("leaderboard top count",             board[0].completed_referrals === 3);
  check("leaderboard mid",                    board[1].referrer_customer_id === midId);
  check("leaderboard low",                    board[2].referrer_customer_id === lowId);

  // Limit honored.
  var top2 = await refs.leaderboard({ limit: 2 });
  check("leaderboard limit 2",                top2.length === 2);

  // Default limit applies when unspecified.
  var defl = await refs.leaderboard();
  check("leaderboard default limit",          defl.length === 3);

  // Validation.
  await assert.rejects(refs.leaderboard({ limit: 0 }),    /limit/);
  await assert.rejects(refs.leaderboard({ limit: -1 }),   /limit/);
  await assert.rejects(refs.leaderboard({ limit: 1.5 }),  /limit/);
  await assert.rejects(refs.leaderboard({ limit: 101 }),  /limit/);
}

async function run() {
  await _issueCode();
  await _issueCodeValidation();
  await _inviteIdempotent();
  await _funnel();
  await _concurrentFunnel();
  await _rewards();
  await _byCodeCaseInsensitive();
  await _statsForReferrer();
  await _leaderboard();
}

module.exports = { run: run };
