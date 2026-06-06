"use strict";
/**
 * Shared test helpers. Re-exported for one-import ergonomics in
 * every `*.test.js` file.
 *
 * The header-line discipline is the same one blamejs uses:
 * `helpers.waitUntil(predicate)` for any test that waits on an
 * observable condition. `setTimeout(r, N)` as a sleep is forbidden
 * — fast platforms finish in milliseconds, contended platforms get
 * the full 5-second budget, no test is brittle across runner
 * generations.
 */

var assert   = require("node:assert");
var http     = require("node:http");
var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var _checks = 0;

function check(label, condition) {
  _checks += 1;
  if (!condition) {
    throw new Error("FAIL: " + label);
  }
}

function getChecks() { return _checks; }

// Poll `predicate` every 25ms until it returns truthy. Throws after
// the budget elapses. Use this anywhere a test waits on an async
// event — queue drain, fs watch delivery, mock-collector receive,
// retry-exhaustion drop. NEVER use `await new Promise(r =>
// setTimeout(r, N))` as a sleep; there is no good N for that
// pattern, and every release that adds a fixed-budget sleep grows
// the smoke flake surface.
async function waitUntil(predicate, opts) {
  opts = opts || {};
  var timeoutMs  = opts.timeoutMs  || 5000;
  var intervalMs = opts.intervalMs || 25;
  var label      = opts.label      || "(unlabeled)";
  var deadline   = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var ok = await predicate();
    if (ok) return ok;
    await new Promise(function (r) { setTimeout(r, intervalMs); });   // allow:test-promise-settimeout-sleep — the polling step itself, not a sleep-as-wait
  }
  throw new Error("waitUntil timeout: " + label + " (after " + timeoutMs + "ms)");
}

