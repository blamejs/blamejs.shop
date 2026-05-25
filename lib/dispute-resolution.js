"use strict";
/**
 * @module shop.disputeResolution
 * @title  Dispute-resolution primitive — payment-processor chargeback
 *         / inquiry / pre-arbitration / arbitration lifecycle.
 *
 * @intro
 *   Customer-initiated refund requests run through the storefront's
 *   own refund lane (`refundPolicy` / `refundAutomation` / `returns`).
 *   Processor-initiated disputes are a different beast: the customer
 *   (or their bank) opens a chargeback directly with the processor,
 *   the processor notifies the operator via webhook, and the operator
 *   has a fixed window — typically 7-21 days depending on the network
 *   and the dispute kind — to either accept the dispute (concede the
 *   funds) or respond with evidence and fight it. Missing the
 *   deadline is an automatic loss.
 *
 *   This primitive holds the operator-facing state machine for that
 *   lane. It composes the optional `query` / `order` / `payment` /
 *   `customerRiskProfile` handles — none of them owned, all of them
 *   stubbable — and surfaces the operator-console reads:
 *
 *     var dr = bShop.disputeResolution.create({
 *       query:               q,
 *       order:               orders,    // optional — order lookup
 *       payment:             pay,       // optional — refund-on-accept
 *       customerRiskProfile: risk,      // optional — risk band hint
 *     });
 *
 *     await dr.recordDispute({
 *       dispute_id:   "dp_stripe_1",
 *       order_id:     "order-1",
 *       processor:    "stripe",
 *       kind:         "chargeback",
 *       amount_minor: 4500,
 *       currency:     "USD",
 *       reason_code:  "fraudulent",
 *       due_by:       Date.now() + 7 * 24 * 60 * 60 * 1000,
 *     });
 *
 *     await dr.addEvidence({
 *       dispute_id: "dp_stripe_1",
 *       kind:       "signed_proof_of_delivery",
 *       blob_ref:   "s3://evidence/order-1/pod.pdf",
 *     });
 *
 *     await dr.submitResponse({
 *       dispute_id: "dp_stripe_1",
 *       narrative:  "Order shipped to verified billing address ...",
 *     });
 *
 *     await dr.recordProcessorDecision({
 *       dispute_id: "dp_stripe_1",
 *       outcome:    "won",
 *     });
 *
 *   FSM (on `disputes.status`):
 *     open                                  recordDispute
 *     open       → submitted                submitResponse
 *     open       → accepted                 recordProcessorDecision(accepted)
 *     open       → lost                     recordProcessorDecision(lost) — deadline miss
 *     submitted  → won                      recordProcessorDecision(won)
 *     submitted  → lost                     recordProcessorDecision(lost)
 *     submitted  → escalated                recordProcessorDecision(escalated)
 *     lost       → written_off              markWriteoff
 *
 *   Surface:
 *     - recordDispute({ dispute_id, order_id, processor, kind,
 *                       amount_minor, currency, reason_code,
 *                       opened_at?, due_by? })
 *     - addEvidence({ dispute_id, kind, blob_ref, notes? })
 *     - submitResponse({ dispute_id, narrative })
 *     - recordProcessorDecision({ dispute_id, outcome,
 *                                 processor_decision_at? })
 *     - markWriteoff({ dispute_id, operator_id, reason })
 *     - getDispute(dispute_id)
 *     - disputesForOrder(order_id)
 *     - openDisputes({ processor?, kind?, limit? })
 *     - historyForDispute(dispute_id)
 *     - metricsForProcessor({ processor, from, to })
 *
 *   Storage:
 *     - disputes + dispute_evidence + dispute_responses
 *       (migration 0173_dispute_resolution.sql).
 *
 *   Monotonic clock: a per-factory monotonic timestamp ensures that
 *   two writes against the same dispute in the same millisecond
 *   carry strictly-increasing timestamps. The
 *   `(dispute_id, recorded_at ASC)` and
 *   `(dispute_id, submitted_at ASC)` indexes then return evidence and
 *   responses in deterministic order.
 *
 * @primitive disputeResolution
 * @related    refundAutomation, returns, payment, customerRiskProfile
 */

