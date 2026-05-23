-- Stock-alert subscriptions — "Notify me when back in stock" surface.
--
-- A customer (logged in or anonymous) subscribes their email to a SKU
-- (optionally a specific variant). When inventory rises above zero for
-- that SKU, the scan-and-notify sweeper finds the pending subscription
-- and hands the recipient + payload to the `notifications` primitive
-- (if the operator wired the dependency).
--
-- Schema decisions:
--
--   * `email_hash` is `b.crypto.namespaceHash("stock-alert-email",
--     normalised_email)` — a SHA3-512 hex digest. The raw address is
--     never queried; lookup by `(email_hash, sku, variant_id)` keeps
--     the operator-visible WHERE clauses PII-free.
--
--   * `email_normalised` is the lowercased + trimmed plaintext kept
--     alongside the hash so the dispatcher (which already runs inside
--     the trusted operator process) can hand the canonical address to
--     `notifications.enqueue` without a reverse-lookup table. D1's
--     at-rest AEAD covers the disk layer; operators wrapping with
--     application-layer AEAD compose `b.vault.seal` at the route
--     boundary.
--
--   * `variant_id` is nullable. The unique-index `COALESCE(variant_id,
--     '')` collapses NULL to '' so the (email_hash, sku, NULL) and
--     (email_hash, sku, '<some-variant>') tuples are distinct rows —
--     a customer can subscribe to a product's any-variant alert AND a
--     specific variant without colliding.
--
--   * `customer_id` is nullable. Anonymous subscribers (no account)
--     subscribe by email alone; logged-in customers carry the link so
--     `listForCustomer` can return their pending alerts without a
--     hash round-trip.
--
--   * `confirmation_token_hash` is the SHA3-512 namespace-hash of the
--     32-char base64url plaintext token. The plaintext is returned
--     once from `subscribe`; the operator places it in the confirmation
--     email link. Re-subscriptions to the same (email, sku, variant)
--     return the existing row's status — the token only mints fresh on
--     a brand-new subscription so a link emailed earlier doesn't
--     silently break.
--
--   * `confirmed_at` gates the alert: only confirmed rows participate
--     in scanAndNotify. Operators that don't want double-opt-in still
--     get the column populated by calling `confirm` directly with the
--     plaintext token; the column is the universal gate, not the
--     workflow's optional opt-in.
--
--   * `notified_at` marks a row's terminal state — once an alert has
--     fired, it never fires again for the same subscription. A
--     customer re-subscribing after the notification has fired writes
--     a fresh row (the prior row's notified_at != NULL clears the
--     unique-index slot via the WHERE clause used by the primitive's
--     dedupe path).
--
--   * `expires_at` lets the operator prune stale subscriptions
--     (typically 90 days). `cleanupExpired` honors the timestamp;
--     subscriptions never silently expire from `scanAndNotify`'s
--     point of view — the column is operator-driven retention.

CREATE TABLE IF NOT EXISTS stock_alerts (
  id                        TEXT NOT NULL PRIMARY KEY,
  email_hash                TEXT NOT NULL,
  email_normalised          TEXT NOT NULL,
  sku                       TEXT NOT NULL,
  variant_id                TEXT,
  customer_id               TEXT,
  confirmation_token_hash   TEXT NOT NULL,
  confirmed_at              INTEGER,
  notified_at               INTEGER,
  expires_at                INTEGER NOT NULL,
  created_at                INTEGER NOT NULL
);

-- A single live subscription per (email_hash, sku, variant_id) — once
-- a row has been notified the customer must re-subscribe to receive
-- another alert. The primitive's `subscribe` honors this by either
-- returning the existing pending row OR (when the prior row is
-- terminal — notified or expired) deleting it before INSERTing fresh.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_alerts_unique
  ON stock_alerts(email_hash, sku, COALESCE(variant_id, ''));

-- Scan-and-notify reads pending rows by SKU. Confirmed + un-notified +
-- un-expired is the hot filter.
CREATE INDEX IF NOT EXISTS idx_stock_alerts_sku_pending
  ON stock_alerts(sku, notified_at, confirmed_at, expires_at);

-- listForCustomer hits this index.
CREATE INDEX IF NOT EXISTS idx_stock_alerts_customer
  ON stock_alerts(customer_id, created_at DESC);

-- Retention sweep.
CREATE INDEX IF NOT EXISTS idx_stock_alerts_expires
  ON stock_alerts(expires_at);
