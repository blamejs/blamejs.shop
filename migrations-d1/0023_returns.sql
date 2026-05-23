-- Return merchandise authorizations: post-purchase RMA workflow.
--
-- A return_authorizations row tracks one customer-initiated return
-- against an `orders` row. The lifecycle is a small FSM walked at the
-- application tier (lib/returns.js):
--
--     pending  → approved  → received  → refunded
--                                      ↘ rejected (terminal)
--     pending  → rejected (terminal)
--
-- `rma_code` is an operator-readable short identifier shown to the
-- customer (e.g. on the return-label email). Format:
-- `RMA-YYMMDD-AAAAA` where AAAAA is 5 characters from the
-- ambiguity-free alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no
-- 0/O/I/1 — same alphabet as gift-card codes, for the same reason).
-- The code is a UNIQUE column so collisions are surfaced as INSERT
-- failures the application layer retries.
--
-- Companion table `return_lines` is the per-SKU breakdown of what's
-- coming back. A return may cover a subset of an order's lines or
-- different quantities than the original line; we don't constrain
-- `qty <= order_lines.qty` at the DB tier so partial overlapping
-- RMAs (defective unit returned, then a separate damaged-in-transit
-- claim against the same SKU) compose naturally.

CREATE TABLE IF NOT EXISTS return_authorizations (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  customer_id     TEXT,
  rma_code        TEXT NOT NULL UNIQUE,
  reason          TEXT NOT NULL CHECK (reason IN ('defective','wrong-item','not-as-described','no-longer-needed','damaged-in-transit','other')),
  reason_detail   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('pending','approved','received','refunded','rejected')),
  refund_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount_minor >= 0),
  refund_currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(refund_currency) = 3),
  approved_at     INTEGER,
  received_at     INTEGER,
  refunded_at     INTEGER,
  rejected_at     INTEGER,
  rejected_reason TEXT,
  customer_notes  TEXT NOT NULL DEFAULT '',
  operator_notes  TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS return_lines (
  id          TEXT NOT NULL PRIMARY KEY,
  rma_id      TEXT NOT NULL,
  order_line_id TEXT,
  sku         TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  reason      TEXT,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  amount_currency TEXT NOT NULL DEFAULT 'USD',
  FOREIGN KEY (rma_id) REFERENCES return_authorizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rma_order ON return_authorizations(order_id);
CREATE INDEX IF NOT EXISTS idx_rma_status ON return_authorizations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_rma_customer ON return_authorizations(customer_id);
CREATE INDEX IF NOT EXISTS idx_return_lines_rma ON return_lines(rma_id);
