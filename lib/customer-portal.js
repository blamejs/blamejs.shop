"use strict";
/**
 * @module shop.customerPortal
 * @title  Customer portal sessions — self-serve link minting + redemption
 *
 * @intro
 *   The framework hosts its OWN customer portal page — addresses,
 *   payment methods, subscriptions, open orders — and this primitive
 *   is the session manager for the link the customer follows to
 *   reach it. It is NOT a Stripe Customer Portal link.
 *
 *   Flow:
 *     1. Customer requests a portal link from the storefront. The
 *        caller (typically a route handler downstream of an email-
 *        verification or password challenge) calls
 *        `createSession({ customer_id, scope })`.
 *     2. The primitive mints a 32-byte base64url plaintext token via
 *        `b.crypto.generateBytes(32)` + `b.crypto.toBase64Url`, hashes
 *        it via `b.crypto.namespaceHash("customer-portal-token", ...)`,
 *        and writes the hash + scope + 15-min default expiry. The
 *        plaintext is returned ONCE; the database never stores it.
 *     3. The customer follows the link to the portal endpoint, which
 *        calls `verifyToken(plaintext)`. The primitive re-hashes the
 *        plaintext, looks up by hash, runs a `b.crypto.timingSafeEqual`
 *        check (belt-and-braces around the PK index), gates on
 *        `status === 'issued'` and `expires_at > now`, and on success
 *        flips the row to `consumed` (single-use). Returns
 *        `{ customer_id, scope, session_id, expires_at }` or null.
 *     4. Operators can revoke a live session early via
 *        `revokeSession(session_id, reason)` (e.g. password-reset,
 *        session-stolen). The scheduler entry `expireOlderThan(seconds)`
 *        flips stale `issued` rows to `expired` so the FSM column
 *        stays durable for audit.
 *
 *   Composes:
 *     - `b.guardUuid`            — UUID-shape validation on customer
 *                                  ids + session ids at the entry
 *                                  point; bad shape throws a
 *                                  TypeError the calling route handler
 *                                  translates to HTTP 400.
 *     - `b.crypto.generateBytes` — 32-byte CSPRNG draw for the token.
 *     - `b.crypto.toBase64Url`   — URL-safe encoding for the plaintext.
 *     - `b.crypto.namespaceHash` — keys the storage row off
 *                                  `("customer-portal-token", plaintext)`
 *                                  so a dump never reveals the live
 *                                  links the customer received.
 *     - `b.crypto.timingSafeEqual` — constant-time check of stored vs
 *                                  recomputed hash on verify.
 *     - `b.uuid.v7`              — row id; also lexicographically
 *                                  sortable for the listForCustomer
 *                                  tiebreak alongside created_at.
 *
 *   Surface:
 *     - `createSession({ customer_id, scope, ttl_seconds?, ip_hash?,
 *                        ua_class? })`
 *         → `{ session_id, plaintext_token, expires_at }`
 *     - `verifyToken(plaintext)`
 *         → `{ customer_id, scope, session_id, expires_at }` or null
 *         Flips the row to `consumed` on success (single-use).
 *     - `revokeSession(session_id, reason)`
 *         → `{ revoked: boolean }`
 *     - `listForCustomer(customer_id, { from?, to? })`
 *         → array of session rows, newest-first.
 *     - `expireOlderThan(seconds)`
 *         → `{ expired: <count> }`
 *
 *   Storage:
 *     - `customer_portal_sessions`
 *       (migration `0072_customer_portal_sessions.sql`).
 *
 * @primitive customerPortal
 * @related   b.crypto.generateBytes, b.crypto.namespaceHash,
 *            b.crypto.timingSafeEqual, b.guardUuid, b.uuid
 */

var TOKEN_NAMESPACE      = "customer-portal-token";
var TOKEN_BYTES          = 32;
var DEFAULT_TTL_SECONDS  = 15 * 60;                 // allow:raw-time-literal — seconds value; C.TIME returns ms
var MAX_TTL_SECONDS      = 60 * 60 * 24;            // allow:raw-time-literal — seconds value; C.TIME returns ms (hard ceiling — one day)
var MIN_TTL_SECONDS      = 30;                       // refuse zero / negative / sub-30s
var MAX_REASON_LEN       = 64;
var MAX_UA_CLASS_LEN     = 64;
var MAX_IP_HASH_LEN      = 256;
var SCOPE_VALUES         = Object.freeze([
  "full",
  "billing_only",
  "address_only",
  "subscriptions_only",
  "order_history_only",
]);
var STATUS_VALUES        = Object.freeze([
  "issued",
  "consumed",
  "expired",
  "revoked",
]);

