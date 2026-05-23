-- dispute-resolution: payment-processor chargeback / dispute lifecycle.
--
-- The processor-side dispute lane is distinct from the refund lane
-- the storefront drives voluntarily:
--
--   refundPolicy / refundAutomation / returns
--     The customer asks for their money back through the storefront's
--     own surface; the operator authors the rules; the primitive
--     decides whether to issue the refund.
--
--   disputeResolution (this primitive)
--     The customer (or their bank) opens a chargeback / inquiry /
--     pre-arbitration / arbitration directly with the payment
--     processor. The operator finds out about it via processor webhook
--     and has a fixed window — typically 7-21 days depending on the
--     network and kind — to either accept the dispute (concede the
--     funds) or respond with evidence and fight it. Missing the
--     deadline is an automatic loss.
--
-- Three tables hold the lifecycle:
--
--   * `disputes` — one row per processor-opened dispute. Keyed by the
--     operator-supplied `dispute_id` (typically the processor's own
--     identifier, e.g. Stripe's `dp_...`). Carries the kind enum, the
--     amount in dispute, the processor's reason code, the operator's
--     working status through the FSM, the deadline the processor
--     enforced, and the outcome once the processor finishes
--     adjudicating.
--
--   * `dispute_evidence` — append-only log of the artifacts the
--     operator gathered to fight the dispute. Each row carries an
--     evidence kind (signed_proof_of_delivery / customer_communication
--     / refund_policy / receipt / shipping_label / customer_signature
--     / other), an opaque `blob_ref` pointing into operator storage
--     (the primitive doesn't own the bytes — the upstream artifact
--     store does), and an optional operator note.
--
--   * `dispute_responses` — append-only log of every response the
--     operator submitted to the processor. The most-recent response
--     for a dispute is the "active" one; earlier responses are
--     preserved so the audit history shows how the operator's
--     narrative evolved if multiple submissions were allowed (e.g. a
--     pre-arbitration after losing the initial chargeback).
--
-- FSM on `disputes.status`:
--
--   open                                           — created by recordDispute
--   open       → submitted        (submitResponse)
--   open       → accepted         (recordProcessorDecision outcome=accepted)
--   open       → lost             (recordProcessorDecision outcome=lost — deadline miss)
--   submitted  → won              (recordProcessorDecision outcome=won)
--   submitted  → lost             (recordProcessorDecision outcome=lost)
--   submitted  → escalated        (recordProcessorDecision outcome=escalated — pre_arbitration spawn)
--   lost       → written_off      (markWriteoff)
--
-- Terminal states: won / accepted / written_off. `lost` is terminal
-- for the dispute itself but the operator may still record a writeoff
-- against it (accounting closes the books on uncollectable funds).
-- `escalated` is terminal for this dispute row — the processor's
-- escalation spawns a fresh dispute row with a higher-kind value
-- (pre_arbitration / arbitration) and its own dispute_id.
--
-- Indexes drive the operator-facing reads:
--   * (status, due_by ASC)        — openDisputes "soonest deadline first"
--   * (order_id, opened_at DESC)  — disputesForOrder
--   * (processor, opened_at DESC) — metricsForProcessor windowed read
--   * (dispute_id) on evidence    — historyForDispute (evidence join)
--   * (dispute_id) on responses   — historyForDispute (response join)

CREATE TABLE IF NOT EXISTS disputes (
  dispute_id            TEXT    NOT NULL PRIMARY KEY,
  order_id              TEXT    NOT NULL,
  processor             TEXT    NOT NULL,
  kind                  TEXT    NOT NULL CHECK (kind IN (
                          'chargeback',
                          'inquiry',
                          'pre_arbitration',
                          'arbitration'
                        )),
  amount_minor          INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency              TEXT    NOT NULL,
  reason_code           TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'open' CHECK (status IN (
                          'open',
                          'submitted',
                          'won',
                          'lost',
                          'accepted',
                          'escalated',
                          'written_off'
                        )),
  outcome               TEXT,
  opened_at             INTEGER NOT NULL,
  due_by                INTEGER,
  submitted_at          INTEGER,
  decided_at            INTEGER,
  written_off_at        INTEGER,
  written_off_reason    TEXT,
  written_off_by        TEXT,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_disputes_status_due
  ON disputes(status, due_by ASC);

CREATE INDEX IF NOT EXISTS idx_disputes_order
  ON disputes(order_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_disputes_processor
  ON disputes(processor, opened_at DESC);

CREATE TABLE IF NOT EXISTS dispute_evidence (
  id            TEXT    NOT NULL PRIMARY KEY,
  dispute_id    TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN (
                  'signed_proof_of_delivery',
                  'customer_communication',
                  'refund_policy',
                  'receipt',
                  'shipping_label',
                  'customer_signature',
                  'other'
                )),
  blob_ref      TEXT    NOT NULL,
  notes         TEXT,
  recorded_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute
  ON dispute_evidence(dispute_id, recorded_at ASC);

CREATE TABLE IF NOT EXISTS dispute_responses (
  id              TEXT    NOT NULL PRIMARY KEY,
  dispute_id      TEXT    NOT NULL,
  narrative       TEXT    NOT NULL,
  submitted_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispute_responses_dispute
  ON dispute_responses(dispute_id, submitted_at ASC);
