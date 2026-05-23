"use strict";
/**
 * notifications — queued + scheduled fan-out across in-app, email,
 * and webhook channels.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0024_notifications.sql. Coverage:
 *   - enqueue: hashed recipient_id, no plaintext stored, returns row
 *   - enqueue: preference-checked, opted-out refusal
 *   - markSent / markFailed / markRead / dismiss transitions + guards
 *   - scheduling: scheduled_at + pendingDueAt cutoff
 *   - unreadForRecipient: ordering, channel filter, limit
 *   - setPreference / getPreferences upsert + bulk read
 *   - cleanupOld: terminal-state retention reclaim
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_NOTIFS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0024_notifications.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_NOTIFS, "utf8")).forEach(function (s) {
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

async function _enqueueHashedAndStored() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });

  var res = await n.enqueue({
    recipient_id: "cust_abc123",
    channel:      "in-app",
    event_type:   "order.shipped",
    title:        "Your order shipped",
    body:         "Tracking: 1Z999",
    payload:      { order_id: "o_1", tracking: "1Z999" },
  });
  check("enqueue returns ok",       res.ok === true);
  check("enqueue returns uuid",     typeof res.id === "string" && res.id.length === 36);
  check("enqueue returns sched_at", Number.isInteger(res.scheduled_at) && res.scheduled_at > 0);

  // Round-trip — the persisted row holds hashes, not plaintext.
  var row = await n.get(res.id);
  check("row persisted",                row && row.id === res.id);
  check("recipient hash stored",        /^[0-9a-f]{128}$/.test(row.recipient_id_hash));
  check("recipient_id is hash too",     row.recipient_id === row.recipient_id_hash);
  check("no plaintext leak",            row.recipient_id.indexOf("cust_abc123") === -1);
  check("status is pending",            row.status === "pending");
  check("retry_count starts at 0",      Number(row.retry_count) === 0);
  check("payload_json round-trips",     JSON.parse(row.payload_json).order_id === "o_1");
  check("title round-trips",            row.title === "Your order shipped");
  check("body round-trips",             row.body === "Tracking: 1Z999");

  // hashRecipient is the same derivation.
  check("hashRecipient matches row",    n.hashRecipient("cust_abc123") === row.recipient_id_hash);
}

async function _enqueueRefusesOptedOut() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });

  // Opt the recipient out of (order.shipped, email).
  var pref = await n.setPreference({
    recipient_id: "cust_xyz",
    event_type:   "order.shipped",
    channel:      "email",
    enabled:      false,
  });
  check("preference persisted disabled", pref.enabled === 0);
  check("preference holds hash",         /^[0-9a-f]{128}$/.test(pref.recipient_id_hash));

  // Same event + channel → refused.
  var refused = await n.enqueue({
    recipient_id: "cust_xyz",
    channel:      "email",
    event_type:   "order.shipped",
    title:        "shipped",
  });
  check("opted-out refused",       refused.ok === false && refused.error === "opted-out");

  // Different channel for same event → still allowed.
  var allowed = await n.enqueue({
    recipient_id: "cust_xyz",
    channel:      "in-app",
    event_type:   "order.shipped",
    title:        "shipped",
  });
  check("other channel allowed",   allowed.ok === true);

  // Different event → still allowed on email.
  var allowed2 = await n.enqueue({
    recipient_id: "cust_xyz",
    channel:      "email",
    event_type:   "order.refunded",
    title:        "refund",
  });
  check("other event allowed",     allowed2.ok === true);

  // Re-enable → email/shipped goes through.
  await n.setPreference({
    recipient_id: "cust_xyz",
    event_type:   "order.shipped",
    channel:      "email",
    enabled:      true,
  });
  var reenabled = await n.enqueue({
    recipient_id: "cust_xyz",
    channel:      "email",
    event_type:   "order.shipped",
    title:        "shipped",
  });
  check("re-enabled allowed",      reenabled.ok === true);
}

async function _statusTransitions() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });
  var e = await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });

  // markSent
  var sent = await n.markSent(e.id);
  check("markSent status",       sent.status === "sent");
  check("markSent sent_at set",  Number.isInteger(sent.sent_at) && sent.sent_at > 0);

  // markSent twice — sent→sent is refused.
  await assert.rejects(n.markSent(e.id), /cannot transition/);

  // markFailed on a fresh row
  var e2 = await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });
  var failed = await n.markFailed(e2.id, { error: "smtp 451 temp" });
  check("markFailed status",     failed.status === "failed");
  check("retry_count bumped",    Number(failed.retry_count) === 1);
  check("last_error captured",   failed.last_error === "smtp 451 temp");

  // Re-fail bumps retry_count again.
  var failed2 = await n.markFailed(e2.id, { error: "smtp 500" });
  check("second fail bumps",     Number(failed2.retry_count) === 2);

  // failed → sent (retry succeeded) clears last_error.
  var recovered = await n.markSent(e2.id);
  check("failed→sent allowed",   recovered.status === "sent");
  check("last_error cleared",    recovered.last_error === null);

  // markRead requires in-app channel.
  var e3 = await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });
  await n.markSent(e3.id);
  await assert.rejects(n.markRead(e3.id), /only in-app/);

  // in-app markRead works.
  var e4 = await n.enqueue({ recipient_id: "r1", channel: "in-app", event_type: "order.shipped" });
  await n.markSent(e4.id);
  var read = await n.markRead(e4.id);
  check("markRead status",       read.status === "read");
  check("read_at set",           Number.isInteger(read.read_at) && read.read_at > 0);

  // dismiss
  var e5 = await n.enqueue({ recipient_id: "r1", channel: "in-app", event_type: "order.refunded" });
  var dismissed = await n.dismiss(e5.id);
  check("dismiss status",        dismissed.status === "dismissed");
  check("dismissed_at set",      Number.isInteger(dismissed.dismissed_at) && dismissed.dismissed_at > 0);
  // dismiss is idempotent.
  var redismiss = await n.dismiss(e5.id);
  check("dismiss idempotent",    redismiss.status === "dismissed");

  // Unknown id returns null.
  check("markSent unknown → null", (await n.markSent(bShop.framework.uuid.v7())) === null);
  check("markRead unknown → null", (await n.markRead(bShop.framework.uuid.v7())) === null);
  check("dismiss unknown → null",  (await n.dismiss(bShop.framework.uuid.v7())) === null);
  check("markFailed unknown → null",
    (await n.markFailed(bShop.framework.uuid.v7(), { error: "x" })) === null);
}

async function _schedulingAndPendingDueAt() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });
  var now = Date.now();

  var soon = await n.enqueue({
    recipient_id: "r1", channel: "in-app", event_type: "system.ping",
    scheduled_at: now - 1000,
  });
  var later = await n.enqueue({
    recipient_id: "r1", channel: "in-app", event_type: "system.ping",
    scheduled_at: now + 60000,
  });
  check("enqueue echoes scheduled_at (past)",   soon.scheduled_at === now - 1000);
  check("enqueue echoes scheduled_at (future)", later.scheduled_at === now + 60000);

  // pendingDueAt(now) → only the past row.
  var due = await n.pendingDueAt(now);
  check("pendingDueAt picks past only", due.length === 1 && due[0].id === soon.id);

  // pendingDueAt(now + 120000) → both.
  var due2 = await n.pendingDueAt(now + 120000);
  check("pendingDueAt picks both",      due2.length === 2);
  check("ordered ascending by sched",   due2[0].scheduled_at <= due2[1].scheduled_at);

  // Mark sent → no longer pending.
  await n.markSent(soon.id);
  var due3 = await n.pendingDueAt(now + 120000);
  check("sent removed from pending",    due3.length === 1 && due3[0].id === later.id);

  // limit cap.
  for (var i = 0; i < 5; i += 1) {
    await n.enqueue({
      recipient_id: "r" + i, channel: "in-app", event_type: "system.ping",
      scheduled_at: now - i,
    });
  }
  var capped = await n.pendingDueAt(now + 120000, { limit: 3 });
  check("limit honored",                capped.length === 3);

  // bad inputs
  await assert.rejects(async function () { await n.pendingDueAt("nope"); }, /non-negative integer/);
  await assert.rejects(async function () { await n.pendingDueAt(now, { limit: 0 }); }, /1\.\.500/);
  await assert.rejects(async function () { await n.pendingDueAt(now, { limit: 9999 }); }, /1\.\.500/);
}

async function _unreadForRecipientPagination() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });
  var base = Date.now();

  // Three in-app for r1, one email for r1, one in-app for r2.
  var a = await n.enqueue({ recipient_id: "r1", channel: "in-app", event_type: "system.ping", scheduled_at: base + 1 });
  var b = await n.enqueue({ recipient_id: "r1", channel: "in-app", event_type: "system.ping", scheduled_at: base + 2 });
  var c = await n.enqueue({ recipient_id: "r1", channel: "in-app", event_type: "system.ping", scheduled_at: base + 3 });
  await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });
  await n.enqueue({ recipient_id: "r2", channel: "in-app", event_type: "system.ping" });

  // Dismiss one — must drop out of unread.
  await n.dismiss(b.id);
  // Mark another read — must drop out of unread.
  await n.markSent(a.id);
  await n.markRead(a.id);

  var r1All = await n.unreadForRecipient("r1");
  check("r1 unread excludes dismissed + read", r1All.length === 2);
  // Sorted by scheduled_at desc — c (base+3) first, email last.
  check("ordered scheduled_at desc",           r1All[0].id === c.id);

  // Channel filter — only in-app.
  var r1InApp = await n.unreadForRecipient("r1", { channel: "in-app" });
  check("channel filter narrows",              r1InApp.length === 1 && r1InApp[0].id === c.id);

  // r2 is isolated.
  var r2All = await n.unreadForRecipient("r2");
  check("r2 isolated",                         r2All.length === 1);

  // limit + invalid inputs
  var r1Limited = await n.unreadForRecipient("r1", { limit: 1 });
  check("limit cap honored",                   r1Limited.length === 1);
  await assert.rejects(async function () { await n.unreadForRecipient("r1", { channel: "fax" }); }, /channel/);
}

async function _setPreferenceUpsert() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });

  // Insert path.
  var p1 = await n.setPreference({
    recipient_id: "r1", event_type: "order.shipped", channel: "email", enabled: false,
  });
  check("preference inserted disabled", p1.enabled === 0);
  check("created_at == updated_at on insert", p1.created_at === p1.updated_at);
  var createdAt = p1.created_at;

  // Update path — same composite key, flip enabled.
  // Wait one tick so updated_at can differ; we don't sleep, we just
  // check that the row updates correctly regardless of timing.
  var p2 = await n.setPreference({
    recipient_id: "r1", event_type: "order.shipped", channel: "email", enabled: true,
  });
  check("update flips enabled",         p2.enabled === 1);
  check("created_at preserved on update", p2.created_at === createdAt);
  check("updated_at >= created_at",     p2.updated_at >= p2.created_at);

  // Multiple preferences for one recipient.
  await n.setPreference({ recipient_id: "r1", event_type: "order.refunded", channel: "email",   enabled: false });
  await n.setPreference({ recipient_id: "r1", event_type: "order.refunded", channel: "in-app",  enabled: true });
  await n.setPreference({ recipient_id: "r1", event_type: "order.refunded", channel: "webhook", enabled: false });

  var prefs = await n.getPreferences("r1");
  check("getPreferences returns 4 rows", prefs.length === 4);
  // Ordered by event_type ASC then channel ASC.
  check("ordered event then channel",
    prefs[0].event_type === "order.refunded" && prefs[0].channel === "email");
  check("preferences scope per recipient",
    (await n.getPreferences("r2")).length === 0);

  // Bad inputs.
  await assert.rejects(async function () {
    await n.setPreference({ recipient_id: "r1", event_type: "x", channel: "email", enabled: "yes" });
  }, /enabled must be a boolean/);
  await assert.rejects(async function () {
    await n.setPreference({ recipient_id: "r1", event_type: "Bad Event", channel: "email", enabled: true });
  }, /event_type/);
  await assert.rejects(async function () {
    await n.setPreference({ recipient_id: "r1", event_type: "x.y", channel: "sms", enabled: true });
  }, /channel/);
}

async function _cleanupOld() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });
  var now = Date.now();

  // Three sent rows; we manually backdate updated_at via UPDATE so
  // the cutoff has something to bite.
  var s1 = await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });
  var s2 = await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });
  var s3 = await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });
  await n.markSent(s1.id);
  await n.markSent(s2.id);
  await n.markSent(s3.id);
  await q("UPDATE notifications SET updated_at = ?1 WHERE id = ?2", [now - 7 * 86400000, s1.id]);
  await q("UPDATE notifications SET updated_at = ?1 WHERE id = ?2", [now - 1 * 86400000, s2.id]);
  // s3 stays "now" — must survive any cutoff before now.

  // A pending row from a long time ago — must NOT be deleted by a
  // sent-only cleanup. Operators that want to reclaim pending
  // explicitly pass it in.
  var p1 = await n.enqueue({ recipient_id: "r1", channel: "email", event_type: "order.shipped" });
  await q("UPDATE notifications SET updated_at = ?1 WHERE id = ?2", [now - 14 * 86400000, p1.id]);

  // Cleanup sent rows older than 3 days.
  var r1 = await n.cleanupOld({
    before_ts: now - 3 * 86400000,
    statuses:  ["sent"],
  });
  check("cleanup reports deleted count", r1.deleted === 1);

  // s1 gone, s2 stays (newer than cutoff), s3 stays, pending stays.
  check("old sent row deleted",      (await n.get(s1.id)) === null);
  check("recent sent row survives",  (await n.get(s2.id)) !== null);
  check("fresh sent row survives",   (await n.get(s3.id)) !== null);
  check("ancient pending survives",  (await n.get(p1.id)) !== null);

  // Now reclaim pending explicitly.
  var r2 = await n.cleanupOld({
    before_ts: now - 3 * 86400000,
    statuses:  ["pending"],
  });
  check("cleanup pending deleted",   r2.deleted === 1);
  check("ancient pending now gone",  (await n.get(p1.id)) === null);

  // Bad inputs.
  await assert.rejects(async function () {
    await n.cleanupOld({ before_ts: -1, statuses: ["sent"] });
  }, /non-negative integer/);
  await assert.rejects(async function () {
    await n.cleanupOld({ before_ts: now, statuses: [] });
  }, /non-empty array/);
  await assert.rejects(async function () {
    await n.cleanupOld({ before_ts: now, statuses: ["bogus"] });
  }, /unknown status/);
}

async function _inputValidation() {
  var q = _makeQuery();
  var n = bShop.notifications.create({ query: q });

  await assert.rejects(async function () { await n.enqueue({}); },                                                  /recipient_id/);
  await assert.rejects(async function () { await n.enqueue({ recipient_id: "x" }); },                               /channel/);
  await assert.rejects(async function () { await n.enqueue({ recipient_id: "x", channel: "sms" }); },               /channel/);
  await assert.rejects(async function () { await n.enqueue({ recipient_id: "x", channel: "email" }); },             /event_type/);
  await assert.rejects(async function () { await n.enqueue({ recipient_id: "x", channel: "email", event_type: "Bad" }); }, /event_type/);
  await assert.rejects(async function () {
    await n.enqueue({ recipient_id: "x evil", channel: "email", event_type: "ok.y" });
  }, /control bytes/);
  await assert.rejects(async function () {
    await n.enqueue({ recipient_id: "x", channel: "email", event_type: "ok.y", payload: [1, 2, 3] });
  }, /payload/);
  await assert.rejects(async function () {
    await n.enqueue({ recipient_id: "x", channel: "email", event_type: "ok.y", scheduled_at: -1 });
  }, /scheduled_at/);
}

async function run() {
  await _enqueueHashedAndStored();
  await _enqueueRefusesOptedOut();
  await _statusTransitions();
  await _schedulingAndPendingDueAt();
  await _unreadForRecipientPagination();
  await _setPreferenceUpsert();
  await _cleanupOld();
  await _inputValidation();
}

module.exports = { run: run };
