-- Compliance export — per-customer subject-access-request lifecycle
-- for GDPR / CCPA / LGPD (and "other" jurisdictions an operator
-- declares). A customer (or operator acting on the customer's
-- behalf) files a request; the primitive walks every injected
-- per-domain reader (customers / orders / order-notes /
-- subscriptions / addresses / payment-methods / support-tickets /
-- loyalty) and assembles a structured bundle keyed on the
-- customer_id. The operator's delivery worker ships the bundle out
-- of band — this table only tracks the request lifecycle.
--
-- Distinct from `scheduled_exports` (order-export's operator bulk
-- CSV / NDJSON dump of the orders table). That primitive answers
-- "give me every order in this date range." This one answers
-- "the customer asked, under law X, for a copy of their data — or
-- asked us to delete it — what's the status?"
--
-- Schema decisions:
--
--   * Single table covers both kinds. `request_kind` is a closed
--     enum (`export` / `deletion`); the lifecycle is the same shape
--     ("received -> processing -> fulfilled -> delivered" for export;
--     "received -> processing -> fulfilled" for deletion, where the
--     `delivery_*` columns stay NULL). A single table keeps the
--     audit-for-customer query a single read and lets the operator
--     dashboard render the two kinds side by side.
--
--   * `jurisdiction` is a closed enum so a downstream dashboard /
--     SLA tracker can branch on the applicable clock (GDPR Art. 12
--     allows up to one month; CCPA §1798.130(a)(2) allows 45 days
--     extendable to 90; LGPD Art. 19 allows 15 days). The primitive
--     itself doesn't enforce the deadline — that's the operator's
--     workflow tooling — but persisting it keeps the audit log
--     defensible.
--
--   * `scope` is a closed enum (`full` / `orders_only` /
--     `identity_only`) nullable so it can be omitted on `deletion`
--     rows (deletion is always a customer-wide gesture; scoping a
--     deletion to a subset would create a partial-erasure artifact
--     that operator law-firm review would refuse). On `export`
--     rows, NULL is forbidden by app-layer validation; the CHECK
--     here only constrains the enum membership when a value is
--     present.
--
--   * `status` lifecycle:
--       received  — request filed; nothing read yet
--       processing — fulfillment in flight (a worker is building
--                    the bundle / a deletion sweep is running)
--       fulfilled  — bundle assembled (export) or deletion executed
--                    (deletion). For exports this is the state
--                    where the bundle JSON is ready for handoff to
--                    the delivery worker.
--       delivered  — bundle shipped to the requesting party
--                    (export only — deletion has no delivered state
--                    since there's nothing to ship).
--       dismissed  — request refused (e.g. identity verification
--                    failed, customer already deleted, jurisdiction
--                    out of scope). `dismiss_reason` captures the
--                    operator-authored justification.
--
--   * `delivery_method` / `delivery_address` are nullable strings
--     stamped at dispatch time. The primitive doesn't enumerate the
--     method namespace — `email` / `s3` / `secure-link` / `mail` are
--     all common; the operator's worker owns the actual delivery
--     channel.
--
--   * No cryptographic chain. Operators wanting tamper-evident
--     records compose this primitive's lifecycle calls with
--     `operatorAuditLog` at the action level (same posture as
--     refund-policy / RMA).
--
-- Indexes:
--   * `(customer_id, requested_at DESC)` — `auditForCustomer`
--     reads a single customer's history.
--   * `(status, requested_at DESC)`     — operator dashboard
--     "show me every received / processing request."
--   * `(jurisdiction, status, requested_at DESC)` — SLA tracker
--     "every GDPR request still open, oldest first."

CREATE TABLE IF NOT EXISTS compliance_requests (
  id                TEXT NOT NULL PRIMARY KEY,
  customer_id       TEXT NOT NULL,
  request_kind      TEXT NOT NULL CHECK (request_kind IN (
                      'export',
                      'deletion'
                    )),
  jurisdiction      TEXT NOT NULL CHECK (jurisdiction IN (
                      'gdpr',
                      'ccpa',
                      'lgpd',
                      'other'
                    )),
  scope             TEXT CHECK (scope IS NULL OR scope IN (
                      'full',
                      'orders_only',
                      'identity_only'
                    )),
  status            TEXT NOT NULL DEFAULT 'received' CHECK (status IN (
                      'received',
                      'processing',
                      'fulfilled',
                      'delivered',
                      'dismissed'
                    )),
  requested_by      TEXT NOT NULL,
  requested_at      INTEGER NOT NULL,
  fulfilled_at      INTEGER,
  delivered_at      INTEGER,
  dismiss_reason    TEXT,
  delivery_method   TEXT,
  delivery_address  TEXT,
  reason            TEXT
);

CREATE INDEX IF NOT EXISTS idx_compliance_requests_customer
  ON compliance_requests(customer_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_requests_status
  ON compliance_requests(status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_requests_jurisdiction
  ON compliance_requests(jurisdiction, status, requested_at DESC);
