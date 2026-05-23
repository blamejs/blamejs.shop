-- Per-line gift wrap selection — one wrap option per order line, not
-- per order.
--
-- The sibling `giftOptions` primitive (migration 0046) carries a
-- single wrap_sku at the order level. That shape collapses when one
-- customer ships goods to multiple recipients in a single order:
-- "wrap the necklace in floral paper for my sister and the watch in
-- kraft paper for my dad" can't be expressed when there's only one
-- wrap slot. This table lets each `(order_id, line_id)` carry its
-- own wrap_sku + gift_message + recipient_name; the per-order
-- giftOptions still drives the order-level concerns (hide_prices on
-- the slip) so the two primitives compose without overlap.
--
-- `line_gift_wraps`:
--
--   * `id` — UUIDv7 row id; the v7 prefix sorts chronologically so a
--     write-ordered scan returns rows in the operator's mutation
--     order without a separate sequence column.
--   * `order_id` + `line_id` — both UUIDs validated at the boundary
--     by `b.guardUuid`. `UNIQUE(order_id, line_id)` means there's
--     exactly one wrap per line; `setLineWrap` is an UPSERT against
--     this constraint so a customer who changes their mind doesn't
--     accumulate stale rows.
--   * `wrap_sku` — a catalog SKU. The shape gate matches the
--     catalog primitive's SKU rule (alnum + . _ -, ≤ 128 chars). The
--     fee is read at packing-slip render time from the per-order
--     `gift_wraps` table via `giftOptions.getWrap(wrap_sku)` so this
--     primitive doesn't duplicate the wrap catalog or its fee.
--   * `gift_message` — optional, ≤ 500 chars, control-byte +
--     zero-width-char free at the lib boundary (the SQL CHECK keeps
--     the length bound enforced even if a caller bypasses the lib).
--   * `recipient_name` — optional, ≤ 120 chars, same hygiene. Used
--     so the picker knows "this one goes to Alice, that one to Bob"
--     when one order ships to multiple addresses (the
--     split-shipments primitive carries the address; this primitive
--     carries the name on the gift tag).
--   * `set_at` / `updated_at` — epoch ms timestamps for analytics
--     (`analytics({ from, to })` reads `set_at`) and for the
--     operator dashboard's "most recent change" column.
--
-- Indexes:
--
--   * `idx_line_gift_wraps_order` — `wrapsForOrder({ order_id })`
--     reads every line for an order; the index keeps that read O(N)
--     in the order's line count, not O(M) in the table size.
--   * `idx_line_gift_wraps_wrap_sku_set_at` — `analytics` groups by
--     `wrap_sku` over a `set_at` window; the composite index covers
--     the GROUP BY + range scan.

CREATE TABLE IF NOT EXISTS line_gift_wraps (
  id               TEXT NOT NULL PRIMARY KEY,
  order_id         TEXT NOT NULL,
  line_id          TEXT NOT NULL,
  wrap_sku         TEXT NOT NULL,
  gift_message     TEXT CHECK (gift_message IS NULL OR length(gift_message) <= 500),
  recipient_name   TEXT CHECK (recipient_name IS NULL OR length(recipient_name) <= 120),
  set_at           INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_line_gift_wraps_order
  ON line_gift_wraps(order_id);

CREATE INDEX IF NOT EXISTS idx_line_gift_wraps_wrap_sku_set_at
  ON line_gift_wraps(wrap_sku, set_at);
