"use strict";
/**
 * @module shop.returnLabels
 * @title  Return-shipping labels — operator-funded return-label flow
 *
 * @intro
 *   A return_labels row is issued against an approved return_authorizations
 *   row and tracks the carrier-scan timeline back to the merchant. The
 *   lifecycle is a small FSM walked at the application tier:
 *
 *       issued ──markShipped──► shipped ──markInTransit──► in_transit
 *                                                              │
 *                                                       markDelivered
 *                                                              ▼
 *                                                          delivered
 *
 *       (any non-delivered state) ──markException──► exception
 *
 *   `issueLabel` refuses unless the underlying return is in `approved`
 *   status — issuing a pre-paid label on a still-pending or already-
 *   rejected claim is a category error that wastes operator postage
 *   and confuses customers.
 *
 *   `markDelivered` is the integration boundary back into the returns
 *   primitive: when the carrier confirms delivery to the merchant
 *   warehouse, the underlying return flips to `received` via the
 *   injected `returns.markReceived` callback. The returns FSM owns
 *   the customer-facing refund flow from there, so the two
 *   primitives compose without duplicating state.
 *
 *   `markInTransit` accepts repeated carrier-scan events from the
 *   `in_transit` state — a parcel passing through three hub scans
 *   produces three timeline rows, not three FSM-refused errors.
 *
 *   `exception` is terminal at this tier (lost / damaged / refused);
 *   operator remediation (re-issue label, file carrier dispute)
 *   happens outside the FSM.
 *
 *   Composition:
 *     var labels = bShop.returnLabels.create({
 *       query:   q,
 *       returns: bShop.returns.create({ query: q }),
 *     });
 *     var lab = await labels.issueLabel({
 *       return_id:       rma.id,
 *       carrier:         "USPS",
 *       service_level:   "Ground Advantage",
 *       weight_grams:    340,
 *       label_url:       "https://labels.example.com/x.pdf",
 *       tracking_number: "9400111202509876543210",
 *       cost_minor:      795,
 *       currency:        "USD",
 *     });
 *     await labels.markShipped({ label_id: lab.id });
 *     await labels.markInTransit({ label_id: lab.id, location: "LAX hub" });
 *     await labels.markDelivered({ label_id: lab.id });
 *     // RMA row now in 'received' status.
 *
 * @related b.safeUrl, b.fsm, b.uuid.v7
 */

var b = require("./index").framework;

// ---- constants ----------------------------------------------------------

var STATUSES = ["issued", "shipped", "in_transit", "delivered", "exception"];
var TERMINAL_STATES = Object.freeze(["delivered", "exception"]);

// FSM transition graph. Encoded as a plain map for the same reason
// the returns primitive does: per-event setters touch different
// timestamp columns (shipped_at on markShipped, delivered_at on
// markDelivered), and b.fsm's restore-per-call dance doesn't earn
// its keep when the per-event work is already custom.
//
// markInTransit deliberately accepts re-entry from in_transit so a
// multi-hop carrier journey produces a row-per-scan timeline
// without spurious FSM refusals.
var TRANSITIONS = {
  issued:     { markShipped: "shipped",   markException: "exception" },
  shipped:    { markInTransit: "in_transit", markDelivered: "delivered", markException: "exception" },
  in_transit: { markInTransit: "in_transit", markDelivered: "delivered", markException: "exception" },
  delivered:  {},
  exception:  {},
};

var CARRIER_MAX_LEN       = 64;
var SERVICE_LEVEL_MAX_LEN = 128;
var TRACKING_MAX_LEN      = 128;
var LOCATION_MAX_LEN      = 256;
var EXCEPTION_MAX_LEN     = 256;
var MAX_URL_LEN           = 2048;
var MAX_LIST_LIMIT        = 100;
var DEFAULT_LIST_LIMIT    = 20;

