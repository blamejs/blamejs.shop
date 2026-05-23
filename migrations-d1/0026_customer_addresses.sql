-- Customer addresses: saved shipping/billing addresses on accounts.
--
-- One row per saved address. `label` is operator-supplied free text
-- ("Home", "Office", "Mom's place") — the primitive caps the length
-- and refuses control bytes but does not impose semantics.
--
-- `country` is ISO 3166-1 alpha-2, uppercase, exactly two letters.
-- The CHECK constraint enforces the length; the primitive enforces
-- the character class. Operators wanting strict country-list
-- validation (against, e.g., the current ISO list with EU sub-codes
-- excluded) compose their own validator on top.
--
-- `phone` is optional E.164-ish — the primitive enforces a single
-- leading `+`, a non-zero first digit, and an overall length of
-- 2-16 characters. Storage is plaintext (operators frequently need
-- to display the number back to staff for outbound contact); a
-- privacy-conscious operator can rotate the column out via a custom
-- migration if their threat model warrants.
--
-- `is_default_shipping` and `is_default_billing` are
-- one-per-customer-per-role flags. The primitive enforces the
-- uniqueness at write time (clearing the flag on the customer's
-- other addresses inside the same call) — the schema doesn't add a
-- partial UNIQUE index because D1's SQLite build supports them but
-- the write-time clear is cheaper than catching the constraint
-- violation and restarting the transaction.
--
-- `is_archived` is the soft-delete flag. Archived rows stay in the
-- table for historical-order lookups (an order that shipped to an
-- address that's since been removed from the customer's saved list
-- still needs to display the recipient + street). The
-- listForCustomer surface filters them out by default; the
-- `include_archived` option opts them back in.

CREATE TABLE IF NOT EXISTS customer_addresses (
  id                  TEXT NOT NULL PRIMARY KEY,
  customer_id         TEXT NOT NULL,
  label               TEXT NOT NULL DEFAULT '',
  recipient_name      TEXT NOT NULL,
  company             TEXT NOT NULL DEFAULT '',
  street_line1        TEXT NOT NULL,
  street_line2        TEXT NOT NULL DEFAULT '',
  city                TEXT NOT NULL,
  region              TEXT NOT NULL DEFAULT '',
  postal_code         TEXT NOT NULL,
  country             TEXT NOT NULL CHECK (length(country) = 2),
  phone               TEXT NOT NULL DEFAULT '',
  is_default_shipping INTEGER NOT NULL DEFAULT 0 CHECK (is_default_shipping IN (0,1)),
  is_default_billing  INTEGER NOT NULL DEFAULT 0 CHECK (is_default_billing IN (0,1)),
  is_archived         INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
  ON customer_addresses(customer_id, is_archived, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_default_shipping
  ON customer_addresses(customer_id, is_default_shipping);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_default_billing
  ON customer_addresses(customer_id, is_default_billing);
