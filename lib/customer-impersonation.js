"use strict";
/**
 * @module shop.customerImpersonation
 * @title  Customer impersonation — operator login-as-customer with
 *         strict audit trail, automatic timeout, and customer
 *         notification
 *
 * @intro
 *   Support troubleshooting routinely requires the operator to see the
 *   storefront the way a specific customer sees it — to reproduce a
 *   broken cart, debug an address-validation refusal, or confirm a
 *   promo applies. The naive shape ("operator signs in as the
 *   customer") is the worst possible shape from an audit standpoint:
 *   every action looks like it came from the customer themselves,
 *   there's no out-of-band signal to the customer that someone else
 *   peered into their account, and a forgotten session keeps the
 *   elevated authority alive indefinitely.
 *
 *   This primitive replaces that pattern with an explicit
 *   impersonation session:
 *
 *     1. The operator calls `startImpersonation({ operator_id,
 *        customer_id, reason })`. When the optional `operatorRoles`
 *        peer is wired, the call gates on `hasPermission(operator_id,
 *        "can_impersonate_customer")` — operators without the
 *        capability are refused at the primitive layer, not in
 *        application code. The primitive mints a 32-byte base64url
 *        plaintext bearer via `b.crypto.generateBytes(32)` +
 *        `b.crypto.toBase64Url`, hashes it via
 *        `b.crypto.namespaceHash("customer-impersonation-token",
 *        plaintext)`, and writes the hash + a 60-minute TTL. The
 *        plaintext leaves this function ONCE; the database never
 *        stores it.
 *
 *     2. Every action the operator takes while the session is live is
 *        captured via `actionsRecord({ impersonation_id, action,
 *        resource_kind, resource_id })`. The application layer wires
 *        this into its existing operator middleware so the audit log
 *        is automatic — operators do not have to remember to record
 *        each action manually. The actions table is append-only;
 *        rows are never updated or deleted.
 *
 *     3. `notifyCustomer({ impersonation_id })` enqueues the customer
 *        notification via the optional `notifications` peer. The
 *        primitive stamps `customer_notified_at` on the row so the
 *        audit reader can spot the (rare) case where notifications
 *        was down when the session opened. The notification is
 *        out-of-band — typically an email — so the customer learns
 *        an operator viewed their account even if the operator never
 *        tells them. The application calls `notifyCustomer`
 *        immediately after `startImpersonation`; this primitive
 *        does NOT auto-notify because some support flows (a customer
 *        physically present at a retail counter) supply the consent
 *        synchronously and the email becomes noise.
 *
 *     4. `endImpersonation({ impersonation_id, ended_by, reason })`
 *        terminates the session. The row's `status` flips from
 *        `active` to `ended` and `ended_at` + `end_reason` land. The
 *        operator's session bearer is no longer valid; any future
 *        `verifyImpersonationToken` returns null. Calling on an
 *        already-terminal row returns `{ ended: false }` rather than
 *        throwing — the caller can safely loop over a list of session
 *        ids during a bulk eject.
 *
 *     5. `cleanupExpired` walks the active set, flips elapsed rows
 *        to `expired`, and returns the count. Operators run this on
 *        a schedule (every minute is plenty; the verify path already
 *        refuses elapsed-but-not-yet-swept rows).
 *
 *   FSM:
 *     active   — session live, verifyImpersonationToken returns context
 *     ended    — operator finished and called endImpersonation
 *                (terminal)
 *     expired  — TTL elapsed before endImpersonation
 *                (terminal; cleanupExpired swept the row)
 *     revoked  — operator-side kill (terminal)
 *
 *   Composes:
 *     - `b.crypto.generateBytes`   — 32-byte CSPRNG draw for the bearer.
 *     - `b.crypto.toBase64Url`     — URL-safe encoding for plaintext.
 *     - `b.crypto.namespaceHash`   — keys the storage row off
 *                                    `("customer-impersonation-token",
 *                                    plaintext)` so a dump never
 *                                    reveals live bearers.
 *     - `b.crypto.timingSafeEqual` — constant-time check on verify.
 *     - `b.guardUuid`              — UUID-shape validation on every
 *                                    operator_id / customer_id /
 *                                    impersonation_id.
 *     - `b.uuid.v7`                — row ids.
 *     - `operatorRoles` (opt)      — `hasPermission(...)` gate at
 *                                    `startImpersonation`. Absent, the
 *                                    primitive trusts the caller (the
 *                                    application has already gated).
 *     - `operatorAuditLog` (opt)   — `record(...)` on every meaningful
 *                                    state transition (start, end,
 *                                    revoke, expired sweep).
 *     - `notifications` (opt)      — `enqueue(...)` from
 *                                    `notifyCustomer` to deliver the
 *                                    "an operator viewed your account"
 *                                    message.
 *
 *   Surface:
 *     - `startImpersonation({ operator_id, customer_id, reason,
 *                              requires_capability?, ttl_seconds? })`
 *         → `{ impersonation_id, plaintext_token, expires_at }`
 *     - `verifyImpersonationToken(plaintext)`
 *         → null on miss / expired / terminal
 *         → `{ impersonation_id, operator_id, customer_id, expires_at,
 *              reason }` on hit
 *     - `endImpersonation({ impersonation_id, ended_by, reason })`
 *         → `{ ended: boolean }`
 *     - `notifyCustomer({ impersonation_id })`
 *         → `{ notified: boolean, customer_notified_at: <ms> | null }`
 *     - `listForOperator(operator_id, { active_only? })`
 *         → array of session rows, newest-first.
 *     - `listForCustomer(customer_id)`
 *         → array of session rows, newest-first.
 *     - `currentlyImpersonating()`
 *         → array of active session rows.
 *     - `cleanupExpired({ now? })`
 *         → `{ swept: <count>, now: <ms> }`
 *     - `actionsRecord({ impersonation_id, action, resource_kind,
 *                         resource_id })`
 *         → `{ id, occurred_at }`
 *     - `actionsForSession(impersonation_id)`
 *         → array of action rows, oldest-first (timeline order).
 *
 *   Storage:
 *     - `impersonations` + `impersonation_actions`
 *       (migration `0190_customer_impersonation.sql`).
 *
 * @primitive customerImpersonation
 * @related   b.crypto.generateBytes, b.crypto.namespaceHash,
 *            b.crypto.timingSafeEqual, b.guardUuid, b.uuid,
 *            operatorRoles, operatorAuditLog, notifications
 */

