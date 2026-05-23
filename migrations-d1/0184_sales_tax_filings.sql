-- Sales tax filings: periodic (monthly / quarterly / annual)
-- aggregation of orders by jurisdiction for remittance to the taxing
-- authority. One row per (jurisdiction, kind, period_start) — the
-- operator opens the filing period once, the primitive aggregates
-- orders into a snapshot at `computeFiling` time, the operator
-- records the submission + payment, optionally amends.
--
-- The breakdown_json carries the per-rate split (how much taxable
-- revenue + collected tax fell into each bracket the jurisdiction
-- charges) — operators need this for the filing form. We store it as
-- a JSON blob keyed by `rate_bps` so the rate-resolution rule stays
-- in the lib layer and the schema is rate-agnostic.
--
-- Status FSM:
--   draft     -> computed  (computeFiling — aggregation snapshot landed)
--   computed  -> submitted (recordSubmission — filed with authority)
--   submitted -> paid      (recordPayment   — remittance cleared)
--   paid      -> amended   (markAmended     — operator corrects an
--                            already-paid filing; the row's snapshot
--                            stays for the audit trail and the
--                            amended_reason explains why)
--   computed  -> amended   (markAmended     — pre-submit correction)
--   submitted -> amended   (markAmended     — post-submit / pre-pay
--                            correction)
--
-- Indexes:
--   * (jurisdiction, status, due_date) — listFilings + upcomingDue
--   * (status, due_date)               — upcomingDue across jurisdictions
--   * (period_start, period_end)       — auditReportForJurisdiction window
--   * UNIQUE (jurisdiction, kind, period_start) — one filing per
--     (jurisdiction, period) so a double-open is refused at the DB
--     boundary, not just at the lib layer.

CREATE TABLE IF NOT EXISTS sales_tax_filings (
  id                       TEXT    NOT NULL PRIMARY KEY,
  jurisdiction             TEXT    NOT NULL,
  kind                     TEXT    NOT NULL CHECK (kind IN ('monthly', 'quarterly', 'annual')),
  period_start             INTEGER NOT NULL,
  period_end               INTEGER NOT NULL,
  due_date                 INTEGER NOT NULL,
  status                   TEXT    NOT NULL CHECK (status IN ('draft', 'computed', 'submitted', 'paid', 'amended')),
  gross_revenue_minor      INTEGER NOT NULL DEFAULT 0 CHECK (gross_revenue_minor   >= 0),
  taxable_revenue_minor    INTEGER NOT NULL DEFAULT 0 CHECK (taxable_revenue_minor >= 0),
  exempt_revenue_minor     INTEGER NOT NULL DEFAULT 0 CHECK (exempt_revenue_minor  >= 0),
  tax_collected_minor      INTEGER NOT NULL DEFAULT 0 CHECK (tax_collected_minor   >= 0),
  tax_owed_minor           INTEGER NOT NULL DEFAULT 0 CHECK (tax_owed_minor        >= 0),
  breakdown_json           TEXT    NOT NULL DEFAULT '{}',
  submission_ref           TEXT,
  submitted_at             INTEGER,
  submitted_by             TEXT,
  payment_minor            INTEGER CHECK (payment_minor IS NULL OR payment_minor >= 0),
  payment_ref              TEXT,
  paid_at                  INTEGER,
  amended_at               INTEGER,
  amended_reason           TEXT,
  computed_at              INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  CHECK (period_end > period_start),
  CHECK (due_date >= period_end)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_tax_filings_unique
  ON sales_tax_filings(jurisdiction, kind, period_start);
CREATE INDEX IF NOT EXISTS idx_sales_tax_filings_jur_status
  ON sales_tax_filings(jurisdiction, status, due_date);
CREATE INDEX IF NOT EXISTS idx_sales_tax_filings_status_due
  ON sales_tax_filings(status, due_date);
CREATE INDEX IF NOT EXISTS idx_sales_tax_filings_period
  ON sales_tax_filings(period_start, period_end);
