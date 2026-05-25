"use strict";
/**
 * @module shop.liveChat
 * @title  Live chat — real-time customer-service queueing
 *
 * @intro
 *   Synchronous storefront customer-service surface. A visitor opens
 *   the chat widget; this primitive enqueues the session; an operator
 *   picks it up; messages flow back and forth until either party
 *   closes the session or the reaper marks it abandoned.
 *
 *   Distinct from `supportTickets` — that primitive is for
 *   asynchronous correspondence with SLA timers measured in hours or
 *   days. This one is for the synchronous chat window: pickup
 *   measured in seconds, transcript bounded by one sitting.
 *
 *   Six-state FSM (mirrors the CHECK enum in the migration):
 *
 *     openSession
 *       (no row) -> queued
 *       Stamps the visitor session hash, the optional customer_id /
 *       email hash, the source page, and `opened_at`. Seeds the
 *       transcript with the visitor's initial_message when supplied.
 *
 *     enqueueSession(session_id)
 *       queued -> queued (no-op when already queued; refuses
 *       otherwise). Surfaces a system message recording the re-
 *       queue beat so the transcript stays complete when an
 *       operator releases the session back to the dispatcher.
 *
 *     assignToOperator({ session_id, operator_id })
 *       queued -> assigned. Stamps `assigned_operator_id` +
 *       `assigned_at`, emits a system "operator joined" message.
 *
 *     recordMessage({ session_id, author, body })
 *       assigned|active|waiting -> active (customer)
 *                                | waiting (operator)
 *       Appends to the transcript and advances `last_activity_at`.
 *       Author='system' is reserved for the primitive's own internal
 *       writes (no public emission shape — operators can record
 *       customer or operator messages only).
 *
 *     closeSession({ session_id, reason })
 *       any non-terminal -> closed. Stamps `closed_at` + reason.
 *
 *     cleanupAbandoned({ idle_minutes })
 *       any non-terminal whose `last_activity_at` is older than
 *       idle_minutes -> abandoned. Emits a system close message so
 *       the transcript records why the session ended.
 *
 *   Visitor session id + email are hashed at the door via
 *   `b.crypto.namespaceHash`. The raw values never land. The
 *   storefront re-derives the hash from the visitor's live session
 *   id when it needs to look up an in-flight chat.
 *
 *   Composition:
 *     - `b.guardUuid`           — UUID-shape validation for ids
 *     - `b.guardEmail`          — strict-profile validate + sanitize
 *     - `b.crypto.namespaceHash` — visitor / email hashing (SHA3-512)
 *     - `b.uuid.v7`             — row ids (sortable)
 *
 *   Storage:
 *     - `chat_sessions`        (migration `0113_live_chat.sql`)
 *     - `chat_messages`        (same migration)
 *     - `chat_operator_state`  (same migration)
 */

var MAX_BODY_LEN       = 4000;
var MAX_REASON_LEN     = 280;
var MAX_SOURCE_PAGE    = 1024;
var MAX_SESSION_ID_LEN = 256;
var MAX_LIST_LIMIT     = 200;
var DEFAULT_QUEUE_LIMIT = 50;
var MAX_IDLE_MINUTES   = 60 * 24 * 7;  // 7 days — generous upper bound
var MIN_IDLE_MINUTES   = 1;

var VISITOR_NAMESPACE  = "live-chat-visitor";
var EMAIL_NAMESPACE    = "live-chat-email";

var ALLOWED_AUTHORS         = ["customer", "operator", "system"];
var PUBLIC_AUTHORS          = ["customer", "operator"];
var ALLOWED_STATUSES        = ["queued", "assigned", "active", "waiting", "closed", "abandoned"];
var NON_TERMINAL_STATUSES   = ["queued", "assigned", "active", "waiting"];
var OPERATOR_STATUSES       = ["available", "away", "offline"];

// FSM allow-list keyed by from-state -> set of legal to-states.
// `closeSession` is a global edge: every non-terminal status can move
// to `closed`. `cleanupAbandoned` is a global edge to `abandoned`.
// `recordMessage` advances assigned|active|waiting -> active|waiting
// depending on author, but does NOT pass through this table — the
// transition is implicit and only the message author drives it.
var TRANSITIONS = {
  queued:    { assigned: 1, closed: 1, abandoned: 1 },
  assigned:  { active: 1, waiting: 1, queued: 1, closed: 1, abandoned: 1 },
  active:    { waiting: 1, closed: 1, abandoned: 1 },
  waiting:   { active: 1, closed: 1, abandoned: 1 },
  closed:    {},
  abandoned: {},
};

