-- Packing slips: warehouse pick-verification paperwork that ships
-- INSIDE the box, distinct from `receipt_prints` (post-sale spool
-- record) and `invoice_renderings` (formal accounting artifact).
--
-- A packing slip is the picker's contract: it lists the box's
-- contents, qty per line, an optional gift message + recipient name
-- (for gift orders), and a Code-128 barcode of the order_id the
-- picker scans against the workstation to verify the right slip
-- joined the right box before the seal goes on. The slip never
-- carries payment / accounting numbers — operators wanting a gift
-- receipt for the recipient toggle `gift_options.hide_prices` so the
-- monetary columns drop out of the rendered slip too.
--
-- Two tables:
--
--   * `packing_slip_prints` — audit log. Each `recordPrint` call
--     appends one row recording who printed which slip for which
--     order at which physical printer. The render surfaces
--     (renderHtml / renderPdfPayload) are pure functions over the
--     order primitive + gift_options join; this table is the
--     side-effect channel an operator reads when reconciling a
--     warehouse paper trail (lost slip, duplicate print, wrong
--     packer). `printer_name` is nullable because a slip printed
--     from a browser print dialog has no stable queue identifier;
--     `byte_size` + `sha3_512` are the integrity record for the
--     bytes handed to the printer so the operator can hash a
--     captured spool and compare against this row.
--
--   * `packing_slip_queue` — orders waiting to print at a named
--     fulfillment location. The operator's pick-list-complete
--     handler enqueues `(order_id, location_code)` rows; the
--     warehouse workstation's batched-print job calls
--     `bulkRenderForLocation({ location_code, limit })` which reads
--     the oldest N rows for that location and returns the rendered
--     HTML for each. Pairing each render with a dequeue (or an
--     operator-issued `dequeue` call after the printer confirms)
--     keeps the queue from re-printing the same slip on the next
--     batch. `(location_code, queued_at)` is the read index; the
--     PRIMARY KEY on `(order_id, location_code)` is a per-pair
--     idempotency guard — enqueueing the same order at the same
--     location twice refuses rather than duplicating the slip in
--     the next batch.
--
-- Indexes:
--   (order_id, occurred_at desc) on packing_slip_prints — the
--                                 per-order audit view read by
--                                 `printsForOrder` newest-first.
--   (location_code, queued_at)   on packing_slip_queue — the FIFO
--                                 batched-render read shape.

CREATE TABLE IF NOT EXISTS packing_slip_prints (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  printer_name  TEXT,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  sha3_512      TEXT NOT NULL CHECK (length(sha3_512) = 128),
  occurred_at   INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_packing_slip_prints_order
  ON packing_slip_prints(order_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS packing_slip_queue (
  order_id      TEXT NOT NULL,
  location_code TEXT NOT NULL CHECK (length(location_code) >= 1 AND length(location_code) <= 64),
  queued_at     INTEGER NOT NULL,
  PRIMARY KEY (order_id, location_code),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_packing_slip_queue_location
  ON packing_slip_queue(location_code, queued_at);
