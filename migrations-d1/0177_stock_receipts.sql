-- Stock receipts — customer-facing scanned proof-of-receipt for items
-- received in a delivered package. The picker prints a packing slip
-- with a QR code at fulfilment; the QR resolves to a single-use
-- plaintext token. The customer scans it on arrival; the storefront
-- walks them through a checklist of the order's line items so they
-- can confirm each SKU was received and flag any that arrived
-- damaged. Each scan is recorded for the audit trail; the per-line
-- states roll up into a `completeReceipt` summary that composes the
-- optional `loyaltyEarnRules` handle to award goods-received points.
--
-- Three tables:
--
--   stock_receipt_tokens — one row per (order_id) issuance. `order_id`
--                          is UNIQUE so a given order has exactly one
--                          live receipt token; re-issuance replaces
--                          the prior row (the audit trail of prior
--                          tokens lives on stock_receipt_scans). The
--                          `token_hash` is the SHA3-512 namespace-hash
--                          of the 32-byte base64url plaintext (43 char,
--                          shown EXACTLY ONCE at issuance, never
--                          persisted). `status` is the FSM:
--                            issued    -> scanned   (first scan)
--                            scanned   -> completed (completeReceipt)
--                            issued    -> expired   (expires_at < now)
--                          `expires_at` defaults to issued_at + 30
--                          days — the QR on a paper packing slip
--                          shouldn't be a forever-valid handle.
--
--   stock_receipt_scans — append-only event log of every scan that
--                          touched a receipt. The first row flips the
--                          parent receipt to `scanned`; subsequent rows
--                          are observational (the customer re-opens
--                          the page, or scans again from a different
--                          device). `user_agent_hash` is the namespace-
--                          hashed UA string so audit reads can
--                          distinguish distinct devices without
--                          storing the raw UA string at rest.
--
--   stock_receipt_line_states — per-(receipt_id, sku) line state. One
--                          row per shipped line. Initial state is
--                          `pending` (no customer action yet); the
--                          customer flips each line to `received` or
--                          `damaged` from the checklist UI. The
--                          `quantity_received` / `quantity_damaged`
--                          columns capture partial quantities so a
--                          line of 3 with 2 received + 1 damaged
--                          records both totals.
--
-- Indexes drive the four hot read paths:
--   * (token_hash) UNIQUE        — recordReceiptScan lookup
--   * (order_id, status)         — receiptsForOrder
--   * (receipt_id)               — line states + scans by receipt
--   * (scanned_at)               — recentScans operator dashboard

CREATE TABLE IF NOT EXISTS stock_receipt_tokens (
  id                  TEXT    NOT NULL PRIMARY KEY,
  order_id            TEXT    NOT NULL UNIQUE,
  token_hash          TEXT    NOT NULL UNIQUE,
  status              TEXT    NOT NULL CHECK (status IN (
                        'issued', 'scanned', 'completed', 'expired'
                      )),
  expires_at          INTEGER NOT NULL,
  issued_at           INTEGER NOT NULL,
  first_scanned_at    INTEGER,
  completed_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK ((status = 'issued'    AND first_scanned_at IS NULL     AND completed_at IS NULL)
      OR (status = 'scanned'   AND first_scanned_at IS NOT NULL AND completed_at IS NULL)
      OR (status = 'completed' AND first_scanned_at IS NOT NULL AND completed_at IS NOT NULL)
      OR (status = 'expired'   AND completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_stock_receipt_tokens_status   ON stock_receipt_tokens(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_tokens_order    ON stock_receipt_tokens(order_id, status);

CREATE TABLE IF NOT EXISTS stock_receipt_scans (
  id                  TEXT    NOT NULL PRIMARY KEY,
  receipt_id          TEXT    NOT NULL,
  scanned_at          INTEGER NOT NULL,
  user_agent_hash     TEXT,
  client_ip_hash      TEXT,
  FOREIGN KEY (receipt_id) REFERENCES stock_receipt_tokens(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stock_receipt_scans_receipt  ON stock_receipt_scans(receipt_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_scans_recent   ON stock_receipt_scans(scanned_at);

CREATE TABLE IF NOT EXISTS stock_receipt_line_states (
  receipt_id          TEXT    NOT NULL,
  sku                 TEXT    NOT NULL,
  quantity_expected   INTEGER NOT NULL CHECK (quantity_expected > 0),
  quantity_received   INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  quantity_damaged    INTEGER NOT NULL DEFAULT 0 CHECK (quantity_damaged >= 0),
  state               TEXT    NOT NULL CHECK (state IN ('pending', 'received', 'damaged', 'partial')),
  damage_reason       TEXT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (receipt_id, sku),
  FOREIGN KEY (receipt_id) REFERENCES stock_receipt_tokens(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stock_receipt_line_states_receipt ON stock_receipt_line_states(receipt_id, state);
