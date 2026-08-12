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
 *   cancel + Refund) on `b.httpClient` (SSRF-gated, response-capped,
 *   ALPN HTTP/2). Each adapter instance wraps its dials in a per-upstream
 *   `b.circuitBreaker` plus a bounded `b.retry` (the latter only on
 *   idempotent dials — GET reads + idempotency-keyed writes — so a
 *   transient blip never re-sends a one-shot charge). While the breaker is
 *   open the dial fast-fails with `code: "CIRCUIT_OPEN"` BEFORE the
 *   request, so checkout renders the recoverable payment-unavailable page
 *   rather than stranding an order mid-charge. No `stripe` npm dep — every
 *   byte is either node built-in or vendored blamejs primitive.
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

// The processor dials carry no caller-supplied TLS agent. They used to: the
// framework's outbound group list was once hybrid-only, and api.stripe.com
// answered that ClientHello with handshake_failure (TLS alert 40), so these
// three dials pinned an explicitly-built agent on Node's default groups to
// keep checkout working. That list now ends in classical X25519 as a
// last-resort floor, so the framework's own posture already negotiates with
// both processors, and the pinned agent had become a downgrade rather than a
// workaround — it forced classical key exchange on a peer that offers an
// ML-KEM hybrid, and it bypassed the client's post-handshake downgrade
// auditing. Without an agent the vendored client builds its own through
// b.pqcAgent, which locks the key exchange to b.network.tls.outboundPosture()
// and therefore follows b.network.tls.preferredGroups.set(...) at runtime.
var STRIPE_API_BASE_DEFAULT  = "https://api.stripe.com/v1";
var STRIPE_WEBHOOK_TOLERANCE = 300;   // ± 5 minutes (Stripe default)
var STRIPE_HTTP_TIMEOUT_MS   = 15000;
var CURRENCY_RE              = /^[a-z]{3}$/;   // Stripe wants lowercase ISO 4217

// ---- PSP dial resilience (circuit breaker + bounded retry) ----------------
//
// b.httpClient does NOT itself circuit-break or retry — it SSRF-gates, caps,
// and pools, but the failure-threshold breaker + backoff retry are separate
// primitives a consumer composes around it. Each adapter instance owns ONE
// breaker per upstream (Stripe / PayPal): per-target is the only correct
// scope — sharing a breaker across unrelated peers defeats the
// failure-threshold semantic.
//
// Open-circuit posture: while the breaker is open every dial fast-fails with
// a plain Error carrying `code: "CIRCUIT_OPEN"` (NOT a TypeError), so the
// storefront's checkout handler renders it through the existing recoverable
// "checkout didn't go through" page — the same structured payment-unavailable
// surface a raw upstream 5xx already produces — rather than charging or
// 400-ing a field. Nothing is captured: the breaker fails BEFORE the dial, so
// no order is stranded mid-charge.
//
// Retry rides ONLY on idempotent dials — GET reads and writes carrying an
// idempotency key (Stripe Idempotency-Key / PayPal-Request-Id). A
// keyless POST is sent exactly once: re-driving it could double-charge.
var BREAKER_FAILURE_THRESHOLD = 5;                 // consecutive failures before opening
var BREAKER_COOLDOWN_MS       = C.TIME.seconds(30); // open → half-open probe delay
var BREAKER_SUCCESS_THRESHOLD = 2;                 // half-open probes to re-close
var DIAL_RETRY_MAX_ATTEMPTS   = 3;                 // total tries incl. first (idempotent only)
var DIAL_RETRY_BASE_DELAY_MS  = 200;
var DIAL_RETRY_MAX_DELAY_MS   = C.TIME.seconds(2);

// One breaker per adapter instance. `idempotent` selects whether the dial
// also rides the bounded backoff retry — the breaker counts the retry loop's
// FINAL outcome as a single call (b.retry.withBreaker), so a transient blip
// that the retry rides out never inflates the failure counter.
function _makeBreaker(name) {
  return b.circuitBreaker.create({
    name:             name,
    failureThreshold: BREAKER_FAILURE_THRESHOLD,
    cooldownMs:       BREAKER_COOLDOWN_MS,
    successThreshold: BREAKER_SUCCESS_THRESHOLD,
  });
}