// ---- constants ----------------------------------------------------------

var MAX_DISPUTE_ID_LEN       = 128;
var MAX_ORDER_ID_LEN         = 128;
var MAX_PROCESSOR_LEN        = 64;
var MAX_REASON_CODE_LEN      = 64;
var MAX_NARRATIVE_LEN        = 16000;
var MAX_BLOB_REF_LEN         = 1024;
var MAX_NOTES_LEN            = 4000;
var MAX_OPERATOR_ID_LEN      = 128;
var MAX_WRITEOFF_REASON_LEN  = 1000;
var MAX_AMOUNT_MINOR         = 1000000000;     // $10,000,000.00 cap
var MAX_LIST_LIMIT           = 200;

var DISPUTE_ID_RE   = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var ORDER_ID_CTRL   = /[\x00-\x1f\x7f]/;
var PROCESSOR_RE    = /^[a-z0-9][a-z0-9_-]{0,63}$/;
var REASON_CODE_RE  = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
var CURRENCY_RE     = /^[A-Z]{3}$/;
var OPERATOR_ID_RE  = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

var KINDS = Object.freeze([
  "chargeback",
  "inquiry",
  "pre_arbitration",
  "arbitration",
]);

var EVIDENCE_KINDS = Object.freeze([
  "signed_proof_of_delivery",
  "customer_communication",
  "refund_policy",
  "receipt",
  "shipping_label",
  "customer_signature",
  "other",
]);

var OUTCOMES = Object.freeze([
  "won",
  "lost",
  "accepted",
  "escalated",
]);

var STATUSES = Object.freeze([
  "open",
  "submitted",
  "won",
  "lost",
  "accepted",
  "escalated",
  "written_off",
]);

var b = require("./vendor/blamejs");

// ---- validators ---------------------------------------------------------

function _disputeId(s) {
  if (typeof s !== "string" || !DISPUTE_ID_RE.test(s)) {
    throw new TypeError(
      "disputeResolution: dispute_id must match /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ (<= " +
      MAX_DISPUTE_ID_LEN + " chars)"
    );
  }
  return s;
}

function _orderId(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_ORDER_ID_LEN) {
    throw new TypeError(
      "disputeResolution: order_id must be a non-empty string <= " +
      MAX_ORDER_ID_LEN + " chars"
    );
  }
  if (ORDER_ID_CTRL.test(s)) {
    throw new TypeError("disputeResolution: order_id must not contain control bytes");
  }
  return s;
}

function _processor(s) {
  if (typeof s !== "string" || !PROCESSOR_RE.test(s)) {
    throw new TypeError(
      "disputeResolution: processor must match /^[a-z0-9][a-z0-9_-]*$/ (<= " +
      MAX_PROCESSOR_LEN + " chars)"
    );
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("disputeResolution: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _evidenceKind(s) {
  if (typeof s !== "string" || EVIDENCE_KINDS.indexOf(s) === -1) {
    throw new TypeError(
      "disputeResolution: evidence kind must be one of " + EVIDENCE_KINDS.join(", ")
    );
  }
  return s;
}

function _outcome(s) {
  if (typeof s !== "string" || OUTCOMES.indexOf(s) === -1) {
    throw new TypeError("disputeResolution: outcome must be one of " + OUTCOMES.join(", "));
  }
  return s;
}

function _amountMinor(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_AMOUNT_MINOR) {
    throw new TypeError(
      "disputeResolution: amount_minor must be an integer in [0, " +
      MAX_AMOUNT_MINOR + "]"
    );
  }
  return n;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError(
      "disputeResolution: currency must be a 3-letter ISO-4217 alpha code (e.g. 'USD')"
    );
  }
  return s;
}

function _reasonCode(s) {
  if (typeof s !== "string" || !REASON_CODE_RE.test(s)) {
    throw new TypeError(
      "disputeResolution: reason_code must match /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ (<= " +
      MAX_REASON_CODE_LEN + " chars)"
    );
  }
  return s;
}

