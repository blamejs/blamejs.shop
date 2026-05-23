-- Pre-order: SKUs not yet released that customers can reserve in
-- advance. Distinct from backorder, which is the "exists, just
-- temporarily out of stock" case (`backorder_skus` keys off `sku`
-- and pivots on the catalog inventory row). A pre-order has no
-- catalog inventory yet — the operator schedules a launch date and
-- caps the reservation pool independently of any shelf count.
--
-- Two tables:
--
--   * `preorder_campaigns` — one row per scheduled launch. `slug` is
--     the operator-chosen identifier (also the URL slug on the
--     marketing page). `launch_at` is the wall-clock moment the
--     campaign converts; `charge_at` is the moment the customer's
--     card is captured (often equal to `launch_at` to defer billing
--     to launch day; can be earlier so the operator collects up
--     front). `max_units_available` is the capacity cap (NULL =
--     unlimited; positive integer caps `units_reserved` so the
--     operator can't oversell against a known fab batch).
--     `deposit_minor` lets the operator collect a partial payment
--     at reservation time without committing to the full price
--     until `convertReservationToOrder` lands. `full_price_minor`
--     is the locked-in price quoted on the marketing page; the
--     order line uses this even if the catalog price has drifted
--     since reservation.
--     CHECK enum on `status` (`active`/`launched`/`closed`).
--     `launched_at` / `closed_at` / `close_reason` are non-NULL
--     once the campaign hits the matching terminal state.
--
--   * `preorder_reservations` — one row per customer reservation.
--     CHECK enum on `status` (`active`/`converted`/`cancelled`).
--     `payment_intent_id` is the operator's PSP intent reference
--     (nullable when the campaign collects nothing at reserve
--     time). `converted_order_id` is set when the launch flow
--     turns the reservation into a regular order; `cancel_reason`
--     captures the prose for the cancelled state.
--     `quantity` constrained `> 0`. The FK to `preorder_campaigns`
--     is on `campaign_slug`; ON DELETE CASCADE so deleting a
--     campaign also drops its reservations (operator scrubs a
--     bad launch).
--
-- Indexes:
--
--   * `idx_preorder_campaigns_status_launch` — the launchCampaign
--     scheduler walks `status='active' AND launch_at <= ?`; the
--     index covers the filter and orders by launch_at without a
--     scan.
--   * `idx_preorder_reservations_customer_status` — the customer
--     portal reads scoped to one customer filtered by status; the
--     index covers both filters, the ORDER BY uses the v7-uuid PK
--     for newest-first.
--   * `idx_preorder_reservations_campaign_status` — the launch
--     flow walks every active reservation for one campaign and
--     converts them; the index covers the filter and the FK
--     enforcement.

CREATE TABLE IF NOT EXISTS preorder_campaigns (
  slug                  TEXT NOT NULL PRIMARY KEY,
  sku                   TEXT NOT NULL,
  variant_id            TEXT,
  launch_at             INTEGER NOT NULL,
  charge_at             INTEGER,
  max_units_available   INTEGER          CHECK (max_units_available IS NULL OR max_units_available >= 0),
  units_reserved        INTEGER NOT NULL DEFAULT 0 CHECK (units_reserved >= 0),
  deposit_minor         INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
  full_price_minor      INTEGER NOT NULL          CHECK (full_price_minor >= 0),
  currency              TEXT    NOT NULL,
  marketing_copy        TEXT    NOT NULL DEFAULT '',
  status                TEXT    NOT NULL CHECK (status IN ('active', 'launched', 'closed')),
  launched_at           INTEGER,
  closed_at             INTEGER,
  close_reason          TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preorder_reservations (
  id                    TEXT NOT NULL PRIMARY KEY,
  campaign_slug         TEXT NOT NULL,
  customer_id           TEXT NOT NULL,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  payment_intent_id     TEXT,
  status                TEXT NOT NULL CHECK (status IN ('active', 'converted', 'cancelled')),
  reservation_at        INTEGER NOT NULL,
  converted_at          INTEGER,
  converted_order_id    TEXT,
  cancelled_at          INTEGER,
  cancel_reason         TEXT,
  FOREIGN KEY (campaign_slug) REFERENCES preorder_campaigns(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_preorder_campaigns_status_launch    ON preorder_campaigns(status, launch_at);
CREATE INDEX IF NOT EXISTS idx_preorder_reservations_customer_status ON preorder_reservations(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_preorder_reservations_campaign_status ON preorder_reservations(campaign_slug, status);
