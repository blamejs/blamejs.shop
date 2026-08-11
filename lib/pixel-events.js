"use strict";
/**
 * @module shop.pixelEvents
 * @title  Pixel events — server-side conversion-tracking pixel/event
 *         API integration.
 *
 * @intro
 *   Every modern ad platform exposes a server-side Conversions API
 *   (Meta CAPI, Google Enhanced Conversions, TikTok Events API,
 *   Pinterest CAPI, Snap CAPI). Operators register one provider row
 *   per platform; the storefront calls `recordEvent` at every
 *   purchase / add-to-cart / view / lead / signup / search; an
 *   operator-wired worker drains the queued rows by HTTPS-POSTing
 *   each event to the platform's conversion URL and routes the
 *   response back through `markDispatched` / `markFailed`.
 *
 *   The shape:
 *
 *     var pe = bShop.pixelEvents.create({ query: q });
 *
 *     await pe.registerProvider({
 *       slug:           "meta",
 *       provider:       "meta_capi",
 *       pixel_id:       "1234567890",
 *       access_token:   "EAAB...redacted",
 *       conversion_url: "https://graph.facebook.com/v18.0/1234567890/events",
 *       active:         true,
 *     });
 *
 *     await pe.recordEvent({
 *       provider_slug:     "meta",
 *       event_name:        "purchase",
 *       event_id:          "order_8819_purchase",
 *       occurred_at:       Date.now(),
 *       customer_email:    "Alice@Example.COM",   // hashed on the way in
 *       customer_phone:    "+15555550123",         // hashed on the way in
 *       order_id:          orderId,
 *       value_minor:       2999,
 *       currency:          "USD",
 *       event_source_url:  "https://shop.example/orders/8819/thanks",
 *     });
 *
 *     // Scheduler tick — operator's worker pulls due rows, POSTs
 *     // each to the provider's conversion URL, then routes the
 *     // result back into the FSM.
 *     var due = await pe.dispatchTick({ now: Date.now(), batch_size: 50 });
 *     for (var i = 0; i < due.length; i += 1) {
 *       var ev = due[i];
 *       try {
 *         var res = await fetch(<provider.conversion_url>, { ... });
 *         await pe.markDispatched({
 *           event_id:        ev.id,
 *           response_status: res.status,
 *           response_body:   await res.text(),
 *         });
 *       } catch (err) {
 *         await pe.markFailed({
 *           event_id: ev.id,
 *           reason:   err && err.message || "dispatch_error",
 *           retry:    true,
 *         });
 *       }
 *     }
 *
 *   PII handling:
 *     `customer_email` / `customer_phone` are normalised + SHA-256
 *     hashed at the write site. The plaintext NEVER reaches the
 *     pixel_events row — every supported provider expects the
 *     identity-matching column to arrive as a hex-encoded SHA-256
 *     digest of the normalised value, and the framework refuses to
 *     persist the raw form. Email normalisation lowercases + trims;
 *     phone normalisation strips every non-digit byte plus a leading
 *     `+`. The resulting bytes are SHA-256-hashed via node:crypto.
 *     `ip_hash` is operator-supplied (already hashed by the caller —
 *     the primitive doesn't model IPv4/IPv6 normalisation here).
 *
 *   FSM:
 *     queued → dispatched
 *           ↘ failed (retry → queued | terminal)
 *
 *   Idempotency:
 *     `event_id` is the operator's dedup token — every supported
 *     platform uses an `event_id` field for de-duplication on their
 *     end. The (provider_slug, event_id) UNIQUE index returns the
 *     existing row when a retry replays.
 *
 *   Storage: migration 0123_pixel_events.sql.
 *
 *   Composition: zero npm runtime deps. The primitive composes
 *   blamejs (`b.uuid.v7`, `b.guardUuid.sanitize`) and node:crypto for
 *   the SHA-256 hashing the provider spec mandates — the framework's
 *   `b.crypto.namespaceHash` is SHA3-512 + prefix, which doesn't
 *   match what Meta / Google / TikTok / Pinterest / Snap expect.
 *
 * @primitive pixelEvents
 * @related   b.uuid, b.guardUuid
 */

