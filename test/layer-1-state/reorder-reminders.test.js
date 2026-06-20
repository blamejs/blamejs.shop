"use strict";
/**
 * reorder-reminders — customer-facing "time to reorder" nudges.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0136
 * (reorder_profiles + reorder_enrollments + reorder_dispatches).
 * Notifications / email / sms are stubbed at the dep boundary — the
 * primitive's contract with each is the narrow `enqueue` / `send`
 * verb the factory checks.
 *
 * Coverage:
 *   - defineReminderProfile: insert + patch-in-place semantics,
 *     channel enum refusals, interval refusals
 *   - enrollCustomerSku: next_remind_at math (last_order_at +
 *     interval_days * 24h), refusal when no active profile,
 *     re-enrolment refreshes cadence
 *   - dispatchTick: pulls only active + due rows, advances
 *     next_remind_at on success, stamps a dispatches row
 *   - channel dispatch via stub: in_app → notifications.enqueue,
 *     email → email.send; missing dep is a typed failure
 *   - unsubscribeFromSku: future dispatchTick skips cancelled rows
 *   - recordSent / markFailed terminal markers
 *   - metricsForProfile aggregates by status in window
 *   - remindersForCustomer paginates by customer_id + status filter
 *   - factory shape + per-verb input validation refusals
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var reorderReminders = require("../../lib/reorder-reminders");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0136_reorder_reminders.sql");

var DAY_MS = 24 * 60 * 60 * 1000;

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
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE" || verb === "ALTER") {
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
}

// Stub notifications — captures every enqueue so the test can assert
// the in_app channel composed correctly.
function _stubNotifications() {
  var calls = [];
  return {
    calls: calls,
    enqueue: async function (input) {
      calls.push(input);
      return { ok: true, id: "stub-notif-" + calls.length };
    },
  };
}

// Stub email — same shape; the primitive composes email.send with
// `{ to, template, sku, enrollment_id }`.
function _stubEmail(opts) {
  opts = opts || {};
  var calls = [];
  return {
    calls: calls,
    send: async function (input) {
      calls.push(input);
      if (opts.throwOnSend) throw new Error(opts.throwOnSend);
      return { ok: true, id: "stub-email-" + calls.length };
    },
  };
}

function _stubSms() {
  var calls = [];
  return {
    calls: calls,
    send: async function (input) {
      calls.push(input);
      return { ok: true };
    },
  };
}

// A deterministic UUID generator — node:crypto.randomUUID() shape so
// the strict guardUuid profile accepts it.
function _newCustomerId() {
  return require("node:crypto").randomUUID();
}

// ---- 1. defineReminderProfile insert + patch + refusals ---------------

async function _testDefineProfile() {
  var query = _makeQuery();
  var rr = reorderReminders.create({ query: query });

  var p = await rr.defineReminderProfile({
    sku:                   "FILTER-PUR-12M",
    interval_days:         365,
    message_template_slug: "reorder-filter-12m",
    channel:               "email",
  });
  check("defineReminderProfile returns shaped row", p && p.sku === "FILTER-PUR-12M");
  check("interval_days echoed",                     p.interval_days === 365);
  check("message_template_slug echoed",             p.message_template_slug === "reorder-filter-12m");
  check("channel echoed",                           p.channel === "email");
  check("archived_at null on new profile",          p.archived_at === null);
  check("created_at integer",                       Number.isInteger(p.created_at));
  check("updated_at integer",                       Number.isInteger(p.updated_at));

  // Redefining the SAME sku patches in place — no error, new values
  // take effect.
  var p2 = await rr.defineReminderProfile({
    sku:                   "FILTER-PUR-12M",
    interval_days:         180,
    message_template_slug: "reorder-filter-6m",
    channel:               "in_app",
  });
  check("redefining same sku patches in place",     p2.sku === "FILTER-PUR-12M");
  check("patched interval_days",                    p2.interval_days === 180);
  check("patched message_template_slug",            p2.message_template_slug === "reorder-filter-6m");
  check("patched channel",                          p2.channel === "in_app");
  check("created_at preserved across patch",        p2.created_at === p.created_at);
  check("updated_at moved on patch",                p2.updated_at >= p.updated_at);

  // Channel enum refusals.
  await assert.rejects(rr.defineReminderProfile({
    sku: "SKU-X", interval_days: 30, message_template_slug: "tpl-x", channel: "carrier-pigeon",
  }), /channel must be one of/, "unknown channel refused");

  // Interval refusals.
  await assert.rejects(rr.defineReminderProfile({
    sku: "SKU-X", interval_days: 0, message_template_slug: "tpl-x", channel: "email",
  }), /interval_days must be/, "zero interval refused");

  await assert.rejects(rr.defineReminderProfile({
    sku: "SKU-X", interval_days: 4000, message_template_slug: "tpl-x", channel: "email",
  }), /interval_days must be/, "interval beyond ceiling refused");

  // SKU + template slug refusals.
  await assert.rejects(rr.defineReminderProfile({
    sku: "bad sku with spaces", interval_days: 30, message_template_slug: "tpl", channel: "email",
  }), /sku must match/, "bad sku refused");

  await assert.rejects(rr.defineReminderProfile({
    sku: "SKU-X", interval_days: 30, message_template_slug: "BAD UPPER", channel: "email",
  }), /message_template_slug must match/, "bad slug refused");
}

// ---- 2. enrollCustomerSku next_remind_at math --------------------------

async function _testEnrollMath() {
  var query = _makeQuery();
  var rr = reorderReminders.create({ query: query });

  // No profile yet → enrolment refused.
  var customerA = _newCustomerId();
  await assert.rejects(rr.enrollCustomerSku({
    customer_id: customerA, sku: "VITAMIN-D3", last_order_at: 1000000,
  }), /no active reminder profile/);

  await rr.defineReminderProfile({
    sku:                   "VITAMIN-D3",
    interval_days:         30,
    message_template_slug: "reorder-vitamin-d3",
    channel:               "email",
  });

  // Enrol with a known last_order_at; next_remind_at = last + 30d.
  var lastOrderAt = 1700000000000; // arbitrary epoch ms
  var e = await rr.enrollCustomerSku({
    customer_id:   customerA,
    sku:           "VITAMIN-D3",
    last_order_at: lastOrderAt,
  });
  check("enrollment returns shaped row",  e && typeof e.id === "string");
  check("enrolment customer_id echoed",   e.customer_id === customerA);
  check("enrolment sku echoed",           e.sku === "VITAMIN-D3");
  check("enrolment last_order_at echoed", e.last_order_at === lastOrderAt);
  check("enrolment next_remind_at = last + interval * 24h",
    e.next_remind_at === lastOrderAt + 30 * DAY_MS);
  check("enrolment status active",        e.status === "active");
  check("enrolment unsubscribed_at null", e.unsubscribed_at === null);

  // Re-enrolling the same pair refreshes the cadence.
  var refreshedLast = lastOrderAt + 5 * DAY_MS;
  var e2 = await rr.enrollCustomerSku({
    customer_id:   customerA,
    sku:           "VITAMIN-D3",
    last_order_at: refreshedLast,
  });
  check("re-enrolment returns same id",          e2.id === e.id);
  check("re-enrolment refreshes last_order_at",  e2.last_order_at === refreshedLast);
  check("re-enrolment re-arms next_remind_at",
    e2.next_remind_at === refreshedLast + 30 * DAY_MS);
  check("re-enrolment status still active",      e2.status === "active");

  // Omitting last_order_at falls back to "now"; check the value is
  // recent (within a few seconds of Date.now()).
  var customerB = _newCustomerId();
  var beforeNow = Date.now();
  var e3 = await rr.enrollCustomerSku({
    customer_id: customerB,
    sku:         "VITAMIN-D3",
  });
  var afterNow = Date.now();
  check("default last_order_at within request window",
    e3.last_order_at >= beforeNow && e3.last_order_at <= afterNow + 100);
}

// ---- 3. dispatchTick batches due reminders ----------------------------

async function _testDispatchTickBatches() {
  var query = _makeQuery();
  var notif = _stubNotifications();
  var rr = reorderReminders.create({
    query:         query,
    notifications: notif,
  });

  await rr.defineReminderProfile({
    sku:                   "PET-FOOD-5KG",
    interval_days:         60,
    message_template_slug: "reorder-pet-food",
    channel:               "in_app",
  });

  // Three enrollments — two due, one in the future.
  var dueA = _newCustomerId();
  var dueB = _newCustomerId();
  var future = _newCustomerId();

  var pastBase = Date.now() - 100 * DAY_MS;
  await rr.enrollCustomerSku({
    customer_id: dueA, sku: "PET-FOOD-5KG", last_order_at: pastBase,
  }); // next = past + 60d → still well in the past
  await rr.enrollCustomerSku({
    customer_id: dueB, sku: "PET-FOOD-5KG", last_order_at: pastBase + DAY_MS,
  });
  await rr.enrollCustomerSku({
    customer_id: future, sku: "PET-FOOD-5KG", last_order_at: Date.now(),
  }); // next = today + 60d → future

  var dispatched = await rr.dispatchTick({ now: Date.now() });
  check("dispatchTick returned 2 due rows",       dispatched.length === 2);
  check("each dispatch is `sent`",                dispatched.every(function (d) { return d.status === "sent"; }));
  check("each dispatch has a fresh id",           dispatched[0].id !== dispatched[1].id);
  check("notifications.enqueue called per row",   notif.calls.length === 2);
  check("notifications payload carries sku",      notif.calls[0].payload.sku === "PET-FOOD-5KG");
  check("notifications payload carries template", notif.calls[0].payload.template_slug === "reorder-pet-food");
  check("notifications event_type is reorder",    notif.calls[0].event_type === "reorder.reminder");
  check("notifications channel mapped to in-app", notif.calls[0].channel === "in-app");

  // Re-tick immediately — both due rows have advanced next_remind_at
  // by one interval, so they're no longer due. The `future` row
  // remains untouched.
  var secondTick = await rr.dispatchTick({ now: Date.now() });
  check("second tick has zero due rows", secondTick.length === 0);
  check("notifications still 2 calls",   notif.calls.length === 2);

  // dispatchTick refusals.
  await assert.rejects(rr.dispatchTick({ batch_size: 0 }),    /batch_size must be/);
  await assert.rejects(rr.dispatchTick({ batch_size: 1000 }), /batch_size must be/);
  await assert.rejects(rr.dispatchTick({ now: -1 }),          /now must be/);
}

// ---- 3b. dispatchTick claims each due row — no double-send under race --

async function _testDispatchTickAtomicClaim() {
  // Two concurrent ticks over the SAME due row must send exactly once.
  // The send is an exactly-once side-effect; without the atomic
  // next_remind_at claim, both ticks read the same due snapshot and
  // both fire it (the customer is double-nudged). The conditional
  // UPDATE (advance next_remind_at WHERE it still equals the observed
  // value) lets exactly one tick win the row; the loser's claim
  // matches zero rows and it skips the send.
  //
  // The in-memory DatabaseSync resolves each query synchronously, so a
  // bare Promise.all would let tick A run start-to-finish before tick B
  // ever reads its snapshot — no interleave, no race exposed. To model
  // two scheduler ticks that BOTH read the same due row before either
  // advances the cursor, the notifications stub blocks tick A inside
  // its send until tick B has read its snapshot and reached its own
  // claim. Both ticks therefore observe the pre-advance cursor.
  var query = _makeQuery();
  var c = _newCustomerId();

  var bothSnapshotsRead;
  var bothRead = new Promise(function (res) { bothSnapshotsRead = res; });
  var enqueueCalls = [];
  var firstSendGated = false;
  var notif = {
    calls: enqueueCalls,
    enqueue: async function (input) {
      enqueueCalls.push(input);
      // Gate ONLY the first send: hold the winning tick inside the
      // side-effect until BOTH ticks have read the due snapshot,
      // guaranteeing they observed the same row before the winner
      // advanced the cursor. Both ticks' SELECTs land before either
      // reaches enqueue (the in-memory DB resolves each query on the
      // microtask queue), so the gate is keyed off the snapshot count,
      // not a post-send read.
      if (!firstSendGated) {
        firstSendGated = true;
        await bothRead;
      }
      return { ok: true, id: "stub-notif-" + enqueueCalls.length };
    },
  };

  // Wrap query to count the dispatchTick snapshot SELECTs. Once both
  // ticks have read (count === 2), release the gated winner so it can
  // claim + send; the loser's claim then matches zero rows and it
  // skips without sending.
  var snapshotReads = 0;
  var gatedQuery = async function (sql, params) {
    var r = await query(sql, params);
    if (/SELECT \* FROM reorder_enrollments\s+WHERE status = 'active'/.test(sql)) {
      snapshotReads += 1;
      if (snapshotReads >= 2) { bothSnapshotsRead(); }
    }
    return r;
  };

  var rr = reorderReminders.create({ query: gatedQuery, notifications: notif });
  await rr.defineReminderProfile({
    sku: "RACE-FILTER", interval_days: 30, message_template_slug: "reorder-race", channel: "in_app",
  });
  // Under one interval stale so a single cadence advance clears the
  // due window: next = (now - 40d) + 30d = now - 10d (due now), and
  // after one advance = now + 20d (future).
  await rr.enrollCustomerSku({
    customer_id: c, sku: "RACE-FILTER", last_order_at: Date.now() - 40 * DAY_MS,
  });

  var now = Date.now();
  var results = await Promise.all([
    rr.dispatchTick({ now: now }),
    rr.dispatchTick({ now: now }),
  ]);

  check("atomic claim: both ticks read the same due snapshot", snapshotReads === 2);

  // Exactly one tick reports a sent row; the loser's claim lost the
  // race and it skipped without sending.
  var sentRows = results[0].concat(results[1]).filter(function (d) { return d.status === "sent"; });
  check("atomic claim: exactly one tick sent the row", sentRows.length === 1);
  check("atomic claim: side-effect fired exactly once", enqueueCalls.length === 1);

  // The dispatches table holds exactly one sent row for this enrollment.
  var enrs = await rr.remindersForCustomer({ customer_id: c });
  var dRows = await query(
    "SELECT * FROM reorder_dispatches WHERE enrollment_id = ?1 AND status = 'sent'",
    [enrs.rows[0].id],
  );
  check("atomic claim: one sent dispatch persisted", dRows.rows.length === 1);

  // A follow-up tick is a no-op — the cursor advanced one interval past
  // the (now - 10d) due value to (now + 20d), clearing the window.
  var third = await rr.dispatchTick({ now: now });
  check("atomic claim: re-tick is a no-op", third.length === 0);
  check("atomic claim: no extra send on re-tick", enqueueCalls.length === 1);
}

// ---- 4. channel dispatch via stub --------------------------------------

async function _testChannelDispatch() {
  // Email channel — composes email.send.
  var queryE = _makeQuery();
  var email  = _stubEmail();
  var rrE = reorderReminders.create({ query: queryE, email: email });

  await rrE.defineReminderProfile({
    sku:                   "COFFEE-12OZ",
    interval_days:         14,
    message_template_slug: "reorder-coffee",
    channel:               "email",
  });
  var cE = _newCustomerId();
  await rrE.enrollCustomerSku({
    customer_id: cE, sku: "COFFEE-12OZ", last_order_at: Date.now() - 30 * DAY_MS,
  });
  var resE = await rrE.dispatchTick({ now: Date.now() });
  check("email channel: one dispatch row",  resE.length === 1);
  check("email channel: status sent",       resE[0].status === "sent");
  check("email.send called once",           email.calls.length === 1);
  check("email.send carries template",      email.calls[0].template === "reorder-coffee");
  check("email.send carries sku",           email.calls[0].sku === "COFFEE-12OZ");
  check("email.send carries customer (to)", email.calls[0].to === cE);

  // SMS channel — composes sms.send.
  var queryS = _makeQuery();
  var smsStub = _stubSms();
  var rrS = reorderReminders.create({ query: queryS, sms: smsStub });
  await rrS.defineReminderProfile({
    sku: "MEDS-30D", interval_days: 30, message_template_slug: "reorder-meds", channel: "sms",
  });
  var cS = _newCustomerId();
  await rrS.enrollCustomerSku({
    customer_id: cS, sku: "MEDS-30D", last_order_at: Date.now() - 60 * DAY_MS,
  });
  var resS = await rrS.dispatchTick({ now: Date.now() });
  check("sms channel: status sent",   resS[0].status === "sent");
  check("sms.send called once",       smsStub.calls.length === 1);
  check("sms.send carries template",  smsStub.calls[0].template === "reorder-meds");

  // Missing dep → typed failure (not a crash).
  var queryM = _makeQuery();
  var rrM = reorderReminders.create({ query: queryM }); // no notifications wired
  await rrM.defineReminderProfile({
    sku: "WIDGET", interval_days: 30, message_template_slug: "reorder-widget", channel: "in_app",
  });
  await rrM.enrollCustomerSku({
    customer_id: _newCustomerId(), sku: "WIDGET", last_order_at: Date.now() - 60 * DAY_MS,
  });
  var resM = await rrM.dispatchTick({ now: Date.now() });
  check("missing dep: dispatch failed",    resM[0].status === "failed");
  check("missing dep: typed fail_reason",  resM[0].fail_reason === "notifications-dep-missing");

  // Email throws → captured as failed with prefix.
  var queryT = _makeQuery();
  var emailT = _stubEmail({ throwOnSend: "smtp 500" });
  var rrT = reorderReminders.create({ query: queryT, email: emailT });
  await rrT.defineReminderProfile({
    sku: "SHAMPOO", interval_days: 45, message_template_slug: "reorder-shampoo", channel: "email",
  });
  await rrT.enrollCustomerSku({
    customer_id: _newCustomerId(), sku: "SHAMPOO", last_order_at: Date.now() - 60 * DAY_MS,
  });
  var resT = await rrT.dispatchTick({ now: Date.now() });
  check("email throw: dispatch failed",          resT[0].status === "failed");
  check("email throw: fail_reason includes msg", /email-send-failed/.test(resT[0].fail_reason));
}

// ---- 5. unsubscribeFromSku stops future dispatches --------------------

async function _testUnsubscribe() {
  var query = _makeQuery();
  var notif = _stubNotifications();
  var rr = reorderReminders.create({ query: query, notifications: notif });

  await rr.defineReminderProfile({
    sku: "DOG-FOOD", interval_days: 30, message_template_slug: "reorder-dog-food", channel: "in_app",
  });

  var c1 = _newCustomerId();
  var c2 = _newCustomerId();
  await rr.enrollCustomerSku({ customer_id: c1, sku: "DOG-FOOD", last_order_at: Date.now() - 60 * DAY_MS });
  await rr.enrollCustomerSku({ customer_id: c2, sku: "DOG-FOOD", last_order_at: Date.now() - 60 * DAY_MS });

  // c1 unsubscribes BEFORE the tick.
  var unsub = await rr.unsubscribeFromSku({ customer_id: c1, sku: "DOG-FOOD" });
  check("unsub status cancelled",        unsub.status === "cancelled");
  check("unsubscribed_at stamped",       Number.isInteger(unsub.unsubscribed_at));

  // Idempotent re-unsubscribe.
  var unsub2 = await rr.unsubscribeFromSku({ customer_id: c1, sku: "DOG-FOOD" });
  check("re-unsubscribe preserves stamp", unsub2.unsubscribed_at === unsub.unsubscribed_at);

  var dispatched = await rr.dispatchTick({ now: Date.now() });
  check("only c2 dispatched (c1 cancelled)", dispatched.length === 1);
  check("notifications called once",         notif.calls.length === 1);

  // Unknown pair refused.
  await assert.rejects(rr.unsubscribeFromSku({
    customer_id: _newCustomerId(), sku: "DOG-FOOD",
  }), /no enrollment for customer/);
}

// ---- 6. recordSent / markFailed terminal markers ----------------------

async function _testTerminalMarkers() {
  var query = _makeQuery();
  var rr = reorderReminders.create({ query: query });

  await rr.defineReminderProfile({
    sku: "TONER-LASER", interval_days: 90, message_template_slug: "reorder-toner", channel: "email",
  });
  var c = _newCustomerId();
  var lastOrder = Date.now() - 100 * DAY_MS;
  var enr = await rr.enrollCustomerSku({
    customer_id: c, sku: "TONER-LASER", last_order_at: lastOrder,
  });
  var initialNext = enr.next_remind_at;

  var sentRow = await rr.recordSent({
    reminder_id: enr.id,
    sent_at:     Date.now(),
  });
  check("recordSent returns dispatch row",   sentRow && sentRow.status === "sent");
  check("recordSent status sent",            sentRow.status === "sent");
  check("recordSent fail_reason null",       sentRow.fail_reason === null);

  // The cadence advanced by 90 days.
  var refreshed = await rr.remindersForCustomer({ customer_id: c });
  check("recordSent advanced next_remind_at",
    refreshed.rows[0].next_remind_at === initialNext + 90 * DAY_MS);

  // markFailed records the failure.
  var failedRow = await rr.markFailed({
    reminder_id: enr.id,
    reason:      "provider-timeout",
  });
  check("markFailed status failed",    failedRow.status === "failed");
  check("markFailed reason recorded",  failedRow.fail_reason === "provider-timeout");

  // Unknown enrollment refused.
  await assert.rejects(rr.recordSent({ reminder_id: "ZZ-NOT-EXIST" }), /not found/);
  await assert.rejects(rr.markFailed({ reminder_id: "ZZ-NOT-EXIST", reason: "x" }), /not found/);

  // Empty reason refused.
  await assert.rejects(rr.markFailed({ reminder_id: enr.id, reason: "" }), /reason must be/);
}

// ---- 7. metricsForProfile aggregates ----------------------------------

async function _testMetrics() {
  var query = _makeQuery();
  var notif = _stubNotifications();
  var rr = reorderReminders.create({ query: query, notifications: notif });

  await rr.defineReminderProfile({
    sku: "BATTERY-AA", interval_days: 90, message_template_slug: "reorder-battery", channel: "in_app",
  });

  // Three enrollments — three sent dispatches via tick.
  var customers = [_newCustomerId(), _newCustomerId(), _newCustomerId()];
  for (var i = 0; i < 3; i += 1) {
    await rr.enrollCustomerSku({
      customer_id: customers[i], sku: "BATTERY-AA",
      last_order_at: Date.now() - 120 * DAY_MS,
    });
  }
  // Use a wide window — the monotonic clock can push occurred_at
  // a handful of milliseconds beyond Date.now() under contention,
  // and the window must capture every emitted row regardless.
  var before = Date.now() - 1000;
  await rr.dispatchTick({ now: Date.now() });

  // Plus two manual failures via markFailed.
  var enrs = await rr.remindersForCustomer({ customer_id: customers[0] });
  await rr.markFailed({ reminder_id: enrs.rows[0].id, reason: "provider-down" });
  await rr.markFailed({ reminder_id: enrs.rows[0].id, reason: "provider-down-2" });

  var after = Date.now() + 60000;
  var m = await rr.metricsForProfile({
    sku: "BATTERY-AA", from: before, to: after,
  });
  check("metrics sku echoed",        m.sku === "BATTERY-AA");
  check("metrics sent_count = 3",    m.sent_count === 3);
  check("metrics failed_count = 2",  m.failed_count === 2);
  check("metrics total_count = 5",   m.total_count === 5);

  // Empty window → zeros.
  var mEmpty = await rr.metricsForProfile({
    sku: "BATTERY-AA", from: 1, to: 2,
  });
  check("empty window sent 0",     mEmpty.sent_count === 0);
  check("empty window failed 0",   mEmpty.failed_count === 0);

  // Inverted window refused.
  await assert.rejects(rr.metricsForProfile({
    sku: "BATTERY-AA", from: 100, to: 50,
  }), /to .* must be ≥ from/);
}

// ---- 8. remindersForCustomer pagination + status filter --------------

async function _testRemindersForCustomer() {
  var query = _makeQuery();
  var rr = reorderReminders.create({ query: query });

  // Two profiles so the same customer can hold multiple enrolments.
  await rr.defineReminderProfile({
    sku: "ITEM-A", interval_days: 30, message_template_slug: "tpl-a", channel: "in_app",
  });
  await rr.defineReminderProfile({
    sku: "ITEM-B", interval_days: 60, message_template_slug: "tpl-b", channel: "email",
  });
  await rr.defineReminderProfile({
    sku: "ITEM-C", interval_days: 90, message_template_slug: "tpl-c", channel: "email",
  });

  var c = _newCustomerId();
  await rr.enrollCustomerSku({ customer_id: c, sku: "ITEM-A", last_order_at: 1700000000000 });
  await rr.enrollCustomerSku({ customer_id: c, sku: "ITEM-B", last_order_at: 1700000001000 });
  await rr.enrollCustomerSku({ customer_id: c, sku: "ITEM-C", last_order_at: 1700000002000 });

  var all = await rr.remindersForCustomer({ customer_id: c });
  check("remindersForCustomer returns all 3",  all.rows.length === 3);
  check("remindersForCustomer next_cursor null at end", all.next_cursor === null);

  // Filter by status = active (default for fresh enrolments).
  var active = await rr.remindersForCustomer({ customer_id: c, status: "active" });
  check("status=active filter returns 3", active.rows.length === 3);

  // Cancel one → status filter narrows.
  await rr.unsubscribeFromSku({ customer_id: c, sku: "ITEM-B" });
  var cancelled = await rr.remindersForCustomer({ customer_id: c, status: "cancelled" });
  check("status=cancelled returns 1",        cancelled.rows.length === 1);
  check("cancelled row is ITEM-B",           cancelled.rows[0].sku === "ITEM-B");
  var stillActive = await rr.remindersForCustomer({ customer_id: c, status: "active" });
  check("active after cancel returns 2",     stillActive.rows.length === 2);

  // Pagination — limit 1 returns a next_cursor; second page picks up
  // with that cursor.
  var page1 = await rr.remindersForCustomer({ customer_id: c, limit: 1 });
  check("limit=1 returns 1 row",            page1.rows.length === 1);
  check("limit=1 returns next_cursor",      Number.isInteger(page1.next_cursor));
  var page2 = await rr.remindersForCustomer({ customer_id: c, limit: 1, cursor: page1.next_cursor });
  check("page2 returns 1 row",              page2.rows.length === 1);
  check("page2 row distinct from page1",    page2.rows[0].id !== page1.rows[0].id);

  // remindersForCustomer refusals.
  await assert.rejects(rr.remindersForCustomer({ customer_id: "not-a-uuid" }),
    /customer_id/);
  await assert.rejects(rr.remindersForCustomer({ customer_id: c, status: "weird" }),
    /status must be one of/);
  await assert.rejects(rr.remindersForCustomer({ customer_id: c, limit: 0 }),
    /limit must be/);
  await assert.rejects(rr.remindersForCustomer({ customer_id: c, cursor: -5 }),
    /cursor must be/);
}

// ---- 9. factory shape + input validation refusals --------------------

async function _testFactoryAndValidation() {
  var query = _makeQuery();

  // Factory: optional deps must be objects when supplied.
  assert.throws(function () {
    reorderReminders.create({ query: query, notifications: "not-an-object" });
  }, /notifications must be/);
  assert.throws(function () {
    reorderReminders.create({ query: query, email: "not-an-object" });
  }, /email must be/);
  assert.throws(function () {
    reorderReminders.create({ query: query, sms: "not-an-object" });
  }, /sms must be/);
  assert.throws(function () {
    reorderReminders.create({ query: query, order: "not-an-object" });
  }, /order must be/);

  var rr = reorderReminders.create({ query: query });
  check("factory exposes CHANNELS",          Array.isArray(rr.CHANNELS) && rr.CHANNELS.length === 3);
  check("module export carries CHANNELS",    Array.isArray(reorderReminders.CHANNELS));
  check("module export carries STATUSES",    Array.isArray(reorderReminders.STATUSES));
  check("module export has run() function",  typeof reorderReminders.run === "function");

  // defineReminderProfile shape refusals.
  await assert.rejects(rr.defineReminderProfile(),                 /input object required/);
  await assert.rejects(rr.defineReminderProfile(null),             /input object required/);

  // enrollCustomerSku shape refusals.
  await assert.rejects(rr.enrollCustomerSku(),                     /input object required/);
  await assert.rejects(rr.enrollCustomerSku({ customer_id: "x", sku: "SKU-X" }),
    /customer_id/);
  await rr.defineReminderProfile({
    sku: "SEED", interval_days: 30, message_template_slug: "seed", channel: "in_app",
  });
  await assert.rejects(rr.enrollCustomerSku({
    customer_id: _newCustomerId(), sku: "SEED", last_order_at: -1,
  }), /last_order_at must be/);
  await assert.rejects(rr.enrollCustomerSku({
    customer_id: _newCustomerId(), sku: "bad sku",
  }), /sku must match/);

  // unsubscribeFromSku refusals.
  await assert.rejects(rr.unsubscribeFromSku(),                    /input object required/);
  await assert.rejects(rr.unsubscribeFromSku({ customer_id: "x", sku: "SEED" }),
    /customer_id/);

  // metricsForProfile refusals.
  await assert.rejects(rr.metricsForProfile(),                     /input object required/);
  await assert.rejects(rr.metricsForProfile({ sku: "SEED" }),      /from must be/);
  await assert.rejects(rr.metricsForProfile({
    sku: "SEED", from: 100, to: -1,
  }), /to must be/);

  // recordSent / markFailed shape refusals.
  await assert.rejects(rr.recordSent(),                            /input object required/);
  await assert.rejects(rr.recordSent({ reminder_id: "bad id w spaces" }),
    /reminder_id must match/);
  await assert.rejects(rr.markFailed(),                            /input object required/);
  await assert.rejects(rr.markFailed({ reminder_id: "bad id w spaces", reason: "x" }),
    /reminder_id must match/);

  // remindersForCustomer shape refusals.
  await assert.rejects(rr.remindersForCustomer(),                  /input object required/);
}

// ---- 10. module-level run() smoke ------------------------------------

async function _testRunSmoke() {
  var res = await reorderReminders.run();
  check("module.run() returns ok",  res && res.ok === true);
}

async function run() {
  await _testDefineProfile();
  await _testEnrollMath();
  await _testDispatchTickBatches();
  await _testDispatchTickAtomicClaim();
  await _testChannelDispatch();
  await _testUnsubscribe();
  await _testTerminalMarkers();
  await _testMetrics();
  await _testRemindersForCustomer();
  await _testFactoryAndValidation();
  await _testRunSmoke();
  console.log("reorder-reminders.test.js: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: run };

if (require.main === module) {
  run().catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
