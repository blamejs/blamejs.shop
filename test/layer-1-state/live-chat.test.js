"use strict";
/**
 * liveChat — real-time customer-service queueing for the storefront.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0113.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/live-chat.js` directly so the gate exists ahead of the entry-
 * point edit.
 *
 * Coverage:
 *   - openSession + enqueueSession seeding + visitor hash never
 *     stores raw session id / raw email
 *   - assignToOperator flips queued -> assigned, emits system msg
 *   - recordMessage round trip + status advancement (customer ->
 *     active, operator -> waiting), since-filter, terminal refusal
 *   - FSM transition refusals (illegal edges + terminal lock)
 *   - waitingQueue FIFO ordering, limit cap
 *   - operatorQueue + operatorWorkload counts
 *   - operator state markers + cleanupAbandoned reaper
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop    = require("../../lib");
var liveChat = require("../../lib/live-chat");
var helpers  = require("../helpers");
var check    = helpers.check;
var assert   = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0113_live_chat.sql"
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

function _validUUID() { return bShop.framework.uuid.v7(); }

function _setup() {
  var query = _makeQuery();
  var chat  = liveChat.create({ query: query });
  return { query: query, chat: chat };
}

async function _openSessionAndEnqueue() {
  var ctx = _setup();

  var s = await ctx.chat.openSession({
    session_id:      "visitor-cookie-abcd1234",
    source_page:     "/products/widget",
    visitor_email:   "Alice@Example.com",
    initial_message: "Hi! Is this widget compatible with the BlamejsBase v3?",
  });
  check("openSession returns 36-char uuid",         typeof s.id === "string" && s.id.length === 36);
  check("openSession stamps status='queued'",       s.status === "queued");
  check("openSession hashes visitor session id",    typeof s.visitor_session_id_hash === "string" && /^[0-9a-f]{128}$/.test(s.visitor_session_id_hash));
  check("openSession hashes visitor email",         typeof s.visitor_email_hash === "string" && /^[0-9a-f]{128}$/.test(s.visitor_email_hash));
  check("openSession does NOT store raw email",     Object.keys(s).indexOf("visitor_email") === -1);
  check("openSession does NOT store raw session",   Object.keys(s).indexOf("visitor_session_id") === -1);
  check("openSession source_page persisted",        s.source_page === "/products/widget");
  check("openSession opened_at == last_activity_at", s.opened_at === s.last_activity_at);
  check("openSession assigned_operator_id null",    s.assigned_operator_id == null);
  check("openSession assigned_at null",             s.assigned_at == null);
  check("openSession closed_at null",               s.closed_at == null);

  // Seeded transcript: system "opened" + customer initial message.
  // Both land at the same `occurred_at` so order between same-ts
  // rows is the tiebreaker — assert presence + content, not slot.
  var msgs = await ctx.chat.messagesForSession({ session_id: s.id });
  check("transcript has 2 lines",                   msgs.length === 2);
  var sysLines = msgs.filter(function (m) { return m.author === "system"; });
  var custLines = msgs.filter(function (m) { return m.author === "customer"; });
  check("transcript records system opened beat",    sysLines.length === 1 && sysLines[0].body.indexOf("session opened") !== -1);
  check("transcript records customer initial msg",  custLines.length === 1 && custLines[0].body.indexOf("BlamejsBase v3") !== -1);

  // Email casing — hash matches across casings.
  var lowered = bShop.framework.crypto.namespaceHash("live-chat-email", "alice@example.com");
  check("email hash matches lowercase canonical",   s.visitor_email_hash === lowered);

  // Open another without an initial message — just the system opener lands.
  var s2 = await ctx.chat.openSession({
    session_id:  "visitor-cookie-9999",
    source_page: "/cart",
  });
  var msgs2 = await ctx.chat.messagesForSession({ session_id: s2.id });
  check("opener-only transcript has 1 line",        msgs2.length === 1 && msgs2[0].author === "system");
  check("opener-only stamps queued",                s2.status === "queued");
  check("opener-only visitor_email_hash null",      s2.visitor_email_hash == null);

  // enqueueSession on a queued row is a no-op.
  var sAgain = await ctx.chat.enqueueSession(s.id);
  check("enqueueSession queued is no-op",           sAgain.status === "queued" && sAgain.opened_at === s.opened_at);

  // openSession refusals.
  await assert.rejects(ctx.chat.openSession(),                                                /input object required/);
  await assert.rejects(ctx.chat.openSession({ source_page: "/x" }),                            /session_id/);
  await assert.rejects(ctx.chat.openSession({ session_id: "x", source_page: "" }),             /source_page/);
  await assert.rejects(ctx.chat.openSession({
    session_id: "x", source_page: "/x", visitor_email: "not-an-email",
  }), /visitor_email/);
  await assert.rejects(ctx.chat.openSession({
    session_id: "x", source_page: "/x", initial_message: "",
  }), /body/);
  await assert.rejects(ctx.chat.openSession({
    session_id: "x", source_page: "/x", initial_message: "bad\x00body",
  }), /control bytes/);
  await assert.rejects(ctx.chat.openSession({
    session_id: "x", source_page: "/x", initial_message: "x".repeat(liveChat.MAX_BODY_LEN + 1),
  }), /body/);
  await assert.rejects(ctx.chat.openSession({
    session_id: "x", source_page: "/x", customer_id: "not-a-uuid",
  }), /customer_id/);
}

async function _assignToOperatorTransitions() {
  var ctx = _setup();
  var s = await ctx.chat.openSession({
    session_id:  "vsid-assign",
    source_page: "/help",
  });
  var operatorId = _validUUID();

  var assigned = await ctx.chat.assignToOperator({
    session_id:  s.id,
    operator_id: operatorId,
  });
  check("assignToOperator flips status='assigned'", assigned.status === "assigned");
  check("assignToOperator stamps operator id",      assigned.assigned_operator_id === operatorId);
  check("assignToOperator stamps assigned_at",      typeof assigned.assigned_at === "number");
  check("assignToOperator bumps last_activity_at",  assigned.last_activity_at >= s.last_activity_at);

  // Transcript records system "operator joined".
  var msgs = await ctx.chat.messagesForSession({ session_id: s.id });
  var sysJoin = msgs.filter(function (m) { return m.author === "system" && m.body === "operator joined"; });
  check("transcript records operator-joined",       sysJoin.length === 1);

  // Double-assign refused (race serialisation).
  await assert.rejects(ctx.chat.assignToOperator({
    session_id: s.id, operator_id: _validUUID(),
  }), /refused/);

  // Bad uuid shapes refused.
  await assert.rejects(ctx.chat.assignToOperator({
    session_id: "not-a-uuid", operator_id: operatorId,
  }), /session_id/);
  await assert.rejects(ctx.chat.assignToOperator({
    session_id: s.id, operator_id: "not-a-uuid",
  }), /operator_id/);
  await assert.rejects(ctx.chat.assignToOperator({
    session_id: _validUUID(), operator_id: operatorId,
  }), /not found/);

  // enqueueSession releases assigned -> queued.
  var released = await ctx.chat.enqueueSession(s.id);
  check("enqueueSession assigned->queued",          released.status === "queued");
  check("enqueueSession clears operator_id",        released.assigned_operator_id == null);
  var msgsR = await ctx.chat.messagesForSession({ session_id: s.id });
  var sysReq = msgsR.filter(function (m) { return m.body === "session re-queued"; });
  check("transcript records re-queue beat",         sysReq.length === 1);
}

async function _recordMessageRoundTrip() {
  var ctx = _setup();
  var s = await ctx.chat.openSession({
    session_id:  "vsid-msgs",
    source_page: "/p/abc",
    initial_message: "Need help with checkout",
  });
  var op = _validUUID();
  // recordMessage by operator on queued is refused.
  await assert.rejects(ctx.chat.recordMessage({
    session_id: s.id, author: "operator", body: "hi",
  }), /assignToOperator/);

  // Customer can keep typing while still queued — does NOT advance status.
  var afterQueuedCust = await ctx.chat.recordMessage({
    session_id: s.id, author: "customer", body: "Still here, anyone?",
  });
  check("customer msg while queued stays queued",   afterQueuedCust.status === "queued");

  // Now assign + exchange.
  await ctx.chat.assignToOperator({ session_id: s.id, operator_id: op });
  var afterOpHi = await ctx.chat.recordMessage({
    session_id: s.id, author: "operator", body: "Hi! How can I help?",
  });
  check("operator msg -> status waiting",            afterOpHi.status === "waiting");
  check("operator msg bumps last_activity_at",       afterOpHi.last_activity_at >= s.last_activity_at);

  var beforeCust = afterOpHi.last_activity_at;
  await helpers.waitUntil(function () { return Date.now() > beforeCust; }, { timeoutMs: 5000, intervalMs: 2 });
  var afterCust = await ctx.chat.recordMessage({
    session_id: s.id, author: "customer", body: "I can't apply my coupon.",
  });
  check("customer msg -> status active",             afterCust.status === "active");
  check("customer msg bumps last_activity_at",       afterCust.last_activity_at > beforeCust);

  // Transcript ordering: system-open, customer-initial, customer-still-here,
  // system-operator-joined, operator-hi, customer-coupon.
  var transcript = await ctx.chat.messagesForSession({ session_id: s.id });
  check("transcript has 6 entries",                  transcript.length === 6);
  check("transcript ordered by occurred_at",         transcript.every(function (m, i) { return i === 0 || transcript[i - 1].occurred_at <= m.occurred_at; }));

  // messagesForSession with `since` filters.
  var midpoint = afterOpHi.last_activity_at;
  var sinceFiltered = await ctx.chat.messagesForSession({
    session_id: s.id, since: midpoint,
  });
  check("messagesForSession since filters",          sinceFiltered.every(function (m) { return m.occurred_at > midpoint; }));
  check("since slice contains the last customer msg",
    sinceFiltered.some(function (m) { return m.body === "I can't apply my coupon."; }));

  // closeSession refuses further messages.
  await ctx.chat.closeSession({ session_id: s.id, reason: "resolved" });
  await assert.rejects(ctx.chat.recordMessage({
    session_id: s.id, author: "customer", body: "anything else?",
  }), /cannot record more messages/);

  // Refusals.
  await assert.rejects(ctx.chat.recordMessage(),                                                /input object required/);
  await assert.rejects(ctx.chat.recordMessage({ session_id: s.id, author: "alien", body: "x" }), /author/);
  await assert.rejects(ctx.chat.recordMessage({ session_id: s.id, author: "system", body: "x" }), /author/);
  await assert.rejects(ctx.chat.recordMessage({ session_id: s.id, author: "customer", body: "" }), /body/);
  await assert.rejects(ctx.chat.recordMessage({ session_id: _validUUID(), author: "customer", body: "x" }), /not found/);
}

async function _fsmTransitionRefusals() {
  var ctx = _setup();
  var s = await ctx.chat.openSession({ session_id: "vsid-fsm", source_page: "/x" });
  // enqueue on queued is no-op (covered elsewhere). enqueue on active
  // (mid-conversation) is refused: see comment in enqueueSession.
  var op = _validUUID();
  await ctx.chat.assignToOperator({ session_id: s.id, operator_id: op });
  await ctx.chat.recordMessage({ session_id: s.id, author: "customer", body: "hello" });  // -> active

  await assert.rejects(ctx.chat.enqueueSession(s.id), /refused/);

  // Force close from active is allowed.
  var closed = await ctx.chat.closeSession({ session_id: s.id, reason: "operator-end" });
  check("close from active works",                  closed.status === "closed");
  check("closed_at + close_reason stamped",         typeof closed.closed_at === "number" && closed.close_reason === "operator-end");

  // Closed is terminal.
  await assert.rejects(ctx.chat.closeSession({ session_id: s.id, reason: "again" }), /refused/);
  await assert.rejects(ctx.chat.assignToOperator({ session_id: s.id, operator_id: op }), /refused/);
  await assert.rejects(ctx.chat.enqueueSession(s.id), /refused/);

  // closeSession refusals.
  await assert.rejects(ctx.chat.closeSession(),                                                  /input object required/);
  await assert.rejects(ctx.chat.closeSession({ session_id: "x" }),                               /session_id/);
  await assert.rejects(ctx.chat.closeSession({ session_id: _validUUID() }),                      /not found/);
  await assert.rejects(ctx.chat.closeSession({
    session_id: s.id, reason: "x".repeat(liveChat.MAX_REASON_LEN + 1),
  }), /reason/);
}

async function _waitingQueueOrdering() {
  var ctx = _setup();
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var beforeTs = Date.now();
    var s = await ctx.chat.openSession({
      session_id:  "vsid-q-" + i,
      source_page: "/p/" + i,
    });
    ids.push(s.id);
    // Force wall-clock to advance between rows so FIFO ordering is
    // observable on the (opened_at, id) tiebreaker. UUID v7 is
    // millisecond-prefixed; sorting by id alone is enough — but we
    // also bump time to make opened_at strictly monotonic so the
    // ORDER BY opened_at ASC primary key actually sees movement.
    await helpers.waitUntil(function () { return Date.now() > beforeTs; }, { timeoutMs: 5000, intervalMs: 2 });
  }
  var q = await ctx.chat.waitingQueue({ limit: 10 });
  check("waitingQueue returns all 5 queued",        q.length === 5);
  check("waitingQueue FIFO oldest first",           q[0].id === ids[0] && q[4].id === ids[4]);

  // Assign one; it drops out of the waiting queue.
  await ctx.chat.assignToOperator({ session_id: ids[0], operator_id: _validUUID() });
  var qAfter = await ctx.chat.waitingQueue({ limit: 10 });
  check("waitingQueue excludes assigned",           qAfter.length === 4 && qAfter[0].id === ids[1]);

  // Limit cap.
  var qSmall = await ctx.chat.waitingQueue({ limit: 2 });
  check("waitingQueue limit caps page",             qSmall.length === 2);

  // Default limit applied when omitted.
  var qDefault = await ctx.chat.waitingQueue();
  check("waitingQueue default limit applied",       qDefault.length === 4);

  // Refusals.
  await assert.rejects(ctx.chat.waitingQueue({ limit: 0 }),                /limit/);
  await assert.rejects(ctx.chat.waitingQueue({ limit: liveChat.MAX_LIST_LIMIT + 1 }), /limit/);
}

async function _operatorQueueAndWorkload() {
  var ctx = _setup();
  var op1 = _validUUID();
  var op2 = _validUUID();

  var sids = [];
  for (var i = 0; i < 4; i += 1) {
    var s = await ctx.chat.openSession({ session_id: "vsid-w-" + i, source_page: "/p" });
    sids.push(s.id);
  }
  await ctx.chat.assignToOperator({ session_id: sids[0], operator_id: op1 });
  await ctx.chat.assignToOperator({ session_id: sids[1], operator_id: op1 });
  await ctx.chat.assignToOperator({ session_id: sids[2], operator_id: op2 });

  check("operatorWorkload op1 = 2",                  (await ctx.chat.operatorWorkload(op1)) === 2);
  check("operatorWorkload op2 = 1",                  (await ctx.chat.operatorWorkload(op2)) === 1);
  check("operatorWorkload unknown operator = 0",     (await ctx.chat.operatorWorkload(_validUUID())) === 0);

  var op1Q = await ctx.chat.operatorQueue({ operator_id: op1 });
  check("operatorQueue op1 returns 2",               op1Q.length === 2);
  check("operatorQueue op1 ordered assigned_at ASC", op1Q[0].id === sids[0] && op1Q[1].id === sids[1]);

  // Status-filter narrows.
  await ctx.chat.recordMessage({ session_id: sids[0], author: "operator", body: "Hi" });   // -> waiting
  var op1Waiting = await ctx.chat.operatorQueue({ operator_id: op1, status: "waiting" });
  check("operatorQueue status=waiting narrows",      op1Waiting.length === 1 && op1Waiting[0].id === sids[0]);

  // Close one — drops out of the open queue.
  await ctx.chat.closeSession({ session_id: sids[0], reason: "resolved" });
  check("operatorWorkload drops closed",             (await ctx.chat.operatorWorkload(op1)) === 1);

  // Cross-operator query (no operator_id) returns every assigned.
  var anyOp = await ctx.chat.operatorQueue();
  check("operatorQueue without op returns all open", anyOp.length === 2);

  // Refusals.
  await assert.rejects(ctx.chat.operatorWorkload("nope"),                           /operator_id/);
  await assert.rejects(ctx.chat.operatorQueue({ operator_id: "nope" }),             /operator_id/);
  await assert.rejects(ctx.chat.operatorQueue({ status: "bogus" }),                 /status/);
}

async function _operatorStateMarkers() {
  var ctx = _setup();
  var op = _validUUID();

  var r1 = await ctx.chat.markOperatorAvailable(op);
  check("markOperatorAvailable returns row",         r1.status === "available" && r1.operator_id === op);

  // Repeat call updates timestamp + status (idempotent on the row).
  var stored1 = (await ctx.query("SELECT * FROM chat_operator_state WHERE operator_id = ?1", [op])).rows[0];
  check("operator state persisted",                  stored1.status === "available");

  var r2 = await ctx.chat.markOperatorAway(op);
  check("markOperatorAway flips state",              r2.status === "away");
  var stored2 = (await ctx.query("SELECT * FROM chat_operator_state WHERE operator_id = ?1", [op])).rows[0];
  check("operator state away persisted",             stored2.status === "away");
  check("only one row per operator (PK)",            (await ctx.query("SELECT COUNT(*) AS c FROM chat_operator_state WHERE operator_id = ?1", [op])).rows[0].c === 1);

  // Re-mark available — still one row.
  await ctx.chat.markOperatorAvailable(op);
  check("toggling stays at one row",                 (await ctx.query("SELECT COUNT(*) AS c FROM chat_operator_state WHERE operator_id = ?1", [op])).rows[0].c === 1);

  // Refusals.
  await assert.rejects(ctx.chat.markOperatorAvailable("nope"),                /operator_id/);
  await assert.rejects(ctx.chat.markOperatorAway("nope"),                     /operator_id/);
}

async function _cleanupAbandonedReaper() {
  var ctx = _setup();
  var query = ctx.query;

  // Helper: insert a session row with a controlled last_activity_at
  // so the reaper has something stale to find without waiting real
  // time. Mirrors the pattern used by supportTickets' SLA test.
  async function _stamp(status, lastActivityAgoMs) {
    var id = bShop.framework.uuid.v7();
    var openedAt = Date.now() - lastActivityAgoMs - 1000;
    var lastAt   = Date.now() - lastActivityAgoMs;
    var vh = bShop.framework.crypto.namespaceHash("live-chat-visitor", "stamp-" + id);
    await query(
      "INSERT INTO chat_sessions " +
      "(id, customer_id, visitor_session_id_hash, visitor_email_hash, source_page, " +
      " status, assigned_operator_id, opened_at, assigned_at, last_activity_at, " +
      " closed_at, close_reason) " +
      "VALUES (?1, NULL, ?2, NULL, '/stamp', ?3, NULL, ?4, NULL, ?5, NULL, NULL)",
      [id, vh, status, openedAt, lastAt],
    );
    return id;
  }

  // Stale (older than 30 minutes) — should be reaped.
  var staleQueued   = await _stamp("queued",   31 * 60 * 1000);
  var staleAssigned = await _stamp("assigned", 31 * 60 * 1000);
  var staleActive   = await _stamp("active",   45 * 60 * 1000);
  var staleWaiting  = await _stamp("waiting",  35 * 60 * 1000);
  // Fresh (newer than 30 minutes) — should survive.
  var freshQueued   = await _stamp("queued",    5 * 60 * 1000);
  /* freshAssigned */ await _stamp("assigned", 10 * 60 * 1000);
  // Already terminal — never reaped no matter how old.
  /* oldClosed     */ await _stamp("closed",    99 * 60 * 60 * 1000);
  /* oldAbandoned  */ await _stamp("abandoned", 99 * 60 * 60 * 1000);

  var result = await ctx.chat.cleanupAbandoned({ idle_minutes: 30 });
  check("cleanupAbandoned reports count",            result.count === 4);
  check("cleanupAbandoned reports threshold_ms",     typeof result.threshold_ms === "number");
  var swept = result.swept;
  check("cleanupAbandoned reaped staleQueued",       swept.indexOf(staleQueued) !== -1);
  check("cleanupAbandoned reaped staleAssigned",     swept.indexOf(staleAssigned) !== -1);
  check("cleanupAbandoned reaped staleActive",       swept.indexOf(staleActive) !== -1);
  check("cleanupAbandoned reaped staleWaiting",      swept.indexOf(staleWaiting) !== -1);
  check("cleanupAbandoned skipped freshQueued",      swept.indexOf(freshQueued) === -1);

  // Reaped rows now carry abandoned + close_reason + a system msg.
  var swept0 = await ctx.chat.getSession(staleQueued);
  check("reaped row status=abandoned",               swept0.status === "abandoned");
  check("reaped row close_reason set",               swept0.close_reason === "idle timeout");
  check("reaped row closed_at stamped",              typeof swept0.closed_at === "number");
  var msgs = await ctx.chat.messagesForSession({ session_id: staleQueued });
  var sysAbandoned = msgs.filter(function (m) { return m.author === "system" && m.body.indexOf("abandoned") !== -1; });
  check("reaped row carries system abandoned msg",   sysAbandoned.length === 1);

  // Refusals.
  await assert.rejects(ctx.chat.cleanupAbandoned(),                       /input object required/);
  await assert.rejects(ctx.chat.cleanupAbandoned({ idle_minutes: 0 }),    /idle_minutes/);
  await assert.rejects(ctx.chat.cleanupAbandoned({ idle_minutes: -1 }),   /idle_minutes/);
  await assert.rejects(ctx.chat.cleanupAbandoned({ idle_minutes: liveChat.MAX_IDLE_MINUTES + 1 }), /idle_minutes/);
  await assert.rejects(ctx.chat.cleanupAbandoned({ idle_minutes: 1.5 }),  /idle_minutes/);
}

async function run() {
  await _openSessionAndEnqueue();
  await _assignToOperatorTransitions();
  await _recordMessageRoundTrip();
  await _fsmTransitionRefusals();
  await _waitingQueueOrdering();
  await _operatorQueueAndWorkload();
  await _operatorStateMarkers();
  await _cleanupAbandonedReaper();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/live-chat.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — live-chat (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — live-chat: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