var nodeCrypto = require("node:crypto");                                  // allow:non-shop-require allow:weak-hash-sha2 — Provider spec (Meta CAPI, Google EC, TikTok Events, Pinterest CAPI, Snap CAPI) mandates SHA-256 of the normalised identifier; blamejs.crypto exposes SHA3-512 / SHAKE256 / namespaceHash, none of which match the wire format ad platforms accept. Node's stdlib SHA-256 hash is the minimum-surface route.

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var PROVIDERS  = ["meta_capi", "google_ec", "tiktok_events", "pinterest_capi", "snap_capi"];
var EVENT_NAMES = [
  "purchase", "add_to_cart", "view_content",
  "lead", "complete_registration", "search",
];
var STATUSES   = ["queued", "dispatched", "failed"];

var MAX_SLUG_LEN          = 64;
var MAX_PIXEL_ID_LEN      = 128;
var MAX_ACCESS_TOKEN_LEN  = 2048;
var MAX_URL_LEN           = 2048;
var MAX_EVENT_ID_LEN      = 128;
var MAX_CURRENCY_LEN      = 3;
var MAX_UA_CLASS_LEN      = 64;
var MAX_IP_HASH_LEN       = 256;
var MAX_REASON_LEN        = 1024;
var MAX_RESPONSE_BODY_LEN = 16384;
var MAX_VALUE_MINOR       = 1000000000000;     // 1 trillion minor units — well above any single conversion
var MAX_LIST_LIMIT        = 500;
var DEFAULT_LIST_LIMIT    = 100;
var MAX_BATCH_SIZE        = 1000;
var DEFAULT_BATCH_SIZE    = 100;

var SLUG_RE         = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
var EVENT_ID_RE     = /^[A-Za-z0-9._:-]+$/;
var CURRENCY_RE     = /^[A-Z]{3}$/;
var UA_CLASS_RE     = /^[a-z0-9._-]+$/;
var IP_HASH_RE      = /^[0-9a-f]+$/;
var SHA256_HEX_RE   = /^[0-9a-f]{64}$/;
// Conservative email shape — operator-facing storefronts already
// validated this via the framework's address-input primitive; the
// gate here is a defensive last-line check before we normalise +
// hash. RFC 5321 caps the local-part at 64 chars and the full
// address at 254.
var EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var MAX_EMAIL_LEN   = 254;
var MAX_PHONE_LEN   = 32;
// E.164 textual phone — `+` + 7-15 digits — same shape the SMS
// dispatcher uses. The normaliser strips non-digits + a leading `+`
// before hashing; the validator gates the input before normalisation.
var PHONE_RAW_RE    = /^\+?[0-9 ().\-]{7,32}$/;

// Transient-failure retry back-off — 1m, 5m, 30m, 2h, 12h. The
// dispatch tick consults the schedule on `markFailed({ retry: true })`
// to compute the next attempt window. Once the schedule is exhausted
// the row terminates as failed regardless of the caller's `retry`
// request — runaway retries against a permanently-broken provider
// credential would otherwise saturate the worker tick.
var RETRY_BACKOFF_MS = [
  C.TIME.minutes(1),
  C.TIME.minutes(5),
  C.TIME.minutes(30),
  C.TIME.hours(2),
  C.TIME.hours(12),
];

// ---- monotonic clock ---------------------------------------------------
//
// Wall-clock can stall on a fast hot loop (multiple inserts inside
// the same millisecond) and on coarse-grained virtualised hosts. The
// monotonic shim keeps the per-process `created_at` / `updated_at`
// timestamps strictly increasing — every subsequent call observes a
// timestamp at least 1ms greater than the previous one. Sibling
// primitives (smsDispatcher, et al.) use the same shape; the FSM
// lookups + dispatchTick ordering rely on strict monotonicity to
// break ties deterministically.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("pixelEvents: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("pixelEvents: " + label + " must match /[a-z][a-z0-9-]*[a-z0-9]/");
  }
  return s;
}

function _provider(s) {
  if (typeof s !== "string" || PROVIDERS.indexOf(s) === -1) {
    throw new TypeError("pixelEvents: provider must be one of " + PROVIDERS.join(", "));
  }
  return s;
}

function _eventName(s) {
  if (typeof s !== "string" || EVENT_NAMES.indexOf(s) === -1) {
    throw new TypeError("pixelEvents: event_name must be one of " + EVENT_NAMES.join(", "));
  }
  return s;
}

