-- Promo bundles — time-limited, multi-component, single-price
-- promotional offers detected against an in-progress cart and applied
-- at checkout. Distinct from the kit-product `bundles` table (which
-- describes virtual composite SKUs added as a single line); a promo
-- bundle is recognized when its component set is already present in
-- the cart at the required quantities, and swaps individual line
-- pricing for the operator-chosen `bundle_price_minor`.
--
-- Lifecycle:
--
--   defineBundle()       INSERT row with starts_at < expires_at,
--                        components_json canonicalized by the
--                        primitive (sorted by sku for diff stability),
--                        redemptions_used = 0, archived_at = NULL.
--   updateBundle()       Window + caps + title are mutable; the
--                        component list, bundle_price_minor, and
--                        currency are NOT — operators redefine under
--                        a fresh slug for a structural change so a
--                        detect-but-not-converted cart never sees the
--                        rug pulled mid-conversion.
--   recordRedemption()   Guarded UPDATE increments redemptions_used
--                        only when the slot is still available; the
--                        UNIQUE(slug, order_id) constraint on the
--                        ledger gives idempotency for replayed calls.
--   archiveBundle()      Soft retire via archived_at — historical
--                        redemption rows stay intact for reporting.
--
-- `components_json` is the canonical JSON array
--   [{ "sku": "...", "quantity": N }, ...]
-- sorted ascending by sku. Stored as TEXT in SQLite; D1's JSON1
-- extension is available if the operator wants to index on individual
-- component skus later (a follow-on migration can add a generated
-- column without disturbing existing rows).
--
-- `currency` is the 3-letter ISO 4217 code; the resolver refuses
-- matches against carts whose currency differs (mixed-currency carts
-- are out of scope — the cart primitive single-currency-per-cart is
-- the project default).
--
-- Indexes drive three hot reads:
--
--   * (archived_at, starts_at, expires_at)  — activeBundles({ now })
--     filters out archived bundles and selects the [starts, expires)
--     window in one index lookup.
--   * (archived_at, expires_at)             — operator dashboard
--     scans for "expired but not archived" rollups.
--   * (slug, occurred_at)                   — metricsForBundle()
--     aggregation walks redemption rows for one bundle in order.

CREATE TABLE IF NOT EXISTS promo_bundles (
  slug                    TEXT    NOT NULL PRIMARY KEY,
  title                   TEXT    NOT NULL,
  components_json         TEXT    NOT NULL,
  bundle_price_minor      INTEGER NOT NULL CHECK (bundle_price_minor >= 0),
  currency                TEXT    NOT NULL CHECK (length(currency) = 3),
  starts_at               INTEGER NOT NULL,
  expires_at              INTEGER NOT NULL,
  max_redemptions_total   INTEGER,
  max_per_customer        INTEGER,
  redemptions_used        INTEGER NOT NULL DEFAULT 0 CHECK (redemptions_used >= 0),
  archived_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  CHECK (starts_at < expires_at)
);

CREATE INDEX IF NOT EXISTS idx_promo_bundles_window   ON promo_bundles(archived_at, starts_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_promo_bundles_expiry   ON promo_bundles(archived_at, expires_at);

CREATE TABLE IF NOT EXISTS promo_bundle_redemptions (
  id             TEXT    NOT NULL PRIMARY KEY,
  slug           TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,
  customer_id    TEXT,
  savings_minor  INTEGER NOT NULL CHECK (savings_minor >= 0),
  occurred_at    INTEGER NOT NULL,
  UNIQUE (slug, order_id),
  FOREIGN KEY (slug) REFERENCES promo_bundles(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_promo_bundle_redemptions_slug     ON promo_bundle_redemptions(slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_promo_bundle_redemptions_customer ON promo_bundle_redemptions(customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_promo_bundle_redemptions_order    ON promo_bundle_redemptions(order_id);
