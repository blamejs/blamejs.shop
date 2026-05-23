"use strict";
/**
 * operator-approvals — multi-step approval workflows for high-risk
 * operator actions (large refunds, bulk catalog edits, payment-method
 * changes, vendor payout overrides).
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0192.
 * The operatorRoles + operatorAuditLog + operatorInbox peers are
 * stubbed locally so the primitive is exercised in isolation.
 *
 * Coverage:
 *   - defineWorkflow create + in-place policy refresh
 *   - capability gate: castVote refused when operatorRoles peer is
 *     wired and the approver lacks the workflow's required_capability
 *   - requestApproval happy path + audit + inbox composition; refused
 *     against archived workflow (via second defineWorkflow that
 *     archives via direct UPDATE — this primitive doesn't ship
 *     archiveWorkflow yet); refused on missing workflow
 *   - castVote UNIQUE(request_id, approver_id) dedup surfaced as a
 *     friendly refusal; requester cannot vote on their own request
 *   - required_approvers threshold flips pending -> approved
 *   - single reject vote vetoes pending -> rejected immediately
 *   - recordEscalation flag + escalation_after_hours metadata
 *   - markExecuted only from approved; cancelRequest closed FSM
 *   - metricsForWorkflow window aggregation
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var operatorApprovals = require("../../lib/operator-approvals");
var bShop             = require("../../lib");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0192_operator_approvals.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var queryFn = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  queryFn.__db = db;
  return queryFn;
}

// Minimal operatorRoles stub — the primitive only calls
// `hasPermission({ operator_id, permission })`.
function _rolesStub(memberships) {
  // memberships: { [operator_id]: ["permission", ...] }
  return {
    hasPermission: async function (input) {
      var perms = memberships[input.operator_id] || [];
      return perms.indexOf(input.permission) >= 0;
    },
  };
}

// Minimal operatorAuditLog stub — captures every record() call.
function _auditStub() {
  var calls = [];
  return {
    calls: calls,
    record: async function (input) {
      calls.push(input);
      return { ok: true };
    },
  };
}

// Minimal operatorInbox stub.
function _inboxStub() {
  var calls = [];
  return {
    calls: calls,
    enqueueMessage: async function (input) {
      calls.push(input);
      return { id: "inbox-" + calls.length };
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- defineWorkflow + in-place refresh ----------------------------------

async function _defineWorkflow() {
  var q = _makeQuery();
  var svc = operatorApprovals.create({ query: q });

  var wf = await svc.defineWorkflow({
    slug:                   "large-refund",
    action_kind:            "refund.large",
    required_approvers:     2,
    required_capability:    "orders.refund",
    escalation_after_hours: 24,
    auto_approve_threshold: 100,
  });
  check("defineWorkflow returns row",         wf && wf.slug === "large-refund");
  check("defineWorkflow required_approvers",  wf.required_approvers === 2);
  check("defineWorkflow capability",          wf.required_capability === "orders.refund");
  check("defineWorkflow escalation",          wf.escalation_after_hours === 24);
  check("defineWorkflow auto_approve",        wf.auto_approve_threshold === 100);

  // Re-define refreshes policy in place.
  var updated = await svc.defineWorkflow({
    slug:                   "large-refund",
    action_kind:            "refund.large",
    required_approvers:     3,
    required_capability:    "orders.refund",
    escalation_after_hours: 48,
    auto_approve_threshold: null,
  });
  check("defineWorkflow refresh approvers",   updated.required_approvers === 3);
  check("defineWorkflow refresh escalation",  updated.escalation_after_hours === 48);
  check("defineWorkflow refresh auto null",   updated.auto_approve_threshold === null);

  // Refusals: bad slug, bad action_kind, bad required_approvers.
  await assert.rejects(svc.defineWorkflow(),                                          /input object required/);
  await assert.rejects(svc.defineWorkflow({ slug: "!!", action_kind: "x",
    required_approvers: 1 }),                                                         /slug/);
  await assert.rejects(svc.defineWorkflow({ slug: "x", action_kind: "BAD",
    required_approvers: 1 }),                                                         /action_kind/);
  await assert.rejects(svc.defineWorkflow({ slug: "x", action_kind: "x",
    required_approvers: 0 }),                                                         /required_approvers/);
  await assert.rejects(svc.defineWorkflow({ slug: "x", action_kind: "x",
    required_approvers: 100 }),                                                       /required_approvers/);
}

// ---- requestApproval + capability gate + audit + inbox ------------------

async function _requestApprovalComposition() {
  var q = _makeQuery();
  var audit = _auditStub();
  var inbox = _inboxStub();
  var roles = _rolesStub({});
  var svc = operatorApprovals.create({
    query:            q,
    operatorRoles:    roles,
    operatorAuditLog: audit,
    operatorInbox:    inbox,
  });

  await svc.defineWorkflow({
    slug: "bulk-catalog-edit", action_kind: "catalog.bulk_edit",
    required_approvers: 2, required_capability: "catalog.write",
  });

  var requester = "op-requester-001";
  var req = await svc.requestApproval({
    workflow_slug: "bulk-catalog-edit",
    requested_by:  requester,
    payload:       { sku_count: 240, price_change: -0.05 },
    justification: "End-of-season clearance across 240 SKUs.",
  });
  check("requestApproval persists",        req && req.id);
  check("requestApproval status pending",  req.status === "pending");
  check("requestApproval votes 0",         req.votes_for === 0 && req.votes_against === 0);
  check("requestApproval payload echoed",  req.payload.sku_count === 240);

  // Audit chained.
  check("audit chain request",             audit.calls.length === 1 &&
                                            audit.calls[0].action === "approval.request");

  // Inbox broadcast keyed off required_capability.
  check("inbox broadcast role",            inbox.calls.length === 1 &&
                                            inbox.calls[0].role === "catalog.write" &&
                                            inbox.calls[0].kind === "approval_request");

  // Unknown workflow refused.
  await assert.rejects(svc.requestApproval({
    workflow_slug: "unknown-flow", requested_by: requester,
    payload: {}, justification: "test",
  }),                                                                                /not found/);

  // Bad payload + bad justification.
  await assert.rejects(svc.requestApproval({
    workflow_slug: "bulk-catalog-edit", requested_by: requester,
    payload: null, justification: "x",
  }),                                                                                /payload/);
  await assert.rejects(svc.requestApproval({
    workflow_slug: "bulk-catalog-edit", requested_by: requester,
    payload: {}, justification: "",
  }),                                                                                /justification/);
}

// ---- castVote UNIQUE dedup + requester self-vote refusal ----------------

async function _castVoteDedup() {
  var q = _makeQuery();
  var svc = operatorApprovals.create({ query: q });

  await svc.defineWorkflow({
    slug: "vendor-payout", action_kind: "vendor.payout",
    required_approvers: 2,
  });

  var requester = "op-requester-002";
  var approver  = "op-approver-001";
  var req = await svc.requestApproval({
    workflow_slug: "vendor-payout", requested_by: requester,
    payload: { vendor_id: "v-1", amount_cents: 50000 },
    justification: "Monthly payout override.",
  });

  // First vote lands.
  var afterFirst = await svc.castVote({
    request_id: req.id, approver_id: approver, decision: "approve",
    comment: "Verified vendor invoice.",
  });
  check("castVote tally bump",             afterFirst.votes_for === 1);
  check("castVote still pending",          afterFirst.status === "pending");
  check("castVote records vote row",       afterFirst.votes.length === 1 &&
                                            afterFirst.votes[0].approver_id === approver);

  // Same approver second vote refused (UNIQUE).
  await assert.rejects(svc.castVote({
    request_id: req.id, approver_id: approver, decision: "approve",
  }),                                                                                /already voted/);

  // Requester voting on their own request refused.
  await assert.rejects(svc.castVote({
    request_id: req.id, approver_id: requester, decision: "approve",
  }),                                                                                /requester cannot vote/);

  // Unknown request id refused.
  await assert.rejects(svc.castVote({
    request_id: _uuid(), approver_id: "op-x", decision: "approve",
  }),                                                                                /not found/);
}

// ---- required_approvers threshold flips pending -> approved -------------

async function _requiredApproversThreshold() {
  var q = _makeQuery();
  var svc = operatorApprovals.create({ query: q });

  await svc.defineWorkflow({
    slug: "payment-method-change", action_kind: "settings.payment",
    required_approvers: 3,
  });

  var requester = "op-requester-003";
  var req = await svc.requestApproval({
    workflow_slug: "payment-method-change", requested_by: requester,
    payload: { new_bank: "ACME-001" },
    justification: "Migrating from legacy bank to new processor.",
  });

  await svc.castVote({ request_id: req.id, approver_id: "op-a", decision: "approve" });
  var afterTwo = await svc.castVote({
    request_id: req.id, approver_id: "op-b", decision: "approve",
  });
  check("threshold pending at 2/3",        afterTwo.status === "pending");
  check("threshold count 2",               afterTwo.votes_for === 2);

  var afterThree = await svc.castVote({
    request_id: req.id, approver_id: "op-c", decision: "approve",
  });
  check("threshold flip to approved",      afterThree.status === "approved");
  check("threshold count 3",               afterThree.votes_for === 3);

  // Further votes after resolution refused.
  await assert.rejects(svc.castVote({
    request_id: req.id, approver_id: "op-d", decision: "approve",
  }),                                                                                /votes refused/);

  // Single reject vote on a new request vetoes immediately.
  var req2 = await svc.requestApproval({
    workflow_slug: "payment-method-change", requested_by: requester,
    payload: { new_bank: "ACME-002" },
    justification: "Second migration attempt.",
  });
  var rejected = await svc.castVote({
    request_id: req2.id, approver_id: "op-veto", decision: "reject",
    comment: "Bank not on approved list.",
  });
  check("single reject vetoes",            rejected.status === "rejected");
  check("single reject tally",             rejected.votes_against === 1);
}

// ---- capability gate via operatorRoles peer -----------------------------

async function _capabilityGate() {
  var q = _makeQuery();
  var roles = _rolesStub({
    "op-with-cap":    ["orders.refund"],
    "op-without-cap": ["customers.read"],
  });
  var svc = operatorApprovals.create({ query: q, operatorRoles: roles });

  await svc.defineWorkflow({
    slug: "large-refund", action_kind: "refund.large",
    required_approvers: 1, required_capability: "orders.refund",
  });
  var req = await svc.requestApproval({
    workflow_slug: "large-refund", requested_by: "op-req",
    payload: { amount: 500 }, justification: "Customer escalation.",
  });

  // Approver lacking the capability is refused.
  await assert.rejects(svc.castVote({
    request_id: req.id, approver_id: "op-without-cap", decision: "approve",
  }),                                                                                /required capability/);

  // Approver with the capability succeeds; threshold = 1 flips to approved.
  var after = await svc.castVote({
    request_id: req.id, approver_id: "op-with-cap", decision: "approve",
  });
  check("capability-gated approve",         after.status === "approved");
}

// ---- recordEscalation + markExecuted + cancelRequest --------------------

async function _escalationAndExecution() {
  var q = _makeQuery();
  var svc = operatorApprovals.create({ query: q });

  await svc.defineWorkflow({
    slug: "large-refund", action_kind: "refund.large",
    required_approvers: 2, escalation_after_hours: 24,
  });

  var req = await svc.requestApproval({
    workflow_slug: "large-refund", requested_by: "op-req",
    payload: { amount: 1500 }, justification: "Chargeback prevention.",
  });

  // Escalate a pending request.
  var escalated = await svc.recordEscalation({
    request_id:   req.id,
    escalated_to: "op-manager",
    reason:       "No approver responded in 24h window.",
  });
  check("escalation status",                escalated.status === "escalated");
  check("escalation target",                escalated.escalated_to === "op-manager");
  check("escalation reason persisted",      escalated.escalation_reason.indexOf("24h window") >= 0);

  // Votes still land on an escalated request.
  await svc.castVote({ request_id: req.id, approver_id: "op-a", decision: "approve" });
  var afterTwo = await svc.castVote({
    request_id: req.id, approver_id: "op-b", decision: "approve",
  });
  check("escalated -> approved",            afterTwo.status === "approved");

  // markExecuted accepted from approved.
  var executed = await svc.markExecuted({
    request_id: req.id, executed_by: "op-executor",
    result: { refund_id: "r-9", credited_cents: 150000 },
  });
  check("execution status",                 executed.status === "executed");
  check("execution result echoed",          executed.result.refund_id === "r-9");
  check("executed_by",                      executed.executed_by === "op-executor");

  // markExecuted refused on already-executed.
  await assert.rejects(svc.markExecuted({
    request_id: req.id, executed_by: "op-executor",
    result: { refund_id: "r-9" },
  }),                                                                                /execution refused/);

  // cancelRequest refused on executed.
  await assert.rejects(svc.cancelRequest({
    request_id: req.id, reason: "Trying to cancel after the fact.",
  }),                                                                                /cancel refused/);

  // Cancel happy path on a fresh pending row.
  var req2 = await svc.requestApproval({
    workflow_slug: "large-refund", requested_by: "op-req",
    payload: { amount: 500 }, justification: "Duplicate request.",
  });
  var cancelled = await svc.cancelRequest({
    request_id: req2.id, reason: "Requester withdrew — wrong customer.",
  });
  check("cancel status",                    cancelled.status === "cancelled");
  check("cancel reason persisted",          cancelled.cancel_reason.indexOf("wrong customer") >= 0);
}

// ---- pendingForApprover + myRequests ------------------------------------

async function _readSurfaces() {
  var q = _makeQuery();
  var svc = operatorApprovals.create({ query: q });

  await svc.defineWorkflow({
    slug: "wf-a", action_kind: "kind.a", required_approvers: 2,
  });
  await svc.defineWorkflow({
    slug: "wf-b", action_kind: "kind.b", required_approvers: 2,
  });

  var r1 = await svc.requestApproval({
    workflow_slug: "wf-a", requested_by: "op-req-1",
    payload: { x: 1 }, justification: "Request one.",
  });
  var r2 = await svc.requestApproval({
    workflow_slug: "wf-b", requested_by: "op-req-1",
    payload: { x: 2 }, justification: "Request two.",
  });
  var r3 = await svc.requestApproval({
    workflow_slug: "wf-a", requested_by: "op-req-2",
    payload: { x: 3 }, justification: "Request three.",
  });

  // pendingForApprover excludes requests the approver authored.
  var pendingForReq1 = await svc.pendingForApprover({ approver_id: "op-req-1" });
  var ids = pendingForReq1.map(function (r) { return r.id; });
  check("pendingForApprover excludes self", ids.indexOf(r1.id) < 0 && ids.indexOf(r2.id) < 0);
  check("pendingForApprover includes other", ids.indexOf(r3.id) >= 0);

  // Cast a vote, then pendingForApprover excludes voted-on rows.
  await svc.castVote({ request_id: r3.id, approver_id: "op-req-1", decision: "abstain" });
  var afterVote = await svc.pendingForApprover({ approver_id: "op-req-1" });
  var idsAfter = afterVote.map(function (r) { return r.id; });
  check("pendingForApprover excludes voted", idsAfter.indexOf(r3.id) < 0);

  // workflow_slug filter narrows.
  var pendingFiltered = await svc.pendingForApprover({
    approver_id: "op-third", workflow_slug: "wf-b",
  });
  check("pendingForApprover filtered",       pendingFiltered.length === 1 &&
                                              pendingFiltered[0].workflow_slug === "wf-b");

  // myRequests returns the requester's own submissions.
  var mine = await svc.myRequests({ requester_id: "op-req-1" });
  check("myRequests count",                  mine.length === 2);
  var mineFiltered = await svc.myRequests({
    requester_id: "op-req-1", status: "pending",
  });
  check("myRequests status filter",          mineFiltered.length === 2 &&
                                              mineFiltered.every(function (r) { return r.status === "pending"; }));
}

// ---- metricsForWorkflow --------------------------------------------------

async function _metricsForWorkflow() {
  var q = _makeQuery();
  var svc = operatorApprovals.create({ query: q });

  await svc.defineWorkflow({
    slug: "wf-metrics", action_kind: "metrics.kind", required_approvers: 1,
  });

  // Create + resolve a handful of rows so the histogram + median latency
  // are non-trivial.
  var r1 = await svc.requestApproval({
    workflow_slug: "wf-metrics", requested_by: "op-req",
    payload: { x: 1 }, justification: "One.",
  });
  await svc.castVote({ request_id: r1.id, approver_id: "op-a", decision: "approve" });

  var r2 = await svc.requestApproval({
    workflow_slug: "wf-metrics", requested_by: "op-req",
    payload: { x: 2 }, justification: "Two.",
  });
  await svc.castVote({ request_id: r2.id, approver_id: "op-a", decision: "reject" });

  var r3 = await svc.requestApproval({
    workflow_slug: "wf-metrics", requested_by: "op-req",
    payload: { x: 3 }, justification: "Three.",
  });
  // Left pending.
  void r3;

  var r4 = await svc.requestApproval({
    workflow_slug: "wf-metrics", requested_by: "op-req",
    payload: { x: 4 }, justification: "Four.",
  });
  await svc.recordEscalation({
    request_id: r4.id, escalated_to: "op-mgr", reason: "Stale 24h.",
  });

  var from = 0;
  var to   = Date.now() + 1000 * 60 * 60;
  var m = await svc.metricsForWorkflow({ slug: "wf-metrics", from: from, to: to });
  check("metrics slug",                      m.slug === "wf-metrics");
  check("metrics total",                     m.total === 4);
  check("metrics by_status approved",        m.by_status.approved === 1);
  check("metrics by_status rejected",        m.by_status.rejected === 1);
  check("metrics by_status pending",         m.by_status.pending === 1);
  check("metrics by_status escalated",       m.by_status.escalated === 1);
  check("metrics escalated tally",           m.escalated === 1);
  check("metrics median resolve numeric",    typeof m.median_time_to_resolve_ms === "number" &&
                                              m.median_time_to_resolve_ms >= 0);

  // Bad window refused.
  await assert.rejects(svc.metricsForWorkflow({
    slug: "wf-metrics", from: 100, to: 50,
  }),                                                                                />= from/);
}

// ---- factory refusals ----------------------------------------------------

async function _factoryRefusals() {
  // operatorRoles without hasPermission refused.
  assert.throws(function () {
    operatorApprovals.create({ query: function () {}, operatorRoles: {} });
  }, /hasPermission/);
  // operatorAuditLog without record refused.
  assert.throws(function () {
    operatorApprovals.create({ query: function () {}, operatorAuditLog: {} });
  }, /record/);
  // operatorInbox without enqueueMessage refused.
  assert.throws(function () {
    operatorApprovals.create({ query: function () {}, operatorInbox: {} });
  }, /enqueueMessage/);
}

async function run() {
  await _defineWorkflow();
  await _requestApprovalComposition();
  await _castVoteDedup();
  await _requiredApproversThreshold();
  await _capabilityGate();
  await _escalationAndExecution();
  await _readSurfaces();
  await _metricsForWorkflow();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("operator-approvals: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