async function waitUntilEqual(getter, expected, opts) {
  return waitUntil(async function () {
    var actual = await getter();
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, opts);
}

// Per-test wall-clock ceiling for real-time-dependent test bodies
// (stream.pipeline rate tests, throttle/backpressure paths). Races the
// body against a timer so a hang surfaces as `test timed out: <label>`
// in seconds instead of an opaque stuck job that eats the CI runner's
// full timeout. The timer is cleared on settle and unref'd so a passing
// body never holds the process open.
async function withTestTimeout(label, fn, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || 30000;
  var timer = null;
  var ceiling = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error("test timed out: " + label + " (after " + timeoutMs + "ms)"));
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([fn(), ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- in-memory D1 query (layer-1 SQL fixtures) -------------------------
//
// A `{ rows, rowCount }` async query backed by an in-memory node:sqlite
// database loaded from one or more real D1 migration files. The same
// SQL the live D1 bridge sees runs here, so every CHECK / UNIQUE / FK
// declared in the schema is exercised end-to-end and a shipped
// statement that breaks the schema surfaces in the test, not the live
// hop. This is the shared form catalog.test.js, catalog-batch.test.js,
// and search-decorate-parity.test.js all use — pass the migration file
// paths the fixture needs (e.g. `0001_catalog.sql`, `0043_collections.sql`).
//
// Returns `{ query, db }`: `query(sql, params)` is the catalog/primitive
// `create({ query })` handle; `db` is the raw DatabaseSync handle for a
// test that needs a D1-style `prepare().bind().all()` shim over the same
// data (the edge↔container parity tests build that shim off `db`).

// Split a migration file on bare `;` (outside comments) so each
// statement runs via prepare().run() — mirrors how D1 receives
// statements over the Worker bridge (one prepared statement at a time).
function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// `opts.tolerant` loads best-effort: a statement node:sqlite can't
// prepare (the occasional D1-flavoured construct) is counted — and
// reported through `opts.onSkippedStatement(path, err)` when supplied —
// instead of throwing. That's the full-schema mode (`allMigrationPaths()`)
// the audit harness and the bridge-backed boot test run on; targeted
// fixtures keep the strict default so a schema break in the migrations
// they pin still fails loudly.
function memD1Query(migrationPaths, opts) {
  opts = opts || {};
  var paths = Array.isArray(migrationPaths) ? migrationPaths : [migrationPaths];
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  var skippedStatements = 0;
  for (var p = 0; p < paths.length; p += 1) {
    var schema = nodeFs.readFileSync(paths[p], "utf8");
    var stmts = _splitSchema(schema);
    for (var i = 0; i < stmts.length; i += 1) {
      if (!opts.tolerant) { db.prepare(stmts[i]).run(); continue; }
      try { db.prepare(stmts[i]).run(); }
      catch (e) {
        skippedStatements += 1;
        if (typeof opts.onSkippedStatement === "function") opts.onSkippedStatement(paths[p], e);
      }
    }
  }
  function query(sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return Promise.resolve({
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      });
    }
    var rows = stmt.all.apply(stmt, params || []);
    return Promise.resolve({ rows: rows, rowCount: rows.length });
  }
  return { query: query, db: db, skippedStatements: skippedStatements };
}

// Every migration in migrations-d1/, numeric order — the full-schema
// list. `memD1Query(allMigrationPaths(), { tolerant: true })` stands the
// whole shop schema up in memory.
function allMigrationPaths() {
  var dir = nodePath.resolve(__dirname, "..", "..", "migrations-d1");
  return nodeFs.readdirSync(dir)
    .filter(function (n) { return /^\d+.*\.sql$/.test(n); })
    .sort()
    .map(function (n) { return nodePath.join(dir, n); });
}

// ---- loopback D1-bridge stub (layer-2 full-composition boots) -----------
//
// A node:http stand-in for the Worker's `POST /_/db/query` SQL bridge,
// speaking the exact wire shape worker/index.js serves: the
// `x-d1-bridge-secret` header gate, a `{ sql, params, mode }` JSON body,
// and a `{ ok, rows, rowCount, lastRowId }` reply ("run" mode returns no
// rows). Backed by a `memD1Query(...).query` handle, so the data both
// sides see lives in one in-memory database the test can also inspect
// directly. The point: server.js gates its ENTIRE catalog + cart +
// storefront + admin composition on D1_BRIDGE_URL/SECRET — without a
// bridge the boot falls back to a JSON identity ping, so no bare boot
// can ever prove a dep-gated surface reaches the wire. Point
// D1_BRIDGE_URL here and the production composition mounts for real.
// Plain `===` on the secret — loopback test traffic needs no
// timing-safe compare.
function startD1Bridge(opts) {
  if (!opts || typeof opts.query !== "function") throw new TypeError("startD1Bridge: opts.query (async sql fn) required");
  if (!opts.secret || typeof opts.secret !== "string") throw new TypeError("startD1Bridge: opts.secret required");
  var server = http.createServer(function (req, res) {
    function _json(status, obj) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    }
    if (req.method !== "POST" || req.url !== "/_/db/query") return _json(404, { ok: false, error: "UNKNOWN_ROUTE" });
    if ((req.headers["x-d1-bridge-secret"] || "") !== opts.secret) return _json(401, { ok: false, error: "UNAUTHORIZED" });
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      var body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_e) { body = null; }
      if (!body || typeof body.sql !== "string") return _json(400, { ok: false, error: "INVALID_REQUEST" });
      Promise.resolve(opts.query(body.sql, Array.isArray(body.params) ? body.params : []))
        .then(function (r) {
          if (body.mode === "run") {
            return _json(200, { ok: true, rows: [], rowCount: r.rowCount || 0, lastRowId: r.lastRowId != null ? r.lastRowId : null });
          }
          return _json(200, { ok: true, rows: r.rows || [], rowCount: r.rowCount || 0 });
        })
        .catch(function (e) {
          return _json(500, { ok: false, error: "QUERY_FAILED", message: (e && e.message) || String(e) });
        });
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", function () {
      var port = server.address().port;
      resolve({
        port:  port,
        url:   "http://127.0.0.1:" + port,
        close: function () { return new Promise(function (r) { server.close(r); }); },
      });
    });
  });
}

// ---- HTTP integration-test client + cookie jar -------------------------
//
// Layer 2 helpers — a thin `node:http` client wrapper that returns the
// parsed response (status / headers / body string) plus a cookie jar
// that captures Set-Cookie values and replays them as a single `Cookie`
// header on subsequent requests against the same origin. Built on
// `node:http` directly so the integration suite stays inside the
// zero-npm-runtime-deps envelope. The jar ignores the `Secure`
// attribute (loopback test traffic is plaintext by design); every
// other attribute is parsed for completeness but only `Max-Age=0`
// (immediate-expiry) actually evicts an entry.

