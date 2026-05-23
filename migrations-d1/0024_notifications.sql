-- Notifications — queued + scheduled fan-out across in-app, email,
-- and webhook channels.
--
-- The raw recipient identifier is NEVER stored: `recipient_id` and
-- `recipient_id_hash` both hold `namespaceHash("notification-recipient",
-- recipient_id)` (deterministic SHA3-512 via b.crypto.namespaceHash).
-- Two columns are kept for forward-compat with operators that wrap
-- this primitive and want to swap one column for a sealed value via
-- `b.vault.seal`; v1 keeps them equal so a D1 dump leaks no
-- identifiers. Lookups happen on the hash; dispatch resolution
-- (channel target lookup) happens out of band against the operator's
-- own customer / vendor table keyed by the same namespaceHash.
--
-- Status FSM:
--   pending   — written, not yet dispatched (scheduled_at is when
--               the scheduler should pick it up; defaults to row
--               creation time for "send now")
--   sent      — dispatcher handed the payload to the channel
--   failed    — channel returned non-recoverable error; retry_count
--               carries the attempt counter
--   dismissed — recipient hid the in-app notification
--   read      — recipient opened / acknowledged the in-app
--               notification
--
-- `notification_preferences` is the per-recipient opt-out matrix.
-- Composite primary key (recipient_id_hash, event_type, channel)
-- means a recipient can disable a single (event_type, channel) pair
-- without affecting others. Absence of a row is treated as enabled
-- (opt-out, not opt-in — operators that need opt-in semantics seed
-- this table on registration).

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT NOT NULL PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  recipient_id_hash TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('in-app','email','webhook')),
  event_type  TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL CHECK (status IN ('pending','sent','failed','dismissed','read')),
  scheduled_at INTEGER NOT NULL,
  sent_at     INTEGER,
  read_at     INTEGER,
  dismissed_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  recipient_id_hash TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('in-app','email','webhook')),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (recipient_id_hash, event_type, channel)
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id_hash, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_event ON notifications(event_type, created_at);
