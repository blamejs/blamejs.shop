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
 *        "customers.impersonate")` — operators without the
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
 *     - `listForCustomer(customer_id, { limit?, offset? })`
 *         → the customer's most recent sessions, newest-first. BOUNDED:
 *           20 by default, 200 at most. The storefront renders this on
 *           every account page load and the rows are never pruned, so an
 *           unbounded read would make a customer's own dashboard slower
 *           for the rest of the account's life. Nothing becomes unreadable:
 *           `offset` walks the older pages, so a customer or a regulator
 *           asking for the whole history can still get it.
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

// How much of a customer's access history their own account page shows by
// default, and the ceiling a caller may ask for. Bounded because the rows are
// an audit trail that is never pruned: an unbounded read would make a
// customer's dashboard slower every time support helped them.
var DEFAULT_CUSTOMER_HISTORY = 20;
var MAX_CUSTOMER_HISTORY     = 200;
var MIN_TTL_SECONDS         = 60;                       // refuse sub-minute
var MAX_TTL_SECONDS         = 8 * 60 * 60;              // allow:raw-time-literal — seconds value; C.TIME returns ms (hard ceiling — eight hours)
var MAX_REASON_LEN          = 280;
var MAX_END_REASON_LEN      = 280;
var MAX_ENDED_BY_LEN        = 64;
var MAX_ACTION_LEN          = 128;
var MAX_RESOURCE_KIND_LEN   = 64;
var MAX_RESOURCE_ID_LEN     = 256;
var DEFAULT_CAPABILITY      = "customers.impersonate";

var STATUS_VALUES = Object.freeze([
  "active", "ended", "expired", "revoked",
]);

var b = require("./vendor/blamejs");

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("customer-impersonation: " + label + " — " +
      (e && e.message || "invalid UUID"));
  }
}

// The admin console has two kinds of operator identity: a staff account, whose
// id is a v7 UUID, and the bootstrap / break-glass credential, whose id is the
// reserved literal below. Both are real operators and both must be recordable
// here — a store running the single-credential console (the common deploy) has
// no UUID to offer, and refusing it would make the feature unreachable exactly
// where the audit trail matters most.
//
// Only this one literal is admitted; anything else still has to be a UUID, so
// the column cannot fill up with free-form operator labels. It matches the id
// the rest of the console records against the same action, which keeps an
// impersonation row joinable to its audit entries.
var BOOTSTRAP_OPERATOR_ID = "owner";

function _operatorId(s, label) {
  if (s === BOOTSTRAP_OPERATOR_ID) return s;
  return _uuid(s, label);
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
    query = function (sql, params) { return b.externalDb.query(sql, params); };
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
    // requires_capability ?? "customers.impersonate")` — operators
    // without the capability are refused with a typed error. The
    // plaintext bearer is returned ONCE; the database stores only the
    // namespaceHash. Default 60-minute TTL caps the blast radius if
    // the operator forgets to call endImpersonation.
    startImpersonation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-impersonation.startImpersonation: input object required");
      }
      var operatorId = _operatorId(input.operator_id, "operator_id");
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

      var plaintext = b.crypto.toBase64Url(
        b.crypto.generateBytes(TOKEN_BYTES)
      );
      var tokenHash = b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var id        = b.uuid.v7();
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
      var tokenHash = b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var r = await query(
        "SELECT id, operator_id, customer_id, token_hash, reason, status, " +
        "       expires_at " +
        "FROM impersonations WHERE token_hash = ?1 LIMIT 1",
        [tokenHash],
      );
      if (!r.rows.length) {
        // Burn the same compare work as the hit path so the latency
        // profile matches between miss and hit.
        b.crypto.timingSafeEqual(tokenHash, tokenHash);
        return null;
      }
      var row = r.rows[0];
      var matched = b.crypto.timingSafeEqual(row.token_hash, tokenHash);
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

      // Enqueue FIRST, then record the confirmation stamp — so
      // `customer_notified_at` only ever means "the notice was
      // successfully enqueued", never "claimed but the enqueue may have
      // failed". A claim-before-enqueue stamp let a concurrent caller
      // observe the provisional stamp and report `notified: true` while
      // the winner's enqueue was still pending (and might then throw and
      // roll the stamp back), silently dropping the privacy notice.
      // Recording the stamp only on enqueue success closes that. A
      // concurrent caller that also slipped past the null-check above may
      // enqueue a second time; a duplicate "an operator viewed your
      // account" notice is benign and strictly preferable to missing it,
      // and the audit stamp still resolves to a single value.
      var now = _now();
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

      // Stamp the confirmation idempotently — the first writer to land
      // wins (WHERE customer_notified_at IS NULL); a concurrent second
      // caller's UPDATE matches zero rows and returns the already-
      // recorded stamp. An enqueue throw above propagates before this,
      // leaving the row un-stamped so a retry re-attempts delivery.
      await query(
        "UPDATE impersonations SET customer_notified_at = ?1 " +
        "WHERE id = ?2 AND customer_notified_at IS NULL",
        [now, id],
      );
      var stampedRow = await _getRow(id);
      var stampedAt  = stampedRow && stampedRow.customer_notified_at != null
        ? Number(stampedRow.customer_notified_at) : now;
      return { notified: true, customer_notified_at: stampedAt };
    },

    // ---- listForOperator ------------------------------------------------
    //
    // Returns every impersonation session the operator has ever
    // started, newest-first. `active_only: true` filters to live
    // sessions only.
    listForOperator: async function (operatorId, listOpts) {
      var oid = _operatorId(operatorId, "operator_id");
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
    // `limit` is bounded and defaulted because the storefront renders this on
    // every /account load. These rows are an audit trail and are never
    // deleted, so an unbounded read would grow the query cost and the page
    // weight of a customer's own dashboard for the rest of the account's life
    // — worst for exactly the customers support has helped most often.
    listForCustomer: async function (customerId, listOpts) {
      var cid = _uuid(customerId, "customer_id");
      var opts = listOpts || {};
      var limit = opts.limit == null ? DEFAULT_CUSTOMER_HISTORY : opts.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 ||
          limit > MAX_CUSTOMER_HISTORY) {
        throw new TypeError("customer-impersonation.listForCustomer: limit must be an integer in [1, " +
          MAX_CUSTOMER_HISTORY + "]");
      }
      // Offset paging, so capping the page does not put older rows out of
      // reach. These are audit records: a bounded default protects the
      // account page from growing heavier with every support visit, but
      // nothing may become unreadable — a customer or a regulator asking for
      // the whole history has to be able to walk it.
      var offset = opts.offset == null ? 0 : opts.offset;
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
        throw new TypeError("customer-impersonation.listForCustomer: offset must be a non-negative integer");
      }
      var r = await query(
        "SELECT * FROM impersonations WHERE customer_id = ?1 " +
        "ORDER BY started_at DESC, id DESC LIMIT ?2 OFFSET ?3",
        [cid, limit, offset],
      );
      return r.rows.map(_projectRow);
    },

    // ---- currentlyImpersonating -----------------------------------------
    //
    // The operator dashboard's "who's currently impersonating whom"
    // surface. Returns every `active` row across all operators,
    // newest-first.
    // Filters on the CLOCK as well as the status column.
    //
    // Authority expires by timestamp — `verifyImpersonationToken` and the
    // per-request liveness read both refuse an elapsed row immediately — while
    // the `status` column only catches up when `cleanupExpired` next runs. A
    // query on status alone therefore reports sessions as live in the window
    // between those two, and longer if the sweep is delayed or was never
    // scheduled. On an oversight screen that is the wrong direction to be
    // wrong in: it shows a supervisor people inside accounts who are not,
    // which is the fastest way to teach them the screen is noise.
    currentlyImpersonating: async function (listOpts) {
      var now = (listOpts && listOpts.now != null) ? listOpts.now : _now();
      var r = await query(
        "SELECT * FROM impersonations WHERE status = 'active' AND expires_at > ?1 " +
        "ORDER BY started_at DESC, id DESC",
        [now],
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

      var rowId = b.uuid.v7();
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
    // ---- consumeToken -----------------------------------------------------
    //
    // Spend the handoff bearer WITHOUT ending the session.
    //
    // `startImpersonation` mints a single plaintext token and the operator
    // follows it once, out of the console and into the storefront. Verifying
    // it is a read, though, so until the token stops matching, that URL keeps
    // working: it sits in browser history, in a chat message if it was pasted,
    // in a proxy log — and anyone holding it can mint their own cookie for
    // that customer for the rest of the hour. The handoff is meant to be
    // one-time; this is what makes it so.
    //
    // Rotating the hash to a fresh random value is what spends it. The row's
    // authority now lives entirely in the cookie the redemption sealed, which
    // is bound to the operator's browser; the session stays `active` and
    // `end` / `revoke` / the sweep are unaffected. Rotating (rather than
    // nulling) also keeps the NOT NULL UNIQUE column honest.
    //
    // Takes the PLAINTEXT the caller was presented, and spends only that one.
    //
    // The match on the current hash is what makes this single-use under
    // concurrency. Verification is a read, so two requests carrying the same
    // link can both pass it before either writes; if the update only keyed on
    // the row id they would both succeed and both mint a cookie, which is the
    // guarantee this exists to provide, broken. Conditioning the write on the
    // hash it verified means exactly one request can win — the second finds
    // the hash already rotated and gets `consumed: false`.
    //
    // Deliberately NOT idempotent: a caller that cannot claim the token must
    // not be handed a session.
    consumeToken: async function (impersonationId, plaintext) {
      var impId = _uuid(impersonationId, "impersonation_id");
      if (typeof plaintext !== "string" || !plaintext.length) {
        throw new TypeError("customer-impersonation.consumeToken: plaintext token required");
      }
      var presented = b.crypto.namespaceHash(TOKEN_NAMESPACE, plaintext);
      var spent = b.crypto.namespaceHash(
        TOKEN_NAMESPACE, "spent:" + impId + ":" + b.crypto.toBase64Url(b.crypto.generateBytes(32)));
      var r = await query(
        "UPDATE impersonations SET token_hash = ?1 " +
        "WHERE id = ?2 AND status = 'active' AND token_hash = ?3",
        [spent, impId, presented],
      );
      return { consumed: r.rowCount === 1 };
    },

    revoke: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-impersonation.revoke: input object required");
      }
      var id     = _uuid(input.impersonation_id, "impersonation_id");
      var reason = _requiredString(input.reason, "reason", MAX_END_REASON_LEN);
      // Optional so an existing caller keeps working; when present it is the
      // operator performing the revocation, and it is what the audit row
      // records as the actor.
      var revokedBy = input.revoked_by == null
        ? null
        : _operatorId(input.revoked_by, "revoked_by");
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
        // The actor is whoever DID the revoking, which is usually not the
        // operator being removed. Attributing it to `existing.operator_id`
        // wrote an audit row saying they ended their own session — on the one
        // feature whose entire justification is an accurate record of who did
        // what to whose account, that is a falsified line. `revoked_by` falls
        // back to the session's own operator so a self-revoke still reads
        // correctly and an older caller keeps working.
        await _audit(
          "revoke",
          revokedBy || existing.operator_id,
          id,
          { status: "active" },
          {
            status: "revoked", ended_at: now, end_reason: reason,
            revoked_by: revokedBy || existing.operator_id,
            // Named explicitly so an auditor reading the row can tell a
            // supervisor's intervention from an operator closing their own.
            self_revoked: !revokedBy || revokedBy === existing.operator_id,
          },
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
