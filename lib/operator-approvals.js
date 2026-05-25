"use strict";
/**
 * @module shop.operatorApprovals
 * @title  Operator approvals — multi-step approval workflows for
 *         high-risk operator actions
 *
 * @intro
 *   Some operator actions are too risky to execute on the strength
 *   of a single operator's intent — large refunds (the customer
 *   trust + chargeback-window exposure exceeds the single agent's
 *   blast radius), bulk catalog edits (a typo in a bulk-price-cut
 *   propagates to every variant before anyone notices), payment-
 *   method changes (the operator's own banking destination shifts
 *   under the chargeback queue), vendor payout overrides (real
 *   money to a third party). The `operatorApprovals` primitive
 *   models these as multi-step workflows: the requesting operator
 *   submits the action, named approvers cast votes, and the
 *   application only executes once the workflow's threshold is met.
 *
 *   A workflow is operator-authored once via `defineWorkflow` and
 *   carries the gating policy: how many approvers are required to
 *   pass, whether approvers must hold a named capability token
 *   from the `operatorRoles` allow-list, how long pending requests
 *   wait before escalation, and an optional `auto_approve_threshold`
 *   that lets the application short-circuit small-payload requests
 *   without a vote (e.g. refunds under $100 still record an audit
 *   row but skip the approval step).
 *
 *   The FSM per request is closed:
 *
 *     pending   -> approved    (votes_for >= required_approvers)
 *     pending   -> rejected    (any single `reject` vote)
 *     pending   -> escalated   (operator records the escalation)
 *     pending   -> cancelled   (requester withdraws before resolve)
 *     approved  -> executed    (markExecuted records the outcome)
 *     approved  -> cancelled   (operator can still cancel after
 *                               approval but before execution)
 *     escalated -> approved    (vote-driven; the escalation flag is
 *                               metadata, not a terminal state)
 *     escalated -> rejected
 *     escalated -> cancelled
 *
 *   Multi-approver semantics: ANY single `reject` vote flips the
 *   request to `rejected`, which matches "any one approver can veto
 *   a money move" — the bar an operator wants for the pre-execution
 *   gate. Approvers can leave an `abstain` vote that counts neither
 *   for nor against; abstentions are recorded so an auditor can see
 *   who saw the request and declined to weigh in.
 *
 *   Surface:
 *
 *     - defineWorkflow({ slug, action_kind, required_approvers,
 *                        required_capability?, escalation_after_hours?,
 *                        auto_approve_threshold? })
 *         Create / update the workflow definition. Re-defining the
 *         same slug refreshes the policy in place (the workflow
 *         identity is stable — the rules are operator-tunable).
 *
 *     - requestApproval({ workflow_slug, requested_by, payload,
 *                         justification })
 *         Submit a new approval request. `payload` is the
 *         operator-supplied structured description of the action
 *         (refund amount, vendor id, catalog patch); the primitive
 *         does NOT interpret it but does JSON-validate +
 *         size-clamp. Returns the persisted row at `status:
 *         "pending"`. Refused if the workflow is archived.
 *
 *     - castVote({ request_id, approver_id, decision, comment? })
 *         Record a vote. `decision` is one of approve / reject /
 *         abstain. UNIQUE(request_id, approver_id) holds at the
 *         schema level; the primitive surfaces the collision as a
 *         friendly refusal. When `operatorRoles` is wired and the
 *         workflow declares a `required_capability`, the approver's
 *         active roles are checked through `hasPermission` and the
 *         vote is refused if the approver doesn't carry the
 *         capability. Crossing the `required_approvers` threshold
 *         flips the request to `approved`; a `reject` vote flips it
 *         to `rejected` immediately.
 *
 *     - recordEscalation({ request_id, escalated_to, reason })
 *         Stamp the escalation columns on a pending request. The
 *         primitive does NOT itself enforce the
 *         `escalation_after_hours` deadline — the application sweeps
 *         pending requests (or wires a scheduler) and calls this
 *         when the deadline passes. The `escalated_to` field is the
 *         operator-id (or role slug) of the escalation target; the
 *         primitive does NOT validate it against the operator
 *         registry, leaving that to the wiring layer.
 *
 *     - markExecuted({ request_id, executed_by, result })
 *         Final state transition: an approved request has been
 *         executed by the application. `result` is JSON-validated +
 *         size-clamped. Refused if the request is not at
 *         `approved`.
 *
 *     - cancelRequest({ request_id, reason })
 *         Operator-initiated withdrawal. Allowed from pending /
 *         approved / escalated; refused from executed / rejected
 *         (the action is already done one way or the other) and
 *         from already-cancelled.
 *
 *     - getRequest(request_id)
 *         Single-row read with denormalized vote tally + nested
 *         votes array.
 *
 *     - pendingForApprover({ approver_id, workflow_slug? })
 *         Pending (or escalated) requests the named approver has
 *         not yet voted on. When `workflow_slug` is supplied the
 *         filter narrows to a single workflow. Used by the operator
 *         console "approvals awaiting you" badge.
 *
 *     - myRequests({ requester_id, status?, limit? })
 *         The requesting operator's own submission history.
 *
 *     - metricsForWorkflow({ slug, from, to })
 *         Aggregate counters over an [from, to) epoch-ms window —
 *         total / by_status / median_time_to_resolve_ms /
 *         auto_approved / escalated.
 *
 *   Composes ONLY blamejs (zero npm deps):
 *     - `b.uuid.v7`              — request + vote row PKs
 *     - `shop.operatorRoles`     — optional peer for the
 *                                  required_capability gate +
 *                                  audit trail
 *     - `shop.operatorAuditLog`  — optional peer; every
 *                                  request / vote / execute /
 *                                  cancel / escalate records a row
 *                                  via the duck-typed `.record(...)`
 *                                  surface
 *     - `shop.operatorInbox`     — optional peer; requestApproval
 *                                  enqueues a role-broadcast
 *                                  message addressed to the
 *                                  workflow's `required_capability`
 *                                  when wired
 *
 *   Monotonic clock: a per-factory monotonic timestamp ensures that
 *   two votes / state-transitions landing in the same wall-clock
 *   millisecond carry strictly-increasing `occurred_at` /
 *   `updated_at` values. The audit ordering is total even on fast
 *   runners that collapse `Date.now()` inside one tick.
 *
 *   Storage: `migrations-d1/0192_operator_approvals.sql` — three
 *   tables (`approval_workflows` + `approval_requests` +
 *   `approval_votes`) with their indexes.
 *
 * @primitive operatorApprovals
 * @related   operatorRoles, operatorAuditLog, operatorInbox, b.uuid
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN           = 80;
var MAX_ACTION_KIND_LEN    = 80;
var MAX_OPERATOR_ID_LEN    = 128;
var MAX_REASON_LEN         = 500;
var MAX_COMMENT_LEN        = 2000;
var MAX_JUSTIFICATION_LEN  = 4000;
var MAX_PAYLOAD_BYTES      = 64 * 1024;
var MAX_RESULT_BYTES       = 64 * 1024;
var MAX_REQUIRED_APPROVERS = 32;
var MAX_LIST_LIMIT         = 500;
var DEFAULT_LIST_LIMIT     = 100;
var MAX_HOURS              = 24 * 365;       // one-year cap

var SLUG_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var ACTION_KIND_RE   = /^[a-z][a-z0-9_.\-]{0,79}$/;
var CONTROL_BYTE_RE  = /[\x00-\x1f\x7f]/;

var DECISIONS = Object.freeze(["approve", "reject", "abstain"]);
var STATUSES  = Object.freeze(["pending", "approved", "rejected",
                               "executed", "cancelled", "escalated"]);

var b = require("./index").framework;

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("operatorApprovals: " + (label || "slug") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _actionKind(s) {
  if (typeof s !== "string" || !ACTION_KIND_RE.test(s)) {
    throw new TypeError("operatorApprovals: action_kind must be lowercase " +
      "alnum / underscore / dot / dash, 1.." + MAX_ACTION_KIND_LEN + " chars");
  }
  return s;
}

function _operatorId(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_OPERATOR_ID_LEN) {
    throw new TypeError("operatorApprovals: " + label +
      " must be a non-empty string (<= " + MAX_OPERATOR_ID_LEN + " chars)");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("operatorApprovals: " + label + " must not contain control bytes");
  }
  return s;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REASON_LEN) {
    throw new TypeError("operatorApprovals: reason must be a non-empty string <= " +
      MAX_REASON_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s.replace(/[\t\r\n]/g, ""))) {
    throw new TypeError("operatorApprovals: reason must not contain control bytes (except whitespace)");
  }
  return s;
}

function _justification(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_JUSTIFICATION_LEN) {
    throw new TypeError("operatorApprovals: justification must be a non-empty string <= " +
      MAX_JUSTIFICATION_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s.replace(/[\t\r\n]/g, ""))) {
    throw new TypeError("operatorApprovals: justification must not contain control bytes (except whitespace)");
  }
  return s;
}

function _comment(s) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > MAX_COMMENT_LEN) {
    throw new TypeError("operatorApprovals: comment must be a string <= " +
      MAX_COMMENT_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s.replace(/[\t\r\n]/g, ""))) {
    throw new TypeError("operatorApprovals: comment must not contain control bytes (except whitespace)");
  }
  return s;
}

function _decision(s) {
  if (typeof s !== "string" || DECISIONS.indexOf(s) < 0) {
    throw new TypeError("operatorApprovals: decision must be one of " + DECISIONS.join(", "));
  }
  return s;
}

function _status(s, label) {
  if (typeof s !== "string" || STATUSES.indexOf(s) < 0) {
    throw new TypeError("operatorApprovals: " + (label || "status") +
      " must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _requiredApprovers(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_REQUIRED_APPROVERS) {
    throw new TypeError("operatorApprovals: required_approvers must be an integer in [1, " +
      MAX_REQUIRED_APPROVERS + "]");
  }
  return n;
}

function _hours(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1 || n > MAX_HOURS) {
    throw new TypeError("operatorApprovals: " + label +
      " must be a positive integer (hours) <= " + MAX_HOURS);
  }
  return n;
}

function _autoApprove(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError("operatorApprovals: auto_approve_threshold must be a positive integer or null");
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("operatorApprovals: " + label +
      " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("operatorApprovals: limit must be an integer in [1, " +
      MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _json(v, label, maxBytes) {
  if (v == null) {
    throw new TypeError("operatorApprovals: " + label + " must be a plain object");
  }
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("operatorApprovals: " + label + " must be a plain object");
  }
  var json;
  try { json = JSON.stringify(v); }
  catch (_e) { throw new TypeError("operatorApprovals: " + label + " must be JSON-serializable"); }
  if (json === undefined) {
    throw new TypeError("operatorApprovals: " + label + " must be JSON-serializable");
  }
  if (json.length > maxBytes) {
    throw new TypeError("operatorApprovals: " + label + " must serialize to <= " +
      maxBytes + " bytes");
  }
  return json;
}

function _capability(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_ACTION_KIND_LEN) {
    throw new TypeError("operatorApprovals: required_capability must be a non-empty string or null");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("operatorApprovals: required_capability must not contain control bytes");
  }
  return s;
}

// ---- row hydration ------------------------------------------------------

function _safeParseObject(s) {
  if (s == null) return null;
  try {
    var parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (_e) { return null; }
}

function _hydrateWorkflow(r) {
  if (!r) return null;
  return {
    slug:                   r.slug,
    action_kind:            r.action_kind,
    required_approvers:     Number(r.required_approvers),
    required_capability:    r.required_capability == null ? null : r.required_capability,
    escalation_after_hours: r.escalation_after_hours == null ? null : Number(r.escalation_after_hours),
    auto_approve_threshold: r.auto_approve_threshold == null ? null : Number(r.auto_approve_threshold),
    archived_at:            r.archived_at == null ? null : Number(r.archived_at),
    created_at:             Number(r.created_at),
    updated_at:             Number(r.updated_at),
  };
}

function _hydrateRequest(r) {
  if (!r) return null;
  return {
    id:                r.id,
    workflow_slug:     r.workflow_slug,
    requested_by:      r.requested_by,
    payload:           _safeParseObject(r.payload_json) || {},
    justification:     r.justification,
    status:            r.status,
    votes_for:         Number(r.votes_for),
    votes_against:     Number(r.votes_against),
    executed_by:       r.executed_by == null ? null : r.executed_by,
    executed_at:       r.executed_at == null ? null : Number(r.executed_at),
    result:            _safeParseObject(r.result_json),
    cancelled_at:      r.cancelled_at == null ? null : Number(r.cancelled_at),
    cancel_reason:     r.cancel_reason == null ? null : r.cancel_reason,
    escalated_to:      r.escalated_to == null ? null : r.escalated_to,
    escalated_at:      r.escalated_at == null ? null : Number(r.escalated_at),
    escalation_reason: r.escalation_reason == null ? null : r.escalation_reason,
    created_at:        Number(r.created_at),
    updated_at:        Number(r.updated_at),
  };
}

function _hydrateVote(r) {
  if (!r) return null;
  return {
    id:          r.id,
    request_id:  r.request_id,
    approver_id: r.approver_id,
    decision:    r.decision,
    comment:     r.comment == null ? null : r.comment,
    occurred_at: Number(r.occurred_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Optional peer — when wired, `castVote` consults
  // `hasPermission({ operator_id, permission })` against the workflow's
  // `required_capability`. Without it, capability is advisory metadata.
  var operatorRoles = opts.operatorRoles || null;
  if (operatorRoles != null) {
    if (typeof operatorRoles !== "object" ||
        typeof operatorRoles.hasPermission !== "function") {
      throw new TypeError("operatorApprovals.create: operatorRoles must expose hasPermission(...)");
    }
  }

  // Optional peer — every state-changing call records an audit row
  // via duck-typed `.record(...)` matching the operatorAuditLog
  // surface (migration 0074).
  var operatorAuditLog = opts.operatorAuditLog || null;
  if (operatorAuditLog != null) {
    if (typeof operatorAuditLog !== "object" ||
        typeof operatorAuditLog.record !== "function") {
      throw new TypeError("operatorApprovals.create: operatorAuditLog must expose record(...)");
    }
  }

  // Optional peer — `requestApproval` enqueues a role-broadcast
  // inbox message addressed to the workflow's `required_capability`
  // when this is wired.
  var operatorInbox = opts.operatorInbox || null;
  if (operatorInbox != null) {
    if (typeof operatorInbox !== "object" ||
        typeof operatorInbox.enqueueMessage !== "function") {
      throw new TypeError("operatorApprovals.create: operatorInbox must expose enqueueMessage(...)");
    }
  }

  // Per-factory monotonic clock. Fast platforms collapse `Date.now()`
  // to identical readings inside one tick; the bump keeps the audit
  // ordering deterministic — two votes / state transitions landing in
  // the same millisecond still carry strictly-increasing timestamps.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- audit helper --------------------------------------------------

  async function _audit(action, actorId, resourceId, before, after) {
    if (!operatorAuditLog) return;
    try {
      await operatorAuditLog.record({
        actor_type:    "operator",
        actor_id:      actorId,
        action:        action,
        resource_kind: "approval_request",
        resource_id:   resourceId,
        before:        before,
        after:         after,
      });
    } catch (_e) {
      // Audit failure does not roll back the state change — the
      // primitive's contract is "best-effort chain to the peer". The
      // peer's own internals carry the hard guarantees.
    }
  }

  // ---- defineWorkflow -----------------------------------------------

  async function defineWorkflow(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.defineWorkflow: input object required");
    }
    var slug                 = _slug(input.slug);
    var actionKind           = _actionKind(input.action_kind);
    var requiredApprovers    = _requiredApprovers(input.required_approvers);
    var requiredCapability   = _capability(input.required_capability);
    var escalationAfterHours = _hours(input.escalation_after_hours, "escalation_after_hours");
    var autoApproveThreshold = _autoApprove(input.auto_approve_threshold);

    var ts = _monotonicTs();

    var existing = (await query(
      "SELECT slug FROM approval_workflows WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];

    if (existing) {
      // In-place policy refresh — the workflow identity is stable;
      // operator-tunable rules ride the updated_at bump.
      await query(
        "UPDATE approval_workflows " +
        "SET action_kind = ?1, required_approvers = ?2, required_capability = ?3, " +
        "escalation_after_hours = ?4, auto_approve_threshold = ?5, updated_at = ?6 " +
        "WHERE slug = ?7",
        [actionKind, requiredApprovers, requiredCapability,
         escalationAfterHours, autoApproveThreshold, ts, slug],
      );
    } else {
      await query(
        "INSERT INTO approval_workflows " +
        "(slug, action_kind, required_approvers, required_capability, " +
        " escalation_after_hours, auto_approve_threshold, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
        [slug, actionKind, requiredApprovers, requiredCapability,
         escalationAfterHours, autoApproveThreshold, ts],
      );
    }

    return await _getWorkflow(slug);
  }

  async function _getWorkflow(slug) {
    var r = (await query(
      "SELECT * FROM approval_workflows WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateWorkflow(r);
  }

  // ---- requestApproval ----------------------------------------------

  async function requestApproval(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.requestApproval: input object required");
    }
    var workflowSlug = _slug(input.workflow_slug, "workflow_slug");
    var requestedBy  = _operatorId(input.requested_by, "requested_by");
    var payloadJson  = _json(input.payload, "payload", MAX_PAYLOAD_BYTES);
    var justification = _justification(input.justification);

    var wf = await _getWorkflow(workflowSlug);
    if (!wf) {
      throw new TypeError("operatorApprovals.requestApproval: workflow " +
        JSON.stringify(workflowSlug) + " not found");
    }
    if (wf.archived_at != null) {
      throw new TypeError("operatorApprovals.requestApproval: workflow " +
        JSON.stringify(workflowSlug) + " is archived - new requests are refused");
    }

    var id = b.uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO approval_requests " +
      "(id, workflow_slug, requested_by, payload_json, justification, status, " +
      " votes_for, votes_against, executed_by, executed_at, result_json, " +
      " cancelled_at, cancel_reason, escalated_to, escalated_at, escalation_reason, " +
      " created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, 0, NULL, NULL, NULL, " +
      " NULL, NULL, NULL, NULL, NULL, ?6, ?6)",
      [id, workflowSlug, requestedBy, payloadJson, justification, ts],
    );

    // Audit + inbox broadcast composition.
    await _audit("approval.request", requestedBy, id, null,
      { workflow_slug: workflowSlug, justification: justification });

    if (operatorInbox && wf.required_capability) {
      try {
        await operatorInbox.enqueueMessage({
          role:     wf.required_capability,
          kind:     "approval_request",
          severity: "warning",
          subject:  "Approval requested: " + wf.action_kind,
          body:     justification,
          payload:  { request_id: id, workflow_slug: workflowSlug },
        });
      } catch (_e) {
        // Inbox failure does not roll back — the request is still
        // pending; the caller can re-broadcast.
      }
    }

    return await getRequest(id);
  }

  // ---- castVote -----------------------------------------------------

  async function castVote(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.castVote: input object required");
    }
    var requestId  = _operatorId(input.request_id, "request_id");
    var approverId = _operatorId(input.approver_id, "approver_id");
    var decision   = _decision(input.decision);
    var comment    = _comment(input.comment);

    var req = (await query(
      "SELECT * FROM approval_requests WHERE id = ?1 LIMIT 1",
      [requestId],
    )).rows[0];
    if (!req) {
      throw new TypeError("operatorApprovals.castVote: request " +
        JSON.stringify(requestId) + " not found");
    }
    if (req.status !== "pending" && req.status !== "escalated") {
      throw new TypeError("operatorApprovals.castVote: request " +
        JSON.stringify(requestId) + " is " + req.status + " — votes refused");
    }
    if (req.requested_by === approverId) {
      throw new TypeError("operatorApprovals.castVote: requester cannot vote on their own request");
    }

    var wf = await _getWorkflow(req.workflow_slug);
    if (!wf) {
      throw new TypeError("operatorApprovals.castVote: workflow " +
        JSON.stringify(req.workflow_slug) + " not found");
    }

    // Capability gate via composed operatorRoles peer.
    if (operatorRoles && wf.required_capability) {
      var allowed = await operatorRoles.hasPermission({
        operator_id: approverId,
        permission:  wf.required_capability,
      });
      if (!allowed) {
        throw new TypeError("operatorApprovals.castVote: approver " +
          JSON.stringify(approverId) + " does not carry required capability " +
          JSON.stringify(wf.required_capability));
      }
    }

    // UNIQUE(request_id, approver_id) — surface the dedup as a
    // friendly refusal rather than a raw constraint error.
    var existing = (await query(
      "SELECT id FROM approval_votes WHERE request_id = ?1 AND approver_id = ?2 LIMIT 1",
      [requestId, approverId],
    )).rows[0];
    if (existing) {
      throw new TypeError("operatorApprovals.castVote: approver " +
        JSON.stringify(approverId) + " has already voted on request " +
        JSON.stringify(requestId));
    }

    var voteId = b.uuid.v7();
    var ts = _monotonicTs();
    await query(
      "INSERT INTO approval_votes (id, request_id, approver_id, decision, comment, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [voteId, requestId, approverId, decision, comment, ts],
    );

    // Tally bump under the same logical transaction.
    var votesFor     = Number(req.votes_for);
    var votesAgainst = Number(req.votes_against);
    if (decision === "approve") votesFor     += 1;
    if (decision === "reject")  votesAgainst += 1;

    // Threshold + veto resolution.
    var newStatus = req.status;
    if (decision === "reject") {
      newStatus = "rejected";
    } else if (decision === "approve" && votesFor >= Number(wf.required_approvers)) {
      newStatus = "approved";
    }

    await query(
      "UPDATE approval_requests SET votes_for = ?1, votes_against = ?2, status = ?3, updated_at = ?4 " +
      "WHERE id = ?5",
      [votesFor, votesAgainst, newStatus, ts, requestId],
    );

    await _audit("approval.vote", approverId, requestId,
      { status: req.status, votes_for: Number(req.votes_for), votes_against: Number(req.votes_against) },
      { status: newStatus, votes_for: votesFor, votes_against: votesAgainst, decision: decision });

    return await getRequest(requestId);
  }

  // ---- recordEscalation --------------------------------------------

  async function recordEscalation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.recordEscalation: input object required");
    }
    var requestId    = _operatorId(input.request_id, "request_id");
    var escalatedTo  = _operatorId(input.escalated_to, "escalated_to");
    var reason       = _reason(input.reason);

    var req = (await query(
      "SELECT * FROM approval_requests WHERE id = ?1 LIMIT 1",
      [requestId],
    )).rows[0];
    if (!req) {
      throw new TypeError("operatorApprovals.recordEscalation: request " +
        JSON.stringify(requestId) + " not found");
    }
    if (req.status !== "pending") {
      throw new TypeError("operatorApprovals.recordEscalation: request " +
        JSON.stringify(requestId) + " is " + req.status + " — escalation refused");
    }

    var ts = _monotonicTs();
    await query(
      "UPDATE approval_requests SET status = 'escalated', escalated_to = ?1, " +
      "escalated_at = ?2, escalation_reason = ?3, updated_at = ?2 WHERE id = ?4",
      [escalatedTo, ts, reason, requestId],
    );

    await _audit("approval.escalate", escalatedTo, requestId,
      { status: req.status },
      { status: "escalated", escalated_to: escalatedTo, reason: reason });

    return await getRequest(requestId);
  }

  // ---- markExecuted ------------------------------------------------

  async function markExecuted(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.markExecuted: input object required");
    }
    var requestId  = _operatorId(input.request_id, "request_id");
    var executedBy = _operatorId(input.executed_by, "executed_by");
    var resultJson = _json(input.result, "result", MAX_RESULT_BYTES);

    var req = (await query(
      "SELECT * FROM approval_requests WHERE id = ?1 LIMIT 1",
      [requestId],
    )).rows[0];
    if (!req) {
      throw new TypeError("operatorApprovals.markExecuted: request " +
        JSON.stringify(requestId) + " not found");
    }
    if (req.status !== "approved") {
      throw new TypeError("operatorApprovals.markExecuted: request " +
        JSON.stringify(requestId) + " is " + req.status + " — execution refused");
    }

    var ts = _monotonicTs();
    await query(
      "UPDATE approval_requests SET status = 'executed', executed_by = ?1, " +
      "executed_at = ?2, result_json = ?3, updated_at = ?2 WHERE id = ?4",
      [executedBy, ts, resultJson, requestId],
    );

    await _audit("approval.execute", executedBy, requestId,
      { status: req.status },
      { status: "executed" });

    return await getRequest(requestId);
  }

  // ---- cancelRequest -----------------------------------------------

  async function cancelRequest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.cancelRequest: input object required");
    }
    var requestId = _operatorId(input.request_id, "request_id");
    var reason    = _reason(input.reason);

    var req = (await query(
      "SELECT * FROM approval_requests WHERE id = ?1 LIMIT 1",
      [requestId],
    )).rows[0];
    if (!req) {
      throw new TypeError("operatorApprovals.cancelRequest: request " +
        JSON.stringify(requestId) + " not found");
    }
    if (req.status === "executed" || req.status === "rejected" || req.status === "cancelled") {
      throw new TypeError("operatorApprovals.cancelRequest: request " +
        JSON.stringify(requestId) + " is " + req.status + " — cancel refused");
    }

    var ts = _monotonicTs();
    await query(
      "UPDATE approval_requests SET status = 'cancelled', cancelled_at = ?1, " +
      "cancel_reason = ?2, updated_at = ?1 WHERE id = ?3",
      [ts, reason, requestId],
    );

    await _audit("approval.cancel", req.requested_by, requestId,
      { status: req.status },
      { status: "cancelled", reason: reason });

    return await getRequest(requestId);
  }

  // ---- getRequest --------------------------------------------------

  async function getRequest(requestId) {
    _operatorId(requestId, "request_id");
    var row = (await query(
      "SELECT * FROM approval_requests WHERE id = ?1 LIMIT 1",
      [requestId],
    )).rows[0];
    if (!row) return null;
    var req = _hydrateRequest(row);

    var voteRows = (await query(
      "SELECT * FROM approval_votes WHERE request_id = ?1 ORDER BY occurred_at ASC, id ASC",
      [requestId],
    )).rows;
    var votes = [];
    for (var i = 0; i < voteRows.length; i += 1) votes.push(_hydrateVote(voteRows[i]));
    req.votes = votes;
    return req;
  }

  // ---- pendingForApprover ------------------------------------------

  async function pendingForApprover(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.pendingForApprover: input object required");
    }
    var approverId   = _operatorId(input.approver_id, "approver_id");
    var workflowSlug = input.workflow_slug == null ? null : _slug(input.workflow_slug, "workflow_slug");
    var limit        = _limit(input.limit);

    var sql = "SELECT r.* FROM approval_requests r " +
      "WHERE r.status IN ('pending', 'escalated') " +
      "AND r.requested_by != ?1 " +
      "AND NOT EXISTS (" +
      "  SELECT 1 FROM approval_votes v " +
      "  WHERE v.request_id = r.id AND v.approver_id = ?1" +
      ")";
    var params = [approverId];
    var idx = 2;
    if (workflowSlug) {
      sql += " AND r.workflow_slug = ?" + idx;
      params.push(workflowSlug);
      idx += 1;
    }
    sql += " ORDER BY r.created_at ASC, r.id ASC LIMIT ?" + idx;
    params.push(limit);

    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRequest(rows[i]));
    return out;
  }

  // ---- myRequests --------------------------------------------------

  async function myRequests(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.myRequests: input object required");
    }
    var requesterId = _operatorId(input.requester_id, "requester_id");
    var statusFilter = input.status == null ? null : _status(input.status);
    var limit       = _limit(input.limit);

    var sql, params;
    if (statusFilter) {
      sql = "SELECT * FROM approval_requests WHERE requested_by = ?1 AND status = ?2 " +
            "ORDER BY created_at DESC, id DESC LIMIT ?3";
      params = [requesterId, statusFilter, limit];
    } else {
      sql = "SELECT * FROM approval_requests WHERE requested_by = ?1 " +
            "ORDER BY created_at DESC, id DESC LIMIT ?2";
      params = [requesterId, limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRequest(rows[i]));
    return out;
  }

  // ---- metricsForWorkflow ------------------------------------------

  async function metricsForWorkflow(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("operatorApprovals.metricsForWorkflow: input object required");
    }
    var slug = _slug(input.slug);
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (to < from) {
      throw new TypeError("operatorApprovals.metricsForWorkflow: to must be >= from");
    }

    var rows = (await query(
      "SELECT status, created_at, updated_at, escalated_at " +
      "FROM approval_requests " +
      "WHERE workflow_slug = ?1 AND created_at >= ?2 AND created_at < ?3",
      [slug, from, to],
    )).rows;

    var byStatus = { pending: 0, approved: 0, rejected: 0,
                     executed: 0, cancelled: 0, escalated: 0 };
    var resolveLatencies = [];
    var escalated = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var s = rows[i].status;
      if (byStatus[s] != null) byStatus[s] += 1;
      if (rows[i].escalated_at != null) escalated += 1;
      if (s === "approved" || s === "rejected" || s === "executed" || s === "cancelled") {
        resolveLatencies.push(Number(rows[i].updated_at) - Number(rows[i].created_at));
      }
    }

    var medianResolveMs = null;
    if (resolveLatencies.length > 0) {
      resolveLatencies.sort(function (a, b) { return a - b; });
      var mid = resolveLatencies.length >> 1;
      medianResolveMs = resolveLatencies.length % 2 === 1
        ? resolveLatencies[mid]
        : Math.round((resolveLatencies[mid - 1] + resolveLatencies[mid]) / 2);
    }

    return {
      slug:                       slug,
      from:                       from,
      to:                         to,
      total:                      rows.length,
      by_status:                  byStatus,
      escalated:                  escalated,
      median_time_to_resolve_ms:  medianResolveMs,
    };
  }

  return {
    DECISIONS:               DECISIONS.slice(),
    STATUSES:                STATUSES.slice(),
    MAX_PAYLOAD_BYTES:       MAX_PAYLOAD_BYTES,
    MAX_RESULT_BYTES:        MAX_RESULT_BYTES,
    MAX_REQUIRED_APPROVERS:  MAX_REQUIRED_APPROVERS,
    MAX_LIST_LIMIT:          MAX_LIST_LIMIT,

    defineWorkflow:          defineWorkflow,
    requestApproval:         requestApproval,
    castVote:                castVote,
    recordEscalation:        recordEscalation,
    markExecuted:            markExecuted,
    cancelRequest:           cancelRequest,
    getRequest:              getRequest,
    pendingForApprover:      pendingForApprover,
    myRequests:              myRequests,
    metricsForWorkflow:      metricsForWorkflow,
  };
}

module.exports = {
  create:                  create,
  DECISIONS:               DECISIONS,
  STATUSES:                STATUSES,
  MAX_PAYLOAD_BYTES:       MAX_PAYLOAD_BYTES,
  MAX_RESULT_BYTES:        MAX_RESULT_BYTES,
  MAX_REQUIRED_APPROVERS:  MAX_REQUIRED_APPROVERS,
  MAX_LIST_LIMIT:          MAX_LIST_LIMIT,
};
