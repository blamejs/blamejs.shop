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
  // PayPal adapter mutating operations (Orders v2).
  "paypal_order.create":   true,
  "paypal_capture.create": true,
  "paypal_refund.create":  true,
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

// ---- PayPal adapter -------------------------------------------------------
//
// PayPal Orders v2 over `b.httpClient`. Two structural differences from the
// Stripe adapter: (1) every call needs an OAuth2 client-credentials access
// token, exchanged up front and cached until it nears expiry; (2) webhook
// verification is a server-to-server call to PayPal's own
// verify-webhook-signature API — PayPal has no offline-HMAC shape like
// Stripe's. Outbound goes through `b.httpClient` (SSRF-gated, retried); the
// shared `_runIdempotent` cache applies when `query` is wired.
var PAYPAL_API_BASE_LIVE    = "https://api-m.paypal.com";
var PAYPAL_API_BASE_SANDBOX = "https://api-m.sandbox.paypal.com";
var PAYPAL_HTTP_TIMEOUT_MS  = 15000;
var PAYPAL_TOKEN_SKEW_MS    = C.TIME.minutes(2); // refresh this far before expiry

// PayPal rejects decimal places for these currencies; everything else is
// 2-decimal. Amounts cross the wire as decimal strings in MAJOR units.
var PAYPAL_ZERO_DECIMAL     = { HUF: true, JPY: true, TWD: true };

function _paypalApiBase(opts) {
  if (opts.apiBase) return opts.apiBase.replace(/\/$/, "");
  return opts.sandbox ? PAYPAL_API_BASE_SANDBOX : PAYPAL_API_BASE_LIVE;
}

function _minorToDecimalString(minor, currency) {
  var dec = PAYPAL_ZERO_DECIMAL[currency] ? 0 : 2;
  var neg = minor < 0;
  var s = String(Math.abs(minor));
  if (dec === 0) return (neg ? "-" : "") + s;
  while (s.length <= dec) s = "0" + s;
  return (neg ? "-" : "") + s.slice(0, s.length - dec) + "." + s.slice(s.length - dec);
}

function _headerCI(headers, name) {
  if (!headers) return undefined;
  if (headers[name] != null) return headers[name];
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

async function _paypalToken(opts, state) {
  var now = state.now();
  if (state.token && now < state.tokenExpiresAt) return state.token;
  var httpClient = opts.httpClient || b.httpClient;
  var basic = Buffer.from(opts.clientId + ":" + opts.secret).toString("base64");
  var res = await httpClient.request({
    method:  "POST",
    url:     _paypalApiBase(opts) + "/v1/oauth2/token",
    headers: {
      "authorization":  "Basic " + basic,
      "accept":         "application/json",
      "content-type":   "application/x-www-form-urlencoded",
      "user-agent":     "blamejs-shop (zero-dep)",
    },
    body:      "grant_type=client_credentials",
    timeoutMs: opts.timeoutMs || PAYPAL_HTTP_TIMEOUT_MS,
  });
  var text = res.body && res.body.toString ? res.body.toString("utf8") : "";
  var json; try { json = text.length ? JSON.parse(text) : {}; } catch (_e) { json = {}; }
  if (res.statusCode < 200 || res.statusCode >= 300 || !json.access_token) {
    var err = new Error("paypal: OAuth2 token exchange failed → HTTP " + res.statusCode +
                        (json && json.error_description ? " — " + json.error_description : ""));
    err.code = "PAYPAL_AUTH_" + res.statusCode;
    err.statusCode = res.statusCode;
    throw err;
  }
  state.token = json.access_token;
  var ttlMs = (typeof json.expires_in === "number" ? json.expires_in : 0) * 1000; // allow:raw-time-literal — PayPal expires_in is a runtime seconds value; *1000 → ms
  state.tokenExpiresAt = now + Math.max(0, ttlMs - PAYPAL_TOKEN_SKEW_MS);
  return state.token;
}

async function _paypalCall(opts, state, method, path, bodyObj, requestId) {
  var token = await _paypalToken(opts, state);
  var headers = {
    "authorization": "Bearer " + token,
    "accept":        "application/json",
    "content-type":  "application/json",
    "user-agent":    "blamejs-shop (zero-dep)",
  };
  if (requestId) headers["paypal-request-id"] = requestId;
  var body = bodyObj != null ? JSON.stringify(bodyObj) : undefined;
  if (body) headers["content-length"] = Buffer.byteLength(body, "utf8");
  var httpClient = opts.httpClient || b.httpClient;
  var res = await httpClient.request({
    method:    method,
    url:       _paypalApiBase(opts) + path,
    headers:   headers,
    body:      body,
    timeoutMs: opts.timeoutMs || PAYPAL_HTTP_TIMEOUT_MS,
  });
  var text = res.body && res.body.toString ? res.body.toString("utf8") : "";
  var json; try { json = text.length ? JSON.parse(text) : {}; } catch (_e) { json = { _raw: text }; }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    var detail = json && (json.message || (json.details && json.details[0] && json.details[0].description)) || "";
    var err = new Error("paypal: " + method + " " + path + " → HTTP " + res.statusCode + (detail ? " — " + detail : ""));
    err.code = (json && json.name) || "PAYPAL_HTTP_" + res.statusCode;
    err.statusCode = res.statusCode;
    err.paypal = json || null;
    throw err;
  }
  Object.defineProperty(json, "_paypalStatus",  { value: res.statusCode, enumerable: false });
  Object.defineProperty(json, "_paypalRawText", { value: text,           enumerable: false });
  return json;
}

