-- Payment methods: per-customer saved processor tokens.
--
-- This table stores the OPERATOR-FACING reference to a payment
-- instrument the customer has agreed to keep on file with the
-- payment processor (Stripe, PayPal, Square, Braintree,
-- Authorize.Net). The shop never sees the raw PAN or CVV — those
-- live exclusively inside the processor's PCI-DSS scope. What we
-- store is:
--
--   - `processor`        — which processor owns the token
--   - `processor_token`  — the opaque token the processor returned
--                          (e.g. Stripe `pm_…`, PayPal billing-
--                          agreement id). Unique per processor.
--   - `brand`            — operator-supplied display brand
--                          ("visa" / "mc" / "amex" / "paypal" / …).
--                          Free-form short string; the primitive
--                          enforces shape, not enum.
--   - `last4`            — exactly 4 ASCII digits. Display-only
--                          ("ending in 4242").
--   - `exp_month` / `exp_year` — for cards; non-card processors
--                          (PayPal billing agreements) pass synthetic
--                          values the primitive accepts as long as
--                          they're in-range. Future calendar.
--   - `billing_address_id` — optional FK-style reference to an
--                          address row owned elsewhere in the shop.
--                          Nullable so PayPal-style wallets without
--                          a separate billing-address concept work.
--   - `label`            — optional customer-supplied nickname
--                          ("Work card", "Family AmEx").
--   - `is_default`       — exactly one row per customer may carry
--                          `is_default = 1` AND `archived_at IS NULL`.
--                          The default-uniqueness invariant is
--                          maintained write-side by the primitive
--                          (sibling clear + new set in the same
--                          transaction); a partial unique index
--                          enforces it as a hard floor.
--   - `archived_at` / `archive_reason` — set when the customer
--                          requests removal, when the card expires,
--                          when it's replaced, when fraud is
--                          suspected, or when an operator deletes
--                          it administratively. Archive is
--                          irreversible — operators add a new row
--                          rather than un-archiving an old one, so
--                          the GDPR audit trail stays linear.
--
-- Companion table `payment_method_audit` is the append-only ledger
-- of every event that mutated the row (added, default-set, default-
-- cleared, archived). It's the source of truth for "show me the
-- full history of this payment method" / GDPR data-subject access
-- requests.

CREATE TABLE IF NOT EXISTS payment_methods (
  id                   TEXT NOT NULL PRIMARY KEY,
  customer_id          TEXT NOT NULL,
  processor            TEXT NOT NULL CHECK (processor IN ('stripe', 'paypal', 'square', 'braintree', 'authorize_net')),
  processor_token      TEXT NOT NULL,
  brand                TEXT NOT NULL,
  last4                TEXT NOT NULL CHECK (length(last4) = 4),
  exp_month            INTEGER NOT NULL CHECK (exp_month >= 1 AND exp_month <= 12),
  exp_year             INTEGER NOT NULL CHECK (exp_year >= 1970),
  billing_address_id   TEXT,
  label                TEXT,
  is_default           INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  archived_at          INTEGER,
  archive_reason       TEXT CHECK (archive_reason IS NULL OR archive_reason IN ('customer_request', 'expired', 'replaced', 'fraud', 'operator')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Unique processor-token per processor: the same Stripe `pm_…`
-- cannot be saved twice. Two different processors using the same
-- string remain distinct (the (processor, processor_token) pair is
-- the uniqueness key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_processor_token
  ON payment_methods(processor, processor_token);

-- Default-uniqueness floor: at most one live default per customer.
-- Partial index excludes archived rows so an old archived default
-- doesn't block setting a new one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_one_default_per_customer
  ON payment_methods(customer_id) WHERE is_default = 1 AND archived_at IS NULL;

-- Customer-scoped lookups: list-all and list-active.
CREATE INDEX IF NOT EXISTS idx_payment_methods_customer
  ON payment_methods(customer_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_payment_methods_customer_default
  ON payment_methods(customer_id, is_default);

-- Scheduler walk for markExpired: cheap range scan over
-- (exp_year, exp_month) of live rows.
CREATE INDEX IF NOT EXISTS idx_payment_methods_expiry
  ON payment_methods(exp_year, exp_month) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS payment_method_audit (
  id                   TEXT NOT NULL PRIMARY KEY,
  payment_method_id    TEXT NOT NULL,
  event                TEXT NOT NULL CHECK (event IN ('added', 'default_set', 'default_cleared', 'archived')),
  occurred_at          INTEGER NOT NULL,
  actor                TEXT,
  reason               TEXT,
  FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_method_audit_pm
  ON payment_method_audit(payment_method_id, occurred_at);
