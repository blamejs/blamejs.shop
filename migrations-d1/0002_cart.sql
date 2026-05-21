-- Cart: anonymous + authenticated carts with line items.
--
-- Carts are keyed by a session_id stored in a sealed cookie set by
-- the container. Anonymous shoppers get a cart with `customer_id =
-- NULL`; on customer login the cart `customer_id` is populated (or
-- the anonymous cart merges into the customer's existing active
-- cart via cart.merge).
--
-- Status:
--   active     — the shopper's working cart
--   abandoned  — TTL'd out (cron later)
--   converted  — checkout completed; row stays for audit
--
-- Prices snapshot at add-to-cart time: `unit_amount_minor` +
-- `unit_currency` are captured from `prices.current()` so a later
-- price change doesn't silently re-price the shopper's cart.

CREATE TABLE IF NOT EXISTS carts (
  id          TEXT NOT NULL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  customer_id TEXT,
  currency    TEXT NOT NULL CHECK (length(currency) = 3),
  status      TEXT NOT NULL CHECK (status IN ('active', 'abandoned', 'converted')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE        INDEX IF NOT EXISTS idx_carts_session       ON carts(session_id);
CREATE        INDEX IF NOT EXISTS idx_carts_customer      ON carts(customer_id);
CREATE        INDEX IF NOT EXISTS idx_carts_expires       ON carts(expires_at);
-- Only one active cart per session at a time. Conversion or
-- abandonment frees the session_id to start a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_active_session
  ON carts(session_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cart_lines (
  id                TEXT NOT NULL PRIMARY KEY,
  cart_id           TEXT NOT NULL,
  variant_id        TEXT NOT NULL,
  sku               TEXT NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty > 0),
  unit_amount_minor INTEGER NOT NULL CHECK (unit_amount_minor >= 0),
  unit_currency     TEXT NOT NULL CHECK (length(unit_currency) = 3),
  added_at          INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (cart_id)    REFERENCES carts(id)    ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE CASCADE,
  -- One line per variant per cart — re-adding an existing variant
  -- bumps qty rather than creating a second row.
  UNIQUE (cart_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_lines_cart ON cart_lines(cart_id);