var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var CONTROL_BYTE_STRICT_RE = /[\x00-\x1f\x7f]/;
// Zero-width + direction-override characters. Spelled via \u escapes
// so the file stays ESLint no-irregular-whitespace clean.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// Lazy framework handle — matches the rest of the shop primitives;
// avoids the require cycle that would arise from importing `./index`
// at module-eval time.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}
var C = _b().constants;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("live-chat: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _publicAuthor(s) {
  if (typeof s !== "string" || PUBLIC_AUTHORS.indexOf(s) === -1) {
    throw new TypeError("live-chat: author must be one of " + PUBLIC_AUTHORS.join(", "));
  }
  return s;
}

function _body(s) {
  if (typeof s !== "string") {
    throw new TypeError("live-chat: body must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("live-chat: body must be non-empty after trim");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("live-chat: body must be <= " + MAX_BODY_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("live-chat: body contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("live-chat: body contains zero-width / direction-override characters");
  }
  return s;
}

function _reason(r, label) {
  if (r == null) return null;
  if (typeof r !== "string") {
    throw new TypeError("live-chat: " + (label || "reason") + " must be a string or null");
  }
  if (!r.length) return null;
  if (r.length > MAX_REASON_LEN) {
    throw new TypeError("live-chat: " + (label || "reason") + " must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(r) || ZERO_WIDTH_RE.test(r)) {
    throw new TypeError("live-chat: " + (label || "reason") + " contains control / zero-width bytes");
  }
  return r;
}

function _sourcePage(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("live-chat: source_page must be a non-empty string");
  }
  if (s.length > MAX_SOURCE_PAGE) {
    throw new TypeError("live-chat: source_page must be <= " + MAX_SOURCE_PAGE + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("live-chat: source_page contains control / zero-width bytes");
  }
  return s;
}

function _visitorSessionId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("live-chat: session_id must be a non-empty string");
  }
  if (s.length > MAX_SESSION_ID_LEN) {
    throw new TypeError("live-chat: session_id must be <= " + MAX_SESSION_ID_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("live-chat: session_id contains control / zero-width bytes");
  }
  return s;
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("live-chat: visitor_email must be a non-empty string");
  }
  var guardEmail = _b().guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("live-chat: visitor_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("live-chat: visitor_email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e2) {
    throw new TypeError("live-chat: visitor_email — " + (e2 && e2.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _operatorStatus(s) {
  if (typeof s !== "string" || OPERATOR_STATUSES.indexOf(s) === -1) {
    throw new TypeError("live-chat: operator status must be one of " + OPERATOR_STATUSES.join(", "));
  }
  return s;
}

function _sessionStatus(s, label) {
  if (typeof s !== "string" || ALLOWED_STATUSES.indexOf(s) === -1) {
    throw new TypeError("live-chat: " + (label || "status") +
      " must be one of " + ALLOWED_STATUSES.join(", "));
  }
  return s;
}

function _limit(n, defaultN) {
  if (n == null) return defaultN;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("live-chat: limit must be an integer 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _since(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("live-chat: since must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _idleMinutes(n) {
  if (!Number.isInteger(n) || n < MIN_IDLE_MINUTES || n > MAX_IDLE_MINUTES) {
    throw new TypeError("live-chat: idle_minutes must be an integer " +
      MIN_IDLE_MINUTES + "..." + MAX_IDLE_MINUTES);
  }
  return n;
}

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
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  function _hashVisitor(sessionId) {
    return _b().crypto.namespaceHash(VISITOR_NAMESPACE, sessionId);
  }
  function _hashEmail(canonical) {
    return _b().crypto.namespaceHash(EMAIL_NAMESPACE, canonical);
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM chat_sessions WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _writeSystemMessage(sessionId, body, ts) {
    await query(
      "INSERT INTO chat_messages (id, session_id, author, body, occurred_at) " +
      "VALUES (?1, ?2, 'system', ?3, ?4)",
      [_b().uuid.v7(), sessionId, body, ts],
    );
  }

  // Refuse if the candidate transition isn't legal from the row's
  // current status. Used by every public verb that's gated on
  // current state.
  function _ensureTransition(currentStatus, toStatus, verbLabel) {
    var allowed = TRANSITIONS[currentStatus] || {};
    if (!allowed[toStatus]) {
      var err = new Error("live-chat." + verbLabel +
        ": refused — cannot move " + currentStatus + " -> " + toStatus);
      err.code = "LIVE_CHAT_TRANSITION_REFUSED";
      throw err;
    }
  }

  return {
    MAX_BODY_LEN:           MAX_BODY_LEN,
    MAX_REASON_LEN:         MAX_REASON_LEN,
    MAX_SOURCE_PAGE:        MAX_SOURCE_PAGE,
    MAX_SESSION_ID_LEN:     MAX_SESSION_ID_LEN,
    MAX_LIST_LIMIT:         MAX_LIST_LIMIT,
    DEFAULT_QUEUE_LIMIT:    DEFAULT_QUEUE_LIMIT,
    MAX_IDLE_MINUTES:       MAX_IDLE_MINUTES,
    MIN_IDLE_MINUTES:       MIN_IDLE_MINUTES,
    ALLOWED_AUTHORS:        ALLOWED_AUTHORS.slice(),
    PUBLIC_AUTHORS:         PUBLIC_AUTHORS.slice(),
    ALLOWED_STATUSES:       ALLOWED_STATUSES.slice(),
    NON_TERMINAL_STATUSES:  NON_TERMINAL_STATUSES.slice(),
    OPERATOR_STATUSES:      OPERATOR_STATUSES.slice(),

    // Open a new chat session. Stamps the visitor + optional email
    // hashes, creates the row in `queued` state, and seeds the
    // transcript with the visitor's `initial_message` (when present)
    // authored by `customer`. The opening beat is also recorded as a
    // system message so the rendered transcript shows "session
    // opened from <source_page>" alongside the first visitor line.
    openSession: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("live-chat.openSession: input object required");
      }
      var rawSessionId = _visitorSessionId(input.session_id);
      var visitorHash  = _hashVisitor(rawSessionId);
      var sourcePage   = _sourcePage(input.source_page);

      var customerId = null;
      if (input.customer_id != null) {
        customerId = _uuid(input.customer_id, "customer_id");
      }
      var emailHash = null;
      if (input.visitor_email != null) {
        var canonical = _normalizeEmail(input.visitor_email);
        emailHash = _hashEmail(canonical);
      }
      var initialMessage = null;
      if (input.initial_message != null) {
        initialMessage = _body(input.initial_message);
      }

      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO chat_sessions " +
        "(id, customer_id, visitor_session_id_hash, visitor_email_hash, source_page, " +
        " status, assigned_operator_id, opened_at, assigned_at, last_activity_at, " +
        " closed_at, close_reason) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'queued', NULL, ?6, NULL, ?6, NULL, NULL)",
        [id, customerId, visitorHash, emailHash, sourcePage, ts],
      );
      await _writeSystemMessage(id, "session opened from " + sourcePage, ts);
      if (initialMessage != null) {
        await query(
          "INSERT INTO chat_messages (id, session_id, author, body, occurred_at) " +
          "VALUES (?1, ?2, 'customer', ?3, ?4)",
          [_b().uuid.v7(), id, initialMessage, ts],
        );
      }
      return await _getRaw(id);
    },

    // queued -> queued. No-op when the session is already queued;
    // refuses if the caller is trying to re-queue from an active
    // operator-held state (use closeSession + a fresh openSession
    // for that workflow). Records a system message when the session
    // was previously assigned, so the transcript shows the release.
    enqueueSession: async function (sessionId) {
      sessionId = _uuid(sessionId, "session_id");
      var row = await _getRaw(sessionId);
      if (!row) {
        var err = new Error("live-chat.enqueueSession: session " + sessionId + " not found");
        err.code = "LIVE_CHAT_SESSION_NOT_FOUND";
        throw err;
      }
      if (row.status === "queued") return row;
      // Only `assigned` may release back to queued. assigned|active|
      // waiting all carry an operator, but releasing mid-conversation
      // (active / waiting) is operator-error: the right verb is to
      // closeSession the current chat and let the visitor re-open if
      // they want to talk to someone else. assigned -> queued is the
      // only safe release (the operator picked up but hasn't sent
      // anything yet).
      _ensureTransition(row.status, "queued", "enqueueSession");
      var ts = _now();
      await query(
        "UPDATE chat_sessions SET status = 'queued', assigned_operator_id = NULL, " +
        "last_activity_at = ?1 WHERE id = ?2",
        [ts, sessionId],
      );
      await _writeSystemMessage(sessionId, "session re-queued", ts);
      return await _getRaw(sessionId);
    },

    // queued -> assigned. Stamps assigned_operator_id + assigned_at,
    // emits a system "operator joined" message. Refuses if the
    // session has already been assigned (concurrent dispatcher pick-
    // up should serialize on this refusal).
    assignToOperator: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("live-chat.assignToOperator: input object required");
      }
      var sessionId  = _uuid(input.session_id,  "session_id");
      var operatorId = _uuid(input.operator_id, "operator_id");
      var row = await _getRaw(sessionId);
      if (!row) {
        var err = new Error("live-chat.assignToOperator: session " + sessionId + " not found");
        err.code = "LIVE_CHAT_SESSION_NOT_FOUND";
        throw err;
      }
      _ensureTransition(row.status, "assigned", "assignToOperator");
      var ts = _now();
      await query(
        "UPDATE chat_sessions SET status = 'assigned', assigned_operator_id = ?1, " +
        "assigned_at = ?2, last_activity_at = ?2 WHERE id = ?3",
        [operatorId, ts, sessionId],
      );
      await _writeSystemMessage(sessionId, "operator joined", ts);
      return await _getRaw(sessionId);
    },

    // Append a message to the transcript. author='customer' moves
    // the session to `active`; author='operator' moves it to
    // `waiting`. Either advances `last_activity_at` so the reaper
    // doesn't sweep the chat while it's still in motion.
    recordMessage: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("live-chat.recordMessage: input object required");
      }
      var sessionId = _uuid(input.session_id, "session_id");
      var author    = _publicAuthor(input.author);
      var body      = _body(input.body);
      var row = await _getRaw(sessionId);
      if (!row) {
        var err = new Error("live-chat.recordMessage: session " + sessionId + " not found");
        err.code = "LIVE_CHAT_SESSION_NOT_FOUND";
        throw err;
      }
      if (row.status === "closed" || row.status === "abandoned") {
        var tErr = new Error("live-chat.recordMessage: session " + sessionId +
          " is " + row.status + ", cannot record more messages");
        tErr.code = "LIVE_CHAT_SESSION_TERMINAL";
        throw tErr;
      }
      if (row.status === "queued") {
        // Customer-side typing while still queued is allowed and
        // does NOT move the session out of `queued` — the
        // dispatcher still needs to assign an operator before the
        // chat is "active" in the operator-console sense.
        // Operator-side messages on a queued session are refused —
        // an operator must `assignToOperator` first.
        if (author === "operator") {
          var qErr = new Error("live-chat.recordMessage: session " + sessionId +
            " is queued, operator must assignToOperator before sending messages");
          qErr.code = "LIVE_CHAT_NOT_ASSIGNED";
          throw qErr;
        }
      }
      var ts = _now();
      await query(
        "INSERT INTO chat_messages (id, session_id, author, body, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [_b().uuid.v7(), sessionId, author, body, ts],
      );
      // Status advancement:
      //   queued + customer  -> queued (no movement)
      //   assigned + customer -> active
      //   assigned + operator -> waiting
      //   active|waiting + customer -> active
      //   active|waiting + operator -> waiting
      var newStatus = row.status;
      if (row.status !== "queued") {
        newStatus = author === "customer" ? "active" : "waiting";
      }
      await query(
        "UPDATE chat_sessions SET status = ?1, last_activity_at = ?2 WHERE id = ?3",
        [newStatus, ts, sessionId],
      );
      return await _getRaw(sessionId);
    },

    // any non-terminal -> closed. Records a system close message
    // carrying the reason so the transcript explains the close.
    closeSession: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("live-chat.closeSession: input object required");
      }
      var sessionId = _uuid(input.session_id, "session_id");
      var reason    = _reason(input.reason, "reason");
      var row = await _getRaw(sessionId);
      if (!row) {
        var err = new Error("live-chat.closeSession: session " + sessionId + " not found");
        err.code = "LIVE_CHAT_SESSION_NOT_FOUND";
        throw err;
      }
      _ensureTransition(row.status, "closed", "closeSession");
      var ts = _now();
      await query(
        "UPDATE chat_sessions SET status = 'closed', closed_at = ?1, close_reason = ?2, " +
        "last_activity_at = ?1 WHERE id = ?3",
        [ts, reason, sessionId],
      );
      await _writeSystemMessage(sessionId, "session closed" + (reason ? ": " + reason : ""), ts);
      return await _getRaw(sessionId);
    },

    // Read a single session (raw row) or null when not found.
    getSession: async function (sessionId) {
      sessionId = _uuid(sessionId, "session_id");
      return await _getRaw(sessionId);
    },

    // Transcript view. Optional `since` (epoch ms) so the
    // storefront poll-or-tail surface only pulls new lines.
    // Ordered by (occurred_at ASC, id ASC) so consecutive messages
    // with the same timestamp render in insertion order.
    messagesForSession: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("live-chat.messagesForSession: input object required");
      }
      var sessionId = _uuid(input.session_id, "session_id");
      var since     = _since(input.since);
      var sql, params;
      if (since != null) {
        sql = "SELECT * FROM chat_messages WHERE session_id = ?1 AND occurred_at > ?2 " +
              "ORDER BY occurred_at ASC, id ASC";
        params = [sessionId, since];
      } else {
        sql = "SELECT * FROM chat_messages WHERE session_id = ?1 " +
              "ORDER BY occurred_at ASC, id ASC";
        params = [sessionId];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    // Operator-side queue: sessions assigned to one operator, or to
    // any operator (when operator_id omitted) — both restricted to
    // the supplied status filter (or every non-terminal state when
    // omitted). Ordered by assigned_at ASC so the operator works
    // longest-held first.
    operatorQueue: async function (input) {
      input = input || {};
      var operatorId;
      if (input.operator_id != null) {
        operatorId = _uuid(input.operator_id, "operator_id");
      }
      var statusFilter;
      if (input.status != null) {
        statusFilter = _sessionStatus(input.status, "status");
        if (NON_TERMINAL_STATUSES.indexOf(statusFilter) === -1 && statusFilter !== "closed" && statusFilter !== "abandoned") {
          throw new TypeError("live-chat.operatorQueue: status filter out of range");
        }
      }
      var where  = [];
      var params = [];
      var idx    = 1;
      if (operatorId !== undefined) {
        where.push("assigned_operator_id = ?" + idx);
        params.push(operatorId);
        idx += 1;
      } else {
        where.push("assigned_operator_id IS NOT NULL");
      }
      if (statusFilter !== undefined) {
        where.push("status = ?" + idx);
        params.push(statusFilter);
        idx += 1;
      } else {
        where.push("status IN ('assigned','active','waiting')");
      }
      var sql = "SELECT * FROM chat_sessions WHERE " + where.join(" AND ") +
                " ORDER BY assigned_at ASC, opened_at ASC, id ASC";
      var r = await query(sql, params);
      return r.rows;
    },

    // Dispatcher queue: queued sessions in FIFO order. limit caps
    // the page; default is DEFAULT_QUEUE_LIMIT.
    waitingQueue: async function (input) {
      input = input || {};
      var limit = _limit(input.limit, DEFAULT_QUEUE_LIMIT);
      var r = await query(
        "SELECT * FROM chat_sessions WHERE status = 'queued' " +
        "ORDER BY opened_at ASC, id ASC LIMIT ?1",
        [limit],
      );
      return r.rows;
    },

    // Count of active concurrent sessions held by one operator —
    // counts the assigned|active|waiting states (every state in
    // which the operator is currently on the hook). Drives the
    // dispatcher's load-balancing heuristic.
    operatorWorkload: async function (operatorId) {
      operatorId = _uuid(operatorId, "operator_id");
      var r = await query(
        "SELECT COUNT(*) AS c FROM chat_sessions " +
        "WHERE assigned_operator_id = ?1 AND status IN ('assigned','active','waiting')",
        [operatorId],
      );
      var row = r.rows[0];
      return row ? Number(row.c) : 0;
    },

    // Mark an operator available — eligible for dispatcher pickup.
    // Upserts the row.
    markOperatorAvailable: async function (operatorId) {
      operatorId = _uuid(operatorId, "operator_id");
      var ts = _now();
      // Manual upsert because the in-memory test DB doesn't speak
      // sqlite's UPSERT until pragma; same shape used elsewhere.
      var existing = await query(
        "SELECT operator_id FROM chat_operator_state WHERE operator_id = ?1",
        [operatorId],
      );
      if (existing.rows.length) {
        await query(
          "UPDATE chat_operator_state SET status = 'available', updated_at = ?1 " +
          "WHERE operator_id = ?2",
          [ts, operatorId],
        );
      } else {
        await query(
          "INSERT INTO chat_operator_state (operator_id, status, updated_at) " +
          "VALUES (?1, 'available', ?2)",
          [operatorId, ts],
        );
      }
      return { operator_id: operatorId, status: "available", updated_at: ts };
    },

    // Mark an operator away — dispatcher should skip them. Existing
    // assignments are NOT auto-released; the operator drains their
    // current queue.
    markOperatorAway: async function (operatorId) {
      operatorId = _uuid(operatorId, "operator_id");
      var ts = _now();
      var existing = await query(
        "SELECT operator_id FROM chat_operator_state WHERE operator_id = ?1",
        [operatorId],
      );
      if (existing.rows.length) {
        await query(
          "UPDATE chat_operator_state SET status = 'away', updated_at = ?1 " +
          "WHERE operator_id = ?2",
          [ts, operatorId],
        );
      } else {
        await query(
          "INSERT INTO chat_operator_state (operator_id, status, updated_at) " +
          "VALUES (?1, 'away', ?2)",
          [operatorId, ts],
        );
      }
      return { operator_id: operatorId, status: "away", updated_at: ts };
    },

    // Reaper. Closes every non-terminal session whose
    // `last_activity_at` is older than `idle_minutes` minutes ago.
    // Returns the list of session ids that were swept so the
    // scheduler can log / notify.
    cleanupAbandoned: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("live-chat.cleanupAbandoned: input object required");
      }
      var idleMinutes = _idleMinutes(input.idle_minutes);
      var ts        = _now();
      var threshold = ts - C.TIME.minutes(idleMinutes);
      var r = await query(
        "SELECT id FROM chat_sessions " +
        "WHERE status IN ('queued','assigned','active','waiting') " +
        "AND last_activity_at < ?1",
        [threshold],
      );
      var swept = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var sid = r.rows[i].id;
        await query(
          "UPDATE chat_sessions SET status = 'abandoned', closed_at = ?1, " +
          "close_reason = 'idle timeout', last_activity_at = ?1 WHERE id = ?2",
          [ts, sid],
        );
        await _writeSystemMessage(sid, "session abandoned: idle timeout", ts);
        swept.push(sid);
      }
      return { swept: swept, count: swept.length, threshold_ms: threshold };
    },
  };
}

module.exports = {
  create:                 create,
  MAX_BODY_LEN:           MAX_BODY_LEN,
  MAX_REASON_LEN:         MAX_REASON_LEN,
  MAX_SOURCE_PAGE:        MAX_SOURCE_PAGE,
  MAX_SESSION_ID_LEN:     MAX_SESSION_ID_LEN,
  MAX_LIST_LIMIT:         MAX_LIST_LIMIT,
  DEFAULT_QUEUE_LIMIT:    DEFAULT_QUEUE_LIMIT,
  MAX_IDLE_MINUTES:       MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES:       MIN_IDLE_MINUTES,
  ALLOWED_AUTHORS:        ALLOWED_AUTHORS.slice(),
  PUBLIC_AUTHORS:         PUBLIC_AUTHORS.slice(),
  ALLOWED_STATUSES:       ALLOWED_STATUSES.slice(),
  NON_TERMINAL_STATUSES:  NON_TERMINAL_STATUSES.slice(),
  OPERATOR_STATUSES:      OPERATOR_STATUSES.slice(),
};
