-- Tax-exemption certificates — B2B / non-profit / government /
-- agricultural / manufacturer / direct-pay / foreign-diplomat
-- certificates uploaded by buyers and approved by the operator before
-- being honoured at checkout.
--
-- The `certificate_number` field stores operator-display plaintext
-- (the operator needs to verify the number against the document scan
-- the buyer uploaded). `certificate_number_hash` is the
-- b.crypto.namespaceHash("tax-cert-number", uppercase(trim(number)))
-- digest used for dedup — repeated submissions of the same cert by
-- the same customer for the same jurisdiction collapse to a single
-- row via the UNIQUE(customer_id, jurisdiction, certificate_number_hash)
-- index.
--
-- Lifecycle: every certificate enters 'pending-review'. An operator
-- transitions it to 'approved' or 'rejected'. An approved cert may
-- later transition to 'expired' (via the scheduler scan) or 'revoked'
-- (operator-detected fraud / cease-trading / etc.). Checkout reads
-- approved + non-expired rows to determine whether to suppress tax
-- for the buyer's jurisdiction.

CREATE TABLE IF NOT EXISTS tax_exempt_certificates (
  id              TEXT NOT NULL PRIMARY KEY,
  customer_id     TEXT NOT NULL,
  certificate_type TEXT NOT NULL CHECK (certificate_type IN ('resale','nonprofit','government','agricultural','manufacturer','direct-pay','foreign-diplomat','other')),
  jurisdiction    TEXT NOT NULL,                 -- 'US-CA' | 'US-NY' | 'CA-ON' | 'EU-DE' etc.
  certificate_number TEXT NOT NULL,              -- operator-issued or government-issued cert ID
  certificate_number_hash TEXT NOT NULL,         -- namespaceHash("tax-cert-number", uppercase(trim(certificate_number))) for dedup
  legal_name      TEXT NOT NULL,                 -- entity name on the certificate
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER,                       -- NULL = no expiry
  status          TEXT NOT NULL CHECK (status IN ('pending-review','approved','rejected','expired','revoked')),
  reviewed_at     INTEGER,
  reviewed_by     TEXT,
  rejection_reason TEXT,
  document_r2_key TEXT,                          -- optional R2 key for the uploaded scan
  notes           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(customer_id, jurisdiction, certificate_number_hash)
);
CREATE INDEX IF NOT EXISTS idx_tax_exempt_customer ON tax_exempt_certificates(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_tax_exempt_status ON tax_exempt_certificates(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_tax_exempt_jurisdiction ON tax_exempt_certificates(jurisdiction, status);
