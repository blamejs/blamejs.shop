"use strict";
/**
 * newsletter — release-broadcast signup list + unsubscribe flow.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations 0010
 * (signups) and 0014 (unsubscribe tokens). Email hashing comes from
 * b.crypto.namespaceHash; unsubscribe tokens are opaque base64url
 * bearers whose namespaceHash is what lands in storage.
 *
 * Coverage:
 *   - issueUnsubscribeToken: happy path (plaintext returned, hash
 *     stored, expiry one year out)
 *   - issueUnsubscribeToken: refuses bad signup_id
 *   - consumeUnsubscribeToken: happy path (marks consumed + stamps
 *     newsletter_signups.unsubscribed_at)
 *   - consumeUnsubscribeToken: refuses already-consumed
 *   - consumeUnsubscribeToken: refuses expired
 *   - consumeUnsubscribeToken: refuses unknown plaintext
 *   - resubscribe: clears unsubscribed_at on the existing row
 *   - resubscribe: refuses bad email shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_SIGNUPS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0010_newsletter_signups.sql");
var MIG_TOKENS  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0014_newsletter_unsubscribe_tokens.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  var schemas = [
    nodeFs.readFileSync(MIG_SIGNUPS, "utf8"),
    nodeFs.readFileSync(MIG_TOKENS,  "utf8"),
  ];
  schemas.forEach(function (text) {
    _splitSchema(text).forEach(function (s) { db.prepare(s).run(); });
  });
  var raw = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  // Stash a back-door for the test that needs to age out a token's
  // expires_at without sleeping a year. The primitive itself never
  // looks at this; only the test helper below uses it.
  raw._db = db;
  return raw;
}

async function _signup(newsletter, email) {
  return await newsletter.signup({ email: email, source: "test-suite" });
}

async function _issueHappyPath() {
  var query      = _makeQuery();
  var newsletter = bShop.newsletter.create({ query: query });
  var s = await _signup(newsletter, "issue@example.com");

  var t = await newsletter.issueUnsubscribeToken(s.id);
  check("issueUnsubscribeToken returns plaintext token",
    typeof t.token === "string" && t.token.length === 32);
  check("issueUnsubscribeToken returns base64url plaintext",
    /^[A-Za-z0-9_-]{32}$/.test(t.token));
  check("issueUnsubscribeToken returns expires_at",
    typeof t.expires_at === "number" && t.expires_at > Date.now());
  check("issueUnsubscribeToken default expiry ~ one year",
    Math.abs(t.expires_at - (Date.now() + 365 * 24 * 60 * 60 * 1000)) < 60 * 1000);

  // Storage row must key off the hash, never the plaintext.
  var stored = await query(
    "SELECT token_hash, signup_id FROM newsletter_unsubscribe_tokens WHERE signup_id = ?1",
    [s.id],
  );
  check("issueUnsubscribeToken persists exactly one row", stored.rows.length === 1);
  check("issueUnsubscribeToken stores hash, not plaintext",
    stored.rows[0].token_hash !== t.token);
  check("issueUnsubscribeToken hash is hex SHA3-512",
    /^[0-9a-f]{128}$/.test(stored.rows[0].token_hash));
}

async function _issueBadSignupId() {
  var newsletter = bShop.newsletter.create({ query: _makeQuery() });
  await assert.rejects(newsletter.issueUnsubscribeToken(),       /signup_id required/);
  await assert.rejects(newsletter.issueUnsubscribeToken(""),      /signup_id required/);
  await assert.rejects(newsletter.issueUnsubscribeToken(42),      /signup_id required/);
  // Well-formed-but-missing id — the foreign-key check refuses.
  await assert.rejects(
    newsletter.issueUnsubscribeToken(bShop.framework.uuid.v7()),
    /signup_id not found/,
  );
}

async function _consumeHappyPath() {
  var query      = _makeQuery();
  var newsletter = bShop.newsletter.create({ query: query });
  var s = await _signup(newsletter, "consume@example.com");
  var t = await newsletter.issueUnsubscribeToken(s.id);

  var pre = await newsletter.byEmailHash(
    bShop.framework.crypto.namespaceHash("newsletter-email", "consume@example.com"),
  );
  check("pre-consume: signup is active", pre && pre.unsubscribed_at == null);

  var r = await newsletter.consumeUnsubscribeToken(t.token);
  check("consume ok=true",                r.ok === true);
  check("consume error=ok",                r.error === "ok");
  check("consume returns signup_id",       r.signup_id === s.id);
  check("consume returns email_hash",      typeof r.email_hash === "string" && r.email_hash.length === 128);

  // Signup row should now carry an unsubscribed_at stamp.
  var post = await newsletter.byEmailHash(pre.email_normalized
    ? bShop.framework.crypto.namespaceHash("newsletter-email", pre.email_normalized)
    : r.email_hash);
  check("post-consume: signup is unsubscribed", post && post.unsubscribed_at != null);

  // Token row should be marked consumed.
  var stored = await query(
    "SELECT consumed_at FROM newsletter_unsubscribe_tokens WHERE signup_id = ?1",
    [s.id],
  );
  check("post-consume: token row has consumed_at",
    stored.rows.length === 1 && stored.rows[0].consumed_at != null);

  // count() must reflect the unsubscribe.
  var n = await newsletter.count();
  check("count() excludes unsubscribed rows", n === 0);
}

async function _consumeAlreadyConsumed() {
  var newsletter = bShop.newsletter.create({ query: _makeQuery() });
  var s = await _signup(newsletter, "twice@example.com");
  var t = await newsletter.issueUnsubscribeToken(s.id);

  var first = await newsletter.consumeUnsubscribeToken(t.token);
  check("first consume succeeds", first.ok === true);

  var second = await newsletter.consumeUnsubscribeToken(t.token);
  check("second consume refused",         second.ok === false);
  check("second consume error code",       second.error === "already-consumed");
}

async function _consumeExpired() {
  var query      = _makeQuery();
  var newsletter = bShop.newsletter.create({ query: query });
  var s = await _signup(newsletter, "stale@example.com");
  var t = await newsletter.issueUnsubscribeToken(s.id);

  // Age the token out — set expires_at to one second ago. Tests
  // don't have a year to wait; the primitive's contract is "the
  // stored expires_at must be greater than now()", which we
  // exercise by mutating the column directly.
  await query(
    "UPDATE newsletter_unsubscribe_tokens SET expires_at = ?1 WHERE signup_id = ?2",
    [Date.now() - 1000, s.id],
  );

  var r = await newsletter.consumeUnsubscribeToken(t.token);
  check("expired consume refused",     r.ok === false);
  check("expired error code",          r.error === "expired");

  // Signup row stays untouched on expired consume.
  var hash = bShop.framework.crypto.namespaceHash("newsletter-email", "stale@example.com");
  var row = await newsletter.byEmailHash(hash);
  check("expired consume leaves signup active", row && row.unsubscribed_at == null);
}

async function _consumeUnknown() {
  var newsletter = bShop.newsletter.create({ query: _makeQuery() });
  var r1 = await newsletter.consumeUnsubscribeToken("not-a-real-token-no-row-keys-off-this");
  check("unknown plaintext refused",   r1.ok === false);
  check("unknown error code",          r1.error === "not-found");

  // Empty / non-string plaintexts collapse to the same error code
  // — no separate stack trace, no extra information leak.
  var r2 = await newsletter.consumeUnsubscribeToken("");
  check("empty plaintext = not-found", r2.ok === false && r2.error === "not-found");
  var r3 = await newsletter.consumeUnsubscribeToken(undefined);
  check("undefined plaintext = not-found", r3.ok === false && r3.error === "not-found");
  var r4 = await newsletter.consumeUnsubscribeToken(42);
  check("non-string plaintext = not-found", r4.ok === false && r4.error === "not-found");
}

async function _resubscribeHappyPath() {
  var newsletter = bShop.newsletter.create({ query: _makeQuery() });
  var s = await _signup(newsletter, "back@example.com");
  var t = await newsletter.issueUnsubscribeToken(s.id);
  await newsletter.consumeUnsubscribeToken(t.token);

  var hash = bShop.framework.crypto.namespaceHash("newsletter-email", "back@example.com");
  var afterUnsub = await newsletter.byEmailHash(hash);
  check("after unsubscribe: row carries timestamp", afterUnsub.unsubscribed_at != null);

  var r = await newsletter.resubscribe({ email: "back@example.com" });
  check("resubscribe ok",              r.ok === true);
  check("resubscribe returns signup_id", r.signup_id === s.id);

  var afterRe = await newsletter.byEmailHash(hash);
  check("after resubscribe: timestamp cleared", afterRe.unsubscribed_at == null);

  // Resubscribing an unknown address is a soft miss, not a throw.
  var miss = await newsletter.resubscribe({ email: "neverwas@example.com" });
  check("resubscribe unknown email: ok=false", miss.ok === false);
  check("resubscribe unknown email: no signup_id", miss.signup_id === undefined);

  // Case-fold of the original address still hits the same row.
  await newsletter.consumeUnsubscribeToken(
    (await newsletter.issueUnsubscribeToken(s.id)).token,
  );
  var caseRe = await newsletter.resubscribe({ email: "BACK@EXAMPLE.COM" });
  check("resubscribe canonical-equiv address hits same row",
    caseRe.ok === true && caseRe.signup_id === s.id);
}

async function _resubscribeBadEmail() {
  var newsletter = bShop.newsletter.create({ query: _makeQuery() });
  await assert.rejects(newsletter.resubscribe(),                          /input object required/);
  await assert.rejects(newsletter.resubscribe({}),                         /email/);
  await assert.rejects(newsletter.resubscribe({ email: "" }),               /email/);
  await assert.rejects(newsletter.resubscribe({ email: "not-an-email" }),    /email/);
  await assert.rejects(newsletter.resubscribe({ email: "two@@example.com" }), /email/);
  // Header-injection class — guardEmail strict profile refuses.
  await assert.rejects(
    newsletter.resubscribe({ email: "a@example.com\r\nBcc: evil@x" }),
    /email/,
  );
}

async function run() {
  await _issueHappyPath();
  await _issueBadSignupId();
  await _consumeHappyPath();
  await _consumeAlreadyConsumed();
  await _consumeExpired();
  await _consumeUnknown();
  await _resubscribeHappyPath();
  await _resubscribeBadEmail();
}

module.exports = { run: run };