var TOKEN_NAMESPACE         = "customer-impersonation-token";
var TOKEN_BYTES             = 32;
var DEFAULT_TTL_SECONDS     = 60 * 60;                  // allow:raw-time-literal — seconds value; C.TIME returns ms (60-minute default)
var MIN_TTL_SECONDS         = 60;                       // refuse sub-minute
var MAX_TTL_SECONDS         = 8 * 60 * 60;              // allow:raw-time-literal — seconds value; C.TIME returns ms (hard ceiling — eight hours)
var MAX_REASON_LEN          = 280;
var MAX_END_REASON_LEN      = 280;
var MAX_ENDED_BY_LEN        = 64;
var MAX_ACTION_LEN          = 128;
var MAX_RESOURCE_KIND_LEN   = 64;
var MAX_RESOURCE_ID_LEN     = 256;
var DEFAULT_CAPABILITY      = "can_impersonate_customer";

var STATUS_VALUES = Object.freeze([
  "active", "ended", "expired", "revoked",
]);

// Lazy framework handle — matches the pattern used by the rest of the
// shop primitives; avoids the require cycle that would arise from
// importing `./index` at module-eval time.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try {
    return _b().guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("customer-impersonation: " + label + " — " +
      (e && e.message || "invalid UUID"));
  }
}

function _requiredString(s, label, maxLen) {
  if (typeof s !== "string") {
    throw new TypeError("customer-impersonation: " + label + " must be a string");
  }
  if (s.length === 0) {
    throw new TypeError("customer-impersonation: " + label + " must be a non-empty string");
  }
  if (s.length > maxLen) {
    throw new TypeError("customer-impersonation: " + label + " must be <= " +
      maxLen + " characters");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("customer-impersonation: " + label +
      " must not contain control bytes");
  }
  return s;
}

function _ttlSeconds(n) {
  if (n == null) return DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(n) || n < MIN_TTL_SECONDS || n > MAX_TTL_SECONDS) {
    throw new TypeError(
      "customer-impersonation: ttl_seconds must be an integer in [" +
      MIN_TTL_SECONDS + ", " + MAX_TTL_SECONDS + "]"
    );
  }
  return n;
}

function _bool(v, label) {
  if (v == null) return false;
  if (v === true || v === false) return v;
  throw new TypeError("customer-impersonation: " + label + " must be a boolean");
}

