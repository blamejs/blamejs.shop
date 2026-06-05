-- Per-row unsubscribe bearer token for back-in-stock alerts.
--
-- The public POST /stock-alert/unsubscribe route previously deleted a
-- subscription by the raw (email_hash, sku, variant_id) tuple carried in
-- the link query. That tuple is guessable — anyone who knows a victim's
-- email and a SKU could cancel their pending restock alert. Every other
-- opt-out surface in the shop (the newsletter one-click unsubscribe) is
-- gated on an opaque, single-use bearer token instead.
--
-- This column stores `b.crypto.namespaceHash("stock-alert-unsub-token",
-- plaintext)` — a SHA3-512 hex digest of the 32-char base64url plaintext
-- token. The plaintext is returned ONCE from `subscribe` (so the
-- confirmation email can embed the unsubscribe link) and minted fresh per
-- fired row inside `scanAndNotify` (so the back-in-stock notification
-- email carries its own live link); only the hash is durable. The
-- storefront's unsubscribe route resolves the row by this hash and
-- deletes it — the token IS the authorization, so no session is needed
-- and an attacker can no longer cancel an alert they can't produce the
-- token for.
--
-- Nullable: rows written before this migration ran (and the legacy tuple
-- shape) carry NULL until they re-subscribe. A NULL hash never matches a
-- token lookup, so those rows are simply un-unsubscribable via the new
-- route until they re-subscribe and mint one — `cleanupExpired` still
-- prunes them on the retention schedule.

ALTER TABLE stock_alerts ADD COLUMN unsubscribe_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_alerts_unsub_token
  ON stock_alerts(unsubscribe_token_hash);
