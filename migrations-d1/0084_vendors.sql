-- Vendors — multi-vendor marketplace foundation. Each vendor (a
-- supplier or third-party brand the operator drop-ships from) is
-- registered with contact info, a payout rule, and an explicit
-- assignment of which catalog SKUs they fulfill. Vendors are distinct
-- from `affiliates`: an affiliate is a referrer paid a commission for
-- driving traffic; a vendor actually ships the goods. A single SKU
-- can only be fulfilled by ONE vendor at a time (the operator picks
-- the supplier; the UNIQUE constraint on `vendor_skus.sku` is the
-- enforcement).
--
-- Three tables:
--
--   vendors                — one row per supplier/brand. `slug` is the
--                            operator-chosen stable handle and is the
--                            PRIMARY KEY (lowercase alnum + dash,
--                            shape-validated at the write site). The
--                            slug surfaces in operator-facing URLs +
--                            payout reconciliation so the choice is
--                            deliberate; `updateVendor` cannot patch
--                            the slug — operators archive + re-register
--                            to re-key. `contact_email_hash` is
--                            `b.crypto.namespaceHash("vendor-contact-
--                            email", lowercased)` so the raw address
--                            never lands on disk; the operator console
--                            re-derives the hash to look up a vendor
--                            by email. `contact_email_normalised`
--                            keeps the trimmed + lowercased form so
--                            the operator console can group by email-
--                            shape without the hash (the hash is one-
--                            way; the normalised form is what the
--                            operator console renders). `address_json`
--                            is opaque JSON (the shape mirrors
--                            `customer_addresses` but isn't enforced
--                            here — the payout / shipping pipeline
--                            consumes it). `payout_address` is opaque
--                            (an IBAN, PayPal handle, Stripe Connect
--                            id — whatever the operator's payout
--                            pipeline consumes); shape validation is
--                            the payout pipeline's concern. The FSM
--                            column `status` is one of
--                              active     — fulfilling orders, accruing
--                                           commission
--                              paused     — temporarily disabled (KYC
--                                           review, payout issue);
--                                           historical commissions
--                                           still settle but new SKU
--                                           assignment refuses
--                              archived   — terminal soft-delete; no
--                                           more SKU assignments,
--                                           historical rows preserved
--                            `paused_at` / `archived_at` stamp the
--                            transitions for audit. `commission_split_bps`
--                            is the vendor's basis-point share of each
--                            order's gross (10000 = 100%); the operator
--                            keeps `10000 - commission_split_bps`.
--
--   vendor_skus            — assignment join table. (vendor_slug, sku)
--                            is the composite PK so a sku can only be
--                            assigned to one vendor at a time (a
--                            second `INSERT` with the same sku raises
--                            UNIQUE — operators unassign before
--                            reassigning). `assigned_at` is the audit
--                            timestamp. No FK on `sku` — the SKU lives
--                            in the catalog primitive's `variants`
--                            table and may be created out of order
--                            with the vendor assignment.
--
--   vendor_commissions     — append-only ledger of vendor payouts.
--                            `commission_minor` is computed at write
--                            time from the vendor's *current*
--                            `commission_split_bps` and the order
--                            gross; the row preserves the resolved
--                            amount so a later operator-side split
--                            change doesn't retroactively alter
--                            historical payouts. `status` is the
--                            payout FSM:
--                              pending — recorded, not yet paid
--                              paid    — payout_reference stamped
--                              voided  — refund / chargeback /
--                                        operator override
--                            UNIQUE on (vendor_slug, order_id) keeps
--                            `recordCommission` idempotent — a
--                            duplicate call for the same (vendor,
--                            order) returns the existing row.
--
-- Operator payout flow lives outside this primitive (a finance
-- process that calls `payoutsDue` + records the wire / ACH against
-- the resulting commission rows). The primitive owns the registry +
-- the ledger; the dispatch of money is the operator's pipeline.

CREATE TABLE IF NOT EXISTS vendors (
  slug                        TEXT NOT NULL PRIMARY KEY,
  name                        TEXT NOT NULL,
  contact_email_hash          TEXT NOT NULL,
  contact_email_normalised    TEXT NOT NULL,
  contact_phone               TEXT,
  address_json                TEXT,
  payout_method               TEXT NOT NULL CHECK (payout_method IN (
    'paypal', 'bank_transfer', 'stripe_connect', 'gift_card', 'store_credit'
  )),
  payout_address              TEXT NOT NULL,
  commission_split_bps        INTEGER NOT NULL CHECK (commission_split_bps >= 0 AND commission_split_bps <= 10000),
  status                      TEXT NOT NULL CHECK (status IN (
    'active', 'paused', 'archived'
  )),
  paused_at                   INTEGER,
  archived_at                 INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendors_status
  ON vendors(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendors_email_hash
  ON vendors(contact_email_hash);

CREATE TABLE IF NOT EXISTS vendor_skus (
  vendor_slug                 TEXT NOT NULL,
  sku                         TEXT NOT NULL UNIQUE,
  assigned_at                 INTEGER NOT NULL,
  PRIMARY KEY (vendor_slug, sku),
  FOREIGN KEY (vendor_slug) REFERENCES vendors(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vendor_skus_vendor
  ON vendor_skus(vendor_slug, assigned_at DESC);

CREATE TABLE IF NOT EXISTS vendor_commissions (
  id                          TEXT NOT NULL PRIMARY KEY,
  vendor_slug                 TEXT NOT NULL,
  order_id                    TEXT NOT NULL,
  gross_minor                 INTEGER NOT NULL CHECK (gross_minor >= 0),
  commission_minor            INTEGER NOT NULL CHECK (commission_minor >= 0),
  currency                    TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN (
    'pending', 'paid', 'voided'
  )),
  occurred_at                 INTEGER NOT NULL,
  paid_at                     INTEGER,
  payout_reference            TEXT,
  FOREIGN KEY (vendor_slug) REFERENCES vendors(slug) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_commissions_order
  ON vendor_commissions(vendor_slug, order_id);
CREATE INDEX IF NOT EXISTS idx_vendor_commissions_vendor_status
  ON vendor_commissions(vendor_slug, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_commissions_status_occurred
  ON vendor_commissions(status, occurred_at DESC);