// Allowed return-authorization status when issuing a label. Listed
// here (not inlined) so the refusal message stays in sync if the
// returns primitive ever grows additional pre-approval states.
var ISSUABLE_RMA_STATUS = "approved";

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("returnLabels: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _boundedString(s, label, maxLen) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("returnLabels: " + label + " must be a non-empty string");
  }
  if (s.length > maxLen) {
    throw new TypeError("returnLabels: " + label + " must be <= " + maxLen + " characters");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("returnLabels: " + label + " contains control bytes");
  }
  return s;
}

function _optionalBoundedString(s, label, maxLen) {
  if (s == null) return null;
  return _boundedString(s, label, maxLen);
}

function _positiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("returnLabels: " + label + " must be a positive integer");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("returnLabels: " + label + " must be a non-negative integer");
  }
  return n;
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("returnLabels: currency must be 3-letter uppercase ISO 4217");
  }
  return c;
}

function _epochOrNull(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts <= 0) {
    throw new TypeError("returnLabels: " + label + " must be a positive integer epoch-ms or null");
  }
  return ts;
}

// label_url runs through b.safeUrl so a future carrier-API response
// can't smuggle a `javascript:` payload or a credentialed
// `https://user:pass@…` URL into the return-label email. HTTPS-only
// by default — operator can override by passing through their own
// already-validated URL, but the storage column rejects malformed
// shapes regardless.
function _labelUrl(url) {
  if (typeof url !== "string" || !url.length) {
    throw new TypeError("returnLabels: label_url must be a non-empty string");
  }
  if (url.length > MAX_URL_LEN) {
    throw new TypeError("returnLabels: label_url must be <= " + MAX_URL_LEN + " characters");
  }
  try {
    b.safeUrl.parse(url, { allowedProtocols: b.safeUrl.ALLOW_HTTP_TLS });
  } catch (e) {
    throw new TypeError("returnLabels: label_url — " + (e && e.message || "invalid URL"));
  }
  return url;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var returns = opts.returns || null;

  // Refuse transitions outside the FSM graph. `.code` is set so the
  // request layer can distinguish a "you tried to mark a delivered
  // label as shipped" refusal from a "label not found" miss.
  function _assertTransition(currentStatus, event) {
    var allowed = TRANSITIONS[currentStatus];
    if (!allowed || !allowed[event]) {
      var err = new Error(
        "returnLabels: transition '" + event + "' refused from state '" + currentStatus + "'"
      );
      err.code = "RETURN_LABEL_TRANSITION_REFUSED";
      throw err;
    }
    return allowed[event];
  }

  async function _currentStatus(labelId) {
    var r = await query(
      "SELECT status FROM return_labels WHERE id = ?1",
      [labelId],
    );
    if (!r.rows.length) {
      var miss = new TypeError("returnLabels: label " + labelId + " not found");
      miss.code = "RETURN_LABEL_NOT_FOUND";
      throw miss;
    }
    return r.rows[0].status;
  }

  async function _appendEvent(labelId, eventType, detail, occurredAt) {
    await query(
      "INSERT INTO return_label_events (id, label_id, event_type, detail_json, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [
        b.uuid.v7(), labelId, eventType,
        JSON.stringify(detail || {}), occurredAt,
      ],
    );
  }

  return {
    STATUSES:        STATUSES,
    TERMINAL_STATES: TERMINAL_STATES,

    issueLabel: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("returnLabels.issueLabel: input object required");
      }
      _uuid(input.return_id, "return_id");
      _boundedString(input.carrier,         "carrier",         CARRIER_MAX_LEN);
      _boundedString(input.service_level,   "service_level",   SERVICE_LEVEL_MAX_LEN);
      _positiveInt(input.weight_grams,      "weight_grams");
      _labelUrl(input.label_url);
      _boundedString(input.tracking_number, "tracking_number", TRACKING_MAX_LEN);
      _nonNegInt(input.cost_minor,          "cost_minor");
      _currency(input.currency);

      // Refuse if the underlying RMA isn't approved. A pending claim
      // hasn't been triaged yet; a rejected claim should never
      // consume operator postage; a received/refunded claim already
      // has its physical leg complete.
      var rmaRow = (await query(
        "SELECT status FROM return_authorizations WHERE id = ?1",
        [input.return_id],
      )).rows[0];
      if (!rmaRow) {
        var miss = new TypeError("returnLabels.issueLabel: return " + input.return_id + " not found");
        miss.code = "RETURN_NOT_FOUND";
        throw miss;
      }
      if (rmaRow.status !== ISSUABLE_RMA_STATUS) {
        var err = new Error(
          "returnLabels.issueLabel: refused — return is '" + rmaRow.status +
          "', must be '" + ISSUABLE_RMA_STATUS + "'"
        );
        err.code = "RETURN_LABEL_ISSUE_REFUSED";
        throw err;
      }

      var issuedAt = _epochOrNull(input.issued_at, "issued_at");
      var id = b.uuid.v7();
      var ts = issuedAt == null ? _now() : issuedAt;
      await query(
        "INSERT INTO return_labels " +
        "(id, return_id, carrier, service_level, label_url, tracking_number, " +
        "status, cost_minor, currency, issued_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8, ?9)",
        [
          id, input.return_id, input.carrier, input.service_level,
          input.label_url, input.tracking_number,
          input.cost_minor, input.currency, ts,
        ],
      );
      await _appendEvent(id, "issued", {
        carrier:       input.carrier,
        service_level: input.service_level,
        weight_grams:  input.weight_grams,
        cost_minor:    input.cost_minor,
        currency:      input.currency,
      }, ts);
      return await this.getLabel(id);
    },

    markShipped: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("returnLabels.markShipped: input object required");
      }
      _uuid(input.label_id, "label_id");
      var shippedAt = _epochOrNull(input.shipped_at, "shipped_at");

      var current = await _currentStatus(input.label_id);
      _assertTransition(current, "markShipped");

      var stamp = shippedAt == null ? _now() : shippedAt;
      await query(
        "UPDATE return_labels SET status = 'shipped', shipped_at = ?1 WHERE id = ?2",
        [stamp, input.label_id],
      );
      // Event occurred_at follows the carrier-reported timestamp
      // when supplied — the timeline reflects when the customer
      // actually handed the parcel over, not when the row landed.
      await _appendEvent(input.label_id, "shipped", { shipped_at: stamp }, stamp);
      return await this.getLabel(input.label_id);
    },

    markInTransit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("returnLabels.markInTransit: input object required");
      }
      _uuid(input.label_id, "label_id");
      var location   = _optionalBoundedString(input.location,    "location",    LOCATION_MAX_LEN);
      var occurredAt = _epochOrNull(input.occurred_at, "occurred_at");

      var current = await _currentStatus(input.label_id);
      _assertTransition(current, "markInTransit");

      var stamp = occurredAt == null ? _now() : occurredAt;
      // Only flip the row to in_transit on the first scan after
      // shipped — subsequent scans append a timeline row but leave
      // the row state at in_transit (already there).
      if (current !== "in_transit") {
        await query(
          "UPDATE return_labels SET status = 'in_transit' WHERE id = ?1",
          [input.label_id],
        );
      }
      await _appendEvent(input.label_id, "in_transit", {
        location:    location,
        occurred_at: stamp,
      }, stamp);
      return await this.getLabel(input.label_id);
    },

    markDelivered: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("returnLabels.markDelivered: input object required");
      }
      _uuid(input.label_id, "label_id");
      var deliveredAt = _epochOrNull(input.delivered_at, "delivered_at");

      var current = await _currentStatus(input.label_id);
      _assertTransition(current, "markDelivered");

      // Need the return_id before we mutate, so the FSM callback to
      // the returns primitive can target the right RMA row.
      var row = (await query(
        "SELECT return_id FROM return_labels WHERE id = ?1",
        [input.label_id],
      )).rows[0];

      var stamp = deliveredAt == null ? _now() : deliveredAt;
      await query(
        "UPDATE return_labels SET status = 'delivered', delivered_at = ?1 WHERE id = ?2",
        [stamp, input.label_id],
      );
      await _appendEvent(input.label_id, "delivered", { delivered_at: stamp }, stamp);

      // Integration boundary: flip the underlying RMA to `received`.
      // Drop-silent on the callback failing — the carrier delivery
      // is a real-world fact that already landed in this DB; an RMA
      // FSM refusal (already received, terminal state) is not a
      // reason to reject the carrier scan. The timeline still shows
      // delivered, the operator can reconcile manually.
      if (returns && typeof returns.markReceived === "function") {
        try {
          await returns.markReceived(row.return_id, { received_at: stamp });
        } catch (_e) { /* drop-silent — by design */ }
      }
      return await this.getLabel(input.label_id);
    },

    markException: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("returnLabels.markException: input object required");
      }
      _uuid(input.label_id, "label_id");
      _boundedString(input.exception, "exception", EXCEPTION_MAX_LEN);
      var occurredAt = _epochOrNull(input.occurred_at, "occurred_at");

      var current = await _currentStatus(input.label_id);
      _assertTransition(current, "markException");

      var stamp = occurredAt == null ? _now() : occurredAt;
      await query(
        "UPDATE return_labels SET status = 'exception' WHERE id = ?1",
        [input.label_id],
      );
      await _appendEvent(input.label_id, "exception", {
        exception:   input.exception,
        occurred_at: stamp,
      }, stamp);
      return await this.getLabel(input.label_id);
    },

    getLabel: async function (labelId) {
      _uuid(labelId, "label_id");
      var r = await query(
        "SELECT * FROM return_labels WHERE id = ?1",
        [labelId],
      );
      return r.rows[0] || null;
    },

    labelForReturn: async function (returnId) {
      _uuid(returnId, "return_id");
      // Multiple labels per return are possible (e.g. re-issue after
      // exception) — return the most recently issued one so the
      // common "what's the operator's current label?" question is a
      // single call.
      var r = await query(
        "SELECT * FROM return_labels WHERE return_id = ?1 " +
        "ORDER BY issued_at DESC, id DESC LIMIT 1",
        [returnId],
      );
      return r.rows[0] || null;
    },

    pendingPickup: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? DEFAULT_LIST_LIMIT : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("returnLabels.pendingPickup: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var r = await query(
        "SELECT * FROM return_labels WHERE status = 'issued' " +
        "ORDER BY issued_at ASC, id ASC LIMIT ?1",
        [limit],
      );
      return r.rows;
    },

    inTransit: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? DEFAULT_LIST_LIMIT : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("returnLabels.inTransit: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var r = await query(
        "SELECT * FROM return_labels WHERE status IN ('shipped','in_transit') " +
        "ORDER BY issued_at ASC, id ASC LIMIT ?1",
        [limit],
      );
      return r.rows;
    },

    eventsForLabel: async function (labelId) {
      _uuid(labelId, "label_id");
      // ORDER BY (occurred_at, rowid) — within the same epoch-ms,
      // SQLite's rowid preserves insertion order so a same-tick
      // burst (issued + shipped + scan + delivered on a fast
      // runner) returns in the order the application appended them.
      // UUID v7's intra-ms randomness would otherwise scramble
      // ordering for events inside one tick.
      var r = await query(
        "SELECT * FROM return_label_events WHERE label_id = ?1 " +
        "ORDER BY occurred_at ASC, rowid ASC",
        [labelId],
      );
      return r.rows;
    },
  };
}

module.exports = {
  create:          create,
  STATUSES:        STATUSES,
  TERMINAL_STATES: TERMINAL_STATES,
};
