"use strict";
/**
 * r2Bridge — container → Worker → R2 upload adapter.
 *
 * Layer 1 because the adapter is the media-upload primitive admin
 * routes compose against. Coverage:
 *
 *   - factory validation (bridgeUrl, bridgeSecret, bridgePath,
 *     timeoutMs, httpClient override shape)
 *   - put() POSTs to the correct path with the bridge secret header,
 *     X-R2-Key, X-R2-Content-Type, application/octet-stream body
 *   - success response shape (ok + key + size)
 *   - error envelope from the Worker surfaces as a typed throw
 *   - HTTP 4xx / 5xx surface as typed throws
 *   - malformed JSON response surfaces as R2_BAD_RESPONSE
 *   - timeout / network error surface with typed codes
 *   - put() argument validation refuses bad keys / bodies / content-types
 */

var bShop  = require("../../lib");
var helpers = require("../helpers");
var check  = helpers.check;
var assert = helpers.assert;

var r2factory = bShop.r2Bridge;

function _makeFakeHttp(responses) {
  // Mimics b.httpClient.request — returns { statusCode, headers, body:
  // Buffer }. Each queued response can be `{ status, body, throws? }`.
  var calls = [];
  var i = 0;
  var httpClient = {
    request: async function (opts) {
      calls.push(opts);
      var r = responses[i] || responses[responses.length - 1];
      i += 1;
      if (r.throws) {
        var e = new Error(r.throws.message || "simulated");
        if (r.throws.code) e.code = r.throws.code;
        if (r.throws.name) e.name = r.throws.name;
        throw e;
      }
      var bodyStr = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return {
        statusCode: r.status,
        headers:    r.headers || { "content-type": "application/json" },
        body:       Buffer.from(bodyStr, "utf8"),
      };
    },
  };
  return { httpClient: httpClient, calls: calls };
}

async function _factoryValidation() {
  assert.throws(function () { r2factory.create(); },                                /opts must be an object/);
  assert.throws(function () { r2factory.create({}); },                              /bridgeUrl/);
  assert.throws(function () { r2factory.create({ bridgeUrl: "x" }); },               /bridgeSecret/);
  assert.throws(function () { r2factory.create({ bridgeUrl: "x", bridgeSecret: "s", bridgePath: 5 }); }, /bridgePath/);
  assert.throws(function () { r2factory.create({ bridgeUrl: "x", bridgeSecret: "s", timeoutMs: -1 }); },  /timeoutMs/);
  assert.throws(function () { r2factory.create({ bridgeUrl: "x", bridgeSecret: "s", httpClient: {} }); }, /httpClient/);
  check("factory rejects bad inputs", true);
}

async function _putHappyPath() {
  var fake = _makeFakeHttp([{
    status: 200,
    body:   { ok: true, key: "media/abc.png", size: 11 },
  }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s3cret",
    httpClient:   fake.httpClient,
  });
  var buf = Buffer.from("hello world");
  var rec = await r2.put("media/abc.png", buf, "image/png");
  check("returns ok",       rec.ok === true);
  check("returns key",      rec.key === "media/abc.png");
  check("returns size",     rec.size === 11);

  var call = fake.calls[0];
  check("calls bridge URL+path",     call.url === "http://bridge.local/_/r2/put");
  check("POST method",               call.method === "POST");
  check("bridge secret header set",  call.headers["x-d1-bridge-secret"] === "s3cret");
  check("X-R2-Key header set",       call.headers["x-r2-key"] === "media/abc.png");
  check("X-R2-Content-Type header",  call.headers["x-r2-content-type"] === "image/png");
  check("octet-stream content-type", call.headers["content-type"] === "application/octet-stream");
  check("body is the Buffer",        Buffer.isBuffer(call.body) && call.body.equals(buf));
}

async function _customBridgePath() {
  var fake = _makeFakeHttp([{ status: 200, body: { ok: true, key: "k", size: 1 } }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local/",
    bridgeSecret: "s",
    bridgePath:   "/custom/upload",
    httpClient:   fake.httpClient,
  });
  await r2.put("k", Buffer.from("x"), "text/plain");
  check("custom path used",          fake.calls[0].url === "http://bridge.local/custom/upload");
  check("trailing slash normalized", fake.calls[0].url.indexOf("//custom") === -1);
}

async function _workerErrorEnvelope() {
  var fake = _makeFakeHttp([{
    status: 401,
    body:   { ok: false, error: "UNAUTHORIZED" },
  }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "wrong",
    httpClient:   fake.httpClient,
  });
  var threw = false;
  try { await r2.put("media/x.png", Buffer.from("x"), "image/png"); }
  catch (e) {
    threw = true;
    check("error code preserved",  e.code === "UNAUTHORIZED" || e.code === "R2_HTTP_401");
    check("status surfaced",       e.status === 401);
  }
  check("HTTP error throws", threw);
}

