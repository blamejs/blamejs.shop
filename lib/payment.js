"use strict";
/**
 * @module shop.payment
 * @title  Payment primitive — Stripe adapter
 *
 * @intro
 *   v1 ships the Stripe adapter — inbound webhook signature
 *   verification (HMAC-SHA256 over `<timestamp>.<body>` with
 *   `whsec_...` secret, ±5 min tolerance, constant-time compare) and
 *   outbound API calls (PaymentIntent create / retrieve / confirm /
 *   cancel + Refund) composed on `b.httpClient` (SSRF-gated, retried,
 *   circuit-broken, ALPN HTTP/2). No `stripe` npm dep — every byte is
 *   either node built-in or vendored blamejs primitive.
 *
 *   Future Adyen / Mollie / Paddle adapters land as additional
 *   factory functions returning the same `{ verifyWebhook,
 *   createPaymentIntent, ... }` shape so caller code (checkout,
 *   order) doesn't care which adapter is wired.
 *
 *   The verifier IS available on the Worker too (see
 *   worker/index.js's `_verifyStripeSignature`) — the container
 *   re-verifies as defense in depth so a compromised Worker
 *   token can't smuggle unsigned events into the order pipeline.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// Stripe webhook signatures are HMAC-SHA256. blamejs's b.crypto only
// exposes hmacSha3 (sha3-512); a generic b.crypto.hmac surface is a
// tracked upstream ask. Until that lands, the verifier reaches for
// node:crypto for the SHA-256 HMAC ONLY, with the timestamp-tolerance
// + replay + constant-time-compare discipline still composed on
// b.crypto primitives.
var _nodeCrypto = require("node:crypto");   // allow:non-shop-require — HMAC-SHA256 not on b.crypto yet

var STRIPE_API_BASE_DEFAULT  = "https://api.stripe.com/v1";
var STRIPE_WEBHOOK_TOLERANCE = 300;   // ± 5 minutes (Stripe default)
var STRIPE_HTTP_TIMEOUT_MS   = 15000;
var CURRENCY_RE              = /^[a-z]{3}$/;   // Stripe wants lowercase ISO 4217

// ---- validation -----------------------------------------------------------

function _assertSecret(s, label) {
  if (typeof s !== "string" || s.length < 8) {
    throw new TypeError("payment: " + label + " must be a non-empty string");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("payment: " + label + " must be a non-negative integer (minor units)");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("payment: " + label + " must be a positive integer");
  }
}

// ---- Stripe form-encoding -------------------------------------------------
//
// Stripe accepts application/x-www-form-urlencoded with bracket
// notation for nested fields:
//
//   amount=2999&currency=usd&automatic_payment_methods[enabled]=true
//
// `_formEncode({ amount: 2999, currency: "usd", automatic_payment_methods: { enabled: true } })`
// yields the line above. Arrays use `key[]=v1&key[]=v2`.
function _formEncode(obj, prefix) {
  var parts = [];
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (v == null) return;
    var name = prefix ? prefix + "[" + k + "]" : k;
    if (Array.isArray(v)) {
      v.forEach(function (item) {
        if (item != null && typeof item === "object") {
          parts.push(_formEncode(item, name + "[]"));
        } else {
          parts.push(encodeURIComponent(name + "[]") + "=" + encodeURIComponent(String(item)));
        }
      });
    } else if (typeof v === "object") {
      parts.push(_formEncode(v, name));
    } else {
      parts.push(encodeURIComponent(name) + "=" + encodeURIComponent(String(v)));
    }
  });
  return parts.filter(Boolean).join("&");
}

// ---- webhook verifier -----------------------------------------------------

function _parseStripeSig(header) {
  // Format: t=<ts>,v1=<hex>[,v1=<hex>]...
  // Multiple v1= signatures appear during secret rotation.
  if (typeof header !== "string" || !header.length) return null;
  var parts = header.split(",").map(function (p) { return p.trim(); });
  var ts = null;
  var sigs = [];
  for (var i = 0; i < parts.length; i += 1) {
    var eq = parts[i].indexOf("=");
    if (eq <= 0) continue;
    var k = parts[i].slice(0, eq);
    var v = parts[i].slice(eq + 1);
    if (k === "t")       ts = parseInt(v, 10);
    else if (k === "v1") sigs.push(v);
  }
  if (!ts || !isFinite(ts) || sigs.length === 0) return null;
  return { ts: ts, sigs: sigs };
}

function _verifyWebhook(headers, rawBody, secret, opts) {
  if (typeof rawBody !== "string") {
    throw new TypeError("payment.verifyWebhook: rawBody must be the request body string (read BEFORE JSON.parse)");
  }
  opts = opts || {};
  var tolerance = opts.toleranceSeconds == null ? STRIPE_WEBHOOK_TOLERANCE : opts.toleranceSeconds;
  _positiveInt(tolerance, "toleranceSeconds");
  var nowSec = opts.now == null ? Math.floor(Date.now() / 1000) : opts.now;

  var headerVal = null;
  if (headers && typeof headers === "object") {
    // Case-insensitive header lookup.
    var keys = Object.keys(headers);
    for (var k = 0; k < keys.length; k += 1) {
      if (keys[k].toLowerCase() === "stripe-signature") { headerVal = headers[keys[k]]; break; }
    }
  }
  var parsed = _parseStripeSig(headerVal);
  if (!parsed) return { ok: false, reason: "no-signature" };
  if (Math.abs(nowSec - parsed.ts) > tolerance) return { ok: false, reason: "timestamp-outside-tolerance" };

  // HMAC-SHA256 over `<ts>.<body>` with the whsec_… secret.
  var signed = parsed.ts + "." + rawBody;
  var expected = _nodeCrypto.createHmac("sha256", secret).update(signed).digest("hex");
  // b.crypto.hmac returns hex. Stripe v1= is hex. Constant-time compare.
  var match = false;
  for (var s = 0; s < parsed.sigs.length; s += 1) {
    if (_b().crypto.timingSafeEqual(parsed.sigs[s], expected)) { match = true; break; }
  }
  if (!match) return { ok: false, reason: "signature-mismatch" };

  // Parse the event so callers don't re-decode. Throw-on-bad-JSON
  // surfaces as `reason: "bad-json"` — verification still failed.
  try {
    var event = JSON.parse(rawBody);
    return { ok: true, event: event };
  } catch (_e) {
    return { ok: false, reason: "bad-json" };
  }
}

// ---- Stripe API call ------------------------------------------------------

async function _stripeCall(opts, method, path, params, idempotencyKey) {
  var url = (opts.apiBase || STRIPE_API_BASE_DEFAULT) + path;
  var headers = {
    "authorization": "Bearer " + opts.apiKey,
    "accept":         "application/json",
    "user-agent":     "blamejs-shop (zero-dep)",
  };
  var body = null;
  if (params && Object.keys(params).length) {
    body = _formEncode(params);
    headers["content-type"]   = "application/x-www-form-urlencoded";
    headers["content-length"] = Buffer.byteLength(body, "utf8");
  }
  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }
  var res = await _b().httpClient.request({
    method:    method,
    url:       url,
    headers:   headers,
    body:      body || undefined,
    timeoutMs: opts.timeoutMs || STRIPE_HTTP_TIMEOUT_MS,
  });
  var text = res.body && res.body.toString ? res.body.toString("utf8") : "";
  var json = null;
  try { json = text.length ? JSON.parse(text) : {}; } catch (_e) { json = { _raw: text }; }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    var err = new Error("stripe: " + method + " " + path + " → HTTP " + res.statusCode +
                        (json && json.error && json.error.message ? " — " + json.error.message : ""));
    err.code = (json && json.error && json.error.code) || "STRIPE_HTTP_" + res.statusCode;
    err.statusCode = res.statusCode;
    err.stripe = json && json.error || null;
    throw err;
  }
  return json;
}

// ---- adapter --------------------------------------------------------------

function stripe(opts) {
  opts = opts || {};
  _assertSecret(opts.apiKey,        "apiKey");
  _assertSecret(opts.webhookSecret, "webhookSecret");

  return {
    name: "stripe",

    verifyWebhook: function (headers, rawBody, vOpts) {
      return _verifyWebhook(headers, rawBody, opts.webhookSecret, vOpts);
    },

    createPaymentIntent: function (input, idempotencyKey) {
      if (!input || typeof input !== "object") throw new TypeError("payment.createPaymentIntent: input object required");
      _positiveInt(input.amount_minor, "amount_minor");
      if (typeof input.currency !== "string" || !CURRENCY_RE.test(input.currency)) {
        throw new TypeError("payment.createPaymentIntent: currency must be 3-letter lowercase ISO 4217");
      }
      var params = {
        amount:   input.amount_minor,
        currency: input.currency,
        automatic_payment_methods: { enabled: true },
      };
      if (input.customer) params.customer  = input.customer;
      if (input.metadata) params.metadata  = input.metadata;
      if (input.description) params.description = input.description;
      if (input.receipt_email) params.receipt_email = input.receipt_email;
      return _stripeCall(opts, "POST", "/payment_intents", params, idempotencyKey);
    },

    retrievePaymentIntent: function (id) {
      _assertSecret(id, "payment_intent id");
      return _stripeCall(opts, "GET", "/payment_intents/" + encodeURIComponent(id), null, null);
    },

    confirmPaymentIntent: function (id, params, idempotencyKey) {
      _assertSecret(id, "payment_intent id");
      return _stripeCall(opts, "POST", "/payment_intents/" + encodeURIComponent(id) + "/confirm",
                          params || {}, idempotencyKey);
    },

    cancelPaymentIntent: function (id, idempotencyKey) {
      _assertSecret(id, "payment_intent id");
      return _stripeCall(opts, "POST", "/payment_intents/" + encodeURIComponent(id) + "/cancel",
                          {}, idempotencyKey);
    },

    refund: function (input, idempotencyKey) {
      if (!input || typeof input !== "object") throw new TypeError("payment.refund: input object required");
      _assertSecret(input.payment_intent, "refund.payment_intent");
      var params = { payment_intent: input.payment_intent };
      if (input.amount_minor != null) {
        _positiveInt(input.amount_minor, "amount_minor");
        params.amount = input.amount_minor;
      }
      if (input.reason) {
        if (["duplicate", "fraudulent", "requested_by_customer"].indexOf(input.reason) === -1) {
          throw new TypeError("payment.refund: reason must be one of duplicate, fraudulent, requested_by_customer");
        }
        params.reason = input.reason;
      }
      if (input.metadata) params.metadata = input.metadata;
      return _stripeCall(opts, "POST", "/refunds", params, idempotencyKey);
    },
  };
}

function create(opts) {
  opts = opts || {};
  if (opts.adapter && opts.adapter !== "stripe") {
    throw new TypeError("payment.create: unknown adapter " + JSON.stringify(opts.adapter) + " — only 'stripe' is supported in v1");
  }
  return stripe(opts);
}

module.exports = {
  create:                    create,
  stripe:                    stripe,
  STRIPE_WEBHOOK_TOLERANCE:  STRIPE_WEBHOOK_TOLERANCE,
  // Exposed for tests + Worker to share form-encoding shape.
  _formEncode:               _formEncode,
  _verifyWebhook:            _verifyWebhook,
};
