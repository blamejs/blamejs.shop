"use strict";
/**
 * eventLog — universal append-only application event stream.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0199_event_log.sql alone — the primitive has no FKs into the rest
 * of the schema, so the test runs against a minimal in-memory
 * database with just the event_log table.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/event-log.js` directly so the gate exists ahead of the entry-
 * point edit.
 *
 * Coverage:
 *   - recordEvent happy path stamps id + occurred_at + severity
 *     default; persists payload, actor, source.
 *   - recordEvent drop-silent on bad input (object refusal, bad kind,
 *     bad subject, payload non-serialisable, oversize payload,
 *     dangling actor_kind, bad severity, bad source).
 *   - query with kind / subject / actor / severity_min / from / to
 *     narrows the scan; cursor round-trips paginate newest-first.
 *   - cursor mismatch + malformed cursor rejected.
 *   - tail returns newest-first rows + echoes the validated poll_ms;
 *     bad poll_ms rejected.
 *   - metricsForKind rolls up by_severity + by_source + total +
 *     first_at + last_at; window-narrow returns zeroes.
 *   - topKinds aggregates count DESC then kind ASC.
 *   - purgeOlderThan drops aged rows; exclude_critical preserves
 *     critical rows past the retention window.
 *   - monotonic occurred_at — two recordEvent calls in the same wall-
 *     clock millisecond emerge with strictly increasing timestamps.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop    = require("../../lib");
var eventLog = require("../../lib/event-log");
var helpers  = require("../helpers");
var check    = helpers.check;
var assert   = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0199_event_log.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _setup() {
  var query = _makeQuery();
  var el    = eventLog.create({ query: query });
  return { query: query, el: el };
}

function _validRecord(over) {
  over = over || {};
  var base = {
    kind:         "job.dispatched",
    subject_kind: "job",
    subject_id:   "job-abc-123",
    actor_kind:   "system",
    actor_id:     "scheduler",
    payload:      { queue: "default", retry: 0 },
    severity:     "info",
    source:       "worker.scheduler",
  };
  var k;
  for (k in over) {
    if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
  }
  return base;
}

// ---- recordEvent happy path -------------------------------------------

async function _recordEventHappy() {
  var ctx = _setup();
  var rv = await ctx.el.recordEvent(_validRecord());
  check("recordEvent returns id",               typeof rv.id === "string" && rv.id.length >= 32);
  check("recordEvent stamps occurred_at",       Number.isInteger(rv.occurred_at) && rv.occurred_at > 0);
  check("recordEvent not dropped",              rv.dropped === undefined);

  // query the row back to confirm persistence.
  var page = await ctx.el.query({ kind: "job.dispatched" });
  check("query returns the row",                page.rows.length === 1);
  var row = page.rows[0];
  check("row id matches",                       row.id === rv.id);
  check("row kind",                             row.kind === "job.dispatched");
  check("row subject_kind",                     row.subject_kind === "job");
  check("row subject_id",                       row.subject_id === "job-abc-123");
  check("row actor_kind",                       row.actor_kind === "system");
  check("row actor_id",                         row.actor_id === "scheduler");
  check("row severity",                         row.severity === "info");
  check("row source",                           row.source === "worker.scheduler");
  check("row payload queue",                    row.payload && row.payload.queue === "default");
  check("row payload retry",                    row.payload.retry === 0);
  check("row occurred_at",                      row.occurred_at === rv.occurred_at);

  // severity defaults to info; actor + source + payload all optional.
  var minimal = await ctx.el.recordEvent({
    kind:         "cache.invalidated",
    subject_kind: "cache",
    subject_id:   "products:list",
  });
  check("minimal recordEvent ok",               typeof minimal.id === "string");
  var minPage = await ctx.el.query({ kind: "cache.invalidated" });
  check("minimal row actor_kind null",          minPage.rows[0].actor_kind === null);
  check("minimal row actor_id null",            minPage.rows[0].actor_id === null);
  check("minimal row payload null",             minPage.rows[0].payload === null);
  check("minimal row source null",              minPage.rows[0].source === null);
  check("minimal severity default info",        minPage.rows[0].severity === "info");
}

// ---- recordEvent drop-silent on bad input -----------------------------

async function _recordEventDropSilent() {
  var ctx = _setup();
  // The primitive is wired into hot-path callsites; bad input MUST NOT
  // throw — every refusal resolves to a { dropped: true, reason } shape.
  var cases = [
    { input: null,                                              reason: /object/ },
    { input: undefined,                                          reason: /object/ },
    { input: "not-an-object",                                    reason: /object/ },
    { input: _validRecord({ kind: "" }),                          reason: /kind/ },
    { input: _validRecord({ kind: "Has Caps" }),                  reason: /kind/ },
    { input: _validRecord({ kind: 42 }),                          reason: /kind/ },
    { input: _validRecord({ subject_kind: "" }),                  reason: /subject_kind/ },
    { input: _validRecord({ subject_kind: "bad space" }),         reason: /subject_kind/ },
    { input: _validRecord({ subject_id: "" }),                    reason: /subject_id/ },
    { input: _validRecord({ subject_id: "has space" }),           reason: /subject_id/ },
    { input: _validRecord({ actor_kind: "Bad" }),                 reason: /actor_kind/ },
    { input: _validRecord({ actor_id: "has space" }),             reason: /actor_id/ },
    { input: _validRecord({ actor_kind: "system", actor_id: null }), reason: /actor_kind/ },
    { input: _validRecord({ severity: "fatal" }),                 reason: /severity/ },
    { input: _validRecord({ source: "Has Caps" }),                reason: /source/ },
  ];
  for (var i = 0; i < cases.length; i += 1) {
    var rv = await ctx.el.recordEvent(cases[i].input);
    check("dropped case #" + i,                  rv.dropped === true);
    check("dropped reason #" + i,                cases[i].reason.test(rv.reason));
  }

  // Non-serialisable payload (BigInt, circular ref).
  var bigPayload = await ctx.el.recordEvent(_validRecord({ payload: { n: 1n } }));
  check("bigint payload dropped",                bigPayload.dropped === true && /serialisable/.test(bigPayload.reason));

  var circ = {};
  circ.self = circ;
  var circRv = await ctx.el.recordEvent(_validRecord({ payload: circ }));
  check("circular payload dropped",              circRv.dropped === true && /serialisable/.test(circRv.reason));

  // Oversize payload (>64KB) — a runaway producer is refused at the
  // gate rather than mangled in the row store.
  var huge = { blob: "x".repeat(70 * 1024) };
  var hugeRv = await ctx.el.recordEvent(_validRecord({ payload: huge }));
  check("huge payload dropped",                  hugeRv.dropped === true && /exceeds/.test(hugeRv.reason));

  // No row was persisted from any of the drops above.
  var all = await ctx.el.query({});
  check("no rows persisted from drops",          all.rows.length === 0);
}

// ---- query with filters + cursor pagination ---------------------------

async function _queryFiltersAndCursor() {
  var ctx = _setup();
  // Seed a mixed event stream.
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched",     subject_id: "j1", severity: "debug",    source: "worker.a" }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched",     subject_id: "j2", severity: "info",      source: "worker.a" }));
  await ctx.el.recordEvent(_validRecord({ kind: "cache.invalidated",  subject_kind: "cache", subject_id: "c1",  severity: "warning", source: "cache.products", actor_kind: null, actor_id: null }));
  await ctx.el.recordEvent(_validRecord({ kind: "webhook.received",   subject_kind: "webhook", subject_id: "w1", severity: "critical", source: "webhook.stripe", actor_id: "stripe", actor_kind: "external" }));
  await ctx.el.recordEvent(_validRecord({ kind: "feature_flag.flipped", subject_kind: "flag", subject_id: "checkout_v2", severity: "info", actor_id: "operator-42", source: "admin.console" }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched",     subject_id: "j3", severity: "info",      source: "worker.b" }));

  // Filter by kind.
  var jobs = await ctx.el.query({ kind: "job.dispatched" });
  check("kind=job.dispatched count",             jobs.rows.length === 3);
  for (var i = 0; i < jobs.rows.length; i += 1) {
    check("kind filter row " + i,                jobs.rows[i].kind === "job.dispatched");
  }
  // Newest-first ordering (occurred_at DESC).
  check("kind newest-first",                     jobs.rows[0].occurred_at > jobs.rows[1].occurred_at);
  check("kind ascending older 2nd",              jobs.rows[1].occurred_at > jobs.rows[2].occurred_at);

  // Filter by subject.
  var subj = await ctx.el.query({ subject: { kind: "cache", id: "c1" } });
  check("subject filter exact",                  subj.rows.length === 1 && subj.rows[0].subject_id === "c1");

  // Filter by actor (id only).
  var actor = await ctx.el.query({ actor: { id: "operator-42" } });
  check("actor filter by id",                    actor.rows.length === 1 && actor.rows[0].actor_id === "operator-42");

  // Filter by actor (id + kind narrows further).
  var actorKind = await ctx.el.query({ actor: { id: "stripe", kind: "external" } });
  check("actor filter id+kind",                  actorKind.rows.length === 1 && actorKind.rows[0].actor_kind === "external");

  // severity_min = warning includes warning + critical.
  var sev = await ctx.el.query({ severity_min: "warning" });
  check("severity_min warning count",            sev.rows.length === 2);
  for (var j = 0; j < sev.rows.length; j += 1) {
    check("severity_min row " + j,               sev.rows[j].severity === "warning" || sev.rows[j].severity === "critical");
  }

  // severity_min = info excludes debug rows.
  var infoUp = await ctx.el.query({ severity_min: "info" });
  check("severity_min info excludes debug",      infoUp.rows.length === 5);

  // Pagination — limit=2 over 6 rows yields 3 pages.
  var p1 = await ctx.el.query({ limit: 2 });
  check("page1 length",                          p1.rows.length === 2);
  check("page1 cursor present",                  typeof p1.next_cursor === "string" && p1.next_cursor.length > 0);

  var p2 = await ctx.el.query({ limit: 2, cursor: p1.next_cursor });
  check("page2 length",                          p2.rows.length === 2);
  check("page2 ids disjoint from page1",         p2.rows[0].id !== p1.rows[0].id && p2.rows[0].id !== p1.rows[1].id);
  check("page2 cursor present",                  typeof p2.next_cursor === "string");

  var p3 = await ctx.el.query({ limit: 2, cursor: p2.next_cursor });
  check("page3 length",                          p3.rows.length === 2);
  check("page3 cursor null at end",              p3.next_cursor === null);

  // All six ids surfaced exactly once across pages.
  var seen = {};
  [p1, p2, p3].forEach(function (p) {
    p.rows.forEach(function (r) { seen[r.id] = (seen[r.id] || 0) + 1; });
  });
  var uniques = Object.keys(seen).length;
  check("six unique rows paged",                  uniques === 6);
  var dupes = 0;
  for (var k in seen) {
    if (Object.prototype.hasOwnProperty.call(seen, k)) {
      if (seen[k] !== 1) dupes += 1;
    }
  }
  check("no row repeated across pages",          dupes === 0);

  // Bad cursor.
  await assert.rejects(ctx.el.query({ cursor: "not-a-real-cursor" }), /cursor/);
  await assert.rejects(ctx.el.query({ cursor: 42 }),                  /cursor/);
  await assert.rejects(ctx.el.query({ severity_min: "fatal" }),       /severity_min/);
  await assert.rejects(ctx.el.query({ from: -1 }),                    /from/);
  await assert.rejects(ctx.el.query({ from: 100, to: 50 }),           /from must be/);
  await assert.rejects(ctx.el.query({ limit: 0 }),                    /limit/);
  await assert.rejects(ctx.el.query({ limit: 9999 }),                 /limit/);
  await assert.rejects(ctx.el.query({ subject: { kind: "bad space", id: "x" } }), /subject.kind/);
  await assert.rejects(ctx.el.query({ actor: { id: "" } }),           /actor.id/);

  // Cursor minted under one secret can't be replayed under another —
  // the HMAC binding refuses the swap.
  var otherCtxQuery = _makeQuery();
  var otherEl = eventLog.create({ query: otherCtxQuery, cursorSecret: "different-secret-for-test" });
  await assert.rejects(otherEl.query({ cursor: p1.next_cursor }), /cursor/);
}

// ---- tail --------------------------------------------------------------

async function _tail() {
  var ctx = _setup();
  for (var i = 0; i < 5; i += 1) {
    await ctx.el.recordEvent(_validRecord({ subject_id: "j" + i }));
  }
  var t = await ctx.el.tail({ poll_ms: 1000, max_events: 3 });
  check("tail rows length",                      t.rows.length === 3);
  check("tail newest-first",                     t.rows[0].occurred_at > t.rows[1].occurred_at);
  check("tail observed_at present",              Number.isInteger(t.observed_at) && t.observed_at > 0);
  check("tail observed_poll_ms echo",            t.observed_poll_ms === 1000);
  check("tail row[0] subject_id",                t.rows[0].subject_id === "j4");

  // Defaults applied when args omitted.
  var def = await ctx.el.tail({});
  check("tail default poll_ms",                  def.observed_poll_ms === eventLog.DEFAULT_POLL_MS);
  check("tail default max_events",               def.rows.length === 5);

  // poll_ms bounds.
  await assert.rejects(ctx.el.tail({ poll_ms: 100 }),           /poll_ms/);
  await assert.rejects(ctx.el.tail({ poll_ms: 60001 }),         /poll_ms/);
  await assert.rejects(ctx.el.tail({ poll_ms: 1.5 }),           /poll_ms/);
  await assert.rejects(ctx.el.tail({ max_events: 0 }),          /max_events/);
  await assert.rejects(ctx.el.tail({ max_events: 9999 }),       /max_events/);
  await assert.rejects(ctx.el.tail(null),                       /object/);
}

// ---- metricsForKind ----------------------------------------------------

async function _metricsForKind() {
  var ctx = _setup();
  // Seven job.dispatched events across two sources + three severities.
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", severity: "debug",    source: "worker.a" }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", severity: "info",      source: "worker.a" }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", severity: "info",      source: "worker.b" }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", severity: "warning",   source: "worker.b" }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", severity: "critical",  source: null }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", severity: "info",      source: "worker.a" }));
  await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", severity: "info",      source: "worker.a" }));
  // Noise from a different kind — must not appear in the rollup.
  await ctx.el.recordEvent(_validRecord({ kind: "cache.invalidated", subject_kind: "cache", subject_id: "c1" }));

  var nowMs = Date.now();
  var m = await ctx.el.metricsForKind({
    kind: "job.dispatched",
    from: nowMs - 60 * 60 * 1000,
    to:   nowMs + 60 * 60 * 1000,
  });
  check("metrics kind echo",                     m.kind === "job.dispatched");
  check("metrics total",                         m.total === 7);
  check("metrics by_severity debug",             m.by_severity.debug === 1);
  check("metrics by_severity info",              m.by_severity.info === 4);
  check("metrics by_severity warning",           m.by_severity.warning === 1);
  check("metrics by_severity critical",          m.by_severity.critical === 1);
  check("metrics by_source worker.a",            m.by_source["worker.a"] === 4);
  check("metrics by_source worker.b",            m.by_source["worker.b"] === 2);
  check("metrics by_source (none)",              m.by_source["(none)"] === 1);
  check("metrics first_at <= last_at",           m.first_at <= m.last_at);
  check("metrics first_at integer",              Number.isInteger(m.first_at) && m.first_at > 0);

  // Narrow window past the rows.
  var empty = await ctx.el.metricsForKind({
    kind: "job.dispatched",
    from: 1,
    to:   1000,
  });
  check("metrics narrow total 0",                empty.total === 0);
  check("metrics narrow first_at null",          empty.first_at === null);
  check("metrics narrow last_at null",           empty.last_at === null);

  // Bad input.
  await assert.rejects(ctx.el.metricsForKind({ kind: "Bad Kind", from: 1, to: 2 }),  /kind/);
  await assert.rejects(ctx.el.metricsForKind({ kind: "ok.kind", from: null, to: 2 }), /from/);
  await assert.rejects(ctx.el.metricsForKind({ kind: "ok.kind", from: 1, to: null }), /to/);
  await assert.rejects(ctx.el.metricsForKind({ kind: "ok.kind", from: 100, to: 50 }), /from must be/);
  await assert.rejects(ctx.el.metricsForKind(null),                                   /object/);
}

// ---- topKinds ----------------------------------------------------------

async function _topKinds() {
  var ctx = _setup();
  // job.dispatched x4, cache.invalidated x2, webhook.received x1.
  for (var i = 0; i < 4; i += 1) {
    await ctx.el.recordEvent(_validRecord({ kind: "job.dispatched", subject_id: "j" + i }));
  }
  for (var j = 0; j < 2; j += 1) {
    await ctx.el.recordEvent(_validRecord({ kind: "cache.invalidated", subject_kind: "cache", subject_id: "c" + j }));
  }
  await ctx.el.recordEvent(_validRecord({ kind: "webhook.received", subject_kind: "webhook", subject_id: "w0" }));

  var nowMs = Date.now();
  var top = await ctx.el.topKinds({
    from:  nowMs - 60 * 60 * 1000,
    to:    nowMs + 60 * 60 * 1000,
    limit: 10,
  });
  check("topKinds length",                       top.length === 3);
  check("topKinds[0] highest count",             top[0].kind === "job.dispatched" && top[0].count === 4);
  check("topKinds[1] second",                    top[1].kind === "cache.invalidated" && top[1].count === 2);
  check("topKinds[2] third",                     top[2].kind === "webhook.received" && top[2].count === 1);

  // Limit caps results.
  var limited = await ctx.el.topKinds({ from: nowMs - 60000, to: nowMs + 60000, limit: 2 });
  check("topKinds limit applied",                limited.length === 2);

  // Bad input.
  await assert.rejects(ctx.el.topKinds({ from: null, to: 100 }),       /from/);
  await assert.rejects(ctx.el.topKinds({ from: 100,  to: null }),      /to/);
  await assert.rejects(ctx.el.topKinds({ from: 100,  to: 50 }),        /from must be/);
  await assert.rejects(ctx.el.topKinds(null),                          /object/);
}

// ---- purgeOlderThan ----------------------------------------------------

async function _purgeOlderThan() {
  var ctx = _setup();

  // Seed three rows now (won't be purged), one ancient row, one ancient
  // critical row.
  await ctx.el.recordEvent(_validRecord({ subject_id: "fresh1" }));
  await ctx.el.recordEvent(_validRecord({ subject_id: "fresh2", severity: "warning" }));
  await ctx.el.recordEvent(_validRecord({ subject_id: "fresh3", severity: "critical" }));

  // Backdate two rows by writing directly to the DB so the purge math
  // has something to find. (recordEvent's monotonic clock won't let
  // us write a past timestamp through the surface; that posture is
  // intentional — the only way to reach the purge sweep is via the
  // actual passage of time, OR a test backdoor like this one.)
  var ancient    = Date.now() - 365 * 86400000;
  await ctx.query(
    "INSERT INTO event_log " +
    "(id, kind, subject_kind, subject_id, actor_kind, actor_id, payload_json, severity, source, occurred_at) " +
    "VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, NULL, ?6)",
    [bShop.framework.uuid.v7(), "ancient.event", "ancient", "old1", "info", ancient],
  );
  await ctx.query(
    "INSERT INTO event_log " +
    "(id, kind, subject_kind, subject_id, actor_kind, actor_id, payload_json, severity, source, occurred_at) " +
    "VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, NULL, ?6)",
    [bShop.framework.uuid.v7(), "ancient.critical", "ancient", "old2", "critical", ancient],
  );

  // Sanity — five rows total before the purge.
  var pre = await ctx.el.query({ limit: 50 });
  check("pre-purge rows",                        pre.rows.length === 5);

  // Purge with exclude_critical → the ancient critical row stays.
  var purge1 = await ctx.el.purgeOlderThan({ days: 30, exclude_critical: true });
  check("purge1 deleted 1",                      purge1.deleted === 1);
  var post1 = await ctx.el.query({ limit: 50 });
  check("post-purge1 4 rows remain",             post1.rows.length === 4);
  var remainingKinds = post1.rows.map(function (r) { return r.kind; });
  check("post-purge1 ancient.critical preserved", remainingKinds.indexOf("ancient.critical") !== -1);
  check("post-purge1 ancient.event purged",       remainingKinds.indexOf("ancient.event") === -1);

  // Now sweep without exclude_critical — the ancient critical row goes.
  var purge2 = await ctx.el.purgeOlderThan({ days: 30 });
  check("purge2 deleted 1 (critical)",           purge2.deleted === 1);
  var post2 = await ctx.el.query({ limit: 50 });
  check("post-purge2 3 rows",                    post2.rows.length === 3);
  for (var i = 0; i < post2.rows.length; i += 1) {
    check("post-purge2 only fresh remain",       post2.rows[i].subject_id.indexOf("fresh") === 0);
  }

  // Bad input.
  await assert.rejects(ctx.el.purgeOlderThan({ days: 0 }),       /days/);
  await assert.rejects(ctx.el.purgeOlderThan({ days: -1 }),      /days/);
  await assert.rejects(ctx.el.purgeOlderThan({ days: 1.5 }),     /days/);
  await assert.rejects(ctx.el.purgeOlderThan({ days: 999999 }),  /days/);
  await assert.rejects(ctx.el.purgeOlderThan(null),              /object/);
}

// ---- monotonic occurred_at --------------------------------------------

async function _monotonicOccurredAt() {
  var ctx = _setup();
  // Twenty back-to-back recordEvent calls. The monotonic clock keeps
  // occurred_at strictly increasing even when Date.now() returns the
  // same value across multiple invocations.
  var ids = [];
  for (var i = 0; i < 20; i += 1) {
    var rv = await ctx.el.recordEvent(_validRecord({ subject_id: "j" + i }));
    ids.push({ id: rv.id, ts: rv.occurred_at });
  }
  for (var j = 1; j < ids.length; j += 1) {
    check("monotonic step " + j,                 ids[j].ts > ids[j - 1].ts);
  }
}

// ---- run --------------------------------------------------------------

async function run() {
  await _recordEventHappy();
  await _recordEventDropSilent();
  await _queryFiltersAndCursor();
  await _tail();
  await _metricsForKind();
  await _topKinds();
  await _purgeOlderThan();
  await _monotonicOccurredAt();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7,
  // pagination.encodeCursor/decodeCursor) is wired before the first
  // test runs.
  void bShop;
  run().then(function () {
    process.stdout.write("event-log.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("event-log.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
