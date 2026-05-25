"use strict";
/**
 * @module shop.operatorSessions
 * @title  Operator sessions — staff login sessions for the admin console
 *
 * @intro
 *   The cookie-bearing session that represents a logged-in admin /
 *   support / fulfillment user inside the operator console. Distinct
 *   from `customerPortal` (migration 0072), which is the customer-
 *   facing self-serve link. THIS primitive is the STAFF session
 *   manager — once a primary credential challenge succeeds (and, when
 *   policy demands, an MFA step), the row this primitive mints is the
 *   durable handle the console's session middleware validates on every
 *   subsequent request until logout / expiry / revoke / lockout.
 *
 *   Flow:
 *
 *     1. Operator finishes a primary-credential challenge upstream.
 *        Caller invokes `createSession({ operator_id, ip_hash,
 *        mfa_required, ua_class?, ttl_seconds? })`. The primitive
 *        mints a 32-byte base64url plaintext bearer via
 *        `b.crypto.generateBytes(32)` + `b.crypto.toBase64Url`, hashes
 *        it via `b.crypto.namespaceHash("operator-session-token",
 *        plaintext)`, and writes the hash + the per-IP binding + the
 *        MFA-required flag with the 8-hour default ttl. The plaintext
 *        leaves this function ONCE; the database never stores it.
 *
 *     2. Every subsequent request on the operator console calls
 *        `verifyToken(plaintext, { ip_hash })`. The primitive:
 *          * re-hashes the plaintext via `namespaceHash`;
 *          * looks the row up by the hash (primary-key index);
 *          * runs `b.crypto.timingSafeEqual` against the stored hash
 *            (belt-and-braces around the index hit so the latency
 *            profile matches between hit and miss paths);
 *          * refuses when `status` is not `issued` / `active`;
 *          * refuses when `expires_at <= now`;
 *          * refuses when the presented `ip_hash` differs from the
 *            stored `ip_hash` (per-IP binding — a stolen cookie that
 *            leaves the operator's network is dropped);
 *          * returns `{ requires_mfa: true, session_id }` when the row
 *            still carries `mfa_required = 1` and `mfa_verified_at IS
 *            NULL`;
 *          * on first successful presentation flips `status` from
 *            `issued` → `active` and stamps `activated_at`.
 *
 *     3. When MFA is required (`mfa_required = 1` at create), the
 *        caller routes the operator through the step-up challenge,
 *        then calls `recordMfaVerification(session_id)` once the
 *        challenge succeeds. Subsequent `verifyToken` calls return the
 *        full session shape instead of the requires_mfa stub.
 *
 *     4. Failed credential / MFA / verify attempts are recorded via
 *        `recordFailedVerify({ ip_hash, operator_id?, reason })`. The
 *        scheduler / login-attempt middleware calls `lockoutCheck(
 *        ip_hash, { window_seconds?, threshold? })` to read the last
 *        N minutes of failures from that IP hash. When the count
 *        trips threshold the caller refuses further authentication
 *        attempts AND the operator console auto-revokes any live
 *        sessions from that IP — implemented by walking
 *        `listForOperator(...)` over the affected operators and
 *        calling `revokeSession(id, "lockout-trip")` on each live row.
 *
 *     5. Operators can revoke a live session early via
 *        `revokeSession(session_id, reason)` (logout, password reset,
 *        suspected compromise). The scheduler entry
 *        `expireOlderThan(seconds)` flips stale `issued` / `active`
 *        rows to `expired` so the FSM column stays durable for audit
 *        even when the runtime expiry gate already fires.
 *
 *   Audit:
 *
 *     Every meaningful state transition (createSession,
 *     recordMfaVerification, revokeSession, lockoutCheck threshold
 *     trip, verifyToken success on first activation) is sent to the
 *     optional `operatorAuditLog` peer via the duck-typed `.record(...)`
 *     interface (migration 0074). The audit body carries actor_type =
 *     "operator", actor_id = operator_id, action namespaced under
 *     `session.<event>`, and before / after snapshots of the row's
 *     status + mfa_verified_at columns. The peer is optional — absent
 *     wiring, the FSM transitions still land in the storage row, but
 *     the chained log doesn't.
 *
 *   Composes:
 *     - `b.guardUuid`              — UUID-shape validation on
 *                                    operator_id + session_id at the
 *                                    entry point.
 *     - `b.crypto.generateBytes`   — 32-byte CSPRNG draw for the bearer.
 *     - `b.crypto.toBase64Url`     — URL-safe encoding for the plaintext.
 *     - `b.crypto.namespaceHash`   — keys the storage row off
 *                                    `("operator-session-token",
 *                                    plaintext)` so a dump never
 *                                    reveals live bearers.
 *     - `b.crypto.timingSafeEqual` — constant-time check on verify.
 *     - `b.uuid.v7`                — row id + failed-login event id.
 *     - `operatorRoles` (opt)      — when wired, the create call can
 *                                    consult `requireMfa(operator_id)`
 *                                    to derive `mfa_required` from
 *                                    the operator's role assignment
 *                                    rather than relying on the caller
 *                                    to pass the flag.
 *     - `operatorAuditLog` (opt)   — chained-hash audit log.
 *
 *   Surface:
 *     - `createSession({ operator_id, ip_hash, mfa_required?,
 *                        ua_class?, ttl_seconds? })`
 *         → `{ session_id, plaintext_token, expires_at, mfa_required }`
 *     - `verifyToken(plaintext, { ip_hash })`
 *         → on miss: `null`
 *         → on requires_mfa: `{ requires_mfa: true, session_id,
 *                               operator_id, expires_at }`
 *         → on hit:  `{ session_id, operator_id, expires_at,
 *                       mfa_verified_at }`
 *     - `requireMfa(operator_id)` → boolean (queries the optional
 *         `operatorRoles` peer; defaults to `true` when the peer is
 *         wired, `false` when absent so the primitive is testable in
 *         isolation).
 *     - `recordMfaVerification(session_id)`
 *         → `{ verified: boolean }`
 *     - `revokeSession(session_id, reason)`
 *         → `{ revoked: boolean }`
 *     - `listForOperator(operator_id, { from?, to?, status? })`
 *         → array of session rows, newest-first.
 *     - `expireOlderThan(seconds)`
 *         → `{ expired: <count> }`
 *     - `lockoutCheck(ip_hash, { window_seconds?, threshold? })`
 *         → `{ locked: boolean, count: <number>, threshold: <number>,
 *              window_seconds: <number> }`
 *     - `recordFailedVerify({ ip_hash, operator_id?, reason })`
 *         → `{ id, occurred_at }`
 *
 *   Storage:
 *     - `operator_sessions`        (migration `0165_operator_sessions.sql`)
 *     - `operator_failed_logins`   (migration `0165_operator_sessions.sql`)
 *
 * @primitive operatorSessions
 * @related   b.crypto.generateBytes, b.crypto.namespaceHash,
 *            b.crypto.timingSafeEqual, b.guardUuid, b.uuid,
 *            operatorRoles, operatorAuditLog
 */

