"use strict";
/**
 * @module shop.returns
 * @title  Returns primitive — RMA workflow for post-purchase claims
 *
 * @intro
 *   A return_authorizations row tracks one customer-initiated claim
 *   against an `orders` row. The lifecycle is a five-state machine
 *   walked here at the application tier (the order primitive owns
 *   the b.fsm-driven order lifecycle; an RMA is a sibling record
 *   keyed by `order_id`, not a state on the order itself):
 *
 *       pending  ─request───►  approved ─markReceived───► received
 *                  └────►  rejected (terminal)               │
 *       approved ────────────────────►  rejected             │
 *                                                            ▼
 *                                                       refund → refunded
 *
 *   `rma_code` is an operator-readable identifier (`RMA-YYMMDD-AAAAA`)
 *   surfaced to the customer on the return-label email. The
 *   `AAAAA` segment is 5 characters from the ambiguity-free alphabet
 *   `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/I/1 — same alphabet
 *   gift-card codes use, for the same reason). Code generation
 *   uses `b.crypto.generateBytes` (SHAKE256 over OS-RNG) so the
 *   draw stays unguessable even if the OS RNG has a transient
 *   weakness; the unique index on `rma_code` surfaces the rare
 *   collision as an INSERT failure the request layer retries.
 *
 *   `listForCustomer` paginates the customer's RMA history with an
 *   HMAC-tagged cursor (`b.pagination.encodeCursor`) so an
 *   operator-controlled secret prevents cursor forgery / replay
 *   across deployments. The cursor matches the shape used by
 *   order.listForCustomer for consistency.
 *
 *   Composition:
 *     var ret = bShop.returns.create({ query: q });
 *     var { id, rma_code } = await ret.request({
 *       order_id: o.id, reason: "defective",
 *       lines: [{ sku: "WIDGET-1", qty: 1 }],
 *     });
 *     await ret.approve(id, { refund_amount_minor: 4999 });
 *     await ret.markReceived(id);
 *     await ret.refund(id);
 *
 * @related b.crypto.generateBytes, b.pagination.encodeCursor, b.uuid.v7
 */

var b = require("./index").framework;

// ---- constants ----------------------------------------------------------

var REASONS = [
  "defective",
  "wrong-item",
  "not-as-described",
  "no-longer-needed",
  "damaged-in-transit",
  "other",
];

var STATUSES = ["pending", "approved", "received", "refunded", "rejected"];

// Same ambiguity-free alphabet as gift-card codes: 32 glyphs, no
// 0/O/I/1. 256 % 32 === 0 so each random byte modulo-32 lands on a
// uniform draw (no rejection sampling needed).
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var CODE_LEN      = 5;
// RMA-YYMMDD-AAAAA — date prefix groups codes per day for operator
// recognition; the 5-char tail (32^5 ≈ 33.5M) keeps collisions
// vanishingly rare per day.
var CODE_FULL_RE = /^RMA-\d{6}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

var MAX_NOTE_LEN     = 4096;
var MAX_DETAIL_LEN   = 1024;
var MAX_LIST_LIMIT   = 100;
var DEFAULT_LIST_LIMIT = 20;

// Pagination orderKey — must match the shape on the wire so a
// tampered cursor (different orderKey) is rejected by
// decodeCursor's HMAC-tagged state check.
var RMA_ORDER_KEY = ["created_at:desc", "id:desc"];

// State transition graph. Encoded as a plain map so the validator
// reads straight; no b.fsm dependency because the surface is small
// (5 states, 4 events) and per-event setters need to touch
// different timestamp columns anyway.
var TRANSITIONS = {
  pending:  { approve: "approved",  reject: "rejected" },
  approved: { markReceived: "received", reject: "rejected" },
  received: { refund:  "refunded" },
  refunded: {},
  rejected: {},
};

var TERMINAL_STATES = Object.freeze(["refunded", "rejected"]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("returns: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _reason(r) {
  if (typeof r !== "string" || REASONS.indexOf(r) === -1) {
    throw new TypeError("returns: reason must be one of " + REASONS.join(", "));
  }
  return r;
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("returns: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _positiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("returns: " + label + " must be a positive integer");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("returns: " + label + " must be a non-negative integer (minor units)");
  }
  return n;
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("returns: currency must be 3-letter uppercase ISO 4217");
  }
  return c;
}

