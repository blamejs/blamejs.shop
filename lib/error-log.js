"use strict";
/**
 * @module shop.errorLog
 * @title  Error log — operator-side record of HTTP 4xx/5xx events
 *
 * @intro
 *   Hot-path observability sink for the request lifecycle. The
 *   storefront / admin / API layers call `recordError` on every
 *   non-2xx response; this primitive captures the row, surfaces the
 *   top-404 dead-link aggregate, the upstream-5xx breakdown, the
 *   slow-render outliers, and the per-window p50 / p95 / p99
 *   response-time math the operator dashboard renders.
 *
 *   **Drop-silent on bad input — by design.** `recordError` is wired
 *   directly into the request lifecycle. Throwing inside it would
 *   crash the response that triggered it, turning a recorded 404
 *   into an unrecorded 500. Every malformed input (bad status,
 *   unknown method, missing required field, oversized string)
 *   resolves to a silent drop. Read-side methods (`top404Paths`,
 *   `top5xxErrors`, `slowRenders`, `errorById`, `byStatus`,
 *   `metrics`) THROW on bad input — those are dashboard queries with
 *   an operator on the other end of the stack trace.
 *
 *   Session identifiers are hashed via
 *   `b.crypto.namespaceHash("error-log-session", ...)` before the
 *   row reaches the database. The customer_id passes through plain
 *   because the customers table primary-keys on the same shape (an
 *   operator joining the two tables needs the unhashed value).
 *
 *   v1 surface:
 *
 *     errorLog.recordError({
 *       status, path, method,
 *       referrer?, user_agent_class,
 *       session_id?, customer_id?,
 *       error_id?, response_time_ms?,
 *       occurred_at?,
 *     })
 *       → { id, occurred_at }   on success
 *       → { dropped: true, reason }   on bad input (no throw)
 *
 *     errorLog.top404Paths({ from, to, limit })
 *       → [{ path, count }]   sorted by count DESC
 *
 *     errorLog.top5xxErrors({ from, to, limit })
 *       → [{ path, status, count }]   sorted by count DESC
 *
 *     errorLog.slowRenders({ from, to, limit, p99_threshold_ms? })
 *       → [{ id, path, status, response_time_ms, occurred_at }]
 *         sorted by response_time_ms DESC
 *
 *     errorLog.errorById(error_id)
 *       → row | null
 *
 *     errorLog.byStatus({ status, from, to, limit, cursor? })
 *       → { rows, next_cursor }   keyset-paginated on (occurred_at, id)
 *
 *     errorLog.metrics({ from, to })
 *       → { total, by_status_class, p50_ms, p95_ms, p99_ms }
 *
 *   Percentile math: response_time_ms is collected, sorted, and a
 *   simple index-into-sorted-array is read off (no streaming
 *   estimator — operators on a single-shard D1 dataset hit modest
 *   row counts and want exact answers). The `metrics` method
 *   defaults to a 24-hour window; the operator passes a wider range
 *   for daily/weekly rollups.
 */

var b = require("./index").framework;
var C = b.constants;

var ONE_YEAR_MS      = C.TIME.days(365);
var DEFAULT_WINDOW_MS = C.TIME.days(1);             // 24h — the dashboard's default

var SESSION_NAMESPACE = "error-log-session";

var METHODS    = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
var UA_CLASSES = ["desktop", "mobile", "bot", "other"];

// String length bounds for the persisted columns. A path that
// breaches the bound is almost always a misrouted query string or a
// caller-side bug — the drop-silent gate refuses the row rather
// than truncate (truncated paths aggregate to garbage buckets).
var MAX_PATH         = 2048;
var MAX_REFERRER     = 2048;
var MAX_SESSION_ID   = 512;
var MAX_CUSTOMER_ID  = 512;
var MAX_ERROR_ID     = 128;