var TOKEN_NAMESPACE         = "operator-session-token";
var TOKEN_BYTES             = 32;
var DEFAULT_TTL_SECONDS     = 8 * 60 * 60;             // allow:raw-time-literal — TTL stored in seconds; C.TIME returns ms (8-hour shift default)
var MIN_TTL_SECONDS         = 60;                       // refuse zero / sub-minute
var MAX_TTL_SECONDS         = 60 * 60 * 24;             // allow:raw-time-literal — TTL stored in seconds; C.TIME returns ms (hard ceiling — one day)
var MAX_REASON_LEN          = 64;
var MAX_UA_CLASS_LEN        = 64;
var MAX_IP_HASH_LEN         = 256;
var MIN_IP_HASH_LEN         = 1;
var DEFAULT_LOCKOUT_WINDOW  = 15 * 60;                  // allow:raw-time-literal — lockout window stored in seconds; C.TIME returns ms (15-minute rolling window)
var DEFAULT_LOCKOUT_THRESH  = 5;                        // 5 failures trips lockout
var MAX_LOCKOUT_WINDOW      = 24 * 60 * 60;             // allow:raw-time-literal — lockout window stored in seconds; C.TIME returns ms (sanity cap — one day)
var MIN_LOCKOUT_THRESHOLD   = 1;
var MAX_LOCKOUT_THRESHOLD   = 1000;

