"use strict";
/**
 * @module shop.apiKeys
 * @title  API keys primitive — operator-issued bearer tokens for
 *         third-party access to admin endpoints
 *
 * @intro
 *   Every key is a bearer credential. Whoever knows the plaintext
 *   token can authenticate as the key's owner — so the shop never
 *   stores it. On `issueKey` we draw 32 random bytes via
 *   `b.crypto.generateBytes(32)`, render them as URL-safe base64
 *   without padding (43 characters), store the
 *   `b.crypto.namespaceHash("api-key-token", plaintext)` digest, and
 *   return the plaintext exactly once. Subsequent reads only ever see
 *   the hash. `verifyToken(plaintext)` hashes the supplied value with
 *   the same namespace, matches against `token_hash` OR
 *   `token_hash_previous` (24h rotation grace), and routes the hex
 *   compare through `b.crypto.timingSafeEqual` so the equality check
 *   leaves no micro-timing oracle.
 *
 *   Each key carries:
 *     - `owner_type` — one of `operator | app | affiliate | tenant`.
 *     - `owner_id`   — optional owner-row id (nullable for global
 *                      operator keys).
 *     - `scopes`     — JSON array of opaque scope strings the route
 *                      layer enforces; the primitive validates shape
 *                      only (string, alphabet, length).
 *     - `rate_limit_per_minute` — per-key request budget over the
 *                                  last 60s; the route layer enforces
 *                                  by reading `api_key_usage`.
 *     - `expires_at` — optional ms-epoch hard expiry; once reached,
 *                      verifyToken refuses and `cleanupExpired` may
 *                      sweep the row's status to `expired`.
 *
 *   FSM:
 *     active   — issued and usable.
 *     rotated  — superseded by a newer hash via `rotate`; the row's
 *                previous hash stays usable until rotated_at + 24h.
 *     revoked  — terminal; verifyToken refuses immediately.
 *     expired  — terminal; either reached `expires_at` or was swept
 *                by `cleanupExpired`.
 *
 *   Composes:
 *     - `b.crypto.generateBytes`   — 32-byte uniform draw for token
 *                                    plaintext.
 *     - `b.crypto.namespaceHash`   — SHA3-512 of the plaintext under
 *                                    the `api-key-token` namespace.
 *     - `b.crypto.timingSafeEqual` — constant-time hex compare on
 *                                    verify.
 *     - `b.guardUuid`              — UUID-shape validation for ids.
 *     - `b.uuid.v7`                — row ids.
 *
 *   Surface:
 *     issueKey({ owner_type, owner_id?, name, scopes,
 *                rate_limit_per_minute?, expires_at? })
 *     verifyToken(plaintext)
 *     revoke(key_id, reason)
 *     rotate(key_id)
 *     listForOwner({ owner_type, owner_id })
 *     getKey(key_id)
 *     update(key_id, patch)
 *     recordUse({ key_id, endpoint, occurred_at? })
 *     usageForKey({ key_id, from, to })
 *     cleanupExpired({ now? })
 *
 *   Storage:
 *     - `api_keys` + `api_key_usage` (migration `0064_api_keys.sql`).
 *
 * @primitive apiKeys
 * @related   b.crypto, b.guardUuid, b.uuid
 */

var TOKEN_NAMESPACE         = "api-key-token";
var TOKEN_BYTE_LEN          = 32;
// 32 bytes -> 43 chars of base64url (no padding).
var TOKEN_PLAINTEXT_LEN     = 43;
var TOKEN_PLAINTEXT_RE      = /^[A-Za-z0-9_-]{43}$/;

// Framework handle (the vendored blamejs); index.js re-exports this as .framework.
var b = require("./vendor/blamejs");

var ROTATION_GRACE_MS       = b.constants.TIME.days(1);

var OWNER_TYPES             = ["operator", "app", "affiliate", "tenant"];
var STATUSES                = ["active", "rotated", "revoked", "expired"];

