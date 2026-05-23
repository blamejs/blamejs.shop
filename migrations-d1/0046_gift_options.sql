-- Gift options — per-order, set at checkout. Three independent
-- concerns folded into one primitive because they all live on the
-- same packing slip and clear together when the order is cancelled:
--
--   gift wrap      — operator pre-defines a catalog SKU as a wrap
--                    option with a wrap fee. The wrap_sku is a real
--                    variant SKU so inventory + cost flow through
--                    the normal catalog channels — the wrap shows
--                    up on the invoice, decrements inventory, and
--                    can be tied to a real cost-of-goods row. The
--                    storefront shows the operator's title + image
--                    when offering the option at checkout.
--
--   gift message   — short customer-authored prose (≤ 500 chars,
--                    control-byte + zero-width-char free at the
--                    app layer) rendered on the packing slip. The
--                    primitive HTML-escapes on render so the slip
--                    renderer can drop the message inline.
--
--   recipient name — for gift-to-someone-else orders the packing
--                    slip leads with the recipient's name instead
--                    of the buyer's. ≤ 120 chars, same control-byte
--                    discipline as gift_message.
--
--   hide_prices    — toggle that suppresses the price column on
--                    the packing slip (the "gift receipt" pattern —
--                    recipient sees what arrived, not what it cost).
--
-- Schema decisions:
--   * `gift_wraps.wrap_sku` is the PK *and* a FK to variants(sku) so
--     the wrap option always points at a real catalog row. Deleting
--     a variant cascades the wrap row (intentional — the wrap can't
--     exist without its catalog SKU).
--   * `archived_at` is the soft-delete column. Wraps that have been
--     used on an order can't be hard-deleted (their gift_options
--     rows still reference them); archiving removes them from the
--     active-list view but the FK from gift_options.wrap_sku still
--     resolves for older orders' packing slips.
--   * `gift_options.order_id` is the PK. One gift-option row per
--     order; `setForOrder` UPSERTs. `wrap_sku` / `gift_message` /
--     `recipient_name` are independently nullable — an order can
--     have a wrap but no message, or a message but no wrap.
--   * `hide_prices` is NOT NULL with a default of 0 so the column
--     is always meaningful (the absence of a gift_options row means
--     "no gift options", which renders prices by default).
--
-- Indexes:
--   * `(active, archived_at)` — `listWraps({ active_only: true })`
--     scans WHERE active = 1 AND archived_at IS NULL.
--   * `(set_at)` — `analytics({ from, to })` ranges by set_at.

CREATE TABLE IF NOT EXISTS gift_wraps (
  wrap_sku        TEXT NOT NULL PRIMARY KEY,
  title           TEXT NOT NULL,
  fee_minor       INTEGER NOT NULL CHECK (fee_minor >= 0),
  image_url       TEXT,
  max_per_order   INTEGER CHECK (max_per_order IS NULL OR max_per_order > 0),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (wrap_sku) REFERENCES variants(sku) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gift_wraps_active
  ON gift_wraps(active, archived_at);

CREATE TABLE IF NOT EXISTS gift_options (
  order_id        TEXT NOT NULL PRIMARY KEY,
  wrap_sku        TEXT,
  gift_message    TEXT,
  recipient_name  TEXT,
  hide_prices     INTEGER NOT NULL DEFAULT 0 CHECK (hide_prices IN (0, 1)),
  set_at          INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)       ON DELETE CASCADE,
  FOREIGN KEY (wrap_sku) REFERENCES gift_wraps(wrap_sku)
);

CREATE INDEX IF NOT EXISTS idx_gift_options_set_at
  ON gift_options(set_at);