function _narrative(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("disputeResolution: narrative must be a non-empty string");
  }
  if (s.length > MAX_NARRATIVE_LEN) {
    throw new TypeError(
      "disputeResolution: narrative length " + s.length +
      " exceeds cap " + MAX_NARRATIVE_LEN
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("disputeResolution: narrative must not contain control bytes");
  }
  return s;
}

function _blobRef(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("disputeResolution: blob_ref must be a non-empty string");
  }
  if (s.length > MAX_BLOB_REF_LEN) {
    throw new TypeError(
      "disputeResolution: blob_ref length " + s.length +
      " exceeds cap " + MAX_BLOB_REF_LEN
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("disputeResolution: blob_ref must not contain control bytes");
  }
  return s;
}

function _notesOpt(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("disputeResolution: notes must be a string when provided");
  }
  if (s.length > MAX_NOTES_LEN) {
    throw new TypeError(
      "disputeResolution: notes length " + s.length + " exceeds cap " + MAX_NOTES_LEN
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("disputeResolution: notes must not contain control bytes");
  }
  return s;
}

function _operatorId(s) {
  if (typeof s !== "string" || !OPERATOR_ID_RE.test(s)) {
    throw new TypeError(
      "disputeResolution: operator_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " +
      MAX_OPERATOR_ID_LEN + " chars)"
    );
  }
  return s;
}

function _writeoffReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("disputeResolution: writeoff reason must be a non-empty string");
  }
  if (s.length > MAX_WRITEOFF_REASON_LEN) {
    throw new TypeError(
      "disputeResolution: writeoff reason length " + s.length +
      " exceeds cap " + MAX_WRITEOFF_REASON_LEN
    );
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("disputeResolution: writeoff reason must not contain control bytes");
  }
  return s;
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "disputeResolution: " + label + " must be a non-negative integer epoch-ms"
    );
  }
  return n;
}

function _epochMsOpt(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _limit(n) {
  if (n == null) return 50;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError(
      "disputeResolution: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]"
    );
  }
  return n;
}

// ---- row hydration ------------------------------------------------------

function _hydrateDispute(r) {
  if (!r) return null;
  return {
    dispute_id:         r.dispute_id,
    order_id:           r.order_id,
    processor:          r.processor,
    kind:               r.kind,
    amount_minor:       Number(r.amount_minor),
    currency:           r.currency,
    reason_code:        r.reason_code,
    status:             r.status,
    outcome:            r.outcome == null ? null : r.outcome,
    opened_at:          Number(r.opened_at),
    due_by:             r.due_by == null ? null : Number(r.due_by),
    submitted_at:       r.submitted_at == null ? null : Number(r.submitted_at),
    decided_at:         r.decided_at == null ? null : Number(r.decided_at),
    written_off_at:     r.written_off_at == null ? null : Number(r.written_off_at),
    written_off_reason: r.written_off_reason == null ? null : r.written_off_reason,
    written_off_by:     r.written_off_by == null ? null : r.written_off_by,
    updated_at:         Number(r.updated_at),
  };
}

function _hydrateEvidence(r) {
  if (!r) return null;
  return {
    id:          r.id,
    dispute_id:  r.dispute_id,
    kind:        r.kind,
    blob_ref:    r.blob_ref,
    notes:       r.notes == null ? null : r.notes,
    recorded_at: Number(r.recorded_at),
  };
}