async function _http5xxThrows() {
  var fake = _makeFakeHttp([{
    status: 500,
    body:   { ok: false, error: "PUT_FAILED", message: "r2 binding rejected" },
  }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s",
    httpClient:   fake.httpClient,
  });
  var threw = false;
  try { await r2.put("media/x.png", Buffer.from("x"), "image/png"); }
  catch (e) {
    threw = true;
    check("5xx surfaces message", e.message.indexOf("r2 binding rejected") !== -1);
    check("5xx status",           e.status === 500);
  }
  check("5xx throws", threw);
}

async function _malformedResponse() {
  var fake = _makeFakeHttp([{
    status: 200,
    body:   "not-json-at-all",
  }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s",
    httpClient:   fake.httpClient,
  });
  var threw = false;
  try { await r2.put("media/x.png", Buffer.from("x"), "image/png"); }
  catch (e) {
    threw = true;
    check("bad response code", e.code === "R2_BAD_RESPONSE");
  }
  check("malformed response throws", threw);
}

async function _timeoutCode() {
  var fake = _makeFakeHttp([{
    throws: { message: "aborted", name: "AbortError" },
  }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s",
    timeoutMs:    50,
    httpClient:   fake.httpClient,
  });
  var threw = false;
  try { await r2.put("media/x.png", Buffer.from("x"), "image/png"); }
  catch (e) {
    threw = true;
    check("timeout code", e.code === "R2_TIMEOUT");
  }
  check("timeout fires typed error", threw);
}

async function _networkErrorCoded() {
  var fake = _makeFakeHttp([{
    throws: { message: "connect ECONNRESET", code: "ECONNRESET" },
  }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s",
    httpClient:   fake.httpClient,
  });
  var threw = false;
  try { await r2.put("media/x.png", Buffer.from("x"), "image/png"); }
  catch (e) {
    threw = true;
    // The adapter preserves the original code if set.
    check("network error code preserved", e.code === "ECONNRESET");
  }
  check("network error propagates", threw);
}

async function _putArgValidation() {
  var fake = _makeFakeHttp([{ status: 200, body: { ok: true, key: "k", size: 1 } }]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s",
    httpClient:   fake.httpClient,
  });
  await assert.rejects(function () { return r2.put("", Buffer.from("x"), "image/png"); },         /key must be a non-empty string/);
  await assert.rejects(function () { return r2.put("/abs/path", Buffer.from("x"), "image/png"); }, /relative path/);
  await assert.rejects(function () { return r2.put("../escape", Buffer.from("x"), "image/png"); }, /relative path/);
  await assert.rejects(function () { return r2.put("k", null, "image/png"); },                      /body required/);
  await assert.rejects(function () { return r2.put("k", Buffer.from("x"), ""); },                   /contentType must be a non-empty string/);
  await assert.rejects(function () { return r2.put("k", Buffer.from("x"), "not a mime"); },         /type\/subtype/);
  check("put rejects bad args", true);
}

async function _acceptsStringAndUint8() {
  var fake = _makeFakeHttp([
    { status: 200, body: { ok: true, key: "k1", size: 5 } },
    { status: 200, body: { ok: true, key: "k2", size: 3 } },
  ]);
  var r2 = r2factory.create({
    bridgeUrl:    "http://bridge.local",
    bridgeSecret: "s",
    httpClient:   fake.httpClient,
  });
  // String body — encoded as UTF-8.
  var r1 = await r2.put("k1", "hello", "text/plain");
  check("string body accepted", r1.key === "k1");
  check("string body encoded to bytes", Buffer.isBuffer(fake.calls[0].body) && fake.calls[0].body.length === 5);
  // Uint8Array body.
  var r2res = await r2.put("k2", new Uint8Array([1, 2, 3]), "application/octet-stream");
  check("Uint8Array body accepted", r2res.key === "k2");
  check("Uint8Array body encoded",  Buffer.isBuffer(fake.calls[1].body) && fake.calls[1].body.length === 3);
}

async function run() {
  await _factoryValidation();
  await _putHappyPath();
  await _customBridgePath();
  await _workerErrorEnvelope();
  await _http5xxThrows();
  await _malformedResponse();
  await _timeoutCode();
  await _networkErrorCoded();
  await _putArgValidation();
  await _acceptsStringAndUint8();
}

module.exports = { run: run };
