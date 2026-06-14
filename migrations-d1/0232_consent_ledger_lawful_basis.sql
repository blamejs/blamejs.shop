-- GDPR Art. 6(1) lawful basis on each consent-ledger row.
--
-- A consent decision records WHAT the customer decided (consent_kind,
-- state) but not the legal basis the controller processes under. Art.
-- 6(1) names six lawful bases; surfacing the basis on each row lets a
-- Subject Access Request and a supervisory-authority export show not
-- just the decision but the basis it rests on.
--
-- Nullable, CHECK-constrained to the six Art. 6(1) bases. SQLite
-- enforces the CHECK only for rows written after this ALTER, so any
-- pre-existing / backfill-imported row keeps NULL ("basis not recorded
-- at decision time") rather than being assigned a fabricated basis.
-- consentLedger.recordConsentChange stamps the basis on every new row
-- (defaulting from the consent kind, all of which are consent-gated).

ALTER TABLE consent_ledger ADD COLUMN lawful_basis TEXT CHECK (lawful_basis IN (
  'consent','contract','legal_obligation','vital_interests','public_task','legitimate_interests'
));