var STATUS_VALUES = Object.freeze([
  "issued",
  "active",
  "expired",
  "revoked",
  "locked_out",
]);

// Framework handle (the vendored blamejs); index.js re-exports this as .framework.
var b = require("./vendor/blamejs");

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("operator-sessions: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _ttlSeconds(n) {
  if (n == null) return DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(n) || n < MIN_TTL_SECONDS || n > MAX_TTL_SECONDS) {
    throw new TypeError(
      "operator-sessions: ttl_seconds must be an integer in [" +
      MIN_TTL_SECONDS + ", " + MAX_TTL_SECONDS + "]"
    );
  }
  return n;
}

function _requiredString(s, label, minLen, maxLen) {
  if (typeof s !== "string") {
    throw new TypeError("operator-sessions: " + label + " must be a string");
  }
  if (s.length < minLen) {
    throw new TypeError("operator-sessions: " + label + " must be a non-empty string");
  }
  if (s.length > maxLen) {
    throw new TypeError("operator-sessions: " + label + " must be <= " + maxLen + " characters");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("operator-sessions: " + label + " must not contain control bytes");
  }
  return s;
}

function _optShortString(s, label, maxLen) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("operator-sessions: " + label + " must be a string");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("operator-sessions: " + label + " must not contain control bytes");
  }
  if (s.length > maxLen) {
    throw new TypeError("operator-sessions: " + label + " must be <= " + maxLen + " characters");
  }
  return s;
}

function _seconds(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("operator-sessions: " + label + " must be a non-negative integer (seconds)");
  }
}

function _optTsBound(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("operator-sessions: " + label + " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _optStatusFilter(s) {
  if (s == null) return null;
  if (STATUS_VALUES.indexOf(s) === -1) {
    throw new TypeError("operator-sessions: status filter must be one of " + STATUS_VALUES.join(", "));
  }
  return s;
}

function _bool(v, label) {
  if (v == null) return false;
  if (v === true || v === false) return v;
  throw new TypeError("operator-sessions: " + label + " must be a boolean");
}

function _lockoutWindow(n) {
  if (n == null) return DEFAULT_LOCKOUT_WINDOW;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LOCKOUT_WINDOW) {
    throw new TypeError(
      "operator-sessions: window_seconds must be an integer in [1, " + MAX_LOCKOUT_WINDOW + "]"
    );
  }
  return n;
}

