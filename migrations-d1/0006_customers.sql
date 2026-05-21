-- Customers: passkey-enrolled accounts for the storefront.
--
-- v1 ships passwordless. The `customers` row holds an email_hash
-- (b.crypto.namespaceHash output — SHA3-512, domain-separated by the
-- "customer-email" prefix) and an operator-supplied display_name.
-- The raw email is never stored: lookups happen on the
-- deterministic hash so a stolen D1 dump leaks no addresses while
-- the storefront still resolves "is this address already
-- registered?" on the login form.
--
-- `customer_passkeys` holds one row per registered WebAuthn
-- credential. credential_id is the base64url public credential
-- handle from the authenticator (UNIQUE — a credential belongs to
-- exactly one customer). public_key is the COSE_Key bytes (PEM-
-- wrapped or base64-encoded — operator-shaped) needed by
-- b.auth.passkey.verifyAuthentication. counter tracks the signature
-- counter for clone detection; transports is the comma-separated
-- WebAuthn transports hint ("internal,hybrid,usb,...") that the
-- browser uses to narrow the credential picker.

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT NOT NULL PRIMARY KEY,
  email_hash    TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_hash ON customers(email_hash);
CREATE        INDEX IF NOT EXISTS idx_customers_updated_at ON customers(updated_at);

CREATE TABLE IF NOT EXISTS customer_passkeys (
  id             TEXT NOT NULL PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  credential_id  TEXT NOT NULL,
  public_key     TEXT NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports     TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_passkeys_credential ON customer_passkeys(credential_id);
CREATE        INDEX IF NOT EXISTS idx_customer_passkeys_customer   ON customer_passkeys(customer_id);
