-- Shipping insurance — per-shipment third-party parcel insurance and
-- claim FSM. Composes a small set of operator-registered providers
-- (Shipsurance / Loop / U-PIC / Route) and the order's shipping label
-- to produce a per-shipment insurance purchase that the customer opts
-- into for high-value packages.
--
-- Three tables. The first holds the operator-registered providers
-- (name, code, declared-value floor + ceiling, premium calculation
-- inputs). The second holds the per-shipment insurance purchase the
-- customer made — one row per (provider, shipment) — with the quoted
-- premium, the declared value, and the carrier reference. The third
-- holds the per-insurance claim ledger; each insurance row may have
-- zero, one, or many claims over its lifetime (a customer can file a
-- damaged claim, get it approved, then later file a separate
-- not_delivered claim for the same parcel if a replacement also goes
-- missing). The claim primary key is its own UUID; insurance and
-- claim ids are surfaced as opaque to callers.
--
-- `insurance_providers` — operator-registered third-party insurer.
-- `code` is the primary key (operators reference the provider by
-- stable code in receipts / claim packets rather than by an opaque
-- UUID). `premium_rate_bps` is basis points (1/100ths of a percent)
-- charged against the declared value; `premium_min_minor` is the
-- floor so a $1 declared parcel doesn't pay a 0-cent premium.
-- `min_declared_value_minor` and `max_declared_value_minor` cap the
-- declared values the provider underwrites — Shipsurance underwrites
-- to $5,000, Loop to $10,000, etc., per their published rate cards.
-- `claim_window_days` is the number of days after purchase that a
-- customer can still file a claim; carriers + insurers agree on a
-- shared window per provider. `archived_at` soft-deletes a provider
-- without dropping historical insurance rows that reference it.
--
-- `shipping_insurances` — one row per (provider, shipment) purchase.
-- `shipment_id` and `provider_code` form a composite UNIQUE so the
-- customer can't double-insure the same parcel through the same
-- provider; they can purchase through a different provider as a
-- belt-and-braces overlay if they wish. `declared_value_minor` is
-- the operator-asserted parcel value the customer chose at checkout.
-- `premium_minor` is the snapshotted premium at purchase time — the
-- provider's `premium_rate_bps` may shift later, but the customer
-- pays what they were quoted. `currency` is the ISO-4217 alpha code.
-- `external_policy_id` is the provider-minted policy reference (the
-- code the customer presents on the provider's claim portal); the
-- primitive accepts whatever string the provider returns and gates
-- it loosely (alnum + a few punctuation chars, <= 128 chars).
-- `status` is a closed enum: active / cancelled / expired. Cancelled
-- = customer cancelled the order pre-shipment; expired = the
-- claim_window_days elapsed without any claims.
--
-- `insurance_claims` — append-only claim ledger. `claim_type` is one
-- of four operator-defined categories (lost / damaged / stolen /
-- not_delivered). `status` walks a four-state FSM: filed -> approved
-- (terminal) OR filed -> denied (terminal). `payout_minor` is the
-- insurer-approved payout amount on `approved` rows. `evidence_json`
-- is a free-form JSON object — typically the operator captures
-- photos URLs, carrier scan reports, signature attestations there;
-- the primitive only validates JSON round-trip, not the body shape
-- (insurers vary too much for a one-size-fits-all schema).
--
-- Indexes:
--   * (provider_code, status) on shipping_insurances — operator
--     dashboard "active insurance through Shipsurance" + the
--     `metricsForProvider` rollup.
--   * (order_id) on shipping_insurances — `insurancesForOrder` is
--     the storefront's per-order read; UNIQUE on (provider, shipment)
--     does NOT cover this read because an order can fan out to
--     multiple shipments.
--   * (insurance_id, filed_at DESC) on insurance_claims — the
--     `claimsForInsurance` walk.
--   * (status, filed_at DESC) on insurance_claims — operator
--     dashboard "claims awaiting review."

CREATE TABLE IF NOT EXISTS insurance_providers (
  code                       TEXT NOT NULL PRIMARY KEY,
  name                       TEXT NOT NULL,
  premium_rate_bps           INTEGER NOT NULL CHECK (premium_rate_bps >= 0 AND premium_rate_bps <= 10000),
  premium_min_minor          INTEGER NOT NULL CHECK (premium_min_minor >= 0),
  min_declared_value_minor   INTEGER NOT NULL CHECK (min_declared_value_minor >= 0),
  max_declared_value_minor   INTEGER NOT NULL CHECK (max_declared_value_minor > 0),
  claim_window_days          INTEGER NOT NULL CHECK (claim_window_days > 0),
  currency                   TEXT NOT NULL,
  active                     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at                INTEGER,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shipping_insurances (
  id                      TEXT NOT NULL PRIMARY KEY,
  provider_code           TEXT NOT NULL,
  shipment_id             TEXT NOT NULL,
  order_id                TEXT NOT NULL,
  customer_id             TEXT NOT NULL,
  declared_value_minor    INTEGER NOT NULL CHECK (declared_value_minor > 0),
  premium_minor           INTEGER NOT NULL CHECK (premium_minor >= 0),
  currency                TEXT NOT NULL,
  external_policy_id      TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'expired')),
  claim_window_ends_at    INTEGER NOT NULL,
  cancelled_at            INTEGER,
  expired_at              INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (provider_code, shipment_id),
  FOREIGN KEY (provider_code) REFERENCES insurance_providers(code)
);

CREATE TABLE IF NOT EXISTS insurance_claims (
  id              TEXT NOT NULL PRIMARY KEY,
  insurance_id    TEXT NOT NULL,
  claim_type      TEXT NOT NULL CHECK (claim_type IN ('lost', 'damaged', 'stolen', 'not_delivered')),
  status          TEXT NOT NULL CHECK (status IN ('filed', 'approved', 'denied')),
  claimed_amount_minor  INTEGER NOT NULL CHECK (claimed_amount_minor > 0),
  payout_minor    INTEGER,
  denial_reason   TEXT,
  evidence_json   TEXT NOT NULL DEFAULT '{}',
  filed_at        INTEGER NOT NULL,
  resolved_at     INTEGER,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (insurance_id) REFERENCES shipping_insurances(id)
);

CREATE INDEX IF NOT EXISTS idx_shipping_insurances_provider_status
  ON shipping_insurances(provider_code, status);

CREATE INDEX IF NOT EXISTS idx_shipping_insurances_order
  ON shipping_insurances(order_id);

CREATE INDEX IF NOT EXISTS idx_shipping_insurances_shipment
  ON shipping_insurances(shipment_id);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_insurance
  ON insurance_claims(insurance_id, filed_at DESC);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_status
  ON insurance_claims(status, filed_at DESC);
