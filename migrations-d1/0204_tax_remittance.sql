-- Tax remittance: per-jurisdiction record of the actual payment the
-- operator made to a tax authority. Distinct from `sales_tax_filings`
-- (which prepares the filing and tracks the lifecycle of one filing
-- row) — this table tracks the money that left the operator's bank
-- account: when, how, for which filing, against which jurisdiction.
--
-- A filing can be paid in one go (one remittance row) or in
-- installments (multiple remittance rows referencing the same
-- filing_id). The reconciliation read sums every non-voided
-- remittance for a filing and compares it against the filing's
-- `tax_owed_minor` — variance > 0 means the operator under-paid;
-- variance < 0 means over-paid; variance == 0 is the happy case.
--
-- Status FSM is intentionally narrow — once recorded, a remittance is
-- either `paid` (the money cleared) or `voided` (the payment bounced
-- / was clawed back / the bank rejected the wire / the operator
-- mistyped the amount and the bank reversed the transfer). A voided
-- remittance keeps its row for the audit trail (`voided_at`,
-- `void_reason`); the reconciliation read excludes voided rows from
-- the per-filing sum.
--
-- `payment_method` is a CHECK enum so the schema refuses a
-- typo'd method at the DB boundary. The five entries cover the
-- payment rails tax authorities actually accept:
--   bank_transfer — domestic ACH-like push (UK BACS, EU SEPA)
--   credit_card   — authority's online portal accepts a card
--   ach           — US ACH (kept distinct from bank_transfer so US
--                   operators can filter by it for return-handling)
--   wire          — same-day wire (international filings)
--   check         — paper check mailed to the authority
--
-- Penalty columns (`penalty_minor`, `penalty_reason`) are nullable —
-- most remittances don't carry a penalty. When the authority assesses
-- a late-payment / under-payment penalty after the fact, the operator
-- amends the same remittance row via `recordPenalty()` rather than
-- opening a sibling row, so the per-jurisdiction metrics read sees
-- one canonical row per payment with its penalty attached.
--
-- Indexes:
--   * (jurisdiction, paid_at DESC) — `remittancesForJurisdiction` and
--     `metricsForJurisdiction` both filter by jurisdiction + window
--     and want recent-first ordering for operator dashboards.
--   * (filing_id) — `reconcileWithFiling` sums every remittance for
--     one filing in a single index seek.
--   * (status, paid_at) — `unpaidObligations` + `lateRemittances`
--     sweep the active set by status + chronology.

CREATE TABLE IF NOT EXISTS tax_remittances (
  id              TEXT    NOT NULL PRIMARY KEY,
  filing_id       TEXT    NOT NULL,
  jurisdiction    TEXT    NOT NULL,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency        TEXT    NOT NULL,
  payment_method  TEXT    NOT NULL CHECK (payment_method IN (
                    'bank_transfer', 'credit_card', 'ach', 'wire', 'check'
                  )),
  payment_ref     TEXT    NOT NULL,
  paid_at         INTEGER NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('paid', 'voided')),
  voided_at       INTEGER,
  void_reason     TEXT,
  penalty_minor   INTEGER CHECK (penalty_minor IS NULL OR penalty_minor >= 0),
  penalty_reason  TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tax_remittances_jur_paid_at
  ON tax_remittances(jurisdiction, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_tax_remittances_filing
  ON tax_remittances(filing_id);
CREATE INDEX IF NOT EXISTS idx_tax_remittances_status_paid_at
  ON tax_remittances(status, paid_at);