var b = require("./index").framework;

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customer-portal: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _scope(s) {
  if (SCOPE_VALUES.indexOf(s) === -1) {
    throw new TypeError("customer-portal: scope must be one of " + SCOPE_VALUES.join(", "));
  }
  return s;
}

function _ttlSeconds(n) {
  if (n == null) return DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(n) || n < MIN_TTL_SECONDS || n > MAX_TTL_SECONDS) {
    throw new TypeError(
      "customer-portal: ttl_seconds must be an integer in [" +
      MIN_TTL_SECONDS + ", " + MAX_TTL_SECONDS + "]"
    );
  }
  return n;
}

function _optShortString(s, label, maxLen) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("customer-portal: " + label + " must be a string");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("customer-portal: " + label + " must not contain control bytes");
  }
  if (s.length > maxLen) {
    throw new TypeError("customer-portal: " + label + " must be ≤ " + maxLen + " chars");
  }
  return s;
}

function _seconds(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("customer-portal: " + label + " must be a non-negative integer (seconds)");
  }
}

function _optTsBound(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("customer-portal: " + label + " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _now() { return Date.now(); }

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  return {
    SCOPE_VALUES:        SCOPE_VALUES,
    STATUS_VALUES:       STATUS_VALUES,
    DEFAULT_TTL_SECONDS: DEFAULT_TTL_SECONDS,
    TOKEN_NAMESPACE:     TOKEN_NAMESPACE,

    // Mint a fresh portal session. The plaintext token is returned
    // ONCE; the database stores only the namespaceHash. Callers pass
    // the plaintext into the email body / SMS template that delivers
    // the portal URL — never log it, never persist it server-side.
    //
    //   Inputs are validated up-front (UUID shape on customer_id,
    //   enum check on scope, integer-range check on ttl_seconds,
    //   short-string + control-byte check on ip_hash / ua_class).
    //   Bad input throws TypeError so the route handler turns into
    //   HTTP 400 cleanly.
    createSession: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-portal.createSession: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var scope      = _scope(input.scope);
      var ttl        = _ttlSeconds(input.ttl_seconds);
      var ipHash     = _optShortString(input.ip_hash,  "ip_hash",  MAX_IP_HASH_LEN);
      var uaClass    = _optShortString(input.ua_class, "ua_class", MAX_UA_CLASS_LEN);

      var plaintext = b.crypto.toBase64Url(
        b.crypto.generateBytes(TOKEN_BYTES)
      );
      var tokenHash = b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var id        = b.uuid.v7();
      var now       = _now();
      var expiresAt = now + (ttl * 1000); // allow:raw-time-literal — ttl is a runtime seconds value; *1000 converts to ms

      await query(
        "INSERT INTO customer_portal_sessions " +
        "(id, customer_id, token_hash, scope, status, " +
        " consumed_at, revoked_at, revoke_reason, ip_hash, ua_class, " +
        " created_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'issued', NULL, NULL, NULL, ?5, ?6, ?7, ?8)",
        [id, customerId, tokenHash, scope, ipHash, uaClass, now, expiresAt],
      );

      // The plaintext leaves this function exactly once. The row
      // above is the only durable handle to the session; the hash
      // makes the storage layer useless for replaying live links.
      return {
        session_id:      id,
        plaintext_token: plaintext,
        expires_at:      expiresAt,
      };
    },

    // Single-use redemption. Returns `null` on every failure mode
    // (unknown token, expired, consumed, revoked, malformed input) —
    // the caller is typically a route handler that wants to render a
    // single "request a fresh link" page regardless of why. Latency
    // between the miss-path and the hit-path is equalised by burning
    // a constant-shape `timingSafeEqual` even on the miss branch so
    // an attacker can't distinguish "no such token" from "already-
    // consumed" through the response-latency channel.
    //
    //   On success the row's status flips to `consumed` and
    //   `consumed_at` is stamped. A second call with the same
    //   plaintext misses on the status gate.
    verifyToken: async function (plaintext) {
      if (typeof plaintext !== "string" || !plaintext.length) {
        return null;
      }
      var tokenHash = b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var row = (await query(
        "SELECT id, customer_id, token_hash, scope, status, expires_at " +
        "FROM customer_portal_sessions WHERE token_hash = ?1 LIMIT 1",
        [tokenHash],
      )).rows[0];
      if (!row) {
        // Burn the same comparison work as the hit path so the
        // latency profile matches. The compared values are
        // deliberately equal-length and equal (the hash against
        // itself); the result is discarded.
        b.crypto.timingSafeEqual(tokenHash, tokenHash);
        return null;
      }
      var matched = b.crypto.timingSafeEqual(row.token_hash, tokenHash);
      if (!matched) return null;
      if (row.status !== "issued") return null;
      var now = _now();
      if (Number(row.expires_at) <= now) return null;

      // Single-use flip. The WHERE clause re-asserts `status =
      // 'issued'` so two racing verifies don't both succeed — the
      // second one's UPDATE matches zero rows and we treat that as
      // already-consumed (return null).
      var upd = await query(
        "UPDATE customer_portal_sessions " +
        "SET status = 'consumed', consumed_at = ?1 " +
        "WHERE id = ?2 AND status = 'issued'",
        [now, row.id],
      );
      if (Number(upd.rowCount || 0) === 0) return null;

      return {
        customer_id: row.customer_id,
        scope:       row.scope,
        session_id:  row.id,
        expires_at:  Number(row.expires_at),
      };
    },

    // Operator-initiated kill. Idempotent — calling on an already-
    // terminal row (consumed / expired / revoked) returns
    // `{ revoked: false }` rather than throwing, so the caller can
    // safely loop over a list of session ids during a bulk eject
    // (password reset across every live session for a customer).
    revokeSession: async function (sessionId, reason) {
      var id     = _uuid(sessionId, "session_id");
      var clean  = _optShortString(reason, "reason", MAX_REASON_LEN);
      if (clean == null) {
        throw new TypeError("customer-portal.revokeSession: reason required (non-empty string ≤ " + MAX_REASON_LEN + " chars)");
      }
      var now = _now();
      var r = await query(
        "UPDATE customer_portal_sessions " +
        "SET status = 'revoked', revoked_at = ?1, revoke_reason = ?2 " +
        "WHERE id = ?3 AND status = 'issued'",
        [now, clean, id],
      );
      return { revoked: Number(r.rowCount || 0) > 0 };
    },

    // Audit / debugging entry point. Returns every session ever
    // minted for a customer, newest-first by created_at (id as
    // tiebreak — both are uuid.v7-derived so the ordering is
    // monotonic). Optional `from` / `to` bounds (ms epoch, inclusive
    // lower / exclusive upper) constrain the window without a full
    // table scan thanks to the (customer_id, created_at desc) index.
    listForCustomer: async function (customerId, listOpts) {
      var cid = _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("customer-portal.listForCustomer: opts must be an object");
      }
      var from = _optTsBound(listOpts.from, "from");
      var to   = _optTsBound(listOpts.to,   "to");

      var sql = "SELECT id, customer_id, scope, status, " +
                "consumed_at, revoked_at, revoke_reason, " +
                "ip_hash, ua_class, created_at, expires_at " +
                "FROM customer_portal_sessions WHERE customer_id = ?1";
      var params = [cid];
      if (from != null) {
        params.push(from);
        sql += " AND created_at >= ?" + params.length;
      }
      if (to != null) {
        params.push(to);
        sql += " AND created_at < ?" + params.length;
      }
      sql += " ORDER BY created_at DESC, id DESC";
      var r = await query(sql, params);
      return r.rows;
    },

    // Scheduler walk: flip every `issued` row whose `expires_at` is
    // more than `seconds` in the past from `expired`. The lazy gate
    // — verifyToken always re-checks `expires_at > now` regardless
    // — but the durable FSM stamp keeps audit / "show me every live
    // session" queries cheap (status = 'issued' implies "redeemable
    // right now" rather than "issued at some point in the past").
    //
    //   Returns the count of rows flipped so the cron / scheduled-
    //   worker layer can emit a metric.
    expireOlderThan: async function (seconds) {
      _seconds(seconds, "seconds");
      var threshold = _now() - (seconds * 1000); // allow:raw-time-literal — seconds is a runtime seconds value; *1000 converts to ms
      var r = await query(
        "UPDATE customer_portal_sessions " +
        "SET status = 'expired' " +
        "WHERE status = 'issued' AND expires_at < ?1",
        [threshold],
      );
      return { expired: Number(r.rowCount || 0) };
    },
  };
}

module.exports = {
  create:              create,
  SCOPE_VALUES:        SCOPE_VALUES,
  STATUS_VALUES:       STATUS_VALUES,
  DEFAULT_TTL_SECONDS: DEFAULT_TTL_SECONDS,
  TOKEN_NAMESPACE:     TOKEN_NAMESPACE,
};
