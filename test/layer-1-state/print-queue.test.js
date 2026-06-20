"use strict";
/**
 * print-queue — warehouse print job scheduler that decouples order-flow
 * code from the physical printer matrix.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0158
 * (print_jobs). No upstream composition deps — the queue is a pure
 * state machine over its own table, so the test exercises the FSM
 * coverage directly without stubs.
 *
 * Coverage:
 *   - enqueueJob: defaults (paper_size from kind, copies=1,
 *     scheduled_at=now), explicit fields, station_filter passthrough
 *   - enqueueJob: refusals (bad input shape, bad kind, bad
 *     payload_ref, bad priority, bad copies, bad scheduled_at)
 *   - claimJob: FIFO + priority tiebreak, ahead-scheduled rows
 *     skipped, station_filter restricts the claim pool, kinds filter
 *     restricts the claim pool, empty queue returns null
 *   - markComplete: FSM transition, station-ownership refusal, refused
 *     on non-in_progress
 *   - markFailed: FSM transition, station-ownership refusal, retry:true
 *     requeues with retry_count+1, retry:false leaves the failed row
 *     terminal
 *   - cancelJob: refused on terminal states, queued + in_progress both
 *     transition
 *   - cleanupCompleted: age cutoff sweeps complete + cancelled + failed
 *     (terminal rows), leaves queued + in_progress alone
 *   - stationActivity: claims / completed / failed counters
 *   - dailyMetrics: enqueued / completed / failed / cancelled + per-kind
 *     breakdown
 *   - jobsForStation: claimed-by-station + queued-with-station-filter
 *     hybrid view
 *   - pendingByKind: priority_min filter
 *   - factory: no required composition deps (zero-dep queue)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var printQueue = require("../../lib/print-queue");
var bShop      = require("../../lib/index");
var b          = bShop.framework;

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PATH = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0158_print_queue.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
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

async function _enqueueDefaults() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // Defaults: paper_size resolves from DEFAULT_PAPER_BY_KIND[kind],
  // copies = 1, scheduled_at = now.
  var label = await svc.enqueueJob({
    kind:        "shipping_label",
    payload_ref: "shipment:01HX0000000000000000000001",
    priority:    5,
  });
  check("enqueue returns id",              typeof label.id === "string" && label.id.length > 0);
  check("enqueue status=queued",           label.status === "queued");
  check("enqueue priority=5",              label.priority === 5);
  check("enqueue kind=shipping_label",     label.kind === "shipping_label");
  check("enqueue paper_size default",      label.paper_size === "thermal_4x6");
  check("enqueue copies default",          label.copies === 1);
  check("enqueue retry_count default",     label.retry_count === 0);
  check("enqueue scheduled_at default",    typeof label.scheduled_at === "number" && label.scheduled_at > 0);
  check("enqueue created_at stamped",      typeof label.created_at === "number" && label.created_at > 0);
  check("enqueue claimed_at null",         label.claimed_at == null);
  check("enqueue completed_at null",       label.completed_at == null);

  // Invoice defaults to letter paper.
  var inv = await svc.enqueueJob({
    kind:        "invoice",
    payload_ref: "order:01HX0000000000000000000002",
    priority:    3,
  });
  check("enqueue invoice paper default",   inv.paper_size === "letter");

  // Explicit fields override defaults.
  var slip = await svc.enqueueJob({
    kind:           "packing_slip",
    payload_ref:    "order:01HX0000000000000000000003",
    priority:       0,
    station_filter: "ws-3",
    paper_size:     "a4",
    copies:         3,
    scheduled_at:   1_700_000_000_000,
  });
  check("enqueue explicit paper_size",     slip.paper_size === "a4");
  check("enqueue explicit copies",         slip.copies === 3);
  check("enqueue explicit station_filter", slip.station_filter === "ws-3");
  check("enqueue explicit scheduled_at",   slip.scheduled_at === 1_700_000_000_000);
}

async function _enqueueRefusals() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  await assert.rejects(svc.enqueueJob(),                                              /input object required/);
  await assert.rejects(svc.enqueueJob({}),                                            /kind/);
  await assert.rejects(svc.enqueueJob({ kind: "bogus" }),                             /kind/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice",
  }),                                                                                 /payload_ref/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1",
  }),                                                                                 /priority/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1", priority: 99,
  }),                                                                                 /priority/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1", priority: -1,
  }),                                                                                 /priority/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1", priority: 1, copies: 0,
  }),                                                                                 /copies/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1", priority: 1, copies: 1000,
  }),                                                                                 /copies/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1", priority: 1, paper_size: "tabloid",
  }),                                                                                 /paper_size/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1", priority: 1, station_filter: "bad station",
  }),                                                                                 /station_filter/);
  await assert.rejects(svc.enqueueJob({
    kind: "invoice", payload_ref: "order:1", priority: 1, scheduled_at: -1,
  }),                                                                                 /scheduled_at/);
}

async function _claimFifoAndPriority() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // Enqueue four jobs: two at priority 2, two at priority 7.
  // Priority 7 jobs should claim first; within a priority tier, FIFO
  // by scheduled_at (which defaults to created_at via _now()).
  var loP1 = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:1", priority: 2 });
  var hiP1 = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:2", priority: 7 });
  var loP2 = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:3", priority: 2 });
  var hiP2 = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:4", priority: 7 });

  // First claim: hiP1 (priority 7, oldest).
  var c1 = await svc.claimJob({ station_id: "ws-1" });
  check("claim 1 = first hi-priority",     c1.id === hiP1.id);
  check("claim 1 status=in_progress",      c1.status === "in_progress");
  check("claim 1 claimed_by_station",      c1.claimed_by_station === "ws-1");
  check("claim 1 claimed_at stamped",      typeof c1.claimed_at === "number" && c1.claimed_at > 0);

  // Second claim: hiP2 (priority 7, second-oldest).
  var c2 = await svc.claimJob({ station_id: "ws-1" });
  check("claim 2 = second hi-priority",    c2.id === hiP2.id);

  // Third claim: loP1 (priority 2, oldest of the remaining).
  var c3 = await svc.claimJob({ station_id: "ws-1" });
  check("claim 3 = first lo-priority",     c3.id === loP1.id);

  // Fourth claim: loP2.
  var c4 = await svc.claimJob({ station_id: "ws-1" });
  check("claim 4 = second lo-priority",    c4.id === loP2.id);

  // Fifth claim: queue is empty.
  var c5 = await svc.claimJob({ station_id: "ws-1" });
  check("claim 5 empty queue = null",      c5 === null);
}

async function _claimScheduledAndFilters() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // Job scheduled an hour ahead — claim must skip it.
  var future = Date.now() + 60 * 60 * 1000;
  var skipped = await svc.enqueueJob({
    kind: "invoice", payload_ref: "ord:future", priority: 9,
    scheduled_at: future,
  });
  // Job scheduled now — should claim first.
  var now = await svc.enqueueJob({
    kind: "invoice", payload_ref: "ord:now", priority: 2,
  });
  var c1 = await svc.claimJob({ station_id: "ws-1" });
  check("claim skips future-scheduled",    c1.id === now.id);
  var c2 = await svc.claimJob({ station_id: "ws-1" });
  check("claim returns null when only future eligible", c2 === null);

  // station_filter restricts claims. Enqueue a job filtered to ws-A;
  // ws-B can't claim it, ws-A can.
  var q2 = _makeQuery();
  var svc2 = printQueue.create({ query: q2 });
  var pinned = await svc2.enqueueJob({
    kind: "packing_slip", payload_ref: "ord:p1", priority: 5,
    station_filter: "ws-A",
  });
  var unfiltered = await svc2.enqueueJob({
    kind: "packing_slip", payload_ref: "ord:p2", priority: 5,
  });

  // ws-B sees the unfiltered job, never the pinned one — even though
  // the pinned one is higher in the queue at the same priority.
  var cB1 = await svc2.claimJob({ station_id: "ws-B" });
  check("station_filter blocks other station", cB1.id === unfiltered.id);
  var cB2 = await svc2.claimJob({ station_id: "ws-B" });
  check("station_filter leaves nothing for B", cB2 === null);

  // ws-A claims the pinned job.
  var cA1 = await svc2.claimJob({ station_id: "ws-A" });
  check("station_filter passes claim to A",    cA1.id === pinned.id);

  // kinds filter restricts the claim pool. Enqueue a mix; a thermal-
  // only workstation only sees the label-kind jobs.
  var q3 = _makeQuery();
  var svc3 = printQueue.create({ query: q3 });
  await svc3.enqueueJob({ kind: "invoice",        payload_ref: "ord:i1", priority: 5 });
  var label = await svc3.enqueueJob({ kind: "shipping_label", payload_ref: "ord:l1", priority: 5 });
  await svc3.enqueueJob({ kind: "packing_slip",   payload_ref: "ord:s1", priority: 5 });
  var retLabel = await svc3.enqueueJob({ kind: "return_label",   payload_ref: "ord:r1", priority: 5 });

  var cL1 = await svc3.claimJob({
    station_id: "ws-thermal",
    kinds:      ["shipping_label", "return_label", "packing_label"],
  });
  check("kinds filter picks label kind",       cL1.id === label.id);
  var cL2 = await svc3.claimJob({
    station_id: "ws-thermal",
    kinds:      ["shipping_label", "return_label", "packing_label"],
  });
  check("kinds filter picks second label",     cL2.id === retLabel.id);
  var cL3 = await svc3.claimJob({
    station_id: "ws-thermal",
    kinds:      ["shipping_label", "return_label", "packing_label"],
  });
  check("kinds filter exhausts thermal pool",  cL3 === null);

  // Suppress unused-binding lint — `skipped` exists to seed the
  // ahead-scheduled row that the claim must skip.
  void skipped;
}

async function _claimRefusals() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });
  await assert.rejects(svc.claimJob(),                                                /input object required/);
  await assert.rejects(svc.claimJob({}),                                              /station_id/);
  await assert.rejects(svc.claimJob({ station_id: "bad station" }),                   /station_id/);
  await assert.rejects(svc.claimJob({ station_id: "ws-1", kinds: [] }),               /kinds/);
  await assert.rejects(svc.claimJob({ station_id: "ws-1", kinds: ["bogus"] }),        /kind/);
  await assert.rejects(svc.claimJob({
    station_id: "ws-1", kinds: ["invoice", "invoice"],
  }),                                                                                 /duplicate kind/);
}

async function _markCompleteFsm() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  var job = await svc.enqueueJob({
    kind: "shipping_label", payload_ref: "ord:1", priority: 5,
  });

  // Refuse markComplete on queued (not yet in_progress).
  await assert.rejects(svc.markComplete({
    job_id: job.id, station_id: "ws-1",
  }), /only in_progress/);

  var claimed = await svc.claimJob({ station_id: "ws-1" });
  check("claim flips status",              claimed.status === "in_progress");

  // Refuse markComplete from a different station.
  await assert.rejects(svc.markComplete({
    job_id: job.id, station_id: "ws-2",
  }), /claimed by/);

  // Happy path.
  var done = await svc.markComplete({ job_id: job.id, station_id: "ws-1" });
  check("markComplete status=complete",    done.status === "complete");
  check("markComplete completed_at",       typeof done.completed_at === "number" && done.completed_at > 0);
  check("markComplete completed_by",       done.completed_by_station === "ws-1");

  // Re-complete refused — terminal.
  await assert.rejects(svc.markComplete({
    job_id: job.id, station_id: "ws-1",
  }), /only in_progress/);

  // Cancel a complete job refused.
  await assert.rejects(svc.cancelJob({
    job_id: job.id, reason: "too late",
  }), /only queued or in_progress/);

  // Unknown id refused.
  await assert.rejects(svc.markComplete({
    job_id: "01999999-9999-7999-8999-999999999999", station_id: "ws-1",
  }), /not found/);

  // Bad input shapes.
  await assert.rejects(svc.markComplete(),                                            /input object required/);
  await assert.rejects(svc.markComplete({ job_id: job.id }),                          /station_id/);
}

async function _markFailedAndRetry() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // Enqueue a job, claim it, mark failed without retry.
  var j1 = await svc.enqueueJob({
    kind: "shipping_label", payload_ref: "ord:1", priority: 5,
  });
  await svc.claimJob({ station_id: "ws-1" });
  var f1 = await svc.markFailed({
    job_id: j1.id, station_id: "ws-1",
    reason: "printer offline",
  });
  check("markFailed status=failed",        f1.failed.status === "failed");
  check("markFailed reason persisted",     f1.failed.fail_reason === "printer offline");
  check("markFailed failed_at stamped",    typeof f1.failed.failed_at === "number" && f1.failed.failed_at > 0);
  check("markFailed no requeued (retry off)", f1.requeued === undefined);

  // Queue must be empty after a no-retry fail.
  var probe = await svc.claimJob({ station_id: "ws-1" });
  check("queue empty after no-retry fail", probe === null);

  // Enqueue + claim + fail-with-retry. The requeued job carries the
  // same payload + retry_count + 1.
  var j2 = await svc.enqueueJob({
    kind: "invoice", payload_ref: "ord:2", priority: 8,
    paper_size: "a4", copies: 2,
  });
  await svc.claimJob({ station_id: "ws-1" });
  var f2 = await svc.markFailed({
    job_id: j2.id, station_id: "ws-1",
    reason: "paper jam", retry: true,
  });
  check("retry: failed terminal row",      f2.failed.status === "failed");
  check("retry: requeued status=queued",   f2.requeued.status === "queued");
  check("retry: retry_count++",            f2.requeued.retry_count === 1);
  check("retry: payload preserved",        f2.requeued.payload_ref === "ord:2");
  check("retry: kind preserved",           f2.requeued.kind === "invoice");
  check("retry: priority preserved",       f2.requeued.priority === 8);
  check("retry: paper_size preserved",     f2.requeued.paper_size === "a4");
  check("retry: copies preserved",         f2.requeued.copies === 2);
  check("retry: different job id",         f2.requeued.id !== j2.id);

  // Reclaim picks up the requeued row.
  var c3 = await svc.claimJob({ station_id: "ws-1" });
  check("retry: requeued is claimable",    c3.id === f2.requeued.id);
  check("retry: retry_count survives claim", c3.retry_count === 1);

  // Refuse markFailed from a different station.
  await assert.rejects(svc.markFailed({
    job_id: c3.id, station_id: "ws-2", reason: "wrong station",
  }), /claimed by/);

  // Refuse markFailed without a reason.
  await assert.rejects(svc.markFailed({
    job_id: c3.id, station_id: "ws-1",
  }), /reason/);

  // Refuse markFailed on a queued job (must be in_progress).
  var jQueued = await svc.enqueueJob({
    kind: "invoice", payload_ref: "ord:3", priority: 1,
  });
  await assert.rejects(svc.markFailed({
    job_id: jQueued.id, station_id: "ws-1", reason: "no",
  }), /only in_progress/);
}

async function _markFailedConcurrentRace() {
  // Two workstations (or an operator + an automated jam-detector) can
  // both call markFailed on the SAME in_progress job. Both pass the JS
  // status check because they read the row before either UPDATE
  // commits; without an atomic claim both would fire the retry INSERT
  // and mint TWO duplicate queued jobs (double-print). The guarded
  // `WHERE ... AND status = 'in_progress'` + rowCount===1 makes the
  // transition the claim: only the winner requeues; the loser sees
  // rowCount 0 and returns the already-failed state, no second insert.
  var baseQuery = _makeQuery();
  var db = baseQuery.__db;

  // Wrap the query so that the instant THIS caller runs the guarded
  // failed-transition UPDATE, a concurrent winner has already flipped
  // the row to 'failed'. We detect that exact statement and pre-apply
  // the winner's commit, then let the real UPDATE run against the now-
  // failed row (it matches zero rows, exactly as a serialized SQLite
  // writer would observe after losing the race).
  var jobId = null;
  var wrapped = async function (sql, params) {
    if (jobId &&
        /UPDATE print_jobs SET status = 'failed'/.test(sql) &&
        /AND status = 'in_progress'/.test(sql)) {
      // Simulate the concurrent winner committing first.
      db.prepare(
        "UPDATE print_jobs SET status = 'failed', failed_at = 1, fail_reason = 'winner' " +
        "WHERE id = ? AND status = 'in_progress'",
      ).run(jobId);
    }
    return baseQuery(sql, params);
  };
  wrapped.__db = db;

  var svc = printQueue.create({ query: wrapped });
  var job = await svc.enqueueJob({
    kind: "shipping_label", payload_ref: "ord:race", priority: 5,
  });
  await svc.claimJob({ station_id: "ws-1" });
  jobId = job.id;   // arm the race shim only for the markFailed UPDATE

  var lost = await svc.markFailed({
    job_id: job.id, station_id: "ws-1", reason: "loser", retry: true,
  });

  // The losing caller observes the failed row but does NOT requeue.
  check("race: loser returns failed state",  lost.failed.status === "failed");
  check("race: loser does not requeue",       lost.requeued === undefined);

  // Exactly ONE row exists for this payload — the winner's failed row.
  // No duplicate queued retry was minted by the lost-race caller.
  var all = baseQuery.__db.prepare(
    "SELECT status FROM print_jobs WHERE payload_ref = 'ord:race'",
  ).all();
  check("race: no duplicate retry minted",    all.length === 1 && all[0].status === "failed");
}

async function _cancelPath() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // Cancel a queued job.
  var j1 = await svc.enqueueJob({
    kind: "invoice", payload_ref: "ord:1", priority: 5,
  });
  var c1 = await svc.cancelJob({ job_id: j1.id, reason: "order voided" });
  check("cancel queued -> cancelled",      c1.status === "cancelled");
  check("cancel reason persisted",         c1.cancel_reason === "order voided");
  check("cancel failed_at stamped",        typeof c1.failed_at === "number" && c1.failed_at > 0);

  // Cancel an in_progress job (claimed but not yet completed).
  var j2 = await svc.enqueueJob({
    kind: "invoice", payload_ref: "ord:2", priority: 5,
  });
  await svc.claimJob({ station_id: "ws-1" });
  var c2 = await svc.cancelJob({ job_id: j2.id, reason: "operator override" });
  check("cancel in_progress -> cancelled", c2.status === "cancelled");

  // Refused: cancel a cancelled job.
  await assert.rejects(svc.cancelJob({
    job_id: j1.id, reason: "again",
  }), /only queued or in_progress/);

  // Refused: bad input + missing reason.
  await assert.rejects(svc.cancelJob(),                                               /input object required/);
  await assert.rejects(svc.cancelJob({ job_id: j1.id }),                              /reason/);
  await assert.rejects(svc.cancelJob({ job_id: j1.id, reason: "" }),                  /reason/);
  await assert.rejects(svc.cancelJob({
    job_id: "01999999-9999-7999-8999-999999999999", reason: "miss",
  }), /not found/);
}

async function _cleanupAgeCutoff() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // Enqueue 4 jobs. Complete two of them, leaving timestamps fresh.
  var j1 = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:1", priority: 5 });
  var j2 = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:2", priority: 5 });
  await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:3", priority: 5 });
  var j4 = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:4", priority: 5 });

  await svc.claimJob({ station_id: "ws-1" });
  await svc.markComplete({ job_id: j1.id, station_id: "ws-1" });
  await svc.claimJob({ station_id: "ws-1" });
  await svc.markComplete({ job_id: j2.id, station_id: "ws-1" });
  await svc.cancelJob({ job_id: j4.id, reason: "voided" });

  // Sweep with a huge cutoff (1000h) — nothing should be old enough.
  var none = await svc.cleanupCompleted({ older_than_hours: 1000 });
  check("cleanup huge cutoff = 0 deleted", none.deleted === 0);

  // Manually rewind the completed_at timestamps so the rows look old.
  // The cleanup query uses COALESCE(completed_at, failed_at,
  // created_at) — we bump every terminal row to "two hours ago".
  var pastTs = Date.now() - 2 * 60 * 60 * 1000;
  await q("UPDATE print_jobs SET completed_at = ?1 WHERE status = 'complete'", [pastTs]);
  await q("UPDATE print_jobs SET failed_at = ?1 WHERE status = 'cancelled'", [pastTs]);

  // Sweep with a 1h cutoff — every terminal row (2 complete, 1
  // cancelled) is older and should be deleted; the remaining queued
  // row should be untouched.
  var swept = await svc.cleanupCompleted({ older_than_hours: 1 });
  check("cleanup 1h cutoff deletes 3",     swept.deleted === 3);

  // The queued row survives.
  var remaining = await q("SELECT COUNT(*) AS n FROM print_jobs", []);
  check("queued row survives sweep",       Number(remaining.rows[0].n) === 1);

  // Refusals: bad input shape.
  await assert.rejects(svc.cleanupCompleted(),                                        /input object required/);
  await assert.rejects(svc.cleanupCompleted({ older_than_hours: -1 }),                /older_than_hours/);
  await assert.rejects(svc.cleanupCompleted({ older_than_hours: "1" }),               /older_than_hours/);
}

async function _stationAndDailyMetrics() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // Enqueue + work through a small batch on two stations.
  var j1 = await svc.enqueueJob({ kind: "invoice",        payload_ref: "ord:1", priority: 5 });
  var j2 = await svc.enqueueJob({ kind: "shipping_label", payload_ref: "ord:2", priority: 5 });
  var j3 = await svc.enqueueJob({ kind: "shipping_label", payload_ref: "ord:3", priority: 5 });
  var j4 = await svc.enqueueJob({ kind: "invoice",        payload_ref: "ord:4", priority: 5 });

  // ws-1: claim + complete j1, claim + fail j2.
  await svc.claimJob({ station_id: "ws-1" });
  await svc.markComplete({ job_id: j1.id, station_id: "ws-1" });
  await svc.claimJob({ station_id: "ws-1" });
  await svc.markFailed({ job_id: j2.id, station_id: "ws-1", reason: "paper jam" });

  // ws-2: claim + complete j3.
  await svc.claimJob({ station_id: "ws-2" });
  await svc.markComplete({ job_id: j3.id, station_id: "ws-2" });

  // ws-1 cancels j4 (still queued).
  await svc.cancelJob({ job_id: j4.id, reason: "voided" });

  var from = 0;
  var to   = Date.now() + 1000;

  var ws1 = await svc.stationActivity({ station_id: "ws-1", from: from, to: to });
  check("ws-1 claims=2",                   ws1.claims === 2);
  check("ws-1 completed=1",                ws1.completed === 1);
  check("ws-1 failed=1",                   ws1.failed === 1);

  var ws2 = await svc.stationActivity({ station_id: "ws-2", from: from, to: to });
  check("ws-2 claims=1",                   ws2.claims === 1);
  check("ws-2 completed=1",                ws2.completed === 1);
  check("ws-2 failed=0",                   ws2.failed === 0);

  var daily = await svc.dailyMetrics({ from: from, to: to });
  check("daily enqueued=4",                daily.enqueued === 4);
  check("daily completed=2",               daily.completed === 2);
  check("daily failed=1",                  daily.failed === 1);
  check("daily cancelled=1",               daily.cancelled === 1);
  check("daily by_kind invoice=1",         daily.completed_by_kind.invoice === 1);
  check("daily by_kind label=1",           daily.completed_by_kind.shipping_label === 1);
  check("daily by_kind return_label=0",    daily.completed_by_kind.return_label === 0);

  // Refusals
  await assert.rejects(svc.stationActivity({ station_id: "ws-1", from: 100, to: 50 }), /from/);
  await assert.rejects(svc.dailyMetrics({ from: -1, to: 100 }),                       /from/);
  await assert.rejects(svc.stationActivity(),                                         /input object required/);
}

async function _readsAndDashboard() {
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });

  // getJob hydrates + UUID gate
  var j = await svc.enqueueJob({ kind: "invoice", payload_ref: "ord:1", priority: 5 });
  var fetched = await svc.getJob(j.id);
  check("getJob round-trips",              fetched.id === j.id);
  var miss = await svc.getJob("01999999-9999-7999-8999-999999999999");
  check("getJob miss = null",              miss === null);

  // jobsForStation: hybrid view of claimed + station_filter-queued.
  // Fresh query so the earlier getJob seed doesn't contend for the
  // claim slot.
  var q2 = _makeQuery();
  var svc2 = printQueue.create({ query: q2 });
  var pinned = await svc2.enqueueJob({
    kind: "packing_slip", payload_ref: "ord:p", priority: 5, station_filter: "ws-A",
  });
  var unpinned = await svc2.enqueueJob({
    kind: "invoice", payload_ref: "ord:u", priority: 5,
  });
  await svc2.claimJob({ station_id: "ws-A" });   // claims `pinned` (highest after pin filter)

  // ws-A sees both: pinned (now in_progress) was claimed by ws-A.
  // unpinned is queued without a filter so it doesn't show up under
  // ws-A's view.
  var forA = await svc2.jobsForStation({ station_id: "ws-A" });
  var idsA = forA.map(function (r) { return r.id; });
  check("jobsForStation includes claimed", idsA.indexOf(pinned.id) !== -1);
  check("jobsForStation excludes unfiltered queued", idsA.indexOf(unpinned.id) === -1);

  // status filter
  var inProg = await svc2.jobsForStation({ station_id: "ws-A", status: "in_progress" });
  check("jobsForStation status filter",    inProg.length === 1 && inProg[0].id === pinned.id);

  // pendingByKind dashboard (fresh query, no carry-over jobs).
  var q3 = _makeQuery();
  var svc3 = printQueue.create({ query: q3 });
  await svc3.enqueueJob({ kind: "shipping_label", payload_ref: "ord:l1", priority: 8 });
  await svc3.enqueueJob({ kind: "shipping_label", payload_ref: "ord:l2", priority: 2 });
  var hiLabels = await svc3.pendingByKind({ kind: "shipping_label", priority_min: 5 });
  check("pendingByKind priority_min filter", hiLabels.length === 1);
  var allLabels = await svc3.pendingByKind({ kind: "shipping_label" });
  check("pendingByKind no filter",         allLabels.length === 2);
  // Ordering: highest priority first
  check("pendingByKind sort order",        allLabels[0].priority >= allLabels[1].priority);

  // Refusals
  await assert.rejects(svc.jobsForStation(),                                          /input object required/);
  await assert.rejects(svc.jobsForStation({ station_id: "ws-A", limit: 0 }),          /limit/);
  await assert.rejects(svc.jobsForStation({ station_id: "ws-A", status: "bogus" }),   /status/);
  await assert.rejects(svc.pendingByKind({ kind: "bogus" }),                          /kind/);
  await assert.rejects(svc.pendingByKind(),                                           /input object required/);
  await assert.rejects(svc.getJob("not-a-uuid"),                                      /job_id/);
}

async function _factoryNoDeps() {
  // No required composition deps — the queue is a self-contained
  // state machine.
  var q = _makeQuery();
  var svc = printQueue.create({ query: q });
  check("factory returns object",          typeof svc === "object" && svc !== null);
  check("factory exports enqueueJob",      typeof svc.enqueueJob === "function");
  check("factory exports claimJob",        typeof svc.claimJob === "function");
  check("factory exports markComplete",    typeof svc.markComplete === "function");
  check("factory exports markFailed",      typeof svc.markFailed === "function");
  check("factory exports cancelJob",       typeof svc.cancelJob === "function");
  check("factory exports getJob",          typeof svc.getJob === "function");
  check("factory exports jobsForStation",  typeof svc.jobsForStation === "function");
  check("factory exports pendingByKind",   typeof svc.pendingByKind === "function");
  check("factory exports cleanupCompleted", typeof svc.cleanupCompleted === "function");
  check("factory exports stationActivity", typeof svc.stationActivity === "function");
  check("factory exports dailyMetrics",    typeof svc.dailyMetrics === "function");
  check("KIND_ENUM exported",              Array.isArray(svc.KIND_ENUM) && svc.KIND_ENUM.length === 6);
  check("PAPER_SIZE_ENUM exported",        Array.isArray(svc.PAPER_SIZE_ENUM) && svc.PAPER_SIZE_ENUM.length === 4);
  check("STATUS_ENUM exported",            Array.isArray(svc.STATUS_ENUM) && svc.STATUS_ENUM.length === 5);
  check("MAX_PRIORITY exported",           svc.MAX_PRIORITY === 10);

  // Module-level exports mirror the factory.
  check("module KIND_ENUM",                Array.isArray(printQueue.KIND_ENUM));
  check("module STATUS_ENUM",              Array.isArray(printQueue.STATUS_ENUM));
  check("module create is fn",             typeof printQueue.create === "function");

  // Sanity: b is reachable (used by the primitive internally).
  check("b.uuid.v7 exists",                typeof b.uuid.v7 === "function");
}

async function run() {
  await _enqueueDefaults();
  await _enqueueRefusals();
  await _claimFifoAndPriority();
  await _claimScheduledAndFilters();
  await _claimRefusals();
  await _markCompleteFsm();
  await _markFailedAndRetry();
  await _markFailedConcurrentRace();
  await _cancelPath();
  await _cleanupAgeCutoff();
  await _stationAndDailyMetrics();
  await _readsAndDashboard();
  await _factoryNoDeps();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("print-queue: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