function _hydrateResponse(r) {
  if (!r) return null;
  return {
    id:           r.id,
    dispute_id:   r.dispute_id,
    narrative:    r.narrative,
    submitted_at: Number(r.submitted_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional composed handles. None owned; all stubbable. The
  // `order` handle is held for forward-compat order-snapshot reads;
  // `payment` is composed when the operator accepts a dispute and
  // wants the refund issued through the same flow; `customerRiskProfile`
  // is consulted by callers that want to enrich the dispute view with
  // a risk band but the primitive itself doesn't gate any behavior on
  // it. Keeping them in the factory signature locks the wiring shape
  // across future feature work.
  var orderHandle    = opts.order               || null;
  var paymentHandle  = opts.payment             || null;
  var riskHandle     = opts.customerRiskProfile || null;

  // Per-factory monotonic clock. Two writes against the same dispute
  // (record + addEvidence, or back-to-back evidence rows) in the same
  // wall-clock millisecond would otherwise tie on `recorded_at` and
  // make the `(dispute_id, recorded_at ASC)` index ambiguous.
  // Forward-leap when the wall clock outpaces the counter; otherwise
  // bump by 1ms so the sequence is strictly increasing per primitive
  // instance.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- internal helpers ---------------------------------------------

  async function _getDisputeRow(disputeId) {
    var r = (await query(
      "SELECT * FROM disputes WHERE dispute_id = ?1 LIMIT 1",
      [disputeId],
    )).rows[0];
    return r || null;
  }

  // ---- recordDispute ------------------------------------------------

  async function recordDispute(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("disputeResolution.recordDispute: input object required");
    }
    var disputeId = _disputeId(input.dispute_id);
    var orderId   = _orderId(input.order_id);
    var processor = _processor(input.processor);
    var kind      = _kind(input.kind);
    var amount    = _amountMinor(input.amount_minor);
    var currency  = _currency(input.currency);
    var reasonCd  = _reasonCode(input.reason_code);
    var openedAt  = input.opened_at == null ? _monotonicTs() : _epochMs(input.opened_at, "opened_at");
    var dueBy     = _epochMsOpt(input.due_by, "due_by");
    if (dueBy != null && dueBy < openedAt) {
      throw new TypeError("disputeResolution.recordDispute: due_by must be >= opened_at");
    }

    // Refuse redefine — disputes are identified by the processor's
    // dispute_id; a duplicate webhook should be deduped at the webhook
    // layer (use `getDispute` to test for existence before recording).
    var existing = await _getDisputeRow(disputeId);
    if (existing) {
      throw new TypeError(
        "disputeResolution.recordDispute: dispute_id " +
        JSON.stringify(disputeId) + " already exists"
      );
    }

    var ts = _monotonicTs();
    if (ts < openedAt) ts = openedAt;
    await query(
      "INSERT INTO disputes (dispute_id, order_id, processor, kind, amount_minor, " +
      "currency, reason_code, status, outcome, opened_at, due_by, submitted_at, " +
      "decided_at, written_off_at, written_off_reason, written_off_by, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', NULL, ?8, ?9, NULL, NULL, NULL, " +
      "NULL, NULL, ?10)",
      [
        disputeId, orderId, processor, kind, amount,
        currency, reasonCd, openedAt, dueBy, ts,
      ],
    );
    return _hydrateDispute(await _getDisputeRow(disputeId));
  }

  // ---- addEvidence --------------------------------------------------

  async function addEvidence(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("disputeResolution.addEvidence: input object required");
    }
    var disputeId = _disputeId(input.dispute_id);
    var kind      = _evidenceKind(input.kind);
    var blobRef   = _blobRef(input.blob_ref);
    var notes     = _notesOpt(input.notes);

    var dispute = await _getDisputeRow(disputeId);
    if (!dispute) {
      throw new TypeError(
        "disputeResolution.addEvidence: dispute_id " +
        JSON.stringify(disputeId) + " not found — call recordDispute first"
      );
    }
    // Evidence can be added while the dispute is open OR after it has
    // been submitted — operators sometimes find additional evidence
    // mid-response window and the processor's surface allows
    // supplementing. Refuse evidence on terminal states.
    if (dispute.status !== "open" && dispute.status !== "submitted") {
      throw new TypeError(
        "disputeResolution.addEvidence: dispute " + JSON.stringify(disputeId) +
        " is in terminal status " + JSON.stringify(dispute.status) +
        " — evidence is only accepted in open / submitted"
      );
    }

    var id = b.uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO dispute_evidence (id, dispute_id, kind, blob_ref, notes, recorded_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, disputeId, kind, blobRef, notes, ts],
    );
    // Bump updated_at on the parent dispute so the dashboard's
    // "recently touched" sort surfaces the dispute again.
    await query(
      "UPDATE disputes SET updated_at = ?1 WHERE dispute_id = ?2",
      [ts, disputeId],
    );
    return {
      id:          id,
      dispute_id:  disputeId,
      kind:        kind,
      blob_ref:    blobRef,
      notes:       notes,
      recorded_at: ts,
    };
  }

  // ---- submitResponse -----------------------------------------------

  async function submitResponse(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("disputeResolution.submitResponse: input object required");
    }
    var disputeId = _disputeId(input.dispute_id);
    var narrative = _narrative(input.narrative);

    var dispute = await _getDisputeRow(disputeId);
    if (!dispute) {
      throw new TypeError(
        "disputeResolution.submitResponse: dispute_id " +
        JSON.stringify(disputeId) + " not found"
      );
    }
    if (dispute.status !== "open") {
      throw new TypeError(
        "disputeResolution.submitResponse: dispute " + JSON.stringify(disputeId) +
        " is in status " + JSON.stringify(dispute.status) +
        " — submitResponse requires status=open"
      );
    }

    var id = b.uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO dispute_responses (id, dispute_id, narrative, submitted_at) " +
      "VALUES (?1, ?2, ?3, ?4)",
      [id, disputeId, narrative, ts],
    );
    await query(
      "UPDATE disputes SET status = 'submitted', submitted_at = ?1, updated_at = ?1 " +
      "WHERE dispute_id = ?2",
      [ts, disputeId],
    );
    return {
      id:           id,
      dispute_id:   disputeId,
      narrative:    narrative,
      submitted_at: ts,
    };
  }

  // ---- recordProcessorDecision --------------------------------------
  //
  // The processor finished adjudicating. The outcome dictates the FSM
  // transition:
  //   submitted → won        the operator's evidence carried the day
  //   submitted → lost       the processor sided with the cardholder
  //   submitted → escalated  the cardholder escalated to pre_arbitration /
  //                          arbitration — caller spawns a new dispute
  //                          row keyed on the escalated dispute_id
  //   open      → accepted   the operator never responded and explicitly
  //                          conceded the dispute (or the deadline ran out
  //                          and the operator wants the audit row to say
  //                          "we accepted it" vs. "we lost")
  //   open      → lost       the deadline ran out without a response
  async function recordProcessorDecision(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("disputeResolution.recordProcessorDecision: input object required");
    }
    var disputeId = _disputeId(input.dispute_id);
    var outcome   = _outcome(input.outcome);
    var decidedAt = input.processor_decision_at == null
      ? _monotonicTs()
      : _epochMs(input.processor_decision_at, "processor_decision_at");

    var dispute = await _getDisputeRow(disputeId);
    if (!dispute) {
      throw new TypeError(
        "disputeResolution.recordProcessorDecision: dispute_id " +
        JSON.stringify(disputeId) + " not found"
      );
    }

    var current = dispute.status;
    var nextStatus;
    if (outcome === "won") {
      if (current !== "submitted") {
        throw new TypeError(
          "disputeResolution.recordProcessorDecision: outcome 'won' requires status=submitted " +
          "(current=" + JSON.stringify(current) + ")"
        );
      }
      nextStatus = "won";
    } else if (outcome === "escalated") {
      if (current !== "submitted") {
        throw new TypeError(
          "disputeResolution.recordProcessorDecision: outcome 'escalated' requires status=submitted " +
          "(current=" + JSON.stringify(current) + ")"
        );
      }
      nextStatus = "escalated";
    } else if (outcome === "accepted") {
      if (current !== "open") {
        throw new TypeError(
          "disputeResolution.recordProcessorDecision: outcome 'accepted' requires status=open " +
          "(current=" + JSON.stringify(current) + ")"
        );
      }
      nextStatus = "accepted";
    } else /* lost */ {
      if (current !== "open" && current !== "submitted") {
        throw new TypeError(
          "disputeResolution.recordProcessorDecision: outcome 'lost' requires status in " +
          "{open, submitted} (current=" + JSON.stringify(current) + ")"
        );
      }
      nextStatus = "lost";
    }

    var ts = _monotonicTs();
    if (ts < decidedAt) ts = decidedAt;
    await query(
      "UPDATE disputes SET status = ?1, outcome = ?2, decided_at = ?3, updated_at = ?3 " +
      "WHERE dispute_id = ?4",
      [nextStatus, outcome, ts, disputeId],
    );
    return _hydrateDispute(await _getDisputeRow(disputeId));
  }

  // ---- markWriteoff -------------------------------------------------
  //
  // After a `lost` dispute, the operator closes the books on the
  // uncollectable funds by writing them off. Terminal — moves the
  // dispute to `written_off` and stamps operator + reason for the
  // audit log.
  async function markWriteoff(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("disputeResolution.markWriteoff: input object required");
    }
    var disputeId  = _disputeId(input.dispute_id);
    var operatorId = _operatorId(input.operator_id);
    var reason     = _writeoffReason(input.reason);

    var dispute = await _getDisputeRow(disputeId);
    if (!dispute) {
      throw new TypeError(
        "disputeResolution.markWriteoff: dispute_id " +
        JSON.stringify(disputeId) + " not found"
      );
    }
    if (dispute.status !== "lost") {
      throw new TypeError(
        "disputeResolution.markWriteoff: dispute " + JSON.stringify(disputeId) +
        " is in status " + JSON.stringify(dispute.status) +
        " — markWriteoff requires status=lost"
      );
    }

    var ts = _monotonicTs();
    await query(
      "UPDATE disputes SET status = 'written_off', written_off_at = ?1, " +
      "written_off_reason = ?2, written_off_by = ?3, updated_at = ?1 " +
      "WHERE dispute_id = ?4",
      [ts, reason, operatorId, disputeId],
    );
    return _hydrateDispute(await _getDisputeRow(disputeId));
  }

  // ---- getDispute ---------------------------------------------------

  async function getDispute(disputeId) {
    _disputeId(disputeId);
    return _hydrateDispute(await _getDisputeRow(disputeId));
  }

  // ---- disputesForOrder ---------------------------------------------

  async function disputesForOrder(orderId) {
    _orderId(orderId);
    var rows = (await query(
      "SELECT * FROM disputes WHERE order_id = ?1 ORDER BY opened_at DESC",
      [orderId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateDispute(rows[i]));
    return out;
  }

  // ---- openDisputes -------------------------------------------------
  //
  // Surfaces disputes still requiring operator attention — status in
  // {open, submitted}. Sorts by due_by ASC NULLS LAST so the soonest
  // deadline floats to the top of the queue. Optional filters: processor,
  // kind, limit. The operator console wires this to the "needs response"
  // sidebar.
  async function openDisputes(listOpts) {
    listOpts = listOpts || {};
    var processor = null;
    if (listOpts.processor != null) processor = _processor(listOpts.processor);
    var kind = null;
    if (listOpts.kind != null) kind = _kind(listOpts.kind);
    var limit = _limit(listOpts.limit);

    var sql = "SELECT * FROM disputes WHERE status IN ('open', 'submitted')";
    var params = [];
    var idx = 1;
    if (processor != null) {
      sql += " AND processor = ?" + idx;
      params.push(processor);
      idx += 1;
    }
    if (kind != null) {
      sql += " AND kind = ?" + idx;
      params.push(kind);
      idx += 1;
    }
    // SQLite sorts NULL first in ASC; coalesce to a far-future sentinel
    // so disputes without a deadline sink below those that have one.
    sql += " ORDER BY COALESCE(due_by, 9223372036854775807) ASC, opened_at ASC LIMIT ?" + idx;
    params.push(limit);

    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateDispute(rows[i]));
    return out;
  }

  // ---- historyForDispute --------------------------------------------
  //
  // Returns the dispute row + ordered evidence + ordered responses.
  // Mirrors the operator-console "dispute detail" view.
  async function historyForDispute(disputeId) {
    _disputeId(disputeId);
    var dispute = _hydrateDispute(await _getDisputeRow(disputeId));
    if (!dispute) return null;

    var ev = (await query(
      "SELECT * FROM dispute_evidence WHERE dispute_id = ?1 ORDER BY recorded_at ASC",
      [disputeId],
    )).rows;
    var evidence = [];
    for (var i = 0; i < ev.length; i += 1) evidence.push(_hydrateEvidence(ev[i]));

    var rs = (await query(
      "SELECT * FROM dispute_responses WHERE dispute_id = ?1 ORDER BY submitted_at ASC",
      [disputeId],
    )).rows;
    var responses = [];
    for (var j = 0; j < rs.length; j += 1) responses.push(_hydrateResponse(rs[j]));

    return {
      dispute:   dispute,
      evidence:  evidence,
      responses: responses,
    };
  }

  // ---- metricsForProcessor ------------------------------------------
  //
  // Rolls up dispute outcomes per processor over a [from, to] window.
  // Win rate is the operator-meaningful metric: wins / decided. A
  // decided dispute is one whose status is in {won, lost, accepted}
  // — escalated rolls into its descendant dispute's count, not the
  // original.
  async function metricsForProcessor(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("disputeResolution.metricsForProcessor: input object required");
    }
    var processor = _processor(input.processor);
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (from > to) {
      throw new TypeError("disputeResolution.metricsForProcessor: from must be <= to");
    }
    var rows = (await query(
      "SELECT status, amount_minor FROM disputes " +
      "WHERE processor = ?1 AND opened_at >= ?2 AND opened_at <= ?3",
      [processor, from, to],
    )).rows;
    var openCount       = 0;
    var submittedCount  = 0;
    var wonCount        = 0;
    var lostCount       = 0;
    var acceptedCount   = 0;
    var escalatedCount  = 0;
    var writtenOffCount = 0;
    var totalDisputedMinor   = 0;
    var totalLostMinor       = 0;
    var totalWrittenOffMinor = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var amt = Number(r.amount_minor || 0);
      totalDisputedMinor += amt;
      if      (r.status === "open")        openCount       += 1;
      else if (r.status === "submitted")   submittedCount  += 1;
      else if (r.status === "won")         wonCount        += 1;
      else if (r.status === "lost")        { lostCount       += 1; totalLostMinor       += amt; }
      else if (r.status === "accepted")    { acceptedCount   += 1; totalLostMinor       += amt; }
      else if (r.status === "escalated")   escalatedCount  += 1;
      else if (r.status === "written_off") { writtenOffCount += 1; totalWrittenOffMinor += amt; }
    }
    var decidedCount = wonCount + lostCount + acceptedCount;
    var winRate = decidedCount === 0 ? null : wonCount / decidedCount;
    return {
      processor:               processor,
      from:                    from,
      to:                      to,
      total_count:             rows.length,
      open_count:              openCount,
      submitted_count:         submittedCount,
      won_count:               wonCount,
      lost_count:              lostCount,
      accepted_count:          acceptedCount,
      escalated_count:         escalatedCount,
      written_off_count:       writtenOffCount,
      decided_count:           decidedCount,
      win_rate:                winRate,
      total_disputed_minor:    totalDisputedMinor,
      total_lost_minor:        totalLostMinor,
      total_written_off_minor: totalWrittenOffMinor,
    };
  }

  // Composed handles held for forward-compatibility. The v1 surface
  // doesn't read them; future feature work will compose the order
  // snapshot into recordDispute (auto-derive amount + currency) and
  // call payment.refund when an `accepted` outcome should also issue
  // the funds back through the processor. Keeping the handles in the
  // factory keeps the operator-facing wiring stable across those
  // additions.
  void orderHandle;
  void paymentHandle;
  void riskHandle;

  return {
    recordDispute:            recordDispute,
    addEvidence:              addEvidence,
    submitResponse:           submitResponse,
    recordProcessorDecision:  recordProcessorDecision,
    markWriteoff:             markWriteoff,
    getDispute:               getDispute,
    disputesForOrder:         disputesForOrder,
    openDisputes:             openDisputes,
    historyForDispute:        historyForDispute,
    metricsForProcessor:      metricsForProcessor,
  };
}

module.exports = {
  create:          create,
  KINDS:           KINDS.slice(),
  EVIDENCE_KINDS:  EVIDENCE_KINDS.slice(),
  OUTCOMES:        OUTCOMES.slice(),
  STATUSES:        STATUSES.slice(),
  MAX_AMOUNT_MINOR:        MAX_AMOUNT_MINOR,
  MAX_NARRATIVE_LEN:       MAX_NARRATIVE_LEN,
  MAX_BLOB_REF_LEN:        MAX_BLOB_REF_LEN,
  MAX_LIST_LIMIT:          MAX_LIST_LIMIT,
};
