-- Queryable buyer-email hash on orders, for guest-order reconciliation.
--
-- A guest checkout records the buyer's email only inside ship_to_json,
-- which isn't indexable. This column stores the same hash the customers
-- table keys on — `b.crypto.namespaceHash("customer-email", email)` —
-- written at checkout. When a shopper later authenticates with a
-- provider-VERIFIED email (OIDC), their prior guest orders (customer_id
-- IS NULL) whose customer_email_hash matches can be claimed into the
-- account. Linking is gated on verified email at the application layer;
-- this column is just the lookup key. Nullable — pre-existing orders +
-- orders placed before checkout wired the write stay NULL (never linked).

ALTER TABLE orders ADD COLUMN customer_email_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_email_hash ON orders(customer_email_hash);
