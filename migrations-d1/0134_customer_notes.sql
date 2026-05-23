-- Customer notes — operator-side CRM annotations attached to a
-- customer record (not to an order). Where order_notes carries the
-- thread of customer-service correspondence for one shipment,
-- customer_notes carries the durable customer-level annotations a
-- support agent or account manager wants to surface every time that
-- customer is on the line:
--
--   "VIP — comp shipping where possible"
--   "Always wants gift wrap on orders > $100"
--   "Do not call after 6pm local time"
--   "Allergic to peanut packaging — flag before fulfilment"
--
-- Unlike order_notes there is no `customer_visible` channel — every
-- customer note is operator-only by design. Customer-facing surfaces
-- belong in the customer-portal / order primitive, never in this
-- table. The `author` column distinguishes operator-authored notes
-- (the common case) from system-authored notes (lifecycle stamps:
-- "first refund issued", "address change recorded").
--
-- `kind` classifies the note for filtered listing:
--
--   general     — uncategorised free-form annotation
--   preference  — durable customer preference (gift wrap, contact
--                 windows, packaging accommodations)
--   escalation  — open escalation tracked against the customer
--                 (complaint, NPS detractor follow-up)
--   warning     — operator-attention flag (fraud watch, ban-evasion
--                 suspect, payment-method abuse history)
--   billing     — billing / dunning / chargeback context an agent
--                 needs before discussing the customer's account
--
-- `tags_json` is the operator-controlled free-form taxonomy (cap 16
-- tags × 64 chars, validated at the primitive layer). The fast-path
-- read pattern `searchByTag` filters on a single tag; `popularTags`
-- aggregates the in-use vocabulary for the operator console's tag
-- picker.
--
-- `pinned` floats a note to the top of `notesForCustomer` — agents
-- pin the VIP / preference notes they want every shift to see first.
--
-- `archived_at` soft-retires a note. Archived notes don't appear in
-- the default listing but `notesForCustomer({ include_archived: true })`
-- surfaces them for audit / undo workflows. Archive is reversible
-- via `pinNote` / `unarchive` semantics handled in lib.
--
-- Indexes drive four hot reads:
--   * (customer_id, archived_at, pinned, created_at) — notesForCustomer
--   * (customer_id, kind, archived_at)               — kind-filtered listing
--   * (archived_at, created_at)                      — global recency sweep
--   * (pinned, customer_id)                          — pinned-only fast path

CREATE TABLE IF NOT EXISTS customer_notes (
  id           TEXT    NOT NULL PRIMARY KEY,
  customer_id  TEXT    NOT NULL,
  author       TEXT    NOT NULL CHECK (author IN ('operator', 'system')),
  author_id    TEXT,
  body         TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('general', 'preference', 'escalation', 'warning', 'billing')),
  tags_json    TEXT    NOT NULL DEFAULT '[]',
  pinned       INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_notes_customer  ON customer_notes(customer_id, archived_at, pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_notes_kind      ON customer_notes(customer_id, kind, archived_at);
CREATE INDEX IF NOT EXISTS idx_customer_notes_recency   ON customer_notes(archived_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_notes_pinned    ON customer_notes(pinned, customer_id);
