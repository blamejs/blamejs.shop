-- Federated sign-in identities (Sign in with Google / Apple).
--
-- A customer can have one row per external identity provider. The
-- (provider, subject) pair is the durable account key — `subject` is
-- the IdP's `sub` claim, which is stable per (user, provider) even when
-- the user's email changes. We link orders by verified email but key
-- the *account* on (provider, subject), per the standard OIDC linking
-- discipline (email is mutable + reassignable; sub is not).
--
-- `email` / `email_verified` are the IdP-asserted values captured at
-- link time, kept for audit + reconciliation. They are NOT the trust
-- anchor for the account (the subject is); they gate guest-order
-- reconciliation, which only ever links on email_verified = 1.
--
-- A customer row is created passwordless (see 0006); this table adds a
-- federated credential alongside passkeys. One customer may hold both a
-- passkey and a Google identity.

CREATE TABLE IF NOT EXISTS customer_oauth_identities (
  id             TEXT NOT NULL PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  provider       TEXT NOT NULL,
  subject        TEXT NOT NULL,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- The account key: one customer per (provider, subject). A second
-- sign-in with the same Google account resolves to the same row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_oauth_provider_subject
  ON customer_oauth_identities(provider, subject);

-- Reverse lookup: every external identity attached to a customer.
CREATE INDEX IF NOT EXISTS idx_customer_oauth_customer
  ON customer_oauth_identities(customer_id);
