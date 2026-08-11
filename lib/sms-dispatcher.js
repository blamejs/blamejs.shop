"use strict";
/**
 * @module shop.smsDispatcher
 * @title  SMS dispatcher — outbound SMS layer with per-country routing
 *
 * @intro
 *   Outbound SMS layer. Operators register one provider per country
 *   (Twilio for US/CA, MessageBird for the EU, Plivo for AU, ...);
 *   the dispatcher routes each enqueue to the first active provider
 *   whose region list covers the recipient's `country_code`. Customer
 *   opt-in is tracked per channel (`marketing` / `transactional` /
 *   `verification`) — non-transactional sends to a phone without the
 *   matching opt-in row are refused at enqueue time, and any inbound
 *   "STOP" / "UNSUBSCRIBE" / "CANCEL" keyword registers an opt-out
 *   plus a single confirmation message.
 *
 *   The shape:
 *
 *     var sms = bShop.smsDispatcher.create({ query: q });
 *
 *     await sms.registerProvider({
 *       slug:         "twilio",
 *       name:         "Twilio",
 *       regions:      ["US", "CA"],
 *       endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/...",
 *       active:       true,
 *     });
 *
 *     await sms.recordOptIn({
 *       customer_id:      customerId,
 *       phone_hash:       sms.hashPhone("+15555550123"),
 *       phone_normalized: "+15555550123",
 *       channel:          "marketing",
 *       opt_in_text:      "YES",
 *     });
 *
 *     await sms.enqueue({
 *       recipient_customer_id: customerId,
 *       recipient_phone:       "+15555550123",
 *       country_code:          "US",
 *       body:                  "Your order has shipped.",
 *       kind:                  "transactional",
 *     });
 *
 *     // Scheduler tick — operator wires this to a cron / Workers
 *     // Cron Trigger. Pulls every queued message whose schedule_at
 *     // is due, hands it to the provider-wired send hook, and flips
 *     // status to `sent`. The send hook stamps provider_ref via
 *     // `markDelivered` when the provider's delivery-receipt webhook
 *     // arrives; transient failures flow through `markFailed` with
 *     // `retry: true` so the row re-queues with back-off.
 *     await sms.dispatchTick({ now: Date.now() });
 *
 *   FSM:
 *     queued → sent → delivered
 *                  ↘ failed (retry → queued | terminal)
 *
 *   Composition: zero npm runtime deps; the primitive composes
 *   blamejs (`b.uuid.v7`, `b.crypto.namespaceHash`, `b.guardUuid`).
 *
 * @related b.crypto.namespaceHash, b.uuid, b.guardUuid
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var PHONE_NAMESPACE = "sms-phone";

var CHANNELS = ["marketing", "transactional", "verification"];
var STATES   = ["opt_in", "opt_out"];
var KINDS    = ["transactional", "marketing", "verification"];
var STATUSES = ["queued", "sent", "delivered", "failed"];

var MAX_SLUG_LEN        = 64;
var MAX_NAME_LEN        = 128;
var MAX_URL_LEN         = 2048;
var MAX_BODY_LEN        = 1600;   // 10 concatenated SMS segments at 160 chars
var MIN_BODY_LEN        = 1;
var MAX_REASON_LEN      = 280;
var MAX_OPT_IN_TEXT_LEN = 280;
var MAX_REGIONS         = 256;
var MAX_LIST_LIMIT      = 500;
var DEFAULT_LIST_LIMIT  = 100;
var MAX_BATCH_SIZE      = 1000;
var DEFAULT_BATCH_SIZE  = 100;
var MAX_PROVIDER_REF_LEN = 256;

// Transient-failure retry back-off — 1m, 5m, 30m, 2h, 12h. The
// dispatch tick consults the schedule on `markFailed({ retry: true })`
// to compute `next_retry_at`; once the schedule is exhausted the row
// terminates as failed regardless of the caller's `retry` request.
var RETRY_BACKOFF_MS = [
  C.TIME.minutes(1),
  C.TIME.minutes(5),
  C.TIME.minutes(30),
  C.TIME.hours(2),
  C.TIME.hours(12),
];

var SLUG_RE          = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
var COUNTRY_RE       = /^[A-Z]{2}$/;
var PHONE_HASH_RE    = /^[0-9a-f]{128}$/;
var PHONE_NORM_RE    = /^\+[1-9][0-9]{6,14}$/;   // E.164: +<country><subscriber>, 7-15 digits total

// Inbound STOP-keyword detection. Operators in the US/UK/AU regulatory
// envelope have all converged on this short list; the primitive
// matches the body case-insensitively, ignoring leading/trailing
// whitespace, so "  stop  " and "STOP" both register an opt-out.
var STOP_KEYWORDS = ["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "STOPALL"];

// Emoji code-point ranges — anything in the BMP emoji block, the
// supplementary-multilingual-plane emoji block, or the variation
// selectors. The check refuses bodies whose ONLY non-whitespace
// content is emoji — a degenerate payload that wastes a provider
// segment without conveying anything to a screen reader.
var EMOJI_CODEPOINT_RANGES = [
  [0x1F300, 0x1FAFF],     // misc symbols + pictographs through symbols-and-pictographs-extended-A
  [0x2600, 0x27BF],       // misc symbols + dingbats
  [0x1F000, 0x1F0FF],     // mahjong + dominoes + cards
  [0x1F100, 0x1F1FF],     // enclosed alphanumeric supplement (incl. regional-indicator pairs)
];
var VARIATION_SELECTORS = [0xFE0F, 0xFE0E];
var ZERO_WIDTH_JOINER   = 0x200D;

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("smsDispatcher: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("smsDispatcher: " + label + " must match /[a-z][a-z0-9-]*[a-z0-9]/");
  }
  return s;
}

function _name(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: name must be a non-empty string");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError("smsDispatcher: name must be <= " + MAX_NAME_LEN + " characters");
  }
  textGuard.freeText(s, "smsDispatcher: name", { zeroWidth: "reject" });
  return s;
}

function _endpointUrl(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: endpoint_url must be a non-empty string");
  }
  if (s.length > MAX_URL_LEN) {
    throw new TypeError("smsDispatcher: endpoint_url must be <= " + MAX_URL_LEN + " characters");
  }
  textGuard.freeText(s, "smsDispatcher: endpoint_url", { zeroWidth: "reject" });
  // Shape gate — refuse anything that isn't an absolute https URL.
  // Provider endpoints are public APIs; operators using a non-https
  // egress are leaking the message body across the wire.
  if (!/^https:\/\//i.test(s)) {
    throw new TypeError("smsDispatcher: endpoint_url must be an absolute https:// URL");
  }
  return s;
}

function _country(s) {
  if (typeof s !== "string") {
    throw new TypeError("smsDispatcher: country_code must be a string");
  }
  var up = s.toUpperCase();
  if (!COUNTRY_RE.test(up)) {
    throw new TypeError("smsDispatcher: country_code must be ISO-3166 alpha-2 (e.g. 'US')");
  }
  return up;
}

function _regions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("smsDispatcher: regions must be a non-empty array");
  }
  if (arr.length > MAX_REGIONS) {
    throw new TypeError("smsDispatcher: regions must have <= " + MAX_REGIONS + " entries");
  }
  var out = [];
  var seen = {};
  for (var i = 0; i < arr.length; i += 1) {
    var c = _country(arr[i]);
    if (seen[c]) {
      throw new TypeError("smsDispatcher: regions contains duplicate entry " + JSON.stringify(c));
    }
    seen[c] = true;
    out.push(c);
  }
  return out;
}

function _channel(s) {
  if (typeof s !== "string" || CHANNELS.indexOf(s) === -1) {
    throw new TypeError("smsDispatcher: channel must be one of " + CHANNELS.join(", "));
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("smsDispatcher: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _phoneNormalized(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: phone_normalized must be a non-empty string");
  }
  if (!PHONE_NORM_RE.test(s)) {
    throw new TypeError("smsDispatcher: phone_normalized must be E.164 (e.g. +15555550123)");
  }
  return s;
}

function _phoneHash(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: phone_hash must be a non-empty string");
  }
  if (!PHONE_HASH_RE.test(s)) {
    throw new TypeError("smsDispatcher: phone_hash must be 128 lowercase hex characters");
  }
  return s;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("smsDispatcher: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _optionalUuid(s, label) {
  if (s == null) return null;
  return _uuid(s, label);
}

function _reason(s, label) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: " + label + " must be a non-empty string when provided");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("smsDispatcher: " + label + " must be <= " + MAX_REASON_LEN + " characters");
  }
  if (textGuard.hasCodepointThreat(s, { zeroWidth: "reject" })) {
    throw new TypeError("smsDispatcher: " + label + " contains control / zero-width bytes");
  }
  return s;
}

function _optInText(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: opt_in_text must be a non-empty string when provided");
  }
  if (s.length > MAX_OPT_IN_TEXT_LEN) {
    throw new TypeError("smsDispatcher: opt_in_text must be <= " + MAX_OPT_IN_TEXT_LEN + " characters");
  }
  textGuard.freeText(s, "smsDispatcher: opt_in_text", { zeroWidth: "reject" });
  return s;
}

function _providerRef(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("smsDispatcher: provider_ref must be a non-empty string");
  }
  if (s.length > MAX_PROVIDER_REF_LEN) {
    throw new TypeError("smsDispatcher: provider_ref must be <= " + MAX_PROVIDER_REF_LEN + " characters");
  }
  textGuard.freeText(s, "smsDispatcher: provider_ref", { zeroWidth: "reject" });
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("smsDispatcher: " + label + " must be a positive integer (epoch ms)");
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
    throw new TypeError("smsDispatcher: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("smsDispatcher: batch_size must be an integer in [1, " + MAX_BATCH_SIZE + "]");
  }
  return n;
}

// Body validator — refuses emoji-only / control-byte payloads. The
// emoji refusal is a discipline check: a body that's nothing but
// pictographs wastes a provider segment without conveying anything
// to a screen reader or a recipient on a feature phone. Operators
// that want pictographs mix them with text.
function _body(s) {
  if (typeof s !== "string" || s.length < MIN_BODY_LEN) {
    throw new TypeError("smsDispatcher: body must be a non-empty string");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("smsDispatcher: body must be <= " + MAX_BODY_LEN + " characters");
  }
  textGuard.freeText(s, "smsDispatcher: body", { zeroWidth: "reject" });
  // Refuse the degenerate emoji-only shape. Walk the string by code
  // point so surrogate pairs in the SMP emoji blocks count as one
  // character.
  var hasNonEmoji = false;
  var cp;
  for (var i = 0; i < s.length; ) {
    cp = s.codePointAt(i);
    i += cp > 0xFFFF ? 2 : 1;
    if (cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D) continue;
    if (cp === ZERO_WIDTH_JOINER) continue;
    if (VARIATION_SELECTORS.indexOf(cp) !== -1) continue;
    var inEmoji = false;
    for (var r = 0; r < EMOJI_CODEPOINT_RANGES.length; r += 1) {
      if (cp >= EMOJI_CODEPOINT_RANGES[r][0] && cp <= EMOJI_CODEPOINT_RANGES[r][1]) {
        inEmoji = true;
        break;
      }
    }
    if (!inEmoji) {
      hasNonEmoji = true;
      break;
    }
  }
  if (!hasNonEmoji) {
    throw new TypeError("smsDispatcher: body must not be emoji-only");
  }
  return s;
}

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

function _isStopKeyword(raw) {
  if (typeof raw !== "string") return false;
  var trimmed = raw.trim().toUpperCase();
  if (!trimmed) return false;
  return STOP_KEYWORDS.indexOf(trimmed) !== -1;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // -------- internal helpers --------

  function hashPhone(phoneNormalized) {
    _phoneNormalized(phoneNormalized);
    return b.crypto.namespaceHash(PHONE_NAMESPACE, phoneNormalized);
  }

  async function _getProvider(slug) {
    var r = await query("SELECT * FROM sms_providers WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _getMessage(id) {
    var r = await query("SELECT * FROM sms_messages WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getOptState(phoneHash, channel) {
    var r = await query(
      "SELECT * FROM sms_opt_state WHERE phone_hash = ?1 AND channel = ?2",
      [phoneHash, channel],
    );
    return r.rows[0] || null;
  }

  // Provider routing — pick the first active provider whose
  // regions_json contains the requested country code. Ties are
  // broken by `created_at ASC` (oldest provider wins), so adding a
  // second provider for the same region doesn't silently re-route
  // existing traffic.
  async function _resolveProvider(countryCode) {
    var r = await query(
      "SELECT * FROM sms_providers WHERE active = 1 ORDER BY created_at ASC, slug ASC",
    );
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var regions;
      try { regions = JSON.parse(row.regions_json); }
      catch (_e) { continue; }
      if (!Array.isArray(regions)) continue;
      if (regions.indexOf(countryCode) !== -1) return row;
    }
    return null;
  }

  // -------- public surface --------

  return {
    // Surface the constants the operator's authoring code consults.
    CHANNELS:          CHANNELS.slice(),
    STATES:            STATES.slice(),
    KINDS:             KINDS.slice(),
    STATUSES:          STATUSES.slice(),
    STOP_KEYWORDS:     STOP_KEYWORDS.slice(),
    RETRY_BACKOFF_MS:  RETRY_BACKOFF_MS.slice(),
    PHONE_NAMESPACE:   PHONE_NAMESPACE,
    MAX_SLUG_LEN:      MAX_SLUG_LEN,
    MAX_BODY_LEN:      MAX_BODY_LEN,
    MAX_LIST_LIMIT:    MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT: DEFAULT_LIST_LIMIT,
    MAX_BATCH_SIZE:    MAX_BATCH_SIZE,
    DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE,

    // Helper surfaced so callers compose with the same hash function
    // the primitive uses internally. Refuses non-E.164 input so a
    // caller can't accidentally hash an ambiguous national-format
    // phone number that won't match the dispatcher's opt-state row.
    hashPhone: hashPhone,

    registerProvider: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.registerProvider: input object required");
      }
      var slug         = _slug(input.slug, "slug");
      var name         = _name(input.name);
      var regions      = _regions(input.regions);
      var endpointUrl  = _endpointUrl(input.endpoint_url);
      var active       = input.active == null ? true : !!input.active;
      var now          = _now();
      var json         = JSON.stringify(regions);

      var existing = await _getProvider(slug);
      if (existing) {
        await query(
          "UPDATE sms_providers SET name = ?1, regions_json = ?2, " +
          "endpoint_url = ?3, active = ?4, updated_at = ?5 WHERE slug = ?6",
          [name, json, endpointUrl, active ? 1 : 0, now, slug],
        );
      } else {
        await query(
          "INSERT INTO sms_providers " +
          "(slug, name, regions_json, endpoint_url, active, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
          [slug, name, json, endpointUrl, active ? 1 : 0, now],
        );
      }
      return await _getProvider(slug);
    },

    providerForRegion: async function (countryCode) {
      var c = _country(countryCode);
      return await _resolveProvider(c);
    },

    recordOptIn: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.recordOptIn: input object required");
      }
      var customerId    = _optionalUuid(input.customer_id, "customer_id");
      var phoneHash     = _phoneHash(input.phone_hash);
      _phoneNormalized(input.phone_normalized);
      var channel       = _channel(input.channel);
      var optInText     = _optInText(input.opt_in_text);
      var now           = _now();

      // Verify the phone_hash matches the supplied phone_normalized.
      // Operators that hand-craft a hash should be caught early; the
      // namespaceHash composition is deterministic so a mismatch
      // means the caller built the row wrong.
      var expected = b.crypto.namespaceHash(PHONE_NAMESPACE, input.phone_normalized);
      if (expected !== phoneHash) {
        throw new TypeError("smsDispatcher.recordOptIn: phone_hash does not match phone_normalized");
      }

      var existing = await _getOptState(phoneHash, channel);
      if (existing) {
        await query(
          "UPDATE sms_opt_state SET state = 'opt_in', customer_id = ?1, " +
          "opt_in_text = ?2, reason = NULL, occurred_at = ?3 " +
          "WHERE phone_hash = ?4 AND channel = ?5",
          [customerId, optInText, now, phoneHash, channel],
        );
        return await _getOptState(phoneHash, channel);
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO sms_opt_state " +
        "(id, phone_hash, customer_id, channel, state, opt_in_text, reason, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'opt_in', ?5, NULL, ?6)",
        [id, phoneHash, customerId, channel, optInText, now],
      );
      return await _getOptState(phoneHash, channel);
    },

    recordOptOut: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.recordOptOut: input object required");
      }
      var customerId = _optionalUuid(input.customer_id, "customer_id");
      var phoneHash  = _phoneHash(input.phone_hash);
      var channel    = input.channel == null ? null : _channel(input.channel);
      var reason     = _reason(input.reason, "reason");
      var now        = _now();

      // Operator-supplied channel narrows the opt-out to one channel.
      // Absence → opt-out applies to every channel; the STOP-keyword
      // handler relies on the default-all behaviour to register a
      // single inbound "STOP" against marketing + transactional +
      // verification in one call.
      var channels = channel ? [channel] : CHANNELS.slice();
      var written = [];
      for (var i = 0; i < channels.length; i += 1) {
        var ch = channels[i];
        var existing = await _getOptState(phoneHash, ch);
        if (existing) {
          await query(
            "UPDATE sms_opt_state SET state = 'opt_out', customer_id = ?1, " +
            "reason = ?2, occurred_at = ?3 " +
            "WHERE phone_hash = ?4 AND channel = ?5",
            [customerId, reason, now, phoneHash, ch],
          );
        } else {
          var id = b.uuid.v7();
          await query(
            "INSERT INTO sms_opt_state " +
            "(id, phone_hash, customer_id, channel, state, opt_in_text, reason, occurred_at) " +
            "VALUES (?1, ?2, ?3, ?4, 'opt_out', NULL, ?5, ?6)",
            [id, phoneHash, customerId, ch, reason, now],
          );
        }
        written.push(await _getOptState(phoneHash, ch));
      }
      return written;
    },

    isOptedIn: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.isOptedIn: input object required");
      }
      var phoneHash = _phoneHash(input.phone_hash);
      var channel   = input.channel == null ? null : _channel(input.channel);

      // No channel supplied → "any opt-in row qualifies." Used by
      // callers that just want to know whether the recipient has ever
      // consented to any kind of contact.
      if (channel == null) {
        var r = await query(
          "SELECT state, channel FROM sms_opt_state " +
          "WHERE phone_hash = ?1 AND state = 'opt_in' LIMIT 1",
          [phoneHash],
        );
        return r.rows.length > 0;
      }
      var row = await _getOptState(phoneHash, channel);
      return !!(row && row.state === "opt_in");
    },

    // Inbound message handler — operator's webhook receiver hands the
    // raw inbound SMS body here; the primitive checks for a STOP
    // keyword and registers an opt-out across every channel + queues
    // a single confirmation message. Returns
    // `{ matched: true, opt_state: [...], confirmation: <message> }`
    // when a keyword matched, `{ matched: false }` otherwise.
    handleInboundKeyword: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.handleInboundKeyword: input object required");
      }
      var phoneHash        = _phoneHash(input.phone_hash);
      _phoneNormalized(input.phone_normalized);
      var body             = input.body;
      if (typeof body !== "string") {
        throw new TypeError("smsDispatcher.handleInboundKeyword: body must be a string");
      }
      if (!_isStopKeyword(body)) return { matched: false };

      // Verify the phone_hash matches the supplied phone_normalized
      // so a misrouted webhook can't opt-out the wrong row.
      var expected = b.crypto.namespaceHash(PHONE_NAMESPACE, input.phone_normalized);
      if (expected !== phoneHash) {
        throw new TypeError(
          "smsDispatcher.handleInboundKeyword: phone_hash does not match phone_normalized"
        );
      }

      var now = _now();
      // Opt-out every channel.
      var written = [];
      for (var i = 0; i < CHANNELS.length; i += 1) {
        var ch = CHANNELS[i];
        var existing = await _getOptState(phoneHash, ch);
        if (existing) {
          await query(
            "UPDATE sms_opt_state SET state = 'opt_out', reason = ?1, occurred_at = ?2 " +
            "WHERE phone_hash = ?3 AND channel = ?4",
            ["stop-keyword", now, phoneHash, ch],
          );
        } else {
          var id = b.uuid.v7();
          await query(
            "INSERT INTO sms_opt_state " +
            "(id, phone_hash, customer_id, channel, state, opt_in_text, reason, occurred_at) " +
            "VALUES (?1, ?2, NULL, ?3, 'opt_out', NULL, 'stop-keyword', ?4)",
            [id, phoneHash, ch, now],
          );
        }
        written.push(await _getOptState(phoneHash, ch));
      }

      // Queue the confirmation. STOP confirmations are mandatory in
      // every major SMS regulatory regime (US TCPA, UK PECR, AU Spam
      // Act); the message bypasses the opt-out gate by design (the
      // recipient explicitly opted in to this single reply by sending
      // STOP). country_code defaults to the operator-supplied value;
      // when absent we fall back to the dispatcher's first active
      // provider — operators that want a different default supply it.
      var countryCode = input.country_code == null
        ? null
        : _country(input.country_code);
      var providerSlug = null;
      if (countryCode) {
        var prov = await _resolveProvider(countryCode);
        if (prov) providerSlug = prov.slug;
      }
      var confirmationBody = "You have been unsubscribed. Reply START to opt back in.";
      var messageId = b.uuid.v7();
      await query(
        "INSERT INTO sms_messages " +
        "(id, recipient_phone_hash, country_code, kind, body, status, " +
        " provider_slug, provider_ref, attempts, next_retry_at, failure_reason, " +
        " schedule_at, sent_at, delivered_at, failed_at, customer_id, created_at) " +
        "VALUES (?1, ?2, ?3, 'transactional', ?4, 'queued', " +
        " ?5, NULL, 0, NULL, NULL, ?6, NULL, NULL, NULL, NULL, ?6)",
        [messageId, phoneHash, countryCode || "XX", confirmationBody, providerSlug, now],
      );
      var confirmation = await _getMessage(messageId);
      return { matched: true, opt_state: written, confirmation: confirmation };
    },

    enqueue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.enqueue: input object required");
      }
      var customerId       = _optionalUuid(input.recipient_customer_id, "recipient_customer_id");
      var phoneNormalized  = _phoneNormalized(input.recipient_phone);
      var countryCode      = _country(input.country_code);
      var body             = _body(input.body);
      var kind             = _kind(input.kind);
      var scheduleAt       = input.schedule_at == null ? _now() : _epochMs(input.schedule_at, "schedule_at");
      var now              = _now();
      var phoneHash        = b.crypto.namespaceHash(PHONE_NAMESPACE, phoneNormalized);

      // Opt-in gate. Transactional sends bypass the marketing
      // opt-out — order receipts, ship notifications, refund
      // confirmations are non-marketing and the regulatory envelope
      // (US TCPA, UK PECR) treats them separately. A `transactional`
      // send still refuses when the recipient has an explicit
      // `transactional` opt-out row (operator-acknowledged
      // do-not-contact). A `verification` send refuses on a
      // verification opt-out. A `marketing` send refuses on either
      // a marketing opt-out OR the absence of a marketing opt-in
      // row (opt-IN semantics — marketing is on the strictest tier).
      if (kind === "marketing") {
        var marketingRow = await _getOptState(phoneHash, "marketing");
        if (!marketingRow || marketingRow.state !== "opt_in") {
          var mErr = new Error("smsDispatcher.enqueue: recipient is not opted-in to marketing");
          mErr.code = "NOT_OPTED_IN";
          throw mErr;
        }
      } else {
        // transactional / verification — refuse only on explicit
        // opt-out for the matching channel.
        var explicitRow = await _getOptState(phoneHash, kind);
        if (explicitRow && explicitRow.state === "opt_out") {
          var oErr = new Error("smsDispatcher.enqueue: recipient opted-out of " + kind);
          oErr.code = "OPTED_OUT";
          throw oErr;
        }
      }

      // Provider routing. No provider for the country → refuse so the
      // operator catches the missing wiring instead of silently
      // queuing a row that the dispatcher will never advance.
      var provider = await _resolveProvider(countryCode);
      if (!provider) {
        var pErr = new Error("smsDispatcher.enqueue: no active provider covers " + countryCode);
        pErr.code = "NO_PROVIDER";
        throw pErr;
      }

      var id = b.uuid.v7();
      await query(
        "INSERT INTO sms_messages " +
        "(id, recipient_phone_hash, country_code, kind, body, status, " +
        " provider_slug, provider_ref, attempts, next_retry_at, failure_reason, " +
        " schedule_at, sent_at, delivered_at, failed_at, customer_id, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'queued', " +
        " ?6, NULL, 0, NULL, NULL, ?7, NULL, NULL, NULL, ?8, ?9)",
        [id, phoneHash, countryCode, kind, body, provider.slug, scheduleAt, customerId, now],
      );
      return await _getMessage(id);
    },

    markDelivered: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.markDelivered: input object required");
      }
      var messageId  = _uuid(input.message_id, "message_id");
      var providerRef = _providerRef(input.provider_ref);
      var now         = _now();

      var existing = await _getMessage(messageId);
      if (!existing) {
        var nfErr = new Error("smsDispatcher.markDelivered: message " + messageId + " not found");
        nfErr.code = "MESSAGE_NOT_FOUND";
        throw nfErr;
      }
      if (existing.status === "delivered") {
        // Idempotent — provider may deliver the receipt twice.
        return existing;
      }
      // Transitions to `delivered` are allowed from `sent` (normal
      // path) and from `queued` (operator's send hook stamps
      // delivered straight away for a synchronous provider).
      // Terminal `failed` rows refuse the transition — the operator
      // sees the contradiction explicitly instead of having a failed
      // row silently flip back to success.
      if (existing.status === "failed") {
        var fsmErr = new Error(
          "smsDispatcher.markDelivered: refusing delivered transition from terminal failed"
        );
        fsmErr.code = "FSM_TERMINAL";
        throw fsmErr;
      }
      await query(
        "UPDATE sms_messages SET status = 'delivered', provider_ref = ?1, " +
        "delivered_at = ?2, sent_at = COALESCE(sent_at, ?2) " +
        "WHERE id = ?3",
        [providerRef, now, messageId],
      );
      return await _getMessage(messageId);
    },

    markFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.markFailed: input object required");
      }
      var messageId = _uuid(input.message_id, "message_id");
      var reason    = _reason(input.reason, "reason");
      var retry     = !!input.retry;
      var now       = _now();

      var existing = await _getMessage(messageId);
      if (!existing) {
        var nfErr = new Error("smsDispatcher.markFailed: message " + messageId + " not found");
        nfErr.code = "MESSAGE_NOT_FOUND";
        throw nfErr;
      }
      if (existing.status === "delivered") {
        var fsmErr = new Error(
          "smsDispatcher.markFailed: refusing failed transition from terminal delivered"
        );
        fsmErr.code = "FSM_TERMINAL";
        throw fsmErr;
      }

      var attempts = Number(existing.attempts || 0) + 1;
      if (retry && attempts < RETRY_BACKOFF_MS.length) {
        // Re-queue with back-off. Pick the entry matching the
        // post-increment attempt index so the first failure waits
        // RETRY_BACKOFF_MS[1] (60s isn't enough for some carriers
        // — the schedule starts at 1m and ramps to 12h).
        var nextRetryAt = now + RETRY_BACKOFF_MS[attempts - 1];
        await query(
          "UPDATE sms_messages SET status = 'queued', attempts = ?1, " +
          "next_retry_at = ?2, schedule_at = ?2, failure_reason = ?3 " +
          "WHERE id = ?4",
          [attempts, nextRetryAt, reason, messageId],
        );
        return await _getMessage(messageId);
      }
      // Terminal failure — exhausted retry budget OR caller asked for
      // a hard fail. Stamp failed_at + persist the reason.
      await query(
        "UPDATE sms_messages SET status = 'failed', attempts = ?1, " +
        "next_retry_at = NULL, failure_reason = ?2, failed_at = ?3 " +
        "WHERE id = ?4",
        [attempts, reason, now, messageId],
      );
      return await _getMessage(messageId);
    },

    // Scheduler-callable. Pulls every queued message whose
    // schedule_at is due, flips status to `sent`, and returns the
    // updated rows. The operator's send hook (composed at the route
    // layer) is responsible for the actual provider POST + the
    // subsequent markDelivered / markFailed; this surface only
    // advances the FSM out of `queued`. A null `now` defaults to
    // Date.now() but the explicit form keeps tests deterministic.
    dispatchTick: async function (input) {
      input = input || {};
      var now = input.now == null ? _now() : _epochMs(input.now, "now");
      var batchSize = _batchSize(input.batch_size);

      var due = await query(
        "SELECT * FROM sms_messages " +
        "WHERE status = 'queued' AND schedule_at <= ?1 " +
        "ORDER BY schedule_at ASC, id ASC LIMIT ?2",
        [now, batchSize],
      );

      var advanced = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var row = due.rows[i];
        // The provider_slug stamp at enqueue is the routing
        // decision; resolve it again here only if the row has no
        // provider yet (STOP confirmation queued without a country
        // hint). A missing provider at tick time terminates the row
        // as failed — operators can't dispatch a message that has
        // no egress.
        var providerSlug = row.provider_slug;
        if (!providerSlug) {
          var resolved = await _resolveProvider(row.country_code);
          if (resolved) providerSlug = resolved.slug;
        }
        if (!providerSlug) {
          // Atomic claim. The snapshot SELECT above is read without a
          // lock, so two concurrent ticks can both pull this same
          // `queued` row. The `AND status = 'queued'` guard makes the
          // transition the claim: SQLite/D1 serialises writers, so
          // exactly one tick's UPDATE matches the row (rowCount === 1)
          // and the other sees rowCount === 0. Only the winner hands the
          // row to the operator's send hook (via `advanced`), so the
          // terminal failure is recorded — and surfaced — exactly once.
          var lostFail = await query(
            "UPDATE sms_messages SET status = 'failed', failure_reason = ?1, " +
            "failed_at = ?2 WHERE id = ?3 AND status = 'queued'",
            ["no_provider_at_dispatch", now, row.id],
          );
          if (!b.sql.casWon(lostFail).won) continue;
          advanced.push(await _getMessage(row.id));
          continue;
        }
        // Atomic claim on the advance to `sent` — same race, same guard.
        // The loser skips so the operator's send hook (the real provider
        // POST) fires once per row, never twice for one message.
        var claimed = await query(
          "UPDATE sms_messages SET status = 'sent', provider_slug = ?1, " +
          "sent_at = ?2 WHERE id = ?3 AND status = 'queued'",
          [providerSlug, now, row.id],
        );
        if (!b.sql.casWon(claimed).won) continue;
        advanced.push(await _getMessage(row.id));
      }
      return advanced;
    },

    messagesForCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.messagesForCustomer: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var limit      = _limit(input.limit, "limit");
      var cursor     = _optionalEpochMs(input.cursor, "cursor");

      var sql, params;
      if (cursor == null) {
        sql = "SELECT * FROM sms_messages WHERE customer_id = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [customerId, limit];
      } else {
        sql = "SELECT * FROM sms_messages WHERE customer_id = ?1 AND created_at < ?2 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?3";
        params = [customerId, cursor, limit];
      }
      var r = await query(sql, params);
      var nextCursor = null;
      if (r.rows.length === limit) {
        nextCursor = Number(r.rows[r.rows.length - 1].created_at);
      }
      return { rows: r.rows, next_cursor: nextCursor };
    },

    // Operator lookup by provider reference — used when the
    // provider's delivery-receipt webhook arrives and the operator's
    // hook needs to find the matching local row before calling
    // markDelivered / markFailed.
    messageByProviderRef: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("smsDispatcher.messageByProviderRef: input object required");
      }
      var providerSlug = _slug(input.provider_slug, "provider_slug");
      var providerRef  = _providerRef(input.provider_ref);
      var r = await query(
        "SELECT * FROM sms_messages WHERE provider_slug = ?1 AND provider_ref = ?2 LIMIT 1",
        [providerSlug, providerRef],
      );
      return r.rows[0] || null;
    },
  };
}

module.exports = {
  create:             create,
  CHANNELS:           CHANNELS.slice(),
  STATES:             STATES.slice(),
  KINDS:              KINDS.slice(),
  STATUSES:           STATUSES.slice(),
  STOP_KEYWORDS:      STOP_KEYWORDS.slice(),
  RETRY_BACKOFF_MS:   RETRY_BACKOFF_MS.slice(),
  PHONE_NAMESPACE:    PHONE_NAMESPACE,
  MAX_SLUG_LEN:       MAX_SLUG_LEN,
  MAX_BODY_LEN:       MAX_BODY_LEN,
  MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT: DEFAULT_LIST_LIMIT,
  MAX_BATCH_SIZE:     MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE,
};
