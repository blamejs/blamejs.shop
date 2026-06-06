"use strict";
/**
 * operator-inbox — per-operator notification feed for system events.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0175.
 *
 * Coverage:
 *   - enqueueMessage: requires exactly one of operator_id / role;
 *     persists payload + severity + kind; refuses both/neither;
 *     refuses an unknown role when allow-list configured.
 *   - inboxForOperator: returns operator-id-addressed rows by default;
 *     folds in role-broadcast rows when operatorRoles peer wired;
 *     severity_min filters by the closed rank ladder; unread_only +
 *     include_archived flags compose correctly; HMAC cursor round-
 *     trips and refuses tampered tokens.
 *   - markRead / markUnread FSM: each transition is observable on
 *     the returned row; markRead is idempotent; markUnread reverses;
 *     refuses messages not addressable to the operator.
 *   - archiveMessage + bulkArchive: archived rows drop from inbox
 *     read; bulkArchive refuses the whole batch if any id is
 *     unaddressable.
 *   - unreadCount: navbar badge count excludes archived + read rows;
 *     severity_min filter works.
 *   - cleanupOlderThan: deletes rows whose created_at < (now - age_ms).
 *   - metricsForKind: per-severity + per-state histogram plus median
 *     read latency over the supplied window.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var operatorInbox = require("../../lib/operator-inbox");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;
var waitUntil     = helpers.waitUntil;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0175_operator_inbox.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return {
    db:    db,
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

// Minimal in-memory operatorRoles stub — the inbox primitive only
// calls `rolesForOperator(operator_id)` so the rest of the
// operatorRoles surface stays unmocked.
function _rolesStub(memberships) {
  // memberships: { [operator_id]: ["role-slug", ...] }
  return {
    rolesForOperator: async function (operatorId) {
      var slugs = memberships[operatorId] || [];
      return slugs.map(function (s) { return { role_slug: s }; });
    },
  };
}

function _factory(extraOpts) {
  var h = _makeQuery();
  var opts = Object.assign({ query: h.query, cursorSecret: "test-secret" }, extraOpts || {});
  return {
    db:    h.db,
    query: h.query,
    inbox: operatorInbox.create(opts),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- enqueueMessage requires exactly one of operator_id / role ---------

async function _enqueueAddressing() {
  var f = _factory();

  // Happy path: operator_id addressing.
  var operatorId = _uuid();
  var row = await f.inbox.enqueueMessage({
    operator_id: operatorId,
    kind:        "refund_failure",
    severity:    "urgent",
    subject:     "Refund attempt failed",
    body:        "Refund for order 1234 failed: gateway declined.",
    payload:     { order_id: "ord-1234", reason: "gateway_declined" },
  });
  check("enqueueMessage returns id",          typeof row.id === "string" && row.id.length === 36);
  check("enqueueMessage operator_id set",     row.operator_id === operatorId);
  check("enqueueMessage role null",           row.role === null);
  check("enqueueMessage kind persisted",      row.kind === "refund_failure");
  check("enqueueMessage severity persisted",  row.severity === "urgent");
  check("enqueueMessage subject persisted",   row.subject === "Refund attempt failed");
  check("enqueueMessage payload round-trip",  row.payload.order_id === "ord-1234"
                                              && row.payload.reason === "gateway_declined");
  check("enqueueMessage created_at set",      typeof row.created_at === "number");
  check("enqueueMessage read_at null",        row.read_at === null);
  check("enqueueMessage archived_at null",    row.archived_at === null);

  // Happy path: role addressing.
  var roleRow = await f.inbox.enqueueMessage({
    role:     "support-agent",
    kind:     "low_stock",
    severity: "warning",
    subject:  "SKU low on stock",
    body:     "SKU widget-blue is below threshold.",
  });
  check("enqueueMessage role addressing",     roleRow.role === "support-agent" && roleRow.operator_id === null);

  // Both addressing modes set: refused.
  await assert.rejects(
    f.inbox.enqueueMessage({
      operator_id: _uuid(),
      role:        "support-agent",
      kind:        "info",
      severity:    "info",
      subject:     "Both",
      body:        "Both",
    }),
    /exactly one of operator_id \/ role is required/,
  );

  // Neither mode set: refused.
  await assert.rejects(
    f.inbox.enqueueMessage({
      kind:     "info",
      severity: "info",
      subject:  "Neither",
      body:     "Neither",
    }),
    /exactly one of operator_id \/ role is required/,
  );

  // Bad severity refused.
  await assert.rejects(
    f.inbox.enqueueMessage({
      operator_id: operatorId,
      kind:        "info",
      severity:    "fatal",
      subject:     "Bad",
      body:        "Bad",
    }),
    /severity must be one of/,
  );

  // Allow-list refusal: unknown role when string[] allow-list set.
  var f2 = _factory({ operatorRoles: ["support-agent", "admin"] });
  await assert.rejects(
    f2.inbox.enqueueMessage({
      role:     "marketing",
      kind:     "info",
      severity: "info",
      subject:  "x",
      body:     "x",
    }),
    /not in the configured operatorRoles allow-list/,
  );

  // Subject control byte refused.
  await assert.rejects(
    f.inbox.enqueueMessage({
      operator_id: operatorId,
      kind:        "info",
      severity:    "info",
      subject:     "bad\x00subject",
      body:        "ok",
    }),
    /control bytes/,
  );
}

// ---- inboxForOperator filters ------------------------------------------

async function _inboxFilters() {
  var operatorA = _uuid();
  var operatorB = _uuid();
  var f = _factory({ operatorRoles: _rolesStub({ [operatorA]: ["support-agent"] }) });

  // Three messages addressed to A directly.
  await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event",  severity: "info",     subject: "A-info",    body: "A info" });
  await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "warn_event",  severity: "warning",  subject: "A-warning", body: "A warn" });
  await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "urg_event",   severity: "urgent",   subject: "A-urgent",  body: "A urgent" });

  // One role-broadcast that A reaches via support-agent.
  await f.inbox.enqueueMessage({ role: "support-agent", kind: "broadcast", severity: "critical", subject: "Role broadcast", body: "Broadcast" });

  // One row addressed to B — A must never see it.
  await f.inbox.enqueueMessage({ operator_id: operatorB, kind: "other", severity: "info", subject: "B-only", body: "Only B" });

  // One row to a role A doesn't carry — also invisible to A.
  await f.inbox.enqueueMessage({ role: "marketing", kind: "marketing", severity: "info", subject: "Marketing", body: "Marketing" });

  // Default: everything addressable to A, not archived.
  var feed = await f.inbox.inboxForOperator({ operator_id: operatorA });
  check("inbox default returns object",            feed && Array.isArray(feed.rows));
  check("inbox default row count",                 feed.rows.length === 4);
  // Sorted by created_at DESC — last enqueued (the broadcast) comes
  // first because it was enqueued just before the foreign rows.
  // We just assert A's rows AND the broadcast are all present.
  var subjects = feed.rows.map(function (r) { return r.subject; }).sort();
  check("inbox A-info present",                    subjects.indexOf("A-info") !== -1);
  check("inbox A-warning present",                 subjects.indexOf("A-warning") !== -1);
  check("inbox A-urgent present",                  subjects.indexOf("A-urgent") !== -1);
  check("inbox broadcast present",                 subjects.indexOf("Role broadcast") !== -1);
  check("inbox B-only excluded",                   subjects.indexOf("B-only") === -1);
  check("inbox Marketing excluded",                subjects.indexOf("Marketing") === -1);

  // severity_min warning: drops A-info, keeps A-warning + A-urgent + broadcast.
  var minWarn = await f.inbox.inboxForOperator({ operator_id: operatorA, severity_min: "warning" });
  check("severity_min warning row count",          minWarn.rows.length === 3);
  var subjMin = minWarn.rows.map(function (r) { return r.subject; }).sort();
  check("severity_min warning excludes info",      subjMin.indexOf("A-info") === -1);

  // severity_min critical: only the broadcast.
  var minCrit = await f.inbox.inboxForOperator({ operator_id: operatorA, severity_min: "critical" });
  check("severity_min critical row count",         minCrit.rows.length === 1);
  check("severity_min critical only broadcast",    minCrit.rows[0].subject === "Role broadcast");

  // unread_only: every row is unread on enqueue, so the count matches default.
  var unread = await f.inbox.inboxForOperator({ operator_id: operatorA, unread_only: true });
  check("unread_only matches default row count",   unread.rows.length === 4);

  // Mark one read, then unread_only should drop it.
  var firstA = feed.rows.filter(function (r) { return r.subject === "A-info"; })[0];
  await f.inbox.markRead({ id: firstA.id, operator_id: operatorA });
  var unread2 = await f.inbox.inboxForOperator({ operator_id: operatorA, unread_only: true });
  check("unread_only after markRead drops one",    unread2.rows.length === 3);

  // include_archived default false, then archive one and toggle to confirm.
  await f.inbox.archiveMessage({ id: firstA.id, operator_id: operatorA });
  var noArchived = await f.inbox.inboxForOperator({ operator_id: operatorA });
  check("default excludes archived",               noArchived.rows.length === 3);
  var withArchived = await f.inbox.inboxForOperator({ operator_id: operatorA, include_archived: true });
  check("include_archived includes archived",      withArchived.rows.length === 4);

  // HMAC cursor round-trip: limit=2, fetch first page, then continue.
  var page1 = await f.inbox.inboxForOperator({ operator_id: operatorA, limit: 2 });
  check("page1 returns 2 rows",                    page1.rows.length === 2);
  check("page1 next_cursor non-null",              typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await f.inbox.inboxForOperator({ operator_id: operatorA, limit: 2, cursor: page1.next_cursor });
  check("page2 returns 1 row",                     page2.rows.length === 1);
  check("page2 next_cursor null",                  page2.next_cursor === null);
  // Sanity: no row appears in both pages.
  var p1ids = page1.rows.map(function (r) { return r.id; });
  var p2ids = page2.rows.map(function (r) { return r.id; });
  for (var pi = 0; pi < p2ids.length; pi += 1) {
    check("page2 row not in page1: " + p2ids[pi], p1ids.indexOf(p2ids[pi]) === -1);
  }

  // Tampered cursor refused.
  await assert.rejects(
    f.inbox.inboxForOperator({ operator_id: operatorA, cursor: "tampered.token" }),
    /cursor/,
  );

  // Cursor under a different secret refused.
  var f3 = _factory({
    operatorRoles: _rolesStub({ [operatorA]: ["support-agent"] }),
    cursorSecret:  "different-secret",
  });
  await f3.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "info", subject: "x", body: "x" });
  await assert.rejects(
    f3.inbox.inboxForOperator({ operator_id: operatorA, cursor: page1.next_cursor }),
    /cursor/,
  );
}

// ---- markRead / markUnread FSM -----------------------------------------

async function _markReadUnreadFsm() {
  var operatorA = _uuid();
  var operatorB = _uuid();
  var f = _factory({ operatorRoles: _rolesStub({ [operatorA]: ["support-agent"] }) });

  var msg = await f.inbox.enqueueMessage({
    operator_id: operatorA,
    kind:        "refund_failure",
    severity:    "urgent",
    subject:     "Mark me read",
    body:        "Body",
  });

  // markRead transitions the row.
  var afterRead = await f.inbox.markRead({ id: msg.id, operator_id: operatorA });
  check("markRead sets read_at",                   typeof afterRead.read_at === "number");
  check("markRead preserves kind",                 afterRead.kind === "refund_failure");

  // Idempotent — second markRead returns the same row.
  var sameRead = await f.inbox.markRead({ id: msg.id, operator_id: operatorA });
  check("markRead idempotent",                     sameRead.read_at === afterRead.read_at);

  // markUnread reverses.
  var afterUnread = await f.inbox.markUnread({ id: msg.id, operator_id: operatorA });
  check("markUnread clears read_at",               afterUnread.read_at === null);

  // markUnread when already unread is a no-op.
  var stillUnread = await f.inbox.markUnread({ id: msg.id, operator_id: operatorA });
  check("markUnread idempotent",                   stillUnread.read_at === null);

  // Operator B can't address operator A's row.
  await assert.rejects(
    f.inbox.markRead({ id: msg.id, operator_id: operatorB }),
    function (err) { return err && err.code === "INBOX_MESSAGE_NOT_ADDRESSABLE"; },
  );
  await assert.rejects(
    f.inbox.markUnread({ id: msg.id, operator_id: operatorB }),
    function (err) { return err && err.code === "INBOX_MESSAGE_NOT_ADDRESSABLE"; },
  );

  // Unknown message id surfaces as not-found.
  await assert.rejects(
    f.inbox.markRead({ id: _uuid(), operator_id: operatorA }),
    function (err) { return err && err.code === "INBOX_MESSAGE_NOT_FOUND"; },
  );

  // Role-broadcast: A can mark it read because A carries the role.
  var broadcast = await f.inbox.enqueueMessage({
    role: "support-agent", kind: "low_stock", severity: "warning", subject: "Bcast", body: "Bcast",
  });
  var bRead = await f.inbox.markRead({ id: broadcast.id, operator_id: operatorA });
  check("markRead works on role broadcast",        typeof bRead.read_at === "number");

  // Operator B (no support-agent role) cannot.
  await assert.rejects(
    f.inbox.markRead({ id: broadcast.id, operator_id: operatorB }),
    function (err) { return err && err.code === "INBOX_MESSAGE_NOT_ADDRESSABLE"; },
  );
}

// ---- archiveMessage + bulkArchive --------------------------------------

async function _archiveBehaviour() {
  var operatorA = _uuid();
  var operatorB = _uuid();
  var f = _factory({ operatorRoles: _rolesStub({ [operatorA]: ["support-agent"] }) });

  var m1 = await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "info",    subject: "m1", body: "m1" });
  var m2 = await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "warning", subject: "m2", body: "m2" });
  var m3 = await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "urgent",  subject: "m3", body: "m3" });
  var foreign = await f.inbox.enqueueMessage({ operator_id: operatorB, kind: "info_event", severity: "info", subject: "foreign", body: "foreign" });

  // archiveMessage drops the row from the default inbox read.
  var archived = await f.inbox.archiveMessage({ id: m1.id, operator_id: operatorA });
  check("archiveMessage stamps archived_at",       typeof archived.archived_at === "number");

  var feed = await f.inbox.inboxForOperator({ operator_id: operatorA });
  var subjects = feed.rows.map(function (r) { return r.subject; });
  check("archived row excluded from default",      subjects.indexOf("m1") === -1
                                                    && subjects.indexOf("m2") !== -1
                                                    && subjects.indexOf("m3") !== -1);

  // archiveMessage is idempotent.
  var sameArchive = await f.inbox.archiveMessage({ id: m1.id, operator_id: operatorA });
  check("archiveMessage idempotent",                sameArchive.archived_at === archived.archived_at);

  // bulkArchive: refuses the whole batch when one id is foreign.
  await assert.rejects(
    f.inbox.bulkArchive({ operator_id: operatorA, ids: [m2.id, foreign.id] }),
    function (err) { return err && err.code === "INBOX_MESSAGE_NOT_ADDRESSABLE"; },
  );
  // foreign row remains active.
  var foreignFeed = await f.inbox.inboxForOperator({ operator_id: operatorB });
  check("foreign row not archived by failed bulk",  foreignFeed.rows.length === 1
                                                    && foreignFeed.rows[0].archived_at === null);

  // bulkArchive happy path.
  var bulk = await f.inbox.bulkArchive({ operator_id: operatorA, ids: [m2.id, m3.id] });
  check("bulkArchive archives both",                bulk.archived_count === 2);

  var feed2 = await f.inbox.inboxForOperator({ operator_id: operatorA });
  check("bulk archived rows excluded",              feed2.rows.length === 0);

  // bulkArchive duplicate-id refused.
  await assert.rejects(
    f.inbox.bulkArchive({ operator_id: operatorA, ids: [m2.id, m2.id] }),
    /duplicates a prior entry/,
  );

  // Empty array refused.
  await assert.rejects(
    f.inbox.bulkArchive({ operator_id: operatorA, ids: [] }),
    /non-empty array/,
  );
}

// ---- unreadCount -------------------------------------------------------

async function _unreadCountBadge() {
  var operatorA = _uuid();
  var f = _factory({ operatorRoles: _rolesStub({ [operatorA]: ["support-agent"] }) });

  // No messages: zero.
  var zero = await f.inbox.unreadCount({ operator_id: operatorA });
  check("unreadCount zero on empty inbox",          zero === 0);

  var a1 = await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "info",    subject: "a1", body: "a1" });
  await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "warning",  subject: "a2", body: "a2" });
  await f.inbox.enqueueMessage({ role: "support-agent", kind: "low_stock", severity: "urgent",  subject: "a3", body: "a3" });

  var three = await f.inbox.unreadCount({ operator_id: operatorA });
  check("unreadCount three",                        three === 3);

  // severity_min warning drops a1 (info).
  var twoMin = await f.inbox.unreadCount({ operator_id: operatorA, severity_min: "warning" });
  check("unreadCount severity_min warning",         twoMin === 2);

  // markRead drops the count.
  await f.inbox.markRead({ id: a1.id, operator_id: operatorA });
  var two = await f.inbox.unreadCount({ operator_id: operatorA });
  check("unreadCount drops after markRead",         two === 2);

  // archive drops it too (archived rows excluded by definition).
  var m2id = (await f.inbox.inboxForOperator({ operator_id: operatorA })).rows.filter(function (r) { return r.subject === "a2"; })[0].id;
  await f.inbox.archiveMessage({ id: m2id, operator_id: operatorA });
  var one = await f.inbox.unreadCount({ operator_id: operatorA });
  check("unreadCount drops after archive",          one === 1);
}

// ---- cleanupOlderThan --------------------------------------------------

async function _cleanupSweep() {
  var operatorA = _uuid();
  var f = _factory();

  await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "info", subject: "x1", body: "x1" });
  await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "info_event", severity: "info", subject: "x2", body: "x2" });

  // Use waitUntil so the test is patient about the monotonic clock
  // advancing past the cutoff under runner contention.
  await waitUntil(async function () {
    var feed = await f.inbox.inboxForOperator({ operator_id: operatorA });
    return feed.rows.length === 2;
  }, { label: "cleanupOlderThan: inbox seeded with 2 rows" });

  // Cleanup with a now far in the future + age_ms small => deletes all.
  var farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
  var swept = await f.inbox.cleanupOlderThan({ now: farFuture, age_ms: 1 });
  check("cleanupOlderThan deletes all",             swept.deleted_count === 2);
  check("cleanupOlderThan returns cutoff",          typeof swept.cutoff === "number");

  var empty = await f.inbox.inboxForOperator({ operator_id: operatorA });
  check("cleanupOlderThan empties inbox",           empty.rows.length === 0);

  // Negative + zero age_ms refused.
  await assert.rejects(
    f.inbox.cleanupOlderThan({ age_ms: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    f.inbox.cleanupOlderThan({ age_ms: -5 }),
    /positive integer/,
  );
}

// ---- metricsForKind ----------------------------------------------------

async function _metricsHistogram() {
  var operatorA = _uuid();
  var f = _factory();

  // Two info + one warning + one critical of kind="refund_failure".
  var m1 = await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "refund_failure", severity: "info",     subject: "rf1", body: "rf1" });
  await f.inbox.enqueueMessage({       operator_id: operatorA, kind: "refund_failure", severity: "info",     subject: "rf2", body: "rf2" });
  var m3 = await f.inbox.enqueueMessage({ operator_id: operatorA, kind: "refund_failure", severity: "warning",  subject: "rf3", body: "rf3" });
  await f.inbox.enqueueMessage({       operator_id: operatorA, kind: "refund_failure", severity: "critical", subject: "rf4", body: "rf4" });
  // One row of a different kind — must not appear in the rollup.
  await f.inbox.enqueueMessage({       operator_id: operatorA, kind: "low_stock",     severity: "info",     subject: "ls1", body: "ls1" });

  // Mark m1 read, m3 archived so we exercise every by_state bucket.
  await f.inbox.markRead({       id: m1.id, operator_id: operatorA });
  await f.inbox.archiveMessage({ id: m3.id, operator_id: operatorA });

  var metrics = await f.inbox.metricsForKind({ kind: "refund_failure", from: 0, to: Date.now() + 1000 });
  check("metricsForKind kind echoed",              metrics.kind === "refund_failure");
  check("metricsForKind total only this kind",     metrics.total === 4);
  check("metricsForKind by_severity info",         metrics.by_severity.info     === 2);
  check("metricsForKind by_severity warning",      metrics.by_severity.warning  === 1);
  check("metricsForKind by_severity critical",     metrics.by_severity.critical === 1);
  check("metricsForKind by_severity urgent zero",  metrics.by_severity.urgent   === 0);
  check("metricsForKind by_state unread",          metrics.by_state.unread   === 2);   // rf2 + rf4
  check("metricsForKind by_state read",            metrics.by_state.read     === 1);   // rf1
  check("metricsForKind by_state archived",        metrics.by_state.archived === 1);   // rf3
  check("metricsForKind median latency present",   typeof metrics.median_read_latency_ms === "number"
                                                    && metrics.median_read_latency_ms >= 0);

  // Bad window refused.
  await assert.rejects(
    f.inbox.metricsForKind({ kind: "refund_failure", from: 100, to: 50 }),
    /from must be <= to/,
  );
}

// ---- exported constants + validation surface ---------------------------

async function _exportedConstants() {
  check("SEVERITIES exported",                Array.isArray(operatorInbox.SEVERITIES)
                                              && operatorInbox.SEVERITIES.indexOf("info") !== -1
                                              && operatorInbox.SEVERITIES.indexOf("warning") !== -1
                                              && operatorInbox.SEVERITIES.indexOf("urgent") !== -1
                                              && operatorInbox.SEVERITIES.indexOf("critical") !== -1);
  check("SEVERITY_RANK exported",             typeof operatorInbox.SEVERITY_RANK === "object"
                                              && operatorInbox.SEVERITY_RANK.info     === 0
                                              && operatorInbox.SEVERITY_RANK.critical === 3);
  check("MAX_SUBJECT_LEN exported",           operatorInbox.MAX_SUBJECT_LEN === 200);
  check("MAX_BODY_LEN exported",              operatorInbox.MAX_BODY_LEN === 8000);
  check("MAX_BULK_IDS exported",              operatorInbox.MAX_BULK_IDS === 200);
  check("DEFAULT_LIMIT exported",             operatorInbox.DEFAULT_LIMIT === 50);

  var inst = operatorInbox.create({ query: _makeQuery().query, cursorSecret: "x" });
  check("instance exposes SEVERITIES",        Array.isArray(inst.SEVERITIES) && inst.SEVERITIES.length === 4);

  // Production cursorSecret requirement.
  var prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(function () {
      operatorInbox.create({ query: _makeQuery().query });
    }, /cursorSecret is required in production/);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }

  // operatorRoles allow-list bad-shape refused.
  assert.throws(function () {
    operatorInbox.create({ query: _makeQuery().query, cursorSecret: "x", operatorRoles: 42 });
  }, /operatorRoles must be a string\[\]/);

  // operatorRoles allow-list duplicate refused.
  assert.throws(function () {
    operatorInbox.create({ query: _makeQuery().query, cursorSecret: "x", operatorRoles: ["a", "a"] });
  }, /duplicates a prior entry/);

  // Bad operator_id (non-UUID) refused at the entry point.
  var inst2 = operatorInbox.create({ query: _makeQuery().query, cursorSecret: "x" });
  await assert.rejects(
    inst2.enqueueMessage({
      operator_id: "not-a-uuid",
      kind:        "info_event",
      severity:    "info",
      subject:     "x",
      body:        "x",
    }),
    /operator_id/,
  );
}

// ---- role-scoped read + write surface ----------------------------------
//
// inboxForRole / unreadCountForRole / markReadForRole / archiveForRole back
// a console that addresses notifications to a role and has no per-operator
// session to fold role membership through (a single-credential admin). They
// return / mutate ONLY `role = ?` rows, never operator-id-addressed ones.
async function _roleScopedSurface() {
  var f = _factory();   // no operatorRoles peer — pure role addressing

  // Two role-broadcasts to "fulfillment", one to a different role, one to
  // an operator id. The fulfillment reads must see ONLY the two fulfillment
  // rows.
  var a = await f.inbox.enqueueMessage({
    role: "fulfillment", kind: "order_paid", severity: "info",
    subject: "New order A", body: "Order A paid.",
  });
  var b2 = await f.inbox.enqueueMessage({
    role: "fulfillment", kind: "order_paid", severity: "warning",
    subject: "New order B", body: "Order B paid.",
  });
  await f.inbox.enqueueMessage({
    role: "support", kind: "ticket", severity: "info",
    subject: "Support row", body: "Not for fulfillment.",
  });
  await f.inbox.enqueueMessage({
    operator_id: _uuid(), kind: "order_paid", severity: "info",
    subject: "Operator-addressed", body: "Not a role broadcast.",
  });

  var feed = await f.inbox.inboxForRole({ role: "fulfillment", limit: 50 });
  check("inboxForRole returns only the role's rows", feed.rows.length === 2);
  check("inboxForRole excludes other roles",
    feed.rows.every(function (r) { return r.role === "fulfillment"; }));
  check("inboxForRole excludes operator-id rows",
    feed.rows.every(function (r) { return r.operator_id == null; }));
  check("inboxForRole newest-first",
    feed.rows[0].id === b2.id && feed.rows[1].id === a.id);

  // unreadCountForRole — both unread now.
  var c0 = await f.inbox.unreadCountForRole({ role: "fulfillment" });
  check("unreadCountForRole counts the role's unread", c0 === 2);
  // severity_min floors the rank ladder.
  var cWarn = await f.inbox.unreadCountForRole({ role: "fulfillment", severity_min: "warning" });
  check("unreadCountForRole severity_min floors", cWarn === 1);

  // markReadForRole clears one — drops the unread count, idempotent.
  var read = await f.inbox.markReadForRole({ id: a.id, role: "fulfillment" });
  check("markReadForRole stamps read_at", read.read_at != null);
  check("unreadCountForRole drops after read",
    (await f.inbox.unreadCountForRole({ role: "fulfillment" })) === 1);
  var readAgain = await f.inbox.markReadForRole({ id: a.id, role: "fulfillment" });
  check("markReadForRole idempotent", readAgain.read_at === read.read_at);

  // A row addressed to a DIFFERENT role can't be cleared via "fulfillment".
  var support = (await f.inbox.inboxForRole({ role: "support", limit: 10 })).rows[0];
  await assert.rejects(
    function () { return f.inbox.markReadForRole({ id: support.id, role: "fulfillment" }); },
    /not addressed to this role/,
  );
  check("cross-role row left unread",
    (await f.inbox.inboxForRole({ role: "support", limit: 10 })).rows[0].read_at == null);

  // archiveForRole drops the row from the default feed; include_archived
  // brings it back.
  await f.inbox.archiveForRole({ id: b2.id, role: "fulfillment" });
  var active = await f.inbox.inboxForRole({ role: "fulfillment", limit: 50 });
  check("archiveForRole drops from active feed",
    active.rows.every(function (r) { return r.id !== b2.id; }));
  var withArchived = await f.inbox.inboxForRole({ role: "fulfillment", include_archived: true, limit: 50 });
  check("include_archived surfaces the archived row",
    withArchived.rows.some(function (r) { return r.id === b2.id; }));
  check("unreadCountForRole excludes archived",
    (await f.inbox.unreadCountForRole({ role: "fulfillment" })) === 0);

  // An unknown id is a coded not-found; a malformed id is a TypeError.
  await assert.rejects(
    function () { return f.inbox.markReadForRole({ id: _uuid(), role: "fulfillment" }); },
    function (e) { return e.code === "INBOX_MESSAGE_NOT_FOUND"; },
  );
  await assert.rejects(
    function () { return f.inbox.archiveForRole({ id: "not-a-uuid", role: "fulfillment" }); },
    /id —/,
  );
}

async function run() {
  await _enqueueAddressing();
  await _inboxFilters();
  await _markReadUnreadFsm();
  await _archiveBehaviour();
  await _unreadCountBadge();
  await _roleScopedSurface();
  await _cleanupSweep();
  await _metricsHistogram();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - operator-inbox (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
