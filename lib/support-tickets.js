"use strict";
/**
 * @module shop.supportTickets
 * @title  Support tickets — customer-service ticketing surface
 *
 * @intro
 *   Customer-service ticketing broader than `orderNotes`. A ticket
 *   isn't necessarily tied to an order: it can be a pre-sale
 *   question, an account problem, a billing dispute, or a complaint.
 *   Each ticket has:
 *
 *     - a thread of messages (customer + operator + system)
 *     - a priority + status FSM
 *     - optional order / customer links
 *     - free-form tags
 *     - an SLA timer the scheduler walks to surface breaches
 *
 *   Email addresses are hashed at the door via
 *   `b.crypto.namespaceHash("support-ticket-email", lowercased)` so
 *   the raw address never lands on disk; the storefront re-derives
 *   the hash from the session-attached email to look up a customer's
 *   own tickets.
 *
 *   Composes:
 *     - `b.guardUuid`      — UUID-shape validation for ids
 *     - `b.guardEmail`     — strict-profile validate + sanitize
 *     - `b.crypto.namespaceHash` — email hashing (SHA3-512)
 *     - `b.uuid.v7`        — row ids
 *     - `b.pagination`     — HMAC-tagged tuple cursors for
 *                            listForCustomer
 *
 *   Surface:
 *     open({ customer_id?, customer_email, subject, body, category,
 *            priority?, order_id?, tags? })
 *     reply({ ticket_id, author, author_id?, body, internal? })
 *     transition({ ticket_id, to_status, reason? })
 *     assign({ ticket_id, operator_id }) / unassign(ticket_id)
 *     addTag({ ticket_id, tag }) / removeTag({ ticket_id, tag })
 *     get(ticket_id)
 *     listForCustomer({ customer_email, customer_id?, cursor?,
 *                       limit?, status_filter? })
 *     listOpenAssignedTo(operator_id)
 *     listUnassigned({ priority? })
 *     thread(ticket_id)
 *     slaCheck()
 *     metrics({ from, to })
 *
 *   Storage:
 *     - `support_tickets`         (migration `0047_support_tickets.sql`)
 *     - `support_messages`        (same migration)
 *     - `support_status_history`  (same migration)
 */

var MAX_SUBJECT_LEN     = 200;
var MAX_BODY_LEN        = 8000;
var MAX_TAG_COUNT       = 16;
var MAX_TAG_LEN         = 32;
var MAX_REASON_LEN      = 280;
var MAX_LIST_LIMIT      = 100;
var DEFAULT_LIST_LIMIT  = 25;

var EMAIL_NAMESPACE     = "support-ticket-email";

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

var ALLOWED_AUTHORS    = ["customer", "operator", "system"];
var ALLOWED_CATEGORIES = [
  "pre_sale", "order_issue", "shipping", "billing", "refund",
  "account", "complaint", "feature_request", "other",
];
var ALLOWED_PRIORITIES = ["low", "normal", "high", "urgent"];
var ALLOWED_STATUSES   = [
  "new", "in_progress", "waiting_customer", "resolved", "closed", "reopened",
];

// SLA budgets — milliseconds since `last_action_at` after which the
// ticket is considered breached. Closed / resolved tickets never
// breach. Drives `slaCheck()` for the scheduler.
var SLA_MS = {
  urgent: b.constants.TIME.hours(1),
  high:   b.constants.TIME.hours(4),
  normal: b.constants.TIME.hours(24),
  low:    b.constants.TIME.hours(72),
};

// FSM. Encoded as an explicit allow-list keyed by from-state. Every
// state can transition to `closed` (operator force-close). `resolved`
// goes to `closed` (archive) or `reopened` (customer pushes back).
// `reopened` re-enters the workflow at `in_progress`.
var TRANSITIONS = {
  new:               { in_progress: 1, closed: 1 },
  in_progress:       { waiting_customer: 1, resolved: 1, closed: 1 },
  waiting_customer:  { in_progress: 1, resolved: 1, closed: 1 },
  resolved:          { reopened: 1, closed: 1 },
  reopened:          { in_progress: 1, closed: 1 },
  closed:            {},
};

// listForCustomer cursor order — (opened_at DESC, id DESC). Tuple
// cursor is HMAC-tagged via `b.pagination` so a tampered cursor
// can't skip past tickets the caller isn't supposed to see.
var LIST_ORDER_KEY = ["opened_at:desc", "id:desc"];