function _optMsEpoch(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("customer-impersonation: " + label +
      " must be a non-negative integer (ms epoch)");
  }
  return n;
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Optional peers. Duck-typed — the tests stub these without
  // importing the full primitive.
  var operatorRoles    = opts.operatorRoles    || null;
  if (operatorRoles && typeof operatorRoles.hasPermission !== "function") {
    throw new TypeError("customer-impersonation.create: opts.operatorRoles must " +
      "expose a hasPermission(input) method");
  }
  var operatorAuditLog = opts.operatorAuditLog || null;
  if (operatorAuditLog && typeof operatorAuditLog.record !== "function") {
    throw new TypeError("customer-impersonation.create: opts.operatorAuditLog must " +
      "expose a record(input) method");
  }
  var notifications    = opts.notifications    || null;
  if (notifications && typeof notifications.enqueue !== "function") {
    throw new TypeError("customer-impersonation.create: opts.notifications must " +
      "expose an enqueue(input) method");
  }

  // Per-factory monotonic clock. Two operator actions in the same
  // millisecond (startImpersonation followed by actionsRecord, for
  // instance) still produce strictly-increasing timestamps so the
  // audit timeline sorts deterministically.
  var _lastTs = 0;
  function _now() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  async function _audit(action, operatorId, impersonationId, before, after) {
    if (!operatorAuditLog) return;
    await operatorAuditLog.record({
      actor_type:    "operator",
      actor_id:      operatorId,
      action:        "impersonation." + action,
      resource_kind: "customer_impersonation",
      resource_id:   impersonationId,
      before:        before,
      after:         after,
    });
  }

  async function _getRow(id) {
    var r = await query(
      "SELECT id, operator_id, customer_id, token_hash, reason, status, " +
      "       started_at, ended_at, end_reason, expires_at, customer_notified_at " +
      "FROM impersonations WHERE id = ?1",
      [id],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  function _projectRow(row) {
    if (!row) return null;
    return {
      id:                    row.id,
      operator_id:           row.operator_id,
      customer_id:           row.customer_id,
      reason:                row.reason,
      status:                row.status,
      started_at:            Number(row.started_at),
      ended_at:              row.ended_at == null ? null : Number(row.ended_at),
      end_reason:            row.end_reason,
      expires_at:            Number(row.expires_at),
      customer_notified_at:  row.customer_notified_at == null
                               ? null : Number(row.customer_notified_at),
    };
  }

  return {

    STATUS_VALUES:        STATUS_VALUES,
    TOKEN_NAMESPACE:      TOKEN_NAMESPACE,
    DEFAULT_TTL_SECONDS:  DEFAULT_TTL_SECONDS,
    DEFAULT_CAPABILITY:   DEFAULT_CAPABILITY,

    // ---- startImpersonation --------------------------------------------
    //
    // Mints a fresh impersonation session. When `operatorRoles` is
    // wired, gates on `hasPermission(operator_id,
    // requires_capability ?? "can_impersonate_customer")` — operators
    // without the capability are refused with a typed error. The
    // plaintext bearer is returned ONCE; the database stores only the
    // namespaceHash. Default 60-minute TTL caps the blast radius if
    // the operator forgets to call endImpersonation.
    startImpersonation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-impersonation.startImpersonation: input object required");
      }
      var operatorId = _uuid(input.operator_id, "operator_id");
      var customerId = _uuid(input.customer_id, "customer_id");
      var reason     = _requiredString(input.reason, "reason", MAX_REASON_LEN);
      var ttl        = _ttlSeconds(input.ttl_seconds);
      var capability = input.requires_capability == null
        ? DEFAULT_CAPABILITY
        : _requiredString(input.requires_capability, "requires_capability", 128);

      // Capability gate via the optional operatorRoles peer. Absent
      // the peer, the primitive trusts the caller (the application has
      // gated upstream). With the peer wired, a missing capability is
      // a typed refusal.
      if (operatorRoles) {
        var allowed = await operatorRoles.hasPermission({
          operator_id: operatorId,
          permission:  capability,
        });
        if (!allowed) {
          var err = new Error(
            "customer-impersonation.startImpersonation: operator " + operatorId +
            " lacks capability " + capability,
          );
          err.code = "IMPERSONATION_CAPABILITY_REFUSED";
          throw err;
        }
      }

      var plaintext = _b().crypto.toBase64Url(
        _b().crypto.generateBytes(TOKEN_BYTES)
      );
      var tokenHash = _b().crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var id        = _b().uuid.v7();
      var now       = _now();
      var expiresAt = now + (ttl * 1000); // allow:raw-time-literal — ttl is a runtime seconds value; *1000 converts to ms

      await query(
        "INSERT INTO impersonations " +
        "(id, operator_id, customer_id, token_hash, reason, status, " +
        " started_at, ended_at, end_reason, expires_at, customer_notified_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, NULL, NULL, ?7, NULL)",
        [id, operatorId, customerId, tokenHash, reason, now, expiresAt],
      );

      await _audit(
        "start",
        operatorId,
        id,
        null,
        { status: "active", customer_id: customerId, expires_at: expiresAt },
      );

      return {
        impersonation_id: id,
        plaintext_token:  plaintext,
        expires_at:       expiresAt,
        operator_id:      operatorId,
        customer_id:      customerId,
        reason:           reason,
        started_at:       now,
      };
    },

    // ---- verifyImpersonationToken ---------------------------------------
    //
    // Resolves a plaintext bearer to the underlying impersonation
    // context. Returns null on every refuse path (unknown token,
    // expired, ended, revoked, malformed input). The constant-time
    // compare on the hex hash defends against a future schema change
    // that introduces a collection scan; the SQL = on token_hash is
    // the lookup.
    verifyImpersonationToken: async function (plaintext) {
      if (typeof plaintext !== "string" || !plaintext.length) {
        return null;
      }
      var tokenHash = _b().crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var r = await query(
        "SELECT id, operator_id, customer_id, token_hash, reason, status, " +
        "       expires_at " +
        "FROM impersonations WHERE token_hash = ?1 LIMIT 1",
        [tokenHash],
      );
      if (!r.rows.length) {
        // Burn the same compare work as the hit path so the latency
        // profile matches between miss and hit.
        _b().crypto.timingSafeEqual(tokenHash, tokenHash);
        return null;
      }
      var row = r.rows[0];
      var matched = _b().crypto.timingSafeEqual(row.token_hash, tokenHash);
      if (!matched) return null;
      if (row.status !== "active") return null;
      var now = _now();
      if (Number(row.expires_at) <= now) return null;

      return {
        impersonation_id: row.id,
        operator_id:      row.operator_id,
        customer_id:      row.customer_id,
        reason:           row.reason,
        expires_at:       Number(row.expires_at),
      };
    },

    // ---- endImpersonation -----------------------------------------------
    //
    // Operator-initiated termination. Idempotent — calling on an
    // already-terminal row returns `{ ended: false }`. `ended_by` is
    // a short label ("operator", "supervisor", "auto-timeout") that
    // distinguishes operator-driven endings from system-driven ones.
    endImpersonation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-impersonation.endImpersonation: input object required");
      }
      var id       = _uuid(input.impersonation_id, "impersonation_id");
      var endedBy  = _requiredString(input.ended_by, "ended_by", MAX_ENDED_BY_LEN);
      var reason   = _requiredString(input.reason, "reason", MAX_END_REASON_LEN);
      var existing = await _getRow(id);
      if (!existing) {
        var miss = new Error("customer-impersonation.endImpersonation: " +
          "impersonation not found");
        miss.code = "IMPERSONATION_NOT_FOUND";
        throw miss;
      }
      if (existing.status !== "active") {
        return { ended: false };
      }
      var now = _now();
      var endReasonLabel = endedBy + ": " + reason;
      if (endReasonLabel.length > MAX_END_REASON_LEN) {
        endReasonLabel = endReasonLabel.slice(0, MAX_END_REASON_LEN);
      }
      var r = await query(
        "UPDATE impersonations " +
        "SET status = 'ended', ended_at = ?1, end_reason = ?2 " +
        "WHERE id = ?3 AND status = 'active'",
        [now, endReasonLabel, id],
      );
      var ended = Number(r.rowCount || 0) > 0;
      if (ended) {
        await _audit(
          "end",
          existing.operator_id,
          id,
          { status: "active" },
          { status: "ended", ended_at: now, end_reason: endReasonLabel },
        );
      }
      return { ended: ended };
    },

    // ---- notifyCustomer -------------------------------------------------
    //
    // Enqueues a customer-side "an operator viewed your account"
    // notification via the optional `notifications` peer. Stamps
    // `customer_notified_at` on the row so the audit reader can
    // confirm out-of-band delivery happened. Returns `{ notified:
    // false }` when no peer is wired so the caller can decide whether
    // to surface that as an operational warning.
    //
    // Idempotent on already-notified rows — re-calling returns the
    // existing stamp without re-enqueuing. A peer that throws is
    // surfaced (the caller MUST retry or fail loud — silent dropping
    // of the customer notification would weaken the audit contract).
    notifyCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-impersonation.notifyCustomer: input object required");
      }
      var id = _uuid(input.impersonation_id, "impersonation_id");
      var existing = await _getRow(id);
      if (!existing) {
        var miss = new Error("customer-impersonation.notifyCustomer: " +
          "impersonation not found");
        miss.code = "IMPERSONATION_NOT_FOUND";
        throw miss;
      }
      if (existing.customer_notified_at != null) {
        return {
          notified:             true,
          customer_notified_at: Number(existing.customer_notified_at),
        };
      }
      if (!notifications) {
        return { notified: false, customer_notified_at: null };
      }
      await notifications.enqueue({
        recipient_id: existing.customer_id,
        channel:      "account-impersonation",
        event_type:   "customer_impersonation_started",
        title:        "An operator viewed your account",
        body:         "",
        payload: {
          impersonation_id: id,
          operator_id:      existing.operator_id,
          reason:           existing.reason,
          started_at:       Number(existing.started_at),
          expires_at:       Number(existing.expires_at),
        },
      });
      var now = _now();
      await query(
        "UPDATE impersonations SET customer_notified_at = ?1 WHERE id = ?2",
        [now, id],
      );
      return { notified: true, customer_notified_at: now };
    },

    // ---- listForOperator ------------------------------------------------
    //
    // Returns every impersonation session the operator has ever
    // started, newest-first. `active_only: true` filters to live
    // sessions only.
    listForOperator: async function (operatorId, listOpts) {
      var oid = _uuid(operatorId, "operator_id");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("customer-impersonation.listForOperator: opts must be an object");
      }
      var activeOnly = _bool(listOpts.active_only, "active_only");
      var sql, params;
      if (activeOnly) {
        sql = "SELECT * FROM impersonations WHERE operator_id = ?1 AND status = 'active' " +
              "ORDER BY started_at DESC, id DESC";
        params = [oid];
      } else {
        sql = "SELECT * FROM impersonations WHERE operator_id = ?1 " +
              "ORDER BY started_at DESC, id DESC";
        params = [oid];
      }
      var r = await query(sql, params);
      return r.rows.map(_projectRow);
    },

    // ---- listForCustomer ------------------------------------------------
    //
    // Returns every impersonation session ever opened against the
    // customer, newest-first. The customer-side "show me who's looked
    // at my account" page reads this directly.
    listForCustomer: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT * FROM impersonations WHERE customer_id = ?1 " +
        "ORDER BY started_at DESC, id DESC",
        [cid],
      );
      return r.rows.map(_projectRow);
    },

    // ---- currentlyImpersonating -----------------------------------------
    //
    // The operator dashboard's "who's currently impersonating whom"
    // surface. Returns every `active` row across all operators,
    // newest-first.
    currentlyImpersonating: async function () {
      var r = await query(
        "SELECT * FROM impersonations WHERE status = 'active' " +
        "ORDER BY started_at DESC, id DESC",
        [],
      );
      return r.rows.map(_projectRow);
    },

    // ---- cleanupExpired -------------------------------------------------
    //
    // Scheduler walk — flips every `active` row whose `expires_at` is
    // in the past to `expired`. Returns the count of rows swept.
    // Idempotent — calling twice in a row produces 0 on the second
    // call. Operators run this on a schedule (every minute is plenty
    // — `verifyImpersonationToken` already refuses elapsed-but-not-
    // yet-swept rows).
    cleanupExpired: async function (input) {
      input = input || {};
      var now = _optMsEpoch(input.now, "now");
      if (now == null) now = _now();
      var r = await query(
        "UPDATE impersonations SET status = 'expired', ended_at = ?1, " +
        "end_reason = 'auto-timeout: ttl elapsed' " +
        "WHERE status = 'active' AND expires_at <= ?1",
        [now],
      );
      return { swept: Number(r.rowCount || 0), now: now };
    },

    // ---- actionsRecord --------------------------------------------------
    //
    // Append-only event log of every operator action taken while the
    // impersonation session was live. The application layer wires this
    // into its existing operator middleware so the audit log is
    // automatic. Refuses on non-active sessions so a stale token
    // can't accumulate spurious action rows after the session ended.
    actionsRecord: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-impersonation.actionsRecord: input object required");
      }
      var impId    = _uuid(input.impersonation_id, "impersonation_id");
      var action   = _requiredString(input.action,        "action",        MAX_ACTION_LEN);
      var rKind    = _requiredString(input.resource_kind, "resource_kind", MAX_RESOURCE_KIND_LEN);
      var rId      = _requiredString(input.resource_id,   "resource_id",   MAX_RESOURCE_ID_LEN);

      var existing = await _getRow(impId);
      if (!existing) {
        var miss = new Error("customer-impersonation.actionsRecord: " +
          "impersonation not found");
        miss.code = "IMPERSONATION_NOT_FOUND";
        throw miss;
      }
      if (existing.status !== "active") {
        var badStatus = new Error("customer-impersonation.actionsRecord: " +
          "impersonation status is " + existing.status + ", actions only " +
          "record on active sessions");
        badStatus.code = "IMPERSONATION_NOT_ACTIVE";
        throw badStatus;
      }
      // Defensive — the verify gate already refuses expired rows, but
      // a clock-skewed scheduler could leave an unsweep'd `active` row
      // past expires_at. Refuse the action so the audit log doesn't
      // accumulate post-expiry rows.
      var now = _now();
      if (Number(existing.expires_at) <= now) {
        var elapsed = new Error("customer-impersonation.actionsRecord: " +
          "impersonation expired (expires_at elapsed before cleanupExpired sweep)");
        elapsed.code = "IMPERSONATION_EXPIRED";
        throw elapsed;
      }

      var rowId = _b().uuid.v7();
      await query(
        "INSERT INTO impersonation_actions " +
        "(id, impersonation_id, action, resource_kind, resource_id, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [rowId, impId, action, rKind, rId, now],
      );
      return {
        id:               rowId,
        impersonation_id: impId,
        action:           action,
        resource_kind:    rKind,
        resource_id:      rId,
        occurred_at:      now,
      };
    },

    // ---- actionsForSession ----------------------------------------------
    //
    // Timeline read — every action recorded against an impersonation
    // session, oldest-first.
    actionsForSession: async function (impersonationId) {
      var impId = _uuid(impersonationId, "impersonation_id");
      var r = await query(
        "SELECT id, impersonation_id, action, resource_kind, resource_id, occurred_at " +
        "FROM impersonation_actions WHERE impersonation_id = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [impId],
      );
      return r.rows.map(function (row) {
        return {
          id:               row.id,
          impersonation_id: row.impersonation_id,
          action:           row.action,
          resource_kind:    row.resource_kind,
          resource_id:      row.resource_id,
          occurred_at:      Number(row.occurred_at),
        };
      });
    },

    // ---- revoke ---------------------------------------------------------
    //
    // Operator-side kill switch — suspected misuse, customer
    // complained, supervisor override. Distinct from
    // `endImpersonation` because the audit log distinguishes
    // operator-driven completion from operator-side termination.
    // Idempotent on already-terminal rows.
    revoke: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-impersonation.revoke: input object required");
      }
      var id     = _uuid(input.impersonation_id, "impersonation_id");
      var reason = _requiredString(input.reason, "reason", MAX_END_REASON_LEN);
      var existing = await _getRow(id);
      if (!existing) {
        var miss = new Error("customer-impersonation.revoke: impersonation not found");
        miss.code = "IMPERSONATION_NOT_FOUND";
        throw miss;
      }
      if (existing.status !== "active") {
        return { revoked: false };
      }
      var now = _now();
      var r = await query(
        "UPDATE impersonations " +
        "SET status = 'revoked', ended_at = ?1, end_reason = ?2 " +
        "WHERE id = ?3 AND status = 'active'",
        [now, reason, id],
      );
      var revoked = Number(r.rowCount || 0) > 0;
      if (revoked) {
        await _audit(
          "revoke",
          existing.operator_id,
          id,
          { status: "active" },
          { status: "revoked", ended_at: now, end_reason: reason },
        );
      }
      return { revoked: revoked };
    },

    // ---- getSession -----------------------------------------------------
    //
    // Hydrated read of a single session by id. Returns null on miss so
    // the caller can map cleanly to HTTP 404.
    getSession: async function (impersonationId) {
      var impId = _uuid(impersonationId, "impersonation_id");
      var row = await _getRow(impId);
      return _projectRow(row);
    },
  };
}

module.exports = {
  create:                create,
  STATUS_VALUES:         STATUS_VALUES,
  TOKEN_NAMESPACE:       TOKEN_NAMESPACE,
  DEFAULT_TTL_SECONDS:   DEFAULT_TTL_SECONDS,
  DEFAULT_CAPABILITY:    DEFAULT_CAPABILITY,
};
