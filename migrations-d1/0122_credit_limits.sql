-- B2B credit accounts: each customer has a credit_limit + payment_terms
-- + billing_cycle. Orders charge against the account up to the limit;
-- invoiced periodically and paid back to reduce the outstanding
-- balance. Distinct from `store_credit_ledger` (migration 0094) — that
-- table is a prepaid wallet (balance can be drained by debits); this
-- table is a borrowed-against credit line (balance grows when orders
-- charge, shrinks when payments arrive).
--
-- Schema decisions:
--   * `credit_accounts` is keyed by `customer_id` 1:1 — a customer
--     either has a credit account or doesn't. The `status` enum
--     governs the FSM: active → suspended → reinstated (active) →
--     closed. `closed` is terminal at the primitive layer (no
--     transition back); operators delete + redefine if they want a
--     fresh account.
--   * `credit_transactions` is the append-only event stream against
--     the account. Five `kind` values:
--       - charge:     a new order chargeable on credit (increases
--                     outstanding)
--       - payment:    operator-recorded payment (reduces outstanding)
--       - hold:       same as charge — kept distinct in the enum so
--                     callers can model a pending-authorization
--                     phase without immediate balance impact in a
--                     future extension. v1 treats hold identically
--                     to charge for outstanding-balance accounting.
--       - release:    cancellation of a prior charge/hold — restores
--                     credit. order_id must match a prior charge
--                     for the same customer.
--       - adjustment: operator-supplied positive or negative
--                     correction (amount_minor stays positive; the
--                     sign is carried by a payment_ref convention or
--                     a future-added `signed_amount` column).
--   * `balance_after_minor` is denormalized — the customer's
--     outstanding balance AFTER this row applied. The
--     `(customer_id, occurred_at DESC)` index drives O(1) current-
--     balance reads.
--   * `payment_terms_days` is the number of days from invoice issue
--     to payment due (net-15 / net-30 / net-60). Stored as an
--     integer so any cadence the operator wants is expressible — the
--     primitive doesn't enforce a fixed enum here.
--   * `billing_cycle` is a CHECK-bounded enum: weekly / biweekly /
--     monthly. Drives the invoicing cadence for downstream invoice
--     rendering.

CREATE TABLE IF NOT EXISTS credit_accounts (
  customer_id          TEXT NOT NULL PRIMARY KEY,
  credit_limit_minor   INTEGER NOT NULL CHECK (credit_limit_minor >= 0),
  currency             TEXT NOT NULL,
  payment_terms_days   INTEGER NOT NULL CHECK (payment_terms_days > 0),
  billing_cycle        TEXT NOT NULL CHECK (billing_cycle IN ('weekly', 'biweekly', 'monthly')),
  status               TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
  suspended_reason     TEXT,
  suspended_at         INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_status ON credit_accounts(status);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id                   TEXT NOT NULL PRIMARY KEY,
  customer_id          TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('charge', 'payment', 'hold', 'release', 'adjustment')),
  order_id             TEXT,
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  balance_after_minor  INTEGER NOT NULL CHECK (balance_after_minor >= 0),
  payment_ref          TEXT,
  occurred_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_customer ON credit_transactions(customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_order    ON credit_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_kind     ON credit_transactions(customer_id, kind);
