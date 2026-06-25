"use strict";
/**
 * apiKeys — operator-issued bearer tokens for third-party access to
 * admin endpoints.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0064_api_keys.sql. The plaintext token is returned ONCE on issue
 * (and ONCE on rotate); every subsequent read goes through the hash.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/api-keys.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - issueKey: persists hash, returns plaintext exactly once, stamps
 *     43-char base64url plaintext + 6-char token_hint, owner_type +
 *     scopes round-trip
 *   - issueKey: refusal classes (missing input, bad owner_type, empty
 *     scopes, bad scope alphabet, oversize name, control bytes, bad
 *     rate_limit)
 *   - verifyToken happy path: active key resolves to the auth context
 *   - verifyToken refusals: revoked, expired (via expires_at), rotated
 *     beyond grace, unknown plaintext, malformed plaintext
 *   - rotate: 24h grace — old hash still verifies inside the window,
 *     refuses outside; new hash verifies immediately; double-rotate
 *     refused
 *   - revoke: immediate effect on verify; idempotent on already-revoked
 *   - update: scopes + rate_limit + name patch; refused columns; refused
 *     on non-active key
 *   - recordUse: log append + last_used_at bump; usageForKey range
 *     read
 *   - listForOwner: filters by owner_type + owner_id; nullable owner_id
 *   - cleanupExpired: sweeps elapsed expires_at into terminal `expired`
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var apiKeys = require("../../lib/api-keys");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0064_api_keys.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
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

function _setup() {
  var h = _makeQuery();
  var ak = apiKeys.create({ query: h.query });
  return { db: h.db, query: h.query, apiKeys: ak };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

function _validIssue(overrides) {
  return Object.assign({
    owner_type:             "operator",
    name:                   "ops-dashboard",
    scopes:                 ["admin:read", "admin:write"],
    rate_limit_per_minute:  60,
  }, overrides || {});
}

var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function _issueHappyPath() {
  var ctx = _setup();
  var issued = await ctx.apiKeys.issueKey(_validIssue());
  check("issue returns 36-char uuid key_id",
    typeof issued.key_id === "string" && issued.key_id.length === 36);
  check("issue returns 43-char base64url plaintext",
    typeof issued.plaintext_token === "string" && TOKEN_RE.test(issued.plaintext_token));
  check("issue returns 6-char token_hint",
    typeof issued.token_hint === "string" && issued.token_hint.length === 6);
  check("token_hint is last 6 of plaintext",
    issued.token_hint === issued.plaintext_token.slice(issued.plaintext_token.length - 6));
  check("issue returns owner_type",   issued.owner_type === "operator");
  check("issue returns owner_id null when omitted", issued.owner_id == null);
  check("issue returns scopes sorted + deduped",
    Array.isArray(issued.scopes) && issued.scopes.length === 2 && issued.scopes[0] === "admin:read");
  check("issue returns rate_limit_per_minute", Number(issued.rate_limit_per_minute) === 60);
  check("issue stamps created_at",   typeof issued.created_at === "number");

  // Stored row has no plaintext.
  var stored = await ctx.apiKeys.getKey(issued.key_id);
  check("getKey returns row",            stored != null);
  check("stored row has no plaintext",   Object.keys(stored).indexOf("plaintext_token") === -1);
  check("stored row exposes token_hash (hex SHA3-512)",
    typeof stored.token_hash === "string" && /^[0-9a-f]{128}$/.test(stored.token_hash));
  check("stored row status active",      stored.status === "active");
  check("stored row active flag true",   stored.active === true);
  check("stored row scopes round-trip",
    stored.scopes.length === 2 && stored.scopes.indexOf("admin:read") !== -1);
  check("stored row token_hash_previous null", stored.token_hash_previous == null);
  check("stored row rotated_at null",    stored.rotated_at == null);
  check("stored row revoked_at null",    stored.revoked_at == null);

  // Two issues produce distinct plaintext + distinct hashes.
  var issued2 = await ctx.apiKeys.issueKey(_validIssue({ name: "second-key" }));
  check("two issues produce distinct plaintext",
    issued.plaintext_token !== issued2.plaintext_token);
  var stored2 = await ctx.apiKeys.getKey(issued2.key_id);
  check("two issues produce distinct hashes",
    stored.token_hash !== stored2.token_hash);
}

async function _issueRefusals() {
  var ctx = _setup();
  await assert.rejects(ctx.apiKeys.issueKey(),                            /input object required/);
  await assert.rejects(ctx.apiKeys.issueKey(null),                        /input object required/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ owner_type: "root" })), /owner_type/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ owner_type: 123 })),    /owner_type/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ name: "" })),           /name/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ name: "   " })),        /name/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ name: "x\x00y" })),     /control/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ name: "x​y" })),   /zero-width/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ scopes: [] })),         /at least one/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ scopes: "admin:read" })), /array/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ scopes: ["Admin:Read"] })), /scope alphabet/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ scopes: ["admin read"] })), /scope alphabet/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ scopes: [42] })),       /must be a string/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ rate_limit_per_minute: -1 })), /rate_limit/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ rate_limit_per_minute: 1.5 })), /rate_limit/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ rate_limit_per_minute: 10000000 })), /rate_limit/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ owner_id: "not-a-uuid" })), /owner_id/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ expires_at: -1 })),     /expires_at/);
  await assert.rejects(ctx.apiKeys.issueKey(_validIssue({ expires_at: 0 })),      /expires_at/);
}

async function _verifyHappyAndRefusals() {
  var ctx = _setup();
  var issued = await ctx.apiKeys.issueKey(_validIssue({
    owner_type: "tenant",
    owner_id:   _validUUID(),
  }));

  var ok = await ctx.apiKeys.verifyToken(issued.plaintext_token);
  check("verify happy returns key_id",         ok != null && ok.key_id === issued.key_id);
  check("verify happy returns owner_type",     ok.owner_type === "tenant");
  check("verify happy returns owner_id",       ok.owner_id === issued.owner_id);
  check("verify happy returns scopes",         Array.isArray(ok.scopes) && ok.scopes.length === 2);
  check("verify happy returns rate_limit",     Number(ok.rate_limit_per_minute) === 60);
  check("verify happy active true",            ok.active === true);

  // Malformed plaintext refused at the validator boundary.
  await assert.rejects(ctx.apiKeys.verifyToken(""),               /non-empty/);
  await assert.rejects(ctx.apiKeys.verifyToken("short"),          /43 base64url/);
  await assert.rejects(ctx.apiKeys.verifyToken("x".repeat(43) + "!"), /non-empty|43 base64url/);

  // Unknown plaintext → null (no leak between "not found" and "wrong hash").
  var nonexistent = "A".repeat(43);
  var miss = await ctx.apiKeys.verifyToken(nonexistent);
  check("verify unknown returns null",         miss === null);

  // Revoked key refused.
  var revoked = await ctx.apiKeys.revoke(issued.key_id, "operator request");
  check("revoke transitions status",           revoked.status === "revoked");
  check("revoke stamps revoke_reason",         revoked.revoke_reason === "operator request");
  check("revoke stamps revoked_at",            typeof revoked.revoked_at === "number");
  var afterRevoke = await ctx.apiKeys.verifyToken(issued.plaintext_token);
  check("verify after revoke returns null",    afterRevoke === null);

  // Re-revoke is idempotent.
  var reRevoked = await ctx.apiKeys.revoke(issued.key_id, "again");
  check("re-revoke idempotent (still revoked)", reRevoked.status === "revoked");

  // Revoke on unknown -> throws.
  await assert.rejects(ctx.apiKeys.revoke(_validUUID(), "x"),      /not found/);
  // Reason validation.
  await assert.rejects(ctx.apiKeys.revoke(issued.key_id, ""),      /non-empty/);
  await assert.rejects(ctx.apiKeys.revoke(issued.key_id, "x\x00y"), /control/);

  // Expired by expires_at - verify refuses even though status is still active.
  var soonExpiry = Date.now() - 1000;
  // We can't pass past-expiry through issueKey's validator (it's
  // technically allowed as a positive int); test by stamping
  // expires_at in the future then advancing the clock via opts.now.
  var futureExpiry = Date.now() + 60000;
  var withExpiry = await ctx.apiKeys.issueKey(_validIssue({
    name:       "expiring-key",
    expires_at: futureExpiry,
  }));
  var preExpiry = await ctx.apiKeys.verifyToken(withExpiry.plaintext_token, { now: futureExpiry - 1 });
  check("verify pre-expiry returns key",       preExpiry != null && preExpiry.key_id === withExpiry.key_id);
  var postExpiry = await ctx.apiKeys.verifyToken(withExpiry.plaintext_token, { now: futureExpiry });
  check("verify at expiry returns null",       postExpiry === null);
  var wayPostExpiry = await ctx.apiKeys.verifyToken(withExpiry.plaintext_token, { now: futureExpiry + 1 });
  check("verify post-expiry returns null",     wayPostExpiry === null);
  // soonExpiry sanity check.
  check("soonExpiry is in the past",           soonExpiry < Date.now());
}

async function _rotateGracePeriod() {
  var ctx = _setup();
  var issued = await ctx.apiKeys.issueKey(_validIssue({ name: "to-rotate" }));
  var oldPlaintext = issued.plaintext_token;

  // Pre-rotate: only the live plaintext verifies.
  var pre = await ctx.apiKeys.verifyToken(oldPlaintext);
  check("pre-rotate verify ok",                pre != null && pre.key_id === issued.key_id);

  var rotated = await ctx.apiKeys.rotate(issued.key_id);
  check("rotate returns new key_id",           rotated.key_id !== issued.key_id);
  check("rotate returns previous_key_id",      rotated.previous_key_id === issued.key_id);
  check("rotate returns new plaintext",        TOKEN_RE.test(rotated.plaintext_token));
  check("rotate plaintext differs from old",   rotated.plaintext_token !== oldPlaintext);
  check("rotate carries scopes forward",
    rotated.scopes.length === 2 && rotated.scopes.indexOf("admin:read") !== -1);
  check("rotate returns rotation_grace_ms",    rotated.rotation_grace_ms === 24 * 60 * 60 * 1000);

  // Old plaintext still verifies inside the grace window.
  var graceOk = await ctx.apiKeys.verifyToken(oldPlaintext);
  check("old plaintext verifies in grace",     graceOk != null && graceOk.key_id === issued.key_id);

  // New plaintext verifies (on the new row).
  var newOk = await ctx.apiKeys.verifyToken(rotated.plaintext_token);
  check("new plaintext verifies",              newOk != null && newOk.key_id === rotated.key_id);

  // The rotated row's status is `rotated`.
  var rotatedRow = await ctx.apiKeys.getKey(issued.key_id);
  check("rotated row status = rotated",        rotatedRow.status === "rotated");
  check("rotated row carries token_hash_previous", typeof rotatedRow.token_hash_previous === "string" && /^[0-9a-f]{128}$/.test(rotatedRow.token_hash_previous));
  check("rotated row stamps rotated_at",       typeof rotatedRow.rotated_at === "number");

  // Outside the grace window: old plaintext refuses.
  var pastGrace = Number(rotatedRow.rotated_at) + 24 * 60 * 60 * 1000 + 1;
  var graceExpired = await ctx.apiKeys.verifyToken(oldPlaintext, { now: pastGrace });
  check("old plaintext refuses past grace",    graceExpired === null);
  // New plaintext still works past the old row's grace (new row is active).
  var newPostGrace = await ctx.apiKeys.verifyToken(rotated.plaintext_token, { now: pastGrace });
  check("new plaintext verifies past old grace", newPostGrace != null);

  // Double-rotate refused — the rotated row is no longer active.
  await assert.rejects(ctx.apiKeys.rotate(issued.key_id),    /API_KEY_NOT_ROTATABLE|is rotated/);

  // Rotate on unknown -> throws.
  await assert.rejects(ctx.apiKeys.rotate(_validUUID()),     /not found/);

  // Rotate on revoked -> throws.
  var revoked = await ctx.apiKeys.issueKey(_validIssue({ name: "revoke-then-rotate" }));
  await ctx.apiKeys.revoke(revoked.key_id, "for test");
  await assert.rejects(ctx.apiKeys.rotate(revoked.key_id),   /API_KEY_NOT_ROTATABLE|is revoked/);
}

async function _updateAndScopeChange() {
  var ctx = _setup();
  var issued = await ctx.apiKeys.issueKey(_validIssue());

  // Rate-limit change round-trips and is visible on verify.
  var bumped = await ctx.apiKeys.update(issued.key_id, { rate_limit_per_minute: 5 });
  check("update returns row",                  bumped != null);
  check("update applies rate_limit",           Number(bumped.rate_limit_per_minute) === 5);

  var verifyAfter = await ctx.apiKeys.verifyToken(issued.plaintext_token);
  check("verify reflects new rate_limit",      Number(verifyAfter.rate_limit_per_minute) === 5);

  // Scope set update + sort + dedupe.
  var rescoped = await ctx.apiKeys.update(issued.key_id, {
    scopes: ["admin:read", "admin:read", "admin:billing", "admin:write"],
  });
  check("update dedupes scopes",               rescoped.scopes.length === 3);
  check("update sorts scopes",                 rescoped.scopes[0] === "admin:billing");
  var verifyScopes = await ctx.apiKeys.verifyToken(issued.plaintext_token);
  check("verify reflects new scopes",          verifyScopes.scopes.length === 3);

  // Name update.
  var renamed = await ctx.apiKeys.update(issued.key_id, { name: "renamed" });
  check("update renames",                      renamed.name === "renamed");

  // Forbidden columns refused.
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { owner_type: "app" }),    /not updatable/);
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { token_hash: "xxx" }),    /not updatable/);
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { status: "revoked" }),    /not updatable/);
  await assert.rejects(ctx.apiKeys.update(issued.key_id, {}),                       /at least one column/);

  // Validation on patched values.
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { rate_limit_per_minute: -1 }), /rate_limit/);
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { scopes: [] }),           /at least one/);
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { scopes: ["BAD SCOPE"] }), /scope alphabet/);
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { name: "" }),             /name/);

  // Unknown key -> null.
  var noop = await ctx.apiKeys.update(_validUUID(), { name: "x" });
  check("update unknown -> null",              noop === null);

  // Update on revoked refuses.
  await ctx.apiKeys.revoke(issued.key_id, "for refusal test");
  await assert.rejects(ctx.apiKeys.update(issued.key_id, { name: "later" }),        /API_KEY_NOT_UPDATABLE|is revoked/);
}

async function _recordUseAndUsageLog() {
  var ctx = _setup();
  var issued = await ctx.apiKeys.issueKey(_validIssue());

  var t0 = 1_700_000_000_000;
  var u1 = await ctx.apiKeys.recordUse({ key_id: issued.key_id, endpoint: "/admin/orders", occurred_at: t0 });
  check("recordUse returns id",                typeof u1.id === "string" && u1.id.length === 36);
  check("recordUse echoes key_id",             u1.key_id === issued.key_id);
  check("recordUse echoes endpoint",           u1.endpoint === "/admin/orders");
  check("recordUse echoes occurred_at",        Number(u1.occurred_at) === t0);

  var u2 = await ctx.apiKeys.recordUse({ key_id: issued.key_id, endpoint: "/admin/inventory", occurred_at: t0 + 1000 });
  check("recordUse second row distinct id",    u2.id !== u1.id);

  // last_used_at bumped on the parent.
  var parent = await ctx.apiKeys.getKey(issued.key_id);
  check("last_used_at bumped to latest",       Number(parent.last_used_at) === t0 + 1000);

  // usageForKey reads back both rows in range.
  var inRange = await ctx.apiKeys.usageForKey({ key_id: issued.key_id, from: t0 - 1, to: t0 + 2000 });
  check("usageForKey returns 2 rows",          inRange.length === 2);
  check("usageForKey ordered desc",            Number(inRange[0].occurred_at) >= Number(inRange[1].occurred_at));

  var outside = await ctx.apiKeys.usageForKey({ key_id: issued.key_id, from: t0 + 2000, to: t0 + 3000 });
  check("usageForKey empty outside range",     outside.length === 0);

  // Refusals.
  await assert.rejects(ctx.apiKeys.recordUse(),                                       /input object required/);
  await assert.rejects(ctx.apiKeys.recordUse({ key_id: _validUUID(), endpoint: "/x" }), /not found/);
  await assert.rejects(ctx.apiKeys.recordUse({ key_id: issued.key_id, endpoint: "" }), /endpoint/);
  await assert.rejects(ctx.apiKeys.recordUse({ key_id: issued.key_id, endpoint: "x\x00y" }), /control/);
  await assert.rejects(ctx.apiKeys.recordUse({ key_id: "not-a-uuid", endpoint: "/x" }), /key_id/);
  await assert.rejects(ctx.apiKeys.recordUse({ key_id: issued.key_id, endpoint: "/x", occurred_at: -1 }), /occurred_at/);
  await assert.rejects(ctx.apiKeys.usageForKey({ key_id: issued.key_id, from: 100, to: 50 }), /from must be <= to/);
}

async function _listForOwnerAndCleanup() {
  var ctx = _setup();
  var tenantId = _validUUID();
  var otherTenant = _validUUID();

  var k1 = await ctx.apiKeys.issueKey(_validIssue({ owner_type: "tenant", owner_id: tenantId, name: "t1-a" }));
  var k2 = await ctx.apiKeys.issueKey(_validIssue({ owner_type: "tenant", owner_id: tenantId, name: "t1-b" }));
  var k3 = await ctx.apiKeys.issueKey(_validIssue({ owner_type: "tenant", owner_id: otherTenant, name: "t2-a" }));
  var k4 = await ctx.apiKeys.issueKey(_validIssue({ owner_type: "operator", name: "global" }));

  var t1Keys = await ctx.apiKeys.listForOwner({ owner_type: "tenant", owner_id: tenantId });
  check("listForOwner filters by tenant",      t1Keys.length === 2);
  check("listForOwner returns t1-a + t1-b",
    t1Keys.map(function (r) { return r.id; }).sort().join(",") ===
    [k1.key_id, k2.key_id].sort().join(","));

  var t2Keys = await ctx.apiKeys.listForOwner({ owner_type: "tenant", owner_id: otherTenant });
  check("listForOwner second tenant isolated", t2Keys.length === 1 && t2Keys[0].id === k3.key_id);

  // Global operator key (owner_id null) is queryable via the
  // null-owner path.
  var operatorKeys = await ctx.apiKeys.listForOwner({ owner_type: "operator" });
  check("listForOwner null owner_id finds global", operatorKeys.length === 1 && operatorKeys[0].id === k4.key_id);

  // cleanupExpired sweeps elapsed expires_at.
  var t0 = 2_000_000_000_000;
  var expiring = await ctx.apiKeys.issueKey(_validIssue({ name: "soon-gone", expires_at: t0 + 1000 }));
  var stillActive = await ctx.apiKeys.issueKey(_validIssue({ name: "still-here", expires_at: t0 + 100000 }));

  var swept = await ctx.apiKeys.cleanupExpired({ now: t0 + 5000 });
  check("cleanupExpired returns count",        swept.swept === 1);
  var afterSweep = await ctx.apiKeys.getKey(expiring.key_id);
  check("expiring key status -> expired",      afterSweep.status === "expired");
  var stillActiveRow = await ctx.apiKeys.getKey(stillActive.key_id);
  check("non-expired key untouched",           stillActiveRow.status === "active");
  // Idempotent.
  var second = await ctx.apiKeys.cleanupExpired({ now: t0 + 5000 });
  check("cleanupExpired idempotent",           second.swept === 0);
}

// Prod-redaction regression for the issueKey token retry loop. A token_hash
// collision surfaces in production as a bare "HTTP 500" (the D1 service-binding
// redacts the SQLite "UNIQUE constraint failed" text), so the old
// indexOf("UNIQUE") gate would have re-thrown instead of regenerating. The
// first generated token_hash is held PERMANENTLY taken (every INSERT of it is
// redacted-rejected and the re-read confirms it), so issueKey can only succeed
// by REGENERATING a different token — proving the retry fires under the
// redacted error AND does not re-use the collided hash.
async function _issueKeyRetriesUnderRedactedCollision() {
  var h = _makeQuery();
  var firstHash = null;
  var q = async function (sql, params) {
    if (/INSERT INTO api_keys/.test(sql)) {
      if (firstHash === null) firstHash = params[5];               // token_hash column
      if (params[5] === firstHash) throw new Error("HTTP 500");    // the winner holds it; redacted, no "UNIQUE"
    }
    if (firstHash !== null && /SELECT id FROM api_keys WHERE token_hash/.test(sql) && params[0] === firstHash) {
      return { rows: [{ id: "winner" }] };                         // the re-read confirms the clash
    }
    return h.query(sql, params);
  };
  var ak = apiKeys.create({ query: q });
  var issued = await ak.issueKey(_validIssue());
  check("redacted-collision: issueKey resolves with a regenerated token (retry fired despite the bare HTTP 500)",
    typeof issued.plaintext_token === "string" && TOKEN_RE.test(issued.plaintext_token));
}

async function run() {
  await _issueHappyPath();
  await _issueKeyRetriesUnderRedactedCollision();
  await _issueRefusals();
  await _verifyHappyAndRefusals();
  await _rotateGracePeriod();
  await _updateAndScopeChange();
  await _recordUseAndUsageLog();
  await _listForOwnerAndCleanup();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - api-keys (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
