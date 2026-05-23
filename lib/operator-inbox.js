"use strict";
/**
 * @module shop.operatorInbox
 * @title  Operator inbox — per-operator notification feed for system
 *         events
 *
 * @intro
 *   Operators run the storefront through an admin console; the inbox
 *   primitive is the in-console "you have N unread messages" stream
 *   that surfaces system events (a refund attempt failed, a SKU has
 *   crossed its low-stock threshold, a security gate fired, an NPS
 *   response landed in the bottom decile, a vendor's payout queued).
 *
 *   The application enqueues a message keyed to one of two
 *   addressing modes:
 *
 *     - `operator_id` — a single named operator. Used when the event
 *       has an obvious owner (the support agent who issued the refund
 *       gets the refund-failure; the buyer of a vendor's product gets
 *       the vendor's payout settlement notification).
 *     - `role` — a broadcast to every operator carrying that role at
 *       the time of read. Used when the event has no specific owner
 *       (low-stock visible to anyone with `inventory.write`; security
 *       incident visible to anyone with `settings.write`). The
 *       `operatorRoles` peer is the source of truth for role-bearer
 *       membership; this primitive optionally consults it via the
 *       `operatorRoles` injection so `inboxForOperator` can fold in
 *       broadcasts the caller would receive.
 *
 *   Exactly one addressing mode is set per message — the schema
 *   CHECK constraint enforces it.
 *
 *   Severity is a four-level closed enum:
 *
 *     - `info`     — informational; default sort tie-break.
 *     - `warning`  — action recommended but not urgent.
 *     - `urgent`   — action expected this shift.
 *     - `critical` — page the on-call.
 *
 *   The primitive does NOT itself dispatch off-channel notifications
 *   (email / SMS / push). It's the in-console feed only. A composed
 *   `notifications` peer can subscribe to inbox writes if the
 *   operator wants critical-severity rows mirrored to an off-channel
 *   pager.
 *
 *   FSM (per message):
 *
 *     created -> (read_at) -> read
 *     created -> archived
 *     read    -> archived
 *     read    -> (markUnread) -> created   (operator can undo)
 *
 *   `archived_at` is terminal as a visible-inbox concept: archived
 *   rows are excluded from `inboxForOperator` and `unreadCount`. They
 *   remain queryable via `metricsForKind` (so an operator-side audit
 *   that "no critical-severity refund_failure went unaddressed last
 *   week" can land). `cleanupOlderThan` is the disk-pressure
 *   release-valve; rows older than the supplied cutoff are deleted
 *   regardless of read / archived state.
 *
 *   Severity-min filtering:
 *
 *     `inboxForOperator({ severity_min: "warning" })` includes
 *     warning + urgent + critical (anything at or above the supplied
 *     floor). The severity rank is a closed integer ladder so the
 *     comparison is local — no operator-authored severity strings
 *     are accepted.
 *
 *   Composes:
 *     - `b.uuid.v7`           — message row PKs (lexicographic +
 *                               monotonic so two same-millisecond
 *                               enqueues retain the order they were
 *                               issued).
 *     - `b.guardUuid`         — UUID-shape gate on every `operator_id`
 *                               entering the primitive.
 *     - `b.pagination`        — HMAC-tagged tuple cursor for
 *                               `inboxForOperator` (state =
 *                               [created_at, id], forward-only).
 *     - `operatorRoles`       — optional. When wired,
 *                               `inboxForOperator` consults
 *                               `rolesForOperator(operator_id)` and
 *                               folds matching role-broadcast rows
 *                               into the result. Absent, only the
 *                               operator-id-addressed rows surface.
 *
 *   Monotonic clock:
 *     Two enqueues landing in the same millisecond on a fast machine
 *     would otherwise tie on `created_at`, blurring the cursor sort
 *     and making per-millisecond ordering tests racy. The factory's
 *     `_now()` bumps by 1ms on collision so every row carries a
 *     strict-monotonic created_at — the (created_at DESC, id DESC)
 *     sort key is total.
 *
 *   Surface:
 *
 *     - enqueueMessage({ operator_id?, role?, kind, severity, subject,
 *                        body, payload?, source_event_id? })
 *         Insert a row. Exactly one of operator_id / role required;
 *         BOTH or NEITHER refused. Returns the persisted row.
 *
 *     - inboxForOperator({ operator_id, severity_min?, unread_only?,
 *                          include_archived?, limit?, cursor? })
 *         Read the operator's inbox. Includes operator-id-addressed
 *         rows + (when `operatorRoles` is wired) role-broadcast rows
 *         the operator currently carries. `severity_min` floors the
 *         severity rank. `unread_only` filters `read_at IS NULL`.
 *         `include_archived` is opt-in (default excludes archived).
 *         HMAC-tagged cursor over (created_at, id) — forward-only.
 *
 *     - markRead({ id, operator_id })
 *         Mark a single message read. Refuses if the message isn't
 *         addressable to the operator (neither operator-id match
 *         nor role-match via operatorRoles). Idempotent — already-
 *         read is a no-op.
 *
 *     - markUnread({ id, operator_id })
 *         Inverse — clears `read_at`. Same addressability gate as
 *         markRead.
 *
 *     - archiveMessage({ id, operator_id })
 *         Mark archived. Same addressability gate. Idempotent.
 *
 *     - bulkArchive({ operator_id, ids })
 *         Archive a list. Refuses any id the operator can't address.
 *         Returns `{ archived_count }`.
 *
 *     - unreadCount({ operator_id, severity_min? })
 *         Cheap count for the navbar badge. Excludes archived.
 *
 *     - cleanupOlderThan({ now?, age_ms })
 *         Delete rows whose `created_at < (now - age_ms)`. Used to
 *         keep the table bounded — the inbox is a feed, not an
 *         archive of record.
 *
 *     - metricsForKind({ kind, from, to })
 *         Per-(severity) histogram + read-rate + median-time-to-read
 *         for one kind over an [from, to) window. Reads archived
 *         rows too — an operator-side audit ("did we read every
 *         critical refund_failure last week?") needs them. Returns
 *         `{ kind, from, to, total, by_severity, by_state }`.
 *
 *   Storage: `migrations-d1/0175_operator_inbox.sql`.
 *
 * @primitive operatorInbox
 * @related   b.uuid, b.guardUuid, b.pagination, shop.operatorRoles
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var SEVERITIES        = Object.freeze(["info", "warning", "urgent", "critical"]);
var SEVERITY_RANK     = Object.freeze({ info: 0, warning: 1, urgent: 2, critical: 3 });

var ROLE_RE           = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
var KIND_RE           = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

var MAX_SUBJECT_LEN   = 200;
var MAX_BODY_LEN      = 8000;
var MAX_PAYLOAD_BYTES = 16384;
var MAX_SOURCE_LEN    = 200;
var MAX_BULK_IDS      = 200;

var DEFAULT_LIMIT     = 50;
var MAX_LIMIT         = 500;

var CONTROL_BYTE_RE        = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var CONTROL_BYTE_STRICT_RE = /[\x00-\x1f\x7f]/;

var CURSOR_ORDER_KEY = Object.freeze(["created_at", "id"]);

// ---- monotonic clock ----------------------------------------------------
//
// Two enqueues landing in the same millisecond on a fast machine would
// otherwise tie on `created_at`. Tests that enqueue + read in a tight
// loop rely on a strict total order for the (created_at DESC, id DESC)
// cursor sort — bumping by 1ms on collision keeps the sort total
// without an extra tiebreaker column at the schema layer.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _operatorId(s) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("operatorInbox: operator_id — " + (e && e.message || "invalid UUID")); }
}

function _messageId(s) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("operatorInbox: id — " + (e && e.message || "invalid UUID")); }
}

function _role(s, label) {
  if (typeof s !== "string" || !ROLE_RE.test(s)) {
    throw new TypeError("operatorInbox: " + (label || "role") +
                        " must be lowercase alnum / underscore / dash, no leading/trailing separator, 1..64 chars");
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || !KIND_RE.test(s)) {
    throw new TypeError("operatorInbox: kind must be lowercase alnum / underscore / dash, 1..64 chars");
  }
  return s;
}

function _severity(s) {
  if (typeof s !== "string" || SEVERITIES.indexOf(s) < 0) {
    throw new TypeError("operatorInbox: severity must be one of " + SEVERITIES.join(", "));
  }
  return s;
}

function _severityMin(s) {
  if (s == null) return null;
  if (typeof s !== "string" || SEVERITIES.indexOf(s) < 0) {
    throw new TypeError("operatorInbox: severity_min must be one of " + SEVERITIES.join(", "));
  }
  return s;
}

function _subject(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_SUBJECT_LEN) {
    throw new TypeError("operatorInbox: subject must be a non-empty string <= " + MAX_SUBJECT_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("operatorInbox: subject must not contain control bytes");
  }
  return s;
}

function _body(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_BODY_LEN) {
    throw new TypeError("operatorInbox: body must be a non-empty string <= " + MAX_BODY_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("operatorInbox: body must not contain control bytes");
  }
  return s;
}

function _payload(p) {
  if (p == null) return {};
  if (typeof p !== "object" || Array.isArray(p)) {
    throw new TypeError("operatorInbox: payload must be a plain object");
  }
  var json;
  try { json = JSON.stringify(p); }
  catch (_e) { throw new TypeError("operatorInbox: payload must be JSON-serializable"); }
  if (json.length > MAX_PAYLOAD_BYTES) {
    throw new TypeError("operatorInbox: payload JSON must be <= " + MAX_PAYLOAD_BYTES + " bytes");
  }
  return JSON.parse(json);
}

function _sourceEventId(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string" || s.length > MAX_SOURCE_LEN) {
    throw new TypeError("operatorInbox: source_event_id must be a string <= " + MAX_SOURCE_LEN + " chars");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s)) {
    throw new TypeError("operatorInbox: source_event_id must not contain control bytes");
  }
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("operatorInbox: limit must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _epochOpt(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("operatorInbox: " + label + " must be a non-negative integer (ms epoch) or null");
  }
  return n;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("operatorInbox: " + label + " must be a positive integer");
  }
  return n;
}

function _bool(v, label, def) {
  if (v == null) return def;
  if (typeof v !== "boolean") {
    throw new TypeError("operatorInbox: " + label + " must be a boolean");
  }
  return v;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Closed allow-list of role slugs the application is willing to
  // address. Enqueueing a role-broadcast for an unknown role would
  // create a write that no operator ever reads — refuse at the
  // boundary instead of producing the silent black hole.
  var operatorRoles = null;
  if (opts.operatorRoles != null) {
    if (Array.isArray(opts.operatorRoles)) {
      var seen = Object.create(null);
      var canon = [];
      for (var i = 0; i < opts.operatorRoles.length; i += 1) {
        var r = _role(opts.operatorRoles[i], "operatorRoles[" + i + "]");
        if (seen[r]) {
          throw new TypeError("operatorInbox.create: operatorRoles[" + i + "] duplicates a prior entry");
        }
        seen[r] = true;
        canon.push(r);
      }
      operatorRoles = canon;
    } else if (typeof opts.operatorRoles === "object"
               && typeof opts.operatorRoles.rolesForOperator === "function") {
      // Live operatorRoles peer — used in production wiring where the
      // role membership of a given operator is dynamic.
      operatorRoles = opts.operatorRoles;
    } else {
      throw new TypeError("operatorInbox.create: operatorRoles must be a string[] of allowed roles" +
                          " OR an object exposing rolesForOperator(operator_id)");
    }
  }

  // HMAC-tagged cursor secret. Production wiring MUST pass an
  // operator-managed secret; the dev fallback is only safe locally
  // (a forged cursor reveals nothing the operator's own admin
  // console doesn't already expose to them).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("operatorInbox.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "operator-inbox-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("operatorInbox." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = _b().pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(CURSOR_ORDER_KEY)) {
        throw new TypeError("operatorInbox." + label + ": cursor orderKey mismatch");
      }
      if (!Array.isArray(state.vals) || state.vals.length !== 2) {
        throw new TypeError("operatorInbox." + label + ": cursor vals shape mismatch");
      }
      var createdAt = state.vals[0];
      var rowId     = state.vals[1];
      if (!Number.isInteger(createdAt) || createdAt < 0) {
        throw new TypeError("operatorInbox." + label + ": cursor created_at must be a non-negative integer");
      }
      if (typeof rowId !== "string" || !rowId.length) {
        throw new TypeError("operatorInbox." + label + ": cursor id must be a non-empty string");
      }
      return { created_at: createdAt, id: rowId };
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("operatorInbox." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit) {
    if (rows.length < limit) return null;
    var last = rows[rows.length - 1];
    return _b().pagination.encodeCursor({
      orderKey: CURSOR_ORDER_KEY,
      vals:     [last.created_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  // Resolve the operator's currently-active roles. Two wiring modes:
  //   - opts.operatorRoles as a string[] of allowed-roles only —
  //     the application has no live membership; role-broadcasts are
  //     enqueueable but `inboxForOperator` returns operator-id-only
  //     until the peer is wired.
  //   - opts.operatorRoles as a peer exposing rolesForOperator —
  //     live membership; role-broadcast rows fold in.
  async function _rolesForOperator(operatorId) {
    if (operatorRoles == null) return [];
    if (Array.isArray(operatorRoles)) return [];
    var rows = await operatorRoles.rolesForOperator(operatorId);
    if (!Array.isArray(rows)) return [];
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var row  = rows[i];
      var slug = (row && typeof row === "object") ? row.role_slug : row;
      if (typeof slug !== "string" || !ROLE_RE.test(slug)) continue;
      if (seen[slug]) continue;
      seen[slug] = true;
      out.push(slug);
    }
    return out;
  }

  function _isAllowedRole(slug) {
    if (operatorRoles == null) return true;   // no allow-list configured
    if (Array.isArray(operatorRoles))     return operatorRoles.indexOf(slug) >= 0;
    return true;   // live peer handles its own gating at enqueue time
  }

  function _decodeRow(row) {
    if (!row) return null;
    var payload;
    try { payload = JSON.parse(row.payload_json); }
    catch (_e) { payload = {}; }
    return {
      id:               row.id,
      operator_id:      row.operator_id,
      role:             row.role,
      kind:             row.kind,
      severity:         row.severity,
      subject:          row.subject,
      body:             row.body,
      payload:          payload,
      source_event_id:  row.source_event_id,
      read_at:          row.read_at     != null ? Number(row.read_at)     : null,
      archived_at:      row.archived_at != null ? Number(row.archived_at) : null,
      created_at:       Number(row.created_at),
    };
  }

  // ---- enqueueMessage ---------------------------------------------------

  async function enqueueMessage(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.enqueueMessage: input object required");
    }
    var hasOperator = input.operator_id != null;
    var hasRole     = input.role != null;
    if (hasOperator === hasRole) {
      throw new TypeError("operatorInbox.enqueueMessage: exactly one of operator_id / role is required");
    }
    var operatorId = hasOperator ? _operatorId(input.operator_id) : null;
    var role       = hasRole     ? _role(input.role, "role")      : null;
    if (role && !_isAllowedRole(role)) {
      throw new TypeError("operatorInbox.enqueueMessage: role " + JSON.stringify(role) +
                          " is not in the configured operatorRoles allow-list");
    }
    var kind          = _kind(input.kind);
    var severity      = _severity(input.severity);
    var subject       = _subject(input.subject);
    var body          = _body(input.body);
    var payload       = _payload(input.payload);
    var sourceEventId = _sourceEventId(input.source_event_id);

    var id = _b().uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO operator_inbox_messages " +
      "(id, operator_id, role, kind, severity, subject, body, payload_json, " +
      " source_event_id, read_at, archived_at, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10)",
      [id, operatorId, role, kind, severity, subject, body,
       JSON.stringify(payload), sourceEventId, ts],
    );
    var r = await query("SELECT * FROM operator_inbox_messages WHERE id = ?1", [id]);
    return _decodeRow(r.rows[0]);
  }

  // ---- inboxForOperator -------------------------------------------------

  async function inboxForOperator(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.inboxForOperator: input object required");
    }
    var operatorId       = _operatorId(input.operator_id);
    var severityMin      = _severityMin(input.severity_min);
    var unreadOnly       = _bool(input.unread_only,       "unread_only",       false);
    var includeArchived  = _bool(input.include_archived,  "include_archived",  false);
    var limit            = _limit(input.limit);
    var cursorState      = _decodeCursor(input.cursor, "inboxForOperator");

    var roles = await _rolesForOperator(operatorId);

    // Build WHERE clauses dynamically. Role placeholders are inlined
    // as `?N` parameters (never string-concatenated values) so the
    // SQL is parameter-safe regardless of the role allow-list shape.
    var params = [];
    var idx    = 1;
    var pushP  = function (v) { params.push(v); var k = idx; idx += 1; return "?" + k; };

    var opPlace = pushP(operatorId);

    var addressClauses = ["operator_id = " + opPlace];
    if (roles.length > 0) {
      var placeholders = [];
      for (var ri = 0; ri < roles.length; ri += 1) placeholders.push(pushP(roles[ri]));
      addressClauses.push("role IN (" + placeholders.join(", ") + ")");
    }

    var where = "(" + addressClauses.join(" OR ") + ")";

    if (!includeArchived) where += " AND archived_at IS NULL";
    if (unreadOnly)       where += " AND read_at IS NULL";

    if (severityMin) {
      var minRank = SEVERITY_RANK[severityMin];
      var allowed = [];
      for (var si = 0; si < SEVERITIES.length; si += 1) {
        if (SEVERITY_RANK[SEVERITIES[si]] >= minRank) {
          allowed.push(pushP(SEVERITIES[si]));
        }
      }
      where += " AND severity IN (" + allowed.join(", ") + ")";
    }

    if (cursorState) {
      // Forward cursor over (created_at DESC, id DESC). Predicate:
      //   created_at <  cursor.created_at
      //     OR (created_at = cursor.created_at AND id < cursor.id)
      var caP = pushP(cursorState.created_at);
      var idP = pushP(cursorState.id);
      where  += " AND (created_at < " + caP +
                " OR (created_at = " + caP + " AND id < " + idP + "))";
    }

    var limitPlace = pushP(limit);

    var sql = "SELECT * FROM operator_inbox_messages WHERE " + where +
              " ORDER BY created_at DESC, id DESC LIMIT " + limitPlace;
    var r = await query(sql, params);
    var rows = [];
    for (var ki = 0; ki < r.rows.length; ki += 1) rows.push(_decodeRow(r.rows[ki]));
    var nextCursor = rows.length === limit
      ? _b().pagination.encodeCursor({
          orderKey: CURSOR_ORDER_KEY,
          vals:     [rows[rows.length - 1].created_at, rows[rows.length - 1].id],
          forward:  true,
        }, cursorSecret)
      : null;
    return { rows: rows, next_cursor: nextCursor };
  }
  // Mark the unused helper as used so eslint stays quiet. `_encodeNext`
  // is the symmetric encoder kept for parity with knowledge-base —
  // the inline version above is identical.
  void _encodeNext;

  // ---- addressability gate ----------------------------------------------
  //
  // A message is addressable to operator O iff either:
  //   - row.operator_id === O, OR
  //   - row.role !== null AND O currently carries role row.role.
  //
  // markRead / markUnread / archiveMessage all gate on this so an
  // operator can't mutate another operator's id-addressed inbox row.
  async function _addressableRow(messageId, operatorId, roles) {
    var r = await query("SELECT * FROM operator_inbox_messages WHERE id = ?1", [messageId]);
    if (!r.rows.length) return { row: null, reason: "not_found" };
    var row = r.rows[0];
    if (row.operator_id != null && row.operator_id === operatorId) return { row: row, reason: null };
    if (row.role != null) {
      for (var i = 0; i < roles.length; i += 1) {
        if (roles[i] === row.role) return { row: row, reason: null };
      }
    }
    return { row: row, reason: "not_addressable" };
  }

  // ---- markRead ---------------------------------------------------------

  async function markRead(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.markRead: input object required");
    }
    var id         = _messageId(input.id);
    var operatorId = _operatorId(input.operator_id);
    var roles      = await _rolesForOperator(operatorId);

    var gated = await _addressableRow(id, operatorId, roles);
    if (gated.reason === "not_found") {
      var miss = new Error("operatorInbox.markRead: message not found");
      miss.code = "INBOX_MESSAGE_NOT_FOUND";
      throw miss;
    }
    if (gated.reason === "not_addressable") {
      var nope = new Error("operatorInbox.markRead: message not addressable to this operator");
      nope.code = "INBOX_MESSAGE_NOT_ADDRESSABLE";
      throw nope;
    }
    if (gated.row.read_at != null) {
      // Idempotent — already read. Decode + return the current row.
      return _decodeRow(gated.row);
    }
    var ts = _now();
    await query(
      "UPDATE operator_inbox_messages SET read_at = ?1 WHERE id = ?2 AND read_at IS NULL",
      [ts, id],
    );
    var fresh = await query("SELECT * FROM operator_inbox_messages WHERE id = ?1", [id]);
    return _decodeRow(fresh.rows[0]);
  }

  // ---- markUnread -------------------------------------------------------

  async function markUnread(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.markUnread: input object required");
    }
    var id         = _messageId(input.id);
    var operatorId = _operatorId(input.operator_id);
    var roles      = await _rolesForOperator(operatorId);

    var gated = await _addressableRow(id, operatorId, roles);
    if (gated.reason === "not_found") {
      var miss = new Error("operatorInbox.markUnread: message not found");
      miss.code = "INBOX_MESSAGE_NOT_FOUND";
      throw miss;
    }
    if (gated.reason === "not_addressable") {
      var nope = new Error("operatorInbox.markUnread: message not addressable to this operator");
      nope.code = "INBOX_MESSAGE_NOT_ADDRESSABLE";
      throw nope;
    }
    if (gated.row.read_at == null) return _decodeRow(gated.row);   // already unread
    await query(
      "UPDATE operator_inbox_messages SET read_at = NULL WHERE id = ?1",
      [id],
    );
    var fresh = await query("SELECT * FROM operator_inbox_messages WHERE id = ?1", [id]);
    return _decodeRow(fresh.rows[0]);
  }

  // ---- archiveMessage ---------------------------------------------------

  async function archiveMessage(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.archiveMessage: input object required");
    }
    var id         = _messageId(input.id);
    var operatorId = _operatorId(input.operator_id);
    var roles      = await _rolesForOperator(operatorId);

    var gated = await _addressableRow(id, operatorId, roles);
    if (gated.reason === "not_found") {
      var miss = new Error("operatorInbox.archiveMessage: message not found");
      miss.code = "INBOX_MESSAGE_NOT_FOUND";
      throw miss;
    }
    if (gated.reason === "not_addressable") {
      var nope = new Error("operatorInbox.archiveMessage: message not addressable to this operator");
      nope.code = "INBOX_MESSAGE_NOT_ADDRESSABLE";
      throw nope;
    }
    if (gated.row.archived_at != null) return _decodeRow(gated.row);   // idempotent
    var ts = _now();
    await query(
      "UPDATE operator_inbox_messages SET archived_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
      [ts, id],
    );
    var fresh = await query("SELECT * FROM operator_inbox_messages WHERE id = ?1", [id]);
    return _decodeRow(fresh.rows[0]);
  }

  // ---- bulkArchive ------------------------------------------------------

  async function bulkArchive(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.bulkArchive: input object required");
    }
    var operatorId = _operatorId(input.operator_id);
    if (!Array.isArray(input.ids) || input.ids.length === 0) {
      throw new TypeError("operatorInbox.bulkArchive: ids must be a non-empty array");
    }
    if (input.ids.length > MAX_BULK_IDS) {
      throw new TypeError("operatorInbox.bulkArchive: ids must contain <= " + MAX_BULK_IDS + " entries");
    }
    var ids = [];
    var seen = Object.create(null);
    for (var i = 0; i < input.ids.length; i += 1) {
      var id = _messageId(input.ids[i]);
      if (seen[id]) {
        throw new TypeError("operatorInbox.bulkArchive: ids[" + i + "] duplicates a prior entry");
      }
      seen[id] = true;
      ids.push(id);
    }

    var roles = await _rolesForOperator(operatorId);

    // Pre-flight every id — if any is unaddressable, refuse the
    // whole batch so the caller can re-try without a partial-write
    // surprise.
    for (var k = 0; k < ids.length; k += 1) {
      var gated = await _addressableRow(ids[k], operatorId, roles);
      if (gated.reason === "not_found") {
        var miss = new Error("operatorInbox.bulkArchive: ids[" + k + "] not found");
        miss.code = "INBOX_MESSAGE_NOT_FOUND";
        throw miss;
      }
      if (gated.reason === "not_addressable") {
        var nope = new Error("operatorInbox.bulkArchive: ids[" + k + "] not addressable to this operator");
        nope.code = "INBOX_MESSAGE_NOT_ADDRESSABLE";
        throw nope;
      }
    }

    var ts = _now();
    var archived = 0;
    for (var m = 0; m < ids.length; m += 1) {
      var u = await query(
        "UPDATE operator_inbox_messages SET archived_at = ?1 " +
        "WHERE id = ?2 AND archived_at IS NULL",
        [ts, ids[m]],
      );
      archived += Number(u.rowCount || 0);
    }
    return { archived_count: archived };
  }

  // ---- unreadCount ------------------------------------------------------

  async function unreadCount(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.unreadCount: input object required");
    }
    var operatorId  = _operatorId(input.operator_id);
    var severityMin = _severityMin(input.severity_min);
    var roles       = await _rolesForOperator(operatorId);

    var params = [];
    var idx    = 1;
    var pushP  = function (v) { params.push(v); var k = idx; idx += 1; return "?" + k; };
    var opPlace = pushP(operatorId);

    var addressClauses = ["operator_id = " + opPlace];
    if (roles.length > 0) {
      var placeholders = [];
      for (var ri = 0; ri < roles.length; ri += 1) placeholders.push(pushP(roles[ri]));
      addressClauses.push("role IN (" + placeholders.join(", ") + ")");
    }
    var where = "(" + addressClauses.join(" OR ") +
                ") AND read_at IS NULL AND archived_at IS NULL";

    if (severityMin) {
      var minRank = SEVERITY_RANK[severityMin];
      var allowed = [];
      for (var si = 0; si < SEVERITIES.length; si += 1) {
        if (SEVERITY_RANK[SEVERITIES[si]] >= minRank) {
          allowed.push(pushP(SEVERITIES[si]));
        }
      }
      where += " AND severity IN (" + allowed.join(", ") + ")";
    }

    var sql = "SELECT COUNT(*) AS c FROM operator_inbox_messages WHERE " + where;
    var r = await query(sql, params);
    var row = r.rows[0] || {};
    return Number(row.c || row.COUNT || 0);
  }

  // ---- cleanupOlderThan -------------------------------------------------

  async function cleanupOlderThan(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.cleanupOlderThan: input object required");
    }
    var ageMs = _positiveInt(input.age_ms, "age_ms");
    var now;
    if (input.now != null) {
      now = _epochOpt(input.now, "now");
    } else {
      now = _now();
    }
    var cutoff = now - ageMs;
    var r = await query(
      "DELETE FROM operator_inbox_messages WHERE created_at < ?1",
      [cutoff],
    );
    return { deleted_count: Number(r.rowCount || 0), cutoff: cutoff };
  }

  // ---- metricsForKind ---------------------------------------------------

  async function metricsForKind(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorInbox.metricsForKind: input object required");
    }
    var kind = _kind(input.kind);
    var from = _epochOpt(input.from, "from");
    var to   = _epochOpt(input.to,   "to");
    if (from != null && to != null && from > to) {
      throw new TypeError("operatorInbox.metricsForKind: from must be <= to");
    }

    var sql = "SELECT severity, read_at, archived_at, created_at FROM operator_inbox_messages WHERE kind = ?1";
    var params = [kind];
    var idx = 2;
    if (from != null) { sql += " AND created_at >= ?" + idx; params.push(from); idx += 1; }
    if (to   != null) { sql += " AND created_at <  ?" + idx; params.push(to);   idx += 1; }

    var r = await query(sql, params);

    var bySeverity = { info: 0, warning: 0, urgent: 0, critical: 0 };
    var byState    = { unread: 0, read: 0, archived: 0 };
    var readLatencies = [];

    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      if (bySeverity[row.severity] != null) bySeverity[row.severity] += 1;
      if (row.archived_at != null) {
        byState.archived += 1;
      } else if (row.read_at != null) {
        byState.read += 1;
        readLatencies.push(Number(row.read_at) - Number(row.created_at));
      } else {
        byState.unread += 1;
      }
    }

    var medianReadLatencyMs = null;
    if (readLatencies.length > 0) {
      readLatencies.sort(function (a, b) { return a - b; });
      var mid = readLatencies.length >> 1;
      medianReadLatencyMs = readLatencies.length % 2 === 1
        ? readLatencies[mid]
        : Math.round((readLatencies[mid - 1] + readLatencies[mid]) / 2);
    }

    return {
      kind:                    kind,
      from:                    from,
      to:                      to,
      total:                   r.rows.length,
      by_severity:             bySeverity,
      by_state:                byState,
      median_read_latency_ms:  medianReadLatencyMs,
    };
  }

  return {
    SEVERITIES:        SEVERITIES.slice(),
    SEVERITY_RANK:     Object.assign({}, SEVERITY_RANK),
    MAX_SUBJECT_LEN:   MAX_SUBJECT_LEN,
    MAX_BODY_LEN:      MAX_BODY_LEN,
    MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
    DEFAULT_LIMIT:     DEFAULT_LIMIT,
    MAX_LIMIT:         MAX_LIMIT,
    MAX_BULK_IDS:      MAX_BULK_IDS,

    enqueueMessage:    enqueueMessage,
    inboxForOperator:  inboxForOperator,
    markRead:          markRead,
    markUnread:        markUnread,
    archiveMessage:    archiveMessage,
    bulkArchive:       bulkArchive,
    unreadCount:       unreadCount,
    cleanupOlderThan:  cleanupOlderThan,
    metricsForKind:    metricsForKind,
  };
}

module.exports = {
  create:            create,
  SEVERITIES:        SEVERITIES,
  SEVERITY_RANK:     SEVERITY_RANK,
  MAX_SUBJECT_LEN:   MAX_SUBJECT_LEN,
  MAX_BODY_LEN:      MAX_BODY_LEN,
  MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
  DEFAULT_LIMIT:     DEFAULT_LIMIT,
  MAX_LIMIT:         MAX_LIMIT,
  MAX_BULK_IDS:      MAX_BULK_IDS,
};
