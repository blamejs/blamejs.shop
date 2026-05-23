"use strict";
/**
 * @module shop.customerImport
 * @title  Customer bulk-import — CSV / NDJSON migration loader
 *
 * @intro
 *   Operators run this once during platform migration: a CSV or
 *   NDJSON export of customer rows from a prior storefront is fed
 *   through the primitive, which validates each row (email via
 *   `b.guardEmail` at strict profile, display_name shape, control-
 *   byte refusal), dedupes against the existing `customers` table by
 *   the SHA3-512 email_hash that the customers primitive already
 *   owns, and lands creates / updates per row. CSV cell content
 *   additionally runs through `b.guardCsv` strict profile — a
 *   formula-injection payload (`=cmd|...`, `+SUM(...)`,
 *   `WEBSERVICE(...)`) in a migrated row refuses the entire upload
 *   before any write.
 *
 *   `on_conflict` decides what happens when a row's email collides
 *   with an existing customer (the dedupe lookup is by email_hash,
 *   so canonical-equivalent addresses collide):
 *
 *     update — overwrite display_name on the existing row; the row
 *              counts as `updated`.
 *     skip   — leave the existing customer untouched; the row
 *              counts as `skipped`.
 *     error  — surface a row-error; counts as `errored`.
 *
 *   `dryRun(rows)` returns the per-row outcome breakdown WITHOUT
 *   writing — same shape as `importRows`. A real run of the same
 *   rows then reproduces the same outcome breakdown (modulo
 *   conflicts introduced by the writes themselves).
 *
 *   The factory writes a `customer_imports` run row per
 *   `importRows` / `importFromCsv` / `importFromNdjson` call so the
 *   operator console has a per-job audit trail. `cancelInflight()`
 *   flips the run row to `cancelled` and the driver stops consuming
 *   the input stream at its next iteration boundary.
 *
 *       var imp = bShop.customerImport.create({
 *         query:     externalDbD1Query,
 *         customers: bShop.customers.create({ query: externalDbD1Query }),
 *       });
 *       var report = await imp.importRows({
 *         rows:        [{ email: "a@example.com", display_name: "A" }, ...],
 *         on_conflict: "skip",
 *       });
 *       report.created;   report.updated;   report.skipped;   report.errored;
 *       report.errors;    // [{ row_index, message }, ...]
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var DEFAULT_MAX_ROWS     = 200000;
var DEFAULT_MAX_ERRORS   = 1000;
var SOURCES              = Object.freeze(["csv", "ndjson", "api"]);
var ON_CONFLICT_MODES    = Object.freeze(["update", "skip", "error"]);
var CSV_EXPECTED_HEADERS = Object.freeze(["email", "display_name"]);
var CONTROL_BYTE_RE      = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var MAX_DISPLAY_NAME_LEN = 128;

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.customers) {
    throw new TypeError("customer-import.create: opts.customers required (bShop.customers instance)");
  }
  var customers = opts.customers;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  var maxRows   = opts.maxRows   == null ? DEFAULT_MAX_ROWS   : opts.maxRows;
  var maxErrors = opts.maxErrors == null ? DEFAULT_MAX_ERRORS : opts.maxErrors;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new TypeError("customer-import.create: maxRows must be a positive integer");
  }
  if (!Number.isInteger(maxErrors) || maxErrors <= 0) {
    throw new TypeError("customer-import.create: maxErrors must be a positive integer");
  }

  // Per-factory run state. `inflight` tracks the currently-running
  // job so `cancelInflight()` knows what row id to flip. `lastReport`
  // exposes the most recently completed run's summary; it survives
  // until the next run starts.
  var state = {
    inflight:    null,   // { runId, cancelled: bool }
    lastReport:  null,
  };

  return {
    SOURCES:               SOURCES,
    ON_CONFLICT_MODES:     ON_CONFLICT_MODES,
    CSV_EXPECTED_HEADERS:  CSV_EXPECTED_HEADERS,

    dryRun: function (rows) {
      return _dryRun(customers, rows);
    },

    importRows: function (input) {
      return _importRows(query, customers, state, maxRows, maxErrors, input || {}, "api");
    },

    importFromCsv: function (stream) {
      return _importFromCsv(query, customers, state, maxRows, maxErrors, stream);
    },

    importFromNdjson: function (stream) {
      return _importFromNdjson(query, customers, state, maxRows, maxErrors, stream);
    },

    lastReport: function () { return state.lastReport; },

    cancelInflight: async function () {
      if (!state.inflight) return false;
      state.inflight.cancelled = true;
      var ts = Date.now();
      await query(
        "UPDATE customer_imports SET status = ?1, completed_at = ?2 " +
        "WHERE id = ?3 AND status = 'running'",
        ["cancelled", ts, state.inflight.runId],
      );
      return true;
    },
  };
}

// ---- validation helpers ------------------------------------------------

function _normalizeRow(raw, rowIndex) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("row " + rowIndex + ": must be a plain object with email + display_name");
  }
  var email = raw.email;
  var displayName = raw.display_name;
  if (typeof email !== "string" || !email.length) {
    throw new TypeError("row " + rowIndex + ": email must be a non-empty string");
  }
  if (typeof displayName !== "string" || !displayName.length) {
    throw new TypeError("row " + rowIndex + ": display_name must be a non-empty string");
  }
  if (displayName.length > MAX_DISPLAY_NAME_LEN) {
    throw new TypeError("row " + rowIndex + ": display_name must be <= " + MAX_DISPLAY_NAME_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(displayName)) {
    throw new TypeError("row " + rowIndex + ": display_name contains control bytes");
  }
  // guardEmail strict profile — refuses smuggling / header-injection /
  // multi-@ / mixed-script. The customers primitive will re-validate
  // at write time; we validate here so dryRun surfaces the same error
  // shape without touching the DB.
  var guardEmail = _b().guardEmail;
  var report;
  try {
    report = guardEmail.validate(email, { profile: "strict" });
  } catch (e) {
    throw new TypeError("row " + rowIndex + ": email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("row " + rowIndex + ": email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  return { email: email, display_name: displayName };
}

function _validateOnConflict(mode) {
  if (ON_CONFLICT_MODES.indexOf(mode) === -1) {
    throw new TypeError(
      "customer-import: on_conflict must be one of " + ON_CONFLICT_MODES.join(", ") +
      ", got " + JSON.stringify(mode)
    );
  }
}

function _addError(errors, maxErrors, rowIndex, message) {
  if (errors.length < maxErrors) {
    errors.push({ row_index: rowIndex, message: message });
  }
}

// ---- run-row persistence -----------------------------------------------

async function _openRun(query, state, source, inputByteCount) {
  var runId = _b().uuid.v7();
  var startedAt = Date.now();
  await query(
    "INSERT INTO customer_imports " +
    "(id, started_at, completed_at, status, source, input_byte_count, " +
    " rows_processed, rows_created, rows_updated, rows_skipped, rows_errored, errors_json) " +
    "VALUES (?1, ?2, NULL, 'running', ?3, ?4, 0, 0, 0, 0, 0, '[]')",
    [runId, startedAt, source, inputByteCount],
  );
  state.inflight = { runId: runId, cancelled: false };
  return { runId: runId, startedAt: startedAt };
}

async function _closeRun(query, state, runId, status, counters, errors) {
  var ts = Date.now();
  // The run might already be in `cancelled` — cancelInflight flips
  // it under us. Don't downgrade a cancelled run to complete; the
  // status column has a 4-value CHECK enum and the operator console
  // cares about the distinction.
  var current = (await query(
    "SELECT status FROM customer_imports WHERE id = ?1",
    [runId],
  )).rows[0];
  var finalStatus = (current && current.status === "cancelled") ? "cancelled" : status;
  var errorsJson = _b().safeJson.stringify(errors, { canonical: true });
  await query(
    "UPDATE customer_imports SET " +
    "  status = ?1, completed_at = ?2, " +
    "  rows_processed = ?3, rows_created = ?4, rows_updated = ?5, " +
    "  rows_skipped = ?6, rows_errored = ?7, errors_json = ?8 " +
    "WHERE id = ?9",
    [
      finalStatus, ts,
      counters.processed, counters.created, counters.updated,
      counters.skipped, counters.errored,
      errorsJson,
      runId,
    ],
  );
  state.inflight = null;
  return finalStatus;
}

// ---- dryRun ------------------------------------------------------------

async function _dryRun(customers, rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("customer-import.dryRun: rows must be an array");
  }
  var counters = { processed: 0, created: 0, updated: 0, skipped: 0, errored: 0 };
  var errors = [];
  var perRow = [];
  // Track hashes seen in THIS batch so two identical emails inside
  // the same dryRun input collide (the second is reported as a
  // would-be conflict). Mirrors what importRows sees once the first
  // row writes.
  var seenHashesThisRun = Object.create(null);

  for (var i = 0; i < rows.length; i += 1) {
    var rowIndex = i + 1;
    counters.processed += 1;
    try {
      var normalized = _normalizeRow(rows[i], rowIndex);
      var hash = customers.hashEmail(normalized.email);
      var existing = await customers.byEmailHash(hash);
      var outcome;
      if (existing || seenHashesThisRun[hash]) {
        // dryRun reports the conflict but doesn't pick an
        // on_conflict mode — the caller decides at import time. We
        // surface it as `would_conflict` so the operator sees how
        // many rows the on_conflict policy will branch on.
        outcome = "would_conflict";
      } else {
        outcome = "would_create";
        counters.created += 1;
        seenHashesThisRun[hash] = true;
      }
      perRow.push({ row_index: rowIndex, outcome: outcome, email_hash: hash });
    } catch (e) {
      counters.errored += 1;
      var msg = (e && e.message) || String(e);
      errors.push({ row_index: rowIndex, message: msg });
      perRow.push({ row_index: rowIndex, outcome: "error", message: msg });  // allow:non-canonical-audit-outcome — per-row operator-facing import result; not an audit.emit outcome (which uses the canonical success/failure/denied triple)
    }
  }
  // dryRun rolls `would_conflict` into `skipped` for the headline
  // counters — the caller can dig into `per_row` if they need the
  // distinction. This keeps the dryRun + importRows breakdown shapes
  // identical (created / updated / skipped / errored), which is the
  // contract the test pins.
  counters.skipped = perRow.filter(function (r) { return r.outcome === "would_conflict"; }).length;
  return {
    dry_run:   true,
    rows:      rows.length,
    processed: counters.processed,
    created:   counters.created,
    updated:   counters.updated,
    skipped:   counters.skipped,
    errored:   counters.errored,
    errors:    errors,
    per_row:   perRow,
  };
}

// ---- importRows --------------------------------------------------------

async function _importRows(query, customers, state, maxRows, maxErrors, input, source) {
  if (!input || typeof input !== "object") {
    throw new TypeError("customer-import.importRows: input object required");
  }
  if (!Array.isArray(input.rows)) {
    throw new TypeError("customer-import.importRows: input.rows must be an array");
  }
  if (input.rows.length > maxRows) {
    throw new TypeError("customer-import.importRows: rows exceeds maxRows (" + maxRows + ")");
  }
  var onConflict = input.on_conflict;
  _validateOnConflict(onConflict);

  // input byte count: rough JSON-stringify of the rows so the audit
  // row records something honest. Programmatic api callers don't
  // hand us a byte stream, but a canonical-JSON encode is a stable
  // size proxy.
  var inputByteCount;
  try {
    inputByteCount = Buffer.byteLength(_b().safeJson.stringify(input.rows, { canonical: true }), "utf8");
  } catch (_e) {
    inputByteCount = 0;
  }

  var run = await _openRun(query, state, source, inputByteCount);
  var counters = { processed: 0, created: 0, updated: 0, skipped: 0, errored: 0 };
  var errors = [];

  try {
    for (var i = 0; i < input.rows.length; i += 1) {
      if (state.inflight && state.inflight.cancelled) break;
      var rowIndex = i + 1;
      counters.processed += 1;
      try {
        var normalized = _normalizeRow(input.rows[i], rowIndex);
        var hash = customers.hashEmail(normalized.email);
        var existing = await customers.byEmailHash(hash);
        if (existing) {
          if (onConflict === "skip") {
            counters.skipped += 1;
          } else if (onConflict === "update") {
            await query(
              "UPDATE customers SET display_name = ?1, updated_at = ?2 WHERE id = ?3",
              [normalized.display_name, Date.now(), existing.id],
            );
            counters.updated += 1;
          } else {
            // "error" — surface as row-error, don't write.
            _addError(errors, maxErrors, rowIndex,
              "duplicate email_hash for existing customer");
            counters.errored += 1;
          }
        } else {
          await customers.register({
            email:        normalized.email,
            display_name: normalized.display_name,
          });
          counters.created += 1;
        }
      } catch (e) {
        _addError(errors, maxErrors, rowIndex, (e && e.message) || String(e));
        counters.errored += 1;
      }
    }
  } catch (driverErr) {
    // Non-row driver failure (DB went away, etc.) — flip the run to
    // failed with the error captured. Don't swallow.
    await _closeRun(query, state, run.runId, "failed", counters,
      errors.concat([{ row_index: 0, message: (driverErr && driverErr.message) || String(driverErr) }]));
    throw driverErr;
  }

  var finalStatus = await _closeRun(query, state, run.runId, "complete", counters, errors);
  var report = {
    run_id:    run.runId,
    status:    finalStatus,
    source:    source,
    rows:      input.rows.length,
    processed: counters.processed,
    created:   counters.created,
    updated:   counters.updated,
    skipped:   counters.skipped,
    errored:   counters.errored,
    errors:    errors,
  };
  state.lastReport = report;
  return report;
}

// ---- importFromCsv -----------------------------------------------------

async function _importFromCsv(query, customers, state, maxRows, maxErrors, stream) {
  if (stream === undefined || stream === null) {
    throw new TypeError("customer-import.importFromCsv: stream required (string, Buffer, Uint8Array, or async-iterable)");
  }
  var input = await _drainToString(stream);
  var byteLen = Buffer.byteLength(input, "utf8");

  // Content-safety gate: refuse formula-injection / bidi / control
  // bytes in any cell BEFORE we parse the records. Strict profile
  // refuses rather than sanitizing — the importer would otherwise
  // silently smuggle the payload into a customer record.
  var guardRv = _b().guardCsv.validate(input, { profile: "strict" });
  if (!guardRv.ok) {
    var kinds = guardRv.issues.map(function (i) { return i.kind || i.ruleId || "issue"; });
    throw new TypeError(
      "customer-import.importFromCsv: csv refused by content-safety guard — " + kinds.join(", ")
    );
  }

  var records;
  try {
    records = _b().csv.parse(input, { header: true, maxRows: maxRows + 1 });
  } catch (e) {
    throw new TypeError("customer-import.importFromCsv: csv parse failed — " + (e && e.message || "malformed"));
  }
  if (!records.length) {
    throw new TypeError("customer-import.importFromCsv: csv contained no data rows");
  }
  // header validation — first record's keys must match expected.
  var keys = Object.keys(records[0]);
  for (var i = 0; i < CSV_EXPECTED_HEADERS.length; i += 1) {
    if (keys.indexOf(CSV_EXPECTED_HEADERS[i]) === -1) {
      throw new TypeError(
        "customer-import.importFromCsv: csv missing required column " +
        JSON.stringify(CSV_EXPECTED_HEADERS[i]) +
        " (expected columns: " + CSV_EXPECTED_HEADERS.join(", ") + ")"
      );
    }
  }
  if (records.length > maxRows) {
    throw new TypeError("customer-import.importFromCsv: csv exceeds maxRows (" + maxRows + ")");
  }
  // Build the row list with just the expected fields — extra columns
  // are tolerated but ignored.
  var rows = records.map(function (r) {
    return { email: r.email, display_name: r.display_name };
  });

  return await _runFromSource(query, customers, state, maxRows, maxErrors,
    { rows: rows, on_conflict: "skip" }, "csv", byteLen);
}

// ---- importFromNdjson --------------------------------------------------

async function _importFromNdjson(query, customers, state, maxRows, maxErrors, stream) {
  if (stream === undefined || stream === null) {
    throw new TypeError("customer-import.importFromNdjson: stream required");
  }
  var input = await _drainToString(stream);
  var byteLen = Buffer.byteLength(input, "utf8");

  // NDJSON: one JSON object per line. Blank lines tolerated.
  // Records get parsed through b.safeJson.parse — the strict default
  // refuses oversize / proto-pollution / depth-overflow before the
  // row hits the importer.
  var lines = input.split(/\r?\n/);
  var rows = [];
  var lineErrors = Object.create(null);
  var anyNonBlank = false;
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (!line.length) continue;
    anyNonBlank = true;
    try {
      var obj = _b().safeJson.parse(line);
      rows.push(obj);
    } catch (e) {
      // We surface NDJSON parse errors as row-errors keyed off the
      // row index (1-based, post-blank-stripping). The placeholder
      // null pushes into rows so the normalizer flags it later with
      // a more specific message via lineErrors lookup.
      lineErrors[rows.length + 1] = (e && e.message) || String(e);
      rows.push(null);
    }
  }
  if (!anyNonBlank) {
    throw new TypeError("customer-import.importFromNdjson: stream contained no data rows");
  }
  if (rows.length > maxRows) {
    throw new TypeError("customer-import.importFromNdjson: rows exceeds maxRows (" + maxRows + ")");
  }

  var report = await _runFromSource(query, customers, state, maxRows, maxErrors,
    { rows: rows, on_conflict: "skip" }, "ndjson", byteLen);

  // Substitute the precise JSON-parse error message for the generic
  // "must be a plain object" entry the normalizer produced for null
  // placeholders. Same row_index either way.
  if (Object.keys(lineErrors).length) {
    report.errors = report.errors.map(function (e) {
      if (lineErrors[e.row_index]) {
        return { row_index: e.row_index, message: lineErrors[e.row_index] };
      }
      return e;
    });
  }
  return report;
}

// ---- shared driver -----------------------------------------------------

async function _runFromSource(query, customers, state, maxRows, maxErrors, input, source, byteLen) {
  _validateOnConflict(input.on_conflict);
  var run = await _openRun(query, state, source, byteLen);
  var counters = { processed: 0, created: 0, updated: 0, skipped: 0, errored: 0 };
  var errors = [];

  try {
    for (var i = 0; i < input.rows.length; i += 1) {
      if (state.inflight && state.inflight.cancelled) break;
      var rowIndex = i + 1;
      counters.processed += 1;
      try {
        var normalized = _normalizeRow(input.rows[i], rowIndex);
        var hash = customers.hashEmail(normalized.email);
        var existing = await customers.byEmailHash(hash);
        if (existing) {
          if (input.on_conflict === "skip") {
            counters.skipped += 1;
          } else if (input.on_conflict === "update") {
            await query(
              "UPDATE customers SET display_name = ?1, updated_at = ?2 WHERE id = ?3",
              [normalized.display_name, Date.now(), existing.id],
            );
            counters.updated += 1;
          } else {
            _addError(errors, maxErrors, rowIndex, "duplicate email_hash for existing customer");
            counters.errored += 1;
          }
        } else {
          await customers.register({
            email:        normalized.email,
            display_name: normalized.display_name,
          });
          counters.created += 1;
        }
      } catch (e) {
        _addError(errors, maxErrors, rowIndex, (e && e.message) || String(e));
        counters.errored += 1;
      }
    }
  } catch (driverErr) {
    await _closeRun(query, state, run.runId, "failed", counters,
      errors.concat([{ row_index: 0, message: (driverErr && driverErr.message) || String(driverErr) }]));
    throw driverErr;
  }

  var finalStatus = await _closeRun(query, state, run.runId, "complete", counters, errors);
  var report = {
    run_id:    run.runId,
    status:    finalStatus,
    source:    source,
    rows:      input.rows.length,
    processed: counters.processed,
    created:   counters.created,
    updated:   counters.updated,
    skipped:   counters.skipped,
    errored:   counters.errored,
    errors:    errors,
  };
  state.lastReport = report;
  return report;
}

// ---- stream → string ---------------------------------------------------

async function _drainToString(input) {
  if (typeof input === "string") return input;
  if (Buffer.isBuffer(input)) return input.toString("utf8");
  if (input instanceof Uint8Array) return Buffer.from(input).toString("utf8");
  // async-iterable (a Node Readable stream is async-iterable; an
  // operator-provided AsyncGenerator also qualifies). Concatenate
  // every chunk; chunks may be Buffer | Uint8Array | string.
  if (input && typeof input[Symbol.asyncIterator] === "function") {
    var parts = [];
    for await (var chunk of input) {
      if (typeof chunk === "string") parts.push(Buffer.from(chunk, "utf8"));
      else if (Buffer.isBuffer(chunk)) parts.push(chunk);
      else if (chunk instanceof Uint8Array) parts.push(Buffer.from(chunk));
      else throw new TypeError("customer-import: stream chunk must be string, Buffer, or Uint8Array");
    }
    return Buffer.concat(parts).toString("utf8");
  }
  throw new TypeError("customer-import: stream must be string, Buffer, Uint8Array, or async-iterable");
}

module.exports = {
  create:                create,
  SOURCES:               SOURCES,
  ON_CONFLICT_MODES:     ON_CONFLICT_MODES,
  CSV_EXPECTED_HEADERS:  CSV_EXPECTED_HEADERS,
  DEFAULT_MAX_ROWS:      DEFAULT_MAX_ROWS,
  DEFAULT_MAX_ERRORS:    DEFAULT_MAX_ERRORS,
  MAX_DISPLAY_NAME_LEN:  MAX_DISPLAY_NAME_LEN,
};
