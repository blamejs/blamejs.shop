-- Subscription billing — the money side of recurring revenue,
-- distinct from `subscription_controls` (which owns the pause /
-- resume / skip / cancel FSM the customer-service operator drives).
-- This primitive wraps Stripe (or any processor) billing webhooks
-- into three append-only tables:
--
--   subscription_invoices         — one row per billing period the
--                                   processor generates an invoice
--                                   for. Mirrors Stripe's
--                                   `invoice.created` payload + the
--                                   customer-facing hosted invoice
--                                   URL the receipt email links to.
--                                   The `status` column is the local
--                                   FSM (pending → paid / failed /
--                                   voided); each transition is
--                                   driven by a webhook event the
--                                   primitive's markPaid / markFailed
--                                   surface records.
--
--   subscription_payment_attempts — append-only attempt ledger keyed
--                                   by `(invoice_id, attempt_number)`.
--                                   Stripe retries a failed invoice
--                                   up to 4 times by default; each
--                                   `invoice.payment_failed` /
--                                   `invoice.payment_succeeded`
--                                   webhook writes one row so the
--                                   support operator can replay the
--                                   exact failure_code sequence on
--                                   the customer profile screen.
--
--   subscription_dunning_states   — one row per dunning episode. A
--                                   subscription enters dunning when
--                                   the processor flips it to
--                                   `past_due`; the row stays open
--                                   until the operator (or the
--                                   processor's automatic recovery)
--                                   resolves it via exitDunning with
--                                   one of `recovered` / `cancelled`
--                                   / `written_off`. The append-only
--                                   shape lets the operator dashboard
--                                   render dunning history per
--                                   subscription without losing the
--                                   prior episodes.
--
-- Indexes:
--   * (subscription_id, created_at DESC) on invoices — the per-
--     subscription invoice list the customer profile renders.
--   * (status, created_at) on invoices — `failedInvoices` window
--     query (operator dashboard "show me every failed invoice this
--     week").
--   * UNIQUE (processor_invoice_id) on invoices — Stripe webhook
--     idempotency. Replays of `invoice.created` collapse to one
--     row.
--   * (invoice_id, attempt_number) UNIQUE on attempts — per-invoice
--     attempt ordering + replay idempotency.
--   * (subscription_id, entered_at DESC) on dunning_states — the
--     dunning timeline per subscription.
--   * (state, entered_at) WHERE exited_at IS NULL on dunning_states
--     — partial index for the `dunningRoster` walk (operator
--     dashboard "every subscription in dunning right now").

CREATE TABLE IF NOT EXISTS subscription_invoices (
  id                    TEXT NOT NULL PRIMARY KEY,
  subscription_id       TEXT NOT NULL,
  period_start          INTEGER NOT NULL,
  period_end            INTEGER NOT NULL,
  amount_minor          INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  invoice_url           TEXT,
  processor_invoice_id  TEXT UNIQUE,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'voided')),
  paid_at               INTEGER,
  voided_at             INTEGER,
  created_at            INTEGER NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_invoices_subscription
  ON subscription_invoices(subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sub_invoices_status
  ON subscription_invoices(status, created_at);

CREATE TABLE IF NOT EXISTS subscription_payment_attempts (
  id                    TEXT NOT NULL PRIMARY KEY,
  invoice_id            TEXT NOT NULL,
  attempt_number        INTEGER NOT NULL CHECK (attempt_number >= 1),
  status                TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  processor_charge_id   TEXT,
  failure_code          TEXT,
  occurred_at           INTEGER NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES subscription_invoices(id) ON DELETE CASCADE,
  UNIQUE (invoice_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_sub_pay_attempts_invoice
  ON subscription_payment_attempts(invoice_id, attempt_number);

CREATE TABLE IF NOT EXISTS subscription_dunning_states (
  id                TEXT NOT NULL PRIMARY KEY,
  subscription_id   TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('active', 'dunning', 'recovered', 'cancelled', 'written_off')),
  reason            TEXT,
  entered_at        INTEGER NOT NULL,
  exited_at         INTEGER,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_dunning_subscription
  ON subscription_dunning_states(subscription_id, entered_at DESC);

CREATE INDEX IF NOT EXISTS idx_sub_dunning_open
  ON subscription_dunning_states(state, entered_at) WHERE exited_at IS NULL;