function paypal(opts) {
  opts = opts || {};
  _assertSecret(opts.clientId, "clientId");
  _assertSecret(opts.secret,   "secret");
  if (opts.query != null && typeof opts.query !== "function") {
    throw new TypeError("payment: query must be a function (sql, params) => Promise<{ rows }>");
  }
  if (opts.now != null && typeof opts.now !== "function") {
    throw new TypeError("payment: now must be a function returning current epoch ms");
  }
  var state = {
    query:          opts.query || null,
    now:            typeof opts.now === "function" ? opts.now : function () { return Date.now(); },
    token:          null,
    tokenExpiresAt: 0,
  };

  function _maybeIdempotent(operation, idempotencyKey, requestObj, doCall) {
    if (!state.query || idempotencyKey == null) return doCall();
    return _runIdempotent(state, operation, idempotencyKey, requestObj, doCall);
  }

  function _amount(input, label) {
    _positiveInt(input.amount_minor, "amount_minor");
    if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
      throw new TypeError("payment." + label + ": currency must be a 3-letter uppercase ISO 4217 code");
    }
    return { currency_code: input.currency, value: _minorToDecimalString(input.amount_minor, input.currency) };
  }

  return {
    name: "paypal",

    // Create an Orders-v2 order (intent CAPTURE). The returned `id` is the
    // PayPal order id the buyer approves; `captureOrder` finalizes it.
    createOrder: function (input, idempotencyKey) {
      if (!input || typeof input !== "object") throw new TypeError("payment.createOrder: input object required");
      var bodyObj = {
        intent: "CAPTURE",
        purchase_units: [{
          amount:     _amount(input, "createOrder"),
          custom_id:  input.order_id || undefined,
          invoice_id: input.invoice_id || undefined,
        }],
      };
      if (input.return_url || input.cancel_url) {
        bodyObj.payment_source = { paypal: { experience_context: {
          return_url: input.return_url || undefined,
          cancel_url: input.cancel_url || undefined,
        } } };
      }
      var requestId = "order:" + (input.order_id || idempotencyKey || b.uuid.v7());
      return _maybeIdempotent("paypal_order.create", idempotencyKey, { op: "createOrder", input: input }, function () {
        return _paypalCall(opts, state, "POST", "/v2/checkout/orders", bodyObj, requestId);
      });
    },

    // Capture an approved order. Returns the capture resource (the
    // `purchase_units[0].payments.captures[0].id` is the capture id refunds
    // reference).
    captureOrder: function (orderId, idempotencyKey) {
      if (typeof orderId !== "string" || !orderId.length) throw new TypeError("payment.captureOrder: orderId required");
      var requestId = "capture:" + orderId + (idempotencyKey ? ":" + idempotencyKey : "");
      return _maybeIdempotent("paypal_capture.create", idempotencyKey, { op: "captureOrder", orderId: orderId }, function () {
        return _paypalCall(opts, state, "POST", "/v2/checkout/orders/" + encodeURIComponent(orderId) + "/capture", {}, requestId);
      });
    },

    getOrder: function (orderId) {
      if (typeof orderId !== "string" || !orderId.length) throw new TypeError("payment.getOrder: orderId required");
      return _paypalCall(opts, state, "GET", "/v2/checkout/orders/" + encodeURIComponent(orderId), null, null);
    },

    // Refund a capture — full when no amount is given, partial with
    // { amount_minor, currency }.
    refund: function (input, idempotencyKey) {
      if (!input || typeof input !== "object") throw new TypeError("payment.refund: input object required");
      if (typeof input.capture_id !== "string" || !input.capture_id.length) {
        throw new TypeError("payment.refund: capture_id required");
      }
      var bodyObj = {};
      if (input.amount_minor != null) bodyObj.amount = _amount(input, "refund");
      if (input.note_to_payer) bodyObj.note_to_payer = input.note_to_payer;
      if (input.invoice_id)    bodyObj.invoice_id = input.invoice_id;
      // Multiple partial refunds on the SAME capture are legitimate + distinct,
      // so the PayPal-Request-Id (PayPal's idempotency identity) must be unique
      // per call by default — reusing `capture_id` alone would make PayPal
      // replay the first refund instead of executing the next. A caller that
      // wants a retry deduplicated passes an explicit idempotencyKey (or
      // input.idempotency_suffix); otherwise a fresh uuid keeps each refund
      // its own request. (createOrder / captureOrder stay stable on purpose —
      // retrying those SHOULD be idempotent.)
      var requestId = "refund:" + input.capture_id + ":" + (idempotencyKey || input.idempotency_suffix || b.uuid.v7());
      return _maybeIdempotent("paypal_refund.create", idempotencyKey, { op: "refund", input: input }, function () {
        return _paypalCall(opts, state, "POST",
          "/v2/payments/captures/" + encodeURIComponent(input.capture_id) + "/refund", bodyObj, requestId);
      });
    },

    // Verify an inbound webhook by calling PayPal's verify-webhook-signature
    // API with the transmission headers + the configured webhook id + the
    // event body. Returns { ok, event } on a SUCCESS verification status,
    // { ok:false, reason } otherwise (drop-silent — never throws).
    verifyWebhook: async function (headers, rawBody, vOpts) {
      var webhookId = (vOpts && vOpts.webhookId) || opts.webhookId;
      if (!webhookId) return { ok: false, reason: "no-webhook-id" };
      var authAlgo        = _headerCI(headers, "paypal-auth-algo");
      var certUrl         = _headerCI(headers, "paypal-cert-url");
      var transmissionId  = _headerCI(headers, "paypal-transmission-id");
      var transmissionSig = _headerCI(headers, "paypal-transmission-sig");
      var transmissionTime= _headerCI(headers, "paypal-transmission-time");
      if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
        return { ok: false, reason: "missing-transmission-headers" };
      }
      var event;
      try { event = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody; }
      catch (_e) { return { ok: false, reason: "malformed-body" }; }
      var verifyBody = {
        auth_algo:         authAlgo,
        cert_url:          certUrl,
        transmission_id:   transmissionId,
        transmission_sig:  transmissionSig,
        transmission_time: transmissionTime,
        webhook_id:        webhookId,
        webhook_event:     event,
      };
      var res;
      try { res = await _paypalCall(opts, state, "POST", "/v1/notifications/verify-webhook-signature", verifyBody, null); }
      catch (e) { return { ok: false, reason: "verify-call-failed", error: e && e.message }; }
      if (res && res.verification_status === "SUCCESS") return { ok: true, event: event };
      return { ok: false, reason: "verification-status-" + ((res && res.verification_status) || "unknown") };
    },
  };
}

function create(opts) {
  opts = opts || {};
  var adapter = opts.adapter || "stripe";
  if (adapter === "stripe") return stripe(opts);
  if (adapter === "paypal") return paypal(opts);
  throw new TypeError("payment.create: unknown adapter " + JSON.stringify(opts.adapter) + " — 'stripe' and 'paypal' are supported");
}

module.exports = {
  create:                    create,
  stripe:                    stripe,
  paypal:                    paypal,
  STRIPE_WEBHOOK_TOLERANCE:  STRIPE_WEBHOOK_TOLERANCE,
  IDEMPOTENCY_TTL_MS:        IDEMPOTENCY_TTL_MS,
  // Exposed for tests + Worker to share form-encoding shape.
  _formEncode:               _formEncode,
  _verifyWebhook:            _verifyWebhook,
  _canonicalHash:            _canonicalHash,
};