function _pixelId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: pixel_id must be a non-empty string");
  }
  if (s.length > MAX_PIXEL_ID_LEN) {
    throw new TypeError("pixelEvents: pixel_id must be <= " + MAX_PIXEL_ID_LEN + " characters");
  }
  textGuard.freeText(s, "pixelEvents: pixel_id", { zeroWidth: "reject" });
  return s;
}

function _accessToken(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: access_token must be a non-empty string");
  }
  if (s.length > MAX_ACCESS_TOKEN_LEN) {
    throw new TypeError("pixelEvents: access_token must be <= " + MAX_ACCESS_TOKEN_LEN + " characters");
  }
  textGuard.freeText(s, "pixelEvents: access_token", { zeroWidth: "reject" });
  return s;
}

function _conversionUrl(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: conversion_url must be a non-empty string");
  }
  if (s.length > MAX_URL_LEN) {
    throw new TypeError("pixelEvents: conversion_url must be <= " + MAX_URL_LEN + " characters");
  }
  textGuard.freeText(s, "pixelEvents: conversion_url", { zeroWidth: "reject" });
  // Every supported provider's conversion API is public HTTPS — refuse
  // anything else so an operator typo can't egress conversion data in
  // plaintext.
  if (!/^https:\/\//i.test(s)) {
    throw new TypeError("pixelEvents: conversion_url must be an absolute https:// URL");
  }
  return s;
}

function _eventId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: event_id must be a non-empty string");
  }
  if (s.length > MAX_EVENT_ID_LEN) {
    throw new TypeError("pixelEvents: event_id must be <= " + MAX_EVENT_ID_LEN + " characters");
  }
  if (!EVENT_ID_RE.test(s)) {
    throw new TypeError("pixelEvents: event_id must match /^[A-Za-z0-9._:-]+$/");
  }
  return s;
}

function _eventSourceUrl(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: event_source_url must be a non-empty string");
  }
  if (s.length > MAX_URL_LEN) {
    throw new TypeError("pixelEvents: event_source_url must be <= " + MAX_URL_LEN + " characters");
  }
  textGuard.freeText(s, "pixelEvents: event_source_url", { zeroWidth: "reject" });
  if (!/^https?:\/\//i.test(s)) {
    throw new TypeError("pixelEvents: event_source_url must be an absolute http(s):// URL");
  }
  return s;
}

function _email(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: customer_email must be a non-empty string when provided");
  }
  if (s.length > MAX_EMAIL_LEN) {
    throw new TypeError("pixelEvents: customer_email must be <= " + MAX_EMAIL_LEN + " characters");
  }
  textGuard.freeText(s, "pixelEvents: customer_email", { zeroWidth: "reject" });
  // Validate the trimmed form — normalisation strips leading /
  // trailing whitespace before hashing, so a "  alice@example.com  "
  // input still hashes to the canonical address. Reject only when
  // the trimmed form doesn't look like an email at all.
  if (!EMAIL_RE.test(s.trim())) {
    throw new TypeError("pixelEvents: customer_email must be a valid address shape");
  }
  return s;
}

function _phone(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: customer_phone must be a non-empty string when provided");
  }
  if (s.length > MAX_PHONE_LEN) {
    throw new TypeError("pixelEvents: customer_phone must be <= " + MAX_PHONE_LEN + " characters");
  }
  if (!PHONE_RAW_RE.test(s)) {
    throw new TypeError("pixelEvents: customer_phone must contain only digits + optional leading + / spaces / dashes / parens");
  }
  return s;
}

function _currency(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("pixelEvents: currency must be a string when provided");
  }
  if (s.length !== MAX_CURRENCY_LEN || !CURRENCY_RE.test(s)) {
    throw new TypeError("pixelEvents: currency must be a 3-letter uppercase ISO-4217 code (e.g. 'USD')");
  }
  return s;
}

function _valueMinor(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0 || n > MAX_VALUE_MINOR) {
    throw new TypeError("pixelEvents: value_minor must be a non-negative integer <= " + MAX_VALUE_MINOR);
  }
  return n;
}

function _uaClass(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: ua_class must be a non-empty string when provided");
  }
  if (s.length > MAX_UA_CLASS_LEN) {
    throw new TypeError("pixelEvents: ua_class must be <= " + MAX_UA_CLASS_LEN + " characters");
  }
  if (!UA_CLASS_RE.test(s)) {
    throw new TypeError("pixelEvents: ua_class must match /[a-z0-9._-]+/");
  }
  return s;
}

