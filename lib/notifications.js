"use strict";
/**
 * @module shop.notifications
 * @title  Notifications primitive — queued + scheduled fan-out
 *
 * @intro
 *   Write-ahead notifications queue with retry semantics + per-
 *   recipient preferences. Callers `enqueue` a row in `pending`
 *   state with a `scheduled_at` (defaults to now); an operator-
 *   driven scheduler polls `pendingDueAt(ts)` and dispatches each
 *   row through the matching channel (in-app, email, webhook),
 *   marking it `sent` / `failed` via `markSent` / `markFailed`.
 *   Recipient-facing transitions are `markRead` (in-app open) and
 *   `dismiss` (in-app hide).
 *
 *   Channels:
 *     in-app   — surfaced in the recipient's inbox via
 *                `unreadForRecipient`
 *     email    — operator dispatcher reads the `payload_json` and
 *                hands it to `b.shop.email` (or its own SMTP path)
 *     webhook  — operator dispatcher hands the row to the
 *                `webhooks` primitive
 *
 *   Preferences:
 *     `setPreference({ recipient_id, event_type, channel, enabled })`
 *     writes an opt-in / opt-out row keyed by
 *     (recipient_id_hash, event_type, channel). `enqueue` consults
 *     this table and refuses with `{ ok: false, error: "opted-out" }`
 *     when the target is disabled. Absence of a row is treated as
 *     enabled — operators that need opt-in semantics seed the table
 *     at registration time.
 *
 *   Composes:
 *     - b.crypto.namespaceHash — recipient_id derivation
 *       (namespace "notification-recipient")
 *     - b.uuid.v7              — row id
 *     - b.guardUuid            — row id sanitization on transition
 *                                calls
 */

var b = require("./vendor/blamejs");

var RECIPIENT_NAMESPACE = "notification-recipient";

var CHANNELS = ["in-app", "email", "webhook"];

var STATUSES = ["pending", "sent", "failed", "dismissed", "read"];

var MAX_RECIPIENT_LEN  = 256;
var MAX_EVENT_TYPE_LEN = 128;
var MAX_TITLE_LEN      = 256;
var MAX_BODY_LEN       = 8192;
var MAX_PAYLOAD_BYTES  = 65536;
var MAX_ERROR_LEN      = 1024;

var EVENT_TYPE_RE     = /^[a-z](?:[a-z0-9._-]*[a-z0-9])?$/;
var CONTROL_BYTE_RE   = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var DEFAULT_PAGE_SIZE = 50;
var MAX_PAGE_SIZE     = 500;

// ---- validators ---------------------------------------------------------

function _recipientId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("notifications: recipient_id must be a non-empty string");
  }
  if (s.length > MAX_RECIPIENT_LEN) {
    throw new TypeError("notifications: recipient_id must be <= " + MAX_RECIPIENT_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("notifications: recipient_id contains control bytes");
  }
  return s;
}

function _channel(s) {
  if (typeof s !== "string" || CHANNELS.indexOf(s) === -1) {
    throw new TypeError("notifications: channel must be one of " + CHANNELS.join(", "));
  }
  return s;
}

function _eventType(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("notifications: event_type must be a non-empty string");
  }
  if (s.length > MAX_EVENT_TYPE_LEN) {
    throw new TypeError("notifications: event_type must be <= " + MAX_EVENT_TYPE_LEN + " characters");
  }
  if (!EVENT_TYPE_RE.test(s)) {
    throw new TypeError("notifications: event_type must match /[a-z][a-z0-9._-]*[a-z0-9]/");
  }
  return s;
}

function _title(s) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("notifications: title must be a string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("notifications: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("notifications: title contains control bytes");
  }
  return s;
}

function _body(s) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("notifications: body must be a string");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("notifications: body must be <= " + MAX_BODY_LEN + " characters");
  }
  return s;
}

