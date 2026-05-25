"use strict";
/**
 * @module shop.printQueue
 * @title  Print queue — warehouse print job scheduler that decouples
 *         order-flow code from the physical printer matrix
 *
 * @intro
 *   The warehouse needs packing slips, shipping labels, return labels,
 *   and invoices printed at six workstations across two floors. Each
 *   workstation has a thermal label printer + a laser printer; some
 *   only print 4x6 thermal labels, others only handle Letter / A4
 *   paper. A naive "print this slip directly" verb couples the
 *   order-flow code to which printer is physically online right now,
 *   which paper is loaded, which workstation is unmanned at 3am.
 *
 *   The fix is a queue: order-flow code calls `enqueueJob({...})` and
 *   walks away; workstations call `claimJob({ station_id, kinds? })`
 *   when their operator is ready to print, atomically marking the job
 *   in_progress; after the print succeeds the workstation calls
 *   `markComplete`. If the printer jams or runs out of paper,
 *   `markFailed({ retry: true })` puts the job back at the front of
 *   the queue for the next claimant with `retry_count + 1`.
 *
 *   Lifecycle (five-state FSM):
 *
 *     enqueueJob({ kind, payload_ref, priority, station_filter?,
 *                  paper_size?, copies?, scheduled_at? })
 *       Creates a new `queued` row. `kind` is one of packing_slip /
 *       shipping_label / invoice / packing_label / return_label /
 *       pickup_slip. `payload_ref` is an opaque operator-supplied
 *       reference (typically an order_id, shipment_id, or pre-rendered
 *       PDF object key) — the queue itself doesn't interpret it; the
 *       claiming workstation resolves the payload via its own render
 *       pipeline. `priority` is 0..10 (higher wins). `paper_size`
 *       defaults to a kind-appropriate value (labels → thermal_4x6,
 *       slips/invoices → letter). `copies` defaults to 1.
 *       `station_filter` (optional) restricts the claim pool to a
 *       single station_id. `scheduled_at` (optional) defers the job —
 *       claims refuse to return rows whose scheduled_at exceeds the
 *       current clock. Returns the inserted row.
 *
 *     claimJob({ station_id, kinds? })
 *       Atomically claims the highest-priority eligible queued row
 *       and flips it to `in_progress`. Eligible = `status='queued'`
 *       AND `scheduled_at <= now()` AND (`station_filter IS NULL` OR
 *       `station_filter = station_id`) AND (`kinds` is omitted OR
 *       `kind IN kinds`). Returns the claimed row or null when no job
 *       is eligible. The claim writes `claimed_by_station` +
 *       `claimed_at` so the audit trail answers "who was working on
 *       what when the network went down". Ordering: (priority DESC,
 *       scheduled_at ASC, created_at ASC) — highest priority wins,
 *       FIFO within a priority band.
 *
 *     markComplete({ job_id, station_id })
 *       in_progress -> complete. Refuses when the job isn't claimed
 *       by the supplied station_id (a different workstation can't
 *       complete someone else's job). Stamps `completed_at` +
 *       `completed_by_station`.
 *
 *     markFailed({ job_id, station_id, reason, retry? })
 *       in_progress -> failed. Refuses when the job isn't claimed by
 *       the supplied station_id. Stamps `failed_at` + `fail_reason`.
 *       When `retry: true`, inserts a fresh `queued` row with the
 *       same payload + `retry_count + 1`; the failed row stays on
 *       disk for the audit. Returns `{ failed, requeued? }` so the
 *       workstation knows whether to expect the same job back on the
 *       next poll.
 *
 *     cancelJob({ job_id, reason })
 *       queued|in_progress -> cancelled. Used when the upstream
 *       trigger went away (order cancelled, shipment voided). Refuses
 *       cancelling a terminal job (complete / failed / cancelled).
 *       Persists `cancel_reason` + `failed_at`.
 *
 *   Reads:
 *     getJob(job_id)                                — single row by id
 *     jobsForStation({ station_id, status?, limit? }) — claimed-by-this-
 *                                                       station view,
 *                                                       newest-first
 *     pendingByKind({ kind, priority_min? })        — operator dashboard
 *                                                       "what's piling up
 *                                                       in the queue"
 *     stationActivity({ station_id, from, to })     — per-station throughput
 *                                                       breakdown
 *     dailyMetrics({ from, to })                    — aggregate throughput
 *                                                       across the window
 *
 *   Maintenance:
 *     cleanupCompleted({ older_than_hours })
 *       Deletes complete + cancelled rows whose completed_at /
 *       failed_at is older than the cutoff. Failed-but-requeued rows
 *       (retried) are deleted too — the audit lives in the new queued
 *       row's `retry_count` lineage. Returns the deleted count.
 *
 *   Composition:
 *     - b.uuid.v7              — job ids (sortable; the dashboard
 *                                reads sort by id DESC to get
 *                                newest-first without a second index).
 *     - b.guardUuid            — strict UUID validation on every id
 *                                input.
 *
 *   Three-tier input validation: every public verb is either a
 *   config-time entry point (factory create) or a defensive
 *   request-shape reader. All throw on bad input — no drop-silent
 *   hot-path sinks.
 *
 * @primitive printQueue
 * @related    pickLists, orderTracking, splitShipments
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}
var C = _b().constants;

// ---- constants ----------------------------------------------------------

var STATION_RE      = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var PAYLOAD_RE      = /^[A-Za-z0-9][A-Za-z0-9._:/=+-]{0,255}$/;
var MAX_REASON      = 280;
var MAX_KINDS       = 16;
var MAX_LIMIT       = 500;
var DEFAULT_LIMIT   = 100;
var MAX_PRIORITY    = 10;
var MAX_COPIES      = 99;
var MAX_RETRY_COUNT = 64;

var KIND_ENUM = Object.freeze([
  "packing_slip", "shipping_label", "invoice",
  "packing_label", "return_label", "pickup_slip",
]);

var PAPER_SIZE_ENUM = Object.freeze([
  "letter", "a4", "thermal_4x6", "thermal_4x8",
]);

var STATUS_ENUM = Object.freeze([
  "queued", "in_progress", "complete", "failed", "cancelled",
]);

// Default paper size keyed by job kind. Labels go to the thermal
// printer; slips + invoices go to the laser printer. Operators override
// per-job when their workflow doesn't match the default (e.g. printing
// a return label on letter stock because the thermal printer is down).
var DEFAULT_PAPER_BY_KIND = Object.freeze({
  packing_slip:   "letter",
  shipping_label: "thermal_4x6",
  invoice:        "letter",
  packing_label:  "thermal_4x6",
  return_label:   "thermal_4x6",
  pickup_slip:    "letter",
});

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return _b().guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("print-queue: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _station(s, label) {
  if (typeof s !== "string" || !STATION_RE.test(s)) {
    throw new TypeError("print-queue: " + (label || "station_id") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _payloadRef(s) {
  if (typeof s !== "string" || !PAYLOAD_RE.test(s)) {
    throw new TypeError("print-queue: payload_ref must be a 1..256 char string of " +
      "alnum + . _ : / = + - characters");
  }
}
function _kind(s) {
  if (KIND_ENUM.indexOf(s) === -1) {
    throw new TypeError("print-queue: kind must be one of " + KIND_ENUM.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _paperSize(s) {
  if (PAPER_SIZE_ENUM.indexOf(s) === -1) {
    throw new TypeError("print-queue: paper_size must be one of " + PAPER_SIZE_ENUM.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _status(s) {
  if (STATUS_ENUM.indexOf(s) === -1) {
    throw new TypeError("print-queue: status must be one of " + STATUS_ENUM.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _priority(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) {
    throw new TypeError("print-queue: priority must be an integer in 0..." + MAX_PRIORITY);
  }
}
function _copies(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_COPIES) {
    throw new TypeError("print-queue: copies must be an integer in 1..." + MAX_COPIES);
  }
}
function _scheduledAt(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("print-queue: scheduled_at must be a non-negative integer (epoch ms)");
  }
}
function _reason(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REASON) {
    throw new TypeError("print-queue: " + (label || "reason") +
      " must be a non-empty string ≤ " + MAX_REASON + " chars");
  }
  return s;
}
function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("print-queue: limit must be an integer in 1..." + MAX_LIMIT);
  }
}
function _hours(n, label) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) {
    throw new TypeError("print-queue: " + label + " must be a non-negative finite number");
  }
}
function _window(from, to) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError("print-queue: from must be a non-negative integer (epoch ms)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError("print-queue: to must be a non-negative integer (epoch ms)");
  }
  if (from > to) {
    throw new TypeError("print-queue: from must be ≤ to");
  }
}
function _kindsFilter(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("print-queue: kinds filter must be a non-empty array when supplied");
  }
  if (arr.length > MAX_KINDS) {
    throw new TypeError("print-queue: kinds filter accepts at most " + MAX_KINDS + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    _kind(arr[i]);
    if (seen[arr[i]]) {
      throw new TypeError("print-queue: duplicate kind " + JSON.stringify(arr[i]) + " in filter");
    }
    seen[arr[i]] = true;
    out.push(arr[i]);
  }
  return out;
}

// Monotonic clock — every write that stamps a timestamp uses _now()
// instead of Date.now() directly so an enqueueJob + immediate claimJob
// + markComplete sequence never collides on the millisecond boundary.
// Operators reading the timeline get a strict ordering even on hosts
// where Date.now() is coarse.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// Build a parameterized IN-clause from a fixed-enum list. The values
// themselves are validated against KIND_ENUM before reaching this
// function so no operator input lands in the SQL string verbatim; the
// param indices start at `startIndex` so callers can compose with
// other ?N placeholders.
function _inClause(values, startIndex) {
  var placeholders = [];
  for (var i = 0; i < values.length; i += 1) {
    placeholders.push("?" + (startIndex + i));
  }
  return "(" + placeholders.join(", ") + ")";
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  async function _getRow(id) {
    var r = await query("SELECT * FROM print_jobs WHERE id = ?1", [id]);
    return r.rows.length ? r.rows[0] : null;
  }

  return {
    KIND_ENUM:        KIND_ENUM,
    PAPER_SIZE_ENUM:  PAPER_SIZE_ENUM,
    STATUS_ENUM:      STATUS_ENUM,
    MAX_PRIORITY:     MAX_PRIORITY,
    MAX_COPIES:       MAX_COPIES,

    // Enqueue a new print job. Validates every field, fills defaults
    // (paper_size from DEFAULT_PAPER_BY_KIND[kind], copies = 1,
    // scheduled_at = now), and inserts a `queued` row. Returns the
    // inserted row.
    enqueueJob: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.enqueueJob: input object required");
      }
      _kind(input.kind);
      _payloadRef(input.payload_ref);
      _priority(input.priority);
      if (input.station_filter != null) _station(input.station_filter, "station_filter");
      var paperSize = input.paper_size == null ? DEFAULT_PAPER_BY_KIND[input.kind] : input.paper_size;
      _paperSize(paperSize);
      var copies = input.copies == null ? 1 : input.copies;
      _copies(copies);
      var ts = _now();
      var scheduledAt = input.scheduled_at == null ? ts : input.scheduled_at;
      _scheduledAt(scheduledAt);

      var id = _b().uuid.v7();
      await query(
        "INSERT INTO print_jobs (id, kind, payload_ref, priority, station_filter, " +
        "paper_size, copies, scheduled_at, status, retry_count, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', 0, ?9)",
        [id, input.kind, input.payload_ref, input.priority,
         input.station_filter == null ? null : input.station_filter,
         paperSize, copies, scheduledAt, ts],
      );
      return await _getRow(id);
    },

    // Atomically claim the highest-priority eligible queued job for
    // the supplied station. Returns the claimed row (status flipped
    // to `in_progress`) or null when no job is eligible. The
    // SELECT + UPDATE pair is serialized inside the query
    // implementation (sqlite is single-writer; D1 wraps in a
    // transaction at the worker layer) so two workstations polling
    // simultaneously can't both win the same row.
    claimJob: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.claimJob: input object required");
      }
      _station(input.station_id);
      var ts = _now();
      var kindsFilter = null;
      if (input.kinds != null) kindsFilter = _kindsFilter(input.kinds);

      // Build the SELECT. station_filter must be null OR match the
      // claiming station; scheduled_at must not exceed the current
      // clock; kinds filter (when supplied) restricts to the
      // workstation's declared capabilities. The ORDER BY matches
      // the (status, priority DESC, scheduled_at) index exactly.
      var sql = "SELECT id FROM print_jobs WHERE status = 'queued' " +
                "AND scheduled_at <= ?1 " +
                "AND (station_filter IS NULL OR station_filter = ?2) ";
      var params = [ts, input.station_id];
      if (kindsFilter) {
        sql += "AND kind IN " + _inClause(kindsFilter, 3) + " ";
        for (var i = 0; i < kindsFilter.length; i += 1) params.push(kindsFilter[i]);
      }
      sql += "ORDER BY priority DESC, scheduled_at ASC, created_at ASC, id ASC LIMIT 1";

      var sel = await query(sql, params);
      if (!sel.rows.length) return null;
      var jobId = sel.rows[0].id;

      // Compare-and-swap on status — guard against a racing claimer
      // that already flipped the row in the same millisecond window.
      // When the UPDATE affects zero rows, the other claimer won;
      // return null and let the caller poll again.
      var upd = await query(
        "UPDATE print_jobs SET status = 'in_progress', claimed_by_station = ?1, " +
        "claimed_at = ?2 WHERE id = ?3 AND status = 'queued'",
        [input.station_id, ts, jobId],
      );
      if (upd.rowCount === 0) return null;
      return await _getRow(jobId);
    },

    // in_progress -> complete. Refuses unless the job is claimed by
    // the supplied station — a different workstation can't complete
    // someone else's job (audit trail integrity).
    markComplete: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.markComplete: input object required");
      }
      var jobId = _id(input.job_id, "job_id");
      _station(input.station_id);
      var row = await _getRow(jobId);
      if (!row) {
        throw new TypeError("print-queue.markComplete: job " + jobId + " not found");
      }
      if (row.status !== "in_progress") {
        throw new TypeError("print-queue.markComplete: job is " + row.status +
          ", only in_progress jobs can be completed");
      }
      if (row.claimed_by_station !== input.station_id) {
        throw new TypeError("print-queue.markComplete: job claimed by " +
          JSON.stringify(row.claimed_by_station) + ", not " +
          JSON.stringify(input.station_id));
      }
      var ts = _now();
      await query(
        "UPDATE print_jobs SET status = 'complete', completed_at = ?1, " +
        "completed_by_station = ?2 WHERE id = ?3",
        [ts, input.station_id, jobId],
      );
      return await _getRow(jobId);
    },

    // in_progress -> failed. Same station-ownership check as
    // markComplete. When `retry: true`, inserts a fresh `queued` row
    // with the same payload + `retry_count + 1` so the job goes back
    // to the head of the priority band. Returns `{ failed: row,
    // requeued?: row }` so the caller can deep-link to the new
    // queued row for monitoring.
    markFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.markFailed: input object required");
      }
      var jobId = _id(input.job_id, "job_id");
      _station(input.station_id);
      var reason = _reason(input.reason, "reason");
      var retry = input.retry === true;
      var row = await _getRow(jobId);
      if (!row) {
        throw new TypeError("print-queue.markFailed: job " + jobId + " not found");
      }
      if (row.status !== "in_progress") {
        throw new TypeError("print-queue.markFailed: job is " + row.status +
          ", only in_progress jobs can be marked failed");
      }
      if (row.claimed_by_station !== input.station_id) {
        throw new TypeError("print-queue.markFailed: job claimed by " +
          JSON.stringify(row.claimed_by_station) + ", not " +
          JSON.stringify(input.station_id));
      }
      var ts = _now();
      await query(
        "UPDATE print_jobs SET status = 'failed', failed_at = ?1, fail_reason = ?2 " +
        "WHERE id = ?3",
        [ts, reason, jobId],
      );
      var failed = await _getRow(jobId);
      var out = { failed: failed };

      if (retry) {
        // Refuse runaway retry loops. retry_count > MAX_RETRY_COUNT
        // surfaces as a TypeError so the workstation operator can't
        // accidentally hammer the queue when the underlying printer
        // is wedged.
        if (row.retry_count >= MAX_RETRY_COUNT) {
          throw new TypeError("print-queue.markFailed: retry_count " + row.retry_count +
            " has reached the cap (" + MAX_RETRY_COUNT + "); the operator " +
            "must clear the underlying failure before requeueing");
        }
        var newId = _b().uuid.v7();
        var ts2 = _now();
        await query(
          "INSERT INTO print_jobs (id, kind, payload_ref, priority, station_filter, " +
          "paper_size, copies, scheduled_at, status, retry_count, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10)",
          [newId, row.kind, row.payload_ref, row.priority, row.station_filter,
           row.paper_size, row.copies, ts2, row.retry_count + 1, ts2],
        );
        out.requeued = await _getRow(newId);
      }
      return out;
    },

    // queued|in_progress -> cancelled. Used when the upstream trigger
    // went away (order cancelled, shipment voided). Refuses on
    // terminal states so the audit trail can't be retroactively
    // rewritten.
    cancelJob: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.cancelJob: input object required");
      }
      var jobId = _id(input.job_id, "job_id");
      var reason = _reason(input.reason, "reason");
      var row = await _getRow(jobId);
      if (!row) {
        throw new TypeError("print-queue.cancelJob: job " + jobId + " not found");
      }
      if (row.status !== "queued" && row.status !== "in_progress") {
        throw new TypeError("print-queue.cancelJob: job is " + row.status +
          ", only queued or in_progress jobs can be cancelled");
      }
      var ts = _now();
      await query(
        "UPDATE print_jobs SET status = 'cancelled', cancel_reason = ?1, failed_at = ?2 " +
        "WHERE id = ?3",
        [reason, ts, jobId],
      );
      return await _getRow(jobId);
    },

    // Single-row read. Validates id shape so a typo surfaces as a
    // clear refusal instead of a bare null.
    getJob: async function (jobId) {
      var id = _id(jobId, "job_id");
      return await _getRow(id);
    },

    // Per-station view. Optional status filter; default limit 100,
    // cap 500. Returns newest-first (claimed_at DESC NULLS LAST so
    // unclaimed station_filter rows still surface).
    jobsForStation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.jobsForStation: input object required");
      }
      _station(input.station_id);
      var hasStatus = input.status != null;
      if (hasStatus) _status(input.status);
      var limit = input.limit == null ? DEFAULT_LIMIT : input.limit;
      _limit(limit);

      // The query covers both claimed jobs (claimed_by_station =
      // station_id) AND queued station-filtered jobs (station_filter
      // = station_id AND status = 'queued') so the operator UI shows
      // both "what I'm working on" and "what's pinned to my station".
      var sql, params;
      if (hasStatus) {
        sql = "SELECT * FROM print_jobs WHERE " +
              "(claimed_by_station = ?1 OR (station_filter = ?1 AND status = 'queued')) " +
              "AND status = ?2 " +
              "ORDER BY COALESCE(claimed_at, created_at) DESC, id DESC LIMIT ?3";
        params = [input.station_id, input.status, limit];
      } else {
        sql = "SELECT * FROM print_jobs WHERE " +
              "claimed_by_station = ?1 OR (station_filter = ?1 AND status = 'queued') " +
              "ORDER BY COALESCE(claimed_at, created_at) DESC, id DESC LIMIT ?2";
        params = [input.station_id, limit];
      }
      return (await query(sql, params)).rows;
    },

    // Operator dashboard "what's piling up in the queue". Filters
    // queued + in_progress rows by kind; optional priority_min surfaces
    // the high-priority backlog only. Newest-first within the
    // priority band so the operator sees the most-stale piles at the
    // bottom.
    pendingByKind: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.pendingByKind: input object required");
      }
      _kind(input.kind);
      var priorityMin = 0;
      if (input.priority_min != null) {
        _priority(input.priority_min);
        priorityMin = input.priority_min;
      }
      var r = await query(
        "SELECT * FROM print_jobs WHERE kind = ?1 AND priority >= ?2 " +
        "AND status IN ('queued', 'in_progress') " +
        "ORDER BY priority DESC, scheduled_at ASC, created_at ASC, id ASC",
        [input.kind, priorityMin],
      );
      return r.rows;
    },

    // Maintenance sweep. Deletes complete + cancelled rows older
    // than the cutoff (now - older_than_hours). Failed-and-requeued
    // rows are deleted too — the audit lives in the new queued row's
    // retry_count lineage. Returns `{ deleted: <count> }` so the
    // operator can monitor the sweep.
    cleanupCompleted: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.cleanupCompleted: input object required");
      }
      _hours(input.older_than_hours, "older_than_hours");
      var cutoff = _now() - Math.floor(C.TIME.hours(input.older_than_hours));
      var r = await query(
        "DELETE FROM print_jobs WHERE status IN ('complete', 'cancelled', 'failed') " +
        "AND COALESCE(completed_at, failed_at, created_at) < ?1",
        [cutoff],
      );
      return { deleted: r.rowCount };
    },

    // Per-station throughput breakdown across the window. Counts
    // claims (claimed_at in window), completions (completed_at in
    // window), and failures (failed_at in window, excluding
    // cancellations — those aren't "the workstation tried and
    // failed"). The window is half-open: [from, to).
    stationActivity: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.stationActivity: input object required");
      }
      _station(input.station_id);
      _window(input.from, input.to);
      var rClaims = await query(
        "SELECT COUNT(*) AS n FROM print_jobs " +
        "WHERE claimed_by_station = ?1 AND claimed_at >= ?2 AND claimed_at < ?3",
        [input.station_id, input.from, input.to],
      );
      var rComplete = await query(
        "SELECT COUNT(*) AS n FROM print_jobs " +
        "WHERE completed_by_station = ?1 AND completed_at >= ?2 AND completed_at < ?3",
        [input.station_id, input.from, input.to],
      );
      var rFailed = await query(
        "SELECT COUNT(*) AS n FROM print_jobs " +
        "WHERE claimed_by_station = ?1 AND status = 'failed' " +
        "AND failed_at >= ?2 AND failed_at < ?3",
        [input.station_id, input.from, input.to],
      );
      return {
        station_id: input.station_id,
        from:       input.from,
        to:         input.to,
        claims:     Number(rClaims.rows[0].n),
        completed:  Number(rComplete.rows[0].n),
        failed:     Number(rFailed.rows[0].n),
      };
    },

    // Aggregate throughput across the window. Returns totals plus
    // per-kind breakdown so the operator can spot e.g. "we printed
    // 4,000 shipping labels but only 12 invoices today". Window is
    // half-open: [from, to).
    dailyMetrics: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("print-queue.dailyMetrics: input object required");
      }
      _window(input.from, input.to);
      var rEnqueued = await query(
        "SELECT COUNT(*) AS n FROM print_jobs WHERE created_at >= ?1 AND created_at < ?2",
        [input.from, input.to],
      );
      var rCompleted = await query(
        "SELECT COUNT(*) AS n FROM print_jobs " +
        "WHERE status = 'complete' AND completed_at >= ?1 AND completed_at < ?2",
        [input.from, input.to],
      );
      var rFailed = await query(
        "SELECT COUNT(*) AS n FROM print_jobs " +
        "WHERE status = 'failed' AND failed_at >= ?1 AND failed_at < ?2",
        [input.from, input.to],
      );
      var rCancelled = await query(
        "SELECT COUNT(*) AS n FROM print_jobs " +
        "WHERE status = 'cancelled' AND failed_at >= ?1 AND failed_at < ?2",
        [input.from, input.to],
      );
      var rByKind = await query(
        "SELECT kind, COUNT(*) AS n FROM print_jobs " +
        "WHERE status = 'complete' AND completed_at >= ?1 AND completed_at < ?2 " +
        "GROUP BY kind ORDER BY kind ASC",
        [input.from, input.to],
      );
      var byKind = Object.create(null);
      for (var i = 0; i < KIND_ENUM.length; i += 1) byKind[KIND_ENUM[i]] = 0;
      for (var j = 0; j < rByKind.rows.length; j += 1) {
        byKind[rByKind.rows[j].kind] = Number(rByKind.rows[j].n);
      }
      return {
        from:           input.from,
        to:             input.to,
        enqueued:       Number(rEnqueued.rows[0].n),
        completed:      Number(rCompleted.rows[0].n),
        failed:         Number(rFailed.rows[0].n),
        cancelled:      Number(rCancelled.rows[0].n),
        completed_by_kind: byKind,
      };
    },
  };
}

module.exports = {
  create:           create,
  KIND_ENUM:        KIND_ENUM,
  PAPER_SIZE_ENUM:  PAPER_SIZE_ENUM,
  STATUS_ENUM:      STATUS_ENUM,
  MAX_PRIORITY:     MAX_PRIORITY,
  MAX_COPIES:       MAX_COPIES,
};
