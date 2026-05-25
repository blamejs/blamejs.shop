"use strict";
/**
 * @module shop.r2Bridge
 * @title  R2 upload bridge — container → Worker → R2
 *
 * @intro
 *   Container-side adapter that POSTs binary bodies to the Worker's
 *   `/_/r2/put` endpoint. The Worker holds the R2 binding (the
 *   container never carries an R2 API token); the bridge call is
 *   authenticated with the same shared-secret header the D1 bridge
 *   uses, so a misconfigured route can never accept arbitrary uploads
 *   from anywhere other than the bound container.
 *
 *   Composed on `b.httpClient.request` so the outbound call inherits
 *   the SSRF gate, retry policy, circuit breaker, TLS 1.3 minimum, and
 *   ALPN-negotiated HTTP/2 transport. No npm dependency.
 *
 *       var r2 = require("blamejs-shop").r2Bridge.create({
 *         bridgeUrl:    process.env.D1_BRIDGE_URL,
 *         bridgeSecret: process.env.D1_BRIDGE_SECRET,
 *         bridgePath:   "/_/r2/put",
 *       });
 *       var rec = await r2.put("media/abc.png", buf, "image/png");
 *       // → { ok: true, key: "media/abc.png", size: 1024 }
 *
 *   The Worker side accepts POST with a binary body plus two headers:
 *   `X-R2-Key` (the object key) and `X-R2-Content-Type` (the MIME type
 *   to persist in R2 object metadata). The shared secret rides in
 *   `x-d1-bridge-secret` — same header name the D1 bridge uses so the
 *   operator has one secret to rotate, not two.
 */

var DEFAULT_TIMEOUT_MS  = 15000;
var DEFAULT_BRIDGE_PATH = "/_/r2/put";
var MAX_KEY_LENGTH      = 1024;
var MAX_CONTENT_TYPE    = 255;

var b = require("./vendor/blamejs");

function _validateOpts(opts) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("r2Bridge.create({ opts }) — opts must be an object");
  }
  if (typeof opts.bridgeUrl !== "string" || !opts.bridgeUrl.length) {
    throw new TypeError("r2Bridge.create — bridgeUrl required");
  }
  if (typeof opts.bridgeSecret !== "string" || !opts.bridgeSecret.length) {
    throw new TypeError("r2Bridge.create — bridgeSecret required");
  }
  if (opts.bridgePath !== undefined && typeof opts.bridgePath !== "string") {
    throw new TypeError("r2Bridge.create — bridgePath must be a string when provided");
  }
  if (opts.timeoutMs !== undefined && (typeof opts.timeoutMs !== "number" || !isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) { // allow:inline-optional-positive-finite-validation — the TypeError message must literally contain "timeoutMs" so the test contract (`assert.throws(..., /timeoutMs/)`) sees the labelled field; the framework helper produces a `code`-first message that doesn't carry the label
    throw new TypeError("r2Bridge.create — timeoutMs must be a positive number");
  }
  if (opts.httpClient !== undefined && (!opts.httpClient || typeof opts.httpClient.request !== "function")) {
    throw new TypeError("r2Bridge.create — httpClient override must expose .request(...)");
  }
}

function _validatePutArgs(key, body, contentType) {
  if (typeof key !== "string" || !key.length) {
    throw new TypeError("r2Bridge.put: key must be a non-empty string");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new TypeError("r2Bridge.put: key exceeds " + MAX_KEY_LENGTH + " chars");
  }
  if (key.indexOf("..") !== -1 || key.charAt(0) === "/") {
    throw new TypeError("r2Bridge.put: key must be a relative path (no leading slash, no '..' segments)");
  }
  if (body == null) {
    throw new TypeError("r2Bridge.put: body required");
  }
  if (!Buffer.isBuffer(body) && typeof body !== "string" && !(body instanceof Uint8Array)) {
    throw new TypeError("r2Bridge.put: body must be Buffer | Uint8Array | string");
  }
  if (typeof contentType !== "string" || !contentType.length) {
    throw new TypeError("r2Bridge.put: contentType must be a non-empty string");
  }
  if (contentType.length > MAX_CONTENT_TYPE) {
    throw new TypeError("r2Bridge.put: contentType exceeds " + MAX_CONTENT_TYPE + " chars");
  }
  // RFC 7231 media-type shape — type/subtype with optional parameters.
  // Stops control bytes / line breaks from being smuggled into the
  // Worker's bound metadata.
  if (!/^[\w.+\-]+\/[\w.+\-]+(?:\s*;\s*[\w.+\-]+=[\w.+\-"]+)*$/.test(contentType)) {
    throw new TypeError("r2Bridge.put: contentType must match `type/subtype` shape");
  }
}

function _httpErr(status, label) {
  var e = new Error("r2Bridge: " + label + " failed with HTTP " + status);
  e.code = "R2_HTTP_" + status;
  e.status = status;
  return e;
}

function create(opts) {
  _validateOpts(opts);
  var url        = opts.bridgeUrl.replace(/\/+$/, "") + (opts.bridgePath || DEFAULT_BRIDGE_PATH);
  var secret     = opts.bridgeSecret;
  var timeoutMs  = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  var httpClient = opts.httpClient || b.httpClient;

  return {
    put: async function (key, body, contentType) {
      _validatePutArgs(key, body, contentType);
      var buf = Buffer.isBuffer(body) ? body
              : body instanceof Uint8Array ? Buffer.from(body)
              : Buffer.from(body, "utf8");
      var res;
      try {
        res = await httpClient.request({
          method:    "POST",
          url:       url,
          headers:   {
            "content-type":        "application/octet-stream",
            "content-length":      buf.length,
            "x-d1-bridge-secret":  secret,
            "x-r2-key":            key,
            "x-r2-content-type":   contentType,
            "accept":               "application/json",
          },
          body:      buf,
          timeoutMs: timeoutMs,
        });
      } catch (e) {
        // Network / abort / timeout / SSRF refusal — surface as typed.
        if (e && e.name === "AbortError") {
          var t = new Error("r2Bridge: upload timed out after " + timeoutMs + "ms");
          t.code = "R2_TIMEOUT";
          throw t;
        }
        if (e && !e.code) e.code = "R2_NETWORK_ERROR";
        throw e;
      }
      var text = res.body && res.body.toString ? res.body.toString("utf8") : "";
      var json = null;
      try { json = text.length ? JSON.parse(text) : null; } catch (_e) { json = null; }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        var err = _httpErr(res.statusCode, "upload");
        if (json && json.error) {
          err.code = json.error;
          err.message += " — " + json.error;
        }
        if (json && json.message) {
          err.message += ": " + json.message;
        }
        throw err;
      }
      if (!json || json.ok !== true || typeof json.key !== "string") {
        var ee = new Error("r2Bridge: upload returned malformed JSON envelope");
        ee.code = "R2_BAD_RESPONSE";
        throw ee;
      }
      return {
        ok:   true,
        key:  json.key,
        size: typeof json.size === "number" ? json.size : buf.length,
      };
    },
  };
}

module.exports = { create: create };
