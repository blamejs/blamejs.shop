-- Invoice renderer audit log + sequential invoice-number minter.
--
-- Distinct from the receipt_prints table (post-sale spool record):
-- invoices are the formal accounting artifact with sequential
-- per-series numbering, tax breakdown, payment terms, and a due
-- date. The renderer returns HTML the operator's worker feeds to a
-- headless-Chrome PDF converter; the bytes themselves are not
-- stored — only the integrity record (size + SHA3-512) so an
-- operator reconciling a disputed invoice can hash the captured
-- PDF and compare against this row.
--
-- `invoice_sequence` is the per-series next-value counter. Each
-- series is operator-defined free-form text (e.g. "DEFAULT", "EU",
-- "US-WHOLESALE") with one row holding the next integer to issue.
-- Sequential numbering is a hard accounting requirement in most
-- jurisdictions (EU VAT, UK MTD, IRS-equivalent record-keeping)
-- and gaps in the sequence are themselves audit-relevant — so the
-- minter advances the counter via a CAS-shape conditional UPDATE
-- and retries on contention rather than risking a duplicate number.
--
-- `invoice_renderings` records every issued invoice exactly once
-- (invoice_number UNIQUE). The id is a UUIDv7 for stable timeline
-- sort; the invoice_number is the operator-facing accounting id
-- shaped `INV-YYYY-NNNNNN` (zero-padded sequence).
--
-- Indexes:
--   (order_id, generated_at desc)  — `invoicesForOrder` reads the
--                                    per-order audit view newest-first.
--   (series, generated_at desc)    — operator dashboard "what got
--                                    issued in series X today" feed.

CREATE TABLE IF NOT EXISTS invoice_sequence (
  series       TEXT NOT NULL PRIMARY KEY CHECK (length(series) >= 1 AND length(series) <= 64),
  next_value   INTEGER NOT NULL CHECK (next_value >= 1),
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_renderings (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  series          TEXT NOT NULL CHECK (length(series) >= 1 AND length(series) <= 64),
  invoice_number  TEXT NOT NULL UNIQUE CHECK (length(invoice_number) >= 1 AND length(invoice_number) <= 128),
  html_size       INTEGER NOT NULL CHECK (html_size >= 0),
  sha3_512        TEXT NOT NULL CHECK (length(sha3_512) = 128),
  generated_at    INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invoice_renderings_order
  ON invoice_renderings(order_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_renderings_series
  ON invoice_renderings(series, generated_at DESC);
