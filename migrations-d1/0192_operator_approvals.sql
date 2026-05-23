-- Operator approvals: multi-step approval workflows for high-risk
-- operator actions (large refunds, bulk catalog edits, payment-method
-- changes, vendor payout overrides). An operator defines a workflow
-- once via `defineWorkflow({ slug, action_kind, required_approvers,
-- required_capability?, escalation_after_hours?,
-- auto_approve_threshold? })`. The application then issues
-- per-action approval requests against that workflow with
-- `requestApproval(...)`. Approvers cast votes; once
-- `votes_for >= required_approvers` the request flips to `approved`
-- and the application is free to execute it (then call
-- `markExecuted(...)` to record the result). Any single `reject`
-- vote flips the request to `rejected` — multi-step approvals model
-- "any one approver can veto" semantics, which matches the
-- pre-execution-of-money-moves bar an operator wants.
--
-- Composes with `operator_roles` (migration 0157) when the optional
-- `operatorRoles` peer is wired into the factory — the
-- `required_capability` column names a permission token from the
-- closed allow-list and `castVote(...)` refuses approvers whose
-- active roles don't carry that token. Without the peer wired,
-- capability is treated as advisory metadata and votes are accepted
-- from any caller (the application is responsible for the gate).
--
-- Schema:
--
--   * `approval_workflows` — keyed on `slug` (PK). Carries the
--     workflow's identity + the gating policy (required_approvers /
--     required_capability / escalation_after_hours /
--     auto_approve_threshold). `archived_at` is a soft-delete
--     tombstone — archived workflows refuse new requests but
--     in-flight requests continue resolving.
--
--   * `approval_requests` — one row per "this action needs approval"
--     event. `payload_json` carries the operator-supplied structured
--     description of the action (the inputs the executor will use if
--     approved); the primitive does NOT interpret it. The `status`
--     CHECK column carries the FSM state — pending / approved /
--     rejected / executed / cancelled / escalated. `votes_for` +
--     `votes_against` are denormalized tallies bumped under the same
--     transaction that inserts a vote so the threshold check is a
--     single comparison instead of a recount. `executed_at` /
--     `executed_by` / `result_json` stamp the post-execution row;
--     `cancelled_at` / `cancel_reason` stamp operator-initiated
--     withdrawal before resolution; `escalated_at` / `escalated_to` /
--     escalation reason stamp the `recordEscalation` call when a
--     pending request crosses the workflow's `escalation_after_hours`
--     window without resolution.
--
--   * `approval_votes` — one row per cast vote. UNIQUE(request_id,
--     approver_id) prevents the same approver double-casting; the
--     primitive surfaces this as a refusal at the application
--     boundary. `decision` is a closed CHECK enum (approve / reject /
--     abstain). `comment` is the optional free-text justification an
--     approver leaves on their vote.
--
-- Indexes drive the four hot read paths:
--   * (workflow_slug, status, created_at)        — metricsForWorkflow.
--   * (status, created_at)                       — admin "show every
--                                                  pending request"
--                                                  cross-workflow.
--   * (requested_by, created_at DESC)            — `myRequests` —
--                                                  the operator's own
--                                                  submission history.
--   * approval_votes(approver_id, occurred_at)   — `pendingForApprover`
--                                                  fold-in on the vote
--                                                  side to filter out
--                                                  requests the
--                                                  approver already
--                                                  voted on.

CREATE TABLE IF NOT EXISTS approval_workflows (
  slug                     TEXT NOT NULL PRIMARY KEY,
  action_kind              TEXT NOT NULL,
  required_approvers       INTEGER NOT NULL,
  required_capability      TEXT,
  escalation_after_hours   INTEGER,
  auto_approve_threshold   INTEGER,
  archived_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_workflows_kind
  ON approval_workflows(action_kind);

CREATE INDEX IF NOT EXISTS idx_approval_workflows_archived
  ON approval_workflows(archived_at);

CREATE TABLE IF NOT EXISTS approval_requests (
  id              TEXT NOT NULL PRIMARY KEY,
  workflow_slug   TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  justification   TEXT NOT NULL,
  status          TEXT NOT NULL
                    CHECK (status IN ('pending', 'approved', 'rejected',
                                      'executed', 'cancelled', 'escalated')),
  votes_for       INTEGER NOT NULL DEFAULT 0,
  votes_against   INTEGER NOT NULL DEFAULT 0,
  executed_by     TEXT,
  executed_at     INTEGER,
  result_json     TEXT,
  cancelled_at    INTEGER,
  cancel_reason   TEXT,
  escalated_to    TEXT,
  escalated_at    INTEGER,
  escalation_reason TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_workflow
  ON approval_requests(workflow_slug, status, created_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests(status, created_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_requester
  ON approval_requests(requested_by, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_votes (
  id              TEXT NOT NULL PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  approver_id     TEXT NOT NULL,
  decision        TEXT NOT NULL
                    CHECK (decision IN ('approve', 'reject', 'abstain')),
  comment         TEXT,
  occurred_at     INTEGER NOT NULL,
  UNIQUE (request_id, approver_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_votes_request
  ON approval_votes(request_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_approval_votes_approver
  ON approval_votes(approver_id, occurred_at);