var MAX_NAME_LEN            = 200;
var MAX_REASON_LEN          = 280;
var MAX_ENDPOINT_LEN        = 512;
var MAX_SCOPE_LEN           = 128;
var MAX_SCOPES_PER_KEY      = 64;
var MIN_RATE_LIMIT          = 0;
// 1e6 requests/minute is ~16.6k/sec — operator wiring something
// larger is mis-configured. The CHECK in storage allows >= 0; we
// guard the upper end at the entry point so the primitive doesn't
// have to think about overflow downstream.
var MAX_RATE_LIMIT          = 1000000;
var DEFAULT_RATE_LIMIT      = 60;

// Scope strings are operator-supplied opaque tokens — the route layer
// enforces them. Alphabet is conservative so a typo'd scope is loud:
// lowercase + digits + `:` + `.` + `_` + `-`. No spaces, no unicode.
var SCOPE_RE                = /^[a-z0-9][a-z0-9:._-]{0,127}$/;

// Control bytes + zero-width / direction-override family. The name +
// reason + endpoint render in operator dashboards; embedded control
// / direction-override bytes are a slipping-class for header
// injection + visual-spoofing attacks downstream.
var CONTROL_BYTE_STRICT_RE  = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE           = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_UPDATE_COLUMNS  = Object.freeze([
  "name", "scopes", "rate_limit_per_minute",
]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("apiKeys: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _ownerType(s) {
  if (typeof s !== "string" || OWNER_TYPES.indexOf(s) === -1) {
    throw new TypeError("apiKeys: owner_type must be one of " + OWNER_TYPES.join(", "));
  }
  return s;
}

function _name(s) {
  if (typeof s !== "string") {
    throw new TypeError("apiKeys: name must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("apiKeys: name must be non-empty after trim");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError("apiKeys: name must be <= " + MAX_NAME_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("apiKeys: name contains control / zero-width bytes");
  }
  return s;
}

function _scopes(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError("apiKeys: scopes must be an array of strings");
  }
  if (!arr.length) {
    throw new TypeError("apiKeys: scopes must contain at least one entry");
  }
  if (arr.length > MAX_SCOPES_PER_KEY) {
    throw new TypeError("apiKeys: scopes must contain <= " + MAX_SCOPES_PER_KEY + " entries");
  }
  // Set-validate: dedupe + canonicalize. Two callers passing
  // ["admin:read", "admin:read"] should land on the same stored row
  // shape as ["admin:read"]. The primitive sorts so the on-disk JSON
  // is order-independent — operators diffing two keys see a stable
  // shape.
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var s = arr[i];
    if (typeof s !== "string") {
      throw new TypeError("apiKeys: scopes[" + i + "] must be a string");
    }
    if (s.length > MAX_SCOPE_LEN) {
      throw new TypeError("apiKeys: scopes[" + i + "] must be <= " + MAX_SCOPE_LEN + " characters");
    }
    if (!SCOPE_RE.test(s)) {
      throw new TypeError("apiKeys: scopes[" + i + "] contains characters outside the scope alphabet");
    }
    if (seen[s]) continue;
    seen[s] = true;
    out.push(s);
  }
  out.sort();
  return out;
}

function _rateLimit(n) {
  if (n == null) return DEFAULT_RATE_LIMIT;
  if (!Number.isInteger(n) || n < MIN_RATE_LIMIT || n > MAX_RATE_LIMIT) {
    throw new TypeError(
      "apiKeys: rate_limit_per_minute must be an integer " +
      MIN_RATE_LIMIT + ".." + MAX_RATE_LIMIT
    );
  }
  return n;
}

function _expiresAt(ts) {
  if (ts == null) return null;
  if (!Number.isInteger(ts) || ts <= 0) {
    throw new TypeError("apiKeys: expires_at must be a positive integer (ms epoch) or null");
  }
  return ts;
}

