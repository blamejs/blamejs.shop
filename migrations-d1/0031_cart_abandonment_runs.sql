-- Cart abandonment — scheduled scanner that detects active carts
-- left idle past a configured threshold and writes a detection row
-- per (cart, detection_time) so a separate fan-out worker can issue
-- reminder emails without re-detecting the same cart hourly.
--
-- Two tables:
--   * cart_abandonment_detections — one row per detected idle cart.
--     `reminder_status` is the fan-out state machine (pending → sent /
--     skipped-no-email / skipped-suppressed / failed). The UNIQUE
--     constraint on (cart_id, detected_at) prevents the scanner from
--     re-writing the same row if the operator runs it twice in the
--     same millisecond; idempotency across longer runs is enforced
--     at the SELECT site (carts already detected within the current
--     idle window are skipped).
--   * cart_abandonment_runs — one row per scanner invocation. Lets
--     an operator dashboard surface "last run scanned N carts,
--     detected M, sent K reminders". Useful for spotting a scanner
--     that has silently stopped firing (no row in 2× the schedule
--     interval = the cron is broken).
--
-- Privacy posture: `session_id_hash` is the namespace-hashed cart
-- session id (matches the analytics convention) so a raw session id
-- never lands in this table even when the operator dumps the table
-- into an analytics warehouse. `customer_id` is the internal UUID —
-- not PII on its own — and joined to `customers` for the actual
-- email lookup at fan-out time.

CREATE TABLE IF NOT EXISTS cart_abandonment_detections (
  id              TEXT NOT NULL PRIMARY KEY,
  cart_id         TEXT NOT NULL,
  session_id_hash TEXT NOT NULL,
  customer_id     TEXT,                          -- NULL for anonymous carts
  line_count      INTEGER NOT NULL CHECK (line_count > 0),
  subtotal_minor  INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  subtotal_currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(subtotal_currency) = 3),
  -- detection metadata
  detected_at     INTEGER NOT NULL,
  cart_idle_since INTEGER NOT NULL,              -- the cart.updated_at at detection time
  -- reminder fan-out tracking
  reminder_status TEXT NOT NULL CHECK (reminder_status IN ('pending','sent','skipped-no-email','skipped-suppressed','failed')),
  reminder_sent_at INTEGER,
  reminder_skipped_reason TEXT,
  -- dedup keys so we don't re-detect the same cart hourly
  UNIQUE (cart_id, detected_at)
);

CREATE TABLE IF NOT EXISTS cart_abandonment_runs (
  id              TEXT NOT NULL PRIMARY KEY,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  carts_scanned   INTEGER NOT NULL DEFAULT 0,
  carts_detected  INTEGER NOT NULL DEFAULT 0,
  reminders_sent  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_cart_abandonment_detections_cart     ON cart_abandonment_detections(cart_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_cart_abandonment_detections_status   ON cart_abandonment_detections(reminder_status, detected_at);
CREATE INDEX IF NOT EXISTS idx_cart_abandonment_detections_customer ON cart_abandonment_detections(customer_id);
