-- Carrier accounts — per-operator API credentials for shipping carriers
-- (UPS, FedEx, USPS, DHL, Canada Post, Royal Mail, Australia Post).
--
-- Two tables. `carrier_accounts` holds one row per operator credential
-- bundle (one operator may register several accounts with the same
-- carrier — one per ship-from country, or one production + one
-- sandbox); `carrier_usage_log` is the append-only per-call success /
-- latency record that `metricsForAccount` aggregates.
--
-- Credential hygiene:
--
--   The plaintext account_number, api_key, api_secret, and meter_number
--   NEVER reach this table. Every column ending in `_hash` is the hex
--   SHA3-512 digest produced by
--   `b.crypto.namespaceHash("carrier-account-<field>", plaintext)`. The
--   plaintext returns to the caller exactly once at `defineAccount` /
--   `rotateCredentials` time and the operator delivers it to their
--   downstream label-printer or fetch worker. The framework retains
--   only the hash so an at-rest snapshot of the database can't be
--   replayed against the carrier's API.
--
--   `account_number_normalised` is a non-secret derived value — the
--   account number with whitespace and dashes stripped — used as an
--   operator-facing display + dedupe key. The CHECK(length <= 12)
--   below cuts the column at the longest known carrier account-number
--   format (DHL's 9-digit + USPS's 10-digit), so a leaked DB column
--   can't be used to back-pivot into the full secret.
--
-- FSM:
--   active   — credentials accepted; verifyCredentials matches against
--              api_key_hash.
--   rotating — credentials just rotated; api_key_previous_hash is the
--              old digest and stays accepted for 24h so deployed
--              callers reload at their leisure.
--   disabled — terminal; verifyCredentials refuses immediately; the
--              row sticks around so usage history stays attributable.
--
-- Indexes:
--   * (carrier, account_label)     — accountByCarrier lookup.
--   * (status, carrier)            — listAccounts active-only filter.
--   * (account_number_normalised)  — operator-facing search by visible
--                                    digits.
--   * carrier_usage_log
--     (account_id, occurred_at)    — metricsForAccount window scan.

CREATE TABLE IF NOT EXISTS carrier_accounts (
  id                          TEXT NOT NULL PRIMARY KEY,
  carrier                     TEXT NOT NULL CHECK (carrier IN (
                                'ups', 'fedex', 'usps', 'dhl',
                                'canada_post', 'royal_mail', 'australia_post'
                              )),
  account_label               TEXT,
  account_number_hash         TEXT NOT NULL,
  account_number_normalised   TEXT NOT NULL CHECK (length(account_number_normalised) <= 12),
  api_key_hash                TEXT NOT NULL,
  api_key_previous_hash       TEXT,
  api_secret_hash             TEXT,
  meter_number_hash           TEXT,
  ship_from_address_json      TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'rotating')),
  disabled_reason             TEXT,
  disabled_at                 INTEGER,
  rotated_at                  INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS carrier_usage_log (
  id           TEXT NOT NULL PRIMARY KEY,
  account_id   TEXT NOT NULL,
  operation    TEXT NOT NULL,
  success      INTEGER NOT NULL CHECK (success IN (0, 1)),
  ms_elapsed   INTEGER NOT NULL CHECK (ms_elapsed >= 0),
  occurred_at  INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES carrier_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_carrier_accounts_carrier_label
  ON carrier_accounts(carrier, account_label);

CREATE INDEX IF NOT EXISTS idx_carrier_accounts_status_carrier
  ON carrier_accounts(status, carrier);

CREATE INDEX IF NOT EXISTS idx_carrier_accounts_normalised
  ON carrier_accounts(account_number_normalised);

CREATE INDEX IF NOT EXISTS idx_carrier_usage_log_account_time
  ON carrier_usage_log(account_id, occurred_at);
