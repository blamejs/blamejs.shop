"use strict";
/**
 * @module shop.externaldbD1
 * @title  External-DB adapter — Cloudflare D1
 *
 * @intro
 *   Adapter that lets `b.externalDb` target a Cloudflare D1 database
 *   from a Node container. D1 is HTTP-accessed (no TCP), so the
 *   adapter wraps `fetch()` rather than a binary driver — which means
 *   no npm runtime dependency and no vendored client bundle. Two
 *   operating modes:
 *
 *   1. **service-binding** (recommended for Cloudflare Containers):
 *      the container reaches a sibling Worker over a service binding;
 *      the Worker holds the D1 binding and executes the query. The
 *      adapter calls `<bridgeUrl><bridgePath>` with a shared-secret
 *      header. Latency is sub-millisecond plus D1 itself, and no D1
 *      API token ever lives in the container.
 *
 *   2. **rest-api** (for non-Cloudflare deployments that still want
 *      to read from D1 — e.g. a development environment): hits
 *      `https://api.cloudflare.com/client/v4/accounts/<acc>/d1/
 *      database/<db>/query` with an API token in the Authorization
 *      header.
 *
 *   The factory returns the four-field shape `b.externalDb.init`
 *   expects: `{ dialect: "sqlite", connect, query, close }`. Plug it
 *   in as a backend:
 *
 *       var b = require("./lib/vendor/blamejs");
 *       var d1 = require("./lib/externaldb-d1").create({
 *         mode:         "service-binding",
 *         bridgeUrl:    process.env.D1_BRIDGE_URL,    // e.g. http://shop-worker
 *         bridgePath:   "/_/db/query",
 *         bridgeSecret: process.env.D1_BRIDGE_SECRET,
 *       });
 *       b.externalDb.init({ backends: { main: d1 } });
 *
 *   D1 SQL dialect is SQLite — `?1, ?2, ...` parameter placeholders,
 *   no JSONB, no advisory locks. The adapter normalizes both modes'
 *   result shapes into `{ rows, rowCount, lastRowId? }` so downstream
 *   primitives don't see the wire-shape difference.
 */

var b = require("./vendor/blamejs");

var DEFAULT_TIMEOUT_MS = 10000;
var DEFAULT_BRIDGE_PATH = "/_/db/query";
var MAX_RETRY = 2;
var RETRY_BACKOFF_MS = 200;

// SQLite parameter placeholders are `?1, ?2, ...`. Any `?` not
// followed by a digit is a SQLite "auto-numbered" placeholder which
// the D1 driver also accepts; we leave SQL untouched and pass the
// params array through. Operators write SQL with explicit indices in
// new code so re-ordering params in a statement update doesn't
// silently re-map.
function _validateOpts(opts) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("externaldbD1.create({ opts }) — opts must be an object");
  }
  var mode = opts.mode || "service-binding";
  if (mode !== "service-binding" && mode !== "rest-api") {
    throw new TypeError("externaldbD1.create — mode must be 'service-binding' or 'rest-api', got " + JSON.stringify(opts.mode));
  }
  if (mode === "service-binding") {
    if (typeof opts.bridgeUrl !== "string" || !opts.bridgeUrl.length) {
      throw new TypeError("externaldbD1.create — service-binding mode requires bridgeUrl");
    }
    if (typeof opts.bridgeSecret !== "string" || !opts.bridgeSecret.length) {
      throw new TypeError("externaldbD1.create — service-binding mode requires bridgeSecret");
    }
  } else {
    if (typeof opts.accountId !== "string" || !opts.accountId.length) {
      throw new TypeError("externaldbD1.create — rest-api mode requires accountId");
    }
    if (typeof opts.databaseId !== "string" || !opts.databaseId.length) {
      throw new TypeError("externaldbD1.create — rest-api mode requires databaseId");
    }
    if (typeof opts.apiToken !== "string" || !opts.apiToken.length) {
      throw new TypeError("externaldbD1.create — rest-api mode requires apiToken");
    }
  }
  if (opts.timeoutMs !== undefined && (typeof opts.timeoutMs !== "number" || !isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) { // allow:inline-optional-positive-finite-validation — the TypeError message must literally contain "timeoutMs" so the test contract (`assert.throws(..., /timeoutMs/)`) sees the labelled field; the framework helper threads the label through a `code`-first FrameworkError shape, so a plain `TypeError` constructor renders the code as the message instead
    throw new TypeError("externaldbD1.create — timeoutMs must be a positive number");
  }
  if (opts.fetch !== undefined && typeof opts.fetch !== "function") { // allow:inline-optional-function-validation — same TypeError-message contract as the timeoutMs guard above
    throw new TypeError("externaldbD1.create — fetch override must be a function");
  }
}