function _boundedString(s, label, maxLen) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("returns: " + label + " must be a string");
  }
  if (s.length > maxLen) {
    throw new TypeError("returns: " + label + " must be <= " + maxLen + " characters");
  }
  // Refuse control bytes — same posture as b.guardEmail's strict
  // profile. Newlines + tabs are allowed since operator notes are
  // multi-line free-form.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("returns: " + label + " contains control bytes");
  }
  return s;
}

function _sku(s) {
  if (typeof s !== "string" || !s.length || s.length > 128) {
    throw new TypeError("returns: line sku must be a non-empty string <= 128 chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("returns: line sku contains control bytes");
  }
  return s;
}

function _epochOrNull(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts <= 0) {
    throw new TypeError("returns: " + label + " must be a positive integer epoch-ms or null");
  }
  return ts;
}

function _now() { return Date.now(); }

// ---- rma_code generation ------------------------------------------------

// YYMMDD prefix from epoch-ms, UTC. Stable per-day grouping so
// operators triaging a support ticket can spot same-day cohorts.
function _datePrefix(epochMs) {
  var d = new Date(epochMs);
  var yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  var mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  var dd = String(d.getUTCDate()).padStart(2, "0");
  return yy + mm + dd;
}

function _randomTail() {
  var buf = b.crypto.generateBytes(CODE_LEN);
  var out = "";
  for (var i = 0; i < CODE_LEN; i += 1) {
    out += CODE_ALPHABET.charAt(buf[i] & 31);
  }
  return out;
}

function _generateCode(epochMs) {
  return "RMA-" + _datePrefix(epochMs) + "-" + _randomTail();
}