function _dial(breaker, idempotent, fn) {
  if (!breaker) return fn();
  if (!idempotent) return breaker.wrap(fn);
  return b.retry.withBreaker(fn, {
    breaker: breaker,
    retry:   {
      maxAttempts: DIAL_RETRY_MAX_ATTEMPTS,
      baseDelayMs: DIAL_RETRY_BASE_DELAY_MS,
      maxDelayMs:  DIAL_RETRY_MAX_DELAY_MS,
    },
  });
}

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
  "customer.create":       true,
  "setup_intent.create":   true,
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

// ---- egress hardening + outbound idempotency-key validation ----------------
//
// b.httpClient already routes every dial through b.ssrfGuard (private /
// loopback / link-local / reserved / cloud-metadata IP classes refused) and
// pins the TCP connect to the guard's resolved IP set, so DNS rebinding can't
// flip the answer between check and connect. (These dials no longer supply a
// caller-built TLS agent at all — see the note at the head of this file — so
// the pinning applies to the framework's own client.) The remaining gap is a
// HOST allowlist: nothing today
// stops an `opts.apiBase` pointed at an unexpected public host (config
// injection, or a future code path that derives the base from request data)
// from reaching a non-PSP upstream. We pin `allowedHosts` to the configured
// PSP host on every dial so a compromised process can only ever talk to the
// host the adapter was constructed against — defense-in-depth layered on top
// of the IP-class SSRF gate.

// Extract the lowercase hostname from a PSP base URL. Throws a TypeError on a
// non-string / non-https / hostless base — config-time validation (entry
// point), so an operator's typo'd apiBase surfaces at adapter construction
// rather than on the first charge.
function _pspHost(baseUrl, label) {
  if (typeof baseUrl !== "string" || !baseUrl.length) {
    throw new TypeError("payment: " + label + " must be a non-empty URL string");
  }
  var parsed;
  try { parsed = new URL(baseUrl); } catch (_e) {
    throw new TypeError("payment: " + label + " must be a valid absolute URL (got " + JSON.stringify(baseUrl) + ")");
  }
  if (parsed.protocol !== "https:") {
    throw new TypeError("payment: " + label + " must be https (a payment processor is never dialed over plaintext)");
  }
  if (!parsed.hostname) {
    throw new TypeError("payment: " + label + " has no hostname");
  }
  return parsed.hostname.toLowerCase();
}

// Validate + normalize an idempotency key that crosses the wire as an
// outbound header (Stripe `Idempotency-Key` / PayPal `PayPal-Request-Id`).
// Composes b.guardIdempotencyKey (strict profile): bounded length, control-
// char / path-traversal / slash refusal, ASCII-only — so a key carrying a
// log-injection or traversal shape never reaches the processor or the local
// replay cache. Returns the validated key; throws TypeError on refusal (the
// caller's bad-shape path is a clean 400, matching every other field guard).
function _assertOutboundKey(key, label) {
  try {
    return b.guardIdempotencyKey.validate(key, { profile: "strict" });
  } catch (e) {
    throw new TypeError("payment: " + (label || "idempotency key") + " — " + ((e && e.message) || "invalid idempotency key"));
  }
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
    return { ok: true, event: b.safeJson.parse(rawBody) };
  } catch (_e) {
    return { ok: false, reason: "bad-json" };
  }
}

// ---- Stripe API call ------------------------------------------------------

