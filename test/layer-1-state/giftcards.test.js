"use strict";
/**
 * giftcards — issue and redeem prepaid balance instruments.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0013_giftcards.sql. The plaintext code is returned ONCE on issue;
 * every subsequent read goes through the hash.
 *
 * Coverage:
 *   - issue: persists hash + hint, returns plaintext code exactly once
 *   - issue: code matches `XXXX-XXXX-XXXX-XXXX` (32-char alphabet)
 *   - issue: stored row holds no plaintext fragment beyond the 4-char hint
 *   - issue: accepts customer_id only, email only, both, or neither
 *   - issue: email hash collides on case-equivalent addresses
 *   - balance: round-trips, refuses tampered codes
 *   - lookup: returns null on no-match (no info leak)
 *   - redeem: full + partial decrement, transitions to redeemed on zero
 *   - redeem: expired + voided + insufficient + already-redeemed all refuse
 *   - redeem: writes a giftcard_redemptions ledger row per call
 *   - code-format tolerance: hyphens + lowercase + whitespace accepted
 *   - void: refuses if already redeemed; idempotent if already voided
 *   - listForCustomer: filters by status
 *   - validation: every entry point refuses bad input
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0013_giftcards.sql", "0214_giftcard_redemption_reversal.sql"].map(function (n) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n);
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

function _gcFactory() {
  var h = _makeQuery();
  return { db: h.db, gc: bShop.giftcards.create({ query: h.query }) };
}

var CODE_DISPLAY_RE  = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

async function _issueAndStoredShape() {
  var f = _gcFactory();
  var issued = await f.gc.issue({
    amount_minor: 5000,
    currency:     "USD",
  });
  check("issue returns uuid id",              typeof issued.id === "string" && issued.id.length === 36);
  check("issue returns formatted code",        CODE_DISPLAY_RE.test(issued.code));
  check("issue returns 4-char hint",           typeof issued.code_hint === "string" && issued.code_hint.length === 4);
  // Hint is last 4 of plaintext (with dashes stripped).
  var plainNoDashes = issued.code.replace(/-/g, "");
  check("hint is last-4 of plaintext",         issued.code_hint === plainNoDashes.slice(-4));

  // Inspect the stored row directly — the plaintext (beyond the hint)
  // MUST NOT be present anywhere.
  var rows = f.db.prepare("SELECT * FROM giftcards WHERE id = ?").all(issued.id);
  check("issue persists exactly one row",      rows.length === 1);
  var row = rows[0];
  check("stored row has hex code_hash",        /^[0-9a-f]{128}$/.test(row.code_hash));
  check("stored row hint matches",             row.code_hint === issued.code_hint);
  check("stored row currency",                  row.currency === "USD");
  check("stored balance == issued",            row.balance_minor === 5000 && row.issued_minor === 5000);
  check("stored status active",                row.status === "active");
  check("stored row has no plaintext prefix",  row.code_hash.indexOf(plainNoDashes.slice(0, 12)) === -1);
  // Hint alone (4 chars from 32-glyph alphabet) is too small to
  // recover the rest — but assert it doesn't appear MORE than once
  // in the stored row (it'd appear in `code_hint`; never in
  // `code_hash`).
  var hashHits = 0;
  // Hex hash is lowercase; the hint alphabet is uppercase letters
  // (excluding I/O) + 2-9, so they don't share glyphs — but check
  // anyway by uppercasing.
  if (row.code_hash.toUpperCase().indexOf(row.code_hint) !== -1) hashHits += 1;
  check("hint never appears inside the hash",  hashHits === 0);
}

async function _issueAddressing() {
  var f = _gcFactory();
  var custId = bShop.framework.uuid.v7();

  // Operator-only card (no recipient identity).
  var none = await f.gc.issue({ amount_minor: 100, currency: "USD" });
  var noneRow = f.db.prepare("SELECT * FROM giftcards WHERE id = ?").all(none.id)[0];
  check("issue accepts no recipient",          noneRow.issued_to_customer_id === null && noneRow.issued_to_email_hash === null);

  // Customer only.
  var custOnly = await f.gc.issue({ amount_minor: 100, currency: "USD", issued_to_customer_id: custId });
  var co = f.db.prepare("SELECT * FROM giftcards WHERE id = ?").all(custOnly.id)[0];
  check("issue persists customer id",          co.issued_to_customer_id === custId);

  // Email only.
  var emailOnly = await f.gc.issue({ amount_minor: 100, currency: "USD", issued_to_email: "alice@example.com" });
  var eo = f.db.prepare("SELECT * FROM giftcards WHERE id = ?").all(emailOnly.id)[0];
  check("issue persists email hash, not raw",  /^[0-9a-f]{128}$/.test(eo.issued_to_email_hash) && eo.issued_to_email_hash.indexOf("alice") === -1);

  // Both — recipient has an account AND a delivery address.
  var both = await f.gc.issue({
    amount_minor: 100, currency: "USD",
    issued_to_customer_id: custId,
    issued_to_email:       "Alice@Example.COM",
  });
  var b = f.db.prepare("SELECT * FROM giftcards WHERE id = ?").all(both.id)[0];
  check("issue persists both addressings",      b.issued_to_customer_id === custId && b.issued_to_email_hash !== null);
  // Case-fold collision: "Alice@Example.COM" hashes to the same as
  // "alice@example.com" because the primitive lowercases before
  // hashing.
  check("email hash case-folds",                b.issued_to_email_hash === eo.issued_to_email_hash);
}

async function _balanceAndLookup() {
  var f = _gcFactory();
  var issued = await f.gc.issue({ amount_minor: 2500, currency: "EUR" });
  var bal = await f.gc.balance(issued.code);
  check("balance returns full on fresh card",  bal && bal.balance_minor === 2500 && bal.currency === "EUR" && bal.status === "active");

  // Wrong code — null, no info leak about whether row exists.
  var bogus = "ZZZZZZZZZZZZZZZZ";
  var miss = await f.gc.balance(bogus);
  check("balance null on miss",                miss === null);
  var lookupMiss = await f.gc.lookup(bogus);
  check("lookup null on miss",                  lookupMiss === null);

  // Tampered hint match (last 4 chars same, rest random) — must
  // still miss. The hint is not a credential.
  var tampered = "AAAA" + "BBBB" + "CCCC" + issued.code.replace(/-/g, "").slice(-4);
  var tamperedMiss = await f.gc.balance(tampered);
  check("balance null on hint-matching forgery", tamperedMiss === null);
}

async function _codeFormatTolerance() {
  var f = _gcFactory();
  var issued = await f.gc.issue({ amount_minor: 100, currency: "USD" });
  var plain = issued.code.replace(/-/g, "");

  // Display form (with hyphens).
  var withDashes = await f.gc.balance(issued.code);
  check("hyphenated code resolves",            withDashes && withDashes.balance_minor === 100);

  // Bare plaintext.
  var bare = await f.gc.balance(plain);
  check("bare code resolves",                  bare && bare.balance_minor === 100);

  // Lowercase form — uppercase canonicalization should still match.
  var lower = await f.gc.balance(plain.toLowerCase());
  check("lowercase code resolves",             lower && lower.balance_minor === 100);

  // Pasted-with-newline.
  var pasted = await f.gc.balance(" " + issued.code + "\n");
  check("padded code resolves",                pasted && pasted.balance_minor === 100);
}

async function _redeemFullAndPartial() {
  var f = _gcFactory();
  var issued = await f.gc.issue({ amount_minor: 10000, currency: "USD" });
  var orderId = bShop.framework.uuid.v7();

  var first = await f.gc.redeem({ code: issued.code, order_id: orderId, amount_minor: 3000 });
  check("partial redeem returns remaining",     first.remaining_balance_minor === 7000);
  check("partial redeem returns redemption_id", typeof first.redemption_id === "string" && first.redemption_id.length === 36);

  // Ledger row landed.
  var ledger = f.db.prepare("SELECT * FROM giftcard_redemptions WHERE giftcard_id = ? ORDER BY redeemed_at").all(issued.id);
  check("ledger row written",                  ledger.length === 1 && ledger[0].amount_minor === 3000 && ledger[0].order_id === orderId);

  // Card still active.
  var midBal = await f.gc.balance(issued.code);
  check("status still active after partial",    midBal.status === "active" && midBal.balance_minor === 7000);

  // Full drain.
  var second = await f.gc.redeem({ code: issued.code, order_id: orderId, amount_minor: 7000 });
  check("full drain returns 0 remaining",        second.remaining_balance_minor === 0);
  var drained = await f.gc.balance(issued.code);
  check("drained card transitions to redeemed",  drained.status === "redeemed" && drained.balance_minor === 0);

  // Further redemption refused.
  await assert.rejects(
    f.gc.redeem({ code: issued.code, amount_minor: 1 }),
    /redeemed/i,
  );

  // Non-order redemption (manual adjustment) — order_id null.
  var unrelated = await f.gc.issue({ amount_minor: 500, currency: "USD" });
  var adj = await f.gc.redeem({ code: unrelated.code, amount_minor: 250 });
  check("non-order redeem allowed",             adj.remaining_balance_minor === 250);
  var adjRow = f.db.prepare("SELECT * FROM giftcard_redemptions WHERE giftcard_id = ?").all(unrelated.id)[0];
  check("non-order ledger row has null order",  adjRow.order_id === null);
}

// reverseRedemption credits a gift-card spend back when the order that
// redeemed it dies. The card-row balance is restored, a drained ('redeemed')
// card reactivates, and the reversal is idempotent (a re-fire credits back
// exactly once). This is what the order FSM calls on its cancel / refund edges.
async function _reverseRedemption() {
  var f = _gcFactory();
  var issued = await f.gc.issue({ amount_minor: 5000, currency: "USD" });
  var orderId = bShop.framework.uuid.v7();

  // Partial spend then reverse: balance returns to face value.
  await f.gc.redeem({ code: issued.code, order_id: orderId, amount_minor: 2000 });
  check("balance debited after redeem",          (await f.gc.balance(issued.code)).balance_minor === 3000);
  var reversed = await f.gc.reverseRedemption(orderId);
  check("reverse returns the reversed redemption", reversed.length === 1 &&
    reversed[0].amount_minor === 2000 && reversed[0].gift_card_id === issued.id);
  check("balance restored to face value",         (await f.gc.balance(issued.code)).balance_minor === 5000);
  check("redemption row marked reversed",
    f.db.prepare("SELECT reversed_at FROM giftcard_redemptions WHERE order_id = ?").all(orderId)[0].reversed_at != null);

  // Idempotent: a second reverse of the same order is a no-op.
  var again = await f.gc.reverseRedemption(orderId);
  check("second reverse is a no-op",              again.length === 0 &&
    (await f.gc.balance(issued.code)).balance_minor === 5000);

  // A card drained to 'redeemed' by a full spend reactivates on reversal.
  var full = await f.gc.issue({ amount_minor: 1000, currency: "USD" });
  var orderId2 = bShop.framework.uuid.v7();
  await f.gc.redeem({ code: full.code, order_id: orderId2, amount_minor: 1000 });
  check("full spend drains + redeems",            (await f.gc.balance(full.code)).status === "redeemed");
  await f.gc.reverseRedemption(orderId2);
  var reactivated = await f.gc.balance(full.code);
  check("reversal reactivates a drained card",    reactivated.status === "active" && reactivated.balance_minor === 1000);

  // An order with no gift-card spend reverses to nothing.
  check("reverse of an unrelated order is empty", (await f.gc.reverseRedemption(bShop.framework.uuid.v7())).length === 0);

  // Validation.
  await assert.rejects(f.gc.reverseRedemption("not-a-uuid"), /order_id/);
}

async function _redeemRefusals() {
  var f = _gcFactory();

  // Insufficient.
  var small = await f.gc.issue({ amount_minor: 100, currency: "USD" });
  await assert.rejects(
    f.gc.redeem({ code: small.code, amount_minor: 200 }),
    /exceeds remaining balance/,
  );

  // Voided.
  var toVoid = await f.gc.issue({ amount_minor: 100, currency: "USD" });
  await f.gc.void(toVoid.id);
  await assert.rejects(
    f.gc.redeem({ code: toVoid.code, amount_minor: 1 }),
    /voided/i,
  );

  // Expired.
  var expired = await f.gc.issue({
    amount_minor: 100,
    currency:     "USD",
    expires_at:   Date.now() - 1000,
  });
  await assert.rejects(
    f.gc.redeem({ code: expired.code, amount_minor: 1 }),
    /expired/i,
  );
  // After the lazy transition, balance reflects 'expired'.
  var expBal = await f.gc.balance(expired.code);
  check("expired card transitions on refusal",  expBal && expBal.status === "expired");
}

async function _voidBehavior() {
  var f = _gcFactory();
  var card = await f.gc.issue({ amount_minor: 100, currency: "USD" });

  // First void.
  var voided = await f.gc.void(card.id, { reason: "operator-issued-by-mistake" });
  check("void transitions to voided",           voided && voided.status === "voided");

  // Idempotent re-void.
  var again = await f.gc.void(card.id);
  check("void is idempotent",                   again && again.status === "voided");

  // Cannot void a fully-redeemed card.
  var spent = await f.gc.issue({ amount_minor: 100, currency: "USD" });
  await f.gc.redeem({ code: spent.code, amount_minor: 100 });
  await assert.rejects(f.gc.void(spent.id), /redeemed/i);

  // Void on unknown id returns null.
  var miss = await f.gc.void(bShop.framework.uuid.v7());
  check("void null on unknown id",              miss === null);
}

async function _listForCustomer() {
  var f = _gcFactory();
  var custA = bShop.framework.uuid.v7();
  var custB = bShop.framework.uuid.v7();
  await f.gc.issue({ amount_minor: 100, currency: "USD", issued_to_customer_id: custA });
  await f.gc.issue({ amount_minor: 200, currency: "USD", issued_to_customer_id: custA });
  var bCard = await f.gc.issue({ amount_minor: 300, currency: "USD", issued_to_customer_id: custB });
  await f.gc.void(bCard.id);

  var aList = await f.gc.listForCustomer(custA);
  check("listForCustomer returns custA cards", aList.length === 2 && aList.every(function (c) { return c.issued_to_customer_id === custA; }));

  var bActive = await f.gc.listForCustomer(custB, { status: "active" });
  check("listForCustomer filters by status",    bActive.length === 0);
  var bVoided = await f.gc.listForCustomer(custB, { status: "voided" });
  check("listForCustomer status=voided hits",   bVoided.length === 1 && bVoided[0].id === bCard.id);
}

async function _validation() {
  var f = _gcFactory();

  // issue — refuses every malformed input.
  await assert.rejects(f.gc.issue(),                                                                /input object required/);
  await assert.rejects(f.gc.issue({}),                                                              /amount_minor/);
  await assert.rejects(f.gc.issue({ amount_minor: 0,    currency: "USD" }),                         /amount_minor/);
  await assert.rejects(f.gc.issue({ amount_minor: -50,  currency: "USD" }),                         /amount_minor/);
  await assert.rejects(f.gc.issue({ amount_minor: 1.5,  currency: "USD" }),                         /amount_minor/);
  await assert.rejects(f.gc.issue({ amount_minor: 100,  currency: "us" }),                          /currency/);
  await assert.rejects(f.gc.issue({ amount_minor: 100,  currency: "USDD" }),                        /currency/);
  await assert.rejects(f.gc.issue({ amount_minor: 100,  currency: "USD", expires_at: -1 }),         /expires_at/);
  await assert.rejects(f.gc.issue({ amount_minor: 100,  currency: "USD", issued_to_customer_id: "not-a-uuid" }), /issued_to_customer_id/);
  await assert.rejects(f.gc.issue({ amount_minor: 100,  currency: "USD", issued_to_email: "" }),    /issued_to_email/);

  // redeem — refuses every malformed input.
  var ok = await f.gc.issue({ amount_minor: 100, currency: "USD" });
  await assert.rejects(f.gc.redeem(),                                                                /input object required/);
  await assert.rejects(f.gc.redeem({ code: ok.code }),                                               /amount_minor/);
  await assert.rejects(f.gc.redeem({ code: ok.code, amount_minor: 0 }),                              /amount_minor/);
  await assert.rejects(f.gc.redeem({ code: ok.code, amount_minor: 50, order_id: "not-a-uuid" }),     /order_id/);
  await assert.rejects(f.gc.redeem({ code: "",        amount_minor: 50 }),                          /code/);
  // Out-of-alphabet character (contains '0' which is excluded).
  await assert.rejects(f.gc.redeem({ code: "0000000000000000", amount_minor: 50 }),                  /alphabet/);
  // Wrong length.
  await assert.rejects(f.gc.redeem({ code: "ABCD", amount_minor: 50 }),                              /alphabet|characters/);
  // Well-formed but unknown.
  await assert.rejects(f.gc.redeem({ code: "ABCDABCDABCDABCD", amount_minor: 50 }),                  /not recognized/);

  // balance + lookup — same canonicalization refusals.
  await assert.rejects(f.gc.balance(""),                                                              /code/);
  await assert.rejects(f.gc.lookup("!!!!!!!!!!!!!!!!"),                                               /alphabet/);

  // void — refuses bad uuid.
  await assert.rejects(f.gc.void("not-a-uuid"),                                                       /giftcard id/);

  // listForCustomer — refuses bad uuid + bad status filter.
  await assert.rejects(f.gc.listForCustomer("not-a-uuid"),                                            /customer_id/);
  await assert.rejects(f.gc.listForCustomer(bShop.framework.uuid.v7(), { status: "bogus" }),          /status/);
}

async function _hashCollisionsAndUniqueness() {
  var f = _gcFactory();
  // Issue many cards; every code_hash must be distinct.
  var seen = Object.create(null);
  for (var i = 0; i < 32; i += 1) {
    var c = await f.gc.issue({ amount_minor: 1, currency: "USD" });
    var row = f.db.prepare("SELECT code_hash FROM giftcards WHERE id = ?").all(c.id)[0];
    check("code_hash unique across draws #" + i, !seen[row.code_hash]);
    seen[row.code_hash] = true;
  }
}

async function run() {
  await _issueAndStoredShape();
  await _issueAddressing();
  await _balanceAndLookup();
  await _codeFormatTolerance();
  await _redeemFullAndPartial();
  await _reverseRedemption();
  await _redeemRefusals();
  await _voidBehavior();
  await _listForCustomer();
  await _validation();
  await _hashCollisionsAndUniqueness();
}

module.exports = { run: run };
