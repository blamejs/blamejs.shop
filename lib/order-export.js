"use strict";
/**
 * @module shop.orderExport
 * @title  Order export — streaming CSV / NDJSON dump of the orders table
 *
 * @intro
 *   Operator export of orders to CSV or NDJSON for offline analysis,
 *   accounting reconciliation, or 3PL handoff. Big-result-safe: the
 *   row generator streams in batches via a (created_at, id) cursor
 *   so the full set never has to fit in memory.
 *
 *   Lifecycle / surfaces:
 *
 *     csvForRange({ from, to, columns?, batch_size?, cursor?, bom? })
 *       — async-iterable. Yields the header row on first iteration,
 *         then one chunk per database batch. RFC-4180 quoted on every
 *         cell, CRLF (`\r\n`) line endings. `columns` is an allowlist
 *         against the 24-column built-in schema; default is all 24.
 *         The optional `cursor` resumes a previous stream — operator
 *         re-tries after a network drop without redumping rows.
 *
 *     ndjsonForRange({ from, to, columns?, batch_size?, cursor? })
 *       — same shape but newline-delimited JSON. One JSON object per
 *         line; no enclosing array. Each line ends with `\n`.
 *
 *     summaryForRange({ from, to })
 *       — operator-dashboard aggregation:
 *           { order_count, revenue_minor, average_order_minor,
 *             by_status: { ... }, by_currency: { ... } }
 *         Walks the date range once, totals server-side.
 *
 *     scheduleExport({ format, from, to, columns?, deliver_to_url? })
 *     cancelExport(id) / getExport(id) / listExports({ status?, limit? })
 *     markExportRunning(id)
 *     markExportComplete({ export_id, row_count, byte_size, file_sha3_512 })
 *     markExportFailed({ export_id, error })
 *       — FSM-driven queue of operator-filed export jobs that a
 *         background worker picks up. States:
 *           queued → running → complete | failed
 *           queued → cancelled
 *         Re-cancel of an already-running job is refused (the worker
 *         has the bytes mid-flight; the operator manages reversal out
 *         of band).
 *
 *   Privacy:
 *
 *     Customer email is hashed via `b.crypto.namespaceHash(
 *     'order-export-email', ...)` — the raw address NEVER appears in
 *     export output. A 3PL handoff inheriting the CSV gets a stable
 *     pseudonymous identifier per customer, not a reusable
 *     contact-list payload. Operators that want to ship raw email
 *     compose their own export downstream of this primitive (they
 *     have the orders table directly).
 *
 *   CSV-injection defense:
 *
 *     Cell content beginning with `=`, `+`, `-`, or `@` is the
 *     classic CSV-injection vector — opening the file in a
 *     spreadsheet evaluates the cell as a formula. Per OWASP, every
 *     such cell is prefixed with `'` to neutralize the leading
 *     metacharacter — UNLESS it parses as a signed numeric (e.g.
 *     `+15.00` or `-3.50` — those are legitimate amounts). The
 *     primitive errs on the side of escaping; the consumer that
 *     genuinely wants raw formulas opts in by post-processing.
 *
 *   Composition:
 *     - b.crypto.namespaceHash — email pseudonymization
 *     - b.uuid.v7               — scheduled-exports PK
 *     - b.guardUuid             — strict UUID validation
 *     - b.fsm                   — scheduled-export status transitions
 */

var b = require("./vendor/blamejs");

// ---- column schema ------------------------------------------------------
//
// The 27-column built-in shape. Operators selecting `columns: [...]`
// pick a subset; order in the produced output follows COLUMN_ORDER,
// not the operator's input order, so consumers can rely on a stable
// header layout independent of how the request was filed.

var COLUMN_ORDER = Object.freeze([
  "order_id",
  "order_number",
  "created_at",
  "status",
  "customer_id",
  "customer_email_hash",
  "customer_name",
  "shipping_line1",
  "shipping_line2",
  "shipping_city",
  "shipping_country",
  "shipping_postal",
  "shipping_region",
  "line_count",
  "items_total_minor",
  "shipping_total_minor",
  "tax_total_minor",
  "discount_total_minor",
  "grand_total_minor",
  "currency",
  "payment_processor",
  "payment_method_brand",
  "payment_method_last4",
  "fulfillment_status",
  "refund_total_minor",
  "has_returns",
  "has_chargebacks",
]);