function _canonicalCode(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("returns: rma_code must be a non-empty string");
  }
  var up = input.toUpperCase().trim();
  if (!CODE_FULL_RE.test(up)) {
    throw new TypeError("returns: rma_code must match RMA-YYMMDD-AAAAA");
  }
  return up;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors for listForCustomer are HMAC-tagged via
  // b.pagination so an operator can't hand-craft one to skip past a
  // hidden RMA or replay across deployments. Same shape as
  // order.listForCustomer.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("returns.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "returns-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Hydrate a full RMA + its lines. Internal helper — `get` and
  // `byCode` both share this so the wire shape stays consistent.
  async function _hydrate(row) {
    if (!row) return null;
    var lines = (await query(
      "SELECT * FROM return_lines WHERE rma_id = ?1 ORDER BY id ASC",
      [row.id],
    )).rows;
    row.lines = lines;
    return row;
  }

  return {
    REASONS:         REASONS,
    STATUSES:        STATUSES,
    TERMINAL_STATES: TERMINAL_STATES,
    CODE_ALPHABET:   CODE_ALPHABET,

    request: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("returns.request: input object required");
      }
      _uuid(input.order_id, "order_id");
      if (input.customer_id != null) _uuid(input.customer_id, "customer_id");
      _reason(input.reason);
      var reasonDetail  = _boundedString(input.reason_detail,  "reason_detail",  MAX_DETAIL_LEN);
      var customerNotes = _boundedString(input.customer_notes, "customer_notes", MAX_NOTE_LEN);
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new TypeError("returns.request: lines must be a non-empty array");
      }
      for (var li = 0; li < input.lines.length; li += 1) {
        var l = input.lines[li];
        if (!l || typeof l !== "object") {
          throw new TypeError("returns.request: lines[" + li + "] must be an object");
        }
        _sku(l.sku);
        _positiveInt(l.qty, "lines[" + li + "].qty");
        if (l.order_line_id != null) _uuid(l.order_line_id, "lines[" + li + "].order_line_id");
        if (l.reason != null && typeof l.reason !== "string") {
          throw new TypeError("returns.request: lines[" + li + "].reason must be a string");
        }
      }

      // INSERT-with-retry on rma_code collision. The 32^5 ≈ 33.5M
      // per-day tail space makes collisions vanishingly rare, but
      // the UNIQUE index will surface one as an SQLITE_CONSTRAINT
      // we recover from by re-drawing the tail. Cap retries so a
      // pathological RNG failure (or a clock stuck on one ms across
      // a busy day) doesn't loop forever.
      var id = b.uuid.v7();
      var ts = _now();
      var code = null;
      var maxAttempts = 5;
      for (var attempt = 0; attempt < maxAttempts; attempt += 1) {
        var candidate = _generateCode(ts);
        try {
          await query(
            "INSERT INTO return_authorizations " +
            "(id, order_id, customer_id, rma_code, reason, reason_detail, status, " +
            "refund_amount_minor, refund_currency, customer_notes, operator_notes, " +
            "created_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, 'USD', ?7, '', ?8, ?8)",
            [
              id, input.order_id, input.customer_id || null, candidate,
              input.reason, reasonDetail, customerNotes, ts,
            ],
          );
          code = candidate;
          break;
        } catch (e) {
          var msg = (e && e.message) || "";
          if (/UNIQUE|constraint/i.test(msg) && attempt < maxAttempts - 1) {
            continue;
          }
          throw e;
        }
      }
      if (code == null) {
        throw new Error("returns.request: failed to generate unique rma_code after " + maxAttempts + " attempts");
      }

      for (var i = 0; i < input.lines.length; i += 1) {
        var ln = input.lines[i];
        await query(
          "INSERT INTO return_lines (id, rma_id, order_line_id, sku, qty, reason, " +
          "amount_minor, amount_currency) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'USD')",
          [
            b.uuid.v7(), id, ln.order_line_id || null,
            ln.sku, ln.qty, ln.reason || null,
          ],
        );
      }

      return { id: id, rma_code: code, status: "pending" };
    },

    approve: async function (rmaId, input) {
      _uuid(rmaId, "rma id");
      if (!input || typeof input !== "object") {
        throw new TypeError("returns.approve: input object required");
      }
      _nonNegInt(input.refund_amount_minor, "refund_amount_minor");
      var refundCurrency = input.refund_currency == null ? "USD" : _currency(input.refund_currency);
      var operatorNotes  = _boundedString(input.operator_notes, "operator_notes", MAX_NOTE_LEN);

      var current = await this._currentStatus(rmaId);
      _assertTransition(current, "approve");

      var ts = _now();
      await query(
        "UPDATE return_authorizations SET status = 'approved', " +
        "refund_amount_minor = ?1, refund_currency = ?2, approved_at = ?3, " +
        "operator_notes = CASE WHEN ?4 = '' THEN operator_notes ELSE ?4 END, " +
        "updated_at = ?3 WHERE id = ?5",
        [input.refund_amount_minor, refundCurrency, ts, operatorNotes, rmaId],
      );
      return await this.get(rmaId);
    },

    markReceived: async function (rmaId, input) {
      _uuid(rmaId, "rma id");
      input = input || {};
      var receivedAt    = _epochOrNull(input.received_at, "received_at");
      var operatorNotes = _boundedString(input.operator_notes, "operator_notes", MAX_NOTE_LEN);

      var current = await this._currentStatus(rmaId);
      _assertTransition(current, "markReceived");

      var ts = _now();
      var rxAt = receivedAt == null ? ts : receivedAt;
      await query(
        "UPDATE return_authorizations SET status = 'received', " +
        "received_at = ?1, " +
        "operator_notes = CASE WHEN ?2 = '' THEN operator_notes ELSE ?2 END, " +
        "updated_at = ?3 WHERE id = ?4",
        [rxAt, operatorNotes, ts, rmaId],
      );
      return await this.get(rmaId);
    },

    refund: async function (rmaId, input) {
      _uuid(rmaId, "rma id");
      input = input || {};
      var refundedAt    = _epochOrNull(input.refunded_at, "refunded_at");
      var operatorNotes = _boundedString(input.operator_notes, "operator_notes", MAX_NOTE_LEN);

      var current = await this._currentStatus(rmaId);
      _assertTransition(current, "refund");

      var ts = _now();
      var rfAt = refundedAt == null ? ts : refundedAt;
      await query(
        "UPDATE return_authorizations SET status = 'refunded', " +
        "refunded_at = ?1, " +
        "operator_notes = CASE WHEN ?2 = '' THEN operator_notes ELSE ?2 END, " +
        "updated_at = ?3 WHERE id = ?4",
        [rfAt, operatorNotes, ts, rmaId],
      );
      return await this.get(rmaId);
    },

    reject: async function (rmaId, input) {
      _uuid(rmaId, "rma id");
      if (!input || typeof input !== "object") {
        throw new TypeError("returns.reject: input object required");
      }
      if (typeof input.rejected_reason !== "string" || !input.rejected_reason.length) {
        throw new TypeError("returns.reject: rejected_reason must be a non-empty string");
      }
      var rejectedReason = _boundedString(input.rejected_reason, "rejected_reason", MAX_DETAIL_LEN);
      var operatorNotes  = _boundedString(input.operator_notes,  "operator_notes",  MAX_NOTE_LEN);

      var current = await this._currentStatus(rmaId);
      _assertTransition(current, "reject");

      var ts = _now();
      await query(
        "UPDATE return_authorizations SET status = 'rejected', " +
        "rejected_at = ?1, rejected_reason = ?2, " +
        "operator_notes = CASE WHEN ?3 = '' THEN operator_notes ELSE ?3 END, " +
        "updated_at = ?1 WHERE id = ?4",
        [ts, rejectedReason, operatorNotes, rmaId],
      );
      return await this.get(rmaId);
    },

    get: async function (rmaId) {
      _uuid(rmaId, "rma id");
      var r = await query(
        "SELECT * FROM return_authorizations WHERE id = ?1",
        [rmaId],
      );
      return await _hydrate(r.rows[0] || null);
    },

    // The moderation events legal from a given status, as {on, to} —
    // drives the action buttons on the operator return-detail page. A
    // terminal status returns []. Synchronous (pure lookup over the
    // transition table). `on` is the API method name (approve / reject /
    // markReceived / refund).
    transitionsFrom: function (status) {
      var edges = TRANSITIONS[status] || {};
      return Object.keys(edges).map(function (on) { return { on: on, to: edges[on] }; });
    },

    byCode: async function (rmaCode) {
      var canonical = _canonicalCode(rmaCode);
      var r = await query(
        "SELECT * FROM return_authorizations WHERE rma_code = ?1",
        [canonical],
      );
      return await _hydrate(r.rows[0] || null);
    },

    listForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var r = await query(
        "SELECT * FROM return_authorizations WHERE order_id = ?1 " +
        "ORDER BY created_at DESC, id DESC",
        [orderId],
      );
      var rows = r.rows;
      for (var i = 0; i < rows.length; i += 1) {
        await _hydrate(rows[i]);
      }
      return rows;
    },

    listForCustomer: async function (customerId, listOpts) {
      _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? DEFAULT_LIST_LIMIT : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("returns.listForCustomer: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var statusFilter = null;
      if (listOpts.status != null) {
        statusFilter = _status(listOpts.status);
      }
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("returns.listForCustomer: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(RMA_ORDER_KEY)) {
            throw new TypeError("returns.listForCustomer: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("returns.listForCustomer: cursor — " + (e && e.message || "malformed"));
        }
      }

      var sql, params;
      if (cursorVals && statusFilter) {
        sql = "SELECT * FROM return_authorizations WHERE customer_id = ?1 AND status = ?2 AND " +
              "(created_at < ?3 OR (created_at = ?3 AND id < ?4)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?5";
        params = [customerId, statusFilter, cursorVals[0], cursorVals[1], limit];
      } else if (cursorVals) {
        sql = "SELECT * FROM return_authorizations WHERE customer_id = ?1 AND " +
              "(created_at < ?2 OR (created_at = ?2 AND id < ?3)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?4";
        params = [customerId, cursorVals[0], cursorVals[1], limit];
      } else if (statusFilter) {
        sql = "SELECT * FROM return_authorizations WHERE customer_id = ?1 AND status = ?2 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?3";
        params = [customerId, statusFilter, limit];
      } else {
        sql = "SELECT * FROM return_authorizations WHERE customer_id = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [customerId, limit];
      }
      var rows = (await query(sql, params)).rows;
      for (var i = 0; i < rows.length; i += 1) {
        await _hydrate(rows[i]);
      }
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: RMA_ORDER_KEY,
          vals:     [last.created_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    listByStatus: async function (status, listOpts) {
      var statusFilter = _status(status);
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? DEFAULT_LIST_LIMIT : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("returns.listByStatus: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("returns.listByStatus: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(RMA_ORDER_KEY)) {
            throw new TypeError("returns.listByStatus: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("returns.listByStatus: cursor — " + (e && e.message || "malformed"));
        }
      }

      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM return_authorizations WHERE status = ?1 AND " +
              "(created_at < ?2 OR (created_at = ?2 AND id < ?3)) " +
              "ORDER BY created_at DESC, id DESC LIMIT ?4";
        params = [statusFilter, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM return_authorizations WHERE status = ?1 " +
              "ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [statusFilter, limit];
      }
      var rows = (await query(sql, params)).rows;
      for (var i = 0; i < rows.length; i += 1) {
        await _hydrate(rows[i]);
      }
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: RMA_ORDER_KEY,
          vals:     [last.created_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    summaryForOperator: async function (input) {
      input = input || {};
      var from = _epochOrNull(input.from, "from");
      var to   = _epochOrNull(input.to,   "to");
      var statusFilter = null;
      if (input.status != null) statusFilter = _status(input.status);

      var where = [];
      var params = [];
      var idx = 1;
      if (from != null) { where.push("created_at >= ?" + idx); params.push(from); idx += 1; }
      if (to   != null) { where.push("created_at <  ?" + idx); params.push(to);   idx += 1; }
      if (statusFilter) { where.push("status = ?" + idx);     params.push(statusFilter); idx += 1; }
      var whereSql = where.length ? (" WHERE " + where.join(" AND ")) : "";

      // counts_by_status holds every status seen in the window, even
      // when an explicit status filter is supplied (the filter just
      // narrows the population).
      var statusRows = (await query(
        "SELECT status, COUNT(*) AS n FROM return_authorizations" + whereSql +
        " GROUP BY status",
        params,
      )).rows;

      var countsByStatus = {};
      for (var s = 0; s < STATUSES.length; s += 1) countsByStatus[STATUSES[s]] = 0;
      var total = 0;
      for (var r = 0; r < statusRows.length; r += 1) {
        var row = statusRows[r];
        countsByStatus[row.status] = Number(row.n);
        total += Number(row.n);
      }

      // Refund value totals — sum only over RMAs that actually
      // refunded (or are approved-and-pending-refund) so the
      // operator sees committed-payout vs pending-payout. Currency
      // mix is reported per-bucket so a multi-currency shop doesn't
      // collapse to a meaningless single number.
      var refundedRows = (await query(
        "SELECT refund_currency, SUM(refund_amount_minor) AS total FROM return_authorizations" +
        (whereSql ? whereSql + " AND status = 'refunded'" : " WHERE status = 'refunded'") +
        " GROUP BY refund_currency",
        params,
      )).rows;
      var pendingRows = (await query(
        "SELECT refund_currency, SUM(refund_amount_minor) AS total FROM return_authorizations" +
        (whereSql ? whereSql + " AND status IN ('approved','received')" : " WHERE status IN ('approved','received')") +
        " GROUP BY refund_currency",
        params,
      )).rows;

      function _byCurrency(rows) {
        var out = {};
        for (var i = 0; i < rows.length; i += 1) {
          out[rows[i].refund_currency] = Number(rows[i].total) || 0;
        }
        return out;
      }

      return {
        total_count:        total,
        counts_by_status:   countsByStatus,
        refunded_by_currency: _byCurrency(refundedRows),
        pending_by_currency:  _byCurrency(pendingRows),
      };
    },

    // Internal helper — exported (underscored) for test introspection.
    // Returns the current status row or throws if the RMA doesn't
    // exist. Used by every transition method so the not-found and
    // illegal-transition refusals stay shape-consistent.
    _currentStatus: async function (rmaId) {
      var r = await query(
        "SELECT status FROM return_authorizations WHERE id = ?1",
        [rmaId],
      );
      if (!r.rows.length) {
        var miss = new TypeError("returns: rma " + rmaId + " not found");
        miss.code = "RMA_NOT_FOUND";
        throw miss;
      }
      return r.rows[0].status;
    },
  };
}

// Refuse transitions outside the FSM graph. Surfaced as a typed
// error with `.code = 'RMA_TRANSITION_REFUSED'` so callers can
// distinguish "you tried to refund a pending RMA" from "you passed
// a bad UUID".
function _assertTransition(currentStatus, event) {
  var allowed = TRANSITIONS[currentStatus];
  if (!allowed || !allowed[event]) {
    var err = new Error(
      "returns: transition '" + event + "' refused from state '" + currentStatus + "'"
    );
    err.code = "RMA_TRANSITION_REFUSED";
    throw err;
  }
  return allowed[event];
}

module.exports = {
  create:          create,
  REASONS:         REASONS,
  STATUSES:        STATUSES,
  TERMINAL_STATES: TERMINAL_STATES,
  CODE_ALPHABET:   CODE_ALPHABET,
};