async function _stripeCall(opts, method, path, params, idempotencyKey) {
  var apiBase = opts.apiBase || STRIPE_API_BASE_DEFAULT;
  var url = apiBase + path;
  // Pin the dial to the configured Stripe host (computed once per adapter).
  // Layered on top of b.httpClient's IP-class SSRF gate — the process can
  // only ever reach the host the adapter was built against.
  if (opts._allowedHost === undefined) opts._allowedHost = _pspHost(apiBase, "apiBase");
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
    // The key crosses the wire as the `Idempotency-Key` header — validate +
    // refuse traversal / control-char / oversize shapes before it leaves.
    headers["idempotency-key"] = _assertOutboundKey(idempotencyKey, "idempotency_key");
  }
  var httpClient = opts.httpClient || b.httpClient;
  // A GET read is always idempotent; a write is idempotent only when it
  // carries an Idempotency-Key (Stripe dedupes a replay of the SAME key
  // server-side). A keyless POST rides the breaker but NOT the retry, so
  // a transient blip never re-sends it (double-charge guard).
  var idempotent = method === "GET" || !!idempotencyKey;
  // The HTTP request AND the non-2xx → throw both run INSIDE the dialed
  // closure so the breaker counts a 5xx / transport error as a failure
  // (and the idempotent-path retry retries it). A 4xx is the request's
  // fault, not the peer's health — `err.statusCode` makes the retry
  // classifier skip it, and a 4xx still increments the breaker, which is
  // acceptable since a sustained stream of 4xx is itself a degraded state.
  var json = await _dial(opts._breaker, idempotent, async function () {
    var res = await httpClient.request({
      method:       method,
      url:          url,
      headers:      headers,
      body:         body || undefined,
      timeoutMs:    opts.timeoutMs || STRIPE_HTTP_TIMEOUT_MS,
      allowedHosts: [opts._allowedHost],
    });
    var text = res.body && res.body.toString ? res.body.toString("utf8") : "";
    var parsed = null;
    try { parsed = text.length ? b.safeJson.parse(text) : {}; } catch (_e) { parsed = { _raw: text }; }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      var err = new Error("stripe: " + method + " " + path + " → HTTP " + res.statusCode +
                          (parsed && parsed.error && parsed.error.message ? " — " + parsed.error.message : ""));
      err.code = (parsed && parsed.error && parsed.error.code) || "STRIPE_HTTP_" + res.statusCode;
      err.statusCode = res.statusCode;
      err.stripe = parsed && parsed.error || null;
      err._stripeRawText   = text;
      err._stripeStatus    = res.statusCode;
      throw err;
    }
    // Carry the raw status + serialised body alongside the parsed JSON
    // so the idempotency layer can persist them verbatim for replay
    // without re-stringifying (preserves byte-for-byte fidelity with
    // what Stripe returned, including field ordering).
    Object.defineProperty(parsed, "_stripeStatus",  { value: res.statusCode, enumerable: false });
    Object.defineProperty(parsed, "_stripeRawText", { value: text,           enumerable: false });
    return parsed;
  });
  return json;
}

// ---- Idempotency ----------------------------------------------------------
//
// Canonical-JSON hash. Stable across runtime, OS, node version: sort
// every object key recursively, JSON.stringify the result, then run
// through b.crypto.namespaceHash (SHA3-512). Arrays preserve order
// (their order is semantically meaningful — `items[]` in a Stripe
// subscription is an ordered list of line items).
// Drop undefined object members recursively. Idempotency treats an undefined
// member as omitted — two requests that differ only by an explicit `undefined`
// must hash the same — and the vendored canonical primitive would otherwise
// emit `undefined` as `null` (b.safeJson.canonical throws outright). Array
// order is preserved (an `items[]` list is semantically ordered). This is a
// SEMANTIC pre-filter only; the canonical sort + escaping + number format is
// delegated to the canonical-JSON primitive below, not hand-rolled.
function _dropUndefinedMembers(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    var out = [];
    for (var i = 0; i < v.length; i += 1) out.push(_dropUndefinedMembers(v[i]));
    return out;
  }
  var keys = Object.keys(v);
  var obj  = {};
  for (var k = 0; k < keys.length; k += 1) {
    var val = v[keys[k]];
    if (val === undefined) continue;
    obj[keys[k]] = _dropUndefinedMembers(val);
  }
  return obj;
}

function _canonicalHash(obj) {
  // Compose the vendored canonical-JSON primitive (RFC-8785-style sorted-key
  // emission) for deterministic bytes, replacing the hand-rolled key sort.
  var canonical = b.canonicalJson.stringify(_dropUndefinedMembers(obj == null ? {} : obj));
  return b.crypto.namespaceHash(IDEMPOTENCY_NAMESPACE, canonical);
}

