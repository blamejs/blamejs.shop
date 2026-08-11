"use strict";
/**
 * @module shop.webhookReceiver
 * @title  Webhook receiver — inbound HMAC-SHA-256 signed events
 *
 * @intro
 *   Operator-side acceptor for inbound webhooks. The third-party
 *   platform (Stripe, GitHub, Slack, BigCommerce, Square, …) signs
 *   each delivery with `HMAC-SHA-256(secret, timestamp + "." + body)`
 *   and posts the body to the operator's `/<slug>` endpoint. This
 *   primitive verifies the signature, enforces the replay window on
 *   the timestamp, dedupes via the third-party's per-event
 *   idempotency key, and persists the raw body for the operator's
 *   downstream processor.
 *
 *   Distinct from:
 *     - `webhooks`            — DELIVERS outbound events to operator-
 *                                registered third-party endpoints.
 *     - `webhookSubscriptions` — MANAGES per-customer delivery
 *                                subscriptions for the outbound side.
 *   Receiver is the inbound complement.
 *
 *   Secret-at-rest: the plaintext is returned exactly once at
 *   `defineSource` + `rotateSecret`. The row stores only the
 *   namespaceHash of the plaintext under the `webhook-receiver-
 *   secret` namespace. At request time the operator's route layer
 *   supplies the plaintext from its secret-store (env / KMS /
 *   Cloudflare secret) alongside the inbound headers; the primitive
 *   hashes the supplied plaintext under the same namespace and
 *   matches against `signing_secret_hash` (live) or
 *   `signing_secret_previous_hash` (24h grace), routing the hex
 *   compare through `b.crypto.timingSafeEqual`. The matched
 *   plaintext is what feeds the HMAC computation. The plaintext
 *   never reaches the database; the row's hash is the verification
 *   key for whatever plaintext the operator presents.
 *
 *   FSM:
 *     received  — initial state on verifyAndPersist.
 *     processed — terminal-success (markProcessed).
 *     failed    — markFailed; retry=true keeps the row eligible for
 *                  the operator's reprocess scheduler.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash`   — secret-at-rest fingerprint.
 *     - `b.crypto.sha3Hash`        — body fingerprint for audit.
 *     - `b.crypto.generateBytes`   — secret plaintext draw.
 *     - `b.crypto.timingSafeEqual` — constant-time hex compare on the
 *                                    secret-hash match.
 *     - `b.webhookHmac.verify`     — the whole `t=<ts>,v1=<hex>` scheme:
 *                                    HMAC-SHA-256 over `<timestamp>.<raw-body>`,
 *                                    the replay window (on this receiver's
 *                                    injected clock and the source row's
 *                                    tolerance), and a constant-time compare
 *                                    across every signature the header carries.
 *     - `b.uuid.v7`                — row ids.
 *
 *   Surface:
 *     defineSource({ slug, secret_plaintext?, replay_window_seconds?,
 *                    max_body_bytes?, signature_header_name?,
 *                    timestamp_header_name?, active })
 *     verifyAndPersist({ source_slug, secret_plaintext, body,
 *                        signature_header, timestamp_header,
 *                        idempotency_key? })
 *     markProcessed({ event_id, outcome })
 *     markFailed({ event_id, reason, retry })
 *     unprocessedEvents({ source_slug?, limit })
 *     eventsForSource({ source_slug, limit, cursor? })
 *     getEvent(event_id)
 *     purgeOlderThan(days)
 *     rotateSecret(source_slug)
 *     archiveSource(source_slug)
 *
 *   Storage:
 *     - `webhook_sources` + `webhook_received_events`
 *       (migration `0110_webhook_receiver.sql`).
 *
 * @primitive webhookReceiver
 * @related   b.crypto, b.webhook, b.uuid
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");
var C = b.constants;

var SECRET_NAMESPACE   = "webhook-receiver-secret";
var SECRET_BYTE_LEN    = 32;
// 32 bytes -> 43 chars of base64url (no padding).
var SECRET_PLAINTEXT_LEN = 43;
var SECRET_PLAINTEXT_RE  = /^[A-Za-z0-9_\-]{43}$/;

var ROTATION_GRACE_MS  = C.TIME.days(1);

var DEFAULT_REPLAY_WINDOW_SECONDS = 300;     // 5 min — Stripe-shaped default
var MIN_REPLAY_WINDOW_SECONDS     = 30;      // floor — below this clock skew false-rejects
// allow:raw-time-literal — replay-window ceiling in SECONDS (24h); C.TIME returns ms
var MAX_REPLAY_WINDOW_SECONDS     = 86400;   // 24 h — anything larger is "no replay defense"

var DEFAULT_MAX_BODY_BYTES = 1024 * 1024;    // 1 MiB
var MIN_MAX_BODY_BYTES     = 256;            // minimum useful payload
var ABSOLUTE_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB — anything larger is misconfigured

var DEFAULT_SIGNATURE_HEADER_NAME = "X-Webhook-Signature";
var DEFAULT_TIMESTAMP_HEADER_NAME = "X-Webhook-Timestamp";

var SLUG_RE       = /^[a-z0-9][a-z0-9_\-]{0,63}$/;

var MAX_HEADER_NAME_LEN = 128;
var HEADER_NAME_RE      = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,127}$/;

// Idempotency keys are third-party-supplied opaque strings. Validation is
// delegated to the framework's idempotency-key guard (strict profile:
// ≤256 bytes, ASCII-only) which additionally refuses path-traversal
// shapes — `/`, `\`, and `..` runs — that the earlier printable-ASCII
// regex let through. Strict allows a literal space (security-neutral for
// a stored-comparison key) and does NOT NFC-normalize the input.

var MAX_OUTCOME_LEN = 280;
var MAX_REASON_LEN  = 1024;

var SIGNATURE_HEX_RE = /^[0-9a-f]{64}$/i;     // 32 bytes of HMAC-SHA-256 = 64 hex chars


var STATUSES = ["received", "processed", "failed"];

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string") {
    throw new TypeError("webhookReceiver: slug must be a string");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "webhookReceiver: slug must match [a-z0-9][a-z0-9_-]{0,63} " +
      "(lowercase, digits, underscore, hyphen; first char alphanumeric)"
    );
  }
  return s;
}

function _replayWindow(n) {
  if (n == null) return DEFAULT_REPLAY_WINDOW_SECONDS;
  if (!Number.isInteger(n) || n < MIN_REPLAY_WINDOW_SECONDS || n > MAX_REPLAY_WINDOW_SECONDS) {
    throw new TypeError(
      "webhookReceiver: replay_window_seconds must be an integer " +
      MIN_REPLAY_WINDOW_SECONDS + ".." + MAX_REPLAY_WINDOW_SECONDS
    );
  }
  return n;
}

function _maxBodyBytes(n) {
  if (n == null) return DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(n) || n < MIN_MAX_BODY_BYTES || n > ABSOLUTE_MAX_BODY_BYTES) {
    throw new TypeError(
      "webhookReceiver: max_body_bytes must be an integer " +
      MIN_MAX_BODY_BYTES + ".." + ABSOLUTE_MAX_BODY_BYTES
    );
  }
  return n;
}

function _headerName(s, fallback, label) {
  if (s == null) return fallback;
  if (typeof s !== "string") {
    throw new TypeError("webhookReceiver: " + label + " must be a string");
  }
  if (!HEADER_NAME_RE.test(s)) {
    throw new TypeError(
      "webhookReceiver: " + label + " must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}"
    );
  }
  if (s.length > MAX_HEADER_NAME_LEN) {
    throw new TypeError(
      "webhookReceiver: " + label + " must be <= " + MAX_HEADER_NAME_LEN + " characters"
    );
  }
  return s;
}

function _active(v) {
  if (typeof v !== "boolean") {
    throw new TypeError("webhookReceiver: active must be a boolean");
  }
  return v;
}

function _outcome(s) {
  if (typeof s !== "string") {
    throw new TypeError("webhookReceiver: outcome must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("webhookReceiver: outcome must be non-empty after trim");
  }
  if (s.length > MAX_OUTCOME_LEN) {
    throw new TypeError("webhookReceiver: outcome must be <= " + MAX_OUTCOME_LEN + " characters");
  }
  textGuard.freeText(s, "webhookReceiver: outcome", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

function _reason(s) {
  if (typeof s !== "string") {
    throw new TypeError("webhookReceiver: reason must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("webhookReceiver: reason must be non-empty after trim");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("webhookReceiver: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  textGuard.freeText(s, "webhookReceiver: reason", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

function _retry(v) {
  if (typeof v !== "boolean") {
    throw new TypeError("webhookReceiver: retry must be a boolean");
  }
  return v;
}

function _idempotencyKey(s) {
  if (s == null) return null;
  // The framework guard owns the alphabet + length policy. It refuses
  // empty keys, control bytes, non-ASCII, over-length, and the
  // path-traversal shapes (`/`, `\`, `..`) the prior regex admitted.
  // Translate its structured error to this primitive's TypeError shape
  // so callers keep a uniform validation-failure surface.
  try {
    return b.guardIdempotencyKey.validate(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("webhookReceiver: idempotency_key — " + (e && e.message || "invalid idempotency key"));
  }
}

function _eventId(s) {
  if (typeof s !== "string" || s.length === 0) {
    throw new TypeError("webhookReceiver: event_id required");
  }
  // UUID v7 + UUID v4 both validate under the strict guard. The
  // primitive issues v7 on persist; we accept either at the entry
  // point so a hand-issued UUID in tests / migrations doesn't trip.
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("webhookReceiver: event_id — " + (e && e.message || "invalid UUID"));
  }
}

function _purgeDays(n) {
  if (!Number.isInteger(n) || n < 1 || n > 36500) {
    throw new TypeError("webhookReceiver: days must be an integer in [1, 36500]");
  }
  return n;
}

function _limit(n, label, max) {
  max = max || 500;
  if (n == null) return 50;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new TypeError(
      "webhookReceiver: " + label + " must be an integer in [1, " + max + "]"
    );
  }
  return n;
}

function _coerceBodyBytes(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError(
    "webhookReceiver: body must be a Buffer, Uint8Array, or string"
  );
}

// ---- secret generation + hashing ----------------------------------------

function _generateSecret() {
  var buf = b.crypto.generateBytes(SECRET_BYTE_LEN);
  return b.crypto.toBase64Url(buf);
}

function _canonicalSecret(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("webhookReceiver: secret must be a non-empty string");
  }
  if (!SECRET_PLAINTEXT_RE.test(input)) {
    throw new TypeError(
      "webhookReceiver: secret must be 43 base64url characters " +
      "(32 bytes of entropy). Generate via defineSource without " +
      "secret_plaintext to draw a fresh secret."
    );
  }
  return input;
}

function _hashSecret(canonical) {
  return b.crypto.namespaceHash(SECRET_NAMESPACE, canonical);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var nowFn;
  if (opts.now != null) {
    if (typeof opts.now !== "function") {
      throw new TypeError("webhookReceiver.create: now must be a function returning ms epoch");
    }
    nowFn = opts.now;
  } else {
    nowFn = function () { return Date.now(); };
  }

  function _now() { return nowFn(); }

  async function _getSourceRaw(slug) {
    var r = await query("SELECT * FROM webhook_sources WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  function _projectSource(row) {
    if (!row) return null;
    return {
      slug:                          row.slug,
      signing_secret_hash:           row.signing_secret_hash,
      signing_secret_previous_hash:  row.signing_secret_previous_hash,
      signing_secret_rotated_at:     row.signing_secret_rotated_at != null
                                       ? Number(row.signing_secret_rotated_at) : null,
      replay_window_seconds:         Number(row.replay_window_seconds),
      max_body_bytes:                Number(row.max_body_bytes),
      signature_header_name:         row.signature_header_name,
      timestamp_header_name:         row.timestamp_header_name,
      active:                        Number(row.active) === 1,
      archived_at:                   row.archived_at != null ? Number(row.archived_at) : null,
      created_at:                    Number(row.created_at),
      updated_at:                    Number(row.updated_at),
    };
  }

  async function _getEventRaw(id) {
    var r = await query("SELECT * FROM webhook_received_events WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  function _projectEvent(row) {
    if (!row) return null;
    return {
      id:              row.id,
      source_slug:     row.source_slug,
      idempotency_key: row.idempotency_key,
      body_sha3_512:   row.body_sha3_512,
      body_size:       Number(row.body_size),
      status:          row.status,
      outcome:         row.outcome,
      received_at:     Number(row.received_at),
      processed_at:    row.processed_at != null ? Number(row.processed_at) : null,
      failed_at:       row.failed_at != null ? Number(row.failed_at) : null,
      fail_reason:     row.fail_reason,
    };
  }

  // Match a supplied plaintext against the source row's live /
  // previous secret hash. Returns the matched-plaintext shape (the
  // primitive only ever sees the plaintext in memory; the row never
  // stores it) when one of the hashes matches inside the grace
  // window — otherwise null. Constant-time on the hex compare via
  // b.crypto.timingSafeEqual.
  function _matchSecret(sourceRow, suppliedPlaintext, nowMs) {
    var suppliedHash = _hashSecret(suppliedPlaintext);
    var matchedLive = b.crypto.timingSafeEqual(
      sourceRow.signing_secret_hash, suppliedHash
    );
    if (matchedLive) {
      return { plaintext: suppliedPlaintext, scope: "live" };
    }
    if (sourceRow.signing_secret_previous_hash != null) {
      var matchedPrev = b.crypto.timingSafeEqual(
        sourceRow.signing_secret_previous_hash, suppliedHash
      );
      if (matchedPrev) {
        var rotatedAt = sourceRow.signing_secret_rotated_at != null
          ? Number(sourceRow.signing_secret_rotated_at) : 0;
        if (nowMs - rotatedAt > ROTATION_GRACE_MS) return null;
        return { plaintext: suppliedPlaintext, scope: "previous" };
      }
    }
    return null;
  }

  return {
    SECRET_NAMESPACE:                 SECRET_NAMESPACE,
    SECRET_BYTE_LEN:                  SECRET_BYTE_LEN,
    SECRET_PLAINTEXT_LEN:             SECRET_PLAINTEXT_LEN,
    ROTATION_GRACE_MS:                ROTATION_GRACE_MS,
    DEFAULT_REPLAY_WINDOW_SECONDS:    DEFAULT_REPLAY_WINDOW_SECONDS,
    MIN_REPLAY_WINDOW_SECONDS:        MIN_REPLAY_WINDOW_SECONDS,
    MAX_REPLAY_WINDOW_SECONDS:        MAX_REPLAY_WINDOW_SECONDS,
    DEFAULT_MAX_BODY_BYTES:           DEFAULT_MAX_BODY_BYTES,
    MIN_MAX_BODY_BYTES:               MIN_MAX_BODY_BYTES,
    ABSOLUTE_MAX_BODY_BYTES:          ABSOLUTE_MAX_BODY_BYTES,
    DEFAULT_SIGNATURE_HEADER_NAME:    DEFAULT_SIGNATURE_HEADER_NAME,
    DEFAULT_TIMESTAMP_HEADER_NAME:    DEFAULT_TIMESTAMP_HEADER_NAME,
    STATUSES:                         STATUSES.slice(),

    // Register a new inbound source. Operator supplies the slug + any
    // header-name overrides + the active flag; the primitive draws a
    // fresh 32-byte base64url secret (or accepts an operator-supplied
    // plaintext when integrating with an existing third-party secret).
    // The plaintext is returned exactly ONCE — store it in the
    // operator's secret-store (env / KMS / Cloudflare secret) and
    // configure the route layer to pass it to verifyAndPersist. The
    // database row only ever holds the namespaceHash.
    defineSource: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("webhookReceiver.defineSource: input object required");
      }
      var slug          = _slug(input.slug);
      var replayWindow  = _replayWindow(input.replay_window_seconds);
      var maxBodyBytes  = _maxBodyBytes(input.max_body_bytes);
      var sigHeader     = _headerName(input.signature_header_name, DEFAULT_SIGNATURE_HEADER_NAME, "signature_header_name");
      var tsHeader      = _headerName(input.timestamp_header_name, DEFAULT_TIMESTAMP_HEADER_NAME, "timestamp_header_name");
      var active        = _active(input.active);

      var existing = await _getSourceRaw(slug);
      if (existing) {
        var collide = new Error("webhookReceiver.defineSource: slug already exists");
        collide.code = "WEBHOOK_SOURCE_EXISTS";
        throw collide;
      }

      var plaintext;
      if (input.secret_plaintext == null) {
        plaintext = _generateSecret();
      } else {
        plaintext = _canonicalSecret(input.secret_plaintext);
      }
      var hash = _hashSecret(plaintext);
      var ts   = _now();

      await query(
        "INSERT INTO webhook_sources " +
        "(slug, signing_secret_hash, signing_secret_previous_hash, " +
        " signing_secret_rotated_at, replay_window_seconds, max_body_bytes, " +
        " signature_header_name, timestamp_header_name, active, archived_at, " +
        " created_at, updated_at) " +
        "VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
        [slug, hash, replayWindow, maxBodyBytes, sigHeader, tsHeader, active ? 1 : 0, ts],
      );

      return {
        slug:                   slug,
        secret_plaintext:       plaintext,
        replay_window_seconds:  replayWindow,
        max_body_bytes:         maxBodyBytes,
        signature_header_name:  sigHeader,
        timestamp_header_name:  tsHeader,
        active:                 active,
        created_at:             ts,
        updated_at:             ts,
      };
    },

    // Get an existing source by slug. The row never carries the
    // plaintext — only its hash + the rotation pointers.
    getSource: async function (slug) {
      var s = _slug(slug);
      return _projectSource(await _getSourceRaw(s));
    },

    // List every defined source. Sorted by created_at DESC so the
    // most-recently-registered surfaces first in the operator
    // dashboard.
    listSources: async function () {
      var r = await query(
        "SELECT * FROM webhook_sources ORDER BY created_at DESC, slug ASC",
        [],
      );
      return r.rows.map(_projectSource);
    },

    // Verify an inbound delivery and persist the body. Returns a flat
    // result shape rather than throwing — the operator's route layer
    // distinguishes signature_invalid (HTTP 401) from
    // timestamp_out_of_window (HTTP 408) from replay (HTTP 200, no-op)
    // from ok (HTTP 200, persisted) without a catch tree.
    //
    // The operator supplies `secret_plaintext` alongside the slug —
    // pulled from the operator's secret-store at request time. The
    // primitive hashes it under the secret namespace and matches
    // against the live / previous hash on the row (24h grace);
    // unmatched plaintext is reported as `signature_invalid` (the
    // attacker can't distinguish "wrong secret" from "wrong sig" via
    // the response).
    verifyAndPersist: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("webhookReceiver.verifyAndPersist: input object required");
      }
      var slug = _slug(input.source_slug);
      if (typeof input.secret_plaintext !== "string" || input.secret_plaintext.length === 0) {
        throw new TypeError("webhookReceiver.verifyAndPersist: secret_plaintext must be a non-empty string");
      }
      if (typeof input.signature_header !== "string" || input.signature_header.length === 0) {
        throw new TypeError("webhookReceiver.verifyAndPersist: signature_header must be a non-empty string");
      }
      if (typeof input.timestamp_header !== "string" || input.timestamp_header.length === 0) {
        throw new TypeError("webhookReceiver.verifyAndPersist: timestamp_header must be a non-empty string");
      }

      var bodyBytes;
      try { bodyBytes = _coerceBodyBytes(input.body); }
      catch (e) { throw e; }

      var idempotencyKey = _idempotencyKey(input.idempotency_key);
      var nowMs = _now();

      var sourceRow = await _getSourceRaw(slug);
      if (!sourceRow) {
        var miss = new Error("webhookReceiver.verifyAndPersist: source not registered");
        miss.code = "WEBHOOK_SOURCE_NOT_FOUND";
        throw miss;
      }
      if (sourceRow.archived_at != null || Number(sourceRow.active) !== 1) {
        var inactive = new Error("webhookReceiver.verifyAndPersist: source is not active");
        inactive.code = "WEBHOOK_SOURCE_INACTIVE";
        throw inactive;
      }

      // Body-size gate. The route layer SHOULD enforce this at the
      // edge (Cloudflare / nginx body-size limit) — defending in
      // depth at the primitive guarantees an oversized payload never
      // reaches the persist path even when an operator misconfigures
      // the edge. Refuse outright (throw) so the route layer can map
      // to HTTP 413 Payload Too Large.
      var maxBytes = Number(sourceRow.max_body_bytes);
      if (bodyBytes.length > maxBytes) {
        var oversize = new Error(
          "webhookReceiver.verifyAndPersist: body exceeds max_body_bytes (" +
          bodyBytes.length + " > " + maxBytes + ")"
        );
        oversize.code = "WEBHOOK_BODY_TOO_LARGE";
        throw oversize;
      }

      // Secret match — supplied plaintext against live / previous
      // hash. We do this FIRST (before parsing the timestamp) so a
      // hand-crafted request can't probe the source row's structure
      // by varying the timestamp header.
      var matched = _matchSecret(sourceRow, input.secret_plaintext, nowMs);
      if (!matched) {
        return {
          ok:                       false,
          event_id:                 null,
          replay:                   false,
          signature_invalid:        true,
          timestamp_out_of_window:  false,
        };
      }

      // Parse the operator-supplied timestamp header. The third-party
      // signs in seconds (Stripe / GitHub) — we accept seconds; the
      // operator's route layer is responsible for unit conversion if
      // their third-party emits ms.
      var tsStr = input.timestamp_header;
      if (!/^\d{1,15}$/.test(tsStr)) {
        return {
          ok:                       false,
          event_id:                 null,
          replay:                   false,
          signature_invalid:        true,
          timestamp_out_of_window:  false,
        };
      }
      // The signature must be exactly the hex digest before it is composed
      // into the header below — a value carrying a comma or an `=` would
      // otherwise add fields the parser reads as its own.
      var supplied = input.signature_header.trim().toLowerCase();
      if (!SIGNATURE_HEX_RE.test(supplied)) {
        return {
          ok:                       false,
          event_id:                 null,
          replay:                   false,
          signature_invalid:        true,
          timestamp_out_of_window:  false,
        };
      }

      // Signature + replay window, both from b.webhookHmac. It owns this exact
      // scheme — `t=<ts>,v1=<hex>` over `<timestamp>.<raw-body>` — including
      // the strict-integer timestamp, the skew window, a constant-time compare
      // and multi-signature support for a rotated secret. This receiver takes
      // its clock from the operator (opts.now) and its window from the source
      // row, so both are passed in; the primitive gained the clock argument in
      // 0.18.18, which is what made composing it possible at all.
      //
      // The body goes in as BYTES. Signing a UTF-8 string rebuild of it
      // replaces anything that is not valid UTF-8 with U+FFFD, taking the
      // digest over different bytes than the sender signed and rejecting a
      // correctly-signed delivery. The timestamp goes in as the raw header
      // text rather than a reparsed integer for the same reason.
      var windowSec = Number(sourceRow.replay_window_seconds);
      try {
        b.webhookHmac.verify({
          header:       "t=" + tsStr + ",v1=" + supplied,
          rawBody:      bodyBytes,
          secret:       matched.plaintext,
          profile:      "stripe",
          toleranceSec: windowSec,
          now:          nowMs,
        });
      } catch (e) {
        // Out-of-window and bad-signature are distinct outcomes to an operator
        // reading the delivery log: one is a clock or a replay, the other is a
        // wrong secret. Every other refusal is a malformed header, which is
        // not a signature the receiver can accept.
        var skew = e && e.code === "webhook-hmac/timestamp-skew";
        return {
          ok:                       false,
          event_id:                 null,
          replay:                   false,
          signature_invalid:        !skew,
          timestamp_out_of_window:  skew,
        };
      }

      // Idempotency dedupe. When the third-party supplies an
      // idempotency key (Stripe event id, GitHub delivery id, …) we
      // check whether we've already persisted this (source, key) pair
      // and return `{ replay: true }` without inserting a duplicate
      // row. The returned event_id points at the existing row so the
      // operator's downstream processor can resync without losing the
      // delivery chain.
      if (idempotencyKey != null) {
        var dup = await query(
          "SELECT id FROM webhook_received_events " +
          "WHERE source_slug = ?1 AND idempotency_key = ?2",
          [slug, idempotencyKey],
        );
        if (dup.rows.length) {
          return {
            ok:                       true,
            event_id:                 dup.rows[0].id,
            replay:                   true,
            signature_invalid:        false,
            timestamp_out_of_window:  false,
          };
        }
      }

      // Persist. body_sha3_512 is the SHA3-512 fingerprint of the
      // raw bytes — operators paste-compare against the third-party's
      // console to verify the payload landed intact end-to-end.
      var eventId = b.uuid.v7();
      var bodySha = b.crypto.sha3Hash(bodyBytes);
      try {
        await query(
          "INSERT INTO webhook_received_events " +
          "(id, source_slug, idempotency_key, body_sha3_512, body_size, " +
          " status, outcome, received_at, processed_at, failed_at, fail_reason) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 'received', NULL, ?6, NULL, NULL, NULL)",
          [eventId, slug, idempotencyKey, bodySha, bodyBytes.length, nowMs],
        );
      } catch (e) {
        // The UNIQUE(source_slug, idempotency_key) constraint races when two
        // deliveries with the same key arrive simultaneously — the second
        // insert collapses to a replay rather than a hard error.
        //
        // State-agnostic collision detection — never error-message matching.
        // The production D1 service-binding redacts the SQLite "UNIQUE
        // constraint failed" text to a generic "HTTP 500", so a message regex
        // is blind in prod (it only matches under node:sqlite, where the full
        // text survives). On ANY insert error we re-read the (source_slug,
        // idempotency_key) row: if it now exists the failure WAS the UNIQUE
        // race, so we collapse to a benign replay; if it does not exist the
        // insert failed for another reason and we re-throw the original error.
        // The idempotencyKey != null guard stays — a row with a NULL key has
        // no unique slot to replay onto.
        if (idempotencyKey != null) {
          var late = await query(
            "SELECT id FROM webhook_received_events " +
            "WHERE source_slug = ?1 AND idempotency_key = ?2",
            [slug, idempotencyKey],
          );
          if (late.rows.length) {
            return {
              ok:                       true,
              event_id:                 late.rows[0].id,
              replay:                   true,
              signature_invalid:        false,
              timestamp_out_of_window:  false,
            };
          }
        }
        throw e;
      }

      return {
        ok:                       true,
        event_id:                 eventId,
        replay:                   false,
        signature_invalid:        false,
        timestamp_out_of_window:  false,
      };
    },

    // Mark a received event processed. The operator's downstream
    // processor calls this once it has acted on the payload —
    // `outcome` is an opaque operator-supplied label (`"order-
    // created"`, `"customer-updated"`, etc.) that surfaces in the
    // dashboard's event view. Refused on a non-`received` row so
    // double-processing doesn't silently overwrite the prior
    // outcome.
    markProcessed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("webhookReceiver.markProcessed: input object required");
      }
      var eventId = _eventId(input.event_id);
      var outcome = _outcome(input.outcome);

      var current = await _getEventRaw(eventId);
      if (!current) {
        var miss = new Error("webhookReceiver.markProcessed: event not found");
        miss.code = "WEBHOOK_EVENT_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "received") {
        var refused = new Error(
          "webhookReceiver.markProcessed: refused — event is " + current.status
        );
        refused.code = "WEBHOOK_EVENT_NOT_RECEIVED";
        throw refused;
      }

      var ts = _now();
      await query(
        "UPDATE webhook_received_events " +
        "SET status = 'processed', outcome = ?1, processed_at = ?2 " +
        "WHERE id = ?3",
        [outcome, ts, eventId],
      );
      return _projectEvent(await _getEventRaw(eventId));
    },

    // Mark a received event failed. `retry=true` keeps the row
    // eligible for the operator's reprocess scheduler (the worker
    // can re-pull `failed` + retry rows and re-attempt); `retry=
    // false` is the terminal-dead-letter state. Refused on a non-
    // `received` row.
    markFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("webhookReceiver.markFailed: input object required");
      }
      var eventId = _eventId(input.event_id);
      var reason  = _reason(input.reason);
      var retry   = _retry(input.retry);

      var current = await _getEventRaw(eventId);
      if (!current) {
        var miss = new Error("webhookReceiver.markFailed: event not found");
        miss.code = "WEBHOOK_EVENT_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "received") {
        var refused = new Error(
          "webhookReceiver.markFailed: refused — event is " + current.status
        );
        refused.code = "WEBHOOK_EVENT_NOT_RECEIVED";
        throw refused;
      }

      var ts = _now();
      // When retry=true we still flip status to 'failed' so the row
      // is no longer eligible for the unprocessed-events queue —
      // operators distinguish "needs retry" from "fresh" by the
      // retry flag encoded in fail_reason. (A separate retry_count
      // column was considered and rejected: every operator's retry
      // scheduler has different idempotency + backoff semantics; we
      // surface the row state and let the operator's scheduler own
      // its own counters.) The fail_reason carries the retry hint
      // verbatim so a downstream re-pull can read it.
      var encodedReason = (retry ? "[retry] " : "[dead-letter] ") + reason;
      await query(
        "UPDATE webhook_received_events " +
        "SET status = 'failed', failed_at = ?1, fail_reason = ?2 " +
        "WHERE id = ?3",
        [ts, encodedReason, eventId],
      );
      return _projectEvent(await _getEventRaw(eventId));
    },

    // Single-event lookup. Returns null on miss (the row was already
    // swept by purgeOlderThan, or the operator hand-typed a wrong
    // id). The body itself is NOT stored on the row — only its
    // digest + size. Operators integrating with the body need to
    // capture it from the inbound request before calling
    // verifyAndPersist (the primitive verifies + persists the
    // metadata; the operator's storage layer owns the raw bytes
    // when retention beyond the digest is needed).
    getEvent: async function (eventId) {
      var id = _eventId(eventId);
      return _projectEvent(await _getEventRaw(id));
    },

    // Unprocessed-events queue. The downstream worker reads this on
    // its pull schedule; `received` rows surface in oldest-first
    // order so a backlog drains FIFO. Optional `source_slug` filter
    // for operators running per-source workers.
    unprocessedEvents: async function (input) {
      input = input || {};
      var limit = _limit(input.limit, "limit", 500);
      var sql;
      var params;
      if (input.source_slug != null) {
        var slug = _slug(input.source_slug);
        sql =
          "SELECT * FROM webhook_received_events " +
          "WHERE status = 'received' AND source_slug = ?1 " +
          "ORDER BY received_at ASC, id ASC LIMIT ?2";
        params = [slug, limit];
      } else {
        sql =
          "SELECT * FROM webhook_received_events " +
          "WHERE status = 'received' " +
          "ORDER BY received_at ASC, id ASC LIMIT ?1";
        params = [limit];
      }
      var r = await query(sql, params);
      return r.rows.map(_projectEvent);
    },

    // Per-source feed in time-DESC order. Keyset-paginated on
    // (received_at, id) so operators stepping through a long history
    // don't pay OFFSET-induced scan cost.
    eventsForSource: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("webhookReceiver.eventsForSource: input object required");
      }
      var slug  = _slug(input.source_slug);
      var limit = _limit(input.limit, "limit", 500);

      var cursorAt = null;
      var cursorId = null;
      if (input.cursor != null) {
        if (typeof input.cursor !== "string" || input.cursor.indexOf(":") === -1) {
          throw new TypeError(
            "webhookReceiver.eventsForSource: cursor must be a string of the form '<received_at>:<id>'"
          );
        }
        var idx = input.cursor.indexOf(":");
        var at  = parseInt(input.cursor.slice(0, idx), 10);
        var cid = input.cursor.slice(idx + 1);
        if (!Number.isInteger(at) || at < 0 || cid.length === 0) {
          throw new TypeError("webhookReceiver.eventsForSource: cursor parses to garbage");
        }
        cursorAt = at;
        cursorId = cid;
      }

      var sql;
      var params;
      if (cursorAt == null) {
        sql =
          "SELECT * FROM webhook_received_events " +
          "WHERE source_slug = ?1 " +
          "ORDER BY received_at DESC, id DESC LIMIT ?2";
        params = [slug, limit + 1];
      } else {
        sql =
          "SELECT * FROM webhook_received_events " +
          "WHERE source_slug = ?1 " +
          "  AND (received_at < ?2 OR (received_at = ?2 AND id < ?3)) " +
          "ORDER BY received_at DESC, id DESC LIMIT ?4";
        params = [slug, cursorAt, cursorId, limit + 1];
      }
      var r = await query(sql, params);
      var rows = r.rows.slice(0, limit).map(_projectEvent);
      var nextCursor = null;
      if (r.rows.length > limit && rows.length > 0) {
        var last = rows[rows.length - 1];
        nextCursor = last.received_at + ":" + last.id;
      }
      return { rows: rows, next_cursor: nextCursor };
    },

    // Retention sweep. Deletes terminal (processed / failed) rows
    // older than `days`. `received` rows are never swept — an
    // unprocessed event sitting past the retention window points at
    // a broken downstream worker, and silently deleting it would
    // hide the breakage. Operators schedule this on a daily cron.
    purgeOlderThan: async function (days) {
      var d = _purgeDays(days);
      var nowMs = _now();
      var cutoff = nowMs - C.TIME.days(d);
      var r = await query(
        "DELETE FROM webhook_received_events " +
        "WHERE received_at < ?1 " +
        "  AND status IN ('processed', 'failed')",
        [cutoff],
      );
      return { purged: r.rowCount != null ? Number(r.rowCount) : 0, cutoff: cutoff };
    },

    // Rotate the signing secret. The current hash slides into
    // `signing_secret_previous_hash` with a 24h overlap — the third-
    // party platform pulls the new plaintext (returned ONCE here),
    // updates its sender, and we keep accepting deliveries signed
    // under the old secret until rotated_at + 24h. The new plaintext
    // is returned to the operator's secret-store; the row only ever
    // holds the hash.
    rotateSecret: async function (slug) {
      var s = _slug(slug);
      var current = await _getSourceRaw(s);
      if (!current) {
        var miss = new Error("webhookReceiver.rotateSecret: source not registered");
        miss.code = "WEBHOOK_SOURCE_NOT_FOUND";
        throw miss;
      }
      if (current.archived_at != null) {
        var refused = new Error("webhookReceiver.rotateSecret: source is archived");
        refused.code = "WEBHOOK_SOURCE_ARCHIVED";
        throw refused;
      }

      var plaintext = _generateSecret();
      var newHash   = _hashSecret(plaintext);
      var ts        = _now();

      await query(
        "UPDATE webhook_sources " +
        "SET signing_secret_hash = ?1, " +
        "    signing_secret_previous_hash = ?2, " +
        "    signing_secret_rotated_at = ?3, " +
        "    updated_at = ?3 " +
        "WHERE slug = ?4",
        [newHash, current.signing_secret_hash, ts, s],
      );

      return {
        slug:                  s,
        secret_plaintext:      plaintext,
        rotated_at:            ts,
        rotation_grace_ms:     ROTATION_GRACE_MS,
      };
    },

    // Archive a source — terminal off-switch. The row stays for
    // historical event-trail lookup; verifyAndPersist refuses every
    // inbound delivery against an archived source. Idempotent — re-
    // archiving returns the existing row.
    archiveSource: async function (slug) {
      var s = _slug(slug);
      var current = await _getSourceRaw(s);
      if (!current) {
        var miss = new Error("webhookReceiver.archiveSource: source not registered");
        miss.code = "WEBHOOK_SOURCE_NOT_FOUND";
        throw miss;
      }
      if (current.archived_at != null) {
        return _projectSource(current);
      }
      var ts = _now();
      await query(
        "UPDATE webhook_sources " +
        "SET archived_at = ?1, active = 0, updated_at = ?1 " +
        "WHERE slug = ?2",
        [ts, s],
      );
      return _projectSource(await _getSourceRaw(s));
    },
  };
}

module.exports = {
  create:                            create,
  SECRET_NAMESPACE:                  SECRET_NAMESPACE,
  SECRET_BYTE_LEN:                   SECRET_BYTE_LEN,
  SECRET_PLAINTEXT_LEN:              SECRET_PLAINTEXT_LEN,
  ROTATION_GRACE_MS:                 ROTATION_GRACE_MS,
  DEFAULT_REPLAY_WINDOW_SECONDS:     DEFAULT_REPLAY_WINDOW_SECONDS,
  MIN_REPLAY_WINDOW_SECONDS:         MIN_REPLAY_WINDOW_SECONDS,
  MAX_REPLAY_WINDOW_SECONDS:         MAX_REPLAY_WINDOW_SECONDS,
  DEFAULT_MAX_BODY_BYTES:            DEFAULT_MAX_BODY_BYTES,
  MIN_MAX_BODY_BYTES:                MIN_MAX_BODY_BYTES,
  ABSOLUTE_MAX_BODY_BYTES:           ABSOLUTE_MAX_BODY_BYTES,
  DEFAULT_SIGNATURE_HEADER_NAME:     DEFAULT_SIGNATURE_HEADER_NAME,
  DEFAULT_TIMESTAMP_HEADER_NAME:     DEFAULT_TIMESTAMP_HEADER_NAME,
  STATUSES:                          STATUSES.slice(),
};
