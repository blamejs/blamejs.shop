-- Return-shipping labels: operator-funded pre-paid return labels and
-- their carrier-scan timeline.
--
-- One return_labels row per shipping label issued against a
-- return_authorizations row. The lifecycle is a small FSM walked at
-- the application tier (lib/return-labels.js):
--
--     issued ──markShipped──► shipped ──markInTransit──► in_transit ──markDelivered──► delivered
--                                  │                          │                    (flips return → received)
--                                  └──── markException ───────┴───► exception
--
-- Reaching `delivered` is the carrier-confirmed handoff back to the
-- merchant; the application tier flips the underlying return row to
-- `received` (via injected `returns.markReceived`) so the existing
-- RMA FSM owns the customer-facing refund flow without divergence.
--
-- `exception` is the lost / damaged / refused bucket — terminal at
-- this tier; remediation (issue a replacement label, escalate to
-- carrier dispute) is an operator decision outside the FSM.
--
-- Companion table `return_label_events` is the append-only timeline
-- of FSM transitions + intermediate carrier scans. Every transition
-- writes one row so `eventsForLabel(label_id)` reconstructs the full
-- carrier journey without a separate audit log.
--
-- `tracking_number` is intentionally NOT unique — re-issuing a label
-- on the same tracking number (e.g. carrier label-recovery flow) is
-- a legitimate operator action.

CREATE TABLE IF NOT EXISTS return_labels (
  id              TEXT NOT NULL PRIMARY KEY,
  return_id       TEXT NOT NULL,
  carrier         TEXT NOT NULL,
  service_level   TEXT NOT NULL,
  label_url       TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('issued','shipped','in_transit','delivered','exception')),
  cost_minor      INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  issued_at       INTEGER NOT NULL,
  shipped_at      INTEGER,
  delivered_at    INTEGER,
  FOREIGN KEY (return_id) REFERENCES return_authorizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_return_labels_return   ON return_labels(return_id);
CREATE INDEX IF NOT EXISTS idx_return_labels_status   ON return_labels(status, issued_at);
CREATE INDEX IF NOT EXISTS idx_return_labels_tracking ON return_labels(tracking_number);

CREATE TABLE IF NOT EXISTS return_label_events (
  id          TEXT NOT NULL PRIMARY KEY,
  label_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (label_id) REFERENCES return_labels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_return_label_events_label ON return_label_events(label_id, occurred_at);
