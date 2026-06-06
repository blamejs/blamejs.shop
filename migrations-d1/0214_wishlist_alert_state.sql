-- wishlist-alerts: per-item last-observed state, so an alert fires on a
-- state TRANSITION and never on a steady state.
--
-- Without this table the scanner evaluated the CURRENT state every
-- sweep: a back_in_stock policy re-alerted every wishlister of an
-- already-in-stock item, and a price_drop policy re-alerted while the
-- price simply held below its baseline. The 24h dedupe window only
-- throttled the flood to once per window; the underlying cause is that
-- the scanner had no memory of what it last saw, so it couldn't tell
-- "this item just came back in stock" from "this item is in stock".
--
-- One row per (customer_id, sku, policy_slug) records what the scanner
-- last observed for that tuple:
--
--   * last_in_stock — 1 / 0 / NULL. Updated on every back_in_stock
--     evaluation. A restock fires only on the 0 -> 1 edge; a first
--     observation (NULL -> 1) records the state without firing (there
--     is no observed out-of-stock to transition FROM), and a steady
--     1 -> 1 never re-fires.
--
--   * last_alerted_bps — the discount in basis points at which a
--     price_drop alert last fired for this tuple, or NULL when no
--     drop is currently in effect. A drop fires only when the current
--     discount meets the policy threshold AND is strictly deeper than
--     the last alerted level (NULL counts as "deeper than nothing").
--     A price recovering to or above its baseline resets this to NULL
--     so a fresh drop later re-fires.
--
-- UNIQUE (customer_id, sku, policy_slug) lets the upsert claim/refresh
-- the row in one statement and keeps the scanner's per-tuple read a
-- single-row hit.

CREATE TABLE IF NOT EXISTS wishlist_alert_state (
  customer_id      TEXT NOT NULL,
  sku              TEXT NOT NULL,
  policy_slug      TEXT NOT NULL,
  last_in_stock    INTEGER,
  last_alerted_bps INTEGER,
  updated_at       INTEGER NOT NULL,
  UNIQUE (customer_id, sku, policy_slug)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_alert_state_tuple
  ON wishlist_alert_state(customer_id, sku, policy_slug);
