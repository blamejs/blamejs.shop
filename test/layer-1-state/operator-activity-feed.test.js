"use strict";
/**
 * operatorActivityFeed — operator-side activity timeline aggregator.
 *
 * Layer 1 against in-memory node:sqlite loaded from the migrations
 * each source primitive owns + the 0188 cache migration.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/operator-activity-feed.js` directly so the gate exists ahead
 * of the entry-point edit.
 *
 * Coverage:
 *   - forOperator mixes audit / support / inbox / session sources via stubs
 *   - forOperator kinds filter restricts the feed
 *   - forOperator cursor paginates deterministically
 *   - teamFeed surfaces events across every operator
 *   - summarizeForOperator aggregates kind counts + caches
 *   - recentLogins reads operator_sessions
 *   - currentlyOnline gates on the 5-minute window
 *   - topActions ranks operator_audit_events by frequency
 *   - skip-injected-peers — factory tolerates missing peers cleanly
 *   - validation refusals on bad inputs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop                = require("../../lib");
var operatorActivityFeed = require("../../lib/operator-activity-feed");
var helpers              = require("../helpers");
var check                = helpers.check;
var assert               = helpers.assert;

var MIGS = [
  "0047_support_tickets.sql",
  "0074_operator_audit_log.sql",
  "0165_operator_sessions.sql",
  "0175_operator_inbox.sql",
  "0188_operator_activity_feed.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
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
  return async function (sql, params) {
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
}

function _validUUID() { return bShop.framework.uuid.v7(); }

// ---- seeding helpers ---------------------------------------------------

async function _seedAuditEvent(query, operatorId, action, occurredAt) {
  // Walks the operatorAuditLog primitive so the chain hashes stay
  // consistent — the primitive's monotonic-clock guard means we can't
  // pass occurred_at directly; the helper records the row and then
  // patches occurred_at after the fact for window tests that need a
  // specific timestamp.
  var auditLog = bShop.operatorAuditLog.create({ query: query });
  var row = await auditLog.record({
    actor_type:    "operator",
    actor_id:      operatorId,
    action:        action,
    resource_kind: "product",
    resource_id:   _validUUID(),
  });
  if (occurredAt != null) {
    await query(
      "UPDATE operator_audit_events SET occurred_at = ?1 WHERE id = ?2",
      [occurredAt, row.id],
    );
  }
  return row;
}

async function _seedSupportTicket(query, operatorId, opts) {
  opts = opts || {};
  var ticketId = _validUUID();
  var nowMs = opts.opened_at || Date.now();
  await query(
    "INSERT INTO support_tickets " +
    "(id, customer_id, customer_email_hash, subject, body, category, status, " +
    "priority, order_id, assigned_operator_id, tags_json, opened_at, " +
    "first_response_at, last_action_at, resolved_at, closed_at) " +
    "VALUES (?1, NULL, ?2, ?3, ?4, 'order_issue', 'in_progress', ?5, NULL, " +
    "?6, '[]', ?7, NULL, ?7, ?8, NULL)",
    [
      ticketId,
      "hash-" + ticketId,
      opts.subject || "Where is my order?",
      "Customer says tracking is stale.",
      opts.priority || "high",
      operatorId,
      nowMs,
      opts.resolved_at == null ? null : opts.resolved_at,
    ],
  );
  return ticketId;
}

async function _seedInboxMessage(query, operatorId, opts) {
  opts = opts || {};
  var id = _validUUID();
  await query(
    "INSERT INTO operator_inbox_messages " +
    "(id, operator_id, role, kind, severity, subject, body, payload_json, " +
    "source_event_id, read_at, archived_at, created_at) " +
    "VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, '{}', NULL, NULL, NULL, ?7)",
    [
      id,
      operatorId,
      opts.kind     || "low_stock",
      opts.severity || "warning",
      opts.subject  || "Stock low on SKU-1",
      opts.body     || "Only 3 units left.",
      opts.created_at || Date.now(),
    ],
  );
  return id;
}

async function _seedRoleInbox(query, role, opts) {
  opts = opts || {};
  var id = _validUUID();
  await query(
    "INSERT INTO operator_inbox_messages " +
    "(id, operator_id, role, kind, severity, subject, body, payload_json, " +
    "source_event_id, read_at, archived_at, created_at) " +
    "VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, '{}', NULL, NULL, NULL, ?7)",
    [
      id,
      role,
      opts.kind     || "security_incident",
      opts.severity || "urgent",
      opts.subject  || "Suspicious login attempt",
      opts.body     || "Investigate.",
      opts.created_at || Date.now(),
    ],
  );
  return id;
}

async function _seedSession(query, operatorId, opts) {
  opts = opts || {};
  var id = _validUUID();
  var nowMs = opts.created_at || Date.now();
  var status = opts.status || "active";
  await query(
    "INSERT INTO operator_sessions " +
    "(id, operator_id, token_hash, ip_hash, ua_class, status, mfa_required, " +
    "mfa_verified_at, activated_at, revoked_at, revoke_reason, ttl_seconds, " +
    "created_at, expires_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?8, ?9, 28800, ?10, ?11)",
    [
      id,
      operatorId,
      "tokhash-" + id,
      opts.ip_hash || "iphash-1",
      opts.ua_class || "browser",
      status,
      opts.activated_at == null ? nowMs : opts.activated_at,
      opts.revoked_at == null ? null : opts.revoked_at,
      opts.revoke_reason == null ? null : opts.revoke_reason,
      nowMs,
      opts.expires_at || (nowMs + 28800000),
    ],
  );
  return id;
}

// ---- forOperator mixes sources ----------------------------------------

async function _forOperatorMixesSources() {
  var q = _makeQuery();
  var op = _validUUID();
  var auditLog = bShop.operatorAuditLog.create({ query: q });
  await _seedAuditEvent(q, op, "price_override");
  await _seedSupportTicket(q, op, { resolved_at: Date.now() + 5000 });
  await _seedInboxMessage(q, op, { kind: "refund_failure", severity: "urgent" });
  await _seedSession(q, op, { revoked_at: Date.now() + 3000, revoke_reason: "logout" });

  var feed = operatorActivityFeed.create({
    query:            q,
    cursorSecret:     "oaf-test-cursor",
    operatorAuditLog: auditLog,
    supportTickets:   { __injected: true },
    operatorInbox:    { __injected: true },
  });

  var page = await feed.forOperator({ operator_id: op });
  check("forOperator returns events array",         Array.isArray(page.events));
  check("forOperator surfaces audit event",         page.events.some(function (e) { return e.kind === "audit.price_override"; }));
  check("forOperator surfaces support.assigned",    page.events.some(function (e) { return e.kind === "support.assigned"; }));
  check("forOperator surfaces support.resolved",    page.events.some(function (e) { return e.kind === "support.resolved"; }));
  check("forOperator surfaces inbox event",         page.events.some(function (e) { return e.kind === "inbox.refund_failure"; }));
  check("forOperator surfaces session.login",       page.events.some(function (e) { return e.kind === "session.login"; }));
  check("forOperator surfaces session.revoked",     page.events.some(function (e) { return e.kind === "session.revoked"; }));

  // Newest-first ordering.
  var monotonic = true;
  for (var i = 1; i < page.events.length; i += 1) {
    if (page.events[i].occurred_at > page.events[i - 1].occurred_at) { monotonic = false; break; }
  }
  check("forOperator newest-first ordering", monotonic);

  // Documented shape.
  var shapeOk = page.events.every(function (e) {
    return typeof e.kind === "string"
        && typeof e.occurred_at === "number"
        && typeof e.title === "string"
        && (e.body === null || typeof e.body === "string")
        && (e.link === null || typeof e.link === "string")
        && (e.action === null || typeof e.action === "string")
        && typeof e.severity === "string";
  });
  check("forOperator events have documented shape", shapeOk);
}

// ---- kinds filter ------------------------------------------------------

async function _kindsFilter() {
  var q = _makeQuery();
  var op = _validUUID();
  var auditLog = bShop.operatorAuditLog.create({ query: q });
  await _seedAuditEvent(q, op, "price_override");
  await _seedSupportTicket(q, op, {});
  await _seedInboxMessage(q, op, { kind: "low_stock" });

  var feed = operatorActivityFeed.create({
    query:            q,
    cursorSecret:     "oaf-test-kinds",
    operatorAuditLog: auditLog,
    supportTickets:   { __injected: true },
    operatorInbox:    { __injected: true },
  });

  var filtered = await feed.forOperator({
    operator_id: op,
    kinds:       ["inbox.low_stock"],
  });
  check("kinds filter returns only allowed kinds",
    filtered.events.every(function (e) { return e.kind === "inbox.low_stock"; }));
  check("kinds filter hides audit events",
    !filtered.events.some(function (e) { return e.kind.indexOf("audit.") === 0; }));
}

// ---- cursor pagination -------------------------------------------------

async function _cursorPagination() {
  var q = _makeQuery();
  var op = _validUUID();
  var auditLog = bShop.operatorAuditLog.create({ query: q });

  // Seed enough events to split across pages.
  for (var i = 0; i < 6; i += 1) {
    await _seedInboxMessage(q, op, {
      kind:       "low_stock",
      subject:    "Stock low " + i,
      created_at: Date.now() + 10 + i,
    });
  }

  var feed = operatorActivityFeed.create({
    query:            q,
    cursorSecret:     "oaf-test-cursor-pag",
    operatorAuditLog: auditLog,
    operatorInbox:    { __injected: true },
  });

  var p1 = await feed.forOperator({ operator_id: op, limit: 3 });
  check("page-1 respects limit",   p1.events.length <= 3);
  check("page-1 has next_cursor",  typeof p1.next_cursor === "string" && p1.next_cursor.length > 0);

  var p2 = await feed.forOperator({ operator_id: op, limit: 3, cursor: p1.next_cursor });
  check("page-2 returns events",   p2.events.length > 0);

  // No overlap.
  var firstKeys = {};
  for (var f = 0; f < p1.events.length; f += 1) {
    firstKeys[p1.events[f].occurred_at + "|" + p1.events[f].kind] = true;
  }
  var overlap = p2.events.some(function (e) {
    return firstKeys[e.occurred_at + "|" + e.kind];
  });
  check("pages do not overlap", !overlap);

  // Wrong-orderKey cursor rejected.
  var badCursor = bShop.framework.pagination.encodeCursor({
    orderKey: ["wrong"],
    vals:     [0],
    forward:  true,
  }, "oaf-test-cursor-pag");
  await assert.rejects(
    feed.forOperator({ operator_id: op, cursor: badCursor }),
    /cursor orderKey mismatch/,
  );
}

// ---- teamFeed cross-operator -------------------------------------------

async function _teamFeedCrossOperator() {
  var q = _makeQuery();
  var op1 = _validUUID();
  var op2 = _validUUID();
  var auditLog = bShop.operatorAuditLog.create({ query: q });

  await _seedAuditEvent(q, op1, "price_override");
  await _seedAuditEvent(q, op2, "tax_rate_change");
  await _seedSupportTicket(q, op1, {});
  await _seedInboxMessage(q, op2, { kind: "low_stock" });
  await _seedRoleInbox(q, "support_lead", { kind: "security_incident" });

  var feed = operatorActivityFeed.create({
    query:            q,
    cursorSecret:     "oaf-test-team",
    operatorAuditLog: auditLog,
    supportTickets:   { __injected: true },
    operatorInbox:    { __injected: true },
  });

  var rows = await feed.teamFeed({ limit: 20 });
  check("teamFeed returns array", Array.isArray(rows));
  check("teamFeed surfaces op1 audit", rows.some(function (e) {
    return e.kind === "audit.price_override" && e.operator_id === op1;
  }));
  check("teamFeed surfaces op2 audit", rows.some(function (e) {
    return e.kind === "audit.tax_rate_change" && e.operator_id === op2;
  }));
  check("teamFeed surfaces op1 support", rows.some(function (e) {
    return e.kind === "support.assigned" && e.operator_id === op1;
  }));
  check("teamFeed surfaces op2 inbox",   rows.some(function (e) {
    return e.kind === "inbox.low_stock" && e.operator_id === op2;
  }));
  check("teamFeed surfaces role-broadcast inbox with null operator", rows.some(function (e) {
    return e.kind === "inbox.security_incident" && e.operator_id === null;
  }));

  // Newest-first.
  var monotonic = true;
  for (var i = 1; i < rows.length; i += 1) {
    if (rows[i].occurred_at > rows[i - 1].occurred_at) { monotonic = false; break; }
  }
  check("teamFeed newest-first ordering", monotonic);

  // Limit honoured.
  var capped = await feed.teamFeed({ limit: 2 });
  check("teamFeed respects limit", capped.length <= 2);
}

// ---- summarizeForOperator aggregation ----------------------------------

async function _summarizeAggregates() {
  var q = _makeQuery();
  var op = _validUUID();
  var auditLog = bShop.operatorAuditLog.create({ query: q });

  await _seedAuditEvent(q, op, "price_override");
  await _seedAuditEvent(q, op, "tax_rate_change");
  await _seedInboxMessage(q, op, { kind: "low_stock" });

  var feed = operatorActivityFeed.create({
    query:            q,
    cursorSecret:     "oaf-test-sum",
    operatorAuditLog: auditLog,
    operatorInbox:    { __injected: true },
  });

  var sum = await feed.summarizeForOperator({ operator_id: op, days: 30 });
  check("summarize returns kind_counts object",      sum.kind_counts && typeof sum.kind_counts === "object");
  check("summarize counts price_override",           Number(sum.kind_counts["audit.price_override"]) === 1);
  check("summarize counts tax_rate_change",          Number(sum.kind_counts["audit.tax_rate_change"]) === 1);
  check("summarize counts inbox low_stock",          Number(sum.kind_counts["inbox.low_stock"]) === 1);
  check("summarize returns total",                   sum.total === 3);
  check("summarize last_activity_at is a number",    typeof sum.last_activity_at === "number");
  check("summarize first call is cache miss",        sum.cache_hit === false);

  // Cache row landed.
  var cacheRow = (await q(
    "SELECT * FROM operator_activity_cache WHERE operator_id = ?1",
    [op],
  )).rows[0];
  check("cache row written by summarize",            cacheRow != null);
  check("cache row carries last_activity_at",        Number(cacheRow.last_activity_at) > 0);

  // Second call hits cache freshness.
  var sum2 = await feed.summarizeForOperator({ operator_id: op, days: 30 });
  check("summarize second call hits cache",          sum2.cache_hit === true);
  check("summarize cached counts match",             Number(sum2.kind_counts["audit.price_override"]) === 1);
}

// ---- recentLogins ------------------------------------------------------

async function _recentLoginsRead() {
  var q = _makeQuery();
  var op = _validUUID();
  var nowMs = Date.now();
  await _seedSession(q, op, { created_at: nowMs - 60000, ua_class: "browser" });
  await _seedSession(q, op, { created_at: nowMs - 30000, ua_class: "browser", revoked_at: nowMs - 20000, revoke_reason: "logout", status: "revoked" });
  await _seedSession(q, op, { created_at: nowMs - 5000, ua_class: "mobile_app" });

  var feed = operatorActivityFeed.create({ query: q, cursorSecret: "oaf-test-recent" });

  var rows = await feed.recentLogins({ operator_id: op });
  check("recentLogins returns array",           Array.isArray(rows));
  check("recentLogins returns three rows",      rows.length === 3);
  check("recentLogins newest-first",            rows[0].created_at >= rows[1].created_at);
  check("recentLogins exposes ua_class",        rows[0].ua_class === "mobile_app");
  check("recentLogins exposes revoke_reason",   rows.some(function (r) { return r.revoke_reason === "logout"; }));

  // Operator with no sessions returns empty.
  var empty = await feed.recentLogins({ operator_id: _validUUID() });
  check("recentLogins empty for unknown operator", Array.isArray(empty) && empty.length === 0);
}

// ---- currentlyOnline ---------------------------------------------------

async function _currentlyOnlineGates() {
  var q = _makeQuery();
  var nowMs = Date.now();
  var opActive   = _validUUID();
  var opStale    = _validUUID();
  var opRevoked  = _validUUID();

  // Active within the 5-minute window.
  await _seedSession(q, opActive, {
    created_at:   nowMs - 60000,
    activated_at: nowMs - 60000,
    status:       "active",
    expires_at:   nowMs + 600000,
  });
  // Active row but activity stamp is older than 5 minutes.
  await _seedSession(q, opStale, {
    created_at:   nowMs - 10 * 60 * 1000,
    activated_at: nowMs - 10 * 60 * 1000,
    status:       "active",
    expires_at:   nowMs + 600000,
  });
  // Revoked row inside window — must not surface.
  await _seedSession(q, opRevoked, {
    created_at:   nowMs - 30000,
    activated_at: nowMs - 30000,
    revoked_at:   nowMs - 10000,
    revoke_reason: "logout",
    status:       "revoked",
    expires_at:   nowMs + 600000,
  });

  var feed = operatorActivityFeed.create({ query: q, cursorSecret: "oaf-test-online" });

  var online = await feed.currentlyOnline();
  check("currentlyOnline returns array",                Array.isArray(online));
  check("currentlyOnline includes recently-active",     online.some(function (r) { return r.operator_id === opActive; }));
  check("currentlyOnline excludes stale-active",        !online.some(function (r) { return r.operator_id === opStale; }));
  check("currentlyOnline excludes revoked",             !online.some(function (r) { return r.operator_id === opRevoked; }));
  check("currentlyOnline rows carry last_seen_at",      online.every(function (r) { return typeof r.last_seen_at === "number"; }));
}

// ---- topActions --------------------------------------------------------

async function _topActionsRanking() {
  var q = _makeQuery();
  var op1 = _validUUID();
  var op2 = _validUUID();
  var auditLog = bShop.operatorAuditLog.create({ query: q });

  await _seedAuditEvent(q, op1, "price_override");
  await _seedAuditEvent(q, op2, "price_override");
  await _seedAuditEvent(q, op1, "price_override");
  await _seedAuditEvent(q, op2, "tax_rate_change");

  var feed = operatorActivityFeed.create({
    query:            q,
    cursorSecret:     "oaf-test-top",
    operatorAuditLog: auditLog,
  });

  var ranks = await feed.topActions({
    from:  0,
    to:    Date.now() + 86400000,
    limit: 10,
  });
  check("topActions returns array",                  Array.isArray(ranks));
  check("topActions includes price_override",        ranks.some(function (r) { return r.action === "price_override"; }));
  check("topActions includes tax_rate_change",       ranks.some(function (r) { return r.action === "tax_rate_change"; }));

  // price_override appears 3 times; tax_rate_change once — ranking must
  // put price_override first.
  check("topActions ranks by count DESC",            ranks[0].action === "price_override");
  check("topActions count reflects frequency",       Number(ranks[0].count) === 3);
}

// ---- skip-injected-peers ----------------------------------------------

async function _skipInjectedPeers() {
  var q = _makeQuery();
  var op = _validUUID();
  var auditLog = bShop.operatorAuditLog.create({ query: q });

  await _seedAuditEvent(q, op, "price_override");
  await _seedSupportTicket(q, op, {});
  await _seedInboxMessage(q, op, { kind: "low_stock" });

  // Only audit is wired.
  var feed = operatorActivityFeed.create({
    query:            q,
    cursorSecret:     "oaf-test-skip",
    operatorAuditLog: auditLog,
  });

  var page = await feed.forOperator({ operator_id: op });
  check("skip-peers surfaces audit events",      page.events.some(function (e) { return e.kind.indexOf("audit.") === 0; }));
  check("skip-peers omits support events",       !page.events.some(function (e) { return e.kind.indexOf("support.") === 0; }));
  check("skip-peers omits inbox events",         !page.events.some(function (e) { return e.kind.indexOf("inbox.") === 0; }));

  // topActions with no auditPeer returns [].
  var bareFeed = operatorActivityFeed.create({
    query:        q,
    cursorSecret: "oaf-test-skip-bare",
  });
  var bareTop = await bareFeed.topActions({ from: 0, to: Date.now() + 86400000 });
  check("topActions without auditPeer returns empty", Array.isArray(bareTop) && bareTop.length === 0);
}

// ---- validation refusals ----------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var feed = operatorActivityFeed.create({ query: q, cursorSecret: "oaf-test-validation" });

  await assert.rejects(feed.forOperator(),                                  /input object required/);
  await assert.rejects(feed.forOperator({}),                                /operator_id/);
  await assert.rejects(feed.forOperator({ operator_id: "not-a-uuid" }),     /operator_id/);
  await assert.rejects(feed.forOperator({ operator_id: _validUUID(), limit: 0 }),     /limit/);
  await assert.rejects(feed.forOperator({ operator_id: _validUUID(), limit: 99999 }), /limit/);
  await assert.rejects(feed.forOperator({ operator_id: _validUUID(), from: -1 }),     /from/);
  await assert.rejects(feed.forOperator({ operator_id: _validUUID(), from: 200, to: 100 }), /from must be/);
  await assert.rejects(feed.forOperator({ operator_id: _validUUID(), kinds: "not-an-array" }), /kinds/);
  await assert.rejects(feed.forOperator({ operator_id: _validUUID(), kinds: ["bad kind"] }),   /kinds/);
  await assert.rejects(feed.forOperator({ operator_id: _validUUID(), cursor: 12345 }),         /cursor/);

  await assert.rejects(feed.teamFeed(),                                     /input object required/);
  await assert.rejects(feed.teamFeed({ from: 200, to: 100 }),               /from must be/);
  await assert.rejects(feed.teamFeed({ limit: 0 }),                         /limit/);

  await assert.rejects(feed.summarizeForOperator(),                         /input object required/);
  await assert.rejects(feed.summarizeForOperator({ days: 30 }),             /operator_id/);
  await assert.rejects(feed.summarizeForOperator({ operator_id: _validUUID() }), /days/);
  await assert.rejects(feed.summarizeForOperator({ operator_id: _validUUID(), days: 0 }), /days/);

  await assert.rejects(feed.recentLogins(),                                 /input object required/);
  await assert.rejects(feed.recentLogins({ operator_id: "bad" }),           /operator_id/);

  await assert.rejects(feed.topActions(),                                   /input object required/);
  await assert.rejects(feed.topActions({ to: 100 }),                        /from is required/);
  await assert.rejects(feed.topActions({ from: 0 }),                        /to is required/);
  await assert.rejects(feed.topActions({ from: 200, to: 100 }),             /from must be/);
}

async function run() {
  await _forOperatorMixesSources();
  await _kindsFilter();
  await _cursorPagination();
  await _teamFeedCrossOperator();
  await _summarizeAggregates();
  await _recentLoginsRead();
  await _currentlyOnlineGates();
  await _topActionsRanking();
  await _skipInjectedPeers();
  await _validationRefusals();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/operator-activity-feed.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — operator-activity-feed (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — operator-activity-feed: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
