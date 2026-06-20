"use strict";
/**
 * customer-impersonation — operator login-as-customer with strict
 * audit + automatic timeout + customer notification.
 *
 * Layer 1 against in-memory node:sqlite with migration 0190 loaded.
 * The operatorRoles + operatorAuditLog + notifications peers are all
 * stubbed locally so this test exercises the primitive in isolation.
 *
 * Coverage:
 *   - startImpersonation happy path + plaintext token returned once +
 *     row stored with namespaceHash + expires_at = started_at + ttl
 *   - startImpersonation capability gate via operatorRoles stub —
 *     refused when hasPermission returns false; passed when true
 *   - verifyImpersonationToken hit / miss / expired / terminal paths
 *   - notifyCustomer fans out through notifications stub +
 *     customer_notified_at stamps + idempotent re-notify
 *   - endImpersonation flips status + audit row + idempotent on
 *     terminal row
 *   - actionsRecord captures audit row + refuses on non-active session
 *     + refuses on elapsed expires_at
 *   - cleanupExpired sweeps the active set; verify refuses post-sweep
 *   - listForOperator + listForCustomer + currentlyImpersonating
 *   - factory refusals: bad operatorRoles / operatorAuditLog /
 *     notifications shapes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var customerImpersonation = require("../../lib/customer-impersonation");
var bShop                 = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..",
  "migrations-d1", "0190_customer_impersonation.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var queryFn = async function (sql, params) {
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
  queryFn.__db = db;
  return queryFn;
}

// Operator roles stub — exposes hasPermission in the shape the
// primitive expects. `allow` toggles the answer; `calls` captures the
// invocation so the test can assert the capability string actually
// reached the peer.
function _rolesStub(opts) {
  opts = opts || {};
  var calls = [];
  return {
    hasPermission: async function (input) {
      calls.push(input);
      if (opts.throws) throw new Error(opts.throws);
      return opts.allow === false ? false : true;
    },
    calls: calls,
  };
}

// Audit-log stub — captures every record() call.
function _auditStub() {
  var rows = [];
  return {
    record: async function (input) { rows.push(input); return { ok: true }; },
    rows:   rows,
  };
}

// Notifications stub — captures every enqueue() call. `throws` makes
// the next call reject so the test can assert the primitive surfaces
// the failure (customer notification is part of the audit contract;
// silent drop is not acceptable).
function _notifStub(opts) {
  opts = opts || {};
  var calls = [];
  return {
    enqueue: async function (input) {
      if (opts.throws) throw new Error(opts.throws);
      calls.push(input);
      return { ok: true, id: "notif-" + calls.length };
    },
    calls: calls,
  };
}

function _operatorId() { return bShop.framework.uuid.v7(); }
function _customerId() { return bShop.framework.uuid.v7(); }

async function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var svc = customerImpersonation.create({
    query:            q,
    operatorRoles:    opts.operatorRoles    || null,
    operatorAuditLog: opts.operatorAuditLog || null,
    notifications:    opts.notifications    || null,
  });
  return { q: q, svc: svc };
}

async function _startImpersonationAndCapabilityGate() {
  // Without operatorRoles — primitive trusts the caller
  var noPeer = await _wire();
  var operatorId = _operatorId();
  var customerId = _customerId();
  var session = await noPeer.svc.startImpersonation({
    operator_id: operatorId, customer_id: customerId,
    reason:      "debug broken cart flow",
  });
  check("startImpersonation returns impersonation_id",
    typeof session.impersonation_id === "string" && session.impersonation_id.length > 0);
  check("startImpersonation returns plaintext token",
    typeof session.plaintext_token === "string" && session.plaintext_token.length > 0);
  check("startImpersonation expires_at = started_at + 60min",
    Number(session.expires_at) === Number(session.started_at) + 60 * 60 * 1000);
  // The plaintext is base64url of 32 random bytes — 43 chars, alnum + _-.
  check("startImpersonation plaintext shape",
    /^[A-Za-z0-9_-]{43}$/.test(session.plaintext_token));

  // The stored token_hash is the namespaceHash of the plaintext; the
  // raw plaintext never persists.
  var rows = (await noPeer.q(
    "SELECT token_hash FROM impersonations WHERE id = ?1",
    [session.impersonation_id],
  )).rows;
  var expectedHash = bShop.framework.crypto.namespaceHash(
    customerImpersonation.TOKEN_NAMESPACE, session.plaintext_token,
  );
  check("token_hash matches namespaceHash", rows[0].token_hash === expectedHash);

  // With operatorRoles wired + allow=false — refused with typed code
  var rolesDeny  = _rolesStub({ allow: false });
  var denied = await _wire({ operatorRoles: rolesDeny });
  await assert.rejects(
    denied.svc.startImpersonation({
      operator_id: _operatorId(), customer_id: _customerId(),
      reason:      "audit denied path",
    }),
    function (e) {
      return e.code === "IMPERSONATION_CAPABILITY_REFUSED" &&
             /lacks capability can_impersonate_customer/.test(e.message);
    },
  );
  check("roles peer invoked with default capability",
    rolesDeny.calls.length === 1 &&
    rolesDeny.calls[0].permission === "can_impersonate_customer");

  // With operatorRoles wired + allow=true — passes
  var rolesAllow = _rolesStub({ allow: true });
  var ok = await _wire({ operatorRoles: rolesAllow });
  var passed = await ok.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "allowed flow",
  });
  check("startImpersonation with peer allow=true succeeds",
    typeof passed.plaintext_token === "string");

  // Custom requires_capability — peer receives the operator's choice
  var rolesAllow2 = _rolesStub({ allow: true });
  var custom = await _wire({ operatorRoles: rolesAllow2 });
  await custom.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "custom capability",
    requires_capability: "can_impersonate_customer_pii",
  });
  check("custom capability reaches peer",
    rolesAllow2.calls[0].permission === "can_impersonate_customer_pii");

  // Input refusals
  await assert.rejects(noPeer.svc.startImpersonation(),                              /input object required/);
  await assert.rejects(noPeer.svc.startImpersonation({}),                            /operator_id/);
  await assert.rejects(noPeer.svc.startImpersonation({
    operator_id: "not-a-uuid", customer_id: _customerId(), reason: "x",
  }), /operator_id/);
  await assert.rejects(noPeer.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: "bad", reason: "x",
  }), /customer_id/);
  await assert.rejects(noPeer.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(), reason: "",
  }), /reason/);
  await assert.rejects(noPeer.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason: "x", ttl_seconds: 5,
  }), /ttl_seconds/);
  await assert.rejects(noPeer.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason: "x", ttl_seconds: 999999,
  }), /ttl_seconds/);
}

async function _verifyImpersonationToken() {
  var audit = _auditStub();
  var w = await _wire({ operatorAuditLog: audit });
  var operatorId = _operatorId();
  var customerId = _customerId();
  var session = await w.svc.startImpersonation({
    operator_id: operatorId, customer_id: customerId,
    reason:      "verify path", ttl_seconds: 60,
  });

  // Hit
  var ctx = await w.svc.verifyImpersonationToken(session.plaintext_token);
  check("verify hit impersonation_id",  ctx && ctx.impersonation_id === session.impersonation_id);
  check("verify hit operator_id",       ctx.operator_id === operatorId);
  check("verify hit customer_id",       ctx.customer_id === customerId);
  check("verify hit reason",            ctx.reason === "verify path");
  check("verify hit expires_at",        ctx.expires_at === session.expires_at);

  // Miss on unknown token
  var missCtx = await w.svc.verifyImpersonationToken("a".repeat(43));
  check("verify miss returns null",     missCtx === null);

  // Empty / non-string input
  check("verify empty string null",     (await w.svc.verifyImpersonationToken("")) === null);
  check("verify non-string null",       (await w.svc.verifyImpersonationToken(null)) === null);
  check("verify number null",           (await w.svc.verifyImpersonationToken(42)) === null);

  // Audit row from startImpersonation captured
  check("audit row from start",         audit.rows.length === 1 &&
                                        audit.rows[0].action === "impersonation.start" &&
                                        audit.rows[0].actor_id === operatorId &&
                                        audit.rows[0].resource_id === session.impersonation_id);

  // End the session — verify now refuses
  await w.svc.endImpersonation({
    impersonation_id: session.impersonation_id,
    ended_by: "operator", reason: "done debugging",
  });
  var afterEnd = await w.svc.verifyImpersonationToken(session.plaintext_token);
  check("verify after end returns null", afterEnd === null);
  check("audit row from end",            audit.rows.length === 2 &&
                                         audit.rows[1].action === "impersonation.end");
}

async function _verifyExpiredAndCleanupSweep() {
  var w = await _wire();
  var session = await w.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason: "expiry path", ttl_seconds: 60,
  });
  // Hand-rewrite expires_at into the past so the verify gate refuses
  // even though cleanupExpired hasn't run yet.
  await w.q(
    "UPDATE impersonations SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 1000, session.impersonation_id],
  );
  var elapsed = await w.svc.verifyImpersonationToken(session.plaintext_token);
  check("verify refuses elapsed expires_at", elapsed === null);

  // The row's status is still `active` (sweep hasn't run). cleanupExpired
  // flips it to expired and returns the count.
  var pre = await w.svc.getSession(session.impersonation_id);
  check("pre-sweep status still active",      pre.status === "active");
  var swept = await w.svc.cleanupExpired();
  check("cleanupExpired swept count",         swept.swept === 1);
  var post = await w.svc.getSession(session.impersonation_id);
  check("post-sweep status expired",          post.status === "expired");
  check("post-sweep end_reason recorded",     /auto-timeout/.test(post.end_reason));
  check("post-sweep ended_at stamped",        typeof post.ended_at === "number" && post.ended_at > 0);

  // Idempotent — second sweep finds nothing
  var sweep2 = await w.svc.cleanupExpired();
  check("cleanupExpired idempotent",          sweep2.swept === 0);
}

async function _notifyCustomerFanout() {
  var notif = _notifStub();
  var w = await _wire({ notifications: notif });
  var operatorId = _operatorId();
  var customerId = _customerId();
  var session = await w.svc.startImpersonation({
    operator_id: operatorId, customer_id: customerId,
    reason:      "support call ticket-42",
  });

  // First call enqueues + stamps customer_notified_at
  var n1 = await w.svc.notifyCustomer({ impersonation_id: session.impersonation_id });
  check("notify enqueued",                  notif.calls.length === 1);
  check("notify recipient = customer",      notif.calls[0].recipient_id === customerId);
  check("notify channel",                   notif.calls[0].channel === "account-impersonation");
  check("notify event_type",                notif.calls[0].event_type === "customer_impersonation_started");
  check("notify payload operator_id",       notif.calls[0].payload.operator_id === operatorId);
  check("notify payload reason",            notif.calls[0].payload.reason === "support call ticket-42");
  check("notify returns stamp",             typeof n1.customer_notified_at === "number");

  // Re-notify is idempotent — no second enqueue
  var n2 = await w.svc.notifyCustomer({ impersonation_id: session.impersonation_id });
  check("re-notify does not re-enqueue",    notif.calls.length === 1);
  check("re-notify returns same stamp",     n2.customer_notified_at === n1.customer_notified_at);

  // Concurrent double-notify must enqueue EXACTLY once — both callers
  // read a null stamp before either UPDATEs, but the conditional claim
  // (`... WHERE customer_notified_at IS NULL`) lets only one win and
  // enqueue; the loser re-reads the winner's stamp. Without the claim
  // both fire `notifications.enqueue` and the customer is notified twice.
  var raceNotif = _notifStub();
  var raceW = await _wire({ notifications: raceNotif });
  var raceSession = await raceW.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "concurrent notify",
  });
  var raceResults = await Promise.all([
    raceW.svc.notifyCustomer({ impersonation_id: raceSession.impersonation_id }),
    raceW.svc.notifyCustomer({ impersonation_id: raceSession.impersonation_id }),
  ]);
  check("concurrent notify enqueues once",  raceNotif.calls.length === 1);
  check("concurrent notify both notified",  raceResults[0].notified === true &&
                                            raceResults[1].notified === true);
  check("concurrent notify same stamp",     raceResults[0].customer_notified_at ===
                                            raceResults[1].customer_notified_at);

  // Without notifications wired — returns notified: false
  var bare = await _wire();
  var bareSession = await bare.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "no notif peer",
  });
  var bareNotif = await bare.svc.notifyCustomer({ impersonation_id: bareSession.impersonation_id });
  check("notify without peer notified=false", bareNotif.notified === false);
  check("notify without peer stamp=null",     bareNotif.customer_notified_at === null);

  // notifications peer throwing surfaces — silent drop would weaken
  // the audit contract.
  var failNotif = _notifStub({ throws: "notifications-down" });
  var failW = await _wire({ notifications: failNotif });
  var failSession = await failW.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "notifications outage",
  });
  await assert.rejects(
    failW.svc.notifyCustomer({ impersonation_id: failSession.impersonation_id }),
    /notifications-down/,
  );
  // customer_notified_at was NOT stamped — the row stays in the
  // "needs out-of-band notification" state.
  var stillNull = await failW.svc.getSession(failSession.impersonation_id);
  check("notify failure leaves stamp null",   stillNull.customer_notified_at === null);

  // notify on unknown impersonation refuses
  await assert.rejects(
    bare.svc.notifyCustomer({ impersonation_id: _operatorId() }),
    function (e) { return e.code === "IMPERSONATION_NOT_FOUND"; },
  );
  await assert.rejects(bare.svc.notifyCustomer(),                                      /input object required/);
}

async function _actionsRecordAudit() {
  var w = await _wire();
  var session = await w.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "audit trail test",
  });

  var orderId   = bShop.framework.uuid.v7();
  var addressId = bShop.framework.uuid.v7();
  var act1 = await w.svc.actionsRecord({
    impersonation_id: session.impersonation_id,
    action:           "view",
    resource_kind:    "order",
    resource_id:      orderId,
  });
  check("actionsRecord returns row id",     typeof act1.id === "string" && act1.id.length > 0);
  check("actionsRecord stamps occurred_at", typeof act1.occurred_at === "number" && act1.occurred_at > 0);

  var act2 = await w.svc.actionsRecord({
    impersonation_id: session.impersonation_id,
    action:           "update",
    resource_kind:    "address",
    resource_id:      addressId,
  });
  // Monotonic clock — strict-increasing across same-ms records
  check("actionsRecord monotonic",          act2.occurred_at > act1.occurred_at);

  // Timeline read — oldest-first
  var timeline = await w.svc.actionsForSession(session.impersonation_id);
  check("actionsForSession count",           timeline.length === 2);
  check("actionsForSession order [0]",       timeline[0].action === "view" &&
                                             timeline[0].resource_id === orderId);
  check("actionsForSession order [1]",       timeline[1].action === "update" &&
                                             timeline[1].resource_id === addressId);

  // End the session — actions on terminal session refused
  await w.svc.endImpersonation({
    impersonation_id: session.impersonation_id,
    ended_by: "operator", reason: "done",
  });
  await assert.rejects(
    w.svc.actionsRecord({
      impersonation_id: session.impersonation_id,
      action:           "view",
      resource_kind:    "order",
      resource_id:      bShop.framework.uuid.v7(),
    }),
    function (e) { return e.code === "IMPERSONATION_NOT_ACTIVE"; },
  );

  // Actions on unknown impersonation refused
  await assert.rejects(
    w.svc.actionsRecord({
      impersonation_id: bShop.framework.uuid.v7(),
      action: "view", resource_kind: "order", resource_id: orderId,
    }),
    function (e) { return e.code === "IMPERSONATION_NOT_FOUND"; },
  );

  // Defensive — elapsed expires_at refused even on `active` row
  var session2 = await w.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "elapsed action path",
  });
  await w.q(
    "UPDATE impersonations SET expires_at = ?1 WHERE id = ?2",
    [Date.now() - 1000, session2.impersonation_id],
  );
  await assert.rejects(
    w.svc.actionsRecord({
      impersonation_id: session2.impersonation_id,
      action: "view", resource_kind: "order", resource_id: orderId,
    }),
    function (e) { return e.code === "IMPERSONATION_EXPIRED"; },
  );

  // Input refusals
  await assert.rejects(w.svc.actionsRecord(),                                          /input object required/);
  await assert.rejects(w.svc.actionsRecord({}),                                        /impersonation_id/);
}

async function _listForOperatorAndCustomer() {
  var w = await _wire();
  var operatorA = _operatorId();
  var operatorB = _operatorId();
  var customerX = _customerId();
  var customerY = _customerId();

  var s1 = await w.svc.startImpersonation({ operator_id: operatorA, customer_id: customerX, reason: "a-x" });
  var s2 = await w.svc.startImpersonation({ operator_id: operatorA, customer_id: customerY, reason: "a-y" });
  var s3 = await w.svc.startImpersonation({ operator_id: operatorB, customer_id: customerX, reason: "b-x" });

  // listForOperator
  var aRows = await w.svc.listForOperator(operatorA);
  check("listForOperator count",            aRows.length === 2);
  check("listForOperator newest first",     aRows[0].id === s2.impersonation_id &&
                                            aRows[1].id === s1.impersonation_id);

  // active_only
  await w.svc.endImpersonation({
    impersonation_id: s1.impersonation_id, ended_by: "operator", reason: "wrap",
  });
  var aActive = await w.svc.listForOperator(operatorA, { active_only: true });
  check("listForOperator active_only",       aActive.length === 1 && aActive[0].id === s2.impersonation_id);
  var aAll = await w.svc.listForOperator(operatorA, { active_only: false });
  check("listForOperator active_only=false", aAll.length === 2);

  // listForCustomer
  var xRows = await w.svc.listForCustomer(customerX);
  check("listForCustomer count",             xRows.length === 2);
  check("listForCustomer operators distinct", xRows.some(function (r) { return r.id === s1.impersonation_id; }) &&
                                              xRows.some(function (r) { return r.id === s3.impersonation_id; }));

  // currentlyImpersonating — every active row across operators
  var cur = await w.svc.currentlyImpersonating();
  check("currentlyImpersonating count",      cur.length === 2);
  check("currentlyImpersonating only active", cur.every(function (r) { return r.status === "active"; }));
}

async function _endImpersonationIdempotent() {
  var w = await _wire();
  var session = await w.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "end idempotent",
  });
  var e1 = await w.svc.endImpersonation({
    impersonation_id: session.impersonation_id, ended_by: "operator", reason: "first end",
  });
  check("first end returns ended=true",      e1.ended === true);
  var e2 = await w.svc.endImpersonation({
    impersonation_id: session.impersonation_id, ended_by: "operator", reason: "second end",
  });
  check("second end returns ended=false",    e2.ended === false);

  // End on unknown id refused
  await assert.rejects(
    w.svc.endImpersonation({
      impersonation_id: bShop.framework.uuid.v7(),
      ended_by: "operator", reason: "ghost",
    }),
    function (err) { return err.code === "IMPERSONATION_NOT_FOUND"; },
  );

  // Input refusals
  await assert.rejects(w.svc.endImpersonation(),                                       /input object required/);
  await assert.rejects(w.svc.endImpersonation({
    impersonation_id: session.impersonation_id,
  }), /ended_by/);
  await assert.rejects(w.svc.endImpersonation({
    impersonation_id: session.impersonation_id, ended_by: "operator",
  }), /reason/);

  // Revoke distinguished from end
  var s2 = await w.svc.startImpersonation({
    operator_id: _operatorId(), customer_id: _customerId(),
    reason:      "revoke path",
  });
  var r1 = await w.svc.revoke({
    impersonation_id: s2.impersonation_id, reason: "supervisor override",
  });
  check("revoke returns revoked=true",       r1.revoked === true);
  var post = await w.svc.getSession(s2.impersonation_id);
  check("revoke flips status to revoked",    post.status === "revoked");
  check("revoke captures end_reason",        post.end_reason === "supervisor override");
}

async function _factoryRefusals() {
  // operatorRoles without hasPermission refused
  assert.throws(function () {
    customerImpersonation.create({ query: function () {}, operatorRoles: {} });
  }, /hasPermission/);

  // operatorAuditLog without record refused
  assert.throws(function () {
    customerImpersonation.create({ query: function () {}, operatorAuditLog: {} });
  }, /record/);

  // notifications without enqueue refused
  assert.throws(function () {
    customerImpersonation.create({ query: function () {}, notifications: {} });
  }, /enqueue/);
}

async function run() {
  await _startImpersonationAndCapabilityGate();
  await _verifyImpersonationToken();
  await _verifyExpiredAndCleanupSweep();
  await _notifyCustomerFanout();
  await _actionsRecordAudit();
  await _listForOperatorAndCustomer();
  await _endImpersonationIdempotent();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("customer-impersonation: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