// Refuse C0 control bytes + DEL. Newlines (LF/CR) + tab are tolerated
// in body so multi-line customer narratives work; subject is single-
// line by convention and refuses them.
// Zero-width + direction-override family (see orderNotes for the
// same justification). Spelled via \u escapes so the file stays
// ESLint no-irregular-whitespace clean.

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("supportTickets: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _author(s) {
  if (typeof s !== "string" || ALLOWED_AUTHORS.indexOf(s) === -1) {
    throw new TypeError("supportTickets: author must be one of " + ALLOWED_AUTHORS.join(", "));
  }
  return s;
}

function _category(s) {
  if (typeof s !== "string" || ALLOWED_CATEGORIES.indexOf(s) === -1) {
    throw new TypeError("supportTickets: category must be one of " + ALLOWED_CATEGORIES.join(", "));
  }
  return s;
}

function _priority(s) {
  if (typeof s !== "string" || ALLOWED_PRIORITIES.indexOf(s) === -1) {
    throw new TypeError("supportTickets: priority must be one of " + ALLOWED_PRIORITIES.join(", "));
  }
  return s;
}

function _status(s, label) {
  if (typeof s !== "string" || ALLOWED_STATUSES.indexOf(s) === -1) {
    throw new TypeError("supportTickets: " + label + " must be one of " + ALLOWED_STATUSES.join(", "));
  }
  return s;
}

