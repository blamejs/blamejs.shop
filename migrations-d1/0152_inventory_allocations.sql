-- Inventory allocations: soft-reservation layer in front of committed
-- per-location stock.
--
-- The `inventory_stock` table is the committed shelf — once a unit
-- lands there it can't be allocated to two customers at once via
-- adjustStock alone. The gap that opens during checkout is the
-- in-progress cart: the operator hasn't taken payment yet, but the
-- shopper has selected qty N of SKU S and is filling in shipping.
-- Without a hold layer, a second shopper who hits "add to cart" a
-- moment later sees the same N units as available, and one of the
-- two carts has to be told at payment time that the item is gone —
-- the classic oversell.
--
-- `inventory_holds` is the holds layer. Each row reserves quantity
-- against (sku, location_code) for a specific cart_id with a TTL
-- (default a few minutes — the operator picks). Reads that need
-- "how many can I actually sell?" subtract the open-hold sum from
-- the committed shelf. Three terminal states:
--
--     held       — the live state (TTL not yet reached)
--     released   — the cart abandoned / a hold was released explicitly
--     committed  — the order finalized; the hold converted into a
--                  real stock movement via inventoryLocations.adjustStock
--     expired    — TTL elapsed without commit; cleanupExpiredHolds
--                  flips the row and frees the reservation
--
-- Schema decisions:
--   * `cart_id`, `sku`, `variant_id` mirror the cart-line vocabulary
--     so the join from cart -> holds is grep-able. `variant_id` is
--     NULLABLE because cart lines can target the bare SKU when no
--     variant axis applies.
--   * `location_code` is NULLABLE. Holds taken at the storefront
--     before a routing decision lands store NULL (any location can
--     satisfy them); holds taken during click-and-collect or split
--     shipment land with a concrete location_code so availableForSku
--     can show per-location pressure.
--   * `quantity` is positive INTEGER. Zero / negative quantities are
--     refused at the application layer (a hold of zero is meaningless).
--   * `status` is a four-state CHECK enum. The transitions are
--     enforced by the primitive (`held` -> `released | committed |
--     expired`) so a stale row never gets re-committed.
--   * `ttl_seconds` + `expires_at` are stored together so
--     cleanupExpiredHolds can window-scan on `expires_at` without
--     re-computing it on every row, and the operator can grep the
--     original TTL when debugging an aggressive timeout setting.
--   * `committed_order_id` is set on commit so the audit trail back
--     from an order to the holds it consumed is one indexed lookup.
--   * `release_reason` is set on released / expired transitions so
--     the metrics surface can attribute holds back to their cause
--     ("cart_abandoned", "ttl_expired", "operator_release").
--   * created_at / released_at / committed_at / expired_at are kept
--     separate (rather than one polymorphic `updated_at`) so the
--     metrics queries don't have to disambiguate which transition
--     wrote the timestamp.

CREATE TABLE IF NOT EXISTS inventory_holds (
  id                  TEXT NOT NULL PRIMARY KEY,
  cart_id             TEXT NOT NULL,
  sku                 TEXT NOT NULL,
  variant_id          TEXT,
  location_code       TEXT,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  status              TEXT NOT NULL CHECK (status IN ('held', 'released', 'committed', 'expired')),
  ttl_seconds         INTEGER NOT NULL CHECK (ttl_seconds > 0),
  expires_at          INTEGER NOT NULL,
  committed_order_id  TEXT,
  release_reason      TEXT,
  created_at          INTEGER NOT NULL,
  released_at         INTEGER,
  committed_at        INTEGER,
  expired_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_inventory_holds_status_expires ON inventory_holds(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_inventory_holds_cart_status    ON inventory_holds(cart_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_holds_sku_status_loc ON inventory_holds(sku, status, location_code);
