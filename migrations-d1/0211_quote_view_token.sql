-- Quote view-token — the access credential for the customer-facing quote
-- page (/quote/:token).
--
-- A quote exposes priced line items, an operator message, and accept /
-- decline controls. The customer reaches it without signing in via a single-
-- use-shaped capability link the operator (or the request flow) issues: a
-- 32-byte random token, stored here only as its SHA3-512 namespace hash so a
-- read of this table never yields a working link. The storefront hashes the
-- presented token and constant-time-compares it against this column; a signed-
-- in customer who OWNS the quote (customer_id match) reaches the same page
-- through their account without the token at all.
--
-- Nullable: a quote created before this column existed (or one the operator
-- only ever drives through the console + the owner's account view) carries no
-- token and is simply unreachable by link until one is minted. Unique so a
-- presented hash resolves to at most one quote.

ALTER TABLE quotes ADD COLUMN view_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_view_token
  ON quotes(view_token_hash) WHERE view_token_hash IS NOT NULL;