function _ipHash(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: ip_hash must be a non-empty string when provided");
  }
  if (s.length > MAX_IP_HASH_LEN) {
    throw new TypeError("pixelEvents: ip_hash must be <= " + MAX_IP_HASH_LEN + " characters");
  }
  if (!IP_HASH_RE.test(s)) {
    throw new TypeError("pixelEvents: ip_hash must be lowercase hex");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("pixelEvents: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _optionalEpochMs(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("pixelEvents: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("pixelEvents: batch_size must be an integer in [1, " + MAX_BATCH_SIZE + "]");
  }
  return n;
}

function _reason(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pixelEvents: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("pixelEvents: " + label + " must be <= " + MAX_REASON_LEN + " characters");
  }
  if (textGuard.hasCodepointThreat(s, { zeroWidth: "reject" })) {
    throw new TypeError("pixelEvents: " + label + " contains control / zero-width bytes");
  }
  return s;
}

function _responseBody(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("pixelEvents: response_body must be a string when provided");
  }
  if (s.length > MAX_RESPONSE_BODY_LEN) {
    throw new TypeError("pixelEvents: response_body must be <= " + MAX_RESPONSE_BODY_LEN + " characters");
  }
  // Response bodies from upstream providers are operator-observed
  // already (the dispatch hook captured them); allow the full ASCII
  // range minus the zero-width / bidi block so a malicious provider
  // can't smuggle invisible bytes through the audit trail.
  textGuard.freeText(s, "pixelEvents: response_body", { zeroWidth: "reject" });
  return s;
}

function _responseStatus(n) {
  if (!Number.isInteger(n) || n < 100 || n > 599) {
    throw new TypeError("pixelEvents: response_status must be an integer HTTP status in [100, 599]");
  }
  return n;
}

