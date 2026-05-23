-- Live chat: real-time customer-service queueing for the storefront.
--
-- Distinct from `support_tickets` (async, multi-day correspondence
-- with SLA timers). Live chat is the synchronous surface: a visitor
-- clicks the "chat with us" widget, lands in the queue, an operator
-- picks up, messages flow back and forth, the session closes when
-- the visitor leaves or the operator wraps it up. Abandoned sessions
-- (visitor closed the tab without warning) get reaped by a scheduler
-- pass against `last_activity_at`.
--
-- Three tables:
--
--   * `chat_sessions` — the conversation. One row per chat. Six-
--     state CHECK enum:
--       queued    — visitor opened chat; no operator yet
--       assigned  — operator owns the chat; first operator message
--                   not necessarily sent yet
--       active    — at least one message exchanged in either
--                   direction since assignment
--       waiting   — operator sent a message; visitor hasn't replied
--                   (pure UX state, drives the "customer is typing"
--                   surface; does not block recordMessage)
--       closed    — explicit close by either party (`close_reason`
--                   captures who + why)
--       abandoned — reaper closed it because `last_activity_at` is
--                   older than the idle budget the scheduler walks
--     `assigned_operator_id` is NULL while queued; non-NULL from
--     `assigned` onward. `assigned_at` records when the operator
--     picked up. `last_activity_at` advances on every message and on
--     every state change so the reaper has a single column to walk.
--     `close_reason` is operator-supplied free text bounded at the
--     primitive layer; NULL while non-terminal.
--
--     The visitor's session id + email both ride through
--     `b.crypto.namespaceHash` before they land. A database dump
--     exposes the hash, never the raw values. Visitor session id
--     is hashed under the `live-chat-visitor` namespace; email is
--     hashed under `live-chat-email`. The hashes never round-trip
--     to plaintext.
--
--   * `chat_messages` — one row per message. `author` CHECK enum
--     (customer / operator / system). System messages are emitted
--     by the primitive itself on state transitions (assigned,
--     closed, abandoned) so the rendered transcript is complete
--     without the caller having to interleave system events. The
--     body is the message text; `occurred_at` is the wall-clock
--     stamp. FK CASCADE: deleting a session removes its messages.
--
--   * `chat_operator_state` — per-operator presence row. One row
--     per operator_id (PK). `status` CHECK enum (available / away /
--     offline). The operator console writes this row on connect /
--     idle / disconnect so the dispatcher knows who can pick up the
--     next queued session. `updated_at` is bumped on every write.
--
-- Indexes:
--   * `(status, opened_at)` on `chat_sessions` — the dispatcher
--     reads `waitingQueue` (status='queued' ORDER BY opened_at ASC).
--   * `(assigned_operator_id, status)` on `chat_sessions` —
--     `operatorQueue` filters by operator + status.
--   * `(status, last_activity_at)` on `chat_sessions` — the reaper
--     reads `WHERE status IN ('assigned','active','waiting') AND
--     last_activity_at < ?` to surface abandonment candidates.
--   * `(session_id, occurred_at)` on `chat_messages` — every
--     transcript read keys by session_id ordered by time.
--   * `(visitor_session_id_hash)` on `chat_sessions` — the
--     storefront looks up an in-flight session for the current
--     visitor without scanning the full table.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                       TEXT NOT NULL PRIMARY KEY,
  customer_id              TEXT,
  visitor_session_id_hash  TEXT NOT NULL,
  visitor_email_hash       TEXT,
  source_page              TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
                             'queued', 'assigned', 'active', 'waiting', 'closed', 'abandoned'
                           )),
  assigned_operator_id     TEXT,
  opened_at                INTEGER NOT NULL,
  assigned_at              INTEGER,
  last_activity_at         INTEGER NOT NULL,
  closed_at                INTEGER,
  close_reason             TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           TEXT NOT NULL PRIMARY KEY,
  session_id   TEXT NOT NULL,
  author       TEXT NOT NULL CHECK (author IN ('customer', 'operator', 'system')),
  body         TEXT NOT NULL,
  occurred_at  INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_operator_state (
  operator_id  TEXT NOT NULL PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('available', 'away', 'offline')),
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_status_opened       ON chat_sessions(status, opened_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_operator_status     ON chat_sessions(assigned_operator_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status_activity     ON chat_sessions(status, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_visitor_hash        ON chat_sessions(visitor_session_id_hash);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_time        ON chat_messages(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_chat_operator_state_status        ON chat_operator_state(status);