// ---- read-side validators (THROW — dashboard queries) ------------------

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("errorLog: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _resolveWindow(opts) {
  opts = opts || {};
  var now = Date.now();
  var from = opts.from == null ? (now - DEFAULT_WINDOW_MS) : opts.from;
  var to   = opts.to   == null ? now                      : opts.to;
  _epochMs(from, "from");
  _epochMs(to,   "to");
  if (from >= to) {
    throw new TypeError("errorLog: from must be strictly less than to");
  }
  if ((to - from) > ONE_YEAR_MS) {
    throw new TypeError("errorLog: window (to - from) must be ≤ 1 year");
  }
  return { from: from, to: to };
}

function _limit(n, label, max) {
  max = max || 100;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new TypeError("errorLog: " + label + " must be an integer in [1, " + max + "]");
  }
}

// ---- write-side drop-silent helpers ------------------------------------

function _isInt(n)         { return typeof n === "number" && Number.isInteger(n); }
function _isPositive(n)    { return _isInt(n) && n > 0; }
function _isNonNegative(n) { return _isInt(n) && n >= 0; }

function _isBoundedString(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function _isOptionalBoundedString(v, max) {
  if (v == null) return true;
  return _isBoundedString(v, max);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  return {
    // Record a single error-log row. **Drop-silent on bad input** —
    // this surface is wired into the request lifecycle and a thrown
    // exception would crash the response that triggered it.
    //
    // Returns `{ id, occurred_at }` on success and
    // `{ dropped: true, reason }` on every refusal so a caller that
    // wants to log the drop (debug builds, smoke tests) can see why.
    // Production callers ignore the return value; the drop is silent
    // from the operator dashboard's perspective.
    recordError: async function (input) {
      try {
        if (!input || typeof input !== "object") {
          return { dropped: true, reason: "input must be an object" };
        }

        // status — required, integer in HTTP-error range.
        var status = input.status;
        if (!_isInt(status) || status < 400 || status > 599) {
          return { dropped: true, reason: "status must be an integer in [400, 599]" };
        }

        // path — required, bounded string. Caller strips the query
        // string before passing (the GROUP BY relies on this).
        var path = input.path;
        if (!_isBoundedString(path, MAX_PATH)) {
          return { dropped: true, reason: "path must be a non-empty string ≤ " + MAX_PATH + " chars" };
        }

        // method — required, enum.
        var method = input.method;
        if (typeof method !== "string" || METHODS.indexOf(method) === -1) {
          return { dropped: true, reason: "method must be one of " + METHODS.join(", ") };
        }

        // user_agent_class — required, enum. A request without one
        // is a caller-side bug (the request lifecycle classifies
        // every UA before recordError is invoked).
        var uaClass = input.user_agent_class;
        if (typeof uaClass !== "string" || UA_CLASSES.indexOf(uaClass) === -1) {
          return { dropped: true, reason: "user_agent_class must be one of " + UA_CLASSES.join(", ") };
        }

        // referrer — optional, bounded string.
        if (!_isOptionalBoundedString(input.referrer, MAX_REFERRER)) {
          return { dropped: true, reason: "referrer must be a bounded non-empty string when provided" };
        }
        var referrer = input.referrer == null ? null : input.referrer;

        // session_id — optional. Hashed before persist.
        if (!_isOptionalBoundedString(input.session_id, MAX_SESSION_ID)) {
          return { dropped: true, reason: "session_id must be a bounded non-empty string when provided" };
        }

        // customer_id — optional, plain.
        if (!_isOptionalBoundedString(input.customer_id, MAX_CUSTOMER_ID)) {
          return { dropped: true, reason: "customer_id must be a bounded non-empty string when provided" };
        }
        var customerId = input.customer_id == null ? null : input.customer_id;

        // error_id — optional correlation id surfaced in the
        // rendered error page.
        if (!_isOptionalBoundedString(input.error_id, MAX_ERROR_ID)) {
          return { dropped: true, reason: "error_id must be a bounded non-empty string when provided" };
        }
        var errorId = input.error_id == null ? null : input.error_id;

        // response_time_ms — optional, non-negative integer.
        var responseTimeMs;
        if (input.response_time_ms == null) {
          responseTimeMs = null;
        } else if (_isNonNegative(input.response_time_ms)) {
          responseTimeMs = input.response_time_ms;
        } else {
          return { dropped: true, reason: "response_time_ms must be a non-negative integer when provided" };
        }

        // occurred_at — optional, defaults to Date.now().
        var occurredAt;
        if (input.occurred_at == null) {
          occurredAt = Date.now();
        } else if (_isNonNegative(input.occurred_at)) {
          occurredAt = input.occurred_at;
        } else {
          return { dropped: true, reason: "occurred_at must be a non-negative integer when provided" };
        }

        var sessionHash = input.session_id == null
          ? null
          : b.crypto.namespaceHash(SESSION_NAMESPACE, input.session_id);

        var id = b.uuid.v7();
        await query(
          "INSERT INTO error_log " +
          "(id, status, path, method, referrer, user_agent_class, " +
          " session_id_hash, customer_id, error_id, response_time_ms, occurred_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
          [id, status, path, method, referrer, uaClass,
           sessionHash, customerId, errorId, responseTimeMs, occurredAt],
        );
        return { id: id, occurred_at: occurredAt };
      } catch (_e) {
        // Drop-silent on any unexpected failure — a database hiccup
        // mid-request must not crash the response. The aggregate
        // dashboards already render "no data" gracefully so an
        // observed gap is the operator's signal to check the DB.
        return { dropped: true, reason: "internal" };
      }
    },

    // Top-N 404 paths within the window. GROUP BY path, ORDER BY
    // count DESC. The aggregate strips query strings at the write
    // site so a single dead link surfaces as one row regardless of
    // tracking parameters.
    top404Paths: async function (windowOpts) {
      var w = _resolveWindow(windowOpts);
      var limit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
      _limit(limit, "limit");
      var r = await query(
        "SELECT path AS path, COUNT(*) AS count " +
        "  FROM error_log " +
        " WHERE status = 404 " +
        "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
        " GROUP BY path " +
        " ORDER BY count DESC, path ASC " +
        " LIMIT ?3",
        [w.from, w.to, limit],
      );
      return r.rows.map(function (row) {
        return { path: row.path, count: Number(row.count) || 0 };
      });
    },

    // Top-N 5xx (path, status) tuples within the window. Operators
    // use this to triage upstream failures — a sudden spike on a
    // single (path, 502) tuple usually points at a misbehaving
    // dependency.
    top5xxErrors: async function (windowOpts) {
      var w = _resolveWindow(windowOpts);
      var limit = (windowOpts && windowOpts.limit) == null ? 10 : windowOpts.limit;
      _limit(limit, "limit");
      var r = await query(
        "SELECT path AS path, status AS status, COUNT(*) AS count " +
        "  FROM error_log " +
        " WHERE status >= 500 AND status <= 599 " +
        "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
        " GROUP BY path, status " +
        " ORDER BY count DESC, path ASC, status ASC " +
        " LIMIT ?3",
        [w.from, w.to, limit],
      );
      return r.rows.map(function (row) {
        return {
          path:   row.path,
          status: Number(row.status) || 0,
          count:  Number(row.count) || 0,
        };
      });
    },

    // Slow-render outliers — rows whose response_time_ms exceeded
    // the operator threshold within the window. Default threshold
    // is 2000ms (a server-rendered page taking >2s is loud enough
    // to surface on the dashboard without burying everything else).
    slowRenders: async function (windowOpts) {
      var w = _resolveWindow(windowOpts);
      var limit = (windowOpts && windowOpts.limit) == null ? 20 : windowOpts.limit;
      _limit(limit, "limit");
      var threshold = (windowOpts && windowOpts.p99_threshold_ms) == null ? 2000 : windowOpts.p99_threshold_ms;
      if (!_isNonNegative(threshold)) {
        throw new TypeError("errorLog: p99_threshold_ms must be a non-negative integer");
      }
      var r = await query(
        "SELECT id, path, status, response_time_ms, occurred_at " +
        "  FROM error_log " +
        " WHERE response_time_ms IS NOT NULL " +
        "   AND response_time_ms >= ?1 " +
        "   AND occurred_at >= ?2 AND occurred_at < ?3 " +
        " ORDER BY response_time_ms DESC, id ASC " +
        " LIMIT ?4",
        [threshold, w.from, w.to, limit],
      );
      return r.rows.map(function (row) {
        return {
          id:                row.id,
          path:              row.path,
          status:            Number(row.status) || 0,
          response_time_ms:  Number(row.response_time_ms) || 0,
          occurred_at:       Number(row.occurred_at) || 0,
        };
      });
    },

    // Correlation-id lookup — operator pastes the error id from the
    // rendered page and gets the single row back. Returns `null`
    // when no row matches (the customer mistyped, or the row was
    // already swept by retention).
    errorById: async function (errorId) {
      if (typeof errorId !== "string" || errorId.length === 0) {
        throw new TypeError("errorLog.errorById: error_id required");
      }
      if (errorId.length > MAX_ERROR_ID) {
        throw new TypeError("errorLog.errorById: error_id exceeds " + MAX_ERROR_ID + " chars");
      }
      var r = await query(
        "SELECT id, status, path, method, referrer, user_agent_class, " +
        "       session_id_hash, customer_id, error_id, response_time_ms, occurred_at " +
        "  FROM error_log " +
        " WHERE error_id = ?1 " +
        " ORDER BY occurred_at DESC, id ASC " +
        " LIMIT 1",
        [errorId],
      );
      if (r.rows.length === 0) return null;
      var row = r.rows[0];
      return {
        id:                row.id,
        status:            Number(row.status) || 0,
        path:              row.path,
        method:            row.method,
        referrer:          row.referrer,
        user_agent_class:  row.user_agent_class,
        session_id_hash:   row.session_id_hash,
        customer_id:       row.customer_id,
        error_id:          row.error_id,
        response_time_ms:  row.response_time_ms == null ? null : Number(row.response_time_ms),
        occurred_at:       Number(row.occurred_at) || 0,
      };
    },

    // Keyset-paginated scan over a single status code. The cursor
    // is the (occurred_at, id) pair from the last row of the
    // previous page — operators step through a long tail without
    // OFFSET-induced scan cost.
    byStatus: async function (opts) {
      opts = opts || {};
      if (!_isInt(opts.status) || opts.status < 400 || opts.status > 599) {
        throw new TypeError("errorLog.byStatus: status must be an integer in [400, 599]");
      }
      var w = _resolveWindow(opts);
      var limit = opts.limit == null ? 50 : opts.limit;
      _limit(limit, "limit", 500);

      var cursorAt = null;
      var cursorId = null;
      if (opts.cursor != null) {
        if (typeof opts.cursor !== "string" || opts.cursor.indexOf(":") === -1) {
          throw new TypeError("errorLog.byStatus: cursor must be a string of the form '<occurred_at>:<id>'");
        }
        var idx = opts.cursor.indexOf(":");
        var at  = parseInt(opts.cursor.slice(0, idx), 10);
        var id  = opts.cursor.slice(idx + 1);
        if (!Number.isInteger(at) || at < 0 || id.length === 0) {
          throw new TypeError("errorLog.byStatus: cursor parses to garbage");
        }
        cursorAt = at;
        cursorId = id;
      }

      var sql;
      var params;
      if (cursorAt == null) {
        sql =
          "SELECT id, status, path, method, referrer, user_agent_class, " +
          "       session_id_hash, customer_id, error_id, response_time_ms, occurred_at " +
          "  FROM error_log " +
          " WHERE status = ?1 " +
          "   AND occurred_at >= ?2 AND occurred_at < ?3 " +
          " ORDER BY occurred_at DESC, id DESC " +
          " LIMIT ?4";
        params = [opts.status, w.from, w.to, limit + 1];
      } else {
        sql =
          "SELECT id, status, path, method, referrer, user_agent_class, " +
          "       session_id_hash, customer_id, error_id, response_time_ms, occurred_at " +
          "  FROM error_log " +
          " WHERE status = ?1 " +
          "   AND occurred_at >= ?2 AND occurred_at < ?3 " +
          "   AND (occurred_at < ?4 OR (occurred_at = ?4 AND id < ?5)) " +
          " ORDER BY occurred_at DESC, id DESC " +
          " LIMIT ?6";
        params = [opts.status, w.from, w.to, cursorAt, cursorId, limit + 1];
      }
      var r = await query(sql, params);

      var rows = r.rows.slice(0, limit).map(function (row) {
        return {
          id:                row.id,
          status:            Number(row.status) || 0,
          path:              row.path,
          method:            row.method,
          referrer:          row.referrer,
          user_agent_class:  row.user_agent_class,
          session_id_hash:   row.session_id_hash,
          customer_id:       row.customer_id,
          error_id:          row.error_id,
          response_time_ms:  row.response_time_ms == null ? null : Number(row.response_time_ms),
          occurred_at:       Number(row.occurred_at) || 0,
        };
      });
      var nextCursor = null;
      if (r.rows.length > limit) {
        var last = rows[rows.length - 1];
        nextCursor = last.occurred_at + ":" + last.id;
      }
      return { rows: rows, next_cursor: nextCursor };
    },

    // Aggregate counts + response-time percentiles for the window.
    // Percentile math is exact: pull every non-null response_time_ms
    // into memory, sort, index. Operators on a single-shard D1
    // dataset hit modest row counts and prefer exact answers over
    // streaming-estimator approximations.
    metrics: async function (windowOpts) {
      var w = _resolveWindow(windowOpts);

      var counts = await query(
        "SELECT status, COUNT(*) AS count " +
        "  FROM error_log " +
        " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
        " GROUP BY status",
        [w.from, w.to],
      );
      var total = 0;
      var byClass = { "4xx": 0, "5xx": 0 };
      for (var i = 0; i < counts.rows.length; i += 1) {
        var row = counts.rows[i];
        var n = Number(row.count) || 0;
        total += n;
        var s = Number(row.status) || 0;
        if (s >= 400 && s <= 499) byClass["4xx"] += n;
        else if (s >= 500 && s <= 599) byClass["5xx"] += n;
      }

      var times = await query(
        "SELECT response_time_ms " +
        "  FROM error_log " +
        " WHERE response_time_ms IS NOT NULL " +
        "   AND occurred_at >= ?1 AND occurred_at < ?2 " +
        " ORDER BY response_time_ms ASC",
        [w.from, w.to],
      );
      var sorted = [];
      for (var j = 0; j < times.rows.length; j += 1) {
        var v = Number(times.rows[j].response_time_ms);
        if (Number.isFinite(v)) sorted.push(v);
      }

      function _pct(p) {
        if (sorted.length === 0) return 0;
        // Index = ceil(p * N) - 1, clamped to [0, N-1]. Matches the
        // "nearest-rank" definition operators expect on a discrete
        // sample (a p99 over 100 rows points at the 99th, not at
        // the interpolated 99.0th).
        var idx = Math.ceil(p * sorted.length) - 1;
        if (idx < 0) idx = 0;
        if (idx >= sorted.length) idx = sorted.length - 1;
        return sorted[idx];
      }

      return {
        total:           total,
        by_status_class: byClass,
        p50_ms:          _pct(0.50),
        p95_ms:          _pct(0.95),
        p99_ms:          _pct(0.99),
      };
    },
  };
}

module.exports = {
  create:            create,
  ONE_YEAR_MS:       ONE_YEAR_MS,
  DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
  SESSION_NAMESPACE: SESSION_NAMESPACE,
};