function _isWriteSql(sql) {
  // Classification used only to pick D1's `run` vs `all` execution
  // mode in the Worker bridge. Strips leading whitespace + line
  // comments + block comments before peeking at the verb.
  var s = String(sql || "").replace(/^\s+|^\/\*[\s\S]*?\*\/|^--[^\n]*\n/g, "").trimStart();
  var verb = (s.match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
  return verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "CREATE" || verb === "DROP" || verb === "ALTER" || verb === "REPLACE";
}

// Per-query deadline. b.safeAsync.withTimeoutSignal returns an AbortSignal
// that fires after `ms`, which is what fetch already takes.
//
// This replaced a hand-rolled AbortController whose setTimeout was only
// cleared by a `finish()` nobody ever called: every query left a pending
// timer behind, and a pending timer is ref'd, so it kept the event loop
// awake until it fired. On a query path this busy that is a standing
// population of live timers and a shutdown that cannot settle until the last
// one expires. The signal the primitive returns does not hold the loop open.
function _timeoutSignal(ms) {
  return b.safeAsync.withTimeoutSignal(null, ms);
}

// A deadline reached through AbortSignal.timeout rejects with a DOMException
// named TimeoutError, NOT AbortError — so a handler that recognises only the
// latter stops producing D1_TIMEOUT and reports a transport failure instead.
// Both names map here; the only abort wired to these dials is the deadline.
function _isTimeoutAbort(e) {
  return !!e && (e.name === "TimeoutError" || e.name === "AbortError");
}

function _timeoutErr(ms, label) {
  var e = new Error("externaldbD1: " + label + " timed out after " + ms + "ms");
  e.code = "D1_TIMEOUT";
  return e;
}

// The attempt loop is b.retry.withRetry — exponential backoff, jitter, and
// the final rethrow — with two things this adapter has to supply.
//
// The classifier is ours. The framework's default reads `err.code` and
// `err.statusCode` off the error itself, and undici does not put them there:
// a transport failure arrives as TypeError("fetch failed") carrying the real
// code on `.cause`. Its retryable set also omits EAI_AGAIN and UND_ERR_SOCKET,
// which are precisely the DNS and socket failures this adapter exists to ride
// out. Handing it the default classifier would leave the loop in place and
// silently stop retrying anything that matters.
//
// The HTTP arm has to throw to be seen at all. b.httpClient and fetch both
// resolve a 5xx as an ordinary response, so a retryable status is raised
// inside the attempt and the response handed back at the boundary once the
// retries are spent — the caller still inspects `res.status` itself.
async function _retryingFetch(fetchImpl, url, init, attempts, label) {
  var received = null;
  return b.retry.withRetry(async function () {
    var res = await fetchImpl(url, init);
    received = res;
    // Retry only on 5xx / 429; a 4xx is the request's own fault.
    if (res.status >= 500 || res.status === 429) throw _httpErr(res.status, label);
    return res;
  }, {
    maxAttempts: attempts + 1,          // `attempts` counts RETRIES, not tries
    baseDelayMs: RETRY_BACKOFF_MS,
    isRetryable: _isTransient,
  }).catch(function (e) {
    // Retries exhausted on a status we did receive: give the caller the
    // response so it reports the upstream's own error, exactly as the previous
    // loop did. A transport failure has no response and propagates.
    if (received && e && e.status === received.status) return received;
    throw e;
  });
}

// Which failures are worth another attempt. Both arms matter and neither is
// what the framework's default classifier looks at.
//
// Transport: undici reports a network failure as TypeError("fetch failed")
// with the real code nested on `.cause`, so the code is read from either
// place. EAI_AGAIN (transient DNS) and UND_ERR_SOCKET (socket torn down
// mid-request) are the two this adapter most needs and the two the framework's
// set leaves out.
//
// HTTP: a 5xx or 429 is raised as an error inside the attempt so the loop can
// see it at all — fetch resolves those as ordinary responses. `_httpErr`
// records the status on `.status`, so that is what is read here. A 4xx is the
// request's own fault and is never retried.
function _isTransient(err) {
  if (!err) return false;
  if (typeof err.status === "number") return err.status >= 500 || err.status === 429;
  var c = err.code || (err.cause && err.cause.code);
  return c === "ECONNRESET" || c === "ETIMEDOUT" || c === "ENOTFOUND" || c === "EAI_AGAIN" || c === "UND_ERR_SOCKET";
}

function _httpErr(status, label) {
  var e = new Error("externaldbD1: " + label + " failed with HTTP " + status);
  e.code = "D1_HTTP_" + status;
  e.status = status;
  return e;
}

// ---- mode: service-binding -----------------------------------------------

function _serviceBindingQuery(opts) {
  // Trailing-slash trim as a loop, not `/\/+$/` — the regex shape is
  // superlinear on long runs of '/' and this value is library input.
  var base = opts.bridgeUrl;
  while (base.charCodeAt(base.length - 1) === 47) base = base.slice(0, -1);
  var url = base + (opts.bridgePath || DEFAULT_BRIDGE_PATH);
  var secret = opts.bridgeSecret;
  var fetchImpl = opts.fetch || globalThis.fetch;
  var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (typeof fetchImpl !== "function") {
    throw new Error("externaldbD1: global fetch unavailable — pass opts.fetch explicitly");
  }
  return async function (_client, sql, params) {
    var mode = _isWriteSql(sql) ? "run" : "all";
    var body = JSON.stringify({ sql: sql, params: params || [], mode: mode });
    var tsig = _timeoutSignal(timeoutMs);
    var res;
    try {
      res = await _retryingFetch(fetchImpl, url, {
        method: "POST",
        headers: {
          "content-type":        "application/json",
          "x-d1-bridge-secret":  secret,
          "accept":               "application/json",
        },
        body:   body,
        signal: tsig,
      }, MAX_RETRY, "service-binding query");
    } catch (e) {
      if (_isTimeoutAbort(e)) throw _timeoutErr(timeoutMs, "service-binding query");
      throw e;
    }
    if (!res.ok) throw _httpErr(res.status, "service-binding query");
    var json = await res.json();
    if (!json || json.ok === false) {
      var err = new Error("externaldbD1: query failed — " + (json && json.error || "unknown") + (json && json.message ? ": " + json.message : ""));
      err.code = (json && json.error) || "D1_QUERY_FAILED";
      throw err;
    }
    return {
      rows:      json.rows || [],
      rowCount:  typeof json.rowCount === "number" ? json.rowCount : (json.rows ? json.rows.length : 0),
      lastRowId: json.lastRowId != null ? json.lastRowId : null,
    };
  };
}

// ---- mode: rest-api ------------------------------------------------------

function _restApiQuery(opts) {
  var url = "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(opts.accountId) +
            "/d1/database/" + encodeURIComponent(opts.databaseId) + "/query";
  var token = opts.apiToken;
  var fetchImpl = opts.fetch || globalThis.fetch;
  var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (typeof fetchImpl !== "function") {
    throw new Error("externaldbD1: global fetch unavailable — pass opts.fetch explicitly");
  }
  return async function (_client, sql, params) {
    var body = JSON.stringify({ sql: sql, params: params || [] });
    var tsig = _timeoutSignal(timeoutMs);
    var res;
    try {
      res = await _retryingFetch(fetchImpl, url, {
        method: "POST",
        headers: {
          "authorization": "Bearer " + token,
          "content-type":  "application/json",
          "accept":         "application/json",
        },
        body:   body,
        signal: tsig,
      }, MAX_RETRY, "rest-api query");
    } catch (e) {
      if (_isTimeoutAbort(e)) throw _timeoutErr(timeoutMs, "rest-api query");
      throw e;
    }
    if (!res.ok) throw _httpErr(res.status, "rest-api query");
    var json = await res.json();
    if (!json || json.success !== true) {
      var firstErr = json && Array.isArray(json.errors) && json.errors[0];
      var err = new Error("externaldbD1: rest-api query failed — " + (firstErr && firstErr.message || "unknown"));
      err.code = firstErr && firstErr.code ? "D1_REST_" + firstErr.code : "D1_REST_QUERY_FAILED";
      throw err;
    }
    // The /query endpoint returns `result: [{ results, meta, success }]`.
    var first = json.result && json.result[0];
    var rows = (first && first.results) || [];
    return {
      rows:      rows,
      rowCount:  typeof (first && first.meta && first.meta.changes) === "number" ? first.meta.changes : rows.length,
      lastRowId: (first && first.meta && first.meta.last_row_id) || null,
    };
  };
}

// ---- factory -------------------------------------------------------------

function create(opts) {
  _validateOpts(opts);
  var queryFn = opts.mode === "rest-api" ? _restApiQuery(opts) : _serviceBindingQuery(opts);
  var sentinelClient = Object.freeze({ kind: "d1-adapter-sentinel" });
  return {
    dialect: "sqlite",
    connect: async function () {
      // D1 has no per-connection state; the adapter returns a frozen
      // sentinel so the pool layer above can still track checkouts.
      return sentinelClient;
    },
    query: queryFn,
    close: async function (_client) {
      // Nothing to close — every query is an independent HTTP call.
    },
  };
}

module.exports = { create: create };
