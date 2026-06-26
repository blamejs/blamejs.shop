"use strict";
/**
 * @module shop.pushNotifications
 * @title  Push notifications — outbound mobile + web push layer
 *
 * @intro
 *   Outbound push-notification layer. Operators register one provider
 *   per egress class (APNs for iOS, FCM for Android, VAPID for web
 *   push), register per-customer device tokens against a provider,
 *   and queue notifications that the dispatcher tick hands to the
 *   operator-wired send hook. The HTTP push itself does not happen
 *   in this primitive — the operator composes the dispatcher with
 *   the provider's egress at the route layer; this surface only
 *   owns the registry, the consent matrix, and the delivery FSM.
 *
 *   Channel consent is opt-in per customer per channel
 *   (`marketing` / `transactional` / `alert`). Marketing pushes
 *   refuse without an explicit opt-in row; transactional + alert
 *   pushes refuse only on an explicit opt-out for the matching
 *   channel.
 *
 *   The shape:
 *
 *     var push = bShop.pushNotifications.create({ query: q });
 *
 *     await push.registerProvider({
 *       slug:        "apns-prod",
 *       kind:        "apns",
 *       credentials: "-----BEGIN PRIVATE KEY-----\\n...",
 *       active:      true,
 *     });
 *
 *     await push.registerDevice({
 *       customer_id:   customerId,
 *       provider_slug: "apns-prod",
 *       device_token:  "a1b2c3d4...",
 *       device_class:  "ios",
 *       locale:        "en-US",
 *     });
 *
 *     await push.recordOptIn({ customer_id: customerId, channel: "marketing" });
 *
 *     await push.enqueueNotification({
 *       recipient_customer_id: customerId,
 *       channel:               "transactional",
 *       title:                 "Order shipped",
 *       body:                  "Your order #1234 is on the way.",
 *       payload:               { order_id: "1234" },
 *     });
 *
 *     // Scheduler tick — operator wires this to a cron / Workers
 *     // Cron Trigger. Pulls every queued notification whose
 *     // schedule_at is due, hands it to the operator-wired send hook,
 *     // and flips status to `sent`. The send hook stamps
 *     // provider_message_id via `markDelivered` when the provider's
 *     // acknowledgement arrives; transient failures flow through
 *     // `markFailed` with `retry: true` so the row re-queues with
 *     // back-off.
 *     await push.dispatchTick({ now: Date.now() });
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
var C = b.constants;

// ---- constants ----------------------------------------------------------

var DEVICE_TOKEN_NAMESPACE = "push-device-token";
var CREDENTIALS_NAMESPACE  = "push-provider-credentials";

var KINDS         = ["apns", "fcm", "web_push"];
var DEVICE_CLASSES = ["ios", "android", "web", "desktop"];
var CHANNELS      = ["marketing", "transactional", "alert"];
var STATES        = ["opt_in", "opt_out"];
var STATUSES      = ["queued", "sent", "delivered", "failed"];

var MAX_SLUG_LEN         = 64;
var MAX_TITLE_LEN        = 256;
var MAX_BODY_LEN         = 4096;
var MIN_TITLE_LEN        = 1;
var MIN_BODY_LEN         = 1;
var MAX_REASON_LEN       = 280;
var MAX_TOKEN_LEN        = 4096;
var MIN_TOKEN_LEN        = 8;
var MAX_LOCALE_LEN       = 35;
var MAX_CREDENTIALS_LEN  = 32 * 1024;     // 32 KiB upper bound on credential material
var MIN_CREDENTIALS_LEN  = 16;
var MAX_PAYLOAD_BYTES    = 16 * 1024;     // 16 KiB serialised JSON payload
var MAX_LIST_LIMIT       = 500;
var DEFAULT_LIST_LIMIT   = 100;
var MAX_BATCH_SIZE       = 1000;
var DEFAULT_BATCH_SIZE   = 100;
var MAX_PROV_MSG_ID_LEN  = 256;

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

var SLUG_RE         = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
var LOCALE_RE       = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;
var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE   = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pushNotifications: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("pushNotifications: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("pushNotifications: " + label + " must match /[a-z][a-z0-9-]*[a-z0-9]/");
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("pushNotifications: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _deviceClass(s) {
  if (typeof s !== "string" || DEVICE_CLASSES.indexOf(s) === -1) {
    throw new TypeError("pushNotifications: device_class must be one of " + DEVICE_CLASSES.join(", "));
  }
  return s;
}

function _channel(s) {
  if (typeof s !== "string" || CHANNELS.indexOf(s) === -1) {
    throw new TypeError("pushNotifications: channel must be one of " + CHANNELS.join(", "));
  }
  return s;
}

function _credentials(s) {
  if (typeof s !== "string" || s.length < MIN_CREDENTIALS_LEN) {
    throw new TypeError("pushNotifications: credentials must be a string >= " + MIN_CREDENTIALS_LEN + " characters");
  }
  if (s.length > MAX_CREDENTIALS_LEN) {
    throw new TypeError("pushNotifications: credentials must be <= " + MAX_CREDENTIALS_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("pushNotifications: credentials contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pushNotifications: credentials contains zero-width / bidi-override codepoints");
  }
  return s;
}

function _deviceToken(s) {
  if (typeof s !== "string" || s.length < MIN_TOKEN_LEN) {
    throw new TypeError("pushNotifications: device_token must be a string >= " + MIN_TOKEN_LEN + " characters");
  }
  if (s.length > MAX_TOKEN_LEN) {
    throw new TypeError("pushNotifications: device_token must be <= " + MAX_TOKEN_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("pushNotifications: device_token contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pushNotifications: device_token contains zero-width / bidi-override codepoints");
  }
  return s;
}

function _locale(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pushNotifications: locale must be a non-empty string when provided");
  }
  if (s.length > MAX_LOCALE_LEN) {
    throw new TypeError("pushNotifications: locale must be <= " + MAX_LOCALE_LEN + " characters");
  }
  if (!LOCALE_RE.test(s)) {
    throw new TypeError("pushNotifications: locale must look like a BCP-47 tag (e.g. en-US)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || s.length < MIN_TITLE_LEN) {
    throw new TypeError("pushNotifications: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("pushNotifications: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("pushNotifications: title contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pushNotifications: title contains zero-width / bidi-override codepoints");
  }
  return s;
}

function _body(s) {
  if (typeof s !== "string" || s.length < MIN_BODY_LEN) {
    throw new TypeError("pushNotifications: body must be a non-empty string");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("pushNotifications: body must be <= " + MAX_BODY_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("pushNotifications: body contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pushNotifications: body contains zero-width / bidi-override codepoints");
  }
  return s;
}

function _payload(p) {
  if (p == null) return null;
  if (typeof p !== "object" || Array.isArray(p)) {
    throw new TypeError("pushNotifications: payload must be a plain object when provided");
  }
  var json;
  try { json = JSON.stringify(p); }
  catch (e) {
    throw new TypeError("pushNotifications: payload is not JSON-serialisable: " + (e && e.message || e));
  }
  if (typeof json !== "string") {
    throw new TypeError("pushNotifications: payload did not serialise to a string");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new TypeError("pushNotifications: payload exceeds " + MAX_PAYLOAD_BYTES + " bytes serialised");
  }
  return json;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("pushNotifications: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _reason(s, label) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pushNotifications: " + label + " must be a non-empty string when provided");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("pushNotifications: " + label + " must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pushNotifications: " + label + " contains control / zero-width bytes");
  }
  return s;
}

function _providerMessageId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pushNotifications: provider_message_id must be a non-empty string");
  }
  if (s.length > MAX_PROV_MSG_ID_LEN) {
    throw new TypeError("pushNotifications: provider_message_id must be <= " + MAX_PROV_MSG_ID_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pushNotifications: provider_message_id contains control / zero-width bytes");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("pushNotifications: " + label + " must be a positive integer (epoch ms)");
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
    throw new TypeError("pushNotifications: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("pushNotifications: batch_size must be an integer in [1, " + MAX_BATCH_SIZE + "]");
  }
  return n;
}

// Monotonic clock. Date.now() can stall on the same millisecond when
// the caller writes a tight loop of rows; the ratchet bumps every
// repeat by +1ms so each row gets a unique created_at / occurred_at
// and the per-customer / provider-message-id ordering reads cleanly.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // -------- internal helpers --------

  function hashDeviceToken(tokenNormalised) {
    _deviceToken(tokenNormalised);
    return b.crypto.namespaceHash(DEVICE_TOKEN_NAMESPACE, tokenNormalised);
  }

  function hashCredentials(credentialsNormalised) {
    _credentials(credentialsNormalised);
    return b.crypto.namespaceHash(CREDENTIALS_NAMESPACE, credentialsNormalised);
  }

  async function _getProvider(slug) {
    var r = await query("SELECT * FROM push_providers WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _getNotification(id) {
    var r = await query("SELECT * FROM push_notifications WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getDevice(id) {
    var r = await query("SELECT * FROM push_devices WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getDeviceByTokenHash(tokenHash) {
    var r = await query("SELECT * FROM push_devices WHERE device_token_hash = ?1", [tokenHash]);
    return r.rows[0] || null;
  }

  async function _getOptState(customerId, channel) {
    var r = await query(
      "SELECT * FROM push_opt_state WHERE customer_id = ?1 AND channel = ?2",
      [customerId, channel],
    );
    return r.rows[0] || null;
  }

  // -------- public surface --------

  return {
    // Surface the constants the operator's authoring code consults.
    KINDS:             KINDS.slice(),
    DEVICE_CLASSES:    DEVICE_CLASSES.slice(),
    CHANNELS:          CHANNELS.slice(),
    STATES:            STATES.slice(),
    STATUSES:          STATUSES.slice(),
    RETRY_BACKOFF_MS:  RETRY_BACKOFF_MS.slice(),
    DEVICE_TOKEN_NAMESPACE: DEVICE_TOKEN_NAMESPACE,
    CREDENTIALS_NAMESPACE:  CREDENTIALS_NAMESPACE,
    MAX_SLUG_LEN:           MAX_SLUG_LEN,
    MAX_TITLE_LEN:          MAX_TITLE_LEN,
    MAX_BODY_LEN:           MAX_BODY_LEN,
    MAX_PAYLOAD_BYTES:      MAX_PAYLOAD_BYTES,
    MAX_LIST_LIMIT:         MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:     DEFAULT_LIST_LIMIT,
    MAX_BATCH_SIZE:         MAX_BATCH_SIZE,
    DEFAULT_BATCH_SIZE:     DEFAULT_BATCH_SIZE,

    // Helpers surfaced so callers compose with the same hash function
    // the primitive uses internally.
    hashDeviceToken: hashDeviceToken,
    hashCredentials: hashCredentials,

    registerProvider: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.registerProvider: input object required");
      }
      var slug         = _slug(input.slug, "slug");
      var kind         = _kind(input.kind);
      _credentials(input.credentials);
      var credentialsNormalised = input.credentials;
      var credentialsHash       = b.crypto.namespaceHash(CREDENTIALS_NAMESPACE, credentialsNormalised);
      var active       = input.active == null ? true : !!input.active;
      var now          = _now();

      var existing = await _getProvider(slug);
      if (existing) {
        // Re-registering after archive un-archives — operators
        // rotating provider credentials don't need a separate
        // "unarchive" verb. The kind is locked at first registration:
        // a slug that started as `apns` can't become `fcm` later
        // without a separate slug. That refusal protects the metrics
        // surface from cross-transport contamination.
        if (existing.kind !== kind) {
          throw new TypeError(
            "pushNotifications.registerProvider: cannot change kind for existing provider '" +
            slug + "' (was '" + existing.kind + "', requested '" + kind + "')"
          );
        }
        await query(
          "UPDATE push_providers SET credentials_hash = ?1, credentials_normalised = ?2, " +
          "active = ?3, archived_at = NULL, updated_at = ?4 WHERE slug = ?5",
          [credentialsHash, credentialsNormalised, active ? 1 : 0, now, slug],
        );
      } else {
        await query(
          "INSERT INTO push_providers " +
          "(slug, kind, credentials_hash, credentials_normalised, active, " +
          " archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
          [slug, kind, credentialsHash, credentialsNormalised, active ? 1 : 0, now],
        );
      }
      return await _getProvider(slug);
    },

    registerDevice: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.registerDevice: input object required");
      }
      var customerId   = _uuid(input.customer_id, "customer_id");
      var providerSlug = _slug(input.provider_slug, "provider_slug");
      var token        = _deviceToken(input.device_token);
      var deviceClass  = _deviceClass(input.device_class);
      var locale       = _locale(input.locale);
      var now          = _now();
      var tokenHash    = b.crypto.namespaceHash(DEVICE_TOKEN_NAMESPACE, token);

      // Provider must exist + be active. Devices registered against
      // an archived / inactive provider can't be dispatched against,
      // so the registration refusal surfaces the wiring gap at the
      // write site instead of letting the device row collect dust.
      var provider = await _getProvider(providerSlug);
      if (!provider) {
        throw new TypeError(
          "pushNotifications.registerDevice: provider '" + providerSlug + "' not registered"
        );
      }
      if (Number(provider.active) !== 1 || provider.archived_at != null) {
        throw new TypeError(
          "pushNotifications.registerDevice: provider '" + providerSlug + "' is inactive / archived"
        );
      }

      // Token-class compatibility check. iOS tokens go to APNs,
      // Android tokens to FCM, web tokens to web_push. The desktop
      // class can ride either FCM (Chrome desktop push) or web_push
      // (Safari / Firefox), so it's allowed against both.
      var compatible = (
        (deviceClass === "ios"     && provider.kind === "apns")     ||
        (deviceClass === "android" && provider.kind === "fcm")      ||
        (deviceClass === "web"     && provider.kind === "web_push") ||
        (deviceClass === "desktop" && (provider.kind === "fcm" || provider.kind === "web_push"))
      );
      if (!compatible) {
        throw new TypeError(
          "pushNotifications.registerDevice: device_class '" + deviceClass +
          "' is not compatible with provider kind '" + provider.kind + "'"
        );
      }

      // UNIQUE(device_token_hash) — re-registering the same token
      // updates the existing row (customer_id may change when the app
      // is reinstalled under a different account; locale + last_seen
      // refresh on every heartbeat). The revocation lifts on a fresh
      // registration because the operator's app has the token live
      // again.
      var existing = await _getDeviceByTokenHash(tokenHash);
      if (existing) {
        await query(
          "UPDATE push_devices SET customer_id = ?1, provider_slug = ?2, " +
          "device_token_normalised = ?3, device_class = ?4, locale = ?5, " +
          "revoked_at = NULL, revoke_reason = NULL, last_seen_at = ?6 " +
          "WHERE device_token_hash = ?7",
          [customerId, providerSlug, token, deviceClass, locale, now, tokenHash],
        );
        return await _getDeviceByTokenHash(tokenHash);
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO push_devices " +
        "(id, customer_id, provider_slug, device_token_hash, " +
        " device_token_normalised, device_class, locale, " +
        " revoked_at, revoke_reason, last_seen_at, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?8)",
        [id, customerId, providerSlug, tokenHash, token, deviceClass, locale, now],
      );
      return await _getDevice(id);
    },

    revokeDevice: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.revokeDevice: input object required");
      }
      var deviceId = _uuid(input.device_id, "device_id");
      var reason   = _reason(input.reason, "reason");
      var now      = _now();

      var existing = await _getDevice(deviceId);
      if (!existing) {
        var nfErr = new Error("pushNotifications.revokeDevice: device " + deviceId + " not found");
        nfErr.code = "DEVICE_NOT_FOUND";
        throw nfErr;
      }
      // Idempotent — a second revoke refreshes the reason but
      // doesn't bump `revoked_at` (the first revocation is the one
      // operators reconcile against).
      if (existing.revoked_at != null) {
        if (reason) {
          await query(
            "UPDATE push_devices SET revoke_reason = ?1 WHERE id = ?2",
            [reason, deviceId],
          );
        }
        return await _getDevice(deviceId);
      }
      await query(
        "UPDATE push_devices SET revoked_at = ?1, revoke_reason = ?2 WHERE id = ?3",
        [now, reason, deviceId],
      );
      return await _getDevice(deviceId);
    },

    recordOptIn: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.recordOptIn: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var channel    = _channel(input.channel);
      var now        = _now();

      var existing = await _getOptState(customerId, channel);
      if (existing) {
        await query(
          "UPDATE push_opt_state SET state = 'opt_in', reason = NULL, occurred_at = ?1 " +
          "WHERE customer_id = ?2 AND channel = ?3",
          [now, customerId, channel],
        );
        return await _getOptState(customerId, channel);
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO push_opt_state " +
        "(id, customer_id, channel, state, reason, occurred_at) " +
        "VALUES (?1, ?2, ?3, 'opt_in', NULL, ?4)",
        [id, customerId, channel, now],
      );
      return await _getOptState(customerId, channel);
    },

    recordOptOut: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.recordOptOut: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var channel    = input.channel == null ? null : _channel(input.channel);
      var reason     = _reason(input.reason, "reason");
      var now        = _now();

      // Operator-supplied channel narrows the opt-out to one
      // channel. Absence → opt-out applies to every channel; a
      // single call captures the global "user disabled push
      // notifications" toggle.
      var channels = channel ? [channel] : CHANNELS.slice();
      var written = [];
      for (var i = 0; i < channels.length; i += 1) {
        var ch = channels[i];
        var existing = await _getOptState(customerId, ch);
        if (existing) {
          await query(
            "UPDATE push_opt_state SET state = 'opt_out', reason = ?1, occurred_at = ?2 " +
            "WHERE customer_id = ?3 AND channel = ?4",
            [reason, now, customerId, ch],
          );
        } else {
          var id = b.uuid.v7();
          await query(
            "INSERT INTO push_opt_state " +
            "(id, customer_id, channel, state, reason, occurred_at) " +
            "VALUES (?1, ?2, ?3, 'opt_out', ?4, ?5)",
            [id, customerId, ch, reason, now],
          );
        }
        written.push(await _getOptState(customerId, ch));
      }
      return written;
    },

    isOptedIn: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.isOptedIn: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var channel    = input.channel == null ? null : _channel(input.channel);

      if (channel == null) {
        var r = await query(
          "SELECT state FROM push_opt_state " +
          "WHERE customer_id = ?1 AND state = 'opt_in' LIMIT 1",
          [customerId],
        );
        return r.rows.length > 0;
      }
      var row = await _getOptState(customerId, channel);
      return !!(row && row.state === "opt_in");
    },

    enqueueNotification: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.enqueueNotification: input object required");
      }
      var customerId = _uuid(input.recipient_customer_id, "recipient_customer_id");
      var channel    = _channel(input.channel);
      var title      = _title(input.title);
      var body       = _body(input.body);
      var payloadJson = _payload(input.payload);
      var scheduleAt = input.schedule_at == null ? _now() : _epochMs(input.schedule_at, "schedule_at");
      var now        = _now();

      // Opt-in gate. Marketing pushes refuse without an explicit
      // opt-in row (opt-IN semantics — the strictest channel).
      // Transactional + alert pushes refuse only on an explicit
      // opt-out for the matching channel.
      if (channel === "marketing") {
        var marketingRow = await _getOptState(customerId, "marketing");
        if (!marketingRow || marketingRow.state !== "opt_in") {
          var mErr = new Error("pushNotifications.enqueueNotification: recipient is not opted-in to marketing");
          mErr.code = "NOT_OPTED_IN";
          throw mErr;
        }
      } else {
        var explicitRow = await _getOptState(customerId, channel);
        if (explicitRow && explicitRow.state === "opt_out") {
          var oErr = new Error("pushNotifications.enqueueNotification: recipient opted-out of " + channel);
          oErr.code = "OPTED_OUT";
          throw oErr;
        }
      }

      // Recipient must have at least one non-revoked device. No
      // device → no egress, no point queueing. Operators that want
      // to drop the notification entirely catch the NO_DEVICE code;
      // operators that want to queue ahead of registration handle
      // the registration on the app side first.
      var devices = await query(
        "SELECT * FROM push_devices WHERE customer_id = ?1 AND revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1",
        [customerId],
      );
      if (devices.rows.length === 0) {
        var dErr = new Error("pushNotifications.enqueueNotification: recipient has no active devices");
        dErr.code = "NO_DEVICE";
        throw dErr;
      }
      var providerSlug = devices.rows[0].provider_slug;

      var id = b.uuid.v7();
      await query(
        "INSERT INTO push_notifications " +
        "(id, recipient_customer_id, channel, title, body, payload_json, status, " +
        " provider_slug, provider_message_id, attempts, next_retry_at, fail_reason, " +
        " schedule_at, dispatched_at, delivered_at, failed_at, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', " +
        " ?7, NULL, 0, NULL, NULL, ?8, NULL, NULL, NULL, ?9)",
        [id, customerId, channel, title, body, payloadJson, providerSlug, scheduleAt, now],
      );
      return await _getNotification(id);
    },

    markDelivered: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.markDelivered: input object required");
      }
      var notificationId   = _uuid(input.notification_id, "notification_id");
      var providerMessageId = _providerMessageId(input.provider_message_id);
      var now              = _now();

      var existing = await _getNotification(notificationId);
      if (!existing) {
        var nfErr = new Error("pushNotifications.markDelivered: notification " + notificationId + " not found");
        nfErr.code = "NOTIFICATION_NOT_FOUND";
        throw nfErr;
      }
      if (existing.status === "delivered") {
        // Idempotent — the provider may deliver the receipt twice.
        return existing;
      }
      // Terminal `failed` refuses the transition so the operator
      // sees the contradiction explicitly instead of having a
      // failed row silently flip back to success.
      if (existing.status === "failed") {
        var fsmErr = new Error(
          "pushNotifications.markDelivered: refusing delivered transition from terminal failed"
        );
        fsmErr.code = "FSM_TERMINAL";
        throw fsmErr;
      }
      await query(
        "UPDATE push_notifications SET status = 'delivered', provider_message_id = ?1, " +
        "delivered_at = ?2, dispatched_at = COALESCE(dispatched_at, ?2) " +
        "WHERE id = ?3",
        [providerMessageId, now, notificationId],
      );
      return await _getNotification(notificationId);
    },

    markFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.markFailed: input object required");
      }
      var notificationId = _uuid(input.notification_id, "notification_id");
      var reason         = _reason(input.reason, "reason");
      var retry          = !!input.retry;
      var now            = _now();

      var existing = await _getNotification(notificationId);
      if (!existing) {
        var nfErr = new Error("pushNotifications.markFailed: notification " + notificationId + " not found");
        nfErr.code = "NOTIFICATION_NOT_FOUND";
        throw nfErr;
      }
      if (existing.status === "delivered") {
        var fsmErr = new Error(
          "pushNotifications.markFailed: refusing failed transition from terminal delivered"
        );
        fsmErr.code = "FSM_TERMINAL";
        throw fsmErr;
      }

      var attempts = Number(existing.attempts || 0) + 1;
      if (retry && attempts < RETRY_BACKOFF_MS.length) {
        // Re-queue with back-off. Pick the entry matching the
        // post-increment attempt index so the first failure waits
        // RETRY_BACKOFF_MS[0] = 1m.
        var nextRetryAt = now + RETRY_BACKOFF_MS[attempts - 1];
        await query(
          "UPDATE push_notifications SET status = 'queued', attempts = ?1, " +
          "next_retry_at = ?2, schedule_at = ?2, fail_reason = ?3 " +
          "WHERE id = ?4",
          [attempts, nextRetryAt, reason, notificationId],
        );
        return await _getNotification(notificationId);
      }
      // Terminal failure — exhausted retry budget OR caller asked
      // for a hard fail.
      await query(
        "UPDATE push_notifications SET status = 'failed', attempts = ?1, " +
        "next_retry_at = NULL, fail_reason = ?2, failed_at = ?3 " +
        "WHERE id = ?4",
        [attempts, reason, now, notificationId],
      );
      return await _getNotification(notificationId);
    },

    // Scheduler-callable. Pulls every queued notification whose
    // schedule_at is due, flips status to `sent`, and returns the
    // updated rows. The operator's send hook (composed at the route
    // layer) is responsible for the actual provider POST + the
    // subsequent markDelivered / markFailed; this surface only
    // advances the FSM out of `queued`.
    dispatchTick: async function (input) {
      input = input || {};
      var now = input.now == null ? _now() : _epochMs(input.now, "now");
      var batchSize = _batchSize(input.batch_size);

      var due = await query(
        "SELECT * FROM push_notifications " +
        "WHERE status = 'queued' AND schedule_at <= ?1 " +
        "ORDER BY schedule_at ASC, id ASC LIMIT ?2",
        [now, batchSize],
      );

      var advanced = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var row = due.rows[i];
        // The provider_slug stamp at enqueue is the routing
        // decision. A row whose provider is now archived / inactive
        // terminates as failed at tick time — operators see the
        // refusal in the metrics surface rather than chasing a
        // silent queue stall.
        var providerSlug = row.provider_slug;
        var provider = providerSlug ? await _getProvider(providerSlug) : null;
        if (!provider || Number(provider.active) !== 1 || provider.archived_at != null) {
          // Atomic claim. The snapshot SELECT above is read without a
          // lock, so two concurrent ticks can both pull this same
          // `queued` row. The `AND status = 'queued'` guard makes the
          // transition the claim: SQLite/D1 serialises writers, so
          // exactly one tick's UPDATE matches the row (rowCount === 1)
          // and the other sees rowCount === 0. Only the winner hands
          // the row to the operator's send hook (via `advanced`), so
          // the customer is never double-dispatched.
          var lostFail = await query(
            "UPDATE push_notifications SET status = 'failed', fail_reason = ?1, " +
            "failed_at = ?2 WHERE id = ?3 AND status = 'queued'",
            ["provider_unavailable_at_dispatch", now, row.id],
          );
          if (!b.sql.casWon(lostFail).won) continue;
          advanced.push(await _getNotification(row.id));
          continue;
        }
        // Atomic claim on the advance to `sent` — same race, same
        // guard. The loser skips so the send hook fires once per row.
        var claimed = await query(
          "UPDATE push_notifications SET status = 'sent', dispatched_at = ?1 " +
          "WHERE id = ?2 AND status = 'queued'",
          [now, row.id],
        );
        if (!b.sql.casWon(claimed).won) continue;
        advanced.push(await _getNotification(row.id));
      }
      return advanced;
    },

    notificationsForCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.notificationsForCustomer: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var limit      = _limit(input.limit, "limit");
      var cursor     = _optionalEpochMs(input.cursor, "cursor");

      var sql, params;
      if (cursor == null) {
        sql = "SELECT * FROM push_notifications WHERE recipient_customer_id = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [customerId, limit];
      } else {
        sql = "SELECT * FROM push_notifications WHERE recipient_customer_id = ?1 AND created_at < ?2 " +
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

    devicesForCustomer: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT * FROM push_devices WHERE customer_id = ?1 ORDER BY revoked_at IS NULL DESC, last_seen_at DESC",
        [cid],
      );
      return r.rows;
    },

    // Aggregate per-provider engagement over a window. The rate
    // denominators are the count of dispatched notifications
    // (status in {sent, delivered, failed}); `delivery_rate` is
    // delivered/dispatched and `failure_rate` is failed/dispatched.
    // Returns zeros instead of NaN when the window contains no
    // dispatched rows.
    metricsForProvider: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pushNotifications.metricsForProvider: input object required");
      }
      var slug = _slug(input.slug, "slug");
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to, "to");
      if (to < from) {
        throw new TypeError("pushNotifications.metricsForProvider: 'to' must be >= 'from'");
      }

      var rows = (await query(
        "SELECT status, COUNT(*) AS n FROM push_notifications " +
        "WHERE provider_slug = ?1 AND created_at >= ?2 AND created_at <= ?3 " +
        "GROUP BY status",
        [slug, from, to],
      )).rows;

      var counts = {};
      for (var i = 0; i < STATUSES.length; i += 1) counts[STATUSES[i]] = 0;
      for (var j = 0; j < rows.length; j += 1) {
        counts[rows[j].status] = Number(rows[j].n || 0);
      }
      var dispatched = counts.sent + counts.delivered + counts.failed;
      var total      = counts.queued + dispatched;

      function _rate(n, d) { return d > 0 ? n / d : 0; }

      return {
        slug:           slug,
        from:           from,
        to:             to,
        total:          total,
        queued:         counts.queued,
        sent:           counts.sent,
        delivered:      counts.delivered,
        failed:         counts.failed,
        dispatched:     dispatched,
        delivery_rate:  _rate(counts.delivered, dispatched),
        failure_rate:   _rate(counts.failed,    dispatched),
      };
    },
  };
}

module.exports = {
  create:             create,
  KINDS:              KINDS.slice(),
  DEVICE_CLASSES:     DEVICE_CLASSES.slice(),
  CHANNELS:           CHANNELS.slice(),
  STATES:             STATES.slice(),
  STATUSES:           STATUSES.slice(),
  RETRY_BACKOFF_MS:   RETRY_BACKOFF_MS.slice(),
  DEVICE_TOKEN_NAMESPACE: DEVICE_TOKEN_NAMESPACE,
  CREDENTIALS_NAMESPACE:  CREDENTIALS_NAMESPACE,
  MAX_SLUG_LEN:           MAX_SLUG_LEN,
  MAX_TITLE_LEN:          MAX_TITLE_LEN,
  MAX_BODY_LEN:           MAX_BODY_LEN,
  MAX_PAYLOAD_BYTES:      MAX_PAYLOAD_BYTES,
  MAX_LIST_LIMIT:         MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:     DEFAULT_LIST_LIMIT,
  MAX_BATCH_SIZE:         MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE:     DEFAULT_BATCH_SIZE,
};