function _lockoutThreshold(n) {
  if (n == null) return DEFAULT_LOCKOUT_THRESH;
  if (!Number.isInteger(n) || n < MIN_LOCKOUT_THRESHOLD || n > MAX_LOCKOUT_THRESHOLD) {
    throw new TypeError(
      "operator-sessions: threshold must be an integer in [" +
      MIN_LOCKOUT_THRESHOLD + ", " + MAX_LOCKOUT_THRESHOLD + "]"
    );
  }
  return n;
}

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional peers. Duck-typed — the tests stub these without
  // importing the full primitive.
  var operatorRoles    = opts.operatorRoles    || null;
  var operatorAuditLog = opts.operatorAuditLog || null;

  // Per-factory monotonic clock. Two staff actions in the same
  // millisecond (createSession + recordMfaVerification, for instance)
  // still produce strictly-increasing timestamps so the audit timeline
  // sorts deterministically.
  var _lastTs = 0;
  function _now() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  async function _audit(action, operatorId, sessionId, before, after) {
    if (!operatorAuditLog || typeof operatorAuditLog.record !== "function") return;
    await operatorAuditLog.record({
      actor_type:    "operator",
      actor_id:      operatorId,
      action:        "session." + action,
      resource_kind: "operator_session",
      resource_id:   sessionId,
      before:        before,
      after:         after,
    });
  }

  return {
    STATUS_VALUES:           STATUS_VALUES,
    DEFAULT_TTL_SECONDS:     DEFAULT_TTL_SECONDS,
    DEFAULT_LOCKOUT_WINDOW:  DEFAULT_LOCKOUT_WINDOW,
    DEFAULT_LOCKOUT_THRESH:  DEFAULT_LOCKOUT_THRESH,
    TOKEN_NAMESPACE:         TOKEN_NAMESPACE,

    // ---- createSession --------------------------------------------------
    //
    // Mints a fresh operator session. The plaintext bearer is returned
    // ONCE; the database stores only the namespaceHash. The per-IP
    // binding is REQUIRED (staff sessions defend access to PII / order
    // history — a missing ip_hash is a primitive-layer error, not a
    // permissive default). On a wired `operatorRoles` peer, the
    // primitive can derive `mfa_required` via `requireMfa(operator_id)`
    // when the caller leaves the flag unset.
    createSession: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operator-sessions.createSession: input object required");
      }
      var operatorId = _uuid(input.operator_id, "operator_id");
      var ipHash     = _requiredString(input.ip_hash, "ip_hash", MIN_IP_HASH_LEN, MAX_IP_HASH_LEN);
      var uaClass    = _optShortString(input.ua_class, "ua_class", MAX_UA_CLASS_LEN);
      var ttl        = _ttlSeconds(input.ttl_seconds);
      var mfaRequired;
      if (input.mfa_required == null && operatorRoles && typeof operatorRoles.requireMfa === "function") {
        // Peer-derived policy. The peer returns truthy when the
        // operator's role assignment demands a step-up; the primitive
        // stores the boolean. Bad peer return (non-boolean) is coerced
        // through Boolean(...) so a stub returning 1 / 0 still works.
        mfaRequired = Boolean(await operatorRoles.requireMfa(operatorId));
      } else {
        mfaRequired = _bool(input.mfa_required, "mfa_required");
      }

      var plaintext = b.crypto.toBase64Url(
        b.crypto.generateBytes(TOKEN_BYTES)
      );
      var tokenHash = b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var id        = b.uuid.v7();
      var now       = _now();
      var expiresAt = now + (ttl * 1000);   // allow:raw-time-literal — ttl is in seconds; * 1000 converts to ms

      await query(
        "INSERT INTO operator_sessions " +
        "(id, operator_id, token_hash, ip_hash, ua_class, status, " +
        " mfa_required, mfa_verified_at, activated_at, " +
        " revoked_at, revoke_reason, ttl_seconds, created_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'issued', ?6, NULL, NULL, " +
        "        NULL, NULL, ?7, ?8, ?9)",
        [id, operatorId, tokenHash, ipHash, uaClass,
         mfaRequired ? 1 : 0, ttl, now, expiresAt],
      );

      await _audit(
        "create",
        operatorId,
        id,
        null,
        { status: "issued", mfa_required: mfaRequired },
      );

      return {
        session_id:      id,
        plaintext_token: plaintext,
        expires_at:      expiresAt,
        mfa_required:    mfaRequired,
      };
    },

    // ---- verifyToken ----------------------------------------------------
    //
    // Validates a presented bearer + ip_hash against the stored row.
    // Returns null on every refuse path (unknown token, expired,
    // consumed, revoked, locked_out, ip_hash mismatch, malformed
    // input). Returns `{ requires_mfa: true, ... }` when the row is
    // valid but the MFA gate has not been satisfied yet. Returns the
    // full session shape on the first hit AND every subsequent hit
    // until the row leaves a redeemable status.
    //
    // The first successful verify on an `issued` row flips it to
    // `active` and stamps `activated_at` — the FSM column makes the
    // "live session" set cheap to query for audit ("show me every
    // operator currently signed in").
    verifyToken: async function (plaintext, vopts) {
      if (typeof plaintext !== "string" || !plaintext.length) {
        return null;
      }
      if (!vopts || typeof vopts !== "object" || typeof vopts.ip_hash !== "string" || !vopts.ip_hash.length) {
        // ip_hash is mandatory on verify — defending the per-IP
        // binding is part of the primitive's contract. Treat a
        // missing / malformed presentation as a miss rather than
        // surface a TypeError; the calling middleware renders the
        // sign-in page either way.
        return null;
      }
      var presentedIp = vopts.ip_hash;
      var tokenHash   = b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var row = (await query(
        "SELECT id, operator_id, token_hash, ip_hash, status, " +
        "       mfa_required, mfa_verified_at, expires_at " +
        "FROM operator_sessions WHERE token_hash = ?1 LIMIT 1",
        [tokenHash],
      )).rows[0];
      if (!row) {
        // Burn the same compare work as the hit path so the latency
        // profile matches between miss and hit. The compared values
        // are equal-length and equal (the hash against itself); the
        // result is discarded.
        b.crypto.timingSafeEqual(tokenHash, tokenHash);
        return null;
      }
      var matched = b.crypto.timingSafeEqual(row.token_hash, tokenHash);
      if (!matched) return null;
      if (row.status !== "issued" && row.status !== "active") return null;
      var now = _now();
      if (Number(row.expires_at) <= now) return null;
      if (row.ip_hash !== presentedIp) return null;

      var mfaRequired = Number(row.mfa_required) === 1;
      var mfaVerifiedAt = row.mfa_verified_at == null ? null : Number(row.mfa_verified_at);

      if (mfaRequired && mfaVerifiedAt == null) {
        // The bearer is valid, the IP is bound, the row is fresh, but
        // the operator hasn't completed the step-up challenge yet.
        // The caller routes them through MFA, then calls
        // `recordMfaVerification(session_id)`.
        return {
          requires_mfa: true,
          session_id:   row.id,
          operator_id:  row.operator_id,
          expires_at:   Number(row.expires_at),
        };
      }

      // First-hit activation. Flip `issued` → `active` and stamp
      // `activated_at`. The WHERE clause re-asserts `status =
      // 'issued'` so two racing verifies don't both stamp; the loser
      // simply observes `status === 'active'` on the read below and
      // falls through. We do NOT refuse on zero-row UPDATE — the
      // session is already active, which is fine.
      if (row.status === "issued") {
        await query(
          "UPDATE operator_sessions " +
          "SET status = 'active', activated_at = ?1 " +
          "WHERE id = ?2 AND status = 'issued'",
          [now, row.id],
        );
        await _audit(
          "activate",
          row.operator_id,
          row.id,
          { status: "issued" },
          { status: "active", activated_at: now },
        );
      }

      return {
        session_id:       row.id,
        operator_id:      row.operator_id,
        expires_at:       Number(row.expires_at),
        mfa_verified_at:  mfaVerifiedAt,
      };
    },

    // ---- requireMfa -----------------------------------------------------
    //
    // Convenience wrapper around the optional `operatorRoles` peer.
    // Returns the peer's boolean when wired; otherwise returns false
    // so the primitive remains testable in isolation. The caller of
    // `createSession` typically does NOT need to invoke this directly
    // — the create call consults the peer itself when `mfa_required`
    // is left unset.
    requireMfa: async function (operatorId) {
      var id = _uuid(operatorId, "operator_id");
      if (!operatorRoles || typeof operatorRoles.requireMfa !== "function") {
        return false;
      }
      return Boolean(await operatorRoles.requireMfa(id));
    },

    // ---- recordMfaVerification ------------------------------------------
    //
    // Stamps `mfa_verified_at` after the caller has finished the step-
    // up challenge. Idempotent on already-verified rows (returns
    // `{ verified: false }`); refuses on terminal rows the same way.
    recordMfaVerification: async function (sessionId) {
      var id = _uuid(sessionId, "session_id");
      var now = _now();
      // Pull the operator_id ahead of the flip so the audit row
      // carries it even if the UPDATE matches zero rows. Failing here
      // means the row doesn't exist — surface a null-ish return so
      // the caller treats it identically to "already verified".
      var existing = (await query(
        "SELECT operator_id, mfa_verified_at, status FROM operator_sessions WHERE id = ?1",
        [id],
      )).rows[0];
      if (!existing) {
        return { verified: false };
      }
      var r = await query(
        "UPDATE operator_sessions " +
        "SET mfa_verified_at = ?1 " +
        "WHERE id = ?2 AND mfa_verified_at IS NULL " +
        "  AND status IN ('issued', 'active')",
        [now, id],
      );
      var flipped = Number(r.rowCount || 0) > 0;
      if (flipped) {
        await _audit(
          "mfa_verify",
          existing.operator_id,
          id,
          { mfa_verified_at: null },
          { mfa_verified_at: now },
        );
      }
      return { verified: flipped };
    },

    // ---- revokeSession --------------------------------------------------
    //
    // Operator-initiated kill (logout, password reset, suspected
    // compromise) OR auto-revoke driven by lockoutCheck. Idempotent —
    // calling on an already-terminal row returns `{ revoked: false }`
    // rather than throwing, so the caller can safely loop over a list
    // of session ids during a bulk eject.
    revokeSession: async function (sessionId, reason) {
      var id    = _uuid(sessionId, "session_id");
      var clean = _optShortString(reason, "reason", MAX_REASON_LEN);
      if (clean == null) {
        throw new TypeError(
          "operator-sessions.revokeSession: reason required (non-empty string <= " +
          MAX_REASON_LEN + " chars)"
        );
      }
      var now = _now();
      var existing = (await query(
        "SELECT operator_id, status FROM operator_sessions WHERE id = ?1",
        [id],
      )).rows[0];
      var r = await query(
        "UPDATE operator_sessions " +
        "SET status = 'revoked', revoked_at = ?1, revoke_reason = ?2 " +
        "WHERE id = ?3 AND status IN ('issued', 'active')",
        [now, clean, id],
      );
      var revoked = Number(r.rowCount || 0) > 0;
      if (revoked && existing) {
        await _audit(
          "revoke",
          existing.operator_id,
          id,
          { status: existing.status },
          { status: "revoked", revoked_at: now, revoke_reason: clean },
        );
      }
      return { revoked: revoked };
    },

    // ---- listForOperator ------------------------------------------------
    //
    // Audit / debugging entry point. Returns every session ever
    // minted for an operator, newest-first by created_at (id as
    // tiebreak — both are uuid.v7-derived so the ordering is
    // monotonic). Optional `from` / `to` bounds (ms epoch, inclusive
    // lower / exclusive upper) constrain the window. Optional `status`
    // filter narrows to a single FSM state.
    listForOperator: async function (operatorId, listOpts) {
      var oid = _uuid(operatorId, "operator_id");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("operator-sessions.listForOperator: opts must be an object");
      }
      var from   = _optTsBound(listOpts.from,   "from");
      var to     = _optTsBound(listOpts.to,     "to");
      var status = _optStatusFilter(listOpts.status);

      var sql = "SELECT id, operator_id, ip_hash, ua_class, status, " +
                "mfa_required, mfa_verified_at, activated_at, " +
                "revoked_at, revoke_reason, ttl_seconds, " +
                "created_at, expires_at " +
                "FROM operator_sessions WHERE operator_id = ?1";
      var params = [oid];
      if (from != null) {
        params.push(from);
        sql += " AND created_at >= ?" + params.length;
      }
      if (to != null) {
        params.push(to);
        sql += " AND created_at < ?" + params.length;
      }
      if (status != null) {
        params.push(status);
        sql += " AND status = ?" + params.length;
      }
      sql += " ORDER BY created_at DESC, id DESC";
      var r = await query(sql, params);
      return r.rows;
    },

    // ---- expireOlderThan ------------------------------------------------
    //
    // Scheduler walk: flip every redeemable row (`issued` / `active`)
    // whose `expires_at` is more than `seconds` in the past to
    // `expired`. The lazy gate — verifyToken always re-checks
    // `expires_at > now` regardless — but the durable FSM stamp keeps
    // audit / "show me every live session" queries cheap. Returns the
    // count of rows flipped so the cron / scheduled-worker layer can
    // emit a metric.
    expireOlderThan: async function (seconds) {
      _seconds(seconds, "seconds");
      var threshold = _now() - (seconds * 1000);   // allow:raw-time-literal — seconds arg is in seconds; * 1000 converts to ms
      var r = await query(
        "UPDATE operator_sessions " +
        "SET status = 'expired' " +
        "WHERE status IN ('issued', 'active') AND expires_at < ?1",
        [threshold],
      );
      return { expired: Number(r.rowCount || 0) };
    },

    // ---- lockoutCheck ---------------------------------------------------
    //
    // Reads the last `window_seconds` of `operator_failed_logins` rows
    // from `ip_hash`. Returns `{ locked: true }` when the count meets
    // or exceeds threshold. Defaults: 5 failures in 15 minutes trips
    // lockout. The caller is responsible for translating
    // `locked: true` into an HTTP refusal AND for walking
    // `listForOperator` to revoke any live sessions from the affected
    // IP — this primitive does NOT auto-revoke on the lockoutCheck
    // read itself (read-only contract). When the threshold is tripped
    // the caller invokes `revokeSession` on each affected live row,
    // and that revoke path lands an audit row via the standard
    // composition.
    lockoutCheck: async function (ipHash, lopts) {
      var ip = _requiredString(ipHash, "ip_hash", MIN_IP_HASH_LEN, MAX_IP_HASH_LEN);
      lopts = lopts || {};
      if (typeof lopts !== "object") {
        throw new TypeError("operator-sessions.lockoutCheck: opts must be an object");
      }
      var windowSec = _lockoutWindow(lopts.window_seconds);
      var threshold = _lockoutThreshold(lopts.threshold);
      var since     = _now() - (windowSec * 1000);   // allow:raw-time-literal — windowSec is in seconds; * 1000 converts to ms
      var r = await query(
        "SELECT COUNT(*) AS n FROM operator_failed_logins " +
        "WHERE ip_hash = ?1 AND occurred_at >= ?2",
        [ip, since],
      );
      var count = Number((r.rows[0] && r.rows[0].n) || 0);
      return {
        locked:         count >= threshold,
        count:          count,
        threshold:      threshold,
        window_seconds: windowSec,
      };
    },

    // ---- recordFailedVerify ---------------------------------------------
    //
    // Append-only event log. The login middleware calls this on every
    // primary-credential miss, MFA miss, or any other "authentication
    // attempt refused" path. `operator_id` is optional — the miss may
    // happen before the operator is even identified (unknown email,
    // for instance). `reason` is a short free-form label
    // ("bad-password", "mfa-fail", "unknown-operator",
    // "ip-binding-mismatch") that the audit reader uses to bucket the
    // timeline.
    recordFailedVerify: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operator-sessions.recordFailedVerify: input object required");
      }
      var ip          = _requiredString(input.ip_hash, "ip_hash", MIN_IP_HASH_LEN, MAX_IP_HASH_LEN);
      var reason      = _requiredString(input.reason,  "reason",  1, MAX_REASON_LEN);
      var operatorId  = input.operator_id == null ? null : _uuid(input.operator_id, "operator_id");
      var id          = b.uuid.v7();
      var now         = _now();
      await query(
        "INSERT INTO operator_failed_logins " +
        "(id, ip_hash, operator_id, reason, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, ip, operatorId, reason, now],
      );
      return { id: id, occurred_at: now };
    },
  };
}

module.exports = {
  create:                  create,
  STATUS_VALUES:           STATUS_VALUES,
  DEFAULT_TTL_SECONDS:     DEFAULT_TTL_SECONDS,
  DEFAULT_LOCKOUT_WINDOW:  DEFAULT_LOCKOUT_WINDOW,
  DEFAULT_LOCKOUT_THRESH:  DEFAULT_LOCKOUT_THRESH,
  TOKEN_NAMESPACE:         TOKEN_NAMESPACE,
};