function cookieJar() {
  // name -> { value, expiresAt? }
  var store = {};

  function _parseSetCookie(raw) {
    var parts = String(raw).split(";");
    if (!parts.length) return null;
    var nv = parts[0].trim();
    var eq = nv.indexOf("=");
    if (eq <= 0) return null;
    var name  = nv.slice(0, eq).trim();
    var value = nv.slice(eq + 1).trim();
    var maxAge;
    for (var i = 1; i < parts.length; i += 1) {
      var attr = parts[i].trim();
      var ai = attr.indexOf("=");
      if (ai > 0) {
        var ak = attr.slice(0, ai).trim().toLowerCase();
        var av = attr.slice(ai + 1).trim();
        if (ak === "max-age") maxAge = parseInt(av, 10);
      }
    }
    return { name: name, value: value, maxAge: maxAge };
  }

  return {
    capture: function (headers) {
      if (!headers) return;
      var raw = headers["set-cookie"];
      if (!raw) return;
      var list = Array.isArray(raw) ? raw : [raw];
      for (var i = 0; i < list.length; i += 1) {
        var c = _parseSetCookie(list[i]);
        if (!c) continue;
        if (c.maxAge === 0) { delete store[c.name]; continue; }
        store[c.name] = { value: c.value };
      }
    },
    header: function () {
      var names = Object.keys(store);
      if (!names.length) return null;
      var pairs = [];
      for (var i = 0; i < names.length; i += 1) {
        pairs.push(names[i] + "=" + store[names[i]].value);
      }
      return pairs.join("; ");
    },
    get: function (name) {
      return store[name] ? store[name].value : null;
    },
  };
}

// Issue a single HTTP request against an already-bound port. Returns
// `{ status, headers, body }` — body is a UTF-8 string. The default
// headers match a real browser shape (User-Agent + Accept-Language +
// Sec-Fetch-Mode) so the framework's bot-guard middleware doesn't
// block the request when the operator hasn't explicitly disabled it.
// Form-encoded POSTs are the common shape on the storefront — pass
// `opts.form` as a plain object and the helper sets the content-type +
// serializes the body.
async function httpRequest(opts) {
  if (!opts || typeof opts !== "object")    throw new TypeError("httpRequest: opts required");
  if (!opts.port)                            throw new TypeError("httpRequest: opts.port required");
  if (!opts.path)                            throw new TypeError("httpRequest: opts.path required");
  var method = (opts.method || "GET").toUpperCase();
  var headers = Object.assign({
    "user-agent":       "blamejs-shop-test/1.0",
    "accept-language":  "en-US,en;q=0.9",
    "sec-fetch-mode":   "navigate",
    "accept":           "text/html,application/xhtml+xml",
  }, opts.headers || {});
  if (opts.jar) {
    var cookieHeader = opts.jar.header();
    if (cookieHeader) headers["cookie"] = cookieHeader;
    // Double-submit CSRF (blamejs createApp default, v0.13.46+): a
    // state-changing request echoes the captured CSRF cookie as the
    // X-CSRF-Token header (csrfProtect accepts the header OR a `_csrf`
    // body field). Any prior GET in the flow seeds the cookie into the
    // jar. Loopback is plain HTTP → the cookie is `csrf`; production
    // (HTTPS) would be `__Host-csrf`. A caller-set header or `_csrf` form
    // field wins.
    if ((method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") &&
        !headers["x-csrf-token"] && !headers["X-CSRF-Token"] &&
        !(opts.form && opts.form._csrf)) {
      var csrfTok = opts.jar.get("csrf") || opts.jar.get("__Host-csrf");
      if (csrfTok) headers["x-csrf-token"] = csrfTok;
    }
  }
  var bodyBuf = null;
  if (opts.form) {
    var pairs = [];
    for (var k in opts.form) {
      if (!Object.prototype.hasOwnProperty.call(opts.form, k)) continue;
      pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(opts.form[k]));
    }
    bodyBuf = Buffer.from(pairs.join("&"), "utf8");
    headers["content-type"]   = "application/x-www-form-urlencoded";
    headers["content-length"] = String(bodyBuf.length);
  } else if (opts.body != null) {
    bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), "utf8");
    headers["content-length"] = String(bodyBuf.length);
  }
  return await new Promise(function (resolve, reject) {
    // A server that refuses an upload mid-stream (e.g. the multipart
    // size cap) responds and tears the socket down while the client is
    // still writing the body. Whether this side then sees the response,
    // a write EPIPE, or a read ECONNRESET is a TCP race — so the
    // response wins whenever its headers arrived: a post-response
    // socket error settles with whatever body was received instead of
    // failing the test. Pre-response socket errors are real failures
    // and still reject. Large bodies are written in slices with an
    // event-loop yield between them so an early response gets processed
    // mid-upload and the client stops sending into a dead socket.
    var gotResponse = false;
    var settled = false;
    var req = http.request({
      host:    opts.host || "127.0.0.1",
      port:    opts.port,
      method:  method,
      path:    opts.path,
      headers: headers,
      // One fresh socket per request — Node's default agent keeps
      // connections alive and would hand the NEXT request the socket a
      // mid-upload rejection just destroyed, surfacing as a read
      // ECONNRESET in whichever unrelated request drew it from the pool.
      agent:   false,
    }, function (res) {
      gotResponse = true;
      var chunks = [];
      function _settle() {
        if (settled) return;
        settled = true;
        var body = Buffer.concat(chunks).toString("utf8");
        if (opts.jar) opts.jar.capture(res.headers);
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      }
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", _settle);
      res.on("error", function (e) {
        // Settling with a partial body on a mid-read reset is correct ONLY
        // for routes whose refusal can legitimately be a wire reset (the
        // over-cap upload case) — callers opt in via tolerateEarlyClose.
        // Everywhere else a reset mid-response is a real server failure
        // and must fail the test loudly.
        if (opts.tolerateEarlyClose && e && (e.code === "ECONNRESET" || e.code === "EPIPE")) return _settle();
        if (!settled) { settled = true; reject(e); }
      });
    });
    req.on("error", function (e) {
      if (gotResponse && e && (e.code === "EPIPE" || e.code === "ECONNRESET")) return;
      // A server refusing a mid-stream upload (over-cap multipart) may
      // destroy the connection before its 413/redirect flushes — the RST
      // discards the client's buffered response, so no response is ever
      // readable. That reset IS the refusal on the wire (browsers see the
      // same). A caller probing such a path opts in via tolerateEarlyClose
      // and gets a sentinel instead of a throw; everything else still
      // rejects, so a genuinely crashed server fails tests loudly.
      if (opts.tolerateEarlyClose && e && (e.code === "EPIPE" || e.code === "ECONNRESET")) {
        if (!settled) { settled = true; resolve({ status: 0, reset: true, headers: {}, body: "" }); }
        return;
      }
      if (!settled) { settled = true; reject(e); }
    });
    if (!bodyBuf || bodyBuf.length <= 65536) {
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    } else {
      var offset = 0;
      (function _writeSlice() {
        if (req.destroyed) return;
        // Server already answered (early rejection) — stop sending and
        // close our side; the response handler owns settling.
        if (gotResponse) return req.end();
        if (offset >= bodyBuf.length) return req.end();
        var slice = bodyBuf.subarray(offset, offset + 65536);
        offset += slice.length;
        req.write(slice, function () { setImmediate(_writeSlice); });
      })();
    }
  });
}