function _optionalUuid(s, label) {
  if (s == null) return null;
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("pixelEvents: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("pixelEvents: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

// ---- normalisation + hashing -------------------------------------------
//
// Each platform's identity-matching surface accepts a hex-encoded
// SHA-256 of the normalised identifier. Normalisation rules are
// platform-portable (the five providers we support converge on the
// same shape):
//
//   email — trim leading/trailing whitespace, lowercase.
//   phone — strip every non-digit byte. A leading `+` is implicit;
//           the digits themselves carry the country code (the operator
//           is expected to pass E.164-ish input — `+15555550123` /
//           `1 (555) 555-0123` / `+1.555.555.0123` all normalise to
//           `15555550123`).
//
// The output is a 64-char lowercase hex digest. Empty input (after
// normalisation) returns null — a caller that hands "  " or "+" as a
// phone hasn't actually supplied an identifier.

function _normaliseEmail(s) {
  return String(s).trim().toLowerCase();
}

function _normalisePhone(s) {
  return String(s).replace(/[^0-9]/g, "");
}

function _sha256Hex(s) {
  // allow:weak-hash-sha2 — Meta CAPI / Google EC / TikTok / Pinterest / Snap CAPI all mandate SHA-256 of the normalised identifier on the wire; b.crypto.sha3Hash (SHA3-512) is not a valid substitute.
  return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function _hashEmail(raw) {
  if (raw == null) return null;
  var norm = _normaliseEmail(raw);
  if (!norm.length) return null;
  return _sha256Hex(norm);
}

function _hashPhone(raw) {
  if (raw == null) return null;
  var norm = _normalisePhone(raw);
  if (!norm.length) return null;
  return _sha256Hex(norm);
}

// ---- row hydration ------------------------------------------------------

function _hydrateProvider(r) {
  if (!r) return null;
  return {
    slug:                     r.slug,
    provider:                 r.provider,
    pixel_id:                 r.pixel_id,
    access_token_hash:        r.access_token_hash,
    access_token_normalized:  r.access_token_normalized,
    conversion_url:           r.conversion_url,
    active:                   Number(r.active) === 1,
    archived_at:              r.archived_at == null ? null : Number(r.archived_at),
    created_at:               Number(r.created_at),
    updated_at:               Number(r.updated_at),
  };
}

function _hydrateEvent(r) {
  if (!r) return null;
  return {
    id:                     r.id,
    provider_slug:          r.provider_slug,
    event_name:             r.event_name,
    event_id:               r.event_id,
    occurred_at:            Number(r.occurred_at),
    customer_email_sha256:  r.customer_email_sha256 == null ? null : r.customer_email_sha256,
    customer_phone_sha256:  r.customer_phone_sha256 == null ? null : r.customer_phone_sha256,
    customer_id:            r.customer_id == null ? null : r.customer_id,
    order_id:               r.order_id == null ? null : r.order_id,
    value_minor:            r.value_minor == null ? null : Number(r.value_minor),
    currency:               r.currency == null ? null : r.currency,
    event_source_url:       r.event_source_url,
    ua_class:               r.ua_class == null ? null : r.ua_class,
    ip_hash:                r.ip_hash == null ? null : r.ip_hash,
    status:                 r.status,
    attempts:               Number(r.attempts || 0),
    dispatched_at:          r.dispatched_at == null ? null : Number(r.dispatched_at),
    response_status:        r.response_status == null ? null : Number(r.response_status),
    response_body:          r.response_body == null ? null : r.response_body,
    last_failure:           r.last_failure == null ? null : r.last_failure,
    created_at:             Number(r.created_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getProvider(slug) {
    var r = await query("SELECT * FROM pixel_providers WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _getEvent(id) {
    var r = await query("SELECT * FROM pixel_events WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getEventByDedup(providerSlug, eventId) {
    var r = await query(
      "SELECT * FROM pixel_events WHERE provider_slug = ?1 AND event_id = ?2",
      [providerSlug, eventId],
    );
    return r.rows[0] || null;
  }

  // -- registerProvider --------------------------------------------------

  async function registerProvider(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pixelEvents.registerProvider: input object required");
    }
    var slug          = _slug(input.slug, "slug");
    var provider      = _provider(input.provider);
    var pixelId       = _pixelId(input.pixel_id);
    var accessToken   = _accessToken(input.access_token);
    var conversionUrl = _conversionUrl(input.conversion_url);
    var active        = input.active == null ? true : !!input.active;
    var now           = _now();
    var tokenHash     = _sha256Hex(accessToken);

    var existing = await _getProvider(slug);
    if (existing) {
      // Refuse the provider-platform swap — operators that want a
      // different ad platform for the same operator-facing slug must
      // archive the old row and pick a new slug, otherwise the event
      // ledger's historical `provider_slug` references become
      // ambiguous. Field updates (pixel_id, access_token,
      // conversion_url, active) are fine.
      if (existing.provider !== provider) {
        throw new TypeError(
          "pixelEvents.registerProvider: cannot change provider platform from " +
          JSON.stringify(existing.provider) + " to " + JSON.stringify(provider) +
          " for slug " + JSON.stringify(slug) +
          " — archive the existing provider and pick a new slug"
        );
      }
      await query(
        "UPDATE pixel_providers SET pixel_id = ?1, access_token_hash = ?2, " +
        "access_token_normalized = ?3, conversion_url = ?4, active = ?5, " +
        "updated_at = ?6 WHERE slug = ?7",
        [pixelId, tokenHash, accessToken, conversionUrl, active ? 1 : 0, now, slug],
      );
    } else {
      await query(
        "INSERT INTO pixel_providers " +
        "(slug, provider, pixel_id, access_token_hash, access_token_normalized, " +
        " conversion_url, active, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
        [slug, provider, pixelId, tokenHash, accessToken, conversionUrl, active ? 1 : 0, now],
      );
    }
    return _hydrateProvider(await _getProvider(slug));
  }

  // -- recordEvent -------------------------------------------------------

  async function recordEvent(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pixelEvents.recordEvent: input object required");
    }
    var providerSlug   = _slug(input.provider_slug, "provider_slug");
    var eventName      = _eventName(input.event_name);
    var eventId        = _eventId(input.event_id);
    var occurredAt     = _epochMs(input.occurred_at, "occurred_at");
    var customerEmail  = _email(input.customer_email == null ? null : input.customer_email);
    var customerPhone  = _phone(input.customer_phone == null ? null : input.customer_phone);
    var customerId     = _optionalUuid(input.customer_id, "customer_id");
    var orderId        = _optionalUuid(input.order_id, "order_id");
    var valueMinor     = _valueMinor(input.value_minor == null ? null : input.value_minor);
    var currency       = _currency(input.currency == null ? null : input.currency);
    var eventSourceUrl = _eventSourceUrl(input.event_source_url);
    var uaClass        = _uaClass(input.ua_class == null ? null : input.ua_class);
    var ipHash         = _ipHash(input.ip_hash == null ? null : input.ip_hash);

    // Value + currency are joint — a purchase with a value must
    // declare its currency, and a currency-less value is meaningless.
    if ((valueMinor == null) !== (currency == null)) {
      throw new TypeError("pixelEvents.recordEvent: value_minor and currency must be supplied together");
    }

    var provider = await _getProvider(providerSlug);
    if (!provider) {
      var pErr = new Error("pixelEvents.recordEvent: provider_slug " + JSON.stringify(providerSlug) + " not found");
      pErr.code = "PROVIDER_NOT_FOUND";
      throw pErr;
    }

    // Idempotent insert — same (provider_slug, event_id) replays
    // surface the existing row instead of returning a DB UNIQUE
    // violation. Every supported platform's Conversions API expects
    // an `event_id` for de-duplication; the framework mirrors that
    // contract on the way in so a retried storefront request doesn't
    // accumulate duplicate rows.
    var dup = await _getEventByDedup(providerSlug, eventId);
    if (dup) return _hydrateEvent(dup);

    var emailHash = _hashEmail(customerEmail);
    var phoneHash = _hashPhone(customerPhone);
    var now       = _now();
    var id        = b.uuid.v7();

    await query(
      "INSERT INTO pixel_events " +
      "(id, provider_slug, event_name, event_id, occurred_at, " +
      " customer_email_sha256, customer_phone_sha256, customer_id, order_id, " +
      " value_minor, currency, event_source_url, ua_class, ip_hash, " +
      " status, attempts, dispatched_at, response_status, response_body, " +
      " last_failure, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, " +
      " 'queued', 0, NULL, NULL, NULL, NULL, ?15)",
      [
        id, providerSlug, eventName, eventId, occurredAt,
        emailHash, phoneHash, customerId, orderId,
        valueMinor, currency, eventSourceUrl, uaClass, ipHash,
        now,
      ],
    );
    return _hydrateEvent(await _getEvent(id));
  }

  // -- dispatchTick ------------------------------------------------------
  //
  // Scheduler-callable. Returns every queued event whose
  // `occurred_at` is due AND whose provider is active. The caller's
  // worker dispatches each row to the provider's conversion URL and
  // routes the response back through `markDispatched` /
  // `markFailed`. The tick itself doesn't mutate FSM state — that
  // contract sits with the caller so a misfiring worker can replay
  // a tick without double-dispatching.

  async function dispatchTick(input) {
    input = input || {};
    var now       = input.now == null ? _now() : _epochMs(input.now, "now");
    var batchSize = _batchSize(input.batch_size);

    var due = await query(
      "SELECT e.* FROM pixel_events e " +
      "JOIN pixel_providers p ON p.slug = e.provider_slug " +
      "WHERE e.status = 'queued' AND e.occurred_at <= ?1 AND p.active = 1 " +
      "ORDER BY e.occurred_at ASC, e.id ASC LIMIT ?2",
      [now, batchSize],
    );
    var out = [];
    for (var i = 0; i < due.rows.length; i += 1) out.push(_hydrateEvent(due.rows[i]));
    return out;
  }

  // -- markDispatched ----------------------------------------------------

  async function markDispatched(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pixelEvents.markDispatched: input object required");
    }
    var eventId        = _uuid(input.event_id, "event_id");
    var responseStatus = _responseStatus(input.response_status);
    var responseBody   = _responseBody(input.response_body == null ? null : input.response_body);
    var now            = _now();

    var existing = await _getEvent(eventId);
    if (!existing) {
      var nfErr = new Error("pixelEvents.markDispatched: event " + eventId + " not found");
      nfErr.code = "EVENT_NOT_FOUND";
      throw nfErr;
    }
    if (existing.status === "dispatched") {
      // Idempotent — the worker's response handler can replay the same
      // success transition.
      return _hydrateEvent(existing);
    }
    if (existing.status === "failed") {
      var fErr = new Error(
        "pixelEvents.markDispatched: refusing dispatched transition from terminal failed"
      );
      fErr.code = "FSM_TERMINAL";
      throw fErr;
    }
    var attempts = Number(existing.attempts || 0) + 1;
    await query(
      "UPDATE pixel_events SET status = 'dispatched', attempts = ?1, " +
      "dispatched_at = ?2, response_status = ?3, response_body = ?4, " +
      "last_failure = NULL WHERE id = ?5",
      [attempts, now, responseStatus, responseBody, eventId],
    );
    return _hydrateEvent(await _getEvent(eventId));
  }

  // -- markFailed --------------------------------------------------------

  async function markFailed(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pixelEvents.markFailed: input object required");
    }
    var eventId = _uuid(input.event_id, "event_id");
    var reason  = _reason(input.reason, "reason");
    var retry   = !!input.retry;
    var now     = _now();

    var existing = await _getEvent(eventId);
    if (!existing) {
      var nfErr = new Error("pixelEvents.markFailed: event " + eventId + " not found");
      nfErr.code = "EVENT_NOT_FOUND";
      throw nfErr;
    }
    if (existing.status === "dispatched") {
      var fErr = new Error(
        "pixelEvents.markFailed: refusing failed transition from terminal dispatched"
      );
      fErr.code = "FSM_TERMINAL";
      throw fErr;
    }
    var attempts = Number(existing.attempts || 0) + 1;
    if (retry && attempts < RETRY_BACKOFF_MS.length) {
      // Re-queue with back-off — the dispatcher's next tick won't
      // pick the row until `occurred_at` slides past `now +
      // RETRY_BACKOFF_MS[attempts - 1]`.
      var nextOccurredAt = now + RETRY_BACKOFF_MS[attempts - 1];
      await query(
        "UPDATE pixel_events SET status = 'queued', attempts = ?1, " +
        "occurred_at = ?2, last_failure = ?3 WHERE id = ?4",
        [attempts, nextOccurredAt, reason, eventId],
      );
      return _hydrateEvent(await _getEvent(eventId));
    }
    // Terminal failure — exhausted retry budget OR caller asked for
    // a hard fail. Persist the reason + flip status.
    await query(
      "UPDATE pixel_events SET status = 'failed', attempts = ?1, " +
      "last_failure = ?2 WHERE id = ?3",
      [attempts, reason, eventId],
    );
    return _hydrateEvent(await _getEvent(eventId));
  }

  // -- eventsForOrder ----------------------------------------------------

  async function eventsForOrder(orderId) {
    var oid = _uuid(orderId, "order_id");
    var r = await query(
      "SELECT * FROM pixel_events WHERE order_id = ?1 " +
      "ORDER BY occurred_at ASC, id ASC",
      [oid],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateEvent(r.rows[i]));
    return out;
  }

  // -- dispatchedInPeriod ------------------------------------------------

  async function dispatchedInPeriod(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pixelEvents.dispatchedInPeriod: input object required");
    }
    var providerSlug = input.provider_slug == null ? null : _slug(input.provider_slug, "provider_slug");
    var from         = _epochMs(input.from, "from");
    var to           = _epochMs(input.to, "to");
    var limit        = _limit(input.limit, "limit");
    if (from > to) {
      throw new TypeError("pixelEvents.dispatchedInPeriod: from must be <= to");
    }

    var sql, params;
    if (providerSlug) {
      sql = "SELECT * FROM pixel_events " +
            "WHERE status = 'dispatched' AND provider_slug = ?1 " +
            "AND dispatched_at >= ?2 AND dispatched_at <= ?3 " +
            "ORDER BY dispatched_at ASC, id ASC LIMIT ?4";
      params = [providerSlug, from, to, limit];
    } else {
      sql = "SELECT * FROM pixel_events " +
            "WHERE status = 'dispatched' " +
            "AND dispatched_at >= ?1 AND dispatched_at <= ?2 " +
            "ORDER BY dispatched_at ASC, id ASC LIMIT ?3";
      params = [from, to, limit];
    }
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateEvent(r.rows[i]));
    return out;
  }

  // -- failedEvents ------------------------------------------------------

  async function failedEvents(input) {
    input = input || {};
    var limit = _limit(input.limit, "limit");
    var r = await query(
      "SELECT * FROM pixel_events WHERE status = 'failed' " +
      "ORDER BY created_at DESC, id ASC LIMIT ?1",
      [limit],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateEvent(r.rows[i]));
    return out;
  }

  // -- metricsForProvider ------------------------------------------------
  //
  // Per-event-name rollup across [from, to]. Computes total / queued
  // / dispatched / failed counts so the operator dashboard can
  // surface dispatch-success ratio per provider per event type.

  async function metricsForProvider(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pixelEvents.metricsForProvider: input object required");
    }
    var slug = _slug(input.slug, "slug");
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to, "to");
    if (from > to) {
      throw new TypeError("pixelEvents.metricsForProvider: from must be <= to");
    }
    var provider = await _getProvider(slug);
    if (!provider) {
      throw new TypeError("pixelEvents.metricsForProvider: slug " + JSON.stringify(slug) + " not found");
    }

    var rows = (await query(
      "SELECT event_name, status, COUNT(*) AS n FROM pixel_events " +
      "WHERE provider_slug = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
      "GROUP BY event_name, status",
      [slug, from, to],
    )).rows;

    var byEvent = {};
    var totals  = { total: 0, queued: 0, dispatched: 0, failed: 0 };
    for (var i = 0; i < EVENT_NAMES.length; i += 1) {
      byEvent[EVENT_NAMES[i]] = { total: 0, queued: 0, dispatched: 0, failed: 0 };
    }
    for (var j = 0; j < rows.length; j += 1) {
      var row    = rows[j];
      var name   = row.event_name;
      var status = row.status;
      var n      = Number(row.n);
      if (byEvent[name]) {
        byEvent[name].total += n;
        if (byEvent[name][status] != null) byEvent[name][status] += n;
      }
      totals.total += n;
      if (totals[status] != null) totals[status] += n;
    }

    return {
      slug:       slug,
      provider:   provider.provider,
      pixel_id:   provider.pixel_id,
      from:       from,
      to:         to,
      total:      totals.total,
      queued:     totals.queued,
      dispatched: totals.dispatched,
      failed:     totals.failed,
      by_event:   byEvent,
    };
  }

  // -- listProviders / getProvider --------------------------------------

  async function getProvider(slug) {
    _slug(slug, "slug");
    return _hydrateProvider(await _getProvider(slug));
  }

  async function listProviders(listOpts) {
    listOpts = listOpts || {};
    var limit = _limit(listOpts.limit, "limit");
    var sql, params;
    if (listOpts.active_only) {
      sql = "SELECT * FROM pixel_providers WHERE active = 1 " +
            "ORDER BY created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql = "SELECT * FROM pixel_providers " +
            "ORDER BY created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateProvider(rows[i]));
    return out;
  }

  return {
    PROVIDERS:           PROVIDERS.slice(),
    EVENT_NAMES:         EVENT_NAMES.slice(),
    STATUSES:            STATUSES.slice(),
    RETRY_BACKOFF_MS:    RETRY_BACKOFF_MS.slice(),
    MAX_SLUG_LEN:        MAX_SLUG_LEN,
    MAX_EVENT_ID_LEN:    MAX_EVENT_ID_LEN,
    MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:  DEFAULT_LIST_LIMIT,
    MAX_BATCH_SIZE:      MAX_BATCH_SIZE,
    DEFAULT_BATCH_SIZE:  DEFAULT_BATCH_SIZE,

    // Helpers surfaced so callers compose with the same hashing the
    // primitive uses internally — a caller that wants to dedupe a row
    // ahead of recordEvent can pre-compute the digest and observe the
    // value the framework would have persisted.
    hashEmail:           _hashEmail,
    hashPhone:           _hashPhone,
    normaliseEmail:      _normaliseEmail,
    normalisePhone:      _normalisePhone,

    registerProvider:    registerProvider,
    getProvider:         getProvider,
    listProviders:       listProviders,
    recordEvent:         recordEvent,
    dispatchTick:        dispatchTick,
    markDispatched:      markDispatched,
    markFailed:          markFailed,
    eventsForOrder:      eventsForOrder,
    dispatchedInPeriod:  dispatchedInPeriod,
    failedEvents:        failedEvents,
    metricsForProvider:  metricsForProvider,
  };
}

module.exports = {
  create:              create,
  PROVIDERS:           PROVIDERS.slice(),
  EVENT_NAMES:         EVENT_NAMES.slice(),
  STATUSES:            STATUSES.slice(),
  RETRY_BACKOFF_MS:    RETRY_BACKOFF_MS.slice(),
  MAX_SLUG_LEN:        MAX_SLUG_LEN,
  MAX_EVENT_ID_LEN:    MAX_EVENT_ID_LEN,
  MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:  DEFAULT_LIST_LIMIT,
  MAX_BATCH_SIZE:      MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE:  DEFAULT_BATCH_SIZE,
  SHA256_HEX_RE:       SHA256_HEX_RE,
};
