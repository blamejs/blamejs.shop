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
//
// Composes b.webhook.verify (alg: "hmac-sha256-stripe") — the
// upstream primitive ships full Stripe-spec verification:
// constant-time compare, multi-v1= rotation support, timestamp
// tolerance, and optional nonce-store replay defense. We wrap the
// throwing API in a { ok, reason } shape so checkout's handler can
// branch on the failure mode without try/catch.

async function _verifyWebhook(headers, rawBody, secret, opts) {
  if (typeof rawBody !== "string") {
    throw new TypeError("payment.verifyWebhook: rawBody must be the request body string (read BEFORE JSON.parse)");
  }
  opts = opts || {};
  // Case-insensitive header lookup so caller framework conventions
  // don't matter (Node http2 = lowercase, Express = preserved case).
  var headerVal = null;
  if (headers && typeof headers === "object") {
    var keys = Object.keys(headers);
    for (var k = 0; k < keys.length; k += 1) {
      if (keys[k].toLowerCase() === "stripe-signature") { headerVal = headers[keys[k]]; break; }
    }
  }
  if (!headerVal) return { ok: false, reason: "no-signature" };

  var toleranceMs = opts.toleranceSeconds == null
    ? STRIPE_WEBHOOK_TOLERANCE * 1000
    : opts.toleranceSeconds * 1000;
  if (typeof toleranceMs !== "number" || !isFinite(toleranceMs) || toleranceMs <= 0) {
    throw new TypeError("payment.verifyWebhook: toleranceSeconds must be a positive number");
  }

  try {
    await _b().webhook.verify({
      alg:         "hmac-sha256-stripe",
      secret:      secret,
      header:      headerVal,
      body:        rawBody,
      toleranceMs: toleranceMs,
      nonceStore:  opts.nonceStore || undefined,
      _nowMs:      opts.now != null ? opts.now * 1000 : undefined,
    });
  } catch (e) {
    var code = (e && e.code) || "";
    var reason = "signature-mismatch";
    if (code === "webhook/stale-timestamp") reason = "timestamp-outside-tolerance";
    else if (code === "webhook/bad-stripe-header") reason = "no-signature";
    else if (code === "webhook/bad-signature") reason = "signature-mismatch";
    else if (code === "webhook/replay-detected") reason = "replay";
    return { ok: false, reason: reason, code: code };
  }

  try {
    return { ok: true, event: JSON.parse(rawBody) };
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
