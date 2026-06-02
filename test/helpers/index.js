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

var assert = require("node:assert");
var http   = require("node:http");
var nodeFs = require("node:fs");
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

function memD1Query(migrationPaths) {
  var paths = Array.isArray(migrationPaths) ? migrationPaths : [migrationPaths];
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  for (var p = 0; p < paths.length; p += 1) {
    var schema = nodeFs.readFileSync(paths[p], "utf8");
    var stmts = _splitSchema(schema);
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
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
  return { query: query, db: db };
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
    var req = http.request({
      host:    opts.host || "127.0.0.1",
      port:    opts.port,
      method:  method,
      path:    opts.path,
      headers: headers,
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var body = Buffer.concat(chunks).toString("utf8");
        if (opts.jar) opts.jar.capture(res.headers);
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
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
  memD1Query:     memD1Query,
  cookieJar:      cookieJar,
  httpRequest:    httpRequest,
  sealedCookie:   sealedCookie,
  authCookie:     authCookie,
};
