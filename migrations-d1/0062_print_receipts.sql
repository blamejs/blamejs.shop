-- Receipt-print audit log. Each call to printReceipts.recordPrint
-- appends one row recording who printed what, in which format, to
-- which physical printer. The render surfaces (thermal / htmlPdf /
-- plainText) are pure functions over the order primitive; this
-- table is the side-effect channel — operators reconciling a
-- warehouse paper trail (lost label, duplicate print, wrong
-- shipping label format) read from this log.
--
-- `format` enumerates the three render surfaces:
--   thermal    — 80mm ESC/POS column-formatted text
--   html_pdf   — A4 HTML emitted by htmlPdf() (operator pipes through
--                a headless-Chrome PDF converter outside this primitive)
--   plain_text — plain-text email receipt body
--
-- `printer_name` is the operator-supplied physical-printer
-- identifier (a name like "warehouse-thermal-1" or a queue path
-- like "lpr://192.168.20.7"). Nullable because htmlPdf renders
-- often spool to a per-operator browser print dialog rather than a
-- named queue; the dialog has no stable identifier the primitive
-- can record.
--
-- `byte_size` + `sha3_512` are the integrity record for the bytes
-- handed to the printer. The operator reconciling a "did we
-- actually print the right thing?" dispute hashes the captured
-- payload (CUPS spool, browser-print blob) and compares against
-- this row.
--
-- Indexes:
--   (order_id, occurred_at desc)  — the per-order audit view used
--                                   by printsForOrder() reads
--                                   newest-first.
--   (format, occurred_at desc)    — operator dashboard "what got
--                                   printed in the last hour" feed.

CREATE TABLE IF NOT EXISTS receipt_prints (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('thermal', 'html_pdf', 'plain_text')),
  printer_name  TEXT,
  locale        TEXT NOT NULL DEFAULT 'en',
  occurred_at   INTEGER NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  sha3_512      TEXT NOT NULL CHECK (length(sha3_512) = 128),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_receipt_prints_order  ON receipt_prints(order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipt_prints_format ON receipt_prints(format, occurred_at DESC);
