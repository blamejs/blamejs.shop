-- Order notes — threaded customer-service conversation attached to
-- an order. Two visibility levels:
--
--   internal          — operator-only. Fraud markers, fulfillment
--                       hints, internal hand-offs.
--   customer_visible  — surfaces on the customer's order page and
--                       in transactional email.
--
-- A note is either a fresh thread starter (`parent_note_id` NULL)
-- or a reply to a prior note. Replies inherit no fields from their
-- parent — visibility / author / tags are stamped per row so an
-- operator can convert an internal thread into customer-visible
-- correspondence without backfilling.
--
-- `author` enumerates the writer's role:
--   customer  — the order's customer wrote it
--   operator  — a staff member wrote it
--   system    — the framework wrote it (FSM transition narration,
--               automated dunning, etc.)
-- `author_id` is the optional UUID of the customer / operator;
-- system-authored notes leave it NULL.
--
-- `tags_json` stores a free-form string array (cap 16 × 32 chars
-- enforced at the primitive layer) so operators can build their
-- own taxonomies (fraud / refund / replacement / vip / …) without
-- a schema migration per label.
--
-- `pinned` floats a note to the top of the listing. `resolved_at` +
-- `resolution` close out an internal thread with a 280-char
-- operator summary; `reopen` clears both and the thread becomes
-- active again.
--
-- `order_note_reads` records who's seen which note. A given
-- (note_id, reader_actor, reader_id) tuple is unique — re-emitting
-- the read receipt is a no-op so the storefront can call
-- `markRead` on every render without growing the table.

CREATE TABLE IF NOT EXISTS order_notes (
  id              TEXT NOT NULL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  parent_note_id  TEXT,
  author          TEXT NOT NULL CHECK (author IN ('customer', 'operator', 'system')),
  author_id       TEXT,
  visibility      TEXT NOT NULL CHECK (visibility IN ('internal', 'customer_visible')),
  body            TEXT NOT NULL,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  resolved_at     INTEGER,
  resolution      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (order_id)       REFERENCES orders(id)       ON DELETE CASCADE,
  FOREIGN KEY (parent_note_id) REFERENCES order_notes(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_notes_order_vis    ON order_notes(order_id, visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_notes_order_pinned ON order_notes(order_id, pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_notes_parent       ON order_notes(parent_note_id);
CREATE INDEX IF NOT EXISTS idx_order_notes_order_resolved ON order_notes(order_id, resolved_at);

CREATE TABLE IF NOT EXISTS order_note_reads (
  id            TEXT NOT NULL PRIMARY KEY,
  note_id       TEXT NOT NULL,
  reader_actor  TEXT NOT NULL CHECK (reader_actor IN ('customer', 'operator', 'system')),
  reader_id     TEXT,
  read_at       INTEGER NOT NULL,
  UNIQUE (note_id, reader_actor, reader_id),
  FOREIGN KEY (note_id) REFERENCES order_notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_note_reads_note   ON order_note_reads(note_id);
CREATE INDEX IF NOT EXISTS idx_order_note_reads_reader ON order_note_reads(reader_actor, reader_id);
