-- Consent ledger — append-only historical record of every consent
-- decision a customer makes (cookie categories, marketing email
-- opt-in, SMS opt-in, third-party data sharing, general data
-- processing).
--
-- Distinct from `cookie_consent_records`. cookieConsent stores per-
-- SESSION decisions keyed by a hashed session id — short-lived,
-- bounded by browser cookie lifetime, purged by cleanupOlderThan.
-- consentLedger stores per-CUSTOMER decisions keyed by customer
-- UUID — durable, never updated, mandatory under GDPR art. 7(1)
-- ("the controller shall be able to demonstrate that the data
-- subject has consented to processing of his or her personal
-- data"). A single customer can carry both a cookie_consent record
-- AND a consent_ledger row covering the same category; the ledger
-- is the audit-of-record for the supervisory authority.
--
-- Append-only — no UPDATE / DELETE on the table from the primitive
-- surface. Withdrawing consent writes a NEW row with state =
-- 'withdrawn' so the prior 'granted' row survives the timeline. A
-- Subject Access Request (`auditExport`) returns every row for the
-- customer in newest-first order; a supervisory-authority sweep
-- (`bulkExportByJurisdiction`) returns every row in the requested
-- jurisdiction over a closed time window.
--
-- `consent_kind` enumerates the nine consent categories shipped in
-- v1:
--
--   cookies_functional         — remember-me, locale, currency picker
--   cookies_analytics          — Plausible / GA / Matomo
--   cookies_marketing          — ad pixels, retargeting
--   cookies_preferences        — saved UI tweaks
--   marketing_email            — newsletter, promo blasts
--   marketing_sms              — SMS marketing (TCPA-relevant in US)
--   data_sharing_partners      — third-party data-sharing for
--                                fulfilment / affiliate analytics
--   data_sharing_analytics     — third-party aggregate-analytics
--                                pipelines (Snowflake / BigQuery sink)
--   data_processing            — catch-all for processing purposes
--                                outside the eight category-specific
--                                kinds; the row's `evidence_ref`
--                                identifies the purpose.
--
-- `state` is binary: granted / withdrawn. Operators chain transitions
-- as separate rows. The current state for a (customer_id,
-- consent_kind) tuple is the latest row by `occurred_at`.
--
-- `source` identifies how the consent decision arrived:
--   signup_form          — first-touch checkbox during account creation
--   preference_center    — buyer-visited /account/preferences toggle
--   cookie_banner        — banner OK / Reject button
--   customer_support     — operator-recorded on behalf of buyer
--                          (e.g. phone-call confirmation)
--   system_default       — implicit grant via legitimate-interest
--                          claim (must be revocable; rare)
--   data_subject_request — recorded as part of a SAR / erasure /
--                          rectification flow
--
-- `jurisdiction` is the ISO-3166-1 alpha-2 country code (uppercase)
-- the decision falls under, nullable when unknown. The bulk-export
-- and compliance-summary paths filter on this column so an operator
-- under a supervisory-authority sweep can produce the per-country
-- evidence package in one query.
--
-- `evidence_ref` is an operator-supplied free-form pointer to the
-- evidence row that proves consent was given (form-submission id,
-- support-ticket id, audit-log row id). The ledger never resolves
-- the ref — it's an opaque string the operator's audit story
-- understands. Nullable when the source itself is the evidence
-- (e.g. cookie_banner click is its own audit row).

CREATE TABLE IF NOT EXISTS consent_ledger (
  id            TEXT NOT NULL PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  consent_kind  TEXT NOT NULL CHECK (consent_kind IN (
                  'cookies_functional',
                  'cookies_analytics',
                  'cookies_marketing',
                  'cookies_preferences',
                  'marketing_email',
                  'marketing_sms',
                  'data_sharing_partners',
                  'data_sharing_analytics',
                  'data_processing'
                )),
  state         TEXT NOT NULL CHECK (state IN ('granted', 'withdrawn')),
  source        TEXT NOT NULL CHECK (source IN (
                  'signup_form',
                  'preference_center',
                  'cookie_banner',
                  'customer_support',
                  'system_default',
                  'data_subject_request'
                )),
  jurisdiction  TEXT,
  evidence_ref  TEXT,
  occurred_at   INTEGER NOT NULL
);

-- Per-customer audit walk: SAR exports + currentStateForCustomer.
CREATE INDEX IF NOT EXISTS idx_consent_ledger_customer_occurred
  ON consent_ledger(customer_id, occurred_at DESC);

-- Compliance-summary rollups by kind/state across the org over a
-- time window.
CREATE INDEX IF NOT EXISTS idx_consent_ledger_kind_state_occurred
  ON consent_ledger(consent_kind, state, occurred_at);

-- Supervisory-authority bulk export per jurisdiction.
CREATE INDEX IF NOT EXISTS idx_consent_ledger_jurisdiction_occurred
  ON consent_ledger(jurisdiction, occurred_at);