function _payload(p) {
  if (p == null) return "{}";
  if (typeof p !== "object" || Array.isArray(p)) {
    throw new TypeError("notifications: payload must be a plain object");
  }
  var encoded;
  try { encoded = JSON.stringify(p); }
  catch (e) { throw new TypeError("notifications: payload — " + (e && e.message || "not JSON-serialisable")); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new TypeError("notifications: payload exceeds " + MAX_PAYLOAD_BYTES + " bytes");
  }
  return encoded;
}

function _scheduledAt(ts, now) {
  if (ts == null) return now;
  if (!Number.isInteger(ts) || ts < 0) {
    throw new TypeError("notifications: scheduled_at must be a non-negative integer (epoch ms)");
  }
  return ts;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_PAGE_SIZE) {
    throw new TypeError("notifications: " + label + " must be an integer in 1.." + MAX_PAGE_SIZE);
  }
  return n;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("notifications: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _error(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("notifications: error must be a non-empty string");
  }
  if (s.length > MAX_ERROR_LEN) return s.slice(0, MAX_ERROR_LEN);
  return s;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  function _hashRecipient(recipientId) {
    return b.crypto.namespaceHash(RECIPIENT_NAMESPACE, recipientId);
  }

  async function _isOptedOut(recipientHash, eventType, channel) {
    var r = await query(
      "SELECT enabled FROM notification_preferences " +
      "WHERE recipient_id_hash = ?1 AND event_type = ?2 AND channel = ?3 LIMIT 1",
      [recipientHash, eventType, channel],
    );
    var row = r.rows[0];
    if (!row) return false;
    return Number(row.enabled) === 0;
  }

  return {
    RECIPIENT_NAMESPACE: RECIPIENT_NAMESPACE,
    CHANNELS:            CHANNELS.slice(),
    STATUSES:            STATUSES.slice(),

    // Hash a recipient id without writing — useful when the caller
    // wants to look the row up under the same key without going
    // through `enqueue`.
    hashRecipient: function (recipientId) {
      return _hashRecipient(_recipientId(recipientId));
    },

    enqueue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("notifications.enqueue: input object required");
      }
      var recipientId = _recipientId(input.recipient_id);
      var channel     = _channel(input.channel);
      var eventType   = _eventType(input.event_type);
      var title       = _title(input.title);
      var body        = _body(input.body);
      var payload     = _payload(input.payload);
      var now         = _now();
      var scheduledAt = _scheduledAt(input.scheduled_at, now);
      var hash        = _hashRecipient(recipientId);

      // Preference check before writing — operator opt-outs short-
      // circuit the queue rather than write a row only to drop it
      // at dispatch time.
      if (await _isOptedOut(hash, eventType, channel)) {
        return { ok: false, error: "opted-out" };
      }

      var id = b.uuid.v7();
      await query(
        "INSERT INTO notifications " +
        "(id, recipient_id, recipient_id_hash, channel, event_type, title, body, " +
        " payload_json, status, scheduled_at, retry_count, created_at, updated_at) " +
        "VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, 0, ?9, ?9)",
        [id, hash, channel, eventType, title, body, payload, scheduledAt, now],
      );
      return { ok: true, id: id, scheduled_at: scheduledAt };
    },

    get: async function (id) {
      _uuid(id, "notification id");
      var r = await query("SELECT * FROM notifications WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    markSent: async function (id, options) {
      _uuid(id, "notification id");
      options = options || {};
      var sentAt = options.sent_at == null ? _now() : _scheduledAt(options.sent_at, _now());
      var existing = (await query("SELECT status FROM notifications WHERE id = ?1", [id])).rows[0];
      if (!existing) return null;
      if (existing.status !== "pending" && existing.status !== "failed") {
        var err = new Error("notifications.markSent: cannot transition from " + existing.status + " to sent");
        err.code = "NOTIFICATION_BAD_TRANSITION";
        throw err;
      }
      await query(
        "UPDATE notifications SET status = 'sent', sent_at = ?1, last_error = NULL, updated_at = ?1 WHERE id = ?2",
        [sentAt, id],
      );
      return (await query("SELECT * FROM notifications WHERE id = ?1", [id])).rows[0];
    },

    markFailed: async function (id, options) {
      _uuid(id, "notification id");
      if (!options || typeof options !== "object") {
        throw new TypeError("notifications.markFailed: options.error required");
      }
      var errMsg    = _error(options.error);
      var increment = options.retry_count_increment;
      if (increment == null) increment = 1;
      if (!Number.isInteger(increment) || increment < 0) {
        throw new TypeError("notifications.markFailed: retry_count_increment must be a non-negative integer");
      }
      var existing = (await query("SELECT status, retry_count FROM notifications WHERE id = ?1", [id])).rows[0];
      if (!existing) return null;
      if (existing.status !== "pending" && existing.status !== "failed") {
        var err = new Error("notifications.markFailed: cannot transition from " + existing.status + " to failed");
        err.code = "NOTIFICATION_BAD_TRANSITION";
        throw err;
      }
      var newCount = Number(existing.retry_count) + increment;
      var ts = _now();
      await query(
        "UPDATE notifications SET status = 'failed', retry_count = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4",
        [newCount, errMsg, ts, id],
      );
      return (await query("SELECT * FROM notifications WHERE id = ?1", [id])).rows[0];
    },

    markRead: async function (id, options) {
      _uuid(id, "notification id");
      options = options || {};
      var readAt = options.read_at == null ? _now() : _scheduledAt(options.read_at, _now());
      var existing = (await query("SELECT status, channel FROM notifications WHERE id = ?1", [id])).rows[0];
      if (!existing) return null;
      if (existing.channel !== "in-app") {
        var err = new Error("notifications.markRead: only in-app notifications can be marked read");
        err.code = "NOTIFICATION_BAD_CHANNEL";
        throw err;
      }
      if (existing.status !== "sent" && existing.status !== "pending") {
        var err2 = new Error("notifications.markRead: cannot transition from " + existing.status + " to read");
        err2.code = "NOTIFICATION_BAD_TRANSITION";
        throw err2;
      }
      await query(
        "UPDATE notifications SET status = 'read', read_at = ?1, updated_at = ?1 WHERE id = ?2",
        [readAt, id],
      );
      return (await query("SELECT * FROM notifications WHERE id = ?1", [id])).rows[0];
    },

    dismiss: async function (id) {
      _uuid(id, "notification id");
      var existing = (await query("SELECT status FROM notifications WHERE id = ?1", [id])).rows[0];
      if (!existing) return null;
      if (existing.status === "dismissed") {
        return (await query("SELECT * FROM notifications WHERE id = ?1", [id])).rows[0];
      }
      var ts = _now();
      await query(
        "UPDATE notifications SET status = 'dismissed', dismissed_at = ?1, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      return (await query("SELECT * FROM notifications WHERE id = ?1", [id])).rows[0];
    },

    unreadForRecipient: async function (recipientId, options) {
      var rid = _recipientId(recipientId);
      options = options || {};
      var limit = _limit(options.limit, "limit");
      var hash = _hashRecipient(rid);
      var params;
      var sql;
      if (options.channel != null) {
        var channel = _channel(options.channel);
        sql = "SELECT * FROM notifications " +
              "WHERE recipient_id_hash = ?1 AND channel = ?2 " +
              "AND status IN ('pending','sent','failed') " +
              "ORDER BY scheduled_at DESC, id DESC LIMIT ?3";
        params = [hash, channel, limit];
      } else {
        sql = "SELECT * FROM notifications " +
              "WHERE recipient_id_hash = ?1 " +
              "AND status IN ('pending','sent','failed') " +
              "ORDER BY scheduled_at DESC, id DESC LIMIT ?2";
        params = [hash, limit];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    pendingDueAt: async function (ts, options) {
      if (!Number.isInteger(ts) || ts < 0) {
        throw new TypeError("notifications.pendingDueAt: ts must be a non-negative integer (epoch ms)");
      }
      options = options || {};
      var limit = _limit(options.limit, "limit");
      var r = await query(
        "SELECT * FROM notifications " +
        "WHERE status = 'pending' AND scheduled_at <= ?1 " +
        "ORDER BY scheduled_at ASC, id ASC LIMIT ?2",
        [ts, limit],
      );
      return r.rows;
    },

    setPreference: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("notifications.setPreference: input object required");
      }
      var recipientId = _recipientId(input.recipient_id);
      var eventType   = _eventType(input.event_type);
      var channel     = _channel(input.channel);
      if (typeof input.enabled !== "boolean") {
        throw new TypeError("notifications.setPreference: enabled must be a boolean");
      }
      var enabled = input.enabled ? 1 : 0;
      var hash    = _hashRecipient(recipientId);
      var now     = _now();
      // Upsert — composite primary key handles dedupe. SQLite's
      // ON CONFLICT REPLACE updates updated_at without dropping
      // created_at on the existing row.
      var existing = (await query(
        "SELECT created_at FROM notification_preferences " +
        "WHERE recipient_id_hash = ?1 AND event_type = ?2 AND channel = ?3 LIMIT 1",
        [hash, eventType, channel],
      )).rows[0];
      if (existing) {
        await query(
          "UPDATE notification_preferences SET enabled = ?1, updated_at = ?2 " +
          "WHERE recipient_id_hash = ?3 AND event_type = ?4 AND channel = ?5",
          [enabled, now, hash, eventType, channel],
        );
        return {
          recipient_id_hash: hash,
          event_type:        eventType,
          channel:           channel,
          enabled:           enabled,
          created_at:        Number(existing.created_at),
          updated_at:        now,
        };
      }
      await query(
        "INSERT INTO notification_preferences " +
        "(recipient_id_hash, event_type, channel, enabled, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        [hash, eventType, channel, enabled, now],
      );
      return {
        recipient_id_hash: hash,
        event_type:        eventType,
        channel:           channel,
        enabled:           enabled,
        created_at:        now,
        updated_at:        now,
      };
    },

    getPreferences: async function (recipientId) {
      var rid = _recipientId(recipientId);
      var hash = _hashRecipient(rid);
      var r = await query(
        "SELECT recipient_id_hash, event_type, channel, enabled, created_at, updated_at " +
        "FROM notification_preferences WHERE recipient_id_hash = ?1 " +
        "ORDER BY event_type ASC, channel ASC",
        [hash],
      );
      return r.rows;
    },

    // Operator retention cleanup. `before_ts` is an epoch-ms cutoff;
    // rows with `updated_at <= before_ts` AND `status IN statuses`
    // are deleted. Refuses an empty statuses array (operators must
    // be explicit about which terminal states they are reclaiming —
    // accidentally deleting `pending` rows would silently drop the
    // queue).
    cleanupOld: async function (options) {
      if (!options || typeof options !== "object") {
        throw new TypeError("notifications.cleanupOld: options object required");
      }
      if (!Number.isInteger(options.before_ts) || options.before_ts < 0) {
        throw new TypeError("notifications.cleanupOld: before_ts must be a non-negative integer (epoch ms)");
      }
      if (!Array.isArray(options.statuses) || options.statuses.length === 0) {
        throw new TypeError("notifications.cleanupOld: statuses must be a non-empty array");
      }
      var seen = {};
      for (var i = 0; i < options.statuses.length; i += 1) {
        var s = options.statuses[i];
        if (STATUSES.indexOf(s) === -1) {
          throw new TypeError("notifications.cleanupOld: unknown status " + JSON.stringify(s));
        }
        seen[s] = true;
      }
      // Hand-rolled IN clause — every status token is already
      // validated against the closed list above, so direct
      // interpolation is safe; parameters go in via positional
      // placeholders for the timestamp.
      var statusList = Object.keys(seen).map(function (k) { return "'" + k + "'"; }).join(",");
      var r = await query(
        "DELETE FROM notifications WHERE updated_at <= ?1 AND status IN (" + statusList + ")",
        [options.before_ts],
      );
      return { deleted: Number(r.rowCount || 0) };
    },
  };
}

module.exports = {
  create:              create,
  RECIPIENT_NAMESPACE: RECIPIENT_NAMESPACE,
  CHANNELS:            CHANNELS.slice(),
  STATUSES:            STATUSES.slice(),
};
