-- Vendor invoices: the operator's record of bills RECEIVED FROM a
-- vendor against goods or services. Distinct from `invoiceRenderer`,
-- which renders operator-to-customer invoices; this table is the
-- accounts-payable side. The lifecycle:
--
--   received -> approved -> paid
--      |           |
--      +--> disputed  (operator pushes back on amount / line items)
--      +--> voided    (vendor reissued / duplicate / cancelled)
--
-- Receipt is the initial state — the operator captured the bill but
-- hasn't done the internal accounts-payable approval yet. Approval
-- means the operator (or the operator's accounts-payable agent) has
-- signed off the amount + line items against the related POs and
-- the goods-received note. Paid carries the payment_ref + paid_minor
-- so partial-pay scenarios (the operator only paid the undisputed
-- portion) are first-class. Disputed and voided are terminal in the
-- sense that the FSM doesn't continue forward from them — the
-- operator either records a follow-up invoice (vendor reissued) or
-- recovers the row by re-approving after dispute resolution offline.
--
-- UNIQUE(vendor_slug, invoice_number) is the duplicate guard: a
-- vendor's invoice numbers are unique within their own sequence; the
-- operator capturing the same invoice twice (accidental double-entry)
-- gets a constraint failure rather than a silent duplicate that
-- inflates accounts-payable balances.
--
-- `line_items_json` is the operator-captured array of line entries
-- (description / quantity / unit_cost_minor / total_minor). Operators
-- transcribe what the vendor's paper / EDI invoice says verbatim so
-- the reconciliation against the PO + receipt is line-by-line.
--
-- `related_po_ids_json` is the operator-supplied set of PO ids the
-- invoice covers. A single vendor invoice can cover multiple POs
-- (consolidated month-end billing) and a single PO can be split
-- across multiple invoices (vendor invoices on partial shipment).
-- The reconciliation primitive walks both directions: every PO line
-- billed should match a PO entry, every PO entry should be billed.
--
-- Indexes drive the operator dashboards:
--   * (vendor_slug, status)   — invoicesForVendor + aging report
--   * (status, due_date)      — unpaidInvoices window
--   * (invoice_date)          — metrics + reporting
--   * UNIQUE(vendor_slug, invoice_number) — duplicate guard

CREATE TABLE IF NOT EXISTS vendor_invoices (
  id                   TEXT    NOT NULL PRIMARY KEY,
  vendor_slug          TEXT    NOT NULL,
  invoice_number       TEXT    NOT NULL,
  invoice_date         INTEGER NOT NULL,
  due_date             INTEGER NOT NULL,
  amount_minor         INTEGER NOT NULL,
  currency             TEXT    NOT NULL,
  line_items_json      TEXT    NOT NULL,
  related_po_ids_json  TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('received', 'approved', 'paid', 'disputed', 'voided')),
  approved_by          TEXT,
  approved_at          INTEGER,
  payment_ref          TEXT,
  paid_at              INTEGER,
  paid_minor           INTEGER,
  disputed_at          INTEGER,
  dispute_reason       TEXT,
  voided_at            INTEGER,
  void_reason          TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(vendor_slug, invoice_number),
  CHECK ((status = 'received'  AND approved_at IS NULL AND paid_at IS NULL AND disputed_at IS NULL AND voided_at IS NULL)
      OR (status = 'approved'  AND approved_at IS NOT NULL AND paid_at IS NULL AND voided_at IS NULL)
      OR (status = 'paid'      AND approved_at IS NOT NULL AND paid_at IS NOT NULL AND payment_ref IS NOT NULL)
      OR (status = 'disputed'  AND disputed_at IS NOT NULL AND dispute_reason IS NOT NULL)
      OR (status = 'voided'    AND voided_at IS NOT NULL AND void_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_vendor_invoices_vendor_status ON vendor_invoices(vendor_slug, status);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_status_due    ON vendor_invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_invoice_date  ON vendor_invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_due_date      ON vendor_invoices(due_date);
