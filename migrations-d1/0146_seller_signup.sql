-- Seller signup — marketplace seller onboarding flow. Companion to
-- `vendors` (which is the registry of suppliers the operator
-- drop-ships from): this primitive owns the application-to-vendor
-- pipeline. A prospective seller submits an application, the
-- operator (or an internal KYC/AML team) requests supporting
-- documents, the applicant uploads them, the operator approves or
-- rejects. On approval the primitive composes
-- `vendors.registerVendor` to mint the real vendor row; the
-- application row stays around with `status='approved'` and a
-- `vendor_slug` pointer for audit. Distinct from `customer_roles`
-- (which models B2B account hierarchy inside a single customer
-- entity); this is the inbound application funnel.
--
-- Two tables:
--
--   seller_applications              — one row per application.
--     `id` is a uuid v7 primary key (sortable; B-tree locality so
--     the operator inbox can keyset-paginate by created_at without
--     a second index). Contact email / phone / tax_id are
--     hashed via `b.crypto.namespaceHash` under the
--     "seller-signup-email" / "seller-signup-phone" / "seller-
--     signup-tax-id" namespaces so the raw values never land on
--     disk; the `_normalised` siblings keep the trimmed +
--     lowercased forms (last 4 only for tax_id) so the operator
--     console can render a human-readable identifier without
--     unhashing. `business_address_json` is opaque JSON (the
--     shape mirrors customer_addresses but isn't enforced here).
--     `tax_id_kind` is a closed enum capturing what kind of tax
--     identifier the applicant supplied (US SSN / EIN, EU VAT,
--     UK UTR, AU ABN, etc.). `category_focus_json` is the
--     applicant's stated product categories (free-form list, an
--     operator-facing hint — the operator decides whether the
--     applicant's catalog actually fits). `expected_monthly_
--     volume_minor` is the applicant's self-reported volume in
--     minor units of `currency`; a sanity cap is enforced at the
--     write site. `references_json` is optional opaque JSON
--     (references, social handles, business website, etc.).
--     The FSM column `status` walks:
--       submitted             — application captured, awaiting
--                               operator review
--       docs_pending          — operator has requested one or more
--                               supporting documents
--       in_review             — every requested doc has been
--                               uploaded; operator is verifying
--       revisions_requested   — operator needs the applicant to
--                               refile something (additional doc,
--                               corrected info). The doc table
--                               receives one or more new
--                               `requested` rows; the application
--                               returns to docs_pending once the
--                               applicant uploads them.
--       approved              — vendor row minted via
--                               `vendors.registerVendor`;
--                               `vendor_slug` populated
--       rejected              — terminal; `reject_reason` captured
--       withdrawn             — terminal; applicant withdrew
--                               (out-of-scope for the v1 surface,
--                               column reserved for future
--                               withdrawApplication verb without a
--                               schema bump)
--     `approved_at` / `approved_by` / `rejected_at` /
--     `rejected_by` / `reject_reason` / `vendor_slug` are the
--     terminal-transition audit stamps. `created_at` /
--     `updated_at` are managed by the primitive.
--
--   seller_application_documents     — append-only document
--     requests + uploads. One row per (application, doc_kind)
--     instance — the operator requests a `w9`, the applicant
--     uploads it; if the operator then re-requests the same
--     doc_kind via `requestRevisions`, a NEW row lands so the
--     audit trail captures every revision cycle. The FK to
--     `seller_applications.id` cascades on delete so an operator
--     who hard-deletes an abandoned application (a privacy-
--     erasure migration concern out of scope here) drops the
--     associated docs in one move. `sha3_512` / `byte_size` /
--     `mime_type` / `uploaded_at` are populated on
--     `recordDocumentUploaded`. The doc body itself is NOT
--     stored here — the operator's object-store / sealed-storage
--     pipeline owns the bytes; this primitive owns the
--     content-addressed pointer + the FSM beat.
--
-- The vendor row that lands on approval is the operator's
-- ongoing relationship; the application row is the historical
-- audit grain for "how did this vendor get here?" Operators read
-- `getApplication(id)` + `documentsForApplication(application_id)`
-- to render the full onboarding paper trail for compliance.

CREATE TABLE IF NOT EXISTS seller_applications (
  id                              TEXT NOT NULL PRIMARY KEY,
  business_name                   TEXT NOT NULL,
  contact_email_hash              TEXT NOT NULL,
  contact_email_normalised        TEXT NOT NULL,
  contact_phone_hash              TEXT NOT NULL,
  contact_phone_normalised        TEXT NOT NULL,
  business_address_json           TEXT NOT NULL,
  tax_id_kind                     TEXT NOT NULL CHECK (tax_id_kind IN (
    'us_ssn', 'us_ein', 'eu_vat', 'uk_utr', 'au_abn', 'ca_bn', 'other'
  )),
  tax_id_hash                     TEXT NOT NULL,
  tax_id_normalised_last4         TEXT NOT NULL,
  category_focus_json             TEXT NOT NULL,
  expected_monthly_volume_minor   INTEGER NOT NULL CHECK (expected_monthly_volume_minor >= 0),
  currency                        TEXT NOT NULL,
  references_json                 TEXT,
  status                          TEXT NOT NULL CHECK (status IN (
    'submitted', 'docs_pending', 'in_review', 'revisions_requested',
    'approved', 'rejected', 'withdrawn'
  )),
  approved_at                     INTEGER,
  approved_by                     TEXT,
  rejected_at                     INTEGER,
  rejected_by                     TEXT,
  reject_reason                   TEXT,
  vendor_slug                     TEXT,
  created_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seller_applications_status
  ON seller_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_applications_email_hash
  ON seller_applications(contact_email_hash);
CREATE INDEX IF NOT EXISTS idx_seller_applications_phone_hash
  ON seller_applications(contact_phone_hash);
CREATE INDEX IF NOT EXISTS idx_seller_applications_tax_id_hash
  ON seller_applications(tax_id_hash);
CREATE INDEX IF NOT EXISTS idx_seller_applications_created_at
  ON seller_applications(created_at DESC);

CREATE TABLE IF NOT EXISTS seller_application_documents (
  id                              TEXT NOT NULL PRIMARY KEY,
  application_id                  TEXT NOT NULL,
  doc_kind                        TEXT NOT NULL CHECK (doc_kind IN (
    'w9', 'w8ben', 'id', 'business_license', 'utility_bill',
    'insurance', 'bank_statement', 'other'
  )),
  status                          TEXT NOT NULL CHECK (status IN (
    'requested', 'uploaded', 'accepted', 'rejected'
  )),
  instructions                    TEXT NOT NULL,
  sha3_512                        TEXT,
  byte_size                       INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  mime_type                       TEXT,
  uploaded_at                     INTEGER,
  accepted_at                     INTEGER,
  rejected_at                     INTEGER,
  reject_reason                   TEXT,
  created_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL,
  FOREIGN KEY (application_id) REFERENCES seller_applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_seller_application_documents_app
  ON seller_application_documents(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_application_documents_status
  ON seller_application_documents(application_id, status, created_at DESC);
