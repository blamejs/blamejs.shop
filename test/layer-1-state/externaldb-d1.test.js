"use strict";
/**
 * externaldbD1 — adapter shape + wire-protocol contract.
 *
 * Layer 1 because the adapter is the data-access primitive every
 * commerce module composes against. Coverage:
 *
 *   - factory validation (mode, required opts, fetch override)
 *   - service-binding mode: header shape, body shape, READ vs WRITE
 *     classification, result-shape normalization
 *   - rest-api mode: URL shape, Bearer auth, error envelope mapping
 *   - HTTP error → typed exception
 *   - Worker-side error envelope → typed exception
 *   - retry on 5xx, surface non-retryable 4xx immediately
 *   - request timeout
 */

var bShop  = require("../../lib");
var helpers = require("../helpers");
var check  = helpers.check;
var assert = helpers.assert;

var d1factory = bShop.externaldbD1;

function _makeFake(responses) {
  // Returns a fetch shim that yields the next queued response per
  // call. Each response is `{ status, body, throws? }` — `throws`
  // simulates a network-level error.
  var calls = [];
  var i = 0;
  var fetchImpl = async function (url, init) {
    calls.push({ url: url, init: init });
    var r = responses[i] || responses[responses.length - 1];
    i += 1;
    if (r.throws) {
      var e = new Error(r.throws.message || "simulated");
      e.code = r.throws.code || "ECONNRESET";
      throw e;
    }
    var body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      ok:      r.status >= 200 && r.status < 300,
      status:  r.status,
      json:    async function () { return JSON.parse(body); },
      text:    async function () { return body; },
    };
  };
  return { fetch: fetchImpl, calls: calls };
}

async function _factoryValidation() {
  assert.throws(function () { d1factory.create(); },                                                 /opts must be an object/);
  assert.throws(function () { d1factory.create({ mode: "junk" });                  }, /mode must be/);
  assert.throws(function () { d1factory.create({ mode: "service-binding" });        }, /bridgeUrl/);
  assert.throws(function () { d1factory.create({ mode: "service-binding", bridgeUrl: "x" }); }, /bridgeSecret/);
  assert.throws(function () { d1factory.create({ mode: "rest-api" });              }, /accountId/);
  assert.throws(function () { d1factory.create({ mode: "rest-api", accountId: "a" }); }, /databaseId/);
  assert.throws(function () { d1factory.create({ mode: "rest-api", accountId: "a", databaseId: "d" }); }, /apiToken/);
  assert.throws(function () {
    d1factory.create({ mode: "service-binding", bridgeUrl: "u", bridgeSecret: "s", timeoutMs: -1 });
  }, /timeoutMs/);
  check("factory rejects bad inputs", true);
}

async function _serviceBindingReadShape() {
  var fake = _makeFake([{
    status: 200,
    body: { ok: true, rows: [{ id: 1, sku: "abc" }, { id: 2, sku: "def" }], rowCount: 2 },
  }]);
  var d1 = d1factory.create({
    mode:         "service-binding",
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s3cret",
    fetch:        fake.fetch,
  });
  check("dialect is sqlite", d1.dialect === "sqlite");
  var client = await d1.connect();
  var r = await d1.query(client, "SELECT id, sku FROM products WHERE active = ?1", [1]);
  check("rows normalized", r.rows.length === 2 && r.rows[0].sku === "abc");
  check("rowCount normalized", r.rowCount === 2);

  check("calls bridge URL+path", fake.calls[0].url === "http://bridge.local/_/db/query");
  var init = fake.calls[0].init;
  check("POST method", init.method === "POST");
  check("bridge secret header set", init.headers["x-d1-bridge-secret"] === "s3cret");
  check("content-type JSON", /application\/json/.test(init.headers["content-type"]));
  var parsed = JSON.parse(init.init ? init.init.body : init.body);
  check("body carries SQL", parsed.sql.indexOf("SELECT") === 0);
  check("body carries params", Array.isArray(parsed.params) && parsed.params[0] === 1);
  check("READ classified as 'all'", parsed.mode === "all");
}

async function _serviceBindingWriteShape() {
  var fake = _makeFake([{
    status: 200,
    body: { ok: true, rows: [], rowCount: 1, lastRowId: 42 },
  }]);
  var d1 = d1factory.create({
    mode:         "service-binding",
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s3cret",
    fetch:        fake.fetch,
  });
  var client = await d1.connect();
  var r = await d1.query(client, "INSERT INTO orders (id) VALUES (?1)", ["ord_1"]);
  var parsed = JSON.parse(fake.calls[0].init.body);
  check("INSERT classified as 'run'", parsed.mode === "run");
  check("write returns rowCount", r.rowCount === 1);
  check("write returns lastRowId", r.lastRowId === 42);
}

async function _serviceBindingErrorEnvelope() {
  var fake = _makeFake([{
    status: 200,
    body: { ok: false, error: "UNIQUE_VIOLATION", message: "sku already exists" },
  }]);
  var d1 = d1factory.create({
    mode:         "service-binding",
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s3cret",
    fetch:        fake.fetch,
  });
  var client = await d1.connect();
  var threw = false;
  try { await d1.query(client, "INSERT INTO products (sku) VALUES (?1)", ["abc"]); }
  catch (e) {
    threw = true;
    check("error code preserved", e.code === "UNIQUE_VIOLATION");
    check("error message echoes worker", e.message.indexOf("sku already exists") !== -1);
  }
  check("worker error envelope surfaces as throw", threw);
}