function _subject(s) {
  if (typeof s !== "string") {
    throw new TypeError("supportTickets: subject must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("supportTickets: subject must be non-empty after trim");
  }
  if (s.length > MAX_SUBJECT_LEN) {
    throw new TypeError("supportTickets: subject must be <= " + MAX_SUBJECT_LEN + " characters");
  }
  textGuard.freeText(s, "supportTickets: subject", { singleLine: "reject", zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _body(s) {
  if (typeof s !== "string") {
    throw new TypeError("supportTickets: body must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("supportTickets: body must be non-empty after trim");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("supportTickets: body must be <= " + MAX_BODY_LEN + " characters");
  }
  textGuard.freeText(s, "supportTickets: body", { zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _tags(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("supportTickets: tags must be an array of strings");
  }
  if (input.length > MAX_TAG_COUNT) {
    throw new TypeError("supportTickets: tags array must contain <= " + MAX_TAG_COUNT + " entries");
  }
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    var t = input[i];
    if (typeof t !== "string" || !t.length) {
      throw new TypeError("supportTickets: tags[" + i + "] must be a non-empty string");
    }
    if (t.length > MAX_TAG_LEN) {
      throw new TypeError("supportTickets: tags[" + i + "] must be <= " + MAX_TAG_LEN + " characters");
    }
    if (textGuard.hasCodepointThreat(t, { singleLine: "reject", zeroWidth: "reject" })) {
      throw new TypeError("supportTickets: tags[" + i + "] contains control / zero-width bytes");
    }
    out.push(t);
  }
  return out;
}

function _singleTag(t) {
  if (typeof t !== "string" || !t.length) {
    throw new TypeError("supportTickets: tag must be a non-empty string");
  }
  if (t.length > MAX_TAG_LEN) {
    throw new TypeError("supportTickets: tag must be <= " + MAX_TAG_LEN + " characters");
  }
  textGuard.freeText(t, "supportTickets: tag", { singleLine: "reject", zeroWidth: "reject" });
  return t;
}

function _reason(r) {
  if (r == null) return null;
  if (typeof r !== "string") {
    throw new TypeError("supportTickets: reason must be a string or null");
  }
  if (!r.length) return null;
  if (r.length > MAX_REASON_LEN) {
    throw new TypeError("supportTickets: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  textGuard.freeText(r, "supportTickets: reason", { zeroWidth: "reject", bidiMarks: "allow" });
  return r;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("supportTickets: limit must be an integer 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _timestampRange(from, to, label) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError("supportTickets." + label + ": from must be a non-negative integer (ms epoch)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError("supportTickets." + label + ": to must be a non-negative integer (ms epoch)");
  }
  if (from > to) {
    throw new TypeError("supportTickets." + label + ": from must be <= to");
  }
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("supportTickets: customer_email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("supportTickets: customer_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("supportTickets: customer_email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e2) {
    throw new TypeError("supportTickets: customer_email — " + (e2 && e2.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _now() { return Date.now(); }

function _hydrate(row) {
  if (!row) return row;
  try { row.tags = JSON.parse(row.tags_json || "[]"); }
  catch (_e) { row.tags = []; }
  return row;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged via b.pagination so a caller
  // can't hand-craft one to skip past tickets attached to another
  // customer or replay across deployments. The secret defaults to a
  // dev-only placeholder so the primitive boots in tests; production
  // deployments must supply a derived value (typically
  // b.crypto.namespaceHash("support-tickets-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("supportTickets.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "support-tickets-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("supportTickets." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("supportTickets." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("supportTickets." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return b.pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [last.opened_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  function _hashEmail(canonicalEmail) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, canonicalEmail);
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM support_tickets WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // Refresh + return the hydrated ticket. Used as the return value
  // of every mutation so the caller gets the post-image without
  // having to call get() separately.
  async function _refresh(id) {
    var row = await _getRaw(id);
    return _hydrate(row);
  }

  async function _writeStatusHistory(ticketId, fromStatus, toStatus, reason, ts) {
    await query(
      "INSERT INTO support_status_history " +
      "(id, ticket_id, from_status, to_status, reason, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [b.uuid.v7(), ticketId, fromStatus, toStatus, reason, ts],
    );
  }

  return {
    MAX_SUBJECT_LEN:    MAX_SUBJECT_LEN,
    MAX_BODY_LEN:       MAX_BODY_LEN,
    MAX_TAG_COUNT:      MAX_TAG_COUNT,
    MAX_TAG_LEN:        MAX_TAG_LEN,
    MAX_REASON_LEN:     MAX_REASON_LEN,
    MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
    ALLOWED_AUTHORS:    ALLOWED_AUTHORS.slice(),
    ALLOWED_CATEGORIES: ALLOWED_CATEGORIES.slice(),
    ALLOWED_PRIORITIES: ALLOWED_PRIORITIES.slice(),
    ALLOWED_STATUSES:   ALLOWED_STATUSES.slice(),
    SLA_MS:             Object.assign({}, SLA_MS),

    // Open a new ticket. Status starts at `new`; `last_action_at`
    // mirrors `opened_at` so the SLA clock starts running
    // immediately. The first body lands as the first row in
    // support_messages authored by `customer` (operator-opened
    // tickets are still recorded as customer-authored because the
    // body represents the customer's intent — operators can `reply`
    // afterwards if they need to add operator-side context).
    open: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("supportTickets.open: input object required");
      }
      var customerEmail   = _normalizeEmail(input.customer_email);
      var customerEmailH  = _hashEmail(customerEmail);
      var subject         = _subject(input.subject);
      var body            = _body(input.body);
      var category        = _category(input.category);
      var priority        = input.priority == null ? "normal" : _priority(input.priority);
      var tags            = _tags(input.tags);

      var customerId = null;
      if (input.customer_id != null) {
        customerId = _uuid(input.customer_id, "customer_id");
      }
      var orderId = null;
      if (input.order_id != null) {
        orderId = _uuid(input.order_id, "order_id");
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO support_tickets " +
        "(id, customer_id, customer_email_hash, subject, body, category, status, " +
        " priority, order_id, assigned_operator_id, tags_json, opened_at, " +
        " first_response_at, last_action_at, resolved_at, closed_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?8, NULL, ?9, ?10, NULL, ?10, NULL, NULL)",
        [
          id, customerId, customerEmailH, subject, body, category,
          priority, orderId, JSON.stringify(tags), ts,
        ],
      );

      // First message — the customer's opening body.
      await query(
        "INSERT INTO support_messages " +
        "(id, ticket_id, author, author_id, body, internal, created_at) " +
        "VALUES (?1, ?2, 'customer', ?3, ?4, 0, ?5)",
        [b.uuid.v7(), id, customerId, body, ts],
      );

      return await _refresh(id);
    },

    // Append a message to the ticket thread.
    //   * A CUSTOMER-VISIBLE operator reply (internal=false) flips
    //     `new -> in_progress`, stamps `first_response_at` if unset, and
    //     bumps `last_action_at`. An INTERNAL operator note (internal=true)
    //     is operator-to-operator: append-only, no status flip, no
    //     first-response stamp (the customer never sees it, so it can't
    //     satisfy the response SLA).
    //   * A customer reply doesn't advance `last_action_at` on the
    //     operator's-clock states, but DOES requeue the ticket: a reply to
    //     `waiting_customer` returns it to `in_progress`, and a reply to a
    //     `resolved` ticket reopens it (`resolved -> reopened`, with a
    //     fresh SLA clock) so the operator's pushback never goes unseen.
    reply: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("supportTickets.reply: input object required");
      }
      var ticketId = _uuid(input.ticket_id, "ticket_id");
      var author   = _author(input.author);
      var body     = _body(input.body);
      var internal = input.internal === true ? 1 : 0;

      if (internal && author !== "operator") {
        throw new TypeError("supportTickets.reply: internal=true requires author='operator'");
      }

      var authorId = null;
      if (input.author_id != null) {
        authorId = _uuid(input.author_id, "author_id");
      }

      var ticket = await _getRaw(ticketId);
      if (!ticket) {
        var err = new Error("supportTickets.reply: ticket " + ticketId + " not found");
        err.code = "SUPPORT_TICKET_NOT_FOUND";
        throw err;
      }
      if (ticket.status === "closed") {
        var cErr = new Error("supportTickets.reply: ticket " + ticketId + " is closed");
        cErr.code = "SUPPORT_TICKET_CLOSED";
        throw cErr;
      }

      var ts = _now();
      await query(
        "INSERT INTO support_messages " +
        "(id, ticket_id, author, author_id, body, internal, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [b.uuid.v7(), ticketId, author, authorId, body, internal, ts],
      );

      if (author === "operator") {
        // Only a CUSTOMER-VISIBLE operator reply counts as a first
        // response or advances the workflow. An INTERNAL note (internal=1)
        // is operator-to-operator — the customer never sees it, so
        // stamping first_response_at off it would satisfy the SLA with
        // content that never reached the person waiting. An internal note
        // is append-only here: no status flip, no first_response_at, no
        // last_action_at bump (it isn't operator responsiveness TO the
        // customer). The message row was already inserted above.
        if (!internal) {
          // A customer-visible operator reply flips `new -> in_progress`
          // automatically; other states keep their status. The
          // first-response stamp + SLA timer advance only on this path.
          var newStatus = ticket.status;
          if (ticket.status === "new") {
            newStatus = "in_progress";
            await _writeStatusHistory(ticketId, ticket.status, newStatus, "operator-reply", ts);
          }
          var firstResp = ticket.first_response_at == null ? ts : ticket.first_response_at;
          await query(
            "UPDATE support_tickets SET status = ?1, first_response_at = ?2, last_action_at = ?3 WHERE id = ?4",
            [newStatus, firstResp, ts, ticketId],
          );
        }
      } else if (author === "customer") {
        // Customer replies don't advance last_action_at on the
        // operator's-clock states — that would mask an SLA breach. They DO
        // move the ticket back into a queue the operator owes the next
        // move on:
        //   * waiting_customer -> in_progress (the customer answered)
        //   * resolved        -> reopened     (the customer pushed back; an
        //                                       FSM-legal edge, resolved ->
        //                                       reopened). Without this, a
        //                                       reply to a resolved ticket
        //                                       was silently dropped from
        //                                       every operator queue.
        // last_action_at bumps ONLY on the resolved->reopened move so the
        // reopened ticket surfaces with a fresh SLA clock (the operator now
        // owes a response); the waiting_customer->in_progress move keeps the
        // existing clock (the operator's responsiveness window never paused).
        if (ticket.status === "waiting_customer") {
          await _writeStatusHistory(ticketId, ticket.status, "in_progress", "customer-reply", ts);
          await query(
            "UPDATE support_tickets SET status = 'in_progress' WHERE id = ?1",
            [ticketId],
          );
        } else if (ticket.status === "resolved") {
          await _writeStatusHistory(ticketId, ticket.status, "reopened", "customer-reply", ts);
          await query(
            "UPDATE support_tickets SET status = 'reopened', last_action_at = ?1 WHERE id = ?2",
            [ts, ticketId],
          );
        }
      }
      // system author: append-only; no state mutation.

      return await _refresh(ticketId);
    },

    // FSM transition. The graph is:
    //
    //   new -> in_progress | closed
    //   in_progress -> waiting_customer | resolved | closed
    //   waiting_customer -> in_progress | resolved | closed
    //   resolved -> reopened | closed
    //   reopened -> in_progress | closed
    //   closed -> (terminal)
    //
    // Stamps `resolved_at` on first entry into `resolved`, `closed_at`
    // on first entry into `closed`. `last_action_at` advances on
    // every transition.
    transition: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("supportTickets.transition: input object required");
      }
      var ticketId = _uuid(input.ticket_id, "ticket_id");
      var toStatus = _status(input.to_status, "to_status");
      var reason   = _reason(input.reason);

      var ticket = await _getRaw(ticketId);
      if (!ticket) {
        var err = new Error("supportTickets.transition: ticket " + ticketId + " not found");
        err.code = "SUPPORT_TICKET_NOT_FOUND";
        throw err;
      }
      var allowed = TRANSITIONS[ticket.status] || {};
      if (!allowed[toStatus]) {
        var tErr = new Error(
          "supportTickets.transition: refused — cannot move " +
          ticket.status + " -> " + toStatus
        );
        tErr.code = "SUPPORT_TICKET_TRANSITION_REFUSED";
        throw tErr;
      }

      var ts        = _now();
      var resolvedAt = ticket.resolved_at;
      var closedAt   = ticket.closed_at;
      if (toStatus === "resolved" && resolvedAt == null) resolvedAt = ts;
      if (toStatus === "closed"   && closedAt   == null) closedAt   = ts;

      await _writeStatusHistory(ticketId, ticket.status, toStatus, reason, ts);
      await query(
        "UPDATE support_tickets SET status = ?1, last_action_at = ?2, resolved_at = ?3, closed_at = ?4 WHERE id = ?5",
        [toStatus, ts, resolvedAt, closedAt, ticketId],
      );
      return await _refresh(ticketId);
    },

    assign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("supportTickets.assign: input object required");
      }
      var ticketId   = _uuid(input.ticket_id, "ticket_id");
      var operatorId = _uuid(input.operator_id, "operator_id");
      var ticket = await _getRaw(ticketId);
      if (!ticket) {
        var err = new Error("supportTickets.assign: ticket " + ticketId + " not found");
        err.code = "SUPPORT_TICKET_NOT_FOUND";
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE support_tickets SET assigned_operator_id = ?1, last_action_at = ?2 WHERE id = ?3",
        [operatorId, ts, ticketId],
      );
      return await _refresh(ticketId);
    },

    unassign: async function (ticketId) {
      ticketId = _uuid(ticketId, "ticket_id");
      var ticket = await _getRaw(ticketId);
      if (!ticket) {
        var err = new Error("supportTickets.unassign: ticket " + ticketId + " not found");
        err.code = "SUPPORT_TICKET_NOT_FOUND";
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE support_tickets SET assigned_operator_id = NULL, last_action_at = ?1 WHERE id = ?2",
        [ts, ticketId],
      );
      return await _refresh(ticketId);
    },

    // Add a tag. The mutation is a SINGLE atomic JSON1 statement —
    // `json_insert(..., '$[#]', ?)` appends only when the tag isn't
    // already present (the json_each NOT-EXISTS guard) AND the ticket is
    // under the cap (json_array_length guard). A prior read-modify-write
    // (decode -> push in JS -> write the whole array back) lost one of two
    // concurrent addTag writes: both read the same array, both appended
    // their own tag, the last write clobbered the other. Doing the append
    // inside SQLite removes the read-then-write window entirely. The read
    // that remains exists ONLY to classify a zero-row update (idempotent
    // dup vs cap-exceeded error) — it never feeds the write.
    addTag: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("supportTickets.addTag: input object required");
      }
      var ticketId = _uuid(input.ticket_id, "ticket_id");
      var tag      = _singleTag(input.tag);
      var res = await query(
        "UPDATE support_tickets " +
        "SET tags_json = json_insert(COALESCE(tags_json, '[]'), '$[#]', ?1) " +
        "WHERE id = ?2 " +
        "  AND (SELECT COUNT(*) FROM json_each(COALESCE(tags_json, '[]')) WHERE value = ?1) = 0 " +
        "  AND json_array_length(COALESCE(tags_json, '[]')) < ?3",
        [tag, ticketId, MAX_TAG_COUNT],
      );
      if (Number((res && res.rowCount) || 0) === 0) {
        // The atomic UPDATE matched no row. Read once to classify: a
        // missing ticket is a hard error; an already-present tag is an
        // idempotent no-op; otherwise the ticket is at the tag cap.
        var ticket = await _getRaw(ticketId);
        if (!ticket) {
          var err = new Error("supportTickets.addTag: ticket " + ticketId + " not found");
          err.code = "SUPPORT_TICKET_NOT_FOUND";
          throw err;
        }
        var tags;
        try { tags = JSON.parse(ticket.tags_json || "[]"); }
        catch (_e) { tags = []; }
        if (tags.indexOf(tag) === -1 && tags.length >= MAX_TAG_COUNT) {
          throw new TypeError("supportTickets.addTag: ticket already has " + MAX_TAG_COUNT + " tags");
        }
        // else: tag already present — idempotent success, nothing to do.
      }
      return await _refresh(ticketId);
    },

    // Remove a tag. Single atomic JSON1 statement — rebuild the array
    // from `json_each` minus the target value. Same lost-update hazard as
    // addTag if done read-modify-write; doing it in SQLite removes the
    // window. Idempotent: a tag that isn't present matches no row in the
    // EXISTS guard and the update is a no-op. A missing ticket is read
    // back only to raise the not-found error (the update wrote nothing).
    removeTag: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("supportTickets.removeTag: input object required");
      }
      var ticketId = _uuid(input.ticket_id, "ticket_id");
      var tag      = _singleTag(input.tag);
      var res = await query(
        "UPDATE support_tickets " +
        "SET tags_json = (" +
        "  SELECT COALESCE(json_group_array(value), '[]') " +
        "  FROM json_each(COALESCE(tags_json, '[]')) WHERE value <> ?1" +
        ") " +
        "WHERE id = ?2 " +
        "  AND EXISTS (SELECT 1 FROM json_each(COALESCE(tags_json, '[]')) WHERE value = ?1)",
        [tag, ticketId],
      );
      if (Number((res && res.rowCount) || 0) === 0) {
        // No row changed — either the ticket is missing (hard error) or
        // the tag simply wasn't present (idempotent no-op).
        var ticket = await _getRaw(ticketId);
        if (!ticket) {
          var err = new Error("supportTickets.removeTag: ticket " + ticketId + " not found");
          err.code = "SUPPORT_TICKET_NOT_FOUND";
          throw err;
        }
      }
      return await _refresh(ticketId);
    },

    get: async function (id) {
      _uuid(id, "ticket_id");
      return await _refresh(id);
    },

    // Paginated ticket list for one customer. The lookup key is the
    // email hash, with an optional customer_id refinement (a single
    // email can be attached to multiple customer rows during account
    // migrations — the operator console scopes by id when present).
    // Ordered (opened_at DESC, id DESC); cursor is a HMAC-tagged tuple.
    listForCustomer: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("supportTickets.listForCustomer: input object required");
      }
      var emailNorm   = _normalizeEmail(listOpts.customer_email);
      var emailHash   = _hashEmail(emailNorm);
      var limit       = _limit(listOpts.limit);
      var cursorVals  = _decodeCursor(listOpts.cursor, "listForCustomer");
      var statusFilter;
      if (listOpts.status_filter != null) {
        statusFilter = _status(listOpts.status_filter, "status_filter");
      }
      var customerId;
      if (listOpts.customer_id != null) {
        customerId = _uuid(listOpts.customer_id, "customer_id");
      }

      var where  = ["customer_email_hash = ?1"];
      var params = [emailHash];
      var idx    = 2;
      if (customerId !== undefined) {
        where.push("customer_id = ?" + idx);
        params.push(customerId);
        idx += 1;
      }
      if (statusFilter !== undefined) {
        where.push("status = ?" + idx);
        params.push(statusFilter);
        idx += 1;
      }
      if (cursorVals) {
        var a = idx;
        var bIdx = idx + 1;
        where.push(
          "(opened_at < ?" + a + " OR " +
          "(opened_at = ?" + a + " AND id < ?" + bIdx + "))"
        );
        params.push(cursorVals[0], cursorVals[1]);
        idx += 2;
      }
      params.push(limit);
      var sql = "SELECT * FROM support_tickets WHERE " + where.join(" AND ") +
                " ORDER BY opened_at DESC, id DESC LIMIT ?" + idx;
      var r = await query(sql, params);
      var rows = r.rows.map(_hydrate);
      return { rows: rows, next_cursor: _encodeNext(rows, limit) };
    },

    // Operator queue — every open ticket (not resolved, not closed)
    // assigned to this operator, urgent first, then by oldest
    // last_action_at (most-stale-first).
    listOpenAssignedTo: async function (operatorId) {
      operatorId = _uuid(operatorId, "operator_id");
      var sql =
        "SELECT * FROM support_tickets " +
        "WHERE assigned_operator_id = ?1 AND status NOT IN ('resolved', 'closed') " +
        "ORDER BY CASE priority " +
        "  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 " +
        "  WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, " +
        "last_action_at ASC";
      var r = await query(sql, [operatorId]);
      return r.rows.map(_hydrate);
    },

    // Triage queue — every ticket that nobody owns yet. Same priority
    // ordering as the assigned queue; optional priority filter so a
    // dispatcher can pull, say, urgents only.
    listUnassigned: async function (listOpts) {
      listOpts = listOpts || {};
      var priorityFilter;
      if (listOpts.priority != null) {
        priorityFilter = _priority(listOpts.priority);
      }
      var sql, params;
      if (priorityFilter !== undefined) {
        sql =
          "SELECT * FROM support_tickets " +
          "WHERE assigned_operator_id IS NULL AND status NOT IN ('resolved', 'closed') " +
          "AND priority = ?1 " +
          "ORDER BY last_action_at ASC";
        params = [priorityFilter];
      } else {
        sql =
          "SELECT * FROM support_tickets " +
          "WHERE assigned_operator_id IS NULL AND status NOT IN ('resolved', 'closed') " +
          "ORDER BY CASE priority " +
          "  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 " +
          "  WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, " +
          "last_action_at ASC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows.map(_hydrate);
    },

    // Customer-account-scoped list — every ticket whose `customer_id`
    // matches, newest-opened first, optionally narrowed to one status.
    // Keyed on the row's `customer_id` (NOT the email hash) so the
    // storefront, which holds only the session customer id (the raw
    // email is never on disk), can list + ownership-gate a signed-in
    // shopper's tickets without re-deriving the email hash. Composes the
    // same id / status / limit validators as the rest of the surface, and
    // (like listForCustomer) returns `{ rows, next_cursor }` on the
    // (opened_at DESC, id DESC) tuple so a caller that needs the customer's
    // COMPLETE ticket set — e.g. the subject-access export, which keys on
    // customer_id and has no email to drive listForCustomer — can page to
    // the end instead of stopping at the first `limit`.
    listByCustomerId: async function (customerId, listOpts) {
      customerId = _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      var limit = _limit(listOpts.limit);
      var cursorVals = _decodeCursor(listOpts.cursor, "listByCustomerId");
      var where  = ["customer_id = ?1"];
      var params = [customerId];
      var idx    = 2;
      if (listOpts.status_filter != null) {
        where.push("status = ?" + idx);
        params.push(_status(listOpts.status_filter, "status_filter"));
        idx += 1;
      }
      if (cursorVals) {
        where.push(
          "(opened_at < ?" + idx + " OR " +
          "(opened_at = ?" + idx + " AND id < ?" + (idx + 1) + "))"
        );
        params.push(cursorVals[0], cursorVals[1]);
        idx += 2;
      }
      params.push(limit);
      var sql = "SELECT * FROM support_tickets WHERE " + where.join(" AND ") +
                " ORDER BY opened_at DESC, id DESC LIMIT ?" + idx;
      var r = await query(sql, params);
      var rows = r.rows.map(_hydrate);
      return { rows: rows, next_cursor: _encodeNext(rows, limit) };
    },

    // Operator queue across every assignment state — newest-stale first
    // (oldest last_action_at), optionally narrowed to one status. The
    // status filter drives the admin console's status chips; absent a
    // filter it surfaces the whole board (every status, including
    // resolved / closed) so the operator can audit history, capped at
    // `limit`.
    list: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = _limit(listOpts.limit);
      var where  = [];
      var params = [];
      var idx    = 1;
      if (listOpts.status_filter != null) {
        where.push("status = ?" + idx);
        params.push(_status(listOpts.status_filter, "status_filter"));
        idx += 1;
      }
      params.push(limit);
      var sql = "SELECT * FROM support_tickets" +
                (where.length ? " WHERE " + where.join(" AND ") : "") +
                " ORDER BY CASE priority " +
                "  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 " +
                "  WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, " +
                "last_action_at ASC LIMIT ?" + idx;
      var r = await query(sql, params);
      return r.rows.map(_hydrate);
    },

    // Full thread view — ticket + every message in created_at ASC
    // order so the caller can render the conversation top-to-bottom.
    thread: async function (ticketId) {
      ticketId = _uuid(ticketId, "ticket_id");
      var ticket = await _refresh(ticketId);
      if (!ticket) {
        var err = new Error("supportTickets.thread: ticket " + ticketId + " not found");
        err.code = "SUPPORT_TICKET_NOT_FOUND";
        throw err;
      }
      var msgs = (await query(
        "SELECT * FROM support_messages WHERE ticket_id = ?1 ORDER BY created_at ASC, id ASC",
        [ticketId],
      )).rows;
      return { ticket: ticket, messages: msgs };
    },

    // Scheduler-callable: surface every open ticket whose SLA budget
    // has elapsed since `last_action_at`. Closed / resolved tickets
    // never breach. Returned rows are decorated with `sla_budget_ms`
    // + `sla_elapsed_ms` so the alert pipeline can sort / batch by
    // severity.
    slaCheck: async function () {
      var now = _now();
      var sql =
        "SELECT * FROM support_tickets " +
        "WHERE status NOT IN ('resolved', 'closed')";
      var r = await query(sql, []);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var t = _hydrate(r.rows[i]);
        var budget = SLA_MS[t.priority];
        if (budget == null) continue;
        var elapsed = now - t.last_action_at;
        if (elapsed > budget) {
          t.sla_budget_ms  = budget;
          t.sla_elapsed_ms = elapsed;
          out.push(t);
        }
      }
      return out;
    },

    // Operator-dashboard aggregates over a closed time window:
    //   - per-category ticket counts (opened_at in [from, to])
    //   - average first-response-time (ms)
    //   - resolution rate (resolved / opened, 0..1)
    //   - escalation rate (count of waiting_customer -> in_progress
    //     OR resolved -> reopened transitions, divided by opened)
    metrics: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("supportTickets.metrics: input object required");
      }
      var from = input.from;
      var to   = input.to;
      _timestampRange(from, to, "metrics");

      var openedRows = (await query(
        "SELECT category, opened_at, first_response_at, resolved_at " +
        "FROM support_tickets WHERE opened_at >= ?1 AND opened_at <= ?2",
        [from, to],
      )).rows;

      var perCategory = {};
      for (var i = 0; i < ALLOWED_CATEGORIES.length; i += 1) {
        perCategory[ALLOWED_CATEGORIES[i]] = 0;
      }
      var firstResponseSamples = 0;
      var firstResponseTotal   = 0;
      var resolvedCount        = 0;
      for (var j = 0; j < openedRows.length; j += 1) {
        var row = openedRows[j];
        if (perCategory[row.category] != null) perCategory[row.category] += 1;
        if (row.first_response_at != null) {
          firstResponseSamples += 1;
          firstResponseTotal   += row.first_response_at - row.opened_at;
        }
        if (row.resolved_at != null) resolvedCount += 1;
      }

      var openedCount = openedRows.length;
      var avgFirstResponseMs = firstResponseSamples > 0
        ? Math.round(firstResponseTotal / firstResponseSamples)
        : null;
      var resolutionRate = openedCount > 0
        ? resolvedCount / openedCount
        : 0;

      // Escalations: transitions back into `in_progress` from
      // `waiting_customer` OR into `reopened` from `resolved`, on
      // tickets opened in the window. Joining via subquery keeps the
      // logic portable across the in-memory test DB and D1.
      var escRows = (await query(
        "SELECT COUNT(*) AS c FROM support_status_history h " +
        "WHERE ((h.from_status = 'waiting_customer' AND h.to_status = 'in_progress') " +
        "    OR (h.from_status = 'resolved'         AND h.to_status = 'reopened')) " +
        "  AND h.ticket_id IN (" +
        "    SELECT id FROM support_tickets WHERE opened_at >= ?1 AND opened_at <= ?2" +
        "  )",
        [from, to],
      )).rows;
      var escalationCount = escRows[0] ? Number(escRows[0].c) : 0;
      var escalationRate = openedCount > 0
        ? escalationCount / openedCount
        : 0;

      return {
        from:                   from,
        to:                     to,
        opened_count:           openedCount,
        per_category:           perCategory,
        avg_first_response_ms:  avgFirstResponseMs,
        resolution_rate:        resolutionRate,
        escalation_count:       escalationCount,
        escalation_rate:        escalationRate,
      };
    },
  };
}

module.exports = {
  create:             create,
  MAX_SUBJECT_LEN:    MAX_SUBJECT_LEN,
  MAX_BODY_LEN:       MAX_BODY_LEN,
  MAX_TAG_COUNT:      MAX_TAG_COUNT,
  MAX_TAG_LEN:        MAX_TAG_LEN,
  MAX_REASON_LEN:     MAX_REASON_LEN,
  MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
  ALLOWED_AUTHORS:    ALLOWED_AUTHORS.slice(),
  ALLOWED_CATEGORIES: ALLOWED_CATEGORIES.slice(),
  ALLOWED_PRIORITIES: ALLOWED_PRIORITIES.slice(),
  ALLOWED_STATUSES:   ALLOWED_STATUSES.slice(),
  SLA_MS:             Object.assign({}, SLA_MS),
};
