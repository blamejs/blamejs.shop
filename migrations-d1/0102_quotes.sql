-- Quotes — B2B request-for-quote (RFQ) negotiation surface.
--
-- A quote is a multi-step negotiation between a customer and the
-- operator. The customer submits an RFQ with N requested lines
-- (SKU + quantity + optional per-line notes), the operator
-- responds with line prices + shipping + tax + an expiry, and the
-- customer either accepts (quote converts to an order at the
-- quoted prices) or rejects / lets it expire.
--
-- This is distinct from `cartBulkOps.quoteForCart`: that is a
-- snapshot of the current cart with current prices — no
-- negotiation, no per-line operator response, no acceptance
-- contract. The `quotes` table backs the full negotiation
-- lifecycle and is the artifact the operator and the customer
-- both reference when honouring an agreed price.
--
-- States:
--   requested  — customer submitted the RFQ; awaiting operator
--   responded  — operator priced the lines + set valid_until
--   accepted   — customer accepted the quoted terms
--   rejected   — customer rejected (terminal)
--   expired    — valid_until passed without acceptance (terminal)
--   cancelled  — operator or customer cancelled (terminal)
--   converted  — accepted quote was used to create an order
--                (terminal; converted_order_id populated)
--
-- `valid_until` is the operator-set expiry timestamp (ms). After
-- it elapses, `listExpired({ as_of })` surfaces the row so a
-- cron / dunning job can transition it to `expired`.
--
-- `total_minor` is the operator-quoted grand total — the sum of
-- the quote_lines line-totals plus `shipping_minor` + `tax_minor`.
-- It is NULL until the operator has responded.

CREATE TABLE IF NOT EXISTS quotes (
  id                   TEXT NOT NULL PRIMARY KEY,
  customer_id          TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'requested', 'responded', 'accepted',
                         'rejected', 'expired', 'cancelled', 'converted'
                       )),
  delivery_terms       TEXT,
  payment_terms        TEXT,
  message              TEXT,
  operator_notes       TEXT,
  shipping_minor       INTEGER CHECK (shipping_minor IS NULL OR shipping_minor >= 0),
  tax_minor            INTEGER CHECK (tax_minor      IS NULL OR tax_minor      >= 0),
  total_minor          INTEGER CHECK (total_minor    IS NULL OR total_minor    >= 0),
  currency             TEXT    CHECK (currency       IS NULL OR length(currency) = 3),
  valid_until          INTEGER,
  accepted_at          INTEGER,
  accepted_by_customer TEXT,
  rejected_at          INTEGER,
  reject_reason        TEXT,
  converted_at         INTEGER,
  converted_order_id   TEXT,
  cancelled_at         INTEGER,
  cancel_reason        TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quotes_customer    ON quotes(customer_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_status      ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_valid_until ON quotes(valid_until)
  WHERE valid_until IS NOT NULL AND status = 'responded';
CREATE INDEX IF NOT EXISTS idx_quotes_updated_at  ON quotes(updated_at);

CREATE TABLE IF NOT EXISTS quote_lines (
  id                TEXT NOT NULL PRIMARY KEY,
  quote_id          TEXT NOT NULL,
  sku               TEXT NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  notes             TEXT,
  unit_price_minor  INTEGER CHECK (unit_price_minor IS NULL OR unit_price_minor >= 0),
  currency          TEXT    CHECK (currency         IS NULL OR length(currency)  = 3),
  FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_lines_sku   ON quote_lines(sku);