// Pre-primitive request-hash encoding, retained ONLY to recognise idempotency
// rows that an earlier release wrote with the hand-rolled canonicaliser. The
// request_hash column is persisted and compared on replay, so without this a
// same-key retry issued across the upgrade boundary would be refused as a
// false collision until the row's 1-day TTL elapsed. New rows always store the
// primitive-composed _canonicalHash; this fallback is compare-only and is safe
// to delete once a full IDEMPOTENCY_TTL_MS has elapsed after deploy (by then
// every legacy-encoded row has expired).
function _legacyCanonicalise(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    var out = [];
    for (var i = 0; i < v.length; i += 1) out.push(_legacyCanonicalise(v[i]));
    return out;
  }
  var keys = Object.keys(v).sort();
  var obj  = {};
  for (var k = 0; k < keys.length; k += 1) {
    var val = v[keys[k]];
    if (val === undefined) continue;
    obj[keys[k]] = _legacyCanonicalise(val);
  }
  return obj;
}

function _legacyCanonicalHash(obj) {
  return b.crypto.namespaceHash(IDEMPOTENCY_NAMESPACE, JSON.stringify(_legacyCanonicalise(obj == null ? {} : obj)));
}

// A stored request_hash matches when it equals the current primitive-composed
// hash OR (transition fallback) the legacy encoding's hash for the same body.
function _requestHashMatches(storedHash, requestObj) {
  if (storedHash === _canonicalHash(requestObj)) return true;
  return storedHash === _legacyCanonicalHash(requestObj);
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
    if (!_requestHashMatches(existing.request_hash, requestObj)) {
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

  // Atomic claim: two concurrent same-key calls both miss the lookup above
  // and both reach here — ON CONFLICT DO NOTHING lets exactly one cache its
  // response while the loser defers to the winner's row instead of dying on
  // the PRIMARY KEY violation. Never OR REPLACE / DO UPDATE: the loser must
  // not overwrite the winner's cached response, and a same-key racer with a
  // DIFFERENT body must still hit the collision refusal below.
  var ins = await query(
    "INSERT INTO payment_idempotency " +
    "(idempotency_key, operation, request_hash, response_status, response_body, created_at, expires_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
    "ON CONFLICT(idempotency_key) DO NOTHING",
    [key, operation, requestHash, status, rawText, now, now + IDEMPOTENCY_TTL_MS],
  );
  var changes = ins && (ins.rowCount != null ? ins.rowCount
    : (ins.meta && ins.meta.changes != null ? ins.meta.changes : ins.changes));
  if (Number(changes || 0) === 0) {
    // A concurrent call claimed the key first. Replay its cached row —
    // unless our request body differs, which is the same collision the
    // up-front check refuses.
    var winner = (await query(
      "SELECT request_hash, response_status, response_body " +
      "FROM payment_idempotency WHERE idempotency_key = ?1 LIMIT 1",
      [key],
    )).rows[0];
    if (winner && !_requestHashMatches(winner.request_hash, requestObj)) {
      throw new TypeError("payment: idempotency_key collision (different inputs)");
    }
    if (winner) {
      var winnerReplay = null;
      try { winnerReplay = JSON.parse(winner.response_body); } catch (_e) { winnerReplay = { _raw: winner.response_body }; }
      Object.defineProperty(winnerReplay, "_stripeStatus", { value: Number(winner.response_status), enumerable: false });
      Object.defineProperty(winnerReplay, "_replayed",     { value: true,                            enumerable: false });
      return winnerReplay;
    }
    // Conflicted but the row vanished (TTL purge between the two
    // statements) — fall through: our own result is still the outcome.
  }

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

  // One circuit breaker per adapter instance, guarding every Stripe dial.
  // Stashed on opts so the module-level `_stripeCall` reaches it without a
  // signature change. Skippable in tests via `breaker: false`.
  if (opts._breaker === undefined) {
    opts._breaker = opts.breaker === false ? null : _makeBreaker("psp-stripe");
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

    // The per-adapter circuit breaker (or null when disabled). Exposed so
    // an operator dashboard can read `breaker.getState()` ("closed" /
    // "open" / "half") and reset it after a confirmed recovery.
    breaker: opts._breaker,

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
      // Saved-card reuse: a stored payment_method drives an off-session
      // (one-click) charge. Both are optional so the default Elements flow
      // — no payment_method, automatic_payment_methods.enabled — is
      // byte-identical. When a payment_method is supplied we confirm
      // immediately (confirm:true) so the stored card is charged in the
      // single create call rather than requiring a second client round trip.
      if (input.payment_method) {
        if (typeof input.payment_method !== "string" || !input.payment_method.length) {
          throw new TypeError("payment.createPaymentIntent: payment_method must be a non-empty string");
        }
        params.payment_method = input.payment_method;
        params.confirm = true;
        if (input.off_session) params.off_session = true;
      }
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

    // ---- Customer + SetupIntent (saved-card vaulting) ---------------------
    //
    // The card-on-file flow needs a Stripe Customer to attach the saved
    // payment method to, plus a SetupIntent the browser confirms (off the
    // Elements card form) to collect-without-charging. The shop persists
    // only the resulting opaque `pm_…` token — never the PAN/CVV, which
    // stay inside Stripe's PCI scope. `usage: "off_session"` so the saved
    // card is reusable for a later one-click (off-session) charge.

    // Create (or look up) a Stripe Customer for a shopper. `email` is the
    // only field Stripe needs to dedupe; `metadata` carries the shop's own
    // customer id so a Stripe-dashboard operator can correlate the two.
    createCustomer: function (input, idempotencyKey) {
      if (!input || typeof input !== "object") throw new TypeError("payment.createCustomer: input object required");
      var params = {};
      if (input.email != null) {
        if (typeof input.email !== "string" || !input.email.length) {
          throw new TypeError("payment.createCustomer: email must be a non-empty string when provided");
        }
        params.email = input.email;
      }
      if (input.name) params.name = input.name;
      if (input.metadata) params.metadata = input.metadata;
      return _maybeIdempotent("customer.create", idempotencyKey, params, function () {
        return _stripeCall(opts, "POST", "/customers", params, idempotencyKey);
      });
    },

    // Open a SetupIntent for the given Stripe Customer. The browser's
    // Elements confirms it against the entered card; on success Stripe
    // returns a `pm_…` the shop reads back via retrieveSetupIntent →
    // retrievePaymentMethod and stores through paymentMethods.add.
    createSetupIntent: function (input, idempotencyKey) {
      if (!input || typeof input !== "object") throw new TypeError("payment.createSetupIntent: input object required");
      _assertSecret(input.customer, "createSetupIntent.customer");
      var params = {
        customer: input.customer,
        automatic_payment_methods: { enabled: true },
        usage: "off_session",
      };
      if (input.metadata) params.metadata = input.metadata;
      return _maybeIdempotent("setup_intent.create", idempotencyKey, params, function () {
        return _stripeCall(opts, "POST", "/setup_intents", params, idempotencyKey);
      });
    },

    // Read a SetupIntent back (after the browser confirmed it) to learn the
    // resulting payment_method id. Read-only.
    retrieveSetupIntent: function (id) {
      _assertSecret(id, "setup_intent id");
      return _stripeCall(opts, "GET", "/setup_intents/" + encodeURIComponent(id), null, null);
    },

    // Read a saved payment method's display fields (brand / last4 /
    // exp_month / exp_year) so the shop can render "ending in 4242". The
    // PAN/CVV are never in this payload. Read-only.
    retrievePaymentMethod: function (id) {
      _assertSecret(id, "payment_method id");
      return _stripeCall(opts, "GET", "/payment_methods/" + encodeURIComponent(id), null, null);
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
// How far before expiry the token manager re-fetches. Two minutes rather than
// the primitive's default minute, so a token cannot expire mid-checkout on a
// slow Orders-v2 round trip.
// allow:raw-time-literal — clientCredentialsManager takes refreshSkewSec in
// SECONDS; C.TIME returns milliseconds and cannot express this argument.
var PAYPAL_TOKEN_SKEW_SEC   = 120;

// PayPal rejects decimal places for these currencies; everything else is
// 2-decimal. Amounts cross the wire as decimal strings in MAJOR units.
var PAYPAL_ZERO_DECIMAL     = { HUF: true, JPY: true, TWD: true };

function _paypalApiBase(opts) {
  if (opts.apiBase) return opts.apiBase.replace(/\/$/, "");
  return opts.sandbox ? PAYPAL_API_BASE_SANDBOX : PAYPAL_API_BASE_LIVE;
}

// The PayPal host the adapter is allowed to dial (computed once, cached on
// opts). Pins every PayPal dial — token exchange + Orders-v2 — to the
// configured host, layered on b.httpClient's IP-class SSRF gate.
function _paypalAllowedHost(opts) {
  if (opts._allowedHost === undefined) opts._allowedHost = _pspHost(_paypalApiBase(opts), "apiBase");
  return opts._allowedHost;
}

function _minorToDecimalString(minor, currency) {
  var dec = PAYPAL_ZERO_DECIMAL[currency] ? 0 : 2;
  var neg = minor < 0;
  var s = String(Math.abs(minor));
  if (dec === 0) return (neg ? "-" : "") + s;
  while (s.length <= dec) s = "0" + s;
  return (neg ? "-" : "") + s.slice(0, s.length - dec) + "." + s.slice(s.length - dec);
}

// Inverse of _minorToDecimalString: parse a PayPal decimal amount string
// (e.g. webhook `resource.amount.value`) into exact integer minor units,
// using the same zero-decimal currency table. STRICT — money parsed off an
// inbound webhook decides refund accounting, so a malformed shape throws a
// TypeError rather than guessing (the caller maps that to a 5xx so the
// processor re-delivers; a guessed amount would silently mis-credit). Pure
// digit-string arithmetic — the value never passes through a float.
function _decimalToMinor(value, currency) {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("payment: decimal amount currency must be a 3-letter uppercase ISO 4217 code");
  }
  if (typeof value !== "string" || !/^\d{1,15}(\.\d{1,2})?$/.test(value)) {
    throw new TypeError("payment: decimal amount must be a plain non-negative decimal string (got " + JSON.stringify(value) + ")");
  }
  var dec   = PAYPAL_ZERO_DECIMAL[currency] ? 0 : 2;
  var parts = value.split(".");
  var frac  = parts[1] || "";
  if (frac.length > dec) {
    // More fractional digits than the currency carries (e.g. "100.50" JPY)
    // is a garbled amount, not a roundable one — refuse, never round money.
    throw new TypeError("payment: decimal amount " + JSON.stringify(value) + " has more fractional digits than " + currency + " allows");
  }
  while (frac.length < dec) frac += "0";
  return parseInt(parts[0] + frac, 10);
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

// The PayPal client-credentials bearer token, through b.auth.oauth.
//
// The manager owns the whole grant: a cached token, ONE shared in-flight fetch
// so a burst of checkouts on a cold cache mints one token rather than one
// each, a re-fetch before expiry, and a backoff window on a 429 during which
// the still-valid cached token is served instead of hammering the endpoint.
// PayPal rate-limits the token endpoint well below the rate a checkout burst
// reaches, so each of those matters.
//
// It dials through THIS adapter's client rather than reaching for its own, so
// the exchange keeps everything the Orders-v2 calls have: the per-upstream
// circuit breaker, the bounded retry, the SSRF host pin, and the injected
// opts.httpClient the tests drive. That seam is the reason this composes at
// all — without it the token endpoint would be the one dial the circuit
// protecting live checkouts could not see, which is exactly backwards, since
// its failure is the clearest signal the upstream is unhealthy.
//
// PayPal requires HTTP Basic client authentication. client_secret_basic also
// removes the secret from the request body rather than sending it twice.
function _paypalTokenManager(opts, state) {
  if (state.tokenManager) return state.tokenManager;
  var httpClient  = opts.httpClient || b.httpClient;
  var apiBase     = _paypalApiBase(opts);
  var allowedHost = _paypalAllowedHost(opts);

  // Re-asking for a token is always safe, so the exchange takes the retry arm
  // of the dial alongside the breaker. Request options the caller sets win
  // over these defaults — the framework's host pin wraps this client and
  // disables redirect following per request, and that must not be overwritten.
  //
  // The two layers want opposite things from a failed exchange, so the dial
  // gives each what it needs. A breaker only counts what THROWS, and
  // b.httpClient resolves a 500 as an ordinary response, so a non-2xx has to
  // be raised inside the dial or the token endpoint becomes invisible to the
  // circuit. The OAuth client, meanwhile, wants the response itself so it can
  // build its own typed error and read the reason PayPal gave. So the throw
  // drives the retry and the breaker, and the response is handed back at the
  // boundary once they are done with it. `statusCode` on the raised error is
  // what makes the retry skip a 4xx and ride out a 5xx, while the breaker
  // counts both — a sustained stream of 4xx is its own kind of unhealthy.
  var dialer = {
    request: function (reqOpts) {
      var received = null;
      return _dial(opts._breaker, true, async function () {
        var res = await httpClient.request(Object.assign({
          timeoutMs:    opts.timeoutMs || PAYPAL_HTTP_TIMEOUT_MS,
          allowedHosts: [allowedHost],
        }, reqOpts));
        received = res;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          var err = new Error("paypal: token endpoint returned HTTP " + res.statusCode);
          err.statusCode = res.statusCode;
          throw err;
        }
        return res;
      }).catch(function (e) {
        // A response we actually received goes back to the OAuth client, which
        // turns it into auth-oauth/token-error-<status> — the code its own
        // backoff classifier reads. Anything else (a transport failure, or an
        // open circuit that never dialled) is a real throw and propagates.
        if (received && e && e.statusCode === received.statusCode) return received;
        throw e;
      });
    },
  };

  var oauth = b.auth.oauth.create({
    issuer:                  apiBase,
    clientId:                opts.clientId,
    clientSecret:            opts.secret,
    tokenEndpoint:           apiBase + "/v1/oauth2/token",
    tokenEndpointAuthMethod: "client_secret_basic",
    http:                    { client: dialer, allowedHosts: [allowedHost] },
  });
  state.tokenManager = oauth.clientCredentialsManager({
    refreshSkewSec: PAYPAL_TOKEN_SKEW_SEC,
  });
  return state.tokenManager;
}

function _paypalToken(opts, state) {
  return _paypalTokenManager(opts, state).getToken();
}

// `breaker` selects which circuit the dial rides — every payment call rides
// the adapter's main `opts._breaker`; the webhook-verification dial rides its
// own (see verifyWebhook) so attacker-shaped verification traffic can't trip
// the circuit live checkouts depend on. The token exchange inside always
// rides the main breaker: its failures are credential/PayPal-health signals,
// not attacker-controllable per-request outcomes.
async function _paypalCall(opts, state, method, path, bodyObj, requestId, breaker) {
  var token = await _paypalToken(opts, state);
  var headers = {
    "authorization": "Bearer " + token,
    "accept":        "application/json",
    "content-type":  "application/json",
    "user-agent":    "blamejs-shop (zero-dep)",
  };
  // The request id crosses the wire as the `PayPal-Request-Id` header —
  // validate + refuse traversal / control-char / oversize shapes before it
  // leaves (covers both operator-supplied keys and the adapter-constructed
  // `order:`/`capture:` ids).
  if (requestId) headers["paypal-request-id"] = _assertOutboundKey(requestId, "paypal_request_id");
  var body = bodyObj != null ? JSON.stringify(bodyObj) : undefined;
  if (body) headers["content-length"] = Buffer.byteLength(body, "utf8");
  var httpClient = opts.httpClient || b.httpClient;
  var allowedHost = _paypalAllowedHost(opts);
  // A GET is idempotent; a write is idempotent only when it carries a
  // PayPal-Request-Id (PayPal dedupes a replay of the SAME id, and the
  // same id rides every retry attempt within one call). A keyless write
  // rides the breaker but not the retry.
  var idempotent = method === "GET" || !!requestId;
  var json = await _dial(breaker === undefined ? opts._breaker : breaker, idempotent, async function () {
    var res = await httpClient.request({
      method:       method,
      url:          _paypalApiBase(opts) + path,
      headers:      headers,
      body:         body,
      timeoutMs:    opts.timeoutMs || PAYPAL_HTTP_TIMEOUT_MS,
      allowedHosts: [allowedHost],
    });
    var text = res.body && res.body.toString ? res.body.toString("utf8") : "";
    var parsed; try { parsed = text.length ? b.safeJson.parse(text) : {}; } catch (_e) { parsed = { _raw: text }; }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      var detail = parsed && (parsed.message || (parsed.details && parsed.details[0] && parsed.details[0].description)) || "";
      var err = new Error("paypal: " + method + " " + path + " → HTTP " + res.statusCode + (detail ? " — " + detail : ""));
      err.code = (parsed && parsed.name) || "PAYPAL_HTTP_" + res.statusCode;
      err.statusCode = res.statusCode;
      err.paypal = parsed || null;
      throw err;
    }
    Object.defineProperty(parsed, "_paypalStatus",  { value: res.statusCode, enumerable: false });
    Object.defineProperty(parsed, "_paypalRawText", { value: text,           enumerable: false });
    return parsed;
  });
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
  // One circuit breaker per adapter instance, guarding every PayPal dial
  // (the token exchange + every Orders-v2 call). Skippable in tests via
  // `breaker: false`.
  if (opts._breaker === undefined) {
    opts._breaker = opts.breaker === false ? null : _makeBreaker("psp-paypal");
  }
  // SEPARATE breaker for the webhook-verification dial. The verify call's
  // failure rate is attacker-influenceable: any header-complete spam POST to
  // the (necessarily unauthenticated) webhook route triggers a
  // verify-webhook-signature dial whose 4xx counts as a breaker failure —
  // five consecutive spam posts would otherwise open the SAME circuit live
  // checkout's createOrder/captureOrder ride and fast-fail real payments for
  // the cooldown window. Verification failures say nothing about PayPal's
  // health as a payments peer, so they account against their own circuit.
  if (opts._verifyBreaker === undefined) {
    opts._verifyBreaker = opts.breaker === false ? null : _makeBreaker("psp-paypal-verify");
  }

  var state = {
    query:          opts.query || null,
    now:            typeof opts.now === "function" ? opts.now : function () { return Date.now(); },
    // Built on first use and kept for the adapter's lifetime — the token
    // cache, the shared in-flight fetch and the 429 backoff all live on it,
    // so a per-call manager would throw every one of them away.
    tokenManager:   null,
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

    // The per-adapter circuit breaker (or null when disabled). Same
    // operator-dashboard surface as the Stripe adapter's. `verifyBreaker`
    // is the webhook-verification dial's own circuit — kept separate so
    // spam against the webhook route can't open the payment circuit.
    breaker:       opts._breaker,
    verifyBreaker: opts._verifyBreaker,

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
      try { event = typeof rawBody === "string" ? b.safeJson.parse(rawBody) : rawBody; }
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
      // Rides the verify-only breaker (opts._verifyBreaker), never the main
      // payment circuit — see the factory comment: verification traffic is
      // attacker-shaped and must not be able to fast-fail live checkouts.
      try { res = await _paypalCall(opts, state, "POST", "/v1/notifications/verify-webhook-signature", verifyBody, null, opts._verifyBreaker); }
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

// Boot-time PayPal configuration lint, called by the server entry point so
// an incomplete env surfaces in the boot log instead of as a silent feature
// gap. Returns an array of operator-actionable warning strings (empty when
// nothing is wrong). Pure read of the supplied env map — never throws, never
// changes behavior: webhook verification stays MANDATORY and fails closed
// whether or not the operator saw the warning.
function paypalConfigWarnings(env) {
  env = env && typeof env === "object" ? env : {};
  var warnings = [];
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET && !env.PAYPAL_WEBHOOK_ID) {
    warnings.push(
      "PAYPAL_WEBHOOK_ID is not set: PayPal checkout is configured, but every " +
      "/api/webhooks/paypal delivery will be refused (verification fails closed " +
      "without the webhook id), so out-of-band captures and refunds will not " +
      "reach the order ledger. Set PAYPAL_WEBHOOK_ID to the webhook id from the " +
      "PayPal developer dashboard.");
  }
  return warnings;
}

module.exports = {
  create:                    create,
  stripe:                    stripe,
  paypal:                    paypal,
  paypalConfigWarnings:      paypalConfigWarnings,
  STRIPE_WEBHOOK_TOLERANCE:  STRIPE_WEBHOOK_TOLERANCE,
  IDEMPOTENCY_TTL_MS:        IDEMPOTENCY_TTL_MS,
  // Exposed for tests + Worker to share form-encoding shape.
  _formEncode:               _formEncode,
  _verifyWebhook:            _verifyWebhook,
  _canonicalHash:            _canonicalHash,
  _legacyCanonicalHash:      _legacyCanonicalHash,
  // Exposed for the checkout webhook mirror + admin refund normalization —
  // exact decimal-string ↔ minor-unit conversion sharing one zero-decimal
  // currency table.
  _decimalToMinor:           _decimalToMinor,
  _minorToDecimalString:     _minorToDecimalString,
};
