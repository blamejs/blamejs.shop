"use strict";
/**
 * customer-portal — self-serve portal session manager.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0072
 * (customer_portal_sessions). Token hashing comes from
 * b.crypto.namespaceHash; the plaintext is a 32-byte base64url draw
 * from b.crypto.generateBytes; constant-time compare on verify via
 * b.crypto.timingSafeEqual.
 *
 * Coverage:
 *   - createSession: returns plaintext-once, hash stored, default
 *     15-min expiry, scope round-trip, custom ttl_seconds honored,
 *     ip_hash / ua_class persisted
 *   - createSession: refuses bad input (missing customer_id, bad
 *     scope, out-of-range ttl, control-byte ua_class)
 *   - verifyToken: happy path returns the session shape AND flips
 *     status to consumed (single-use); second presentation returns
 *     null
 *   - verifyToken: expired session returns null + row untouched
 *   - verifyToken: unknown / empty / non-string plaintext returns
 *     null
 *   - verifyToken: scope round-trips through verify for every enum
 *     value
 *   - revokeSession: live session refuses subsequent verifyToken,
 *     idempotent on already-revoked / already-consumed rows
 *   - listForCustomer: newest-first ordering, from / to window
 *     filter
 *   - expireOlderThan: flips stale `issued` rows to `expired`,
 *     leaves fresh / consumed / revoked rows alone
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var customerPortal = require("../../lib/customer-portal");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0072_customer_portal_sessions.sql"
);

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
  // Stash the db handle so individual tests can age out a row's
  // expires_at without sleeping fifteen minutes.
  raw._db = db;
  return raw;
}

function _newCustomerId() { return bShop.framework.uuid.v7(); }

async function _createHappyPath() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var cid = _newCustomerId();

  var beforeT = Date.now();
  var sess = await cp.createSession({ customer_id: cid, scope: "full" });
  var afterT  = Date.now();

  check("createSession returns session_id (uuid.v7 shape)",
    typeof sess.session_id === "string" && /^[0-9a-f-]{36}$/.test(sess.session_id));
  check("createSession returns plaintext_token (32 base64url chars)",
    typeof sess.plaintext_token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(sess.plaintext_token));
  // 32 raw bytes encode to 43 base64url chars (no padding) under
  // b.crypto.toBase64Url. The pattern above asserts exactly that.

  check("createSession returns expires_at (~ now + 15min)",
    typeof sess.expires_at === "number" &&
    sess.expires_at >= beforeT + 15 * 60 * 1000 &&
    sess.expires_at <= afterT  + 15 * 60 * 1000 + 50);

  // The storage row must key off the hash, never the plaintext.
  var stored = (await q(
    "SELECT id, customer_id, token_hash, scope, status, " +
    "ip_hash, ua_class, created_at, expires_at " +
    "FROM customer_portal_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("createSession persists exactly one row", stored != null);
  check("stored row keys off hash, not plaintext",
    stored.token_hash !== sess.plaintext_token);
  check("stored hash is hex SHA3-512",
    /^[0-9a-f]{128}$/.test(stored.token_hash));
  check("stored status starts at 'issued'", stored.status === "issued");
  check("stored scope round-trips",         stored.scope === "full");
  check("stored customer_id round-trips",   stored.customer_id === cid);
  check("stored ip_hash null when not supplied",  stored.ip_hash == null);
  check("stored ua_class null when not supplied", stored.ua_class == null);

  // Custom ttl honored + fingerprints persisted.
  var sess2 = await cp.createSession({
    customer_id: cid,
    scope:       "billing_only",
    ttl_seconds: 300,
    ip_hash:     "a".repeat(64),
    ua_class:    "desktop-firefox",
  });
  check("custom ttl_seconds honored (~ now + 300s)",
    sess2.expires_at >= Date.now() + 300 * 1000 - 1000 &&
    sess2.expires_at <= Date.now() + 300 * 1000 + 1000);
  var stored2 = (await q(
    "SELECT scope, ip_hash, ua_class FROM customer_portal_sessions WHERE id = ?1",
    [sess2.session_id],
  )).rows[0];
  check("custom scope persists",     stored2.scope === "billing_only");
  check("ip_hash persists",          stored2.ip_hash === "a".repeat(64));
  check("ua_class persists",         stored2.ua_class === "desktop-firefox");

  // Two mints for the same customer yield distinct plaintexts +
  // distinct hashes.
  check("two mints yield distinct plaintexts",
    sess.plaintext_token !== sess2.plaintext_token);
}

async function _createBadInput() {
  var cp = customerPortal.create({ query: _makeQuery() });
  await assert.rejects(cp.createSession(),                                              /input object required/);
  await assert.rejects(cp.createSession({}),                                             /customer_id/);
  await assert.rejects(cp.createSession({ customer_id: "not-a-uuid", scope: "full" }),    /customer_id/);
  await assert.rejects(cp.createSession({ customer_id: _newCustomerId() }),               /scope/);
  await assert.rejects(cp.createSession({ customer_id: _newCustomerId(), scope: "bogus" }), /scope/);
  // ttl_seconds range check
  await assert.rejects(
    cp.createSession({ customer_id: _newCustomerId(), scope: "full", ttl_seconds: 0 }),
    /ttl_seconds/,
  );
  await assert.rejects(
    cp.createSession({ customer_id: _newCustomerId(), scope: "full", ttl_seconds: 99999999 }),
    /ttl_seconds/,
  );
  await assert.rejects(
    cp.createSession({ customer_id: _newCustomerId(), scope: "full", ttl_seconds: 1.5 }),
    /ttl_seconds/,
  );
  // Control bytes refused in ua_class / ip_hash.
  await assert.rejects(
    cp.createSession({ customer_id: _newCustomerId(), scope: "full", ua_class: "bad\r\nclass" }),
    /ua_class/,
  );
  await assert.rejects(
    cp.createSession({ customer_id: _newCustomerId(), scope: "full", ip_hash: "x".repeat(257) }),
    /ip_hash/,
  );
}

async function _verifyHappyPathAndSingleUse() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var cid = _newCustomerId();

  var sess = await cp.createSession({ customer_id: cid, scope: "subscriptions_only" });

  var v = await cp.verifyToken(sess.plaintext_token);
  check("verifyToken returns object",          v != null && typeof v === "object");
  check("verifyToken returns customer_id",     v.customer_id === cid);
  check("verifyToken returns scope",           v.scope === "subscriptions_only");
  check("verifyToken returns session_id",      v.session_id === sess.session_id);
  check("verifyToken returns expires_at",
    typeof v.expires_at === "number" && v.expires_at === sess.expires_at);

  // The row must now be marked consumed with a consumed_at stamp.
  var row = (await q(
    "SELECT status, consumed_at FROM customer_portal_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("post-verify: status === consumed", row.status === "consumed");
  check("post-verify: consumed_at stamped",
    typeof row.consumed_at === "number" && row.consumed_at > 0);

  // Single-use: second presentation of the same plaintext returns
  // null. The row is NOT re-stamped (consumed_at stays at the first-
  // consumption time).
  var firstConsumedAt = row.consumed_at;
  var v2 = await cp.verifyToken(sess.plaintext_token);
  check("second verifyToken returns null",   v2 === null);
  var row2 = (await q(
    "SELECT status, consumed_at FROM customer_portal_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("second verify leaves status === consumed", row2.status === "consumed");
  check("second verify does not re-stamp consumed_at",
    row2.consumed_at === firstConsumedAt);
}

async function _verifyExpiredReturnsNull() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var cid = _newCustomerId();

  var sess = await cp.createSession({ customer_id: cid, scope: "address_only" });

  // Age the row out — set expires_at to one second ago. Tests don't
  // have 15 minutes to wait; the primitive's contract is "stored
  // expires_at > now()", which we exercise by mutating the column
  // directly.
  await q(
    "UPDATE customer_portal_sessions SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 1000, sess.session_id],
  );

  var v = await cp.verifyToken(sess.plaintext_token);
  check("expired verify returns null", v === null);

  // Row stays untouched — verify does not flip an expired row to
  // 'consumed'.
  var row = (await q(
    "SELECT status, consumed_at FROM customer_portal_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("expired verify leaves status === issued",  row.status === "issued");
  check("expired verify leaves consumed_at NULL",    row.consumed_at == null);
}

async function _verifyUnknownAndBadInput() {
  var cp = customerPortal.create({ query: _makeQuery() });
  check("unknown plaintext returns null",
    (await cp.verifyToken("not-a-real-token-32-chars-base64url-style-x")) === null);
  check("empty string returns null",     (await cp.verifyToken(""))         === null);
  check("undefined returns null",        (await cp.verifyToken(undefined))   === null);
  check("non-string returns null",       (await cp.verifyToken(42))           === null);
  check("null plaintext returns null",   (await cp.verifyToken(null))         === null);
}

async function _scopeRoundTrip() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var cid = _newCustomerId();
  var enumValues = customerPortal.SCOPE_VALUES;
  check("SCOPE_VALUES exposes all five scopes", enumValues.length === 5);
  for (var i = 0; i < enumValues.length; i += 1) {
    var scope = enumValues[i];
    var s = await cp.createSession({ customer_id: cid, scope: scope });
    var v = await cp.verifyToken(s.plaintext_token);
    check("scope " + scope + " round-trips through verifyToken",
      v != null && v.scope === scope);
  }
}

async function _revokeBlocksVerify() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var cid = _newCustomerId();

  var sess = await cp.createSession({ customer_id: cid, scope: "full" });
  var r = await cp.revokeSession(sess.session_id, "operator-eject");
  check("revokeSession on live row returns revoked=true", r.revoked === true);

  // Storage state reflects the FSM transition.
  var row = (await q(
    "SELECT status, revoked_at, revoke_reason FROM customer_portal_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("post-revoke: status === revoked",  row.status === "revoked");
  check("post-revoke: revoked_at stamped",
    typeof row.revoked_at === "number" && row.revoked_at > 0);
  check("post-revoke: revoke_reason persists", row.revoke_reason === "operator-eject");

  // Verify on a revoked session is a null — same as expired / unknown.
  var v = await cp.verifyToken(sess.plaintext_token);
  check("verify after revoke returns null", v === null);

  // Idempotent — calling revoke on an already-revoked row returns
  // revoked=false rather than throwing.
  var r2 = await cp.revokeSession(sess.session_id, "double-eject");
  check("revoke on already-revoked row returns revoked=false", r2.revoked === false);

  // Revoking a consumed session is also a no-op (revoked=false).
  var sess2 = await cp.createSession({ customer_id: cid, scope: "full" });
  await cp.verifyToken(sess2.plaintext_token);
  var r3 = await cp.revokeSession(sess2.session_id, "after-consume");
  check("revoke on already-consumed row returns revoked=false", r3.revoked === false);

  // Bad input refused.
  await assert.rejects(cp.revokeSession(),                          /session_id/);
  await assert.rejects(cp.revokeSession("not-a-uuid", "r"),          /session_id/);
  await assert.rejects(cp.revokeSession(bShop.framework.uuid.v7()),  /reason required/);
  await assert.rejects(
    cp.revokeSession(bShop.framework.uuid.v7(), "x".repeat(65)),
    /reason/,
  );
  await assert.rejects(
    cp.revokeSession(bShop.framework.uuid.v7(), "bad\r\nreason"),
    /reason/,
  );
}

async function _listForCustomerOrdering() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var cidA = _newCustomerId();
  var cidB = _newCustomerId();

  // Three sessions for A, one for B. Persist them with explicitly
  // staggered created_at so the ordering check doesn't depend on
  // millisecond-grain wall-clock differences in the inserts.
  var sA1 = await cp.createSession({ customer_id: cidA, scope: "full" });
  var sA2 = await cp.createSession({ customer_id: cidA, scope: "billing_only" });
  var sA3 = await cp.createSession({ customer_id: cidA, scope: "address_only" });
  var sB1 = await cp.createSession({ customer_id: cidB, scope: "full" });

  // Force a deterministic created_at order: sA1 oldest, sA3 newest.
  await q("UPDATE customer_portal_sessions SET created_at = ?1 WHERE id = ?2", [1000, sA1.session_id]);
  await q("UPDATE customer_portal_sessions SET created_at = ?1 WHERE id = ?2", [2000, sA2.session_id]);
  await q("UPDATE customer_portal_sessions SET created_at = ?1 WHERE id = ?2", [3000, sA3.session_id]);
  await q("UPDATE customer_portal_sessions SET created_at = ?1 WHERE id = ?2", [2500, sB1.session_id]);

  var listA = await cp.listForCustomer(cidA);
  check("listForCustomer returns only customer A's rows",
    listA.length === 3 &&
    listA.every(function (r) { return r.customer_id === cidA; }));
  check("listForCustomer orders newest-first",
    listA[0].id === sA3.session_id &&
    listA[1].id === sA2.session_id &&
    listA[2].id === sA1.session_id);

  // Returned shape includes the audit columns (status, consumed_at,
  // revoked_at, revoke_reason, ip_hash, ua_class) — the plaintext
  // token / its hash MUST NOT leak through this read.
  check("listForCustomer row shape includes status",
    typeof listA[0].status === "string");
  check("listForCustomer row shape does NOT leak token_hash",
    !Object.prototype.hasOwnProperty.call(listA[0], "token_hash"));

  // `from` / `to` window — inclusive lower, exclusive upper.
  var windowed = await cp.listForCustomer(cidA, { from: 1500, to: 3000 });
  check("listForCustomer windowed by [from, to) returns only sA2",
    windowed.length === 1 && windowed[0].id === sA2.session_id);

  // Customer B's list is independent + carries exactly one row.
  var listB = await cp.listForCustomer(cidB);
  check("listForCustomer for cidB returns one row",
    listB.length === 1 && listB[0].id === sB1.session_id);

  // Bad bounds refused.
  await assert.rejects(cp.listForCustomer("not-a-uuid"),                 /customer_id/);
  await assert.rejects(cp.listForCustomer(cidA, { from: -1 }),            /from/);
  await assert.rejects(cp.listForCustomer(cidA, { to:   1.5 }),            /to/);
}

async function _expireOlderThanWalk() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var cid = _newCustomerId();

  var stale1 = await cp.createSession({ customer_id: cid, scope: "full" });
  var stale2 = await cp.createSession({ customer_id: cid, scope: "billing_only" });
  var fresh  = await cp.createSession({ customer_id: cid, scope: "address_only" });
  var consumed = await cp.createSession({ customer_id: cid, scope: "order_history_only" });
  var revoked  = await cp.createSession({ customer_id: cid, scope: "full" });

  // Age the two stale rows so their expires_at landed an hour ago.
  // Leave `fresh` with its default 15-min future expiry.
  await q("UPDATE customer_portal_sessions SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 60 * 60 * 1000, stale1.session_id]);
  await q("UPDATE customer_portal_sessions SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 60 * 60 * 1000, stale2.session_id]);

  // Consume + revoke the other two so the walk has to skip them.
  await cp.verifyToken(consumed.plaintext_token);
  await cp.revokeSession(revoked.session_id, "test-eject");

  // expireOlderThan(0) — every issued row whose expires_at is in the
  // past flips to expired. Stale1 + stale2 are the only candidates;
  // fresh stays issued; consumed / revoked stay in their terminal
  // statuses untouched.
  var r = await cp.expireOlderThan(0);
  check("expireOlderThan flips exactly the two stale rows", r.expired === 2);

  var stale1Row = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [stale1.session_id])).rows[0];
  var stale2Row = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [stale2.session_id])).rows[0];
  var freshRow  = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [fresh.session_id])).rows[0];
  var consRow   = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [consumed.session_id])).rows[0];
  var revRow    = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [revoked.session_id])).rows[0];

  check("stale1 flipped to expired",    stale1Row.status === "expired");
  check("stale2 flipped to expired",    stale2Row.status === "expired");
  check("fresh still issued",           freshRow.status  === "issued");
  check("consumed row untouched",       consRow.status   === "consumed");
  check("revoked row untouched",        revRow.status    === "revoked");

  // A second expireOlderThan call is a no-op.
  var r2 = await cp.expireOlderThan(0);
  check("second expireOlderThan flips nothing", r2.expired === 0);

  // Verify on an expired (FSM-stamped) row returns null.
  var v = await cp.verifyToken(stale1.plaintext_token);
  check("verify on FSM-expired row returns null", v === null);

  // Bad input refused.
  await assert.rejects(cp.expireOlderThan(-1),  /seconds/);
  await assert.rejects(cp.expireOlderThan(1.5),  /seconds/);
  await assert.rejects(cp.expireOlderThan("60"), /seconds/);
}

// revokeAllForCustomer — the right-to-erasure / password-reset bulk eject:
// every LIVE (issued) session for one customer flips to revoked in a single
// statement, while terminal rows + other customers' sessions stay untouched.
async function _revokeAllForCustomer() {
  var q  = _makeQuery();
  var cp = customerPortal.create({ query: q });
  var victim = _newCustomerId();
  var other  = _newCustomerId();

  var live1   = await cp.createSession({ customer_id: victim, scope: "full" });
  var live2   = await cp.createSession({ customer_id: victim, scope: "billing_only" });
  var consumed = await cp.createSession({ customer_id: victim, scope: "address_only" });
  var otherLive = await cp.createSession({ customer_id: other, scope: "full" });

  // Consume one so the bulk revoke must skip the terminal row.
  await cp.verifyToken(consumed.plaintext_token);

  var result = await cp.revokeAllForCustomer(victim, "account-erasure");
  check("revokeAll flips both live sessions", result.revoked === 2);

  var l1 = (await q("SELECT status, revoke_reason FROM customer_portal_sessions WHERE id = ?1", [live1.session_id])).rows[0];
  var l2 = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [live2.session_id])).rows[0];
  var co = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [consumed.session_id])).rows[0];
  var ot = (await q("SELECT status FROM customer_portal_sessions WHERE id = ?1", [otherLive.session_id])).rows[0];
  check("revokeAll live1 -> revoked",      l1.status === "revoked");
  check("revokeAll stamps the reason",     l1.revoke_reason === "account-erasure");
  check("revokeAll live2 -> revoked",      l2.status === "revoked");
  check("revokeAll leaves consumed row",   co.status === "consumed");
  check("revokeAll leaves other customer", ot.status === "issued");

  // A revoked session no longer verifies.
  check("revoked session fails verify",    (await cp.verifyToken(live1.plaintext_token)) === null);

  // Idempotent — a re-run flips nothing.
  var again = await cp.revokeAllForCustomer(victim, "account-erasure");
  check("revokeAll idempotent",            again.revoked === 0);

  // Bad input refused.
  await assert.rejects(cp.revokeAllForCustomer("not-a-uuid", "x"), /customer_id/);
  await assert.rejects(cp.revokeAllForCustomer(victim, ""),        /reason/);
}

async function run() {
  await _createHappyPath();
  await _createBadInput();
  await _verifyHappyPathAndSingleUse();
  await _verifyExpiredReturnsNull();
  await _verifyUnknownAndBadInput();
  await _scopeRoundTrip();
  await _revokeBlocksVerify();
  await _revokeAllForCustomer();
  await _listForCustomerOrdering();
  await _expireOlderThanWalk();
}

if (require.main === module) {
  run().then(function () {
    var n = helpers.getChecks();
    process.stdout.write("customer-portal: " + n + " checks ok\n");
  }).catch(function (e) {
    process.stderr.write("customer-portal: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}

module.exports = { run: run };