var COLUMN_SET = Object.freeze(COLUMN_ORDER.reduce(function (acc, c) {
  acc[c] = true; return acc;
}, {}));

var DEFAULT_BATCH_SIZE = 500;
var MAX_BATCH_SIZE     = 5000;
var MAX_LIST_LIMIT     = 200;
var EMAIL_HASH_PREFIX  = "order-export-email";
var CSV_LINE_ENDING    = "\r\n";   // RFC 4180
var FORMATS            = Object.freeze(["csv", "ndjson"]);
var EXPORT_STATUSES    = Object.freeze(["queued", "running", "complete", "failed", "cancelled"]);

// ---- FSM definition (scheduled exports) ---------------------------------

var _exportFsm = null;
function _getExportFsm() {
  if (_exportFsm) return _exportFsm;
  // The scheduled-exports lifecycle is small enough to be expressed
  // directly; reusing b.fsm keeps the audit-trail emission consistent
  // with the rest of the primitive surface (order, inventory-receive)
  // and gives us guard-driven transition refusal for free.
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent */ }
  _exportFsm = b.fsm.define({
    name:    "scheduled_export",
    initial: "queued",
    states: {
      queued:    {},
      running:   {},
      complete:  {},
      failed:    {},
      cancelled: {},
    },
    transitions: [
      { from: "queued",  to: "running",   on: "start" },
      { from: "running", to: "complete",  on: "complete" },
      { from: "running", to: "failed",    on: "fail" },
      { from: "queued",  to: "cancelled", on: "cancel" },
    ],
  });
  return _exportFsm;
}

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("order-export: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("order-export: " + label + " must be a non-negative integer");
  }
}
function _range(from, to) {
  _nonNegInt(from, "from");
  _nonNegInt(to,   "to");
  if (to < from) throw new TypeError("order-export: to must be >= from");
}
function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("order-export: batch_size must be an integer in 1..." + MAX_BATCH_SIZE);
  }
  return n;
}
function _columns(cols) {
  if (cols == null) return COLUMN_ORDER.slice();
  if (!Array.isArray(cols) || cols.length === 0) {
    throw new TypeError("order-export: columns must be a non-empty array of column names");
  }
  var picked = {};
  for (var i = 0; i < cols.length; i += 1) {
    var c = cols[i];
    if (typeof c !== "string" || !COLUMN_SET[c]) {
      throw new TypeError("order-export: unknown column " + JSON.stringify(c) +
        " — allowlist is " + COLUMN_ORDER.join(", "));
    }
    picked[c] = true;
  }
  // Stable header order — COLUMN_ORDER projection, not caller order.
  var out = [];
  for (var j = 0; j < COLUMN_ORDER.length; j += 1) {
    if (picked[COLUMN_ORDER[j]]) out.push(COLUMN_ORDER[j]);
  }
  return out;
}
function _format(f) {
  if (typeof f !== "string" || FORMATS.indexOf(f) === -1) {
    throw new TypeError("order-export: format must be one of " + FORMATS.join(", "));
  }
}
function _limit(n) {
  if (n == null) return 50;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("order-export: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

// ---- CSV helpers --------------------------------------------------------

function _coerceCell(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.join(",");
  return JSON.stringify(value);
}

// CSV injection neutralization — composes the vendored b.guardCsv.escapeCell
// (OWASP "CSV Injection" defense). The vendored primitive is the single
// shared neutralizer across every CSV export surface (order-export +
// customer-segments). It prefixes a leading TAB when a cell starts with ANY
// formula-trigger char — `= + - @` AND the tab / CR / LF / pipe / full-width
// variants a hand-rolled `= + - @`-only check misses. A leading tab renders
// as invisible whitespace in a spreadsheet, so the cell reads as text and
// never evaluates as a formula. The earlier in-tree check exempted signed
// numerics (`+15.00`); the shared primitive prefixes those too (the safe
// OWASP posture — `-2+3+cmd|…` is a real injection that begins like an
// amount), which is the more complete behavior this consolidation buys.
// One export row, RFC 4180.
//
// b.guardCsv.serialize does the whole line: the formula-injection prefix on
// every cell, the unconditional quoting, doubling an embedded quote, the
// delimiter and the CRLF. Only the injection step was composed before; the
// quoting rules were written here and again in customer-segments.js.
//
// Cells are quoted unconditionally. It costs a few bytes and means a
// downstream parser never has to track quote-versus-bare state on a column
// with mixed shapes.
//
// serialize emits the rows it is given WITHOUT a trailing terminator, which is
// right for a whole document and wrong for a generator yielding one row at a
// time — so the line ending is appended here. Verified byte-identical to the
// previous builder across formula-injection, embedded-quote, embedded-comma,
// newline, tab and empty cells.
function _csvRow(cells) {
  return b.guardCsv.serialize([cells.map(_coerceCell)], {
    profile:     "strict",
    alwaysQuote: true,
    headers:     false,
    lineEnding:  CSV_LINE_ENDING,
  }) + CSV_LINE_ENDING;
}

// ---- row projection -----------------------------------------------------

// Map a hydrated order row into the 24-column shape. Every value the
// CSV / NDJSON consumer sees flows through this single projection —
// the email-hash, the line-count, the fulfillment-status derivation
// all happen here so the two formats stay byte-for-byte aligned on
// column semantics. The `opts` arg is reserved for a future "include
// raw email" toggle; left open intentionally so the projection
// signature doesn't change when that lands.
function _projectOrder(row, _opts) {
  var emailHash = "";
  if (row.customer_email && typeof row.customer_email === "string") {
    emailHash = b.crypto.namespaceHash(EMAIL_HASH_PREFIX, row.customer_email);
  }
  var shipTo = {};
  if (row.ship_to_json) {
    try { shipTo = JSON.parse(row.ship_to_json) || {}; }
    catch (_e) { shipTo = {}; }                                               // drop-silent — bad ship_to_json shows up as empty fields, not a refused export
  } else if (row.ship_to && typeof row.ship_to === "object") {
    shipTo = row.ship_to;
  }
  var lineCount = row.line_count == null
    ? (Array.isArray(row.lines) ? row.lines.length : 0)
    : row.line_count;
  return {
    order_id:             row.id || "",
    order_number:         row.order_number || row.id || "",
    created_at:           row.created_at == null ? "" : row.created_at,
    status:               row.status || "",
    customer_id:          row.customer_id || "",
    customer_email_hash:  emailHash,
    customer_name:        row.customer_name || "",
    shipping_line1:       shipTo.line1   || "",
    shipping_line2:       shipTo.line2   || "",
    shipping_city:        shipTo.city    || "",
    shipping_country:     shipTo.country || "",
    shipping_postal:      shipTo.postal  || "",
    shipping_region:      shipTo.state   || shipTo.region || "",
    line_count:           lineCount,
    items_total_minor:    row.subtotal_minor == null ? 0 : row.subtotal_minor,
    shipping_total_minor: row.shipping_minor == null ? 0 : row.shipping_minor,
    tax_total_minor:      row.tax_minor      == null ? 0 : row.tax_minor,
    discount_total_minor: row.discount_minor == null ? 0 : row.discount_minor,
    grand_total_minor:    row.grand_total_minor == null ? 0 : row.grand_total_minor,
    currency:             row.currency || "",
    payment_processor:    row.payment_processor   || "",
    payment_method_brand: row.payment_method_brand || "",
    payment_method_last4: row.payment_method_last4 || "",
    fulfillment_status:   row.fulfillment_status   || row.status || "",
    refund_total_minor:   row.refund_total_minor == null ? 0 : row.refund_total_minor,
    has_returns:          !!row.has_returns,
    has_chargebacks:      !!row.has_chargebacks,
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // order primitive handle is optional — the export reads directly
  // from the orders table via SQL. When supplied, it lets the caller
  // inject a test-tailored read path; otherwise the SQL below assumes
  // the canonical orders / order_lines schema.
  var order = opts.order || null;

  // Cursor encoding for export streams + scheduled-export pagination.
  // HMAC-tagged via b.pagination so an operator can't tamper one to
  // skip rows or replay across deployments.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("order-export.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "order-export-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;
  var EXPORT_ORDER_KEY = ["created_at:asc", "id:asc"];

  // Stream a single batch of orders inside the [from, to) range using
  // a (created_at, id) cursor for stable pagination. Joins are kept
  // narrow — we only pull the columns the projection consumes, even
  // when the operator subselects (so the wire-pull stays bounded by
  // the schema, not the filter).
  async function _readBatch(from, to, cursorVals, batchSize) {
    var sql, params;
    if (cursorVals) {
      sql = "SELECT * FROM orders WHERE created_at >= ?1 AND created_at < ?2 AND " +
            "(created_at > ?3 OR (created_at = ?3 AND id > ?4)) " +
            "ORDER BY created_at ASC, id ASC LIMIT ?5";
      params = [from, to, cursorVals[0], cursorVals[1], batchSize];
    } else {
      sql = "SELECT * FROM orders WHERE created_at >= ?1 AND created_at < ?2 " +
            "ORDER BY created_at ASC, id ASC LIMIT ?3";
      params = [from, to, batchSize];
    }
    var rows = (await query(sql, params)).rows;
    // Hydrate line_count on each row — the projection prefers a
    // pre-computed count over a fan-out per-row line fetch. The
    // single aggregate query stays cheap on an indexed FK.
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].line_count == null) {
        var c = await query(
          "SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?1",
          [rows[i].id],
        );
        rows[i].line_count = (c.rows[0] && (c.rows[0].n || c.rows[0]["COUNT(*)"])) || 0;
      }
    }
    return rows;
  }

  function _decodeCursor(cursor) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("order-export: cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(EXPORT_ORDER_KEY)) {
        throw new TypeError("order-export: cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("order-export: cursor — " + (e && e.message || "malformed"));
    }
  }

  // Async iterable for CSV. Yields the header on the first call,
  // then one row per database row. The cursor's next-page value is
  // accessible via the consumer-visible `_streamCursor` symbol on
  // the iterator — operators driving resumable downloads pull the
  // cursor after each chunk and persist it server-side.
  function _csvIterator(input) {
    input = input || {};
    _range(input.from, input.to);
    var columns  = _columns(input.columns);
    var batch    = _batchSize(input.batch_size);
    var cursor   = _decodeCursor(input.cursor);
    var includeBom = !!input.bom;
    var done     = false;
    var headerEmitted = false;

    return {
      [Symbol.asyncIterator]: function () { return this; },
      next: async function () {
        if (done) return { value: undefined, done: true };
        if (!headerEmitted) {
          headerEmitted = true;
          var headerLine = _csvRow(columns);
          if (includeBom) headerLine = "﻿" + headerLine;
          return { value: headerLine, done: false };
        }
        var rows = await _readBatch(input.from, input.to, cursor, batch);
        if (rows.length === 0) { done = true; return { value: undefined, done: true }; }
        var out = "";
        for (var i = 0; i < rows.length; i += 1) {
          var projected = _projectOrder(rows[i], { columns: columns });
          var cells = [];
          for (var j = 0; j < columns.length; j += 1) {
            cells.push(projected[columns[j]]);
          }
          out += _csvRow(cells);
        }
        var last = rows[rows.length - 1];
        cursor = [last.created_at, last.id];
        if (rows.length < batch) done = true;
        return { value: out, done: false };
      },
      // Expose the most-recently-consumed cursor for callers that
      // want to persist resumable progress between iterations. Not a
      // standard async-iterator hook; operator opts in.
      streamCursor: function () {
        if (!cursor) return null;
        return b.pagination.encodeCursor({
          orderKey: EXPORT_ORDER_KEY,
          vals:     cursor,
          forward:  true,
        }, cursorSecret);
      },
    };
  }

  function _ndjsonIterator(input) {
    input = input || {};
    _range(input.from, input.to);
    var columns  = _columns(input.columns);
    var batch    = _batchSize(input.batch_size);
    var cursor   = _decodeCursor(input.cursor);
    var done     = false;

    return {
      [Symbol.asyncIterator]: function () { return this; },
      next: async function () {
        if (done) return { value: undefined, done: true };
        var rows = await _readBatch(input.from, input.to, cursor, batch);
        if (rows.length === 0) { done = true; return { value: undefined, done: true }; }
        var out = "";
        for (var i = 0; i < rows.length; i += 1) {
          var projected = _projectOrder(rows[i], { columns: columns });
          var picked = {};
          for (var j = 0; j < columns.length; j += 1) {
            picked[columns[j]] = projected[columns[j]];
          }
          out += JSON.stringify(picked) + "\n";
        }
        var last = rows[rows.length - 1];
        cursor = [last.created_at, last.id];
        if (rows.length < batch) done = true;
        return { value: out, done: false };
      },
      streamCursor: function () {
        if (!cursor) return null;
        return b.pagination.encodeCursor({
          orderKey: EXPORT_ORDER_KEY,
          vals:     cursor,
          forward:  true,
        }, cursorSecret);
      },
    };
  }

  // Hydrate one row from scheduled_exports. Returns null on miss so
  // the HTTP handler can map cleanly to 404.
  async function _getExport(id) {
    var r = await query("SELECT * FROM scheduled_exports WHERE id = ?1", [id]);
    if (!r.rows.length) return null;
    return r.rows[0];
  }

  function _now() { return Date.now(); }

  return {
    COLUMN_ORDER:      COLUMN_ORDER,
    EXPORT_STATUSES:   EXPORT_STATUSES,
    FORMATS:           FORMATS,

    csvForRange:    _csvIterator,
    ndjsonForRange: _ndjsonIterator,

    summaryForRange: async function (input) {
      input = input || {};
      _range(input.from, input.to);
      // Single-pass aggregation. SQL does the heavy lifting so the
      // primitive doesn't have to materialize the row set on the JS
      // heap. Three queries: top-line totals, by-status, by-currency.
      var top = await query(
        "SELECT COUNT(*) AS order_count, " +
        "       COALESCE(SUM(grand_total_minor), 0) AS revenue_minor " +
        "FROM orders WHERE created_at >= ?1 AND created_at < ?2",
        [input.from, input.to],
      );
      var byStatus = await query(
        "SELECT status, COUNT(*) AS n, COALESCE(SUM(grand_total_minor), 0) AS revenue_minor " +
        "FROM orders WHERE created_at >= ?1 AND created_at < ?2 " +
        "GROUP BY status",
        [input.from, input.to],
      );
      var byCurrency = await query(
        "SELECT currency, COUNT(*) AS n, COALESCE(SUM(grand_total_minor), 0) AS revenue_minor " +
        "FROM orders WHERE created_at >= ?1 AND created_at < ?2 " +
        "GROUP BY currency",
        [input.from, input.to],
      );
      var orderCount   = (top.rows[0] && top.rows[0].order_count)   || 0;
      var revenueMinor = (top.rows[0] && top.rows[0].revenue_minor) || 0;
      var avg = orderCount > 0 ? Math.floor(revenueMinor / orderCount) : 0;
      var statusMap = {};
      for (var i = 0; i < byStatus.rows.length; i += 1) {
        var sr = byStatus.rows[i];
        statusMap[sr.status] = { count: sr.n, revenue_minor: sr.revenue_minor };
      }
      var currencyMap = {};
      for (var k = 0; k < byCurrency.rows.length; k += 1) {
        var cr = byCurrency.rows[k];
        currencyMap[cr.currency] = { count: cr.n, revenue_minor: cr.revenue_minor };
      }
      return {
        order_count:         orderCount,
        revenue_minor:       revenueMinor,
        average_order_minor: avg,
        by_status:           statusMap,
        by_currency:         currencyMap,
      };
    },

    scheduleExport: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("order-export.scheduleExport: input object required");
      }
      _format(input.format);
      _range(input.from, input.to);
      var columnsJson = null;
      if (input.columns != null) {
        // Validate against allowlist + persist the operator's
        // selection (not the COLUMN_ORDER projection — the worker
        // re-projects at run time).
        var picked = _columns(input.columns);
        columnsJson = JSON.stringify(picked);
      }
      var deliver = null;
      if (input.deliver_to_url != null) {
        if (typeof input.deliver_to_url !== "string" || !input.deliver_to_url.length) {
          throw new TypeError("order-export.scheduleExport: deliver_to_url must be a non-empty string");
        }
        deliver = input.deliver_to_url;
      }
      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO scheduled_exports (id, format, from_ts, to_ts, columns_json, " +
        "deliver_to_url, status, queued_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7)",
        [id, input.format, input.from, input.to, columnsJson, deliver, ts],
      );
      return await _getExport(id);
    },

    cancelExport: async function (exportId) {
      _id(exportId, "export_id");
      var row = await _getExport(exportId);
      if (!row) throw new TypeError("order-export.cancelExport: " + exportId + " not found");
      var fsm = _getExportFsm();
      var inst = fsm.restore({ state: row.status, history: [], context: {} });
      // Validate the legal edge with `can` — same edge + guard check as
      // transition() but side-effect-free (no state mutation, no audit
      // emit). We deliberately do NOT call transition() here: it emits a
      // "success" fsm.scheduled_export.transition audit event, and
      // emitting before the atomic claim below would record a phantom
      // success for a caller that then LOSES the race (the conditional
      // UPDATE matches zero rows). transition()'s real emit is deferred
      // to the winning branch.
      if (!inst.can("cancel")) {
        var err = new Error("order-export.cancelExport: refused — illegal edge 'cancel' from state '" + row.status + "'");
        err.code = "ORDER_EXPORT_CANCEL_REFUSED";
        throw err;
      }
      var ts = _now();
      // Atomic claim — the cross-instance serialization point. b.fsm
      // validated the edge IN MEMORY only (per-request instance, per-
      // instance lock), so two concurrent transitions (e.g. cancel racing
      // markExportRunning) both pass it; gating the write on the row STILL
      // being in the from-state we read makes the loser change 0 rows.
      var upd = await query(
        "UPDATE scheduled_exports SET status = 'cancelled', completed_at = ?1 " +
        "WHERE id = ?2 AND status = ?3",
        [ts, exportId, row.status],
      );
      if (!b.sql.casWon(upd).won) {
        var raced = new Error("order-export.cancelExport: " + exportId +
          " changed state concurrently (no longer " + row.status + ") — refused");
        raced.code = "ORDER_EXPORT_CANCEL_REFUSED";
        throw raced;
      }
      // Won the claim — drive the real transition so its audit event
      // fires exactly once, only for the writer that changed the row.
      // can() pre-validated the edge; transition()'s emit is drop-silent
      // and the row is already persisted, so its throw never reaches the
      // caller.
      try { await inst.transition("cancel", null); } catch (_emitErr) { /* audit emit best-effort */ }
      return await _getExport(exportId);
    },

    getExport: async function (exportId) {
      _id(exportId, "export_id");
      return await _getExport(exportId);
    },

    listExports: async function (listOpts) {
      listOpts = listOpts || {};
      var status = listOpts.status;
      if (status !== undefined && status !== null) {
        if (EXPORT_STATUSES.indexOf(status) === -1) {
          throw new TypeError("order-export.listExports: status must be one of " +
            EXPORT_STATUSES.join(", "));
        }
      }
      var limit = _limit(listOpts.limit);
      var sql, params;
      if (status !== undefined && status !== null) {
        sql = "SELECT * FROM scheduled_exports WHERE status = ?1 " +
              "ORDER BY queued_at DESC, id DESC LIMIT ?2";
        params = [status, limit];
      } else {
        sql = "SELECT * FROM scheduled_exports " +
              "ORDER BY queued_at DESC, id DESC LIMIT ?1";
        params = [limit];
      }
      var rows = (await query(sql, params)).rows;
      return { rows: rows };
    },

    markExportRunning: async function (exportId) {
      _id(exportId, "export_id");
      var row = await _getExport(exportId);
      if (!row) throw new TypeError("order-export.markExportRunning: " + exportId + " not found");
      var fsm = _getExportFsm();
      var inst = fsm.restore({ state: row.status, history: [], context: {} });
      // Validate with side-effect-free `can` (no audit emit); defer the
      // real transition() emit to the winning branch (see cancelExport).
      if (!inst.can("start")) {
        var err = new Error("order-export.markExportRunning: refused — illegal edge 'start' from state '" + row.status + "'");
        err.code = "ORDER_EXPORT_START_REFUSED";
        throw err;
      }
      var ts = _now();
      // Atomic claim (see cancelExport): gate on the observed from-state.
      var upd = await query(
        "UPDATE scheduled_exports SET status = 'running', started_at = ?1 " +
        "WHERE id = ?2 AND status = ?3",
        [ts, exportId, row.status],
      );
      if (!b.sql.casWon(upd).won) {
        var raced = new Error("order-export.markExportRunning: " + exportId +
          " changed state concurrently (no longer " + row.status + ") — refused");
        raced.code = "ORDER_EXPORT_START_REFUSED";
        throw raced;
      }
      // Won the claim — emit the real transition (see cancelExport).
      try { await inst.transition("start", null); } catch (_emitErr) { /* audit emit best-effort */ }
      return await _getExport(exportId);
    },

    markExportComplete: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("order-export.markExportComplete: input object required");
      }
      _id(input.export_id, "export_id");
      _nonNegInt(input.row_count, "row_count");
      _nonNegInt(input.byte_size, "byte_size");
      if (typeof input.file_sha3_512 !== "string" || !/^[0-9a-f]{128}$/i.test(input.file_sha3_512)) {
        throw new TypeError("order-export.markExportComplete: file_sha3_512 must be a 128-hex-char digest");
      }
      var row = await _getExport(input.export_id);
      if (!row) throw new TypeError("order-export.markExportComplete: " + input.export_id + " not found");
      var fsm = _getExportFsm();
      var inst = fsm.restore({ state: row.status, history: [], context: {} });
      // Validate with side-effect-free `can` (no audit emit); defer the
      // real transition() emit to the winning branch (see cancelExport).
      if (!inst.can("complete")) {
        var err = new Error("order-export.markExportComplete: refused — illegal edge 'complete' from state '" + row.status + "'");
        err.code = "ORDER_EXPORT_COMPLETE_REFUSED";
        throw err;
      }
      var ts = _now();
      // Atomic claim (see cancelExport): gate on the observed from-state.
      var upd = await query(
        "UPDATE scheduled_exports SET status = 'complete', row_count = ?1, " +
        "byte_size = ?2, file_sha3_512 = ?3, completed_at = ?4 WHERE id = ?5 AND status = ?6",
        [input.row_count, input.byte_size, input.file_sha3_512, ts, input.export_id, row.status],
      );
      if (!b.sql.casWon(upd).won) {
        var raced = new Error("order-export.markExportComplete: " + input.export_id +
          " changed state concurrently (no longer " + row.status + ") — refused");
        raced.code = "ORDER_EXPORT_COMPLETE_REFUSED";
        throw raced;
      }
      // Won the claim — emit the real transition (see cancelExport).
      try { await inst.transition("complete", null); } catch (_emitErr) { /* audit emit best-effort */ }
      return await _getExport(input.export_id);
    },

    markExportFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("order-export.markExportFailed: input object required");
      }
      _id(input.export_id, "export_id");
      if (typeof input.error !== "string" || !input.error.length) {
        throw new TypeError("order-export.markExportFailed: error must be a non-empty string");
      }
      // Cap the error text — operators store error blobs that
      // occasionally include a wrapped stack trace; bound the
      // persisted column so a runaway stack doesn't bloat the row.
      var errorText = input.error.length > 4000 ? input.error.slice(0, 4000) : input.error;
      var row = await _getExport(input.export_id);
      if (!row) throw new TypeError("order-export.markExportFailed: " + input.export_id + " not found");
      var fsm = _getExportFsm();
      var inst = fsm.restore({ state: row.status, history: [], context: {} });
      // Validate with side-effect-free `can` (no audit emit); defer the
      // real transition() emit to the winning branch (see cancelExport).
      if (!inst.can("fail")) {
        var err = new Error("order-export.markExportFailed: refused — illegal edge 'fail' from state '" + row.status + "'");
        err.code = "ORDER_EXPORT_FAIL_REFUSED";
        throw err;
      }
      var ts = _now();
      // Atomic claim (see cancelExport): gate on the observed from-state.
      var upd = await query(
        "UPDATE scheduled_exports SET status = 'failed', error = ?1, completed_at = ?2 " +
        "WHERE id = ?3 AND status = ?4",
        [errorText, ts, input.export_id, row.status],
      );
      if (!b.sql.casWon(upd).won) {
        var raced = new Error("order-export.markExportFailed: " + input.export_id +
          " changed state concurrently (no longer " + row.status + ") — refused");
        raced.code = "ORDER_EXPORT_FAIL_REFUSED";
        throw raced;
      }
      // Won the claim — emit the real transition (see cancelExport).
      try { await inst.transition("fail", null); } catch (_emitErr) { /* audit emit best-effort */ }
      return await _getExport(input.export_id);
    },

    // Exposed for the test suite so it can assert column semantics
    // without having to thread orders through a full DB round-trip.
    _projectOrder:      _projectOrder,
    _csvRow:            _csvRow,
    // Exposed only to keep the linter quiet about the unused `order`
    // binding when an integrator wires it later — the export reads
    // directly today, but the indirection is preserved.
    _order:             order,
  };
}

module.exports = {
  create:           create,
  COLUMN_ORDER:     COLUMN_ORDER,
  EXPORT_STATUSES:  EXPORT_STATUSES,
  FORMATS:          FORMATS,
  _getExportFsm:    _getExportFsm,
};
