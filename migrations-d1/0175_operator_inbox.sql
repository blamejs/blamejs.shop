-- Operator inbox: per-operator notification feed for system events
-- (refund-failure, low-stock, security-incident, customer-survey-low-
-- nps, etc.). The application enqueues messages keyed to either a
-- specific `operator_id` (UUID — the named human in the operator
-- console) or to a `role` (every operator carrying that role at the
-- time the message is read sees it in their inbox). Both addressing
-- modes coexist; the read path UNIONs them transparently.
--
-- One table: `operator_inbox_messages`. The read-state FSM lives on
-- two columns —
--   * `read_at`     (INTEGER NULL) — when the operator marked it read.
--   * `archived_at` (INTEGER NULL) — when an operator archived the
--                                   message (terminal; archived rows
--                                   never re-surface in the inbox
--                                   read, only via explicit fetch).
-- The state machine collapses to four observable rows:
--   * (read_at NULL, archived_at NULL)   — unread, active
--   * (read_at NOT NULL, archived_at NULL) — read, active
--   * (read_at NULL, archived_at NOT NULL) — unread, archived (rare —
--                                            bulk-archive without
--                                            read-through)
--   * (read_at NOT NULL, archived_at NOT NULL) — read, archived
--
-- `severity` is a four-level closed enum (info / warning / urgent /
-- critical). `kind` is operator-authored (the application categorizes
-- messages — refund_failure, low_stock, etc.); the column is open so
-- domains added later don't require a migration. `payload_json` is
-- the structured event payload — the inbox primitive doesn't
-- interpret it.
--
-- Addressing — exactly one of `operator_id` / `role` is NOT NULL at
-- the schema level (CHECK constraint). Operator-id targeting wins
-- over role broadcasts when both addressing modes carry the same
-- message; the application picks one at enqueue time.
--
-- Indexes drive five hot read paths:
--   * (operator_id, archived_at, read_at, created_at DESC) — inbox
--     scroll for one named operator.
--   * (role, archived_at, read_at, created_at DESC) — inbox scroll
--     for the role-broadcast bucket.
--   * (kind, severity, created_at) — metricsForKind aggregation.
--   * (created_at)                 — cleanupOlderThan sweep.
--   * (id PK)                      — point reads on markRead /
--                                    archiveMessage.

CREATE TABLE IF NOT EXISTS operator_inbox_messages (
  id              TEXT    NOT NULL PRIMARY KEY,
  operator_id     TEXT,
  role            TEXT,
  kind            TEXT    NOT NULL,
  severity        TEXT    NOT NULL CHECK (severity IN ('info', 'warning', 'urgent', 'critical')),
  subject         TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  payload_json    TEXT    NOT NULL,
  source_event_id TEXT,
  read_at         INTEGER,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  CHECK ((operator_id IS NOT NULL AND role IS NULL)
      OR (operator_id IS NULL     AND role IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_operator_inbox_operator
  ON operator_inbox_messages(operator_id, archived_at, read_at, created_at);

CREATE INDEX IF NOT EXISTS idx_operator_inbox_role
  ON operator_inbox_messages(role, archived_at, read_at, created_at);

CREATE INDEX IF NOT EXISTS idx_operator_inbox_kind
  ON operator_inbox_messages(kind, severity, created_at);

CREATE INDEX IF NOT EXISTS idx_operator_inbox_created
  ON operator_inbox_messages(created_at);
