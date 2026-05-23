-- Address validation + autocomplete cache — operator-supplied
-- normalization results, stored to avoid repeat API calls against the
-- carrier-side validators (USPS / Smarty / Lob / Google / Melissa /
-- manual). Distinct from `addresses` (which is the customer's saved
-- shipping/billing book) and from `geolocation` (which resolves a
-- request hint to a country settings row). The validation cache
-- answers one question:
--
--   "An operator already paid the carrier API to normalize THIS
--    address. Do I have a fresh-enough cached normalization to reuse
--    instead of paying the same carrier again?"
--
-- Two tables:
--
--   * `address_validations` — one cached normalization per unique
--     input. `input_signature` is a SHA3-512 hex digest produced by
--     the primitive (namespaceHash under the `address-validation-input`
--     namespace over the canonical-JSON form of the raw input) so the
--     same address — regardless of map order or whitespace
--     fluctuation — produces a single cache row. UNIQUE on the
--     signature so `recordValidation` of an existing signature
--     overwrites in place (operators tuning the cache lifetime get
--     deterministic upsert semantics).
--
--     Columns:
--       - `input_signature`         — UNIQUE; 128 hex chars (SHA3-512).
--       - `normalized_address_json` — operator-opaque JSON blob
--                                     carrying the carrier's normalized
--                                     output (line1 / line2 / city /
--                                     region / postal / country / etc.).
--                                     The primitive doesn't parse the
--                                     blob; downstream renderers do.
--       - `deliverable`             — 0/1; the carrier's verdict on
--                                     whether mail will physically
--                                     reach the address.
--       - `classification`          — closed enum: residential /
--                                     commercial / po_box / military /
--                                     unknown. The carrier may flag
--                                     PO Boxes or APO/FPO/DPO addresses
--                                     for separate routing.
--       - `dpv_match`               — USPS Delivery Point Validation
--                                     code, nullable for non-USPS
--                                     sources. Stored as a short text
--                                     (carrier-specific shape).
--       - `source`                  — closed enum (the carrier the
--                                     normalization came from).
--       - `order_id`                — optional; the order the
--                                     validation was performed for.
--                                     Operators looking up "every
--                                     validation receipt for order X"
--                                     scan this column. Nullable for
--                                     guest checkout / address-book
--                                     edits performed outside of an
--                                     order context.
--       - `expires_at`              — ms-epoch; `lookupCached` skips
--                                     rows whose expiry has elapsed,
--                                     and `cleanupExpired` sweeps them.
--                                     Operator-chosen lifetime —
--                                     USPS-style normalizations are
--                                     stable for weeks; address-suggest
--                                     entries for hot prefixes might
--                                     turn over daily.
--       - `occurred_at`             — ms-epoch of the record write.
--                                     Drives `metricsForSource`'s
--                                     window filter.
--
--   * `address_suggestions_cache` — autocomplete-proxy results keyed
--     by `partial_input` (raw operator-supplied prefix string, UNIQUE).
--     `suggestions_json` is an opaque array the autocomplete UI replays
--     verbatim. Same `expires_at` / `cleanupExpired` lifecycle.
--
-- Indexes:
--   * `idx_address_validations_expires_at` — `cleanupExpired` scans
--     the expires_at axis to identify and delete stale rows.
--   * `idx_address_validations_source_occurred` — `metricsForSource`
--     groups by source within a [from, to] window; the composite
--     keeps the aggregation a single ordered scan.
--   * `idx_address_validations_order` — `validationsForOrder` filters
--     by the (nullable) order_id column.
--   * `idx_address_suggestions_expires_at` — same as above for the
--     suggestions table.

CREATE TABLE IF NOT EXISTS address_validations (
  id                      TEXT NOT NULL PRIMARY KEY,
  input_signature         TEXT NOT NULL UNIQUE,
  normalized_address_json TEXT NOT NULL,
  deliverable             INTEGER NOT NULL CHECK (deliverable IN (0, 1)),
  classification          TEXT NOT NULL CHECK (classification IN (
                            'residential',
                            'commercial',
                            'po_box',
                            'military',
                            'unknown'
                          )),
  dpv_match               TEXT,
  source                  TEXT NOT NULL CHECK (source IN (
                            'usps',
                            'smarty',
                            'lob',
                            'google',
                            'melissa',
                            'manual'
                          )),
  order_id                TEXT,
  expires_at              INTEGER NOT NULL,
  occurred_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_address_validations_expires_at
  ON address_validations(expires_at);

CREATE INDEX IF NOT EXISTS idx_address_validations_source_occurred
  ON address_validations(source, occurred_at);

CREATE INDEX IF NOT EXISTS idx_address_validations_order
  ON address_validations(order_id);

CREATE TABLE IF NOT EXISTS address_suggestions_cache (
  id               TEXT NOT NULL PRIMARY KEY,
  partial_input    TEXT NOT NULL UNIQUE,
  suggestions_json TEXT NOT NULL,
  expires_at       INTEGER NOT NULL,
  occurred_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_address_suggestions_expires_at
  ON address_suggestions_cache(expires_at);