// Mint a sealed cookie value the way `b.cookies.writeSealed` does —
// seal the JSON, then strip the on-wire "vault:" prefix the primitive
// removes before it hits the cookie. Lets a flow test forge the
// `shop_auth` cookie the storefront reads back via `readSealed`,
// without driving the whole WebAuthn ceremony. `b` is the framework
// handle (bShop.framework); the app must be booted first so the vault
// is initialized.
function sealedCookie(b, name, obj) {
  var sealed = b.vault.seal(JSON.stringify(obj));
  var stripped = sealed.indexOf("vault:") === 0 ? sealed.slice("vault:".length) : sealed;
  return name + "=" + encodeURIComponent(stripped);
}

// The signed-in-customer cookie. `opts.exp` overrides the default
// 1-hour expiry (epoch ms).
function authCookie(b, customerId, opts) {
  opts = opts || {};
  return sealedCookie(b, "shop_auth", {
    customer_id: customerId,
    exp:         opts.exp || (Date.now() + 3600000),
  });
}

module.exports = {
  assert:         assert,
  check:          check,
  getChecks:      getChecks,
  waitUntil:      waitUntil,
  waitUntilEqual: waitUntilEqual,
  withTestTimeout: withTestTimeout,
  memD1Query:     memD1Query,
  allMigrationPaths: allMigrationPaths,
  startD1Bridge:  startD1Bridge,
  cookieJar:      cookieJar,
  httpRequest:    httpRequest,
  sealedCookie:   sealedCookie,
  authCookie:     authCookie,
};
