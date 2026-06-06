-- Inbound Stripe webhook replay defense — one row per processed event id.
--
-- A captured, validly-signed Stripe webhook can be replayed verbatim
-- within the ±5-minute signature tolerance window: the signature still
-- verifies, so signature-checking alone does not stop a replay. The
-- downstream order-state idempotency (skip when the order already reached
-- the event's target state) covers the common payment_intent.succeeded
-- re-delivery, but it is keyed on ORDER state, not event identity — a
-- replay that races the first delivery before the order advances, a
-- refund/cancel replay, or an event that maps to no order all slip past
-- it. This table makes the defense event-id-exact and atomic.
--
-- The handler does an atomic INSERT ... ON CONFLICT DO NOTHING on the
-- Stripe event id the moment a signature verifies: the PRIMARY KEY race
-- decides the winner, so two concurrent deliveries of the same event id
-- cannot both proceed. A replay (rowCount === 0) is treated as an
-- already-processed no-op, never re-applied.
--
-- `expires_at` bounds retention to the tolerance window (a replay can
-- only land inside it); a periodic sweep deletes expired rows so the
-- table stays small. `first_seen_at` is kept for operator forensics
-- ("when did we first process this event").

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id      TEXT NOT NULL PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_expires_at
  ON stripe_webhook_events(expires_at);
