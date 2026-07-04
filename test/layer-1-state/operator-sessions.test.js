"use strict";
/**
 * operator-sessions — staff login session manager.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0165 (operator_sessions + operator_failed_logins). Token hashing
 * comes from b.crypto.namespaceHash; the plaintext is a 32-byte
 * base64url draw from b.crypto.generateBytes; constant-time compare
 * on verify via b.crypto.timingSafeEqual.
 *
 * The primitive is wired through the test directly (not via the
 * `bShop` entry point yet) so the gate exists ahead of any entry-
 * point edit.
 *
 * Coverage:
 *   - createSession: returns plaintext-once, hash stored, default
 *     8-hour expiry, mfa_required + ip_hash + ua_class persisted,
 *     custom ttl honored
 *   - createSession: refuses bad input (missing operator_id, missing
 *     ip_hash, control-byte ua_class, out-of-range ttl)
 *   - verifyToken: happy path returns the session shape AND flips
 *     status to active on first hit; per-IP binding refused on a
 *     mismatching ip_hash
 *   - verifyToken: requires_mfa stub returned when mfa_required = 1
 *     and mfa_verified_at IS NULL; full shape after
 *     recordMfaVerification
 *   - verifyToken: expired session returns null + row untouched
 *   - revokeSession: live session refuses subsequent verifyToken;
 *     idempotent on already-revoked rows
 *   - lockoutCheck: threshold trip after N failed-verify rows in the
 *     window; below-threshold returns locked=false
 *   - listForOperator + expireOlderThan + audit-log composition
 *     happy paths
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var operatorSessions = require("../../lib/operator-sessions");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0165_operator_sessions.sql"
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
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  raw._db = db;
  return raw;
}

function _newOperatorId() { return bShop.framework.uuid.v7(); }

// Capture-and-replay audit-log stub. The duck-typed `.record(...)`
// surface mirrors the operator-audit-log primitive's contract; the
// stub just appends to an array so the test can assert composition
// without spinning up the chained-hash storage table.
function _audit() {
  var rows = [];
  return {
    rows: rows,
    record: async function (input) {
      rows.push(input);
      return { id: bShop.framework.uuid.v7(), occurred_at: Date.now() };
    },
  };
}

async function _createHappyPathAndAudit() {
  var q     = _makeQuery();
  var audit = _audit();
  var os    = operatorSessions.create({ query: q, operatorAuditLog: audit });
  var oid   = _newOperatorId();
  var ip    = "a".repeat(64);

  var beforeT = Date.now();
  var sess = await os.createSession({
    operator_id:  oid,
    ip_hash:      ip,
    ua_class:     "desktop-firefox",
    mfa_required: true,
  });
  var afterT = Date.now();

  check("createSession returns session_id (uuid.v7 shape)",
    typeof sess.session_id === "string" && /^[0-9a-f-]{36}$/.test(sess.session_id));
  check("createSession returns plaintext_token (43 base64url chars)",
    typeof sess.plaintext_token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(sess.plaintext_token));
  check("createSession returns expires_at (~ now + 8h)",
    typeof sess.expires_at === "number" &&
    sess.expires_at >= beforeT + 8 * 60 * 60 * 1000 &&
    sess.expires_at <= afterT  + 8 * 60 * 60 * 1000 + 50);
  check("createSession returns mfa_required=true", sess.mfa_required === true);

  // Storage row keys off hash, not plaintext.
  var stored = (await q(
    "SELECT id, operator_id, token_hash, ip_hash, ua_class, status, " +
    " mfa_required, mfa_verified_at, ttl_seconds, created_at, expires_at " +
    "FROM operator_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("createSession persists exactly one row", stored != null);
  check("stored row keys off hash, not plaintext",
    stored.token_hash !== sess.plaintext_token);
  check("stored hash is hex (SHA3-512 — 128 chars)",
    /^[0-9a-f]{128}$/.test(stored.token_hash));
  check("stored status starts at 'issued'",   stored.status === "issued");
  check("stored operator_id round-trips",     stored.operator_id === oid);
  check("stored ip_hash round-trips",         stored.ip_hash === ip);
  check("stored ua_class round-trips",        stored.ua_class === "desktop-firefox");
  check("stored mfa_required = 1",            Number(stored.mfa_required) === 1);
  check("stored mfa_verified_at NULL at create", stored.mfa_verified_at == null);
  check("stored ttl_seconds = 28800",         Number(stored.ttl_seconds) === 28800);

  // Custom ttl + no MFA.
  var sess2 = await os.createSession({
    operator_id:  oid,
    ip_hash:      ip,
    mfa_required: false,
    ttl_seconds:  3600,
  });
  check("custom ttl_seconds honored (~ now + 3600s)",
    sess2.expires_at >= Date.now() + 3600 * 1000 - 2000 &&
    sess2.expires_at <= Date.now() + 3600 * 1000 + 2000);
  check("mfa_required=false honored", sess2.mfa_required === false);

  // Two mints yield distinct plaintexts.
  check("two mints yield distinct plaintexts",
    sess.plaintext_token !== sess2.plaintext_token);

  // Audit composition: two session.create events landed.
  check("audit log captured both createSession events",
    audit.rows.length === 2 &&
    audit.rows[0].action === "session.create" &&
    audit.rows[1].action === "session.create");
  check("audit log carries operator_id as actor_id",
    audit.rows[0].actor_id === oid && audit.rows[1].actor_id === oid);
  check("audit log records mfa_required in after-snapshot",
    audit.rows[0].after && audit.rows[0].after.mfa_required === true &&
    audit.rows[1].after.mfa_required === false);
}

async function _createBadInput() {
  var os = operatorSessions.create({ query: _makeQuery() });
  await assert.rejects(os.createSession(),                                                /input object required/);
  await assert.rejects(os.createSession({}),                                              /operator_id/);
  await assert.rejects(os.createSession({ operator_id: "not-a-uuid", ip_hash: "x" }),     /operator_id/);
  await assert.rejects(os.createSession({ operator_id: _newOperatorId() }),               /ip_hash/);
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "" }),
    /ip_hash/,
  );
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "x".repeat(257) }),
    /ip_hash/,
  );
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "bad\r\nip" }),
    /ip_hash/,
  );
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "x", ua_class: "bad\r\nua" }),
    /ua_class/,
  );
  // ttl_seconds range checks.
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "x", ttl_seconds: 0 }),
    /ttl_seconds/,
  );
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "x", ttl_seconds: 99999999 }),
    /ttl_seconds/,
  );
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "x", ttl_seconds: 1.5 }),
    /ttl_seconds/,
  );
  // mfa_required non-boolean.
  await assert.rejects(
    os.createSession({ operator_id: _newOperatorId(), ip_hash: "x", mfa_required: "yes" }),
    /mfa_required/,
  );
}

async function _verifyHappyPathAndIpBinding() {
  var q   = _makeQuery();
  var os  = operatorSessions.create({ query: q });
  var oid = _newOperatorId();
  var ip  = "ip-hash-A";

  var sess = await os.createSession({
    operator_id:  oid,
    ip_hash:      ip,
    mfa_required: false,
  });

  // First verify on the correct IP flips status to active.
  var v = await os.verifyToken(sess.plaintext_token, { ip_hash: ip });
  check("verifyToken returns object",            v != null && typeof v === "object");
  check("verifyToken returns session_id",        v.session_id === sess.session_id);
  check("verifyToken returns operator_id",       v.operator_id === oid);
  check("verifyToken returns expires_at",        v.expires_at === sess.expires_at);
  check("verifyToken mfa_verified_at NULL when not required",
    v.mfa_verified_at === null);

  var row = (await q(
    "SELECT status, activated_at FROM operator_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("post-verify: status === active",         row.status === "active");
  check("post-verify: activated_at stamped",
    typeof row.activated_at === "number" && row.activated_at > 0);

  // Second verify on the SAME ip still hits and returns the active
  // shape (the session is re-usable until expiry, unlike the customer
  // portal which is single-use).
  var v2 = await os.verifyToken(sess.plaintext_token, { ip_hash: ip });
  check("second verifyToken still returns hit",  v2 != null && v2.session_id === sess.session_id);
  var row2 = (await q(
    "SELECT status, activated_at FROM operator_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  var firstActivatedAt = row.activated_at;
  check("second verify does NOT re-stamp activated_at",
    row2.activated_at === firstActivatedAt);
  check("second verify leaves status === active", row2.status === "active");

  // Per-IP binding — a presentation from a different ip_hash misses.
  var vBad = await os.verifyToken(sess.plaintext_token, { ip_hash: "ip-hash-B" });
  check("verifyToken from mismatched ip_hash returns null", vBad === null);

  // Bad / missing ip_hash on verify returns null (treated as miss).
  check("verifyToken without opts returns null",        (await os.verifyToken(sess.plaintext_token)) === null);
  check("verifyToken with empty ip_hash returns null",  (await os.verifyToken(sess.plaintext_token, { ip_hash: "" })) === null);
  check("verifyToken with non-string ip_hash returns null", (await os.verifyToken(sess.plaintext_token, { ip_hash: 42 })) === null);

  // Unknown / non-string plaintexts return null.
  check("unknown plaintext returns null",
    (await os.verifyToken("not-a-real-bearer-43-chars-base64url-style-x", { ip_hash: ip })) === null);
  check("empty plaintext returns null", (await os.verifyToken("",       { ip_hash: ip })) === null);
  check("null plaintext returns null",  (await os.verifyToken(null,     { ip_hash: ip })) === null);
  check("non-string plaintext returns null", (await os.verifyToken(42,  { ip_hash: ip })) === null);
}

async function _mfaGateAndRecordMfaVerification() {
  var q     = _makeQuery();
  var audit = _audit();
  var os    = operatorSessions.create({ query: q, operatorAuditLog: audit });
  var oid   = _newOperatorId();
  var ip    = "ip-hash-mfa";

  var sess = await os.createSession({
    operator_id:  oid,
    ip_hash:      ip,
    mfa_required: true,
  });

  // First verify with MFA pending returns the requires_mfa stub.
  var v = await os.verifyToken(sess.plaintext_token, { ip_hash: ip });
  check("verifyToken with MFA pending returns requires_mfa=true",
    v != null && v.requires_mfa === true);
  check("requires_mfa stub carries session_id",  v.session_id === sess.session_id);
  check("requires_mfa stub carries operator_id", v.operator_id === oid);
  check("requires_mfa stub carries expires_at",  typeof v.expires_at === "number");

  // Row should remain in `issued` — the MFA stub does NOT activate.
  var rowPre = (await q("SELECT status, activated_at FROM operator_sessions WHERE id = ?1", [sess.session_id])).rows[0];
  check("MFA-pending verify leaves status === issued", rowPre.status === "issued");
  check("MFA-pending verify leaves activated_at NULL", rowPre.activated_at == null);

  // Step-up flip.
  var mfa = await os.recordMfaVerification(sess.session_id);
  check("recordMfaVerification returns verified=true on first call", mfa.verified === true);

  var rowMid = (await q("SELECT mfa_verified_at, status FROM operator_sessions WHERE id = ?1", [sess.session_id])).rows[0];
  check("recordMfaVerification stamps mfa_verified_at",
    typeof rowMid.mfa_verified_at === "number" && rowMid.mfa_verified_at > 0);

  // Second call is idempotent.
  var mfa2 = await os.recordMfaVerification(sess.session_id);
  check("recordMfaVerification idempotent (verified=false on repeat)",
    mfa2.verified === false);

  // Unknown session id is a no-op (verified=false).
  var mfa3 = await os.recordMfaVerification(_newOperatorId());
  check("recordMfaVerification on unknown session returns verified=false",
    mfa3.verified === false);

  // Bad shape.
  await assert.rejects(os.recordMfaVerification("not-a-uuid"), /session_id/);

  // Verify now returns the full session shape AND activates the row.
  var v2 = await os.verifyToken(sess.plaintext_token, { ip_hash: ip });
  check("post-MFA verify returns session_id", v2 != null && v2.session_id === sess.session_id);
  check("post-MFA verify carries mfa_verified_at",
    typeof v2.mfa_verified_at === "number" && v2.mfa_verified_at > 0);
  var rowPost = (await q("SELECT status FROM operator_sessions WHERE id = ?1", [sess.session_id])).rows[0];
  check("post-MFA verify flips status to active", rowPost.status === "active");

  // Audit composition: create + mfa_verify + activate.
  var actions = audit.rows.map(function (r) { return r.action; });
  check("audit log includes session.create",     actions.indexOf("session.create")     !== -1);
  check("audit log includes session.mfa_verify", actions.indexOf("session.mfa_verify") !== -1);
  check("audit log includes session.activate",   actions.indexOf("session.activate")   !== -1);
}

async function _requireMfaPeerWiring() {
  var q = _makeQuery();
  var rolesStub = {
    requireMfa: async function (operatorId) {
      // Stub policy: any operator whose id ends in an even hex char
      // requires MFA. Lets the test exercise both branches without
      // spinning up the real operator-roles primitive.
      return /[02468ace]$/.test(operatorId);
    },
  };
  var os = operatorSessions.create({ query: q, operatorRoles: rolesStub });

  // Craft two operator ids by sampling until we have one of each
  // parity. uuid.v7 with the trailing hex digit gives us both.
  var oidEven, oidOdd;
  for (var i = 0; i < 256 && (!oidEven || !oidOdd); i += 1) {
    var candidate = bShop.framework.uuid.v7();
    if (/[02468ace]$/.test(candidate) && !oidEven) oidEven = candidate;
    if (/[13579bdf]$/.test(candidate) && !oidOdd)  oidOdd  = candidate;
  }
  check("test setup found both even + odd operator_ids",
    typeof oidEven === "string" && typeof oidOdd === "string");

  // Direct requireMfa probe.
  check("requireMfa returns true via peer for even-suffix operator",
    (await os.requireMfa(oidEven)) === true);
  check("requireMfa returns false via peer for odd-suffix operator",
    (await os.requireMfa(oidOdd)) === false);

  // createSession derives mfa_required from the peer when the caller
  // leaves the flag unset.
  var sessEven = await os.createSession({ operator_id: oidEven, ip_hash: "x" });
  var sessOdd  = await os.createSession({ operator_id: oidOdd,  ip_hash: "x" });
  check("createSession derives mfa_required=true via peer",  sessEven.mfa_required === true);
  check("createSession derives mfa_required=false via peer", sessOdd.mfa_required === false);

  // Explicit mfa_required overrides the peer.
  var sessExplicit = await os.createSession({
    operator_id:  oidEven,
    ip_hash:      "x",
    mfa_required: false,
  });
  check("explicit mfa_required overrides peer", sessExplicit.mfa_required === false);

  // Without the peer wired, requireMfa returns false.
  var bare = operatorSessions.create({ query: _makeQuery() });
  check("requireMfa without peer returns false",
    (await bare.requireMfa(_newOperatorId())) === false);
}

async function _verifyExpiredReturnsNull() {
  var q   = _makeQuery();
  var os  = operatorSessions.create({ query: q });
  var oid = _newOperatorId();
  var ip  = "ip-hash-expiry";

  var sess = await os.createSession({
    operator_id:  oid,
    ip_hash:      ip,
    mfa_required: false,
  });

  await q(
    "UPDATE operator_sessions SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 1000, sess.session_id],
  );

  var v = await os.verifyToken(sess.plaintext_token, { ip_hash: ip });
  check("expired verify returns null", v === null);

  // Row still issued — verify does not flip an expired row to active.
  var row = (await q(
    "SELECT status, activated_at FROM operator_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("expired verify leaves status === issued",    row.status === "issued");
  check("expired verify leaves activated_at NULL",    row.activated_at == null);
}

async function _revokeBlocksVerify() {
  var q     = _makeQuery();
  var audit = _audit();
  var os    = operatorSessions.create({ query: q, operatorAuditLog: audit });
  var oid   = _newOperatorId();
  var ip    = "ip-hash-rev";

  var sess = await os.createSession({
    operator_id:  oid,
    ip_hash:      ip,
    mfa_required: false,
  });

  var r = await os.revokeSession(sess.session_id, "operator-logout");
  check("revokeSession on live row returns revoked=true", r.revoked === true);

  var row = (await q(
    "SELECT status, revoked_at, revoke_reason FROM operator_sessions WHERE id = ?1",
    [sess.session_id],
  )).rows[0];
  check("post-revoke: status === revoked",       row.status === "revoked");
  check("post-revoke: revoked_at stamped",
    typeof row.revoked_at === "number" && row.revoked_at > 0);
  check("post-revoke: revoke_reason persists",   row.revoke_reason === "operator-logout");

  // Verify after revoke is a miss.
  var v = await os.verifyToken(sess.plaintext_token, { ip_hash: ip });
  check("verify after revoke returns null", v === null);

  // Idempotent — already-revoked returns revoked=false.
  var r2 = await os.revokeSession(sess.session_id, "double-logout");
  check("revoke on already-revoked row returns revoked=false", r2.revoked === false);

  // Bad input refused.
  await assert.rejects(os.revokeSession(),                                /session_id/);
  await assert.rejects(os.revokeSession("not-a-uuid", "r"),               /session_id/);
  await assert.rejects(os.revokeSession(_newOperatorId()),                /reason required/);
  await assert.rejects(os.revokeSession(_newOperatorId(), ""),            /reason required/);
  await assert.rejects(os.revokeSession(_newOperatorId(), "x".repeat(65)), /reason/);
  await assert.rejects(os.revokeSession(_newOperatorId(), "bad\r\n"),     /reason/);

  // Audit composition: a session.revoke row exists for the actual
  // revoke that landed.
  var revokeRows = audit.rows.filter(function (r2x) { return r2x.action === "session.revoke"; });
  check("audit log carries exactly one session.revoke", revokeRows.length === 1);
  check("session.revoke audit row carries reason in after-snapshot",
    revokeRows[0].after && revokeRows[0].after.revoke_reason === "operator-logout");
}

async function _lockoutThresholdTrip() {
  var q   = _makeQuery();
  var os  = operatorSessions.create({ query: q });
  var ip  = "ip-hash-lockout";

  // Empty state: locked=false, count=0.
  var l0 = await os.lockoutCheck(ip);
  check("lockoutCheck empty state: locked=false", l0.locked === false);
  check("lockoutCheck empty state: count=0",      l0.count === 0);
  check("lockoutCheck default threshold = 5",     l0.threshold === 5);
  check("lockoutCheck default window = 900s",     l0.window_seconds === 900);

  // Record four failures — still under default threshold of 5.
  for (var i = 0; i < 4; i += 1) {
    var ev = await os.recordFailedVerify({
      ip_hash:  ip,
      reason:   "bad-password",
    });
    check("recordFailedVerify returns id + occurred_at",
      typeof ev.id === "string" && /^[0-9a-f-]{36}$/.test(ev.id) &&
      typeof ev.occurred_at === "number");
  }
  var l1 = await os.lockoutCheck(ip);
  check("4 failures below default threshold: locked=false", l1.locked === false);
  check("4 failures: count=4",                              l1.count  === 4);

  // Fifth failure trips the threshold.
  await os.recordFailedVerify({ ip_hash: ip, reason: "bad-password" });
  var l2 = await os.lockoutCheck(ip);
  check("5 failures meets threshold: locked=true", l2.locked === true);
  check("5 failures: count=5",                      l2.count  === 5);

  // Failures from a DIFFERENT ip_hash do not affect this ip's count.
  await os.recordFailedVerify({ ip_hash: "other-ip-hash", reason: "bad-password" });
  var l3 = await os.lockoutCheck(ip);
  check("unrelated-ip failures don't affect target ip count", l3.count === 5);

  // Custom threshold + custom window honored.
  var l4 = await os.lockoutCheck(ip, { threshold: 100, window_seconds: 3600 });
  check("custom-threshold below count: locked=false", l4.locked === false);
  check("custom-threshold round-trip",                l4.threshold === 100);

  // Window: ageing rows out of the window drops the count.
  await q(
    "UPDATE operator_failed_logins SET occurred_at = ?1 WHERE ip_hash = ?2",
    [Date.now() - 2 * 60 * 60 * 1000, ip],
  );
  var l5 = await os.lockoutCheck(ip);   // default 15-min window
  check("aged failures fall out of the default window",
    l5.count === 0 && l5.locked === false);

  // Bad input refusals.
  await assert.rejects(os.lockoutCheck(),                          /ip_hash/);
  await assert.rejects(os.lockoutCheck(""),                         /ip_hash/);
  await assert.rejects(os.lockoutCheck(ip, { threshold:   0 }),      /threshold/);
  await assert.rejects(os.lockoutCheck(ip, { threshold:   1.5 }),    /threshold/);
  await assert.rejects(os.lockoutCheck(ip, { window_seconds: 0 }),   /window_seconds/);
  await assert.rejects(os.lockoutCheck(ip, { window_seconds: -1 }),  /window_seconds/);

  // recordFailedVerify input refusals.
  await assert.rejects(os.recordFailedVerify(),                            /input object required/);
  await assert.rejects(os.recordFailedVerify({}),                           /ip_hash/);
  await assert.rejects(os.recordFailedVerify({ ip_hash: ip }),               /reason/);
  await assert.rejects(os.recordFailedVerify({ ip_hash: ip, reason: "" }),    /reason/);
  await assert.rejects(
    os.recordFailedVerify({ ip_hash: ip, reason: "bad-password", operator_id: "not-a-uuid" }),
    /operator_id/,
  );
}

async function _listForOperatorAndExpire() {
  var q   = _makeQuery();
  var os  = operatorSessions.create({ query: q });
  var oidA = _newOperatorId();
  var oidB = _newOperatorId();
  var ip   = "x";

  var sA1 = await os.createSession({ operator_id: oidA, ip_hash: ip, mfa_required: false });
  var sA2 = await os.createSession({ operator_id: oidA, ip_hash: ip, mfa_required: false });
  var sA3 = await os.createSession({ operator_id: oidA, ip_hash: ip, mfa_required: false });
  var sB1 = await os.createSession({ operator_id: oidB, ip_hash: ip, mfa_required: false });

  await q("UPDATE operator_sessions SET created_at = ?1 WHERE id = ?2", [1000, sA1.session_id]);
  await q("UPDATE operator_sessions SET created_at = ?1 WHERE id = ?2", [2000, sA2.session_id]);
  await q("UPDATE operator_sessions SET created_at = ?1 WHERE id = ?2", [3000, sA3.session_id]);
  await q("UPDATE operator_sessions SET created_at = ?1 WHERE id = ?2", [2500, sB1.session_id]);

  var listA = await os.listForOperator(oidA);
  check("listForOperator returns only operator A's rows",
    listA.length === 3 &&
    listA.every(function (r) { return r.operator_id === oidA; }));
  check("listForOperator orders newest-first",
    listA[0].id === sA3.session_id &&
    listA[1].id === sA2.session_id &&
    listA[2].id === sA1.session_id);
  check("listForOperator row shape includes status + ip_hash",
    typeof listA[0].status === "string" && typeof listA[0].ip_hash === "string");
  check("listForOperator row shape does NOT leak token_hash",
    !Object.prototype.hasOwnProperty.call(listA[0], "token_hash"));

  // Windowed read.
  var windowed = await os.listForOperator(oidA, { from: 1500, to: 3000 });
  check("listForOperator windowed by [from, to) returns only sA2",
    windowed.length === 1 && windowed[0].id === sA2.session_id);

  // Status filter — revoke sA1 + listForOperator(status: 'revoked').
  await os.revokeSession(sA1.session_id, "test-eject");
  var revokedList = await os.listForOperator(oidA, { status: "revoked" });
  check("listForOperator status=revoked filters correctly",
    revokedList.length === 1 && revokedList[0].id === sA1.session_id);

  // Bad bounds refused.
  await assert.rejects(os.listForOperator("not-a-uuid"),                   /operator_id/);
  await assert.rejects(os.listForOperator(oidA, { from: -1 }),              /from/);
  await assert.rejects(os.listForOperator(oidA, { to:   1.5 }),              /to/);
  await assert.rejects(os.listForOperator(oidA, { status: "bogus" }),        /status/);

  // expireOlderThan walk.
  var stale1 = await os.createSession({ operator_id: oidB, ip_hash: ip, mfa_required: false });
  var stale2 = await os.createSession({ operator_id: oidB, ip_hash: ip, mfa_required: false });
  var fresh  = await os.createSession({ operator_id: oidB, ip_hash: ip, mfa_required: false });

  await q("UPDATE operator_sessions SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 60 * 60 * 1000, stale1.session_id]);
  await q("UPDATE operator_sessions SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 60 * 60 * 1000, stale2.session_id]);

  var r = await os.expireOlderThan(0);
  check("expireOlderThan flips at least the two stale rows", r.expired >= 2);

  var stale1Row = (await q("SELECT status FROM operator_sessions WHERE id = ?1", [stale1.session_id])).rows[0];
  var stale2Row = (await q("SELECT status FROM operator_sessions WHERE id = ?1", [stale2.session_id])).rows[0];
  var freshRow  = (await q("SELECT status FROM operator_sessions WHERE id = ?1", [fresh.session_id])).rows[0];

  check("stale1 flipped to expired", stale1Row.status === "expired");
  check("stale2 flipped to expired", stale2Row.status === "expired");
  check("fresh still issued",         freshRow.status  === "issued");

  // expireOlderThan also catches active rows whose expiry has lapsed.
  // Mark a fresh session active via verifyToken, then age it out.
  var activeBecomingStale = await os.createSession({ operator_id: oidB, ip_hash: ip, mfa_required: false });
  await os.verifyToken(activeBecomingStale.plaintext_token, { ip_hash: ip });
  var activeRow = (await q("SELECT status FROM operator_sessions WHERE id = ?1", [activeBecomingStale.session_id])).rows[0];
  check("setup: row is active before aging", activeRow.status === "active");
  await q("UPDATE operator_sessions SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 1000, activeBecomingStale.session_id]);
  var r2 = await os.expireOlderThan(0);
  check("expireOlderThan also expires active rows past their TTL", r2.expired >= 1);
  var stamped = (await q("SELECT status FROM operator_sessions WHERE id = ?1", [activeBecomingStale.session_id])).rows[0];
  check("aged active row flipped to expired", stamped.status === "expired");

  // Bad seconds refused.
  await assert.rejects(os.expireOlderThan(-1),    /seconds/);
  await assert.rejects(os.expireOlderThan(1.5),    /seconds/);
  await assert.rejects(os.expireOlderThan("60"),   /seconds/);
}

// Per-account lockout catches a DISTRIBUTED brute force (one account, many
// IPs) that the per-IP count can't, and clearFailures resets on success.
async function _lockoutPerAccountAndClear() {
  var q   = _makeQuery();
  var os  = operatorSessions.create({ query: q });
  var oid = "019f2a48-2d81-72eb-8431-abe026ccb55a";   // valid UUID (no FK on the column)

  var l0 = await os.lockoutCheck("ip-x", { operator_id: oid });
  check("per-account default threshold = 20",     l0.account_threshold === 20);
  check("per-account empty: not locked, count 0", l0.locked === false && l0.account_count === 0);

  // 3 failures for ONE account, each from a DIFFERENT IP — no single IP nears
  // the per-IP threshold (5), but the account count aggregates across them.
  for (var i = 0; i < 3; i += 1) {
    await os.recordFailedVerify({ ip_hash: "ip-" + i, operator_id: oid, reason: "bad-password" });
  }
  var st = await os.lockoutCheck("ip-0", { operator_id: oid, account_threshold: 3 });
  check("distributed: single-IP count below per-IP threshold", st.count === 1 && st.count < st.threshold);
  check("distributed: account count aggregates across IPs",    st.account_count === 3);
  check("distributed: account threshold trips the lock",       st.locked === true && st.locked_by === "account");

  // Without the account key the same rows don't lock (each IP has one failure).
  var ipOnly = await os.lockoutCheck("ip-0");
  check("no operator_id: per-IP only, not locked", ipOnly.locked === false && ipOnly.account_count === 0);

  // Cross-account isolation: a SECOND account (victim) also has a failure from
  // ip-0. Clearing the FIRST account (attacker signing in as themselves) must
  // NOT erase the victim's row — otherwise a shared-IP attacker could reset a
  // victim's lockout by signing in. clearFailures is scoped to operator_id.
  var victim = "019f2a48-2d81-72eb-8431-abe026ccc999";
  await os.recordFailedVerify({ ip_hash: "ip-0", operator_id: victim, reason: "bad-password" });
  check("clearFailures by IP alone is a no-op (needs operator_id)", (await os.clearFailures({ ip_hash: "ip-0" })).cleared === 0);
  var cleared = await os.clearFailures({ operator_id: oid });   // attacker's own account only
  check("clearFailures removed only the caller's account rows", cleared.cleared === 3);
  var victimState = await os.lockoutCheck("ip-victim", { operator_id: victim, account_threshold: 1 });
  check("victim's failure survives the attacker's clear",       victimState.account_count === 1 && victimState.locked === true);

  var after = await os.lockoutCheck("ip-0", { operator_id: oid, account_threshold: 3 });
  check("after clear: caller's account count back to 0", after.account_count === 0 && after.locked === false);
  check("clearFailures no-op with no keys",              (await os.clearFailures({})).cleared === 0);
}

async function run() {
  await _createHappyPathAndAudit();
  await _createBadInput();
  await _verifyHappyPathAndIpBinding();
  await _mfaGateAndRecordMfaVerification();
  await _requireMfaPeerWiring();
  await _verifyExpiredReturnsNull();
  await _revokeBlocksVerify();
  await _lockoutThresholdTrip();
  await _lockoutPerAccountAndClear();
  await _listForOperatorAndExpire();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/operator-sessions.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — operator-sessions (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — operator-sessions: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
