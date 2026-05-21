-- Orders: immutable post-checkout record with FSM-driven state.
--
-- An order is created in `pending` state when the checkout
-- primitive confirms a payment intent. State changes go through
-- the order FSM (composed on `b.fsm`) — every transition writes a
-- row to `order_transitions` so the lifecycle is audit-trail
-- ready without a separate event log.
--
-- States:  pending | paid | fulfilling | shipped | delivered | refunded | cancelled
-- Events:  mark_paid | start_fulfillment | mark_shipped | mark_delivered |
--          cancel | refund

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT NOT NULL PRIMARY KEY,
  cart_id            TEXT NOT NULL,
  customer_id        TEXT,
  session_id         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'fulfilling', 'shipped', 'delivered', 'refunded', 'cancelled')),
  currency           TEXT NOT NULL CHECK (length(currency) = 3),
  subtotal_minor     INTEGER NOT NULL CHECK (subtotal_minor     >= 0),
  discount_minor     INTEGER NOT NULL CHECK (discount_minor     >= 0),
  tax_minor          INTEGER NOT NULL CHECK (tax_minor          >= 0),
  shipping_minor     INTEGER NOT NULL CHECK (shipping_minor     >= 0),
  grand_total_minor  INTEGER NOT NULL CHECK (grand_total_minor  >= 0),
  payment_intent_id  TEXT,
  ship_to_json       TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (cart_id) REFERENCES carts(id)
);

CREATE INDEX        IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX        IF NOT EXISTS idx_orders_customer    ON orders(customer_id);
CREATE INDEX        IF NOT EXISTS idx_orders_session     ON orders(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pi          ON orders(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_orders_updated_at  ON orders(updated_at);

CREATE TABLE IF NOT EXISTS order_lines (
  id                TEXT NOT NULL PRIMARY KEY,
  order_id          TEXT NOT NULL,
  variant_id        TEXT NOT NULL,
  sku               TEXT NOT NULL,
  qty               INTEGER NOT NULL CHECK (qty > 0),
  unit_amount_minor INTEGER NOT NULL CHECK (unit_amount_minor >= 0),
  unit_currency     TEXT NOT NULL CHECK (length(unit_currency) = 3),
  line_total_minor  INTEGER NOT NULL CHECK (line_total_minor  >= 0),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

CREATE TABLE IF NOT EXISTS order_transitions (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  from_state    TEXT NOT NULL,
  to_state      TEXT NOT NULL,
  on_event      TEXT NOT NULL,
  reason        TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at   INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_transitions_order ON order_transitions(order_id, occurred_at);
