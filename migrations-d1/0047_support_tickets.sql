-- Support tickets — customer-service ticketing surface broader than
-- order_notes. A ticket isn't necessarily tied to an order: it can be
-- a pre-sale question, an account problem, a billing dispute, or a
-- complaint. Each ticket has a thread of messages (customer +
-- operator + system), a priority + status FSM, optional order /
-- customer links, free-form tags, and an SLA timer that the
-- scheduler walks to surface breaches.
--
-- Three tables:
--
--   support_tickets         — one row per ticket. `customer_email_hash`
--                             is `b.crypto.namespaceHash("support-
--                             ticket-email", lowercased_email)` so the
--                             raw address never lands on disk while a
--                             customer can still look up their own
--                             tickets (the storefront re-derives the
--                             hash from the session-attached email).
--                             `tags_json` is a free-form string array.
--                             Timestamps:
--                               opened_at         — ticket creation
--                               first_response_at — first operator reply
--                               last_action_at    — last operator-side
--                                                   action (reply, assign,
--                                                   transition) — drives
--                                                   the SLA timer
--                               resolved_at       — first entry into
--                                                   `resolved`
--                               closed_at         — first entry into
--                                                   `closed`
--
--   support_messages        — one row per message in the ticket
--                             thread. `author` is the writer's role
--                             (customer / operator / system).
--                             `internal` flags an operator-only note
--                             that the customer never sees.
--
--   support_status_history  — one row per FSM transition. Drives the
--                             metrics endpoint's escalation-rate
--                             (count of transitions back to
--                             `in_progress` from `waiting_customer`
--                             or `reopened`) and gives operators an
--                             audit trail.

CREATE TABLE IF NOT EXISTS support_tickets (
  id                       TEXT NOT NULL PRIMARY KEY,
  customer_id              TEXT,
  customer_email_hash      TEXT NOT NULL,
  subject                  TEXT NOT NULL,
  body                     TEXT NOT NULL,
  category                 TEXT NOT NULL CHECK (category IN (
    'pre_sale', 'order_issue', 'shipping', 'billing', 'refund',
    'account', 'complaint', 'feature_request', 'other'
  )),
  status                   TEXT NOT NULL CHECK (status IN (
    'new', 'in_progress', 'waiting_customer', 'resolved', 'closed', 'reopened'
  )),
  priority                 TEXT NOT NULL CHECK (priority IN (
    'low', 'normal', 'high', 'urgent'
  )),
  order_id                 TEXT,
  assigned_operator_id     TEXT,
  tags_json                TEXT NOT NULL DEFAULT '[]',
  opened_at                INTEGER NOT NULL,
  first_response_at        INTEGER,
  last_action_at           INTEGER NOT NULL,
  resolved_at              INTEGER,
  closed_at                INTEGER
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_priority
  ON support_tickets(status, priority DESC, last_action_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_email_opened
  ON support_tickets(customer_email_hash, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned
  ON support_tickets(assigned_operator_id, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_last_action
  ON support_tickets(status, last_action_at);

CREATE TABLE IF NOT EXISTS support_messages (
  id           TEXT NOT NULL PRIMARY KEY,
  ticket_id    TEXT NOT NULL,
  author       TEXT NOT NULL CHECK (author IN ('customer', 'operator', 'system')),
  author_id    TEXT,
  body         TEXT NOT NULL,
  internal     INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1)),
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket
  ON support_messages(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS support_status_history (
  id           TEXT NOT NULL PRIMARY KEY,
  ticket_id    TEXT NOT NULL,
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  occurred_at  INTEGER NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_support_status_history_ticket
  ON support_status_history(ticket_id, occurred_at);