function _reason(r) {
  if (typeof r !== "string") {
    throw new TypeError("apiKeys: reason must be a string");
  }
  var trimmed = r.trim();
  if (!trimmed.length) {
    throw new TypeError("apiKeys: reason must be non-empty after trim");
  }
  if (r.length > MAX_REASON_LEN) {
    throw new TypeError("apiKeys: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(r) || ZERO_WIDTH_RE.test(r)) {
    throw new TypeError("apiKeys: reason contains control / zero-width bytes");
  }
  return r;
}

function _endpoint(s) {
  if (typeof s !== "string") {
    throw new TypeError("apiKeys: endpoint must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("apiKeys: endpoint must be non-empty after trim");
  }
  if (s.length > MAX_ENDPOINT_LEN) {
    throw new TypeError("apiKeys: endpoint must be <= " + MAX_ENDPOINT_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("apiKeys: endpoint contains control / zero-width bytes");
  }
  return s;
}

function _msEpoch(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("apiKeys: " + label + " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- token generation + hashing -----------------------------------------

// 32 bytes -> 43 chars base64url (no padding). Routes through the
// framework's `b.crypto.toBase64Url` so the linear-time Node
// built-in `base64url` encoding runs in place of a polynomial-ReDoS-
// shaped `.replace(/=+$/, "")` strip (CodeQL js/polynomial-redos).
function _generateToken() {
  var buf = b.crypto.generateBytes(TOKEN_BYTE_LEN);
  return b.crypto.toBase64Url(buf);
}

function _canonicalToken(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("apiKeys: token must be a non-empty string");
  }
  if (!TOKEN_PLAINTEXT_RE.test(input)) {
    throw new TypeError("apiKeys: token must be 43 base64url characters");
  }
  return input;
}

function _hashToken(canonical) {
  return b.crypto.namespaceHash(TOKEN_NAMESPACE, canonical);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM api_keys WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // Project the storage row into the operator-facing shape. The
  // plaintext token NEVER appears here — it's returned exactly once
  // at issue / rotate. `scopes` deserializes the JSON column so
  // callers don't have to.
  function _project(row) {
    if (!row) return null;
    var out = {
      id:                    row.id,
      owner_type:            row.owner_type,
      owner_id:              row.owner_id,
      name:                  row.name,
      scopes:                _parseScopesJSON(row.scopes_json),
      token_hash:            row.token_hash,
      token_hash_previous:   row.token_hash_previous,
      rotated_at:            row.rotated_at != null ? Number(row.rotated_at) : null,
      status:                row.status,
      revoked_at:            row.revoked_at != null ? Number(row.revoked_at) : null,
      revoke_reason:         row.revoke_reason,
      rate_limit_per_minute: Number(row.rate_limit_per_minute),
      last_used_at:          row.last_used_at != null ? Number(row.last_used_at) : null,
      expires_at:            row.expires_at != null ? Number(row.expires_at) : null,
      created_at:            Number(row.created_at),
      active:                row.status === "active",
    };
    return out;
  }

  function _parseScopesJSON(raw) {
    if (raw == null) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      // Drop-silent on parse error — the issue path always writes a
      // canonical array, so a parse failure means the row was hand-
      // edited outside the primitive. Surfacing as `[]` keeps the
      // route layer's allowlist closed-by-default.
      return [];
    }
  }

  // Insert the issued row. Token plaintext is generated up-front;
  // collision on the hash UNIQUE constraint is astronomically
  // unlikely (SHA3-512 over 2^256 input space) but we retry on the
  // off chance an operator hand-inserts a row in the same boot.
  async function _insertKey(row, plaintext) {
    var attempts = 0;
    var lastErr;
    while (attempts < 5) {
      attempts += 1;
      try {
        await query(
          "INSERT INTO api_keys " +
          "(id, owner_type, owner_id, name, scopes_json, token_hash, " +
          " token_hash_previous, rotated_at, status, revoked_at, " +
          " revoke_reason, rate_limit_per_minute, last_used_at, " +
          " expires_at, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'active', NULL, " +
          " NULL, ?7, NULL, ?8, ?9)",
          [
            row.id, row.owner_type, row.owner_id, row.name,
            row.scopes_json, row.token_hash, row.rate_limit_per_minute,
            row.expires_at, row.created_at,
          ],
        );
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!e || !e.message || e.message.indexOf("UNIQUE") === -1) throw e;
        // Regenerate on collision.
        plaintext           = _generateToken();
        row.token_hash      = _hashToken(plaintext);
      }
    }
    if (lastErr) throw lastErr;
    return plaintext;
  }

  return {
    TOKEN_NAMESPACE:      TOKEN_NAMESPACE,
    TOKEN_BYTE_LEN:       TOKEN_BYTE_LEN,
    TOKEN_PLAINTEXT_LEN:  TOKEN_PLAINTEXT_LEN,
    ROTATION_GRACE_MS:    ROTATION_GRACE_MS,
    OWNER_TYPES:          OWNER_TYPES.slice(),
    STATUSES:             STATUSES.slice(),
    MAX_NAME_LEN:         MAX_NAME_LEN,
    MAX_REASON_LEN:       MAX_REASON_LEN,
    MAX_ENDPOINT_LEN:     MAX_ENDPOINT_LEN,
    MAX_SCOPE_LEN:        MAX_SCOPE_LEN,
    MAX_SCOPES_PER_KEY:   MAX_SCOPES_PER_KEY,
    MIN_RATE_LIMIT:       MIN_RATE_LIMIT,
    MAX_RATE_LIMIT:       MAX_RATE_LIMIT,
    DEFAULT_RATE_LIMIT:   DEFAULT_RATE_LIMIT,

    issueKey: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("apiKeys.issueKey: input object required");
      }
      var ownerType  = _ownerType(input.owner_type);
      var ownerId    = null;
      if (input.owner_id != null) {
        ownerId = _uuid(input.owner_id, "owner_id");
      }
      var name       = _name(input.name);
      var scopes     = _scopes(input.scopes);
      var rateLimit  = _rateLimit(input.rate_limit_per_minute);
      var expiresAt  = _expiresAt(input.expires_at);

      var id         = b.uuid.v7();
      var plaintext  = _generateToken();
      var hash       = _hashToken(plaintext);
      var ts         = _now();

      var row = {
        id:                    id,
        owner_type:            ownerType,
        owner_id:              ownerId,
        name:                  name,
        scopes_json:           JSON.stringify(scopes),
        token_hash:            hash,
        rate_limit_per_minute: rateLimit,
        expires_at:            expiresAt,
        created_at:            ts,
      };
      var finalPlaintext = await _insertKey(row, plaintext);

      // `plaintext_token` is returned exactly ONCE. The caller
      // delivers it. Subsequent reads against this row only see the
      // hash. We also surface a `token_hint` (last 6 plaintext
      // characters) so an operator triaging a support request can
      // identify which row the holder is asking about — 6 chars of
      // base64url is 2^36 ≈ 70-billion entries, far too large to
      // enable brute-force recovery of the remaining 37 chars.
      return {
        key_id:                id,
        plaintext_token:       finalPlaintext,
        token_hint:            finalPlaintext.slice(finalPlaintext.length - 6),
        owner_type:            ownerType,
        owner_id:              ownerId,
        name:                  name,
        scopes:                scopes.slice(),
        rate_limit_per_minute: rateLimit,
        expires_at:            expiresAt,
        created_at:            ts,
      };
    },

    // Resolve a plaintext token to the underlying key's authorization
    // context. Returns null on no-match, revoked, expired, or rotated-
    // beyond-grace. The hash compare itself is constant-time (we route
    // the hex strings through `b.crypto.timingSafeEqual` even after
    // the SQL = match) so an attacker who can time the query can't
    // distinguish "no row" from "wrong hash". A `rotated` row's
    // previous hash is accepted until `rotated_at + 24h`; this lets
    // a deployed caller re-fetch its new token without a hard outage.
    verifyToken: async function (plaintext, optsArg) {
      var canonical = _canonicalToken(plaintext);
      var hash      = _hashToken(canonical);
      var now;
      if (optsArg && optsArg.now != null) {
        now = _msEpoch(optsArg.now, "now");
      } else {
        now = _now();
      }

      // Match against either the live hash or the previous-on-rotate
      // hash. The SQL = on the hex strings is the lookup; the
      // timingSafeEqual on the matched row's hex is belt-and-braces
      // for any future schema change that introduces collection scans.
      var r = await query(
        "SELECT * FROM api_keys " +
        "WHERE token_hash = ?1 OR token_hash_previous = ?1",
        [hash],
      );
      if (!r.rows.length) return null;
      var row = r.rows[0];

      // Constant-time equality on whichever column matched.
      var matchedLive     = b.crypto.timingSafeEqual(row.token_hash, hash);
      var matchedPrevious = row.token_hash_previous != null
        && b.crypto.timingSafeEqual(row.token_hash_previous, hash);
      if (!matchedLive && !matchedPrevious) return null;

      // expires_at takes precedence over everything else. A key whose
      // status hasn't been swept to `expired` yet but whose
      // expires_at has elapsed is refused at verify time.
      if (row.expires_at != null && Number(row.expires_at) <= now) return null;

      var status = row.status;
      if (status === "revoked" || status === "expired") return null;

      if (status === "rotated") {
        // The live hash is no longer accepted from a rotated row —
        // only the previous (grace) hash. The new caller should be
        // using the freshly-issued token, which lives on a different
        // row.
        if (!matchedPrevious) return null;
        var rotatedAt = row.rotated_at != null ? Number(row.rotated_at) : 0;
        if (now - rotatedAt > ROTATION_GRACE_MS) return null;
      } else if (status === "active") {
        // An active row matches only on the live hash. (The previous
        // column should be NULL on an active row, but defend against
        // a hand-edit by refusing any previous-only match here.)
        if (!matchedLive) return null;
      } else {
        return null;
      }

      return {
        key_id:                row.id,
        owner_type:            row.owner_type,
        owner_id:              row.owner_id,
        scopes:                _parseScopesJSON(row.scopes_json),
        rate_limit_per_minute: Number(row.rate_limit_per_minute),
        active:                true,
      };
    },

    revoke: async function (keyId, reason) {
      var id  = _uuid(keyId, "key_id");
      var why = _reason(reason);
      var current = await _getRaw(id);
      if (!current) {
        var miss = new Error("apiKeys.revoke: key not found");
        miss.code = "API_KEY_NOT_FOUND";
        throw miss;
      }
      if (current.status === "revoked") {
        // Idempotent — re-revoke returns the existing terminal row.
        return _project(current);
      }
      var ts = _now();
      await query(
        "UPDATE api_keys SET status = 'revoked', revoked_at = ?1, " +
        "revoke_reason = ?2, token_hash_previous = NULL, rotated_at = NULL " +
        "WHERE id = ?3",
        [ts, why, id],
      );
      return _project(await _getRaw(id));
    },

    // Rotate the live hash. The old hash slides into
    // `token_hash_previous` with a 24h overlap; verifyToken will
    // continue to accept it (subject to the row's status check)
    // until `rotated_at + ROTATION_GRACE_MS`. The row's status
    // becomes `rotated` to advertise the grace window — the new
    // plaintext is returned on a NEW row (so an operator can list
    // the historical rotation chain). Returns
    // `{ key_id: <new>, plaintext_token, ... , previous_key_id }`.
    rotate: async function (keyId) {
      var id = _uuid(keyId, "key_id");
      var current = await _getRaw(id);
      if (!current) {
        var miss = new Error("apiKeys.rotate: key not found");
        miss.code = "API_KEY_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "active") {
        var refused = new Error(
          "apiKeys.rotate: refused — key is " + current.status
        );
        refused.code = "API_KEY_NOT_ROTATABLE";
        throw refused;
      }

      var ts = _now();
      // Mark the existing row as rotated. The old hash moves into
      // `token_hash_previous`; `token_hash` is cleared so the new
      // row can claim the UNIQUE column without colliding. We use a
      // placeholder hash (the row id under a rotate-marker namespace)
      // so the UNIQUE constraint stays honoured.
      var placeholderHash = b.crypto.namespaceHash(
        "api-key-rotated-placeholder", current.id + ":" + ts
      );
      // Atomic claim: gate the active->rotated transition on the row
      // still being 'active'. The JS status check above only refuses a
      // sequential re-rotate; two concurrent rotates would both pass it
      // and both issue a replacement key (credential over-issuance).
      // The `AND status = 'active'` predicate lets exactly one caller
      // claim the rotation — the loser is refused before any new key is
      // minted.
      var rotateClaim = await query(
        "UPDATE api_keys SET status = 'rotated', rotated_at = ?1, " +
        "token_hash_previous = ?2, token_hash = ?3 WHERE id = ?4 AND status = 'active'",
        [ts, current.token_hash, placeholderHash, id],
      );
      if (Number(rotateClaim.rowCount || 0) !== 1) {
        var lost = await _getRaw(id);
        var refusedRotate = new Error(
          "apiKeys.rotate: refused — key is " + (lost ? lost.status : "gone")
        );
        refusedRotate.code = "API_KEY_NOT_ROTATABLE";
        throw refusedRotate;
      }

      // Issue the replacement row. Scopes / rate-limit / expiry /
      // owner all carry forward verbatim — rotation is plaintext-only.
      var newId        = b.uuid.v7();
      var plaintext    = _generateToken();
      var newHash      = _hashToken(plaintext);
      var row = {
        id:                    newId,
        owner_type:            current.owner_type,
        owner_id:              current.owner_id,
        name:                  current.name,
        scopes_json:           current.scopes_json,
        token_hash:            newHash,
        rate_limit_per_minute: Number(current.rate_limit_per_minute),
        expires_at:            current.expires_at != null ? Number(current.expires_at) : null,
        created_at:            ts,
      };
      var finalPlaintext = await _insertKey(row, plaintext);

      return {
        key_id:                newId,
        previous_key_id:       id,
        plaintext_token:       finalPlaintext,
        token_hint:            finalPlaintext.slice(finalPlaintext.length - 6),
        owner_type:            current.owner_type,
        owner_id:              current.owner_id,
        name:                  current.name,
        scopes:                _parseScopesJSON(current.scopes_json),
        rate_limit_per_minute: Number(current.rate_limit_per_minute),
        expires_at:            current.expires_at != null ? Number(current.expires_at) : null,
        created_at:            ts,
        rotation_grace_ms:     ROTATION_GRACE_MS,
      };
    },

    listForOwner: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("apiKeys.listForOwner: input object required");
      }
      var ownerType = _ownerType(input.owner_type);
      var ownerId   = null;
      if (input.owner_id != null) {
        ownerId = _uuid(input.owner_id, "owner_id");
      }
      var sql, params;
      if (ownerId == null) {
        sql = "SELECT * FROM api_keys WHERE owner_type = ?1 AND owner_id IS NULL " +
              "ORDER BY created_at DESC, id DESC";
        params = [ownerType];
      } else {
        sql = "SELECT * FROM api_keys WHERE owner_type = ?1 AND owner_id = ?2 " +
              "ORDER BY created_at DESC, id DESC";
        params = [ownerType, ownerId];
      }
      var r = await query(sql, params);
      return r.rows.map(_project);
    },

    getKey: async function (keyId) {
      var id = _uuid(keyId, "key_id");
      return _project(await _getRaw(id));
    },

    // Patch-style update — only `name`, `scopes`, and
    // `rate_limit_per_minute` can be set. Token hash / status /
    // owner_type / owner_id are immutable post-issue (changing the
    // owner would orphan the audit trail; changing the status
    // happens through revoke / rotate / cleanupExpired).
    update: async function (keyId, patch) {
      var id = _uuid(keyId, "key_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("apiKeys.update: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("apiKeys.update: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError("apiKeys.update: column '" + keys[i] + "' not updatable");
        }
      }

      var current = await _getRaw(id);
      if (!current) return null;
      if (current.status !== "active") {
        var refused = new Error(
          "apiKeys.update: refused — key is " + current.status
        );
        refused.code = "API_KEY_NOT_UPDATABLE";
        throw refused;
      }

      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (patch.name != null)                   _set("name",                  _name(patch.name));
      if (patch.scopes != null)                 _set("scopes_json",           JSON.stringify(_scopes(patch.scopes)));
      if (patch.rate_limit_per_minute != null)  _set("rate_limit_per_minute", _rateLimit(patch.rate_limit_per_minute));

      params.push(id);
      var sql = "UPDATE api_keys SET " + sets.join(", ") + " WHERE id = ?" + idx;
      await query(sql, params);
      return _project(await _getRaw(id));
    },

    // Append-only usage row + bump `last_used_at` on the parent. The
    // route layer is responsible for calling this on every admitted
    // request; downstream rate-limit accounting reads the usage log
    // across the last 60s.
    recordUse: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("apiKeys.recordUse: input object required");
      }
      var keyId    = _uuid(input.key_id, "key_id");
      var endpoint = _endpoint(input.endpoint);
      var ts;
      if (input.occurred_at != null) {
        ts = _msEpoch(input.occurred_at, "occurred_at");
      } else {
        ts = _now();
      }

      var current = await _getRaw(keyId);
      if (!current) {
        var miss = new Error("apiKeys.recordUse: key not found");
        miss.code = "API_KEY_NOT_FOUND";
        throw miss;
      }

      var rowId = b.uuid.v7();
      await query(
        "INSERT INTO api_key_usage (id, key_id, endpoint, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [rowId, keyId, endpoint, ts],
      );
      await query(
        "UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2",
        [ts, keyId],
      );
      return { id: rowId, key_id: keyId, endpoint: endpoint, occurred_at: ts };
    },

    usageForKey: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("apiKeys.usageForKey: input object required");
      }
      var keyId = _uuid(input.key_id, "key_id");
      var from  = _msEpoch(input.from, "from");
      var to    = _msEpoch(input.to, "to");
      if (from > to) {
        throw new TypeError("apiKeys.usageForKey: from must be <= to");
      }
      var r = await query(
        "SELECT id, key_id, endpoint, occurred_at FROM api_key_usage " +
        "WHERE key_id = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
        "ORDER BY occurred_at DESC, id DESC",
        [keyId, from, to],
      );
      return r.rows.map(function (row) {
        return {
          id:          row.id,
          key_id:      row.key_id,
          endpoint:    row.endpoint,
          occurred_at: Number(row.occurred_at),
        };
      });
    },

    // Sweep any active / rotated row whose `expires_at` has elapsed
    // into the `expired` terminal status. Returns the count of rows
    // swept. Idempotent — calling twice in a row produces 0 on the
    // second call. Operators run this on a schedule (every 5
    // minutes is plenty; expiry doesn't need to be instant because
    // `verifyToken` already refuses elapsed-but-not-yet-swept rows).
    cleanupExpired: async function (input) {
      input = input || {};
      var now;
      if (input.now != null) {
        now = _msEpoch(input.now, "now");
      } else {
        now = _now();
      }
      var r = await query(
        "UPDATE api_keys SET status = 'expired' " +
        "WHERE expires_at IS NOT NULL AND expires_at <= ?1 " +
        "AND status IN ('active', 'rotated')",
        [now],
      );
      return { swept: r.rowCount != null ? Number(r.rowCount) : 0, now: now };
    },
  };
}

module.exports = {
  create:                 create,
  TOKEN_NAMESPACE:        TOKEN_NAMESPACE,
  TOKEN_BYTE_LEN:         TOKEN_BYTE_LEN,
  TOKEN_PLAINTEXT_LEN:    TOKEN_PLAINTEXT_LEN,
  ROTATION_GRACE_MS:      ROTATION_GRACE_MS,
  OWNER_TYPES:            OWNER_TYPES.slice(),
  STATUSES:               STATUSES.slice(),
  MAX_NAME_LEN:           MAX_NAME_LEN,
  MAX_REASON_LEN:         MAX_REASON_LEN,
  MAX_ENDPOINT_LEN:       MAX_ENDPOINT_LEN,
  MAX_SCOPE_LEN:          MAX_SCOPE_LEN,
  MAX_SCOPES_PER_KEY:     MAX_SCOPES_PER_KEY,
  MIN_RATE_LIMIT:         MIN_RATE_LIMIT,
  MAX_RATE_LIMIT:         MAX_RATE_LIMIT,
  DEFAULT_RATE_LIMIT:     DEFAULT_RATE_LIMIT,
};
