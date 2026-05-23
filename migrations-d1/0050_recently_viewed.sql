-- Recently-viewed — storefront personalization log. Tracks the last
-- N products each customer (or anonymous session) opened on the
-- product-detail page. Drives "Recently viewed" rails, "you might
-- also like" recommendations seeded by a customer's recent browse
-- history, and the merge-on-login flow that carries an anonymous
-- shopper's pre-auth browse into their account.
--
-- Schema decisions:
--   * Either `customer_id` OR `session_id_hash` is populated; the
--     CHECK at the bottom enforces that. A row is either anchored
--     to a known customer (authenticated browse) OR to an opaque
--     hashed session identifier (anonymous browse). `merge()`
--     rewrites session rows into the customer record on login so
--     the pre-auth history persists.
--   * `session_id_hash` is the namespace-hashed (`recently-viewed-
--     session`) form of the session id, computed via
--     `b.crypto.namespaceHash` at the app layer. The raw session id
--     is NEVER written to this table — so an operator-side dump
--     can't be replayed to impersonate a still-active session
--     cookie. The hash is a deterministic SHA3-512 hex string so
--     `forSession()` can look it up by hashing the caller-supplied
--     session id at read time.
--   * `product_id` is a SOFT foreign key — the recently-viewed
--     primitive validates UUID shape via `b.guardUuid`, but the
--     D1 layer doesn't enforce referential integrity. A view of
--     an archived / deleted product is operator-orphan-tolerant;
--     the storefront renders an "unavailable" badge rather than
--     crashing the rail.
--   * `viewed_at` captures the first time this (subject, product)
--     pair was logged. `last_viewed_at` is bumped on every
--     subsequent view within the 5-minute dedup window — the app
--     layer collapses repeated PDP refreshes into a single row
--     with an incremented `view_count` instead of writing a new
--     row per refresh. Both are INTEGER epoch milliseconds.
--   * `view_count` mirrors how many de-duped opens this row has
--     accumulated. Operators surface it as a "viewed N times" badge
--     on the account page.
--
-- UNIQUE constraint: one (subject, product) tuple per subject. The
-- subject is `customer_id` when present and `session_id_hash`
-- otherwise. The COALESCE collapses the two-column subject into a
-- single composite key so the UNIQUE index covers both anonymous
-- and authenticated rows without a partial-index split.
--
-- Indexes:
--   * `(customer_id, last_viewed_at DESC)` — `forCustomer` reads
--     scoped to one customer in newest-first order; the index
--     covers the filter and the ORDER BY.
--   * `(session_id_hash, last_viewed_at DESC)` — same shape for
--     `forSession`.
--   * `(product_id, last_viewed_at)` — `recommend`'s co-viewed
--     signal walks "other customers who viewed product X" via this
--     index; second column also supports cheap `cleanupOlderThan`
--     scans scoped to a single product.

CREATE TABLE IF NOT EXISTS recently_viewed (
  id               TEXT NOT NULL PRIMARY KEY,
  customer_id      TEXT,
  session_id_hash  TEXT,
  product_id       TEXT NOT NULL,
  viewed_at        INTEGER NOT NULL,
  last_viewed_at   INTEGER NOT NULL,
  view_count       INTEGER NOT NULL DEFAULT 1 CHECK (view_count > 0),
  CHECK (customer_id IS NOT NULL OR session_id_hash IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recently_viewed_unique
  ON recently_viewed(
    COALESCE(customer_id, ''),
    COALESCE(session_id_hash, ''),
    product_id
  );

CREATE INDEX IF NOT EXISTS idx_recently_viewed_customer
  ON recently_viewed(customer_id, last_viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_recently_viewed_session
  ON recently_viewed(session_id_hash, last_viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_recently_viewed_product
  ON recently_viewed(product_id, last_viewed_at);
