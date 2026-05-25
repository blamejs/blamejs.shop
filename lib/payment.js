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

var b = require("./vendor/blamejs");
var C = b.constants;

var STRIPE_API_BASE_DEFAULT  = "https://api.stripe.com/v1";
var STRIPE_WEBHOOK_TOLERANCE = 300;   // ± 5 minutes (Stripe default)
var STRIPE_HTTP_TIMEOUT_MS   = 15000;
var CURRENCY_RE              = /^[a-z]{3}$/;   // Stripe wants lowercase ISO 4217

// Stripe holds idempotency keys for 24h, so the local cache row
// expires on the same window — operators who run `cleanupExpired()`
// on a daily schedule keep the table small without ever shortening
// the replay window below Stripe's own retention.
var IDEMPOTENCY_TTL_MS       = C.TIME.days(1);
var IDEMPOTENCY_NAMESPACE    = "payment-idempotency-body";
var IDEMPOTENT_OPERATIONS    = {
  "payment_intent.create": true,
  "refund.create":         true,
  "subscription.create":   true,
  "subscription.update":   true,
  "subscription.cancel":   true,
};

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
    ? STRIPE_WEBHOOK_TOLERANCE * 1000 // allow:raw-time-literal — seconds value; *1000 converts to ms
    : opts.toleranceSeconds * 1000;   // allow:raw-time-literal — runtime seconds value; *1000 converts to ms
  if (typeof toleranceMs !== "number" || !isFinite(toleranceMs) || toleranceMs <= 0) {
    throw new TypeError("payment.verifyWebhook: toleranceSeconds must be a positive number");
  }

  try {
    await b.webhook.verify({
      alg:         "hmac-sha256-stripe",
      secret:      secret,
      header:      headerVal,
      body:        rawBody,
      toleranceMs: toleranceMs,
      nonceStore:  opts.nonceStore || undefined,
      _nowMs:      opts.now != null ? opts.now * 1000 : undefined, // allow:raw-time-literal — opts.now is a runtime seconds value; *1000 converts to ms
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
  var httpClient = opts.httpClient || b.httpClient;
  var res = await httpClient.request({
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
    err._stripeRawText   = text;
    err._stripeStatus    = res.statusCode;
    throw err;
  }
  // Carry the raw status + serialised body alongside the parsed JSON
  // so the idempotency layer can persist them verbatim for replay
  // without re-stringifying (preserves byte-for-byte fidelity with
  // what Stripe returned, including field ordering).
  Object.defineProperty(json, "_stripeStatus",  { value: res.statusCode, enumerable: false });
  Object.defineProperty(json, "_stripeRawText", { value: text,           enumerable: false });
  return json;
}

// ---- Idempotency ----------------------------------------------------------
//
// Canonical-JSON hash. Stable across runtime, OS, node version: sort
// every object key recursively, JSON.stringify the result, then run
// through b.crypto.namespaceHash (SHA3-512). Arrays preserve order
// (their order is semantically meaningful — `items[]` in a Stripe
// subscription is an ordered list of line items).
function _canonicalise(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    var out = [];
    for (var i = 0; i < v.length; i += 1) out.push(_canonicalise(v[i]));
    return out;
  }
  var keys = Object.keys(v).sort();
  var obj  = {};
  for (var k = 0; k < keys.length; k += 1) {
    var val = v[keys[k]];
    if (val === undefined) continue;
    obj[keys[k]] = _canonicalise(val);
  }
  return obj;
}

function _canonicalHash(obj) {
  var canonical = JSON.stringify(_canonicalise(obj == null ? {} : obj));
  return b.crypto.namespaceHash(IDEMPOTENCY_NAMESPACE, canonical);
}

function _assertIdempotencyKey(k) {
  if (typeof k !== "string" || k.length < 8 || k.length > 255) {
    throw new TypeError("payment: idempotency_key must be a string between 8 and 255 characters");
  }
}

// Wraps a single Stripe mutating call in the idempotency cache.
//
//   1. Look up (idempotency_key). If present + same request_hash →
//      replay the stored response verbatim. If present + DIFFERENT
//      request_hash → throw (security: never let a same-key replay
//      with a mutated body pass through).
//   2. Otherwise, call Stripe via `doCall()`. On 2xx, INSERT the
//      response row. On any throw, leave the cache empty — the next
//      call with the same key retries cleanly.
async function _runIdempotent(state, operation, key, requestObj, doCall) {
  _assertIdempotencyKey(key);
  if (!IDEMPOTENT_OPERATIONS[operation]) {
    throw new TypeError("payment: unknown idempotent operation " + JSON.stringify(operation));
  }
  var query        = state.query;
  var now          = state.now();
  var requestHash  = _canonicalHash(requestObj);

  // Replay lookup. The PRIMARY KEY index makes this an O(1) probe.
  var existing = (await query(
    "SELECT request_hash, response_status, response_body " +
    "FROM payment_idempotency WHERE idempotency_key = ?1 LIMIT 1",
    [key],
  )).rows[0];

  if (existing) {
    if (existing.request_hash !== requestHash) {
      // Same key, different body — refuse. Stripe itself would reject
      // this on its own idempotency cache, but we surface a typed
      // application error so the caller doesn't have to ship the
      // request first to discover the collision.
      throw new TypeError("payment: idempotency_key collision (different inputs)");
    }
    var replay = null;
    try { replay = JSON.parse(existing.response_body); } catch (_e) { replay = { _raw: existing.response_body }; }
    Object.defineProperty(replay, "_stripeStatus",  { value: Number(existing.response_status), enumerable: false });
    Object.defineProperty(replay, "_replayed",      { value: true,                              enumerable: false });
    return replay;
  }

  var result = await doCall();
  var status = result && result._stripeStatus ? Number(result._stripeStatus) : 200;
  var rawText = result && result._stripeRawText
    ? result._stripeRawText
    : JSON.stringify(result);

  await query(
    "INSERT INTO payment_idempotency " +
    "(idempotency_key, operation, request_hash, response_status, response_body, created_at, expires_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    [key, operation, requestHash, status, rawText, now, now + IDEMPOTENCY_TTL_MS],
  );

  return result;
}

// ---- adapter --------------------------------------------------------------

function stripe(opts) {
  opts = opts || {};
  _assertSecret(opts.apiKey,        "apiKey");
  _assertSecret(opts.webhookSecret, "webhookSecret");
  if (opts.query != null && typeof opts.query !== "function") {
    throw new TypeError("payment: query must be a function (sql, params) => Promise<{ rows }>");
  }
  if (opts.now != null && typeof opts.now !== "function") {
    throw new TypeError("payment: now must be a function returning current epoch ms");
  }

  // Idempotency state shared across every mutating call. When `query`
  // is not supplied the primitive runs in legacy mode — every
  // mutating call goes straight to Stripe, no cache writes, no
  // collision detection. Operators opt in by passing `query`.
  var state = {
    query: opts.query || null,
    now:   typeof opts.now === "function" ? opts.now : function () { return Date.now(); },
  };

  function _maybeIdempotent(operation, idempotencyKey, requestObj, doCall) {
    if (!state.query || idempotencyKey == null) {
      return doCall();
    }
    return _runIdempotent(state, operation, idempotencyKey, requestObj, doCall);
  }

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
      return _maybeIdempotent("payment_intent.create", idempotencyKey, params, function () {
        return _stripeCall(opts, "POST", "/payment_intents", params, idempotencyKey);
      });
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

    // Register a web domain so Stripe enables the wallet methods (Apple
    // Pay / Google Pay / Link / PayPal) for the Express Checkout Element
    // served from it. Stripe performs Apple merchant validation + hosts
    // the domain-association file — the operator does not need an Apple
    // Developer account. Registering in live mode also registers
    // sandbox. One-shot operator action (admin endpoint). `domainName`
    // is a bare hostname — apex, www, and subdomains register separately.
    registerPaymentMethodDomain: function (domainName, idempotencyKey) {
      if (typeof domainName !== "string" ||
          !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domainName)) {
        throw new TypeError("payment.registerPaymentMethodDomain: domainName must be a bare hostname (no scheme / path / port)");
      }
      return _stripeCall(opts, "POST", "/payment_method_domains", { domain_name: domainName }, idempotencyKey);
    },

    // List registered payment-method domains (optionally filtered to one
    // hostname) with each method's enablement status. Read-only.
    listPaymentMethodDomains: function (filter) {
      filter = filter || {};
      var path = "/payment_method_domains";
      if (filter.domain_name) {
        if (typeof filter.domain_name !== "string") throw new TypeError("payment.listPaymentMethodDomains: domain_name must be a string");
        path += "?domain_name=" + encodeURIComponent(filter.domain_name);
      }
      return _stripeCall(opts, "GET", path, null, null);
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
      return _maybeIdempotent("refund.create", idempotencyKey, params, function () {
        return _stripeCall(opts, "POST", "/refunds", params, idempotencyKey);
      });
    },

    // Stripe Subscriptions API. Operators pre-create the recurring
    // Price in Stripe (the source of truth for pricing); the shop's
    // `subscriptions` primitive stores the price id locally and
    // calls these to bind a customer + price into an active
    // subscription record.
    subscriptions: {
      create: function (input, idempotencyKey) {
        if (!input || typeof input !== "object") throw new TypeError("payment.subscriptions.create: input object required");
        _assertSecret(input.customer, "subscriptions.create.customer");
        if (!Array.isArray(input.items) || input.items.length === 0) {
          throw new TypeError("payment.subscriptions.create: items[] (at least one price) required");
        }
        var params = { customer: input.customer, items: input.items };
        if (input.default_payment_method) params.default_payment_method = input.default_payment_method;
        if (input.trial_period_days != null) {
          _nonNegInt(input.trial_period_days, "trial_period_days");
          params.trial_period_days = input.trial_period_days;
        }
        if (input.metadata) params.metadata = input.metadata;
        if (input.payment_behavior) params.payment_behavior = input.payment_behavior;
        if (input.expand) params.expand = input.expand;
        return _maybeIdempotent("subscription.create", idempotencyKey, params, function () {
          return _stripeCall(opts, "POST", "/subscriptions", params, idempotencyKey);
        });
      },

      retrieve: function (id) {
        _assertSecret(id, "subscription id");
        return _stripeCall(opts, "GET", "/subscriptions/" + encodeURIComponent(id), null, null);
      },

      update: function (id, input, idempotencyKey) {
        _assertSecret(id, "subscription id");
        if (!input || typeof input !== "object") throw new TypeError("payment.subscriptions.update: input object required");
        // The hashed request body includes the subscription id so an
        // update against a DIFFERENT subscription with the same key
        // is detected as a collision (the id is part of the URL,
        // not the body Stripe sees, but it's part of the semantic
        // request — replaying against a different sub_ would be the
        // same security hole as replaying with a different amount).
        var hashBody = { _id: id, body: input };
        return _maybeIdempotent("subscription.update", idempotencyKey, hashBody, function () {
          return _stripeCall(opts, "POST", "/subscriptions/" + encodeURIComponent(id), input, idempotencyKey);
        });
      },

      cancel: function (id, opts2, idempotencyKey) {
        _assertSecret(id, "subscription id");
        opts2 = opts2 || {};
        var atPeriodEnd = !!opts2.at_period_end;
        var hashBody = { _id: id, at_period_end: atPeriodEnd };
        return _maybeIdempotent("subscription.cancel", idempotencyKey, hashBody, function () {
          if (atPeriodEnd) {
            // Stripe modeled "cancel at period end" as an UPDATE so the
            // subscription stays active through the current billing
            // window; DELETE is for immediate end-of-life.
            return _stripeCall(opts, "POST", "/subscriptions/" + encodeURIComponent(id),
                                { cancel_at_period_end: true }, idempotencyKey);
          }
          return _stripeCall(opts, "DELETE", "/subscriptions/" + encodeURIComponent(id), null, idempotencyKey);
        });
      },
    },

    // Purges every expired idempotency row. Operators wire this into
    // a daily schedule (cron, scheduled Worker, etc.) — the table
    // grows by at most one row per mutating call per 24h window and
    // a daily sweep keeps the high-water mark bounded. Returns the
    // number of rows removed so the operator can alert on a sudden
    // spike.
    cleanupExpired: async function () {
      if (!state.query) {
        throw new TypeError("payment.cleanupExpired: requires `query` factory opt — idempotency cache is opt-in");
      }
      var cutoff = state.now();
      var r = await state.query(
        "DELETE FROM payment_idempotency WHERE expires_at < ?1",
        [cutoff],
      );
      // D1's DELETE result shape exposes `meta.changes`; fall back to
      // `rowsAffected` for adapters that surface it differently.
      if (r && r.meta && typeof r.meta.changes === "number") return r.meta.changes;
      if (r && typeof r.rowsAffected === "number")           return r.rowsAffected;
      if (r && typeof r.changes      === "number")           return r.changes;
      return 0;
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
  IDEMPOTENCY_TTL_MS:        IDEMPOTENCY_TTL_MS,
  // Exposed for tests + Worker to share form-encoding shape.
  _formEncode:               _formEncode,
  _verifyWebhook:            _verifyWebhook,
  _canonicalHash:            _canonicalHash,
};