async function _serviceBindingHttp5xxRetries() {
  // Worker returns 503 twice, then 200. Adapter should retry and
  // succeed on the third attempt.
  var fake = _makeFake([
    { status: 503, body: { ok: false, error: "UPSTREAM_DOWN" } },
    { status: 503, body: { ok: false, error: "UPSTREAM_DOWN" } },
    { status: 200, body: { ok: true, rows: [{ x: 1 }], rowCount: 1 } },
  ]);
  var d1 = d1factory.create({
    mode:         "service-binding",
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s3cret",
    fetch:        fake.fetch,
  });
  var client = await d1.connect();
  var r = await d1.query(client, "SELECT 1 AS x", []);
  check("retried until success", fake.calls.length === 3);
  check("final result returned", r.rows[0].x === 1);
}

async function _serviceBindingHttp4xxIsTerminal() {
  // A 401 is a permanent client error — must NOT retry.
  var fake = _makeFake([
    { status: 401, body: { ok: false, error: "UNAUTHORIZED" } },
    { status: 200, body: { ok: true, rows: [], rowCount: 0 } },
  ]);
  var d1 = d1factory.create({
    mode:         "service-binding",
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s3cret",
    fetch:        fake.fetch,
  });
  var client = await d1.connect();
  var threw = false;
  try { await d1.query(client, "SELECT 1", []); }
  catch (e) {
    threw = true;
    check("4xx code surfaced", e.code === "D1_HTTP_401");
  }
  check("4xx did not retry", fake.calls.length === 1 && threw);
}

async function _serviceBindingTransientNetworkRetries() {
  // Network ECONNRESET → retry; then success.
  var fake = _makeFake([
    { throws: { code: "ECONNRESET" } },
    { status: 200, body: { ok: true, rows: [{ y: 2 }], rowCount: 1 } },
  ]);
  var d1 = d1factory.create({
    mode:         "service-binding",
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s3cret",
    fetch:        fake.fetch,
  });
  var client = await d1.connect();
  var r = await d1.query(client, "SELECT 2 AS y", []);
  check("network err retried", fake.calls.length === 2);
  check("recovered result", r.rows[0].y === 2);
}

async function _restApiShape() {
  var fake = _makeFake([{
    status: 200,
    body: {
      success: true,
      errors:  [],
      messages:[],
      result:  [{
        results: [{ id: 1, name: "widget" }],
        success: true,
        meta:    { changes: 0, last_row_id: 0, duration: 1.23 },
      }],
    },
  }]);
  var d1 = d1factory.create({
    mode:       "rest-api",
    accountId:  "acc_abc",
    databaseId: "db_xyz",
    apiToken:   "tok_secret",
    fetch:      fake.fetch,
  });
  var client = await d1.connect();
  var r = await d1.query(client, "SELECT * FROM products", []);
  check("REST rows normalized", r.rows.length === 1 && r.rows[0].name === "widget");
  var call = fake.calls[0];
  check(
    "REST URL well-formed",
    call.url === "https://api.cloudflare.com/client/v4/accounts/acc_abc/d1/database/db_xyz/query",
  );
  check("Bearer auth set", call.init.headers.authorization === "Bearer tok_secret");
}

async function _restApiErrorEnvelope() {
  var fake = _makeFake([{
    status: 200,
    body: {
      success: false,
      errors:  [{ code: 7500, message: "table not found" }],
      messages:[],
      result:  null,
    },
  }]);
  var d1 = d1factory.create({
    mode:       "rest-api",
    accountId:  "acc",
    databaseId: "db",
    apiToken:   "tok",
    fetch:      fake.fetch,
  });
  var client = await d1.connect();
  var threw = false;
  try { await d1.query(client, "SELECT * FROM nope", []); }
  catch (e) {
    threw = true;
    check("REST code prefixed", e.code === "D1_REST_7500");
    check("REST error message surfaced", e.message.indexOf("table not found") !== -1);
  }
  check("REST error envelope throws", threw);
}

async function _timeoutSurfacesAsCode() {
  // A fetch that never resolves — AbortController fires; adapter
  // converts to a D1_TIMEOUT error.
  var aborted = false;
  var fetchImpl = async function (_url, init) {
    return await new Promise(function (resolve, reject) {
      if (init && init.signal) {
        init.signal.addEventListener("abort", function () {
          aborted = true;
          var e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }
      // Never resolves on its own.
    });
  };
  var d1 = d1factory.create({
    mode:         "service-binding",
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s",
    timeoutMs:    50,
    fetch:        fetchImpl,
  });
  var client = await d1.connect();
  var threw = false;
  try { await d1.query(client, "SELECT 1", []); }
  catch (e) {
    threw = true;
    check("timeout code", e.code === "D1_TIMEOUT");
  }
  check("timeout fires AbortController", aborted && threw);
}

async function run() {
  await _factoryValidation();
  await _serviceBindingReadShape();
  await _serviceBindingWriteShape();
  await _serviceBindingErrorEnvelope();
  await _serviceBindingHttp5xxRetries();
  await _serviceBindingHttp4xxIsTerminal();
  await _serviceBindingTransientNetworkRetries();
  await _restApiShape();
  await _restApiErrorEnvelope();
  await _timeoutSurfacesAsCode();
}

module.exports = { run: run };
