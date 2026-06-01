"use strict";
/**
 * Public catalog API error scrubbing — the unauthenticated
 * GET /api/catalog/products[/:slug] error mapper (server.js
 * _problemFromError) must NOT echo a raw DB/error string on a 5xx.
 *
 * The shop D1 layer (lib/externaldb-d1.js) wraps the upstream string
 * into err.message ("externaldbD1: query failed — UNIQUE constraint
 * failed: products.slug"). The vendored b.problemDetails.fromError
 * copies err.message verbatim into the problem `detail`, so a storage
 * fault on these public routes used to leak SQLite internals to an
 * anonymous caller — the same class the admin side fixed (lib/admin.js
 * _safeNotice).
 *
 * This drives the REAL exported _problemFromError against a minimal
 * mock response and asserts:
 *
 *   - a DB-layer Error (non-TypeError) → 500 application/problem+json
 *     whose `detail` is the GENERIC message, with the raw constraint
 *     string ABSENT from the body;
 *   - a TypeError (client-shape validation) → 400 with its validation
 *     message intact (the 400 behavior is unchanged);
 *   - a plain non-TypeError Error → still 500-generic (no leak).
 *
 * Network: zero — operates on the pure function + a mock res.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var server  = require("../../server");
var helpers = require("../helpers");
var check   = helpers.check;

// Minimal mock response — b.problemDetails.respond/send need setHeader +
// end + a writable statusCode. Captures everything for assertions.
function _mockRes() {
  return {
    statusCode: 200,
    _headers:   {},
    _body:      null,
    setHeader:  function (k, v) { this._headers[String(k).toLowerCase()] = v; },
    end:        function (b) { this._body = b == null ? "" : String(b); },
  };
}

function _run() {
  // ---- (1) DB-layer error (non-TypeError) → 500 generic, no leak ----
  // The exact shape lib/externaldb-d1.js throws on a failed query.
  var dbErr = new Error("externaldbD1: query failed — UNIQUE constraint failed: products.slug");
  dbErr.code = "D1_QUERY_FAILED";
  var res1 = _mockRes();
  server._problemFromError(res1, dbErr);

  check("db-error → 500", res1.statusCode === 500);
  check("db-error → application/problem+json",
    String(res1._headers["content-type"] || "").indexOf("application/problem+json") === 0);

  var doc1 = JSON.parse(res1._body);
  check("db-error detail is the generic message",
    doc1.detail === "Something went wrong — please try again.");
  // The load-bearing assertion: the raw DB/constraint string is ABSENT
  // from the serialized body the anonymous caller receives.
  check("db-error body omits the raw 'constraint failed' string",
    res1._body.indexOf("constraint failed") === -1);
  check("db-error body omits the table/column name",
    res1._body.indexOf("products.slug") === -1);
  check("db-error body omits the 'query failed' wrapper",
    res1._body.indexOf("query failed") === -1);

  // ---- (2) TypeError → 400 with its validation message intact ----
  // _uuid / list validators throw a TypeError whose message is
  // operator-safe (no storage internals); the 400 path is unchanged.
  var validationErr = new TypeError("catalog: limit must be a positive integer");
  var res2 = _mockRes();
  server._problemFromError(res2, validationErr);

  check("TypeError → 400", res2.statusCode === 400);
  var doc2 = JSON.parse(res2._body);
  check("TypeError detail surfaces the validation message",
    doc2.detail === "catalog: limit must be a positive integer");

  // ---- (3) a plain non-TypeError Error → still 500 generic ----
  var plainErr = new Error("Cannot read properties of undefined (reading 'rows')");
  var res3 = _mockRes();
  server._problemFromError(res3, plainErr);

  check("plain error → 500", res3.statusCode === 500);
  var doc3 = JSON.parse(res3._body);
  check("plain error detail is the generic message",
    doc3.detail === "Something went wrong — please try again.");
  check("plain error body omits the raw message",
    res3._body.indexOf("Cannot read properties") === -1);
}

module.exports = { run: _run };
