-- Analytics events — operator-visible event stream for funnel
-- debugging + product/search aggregates. Sits alongside the orders-
-- derived aggregates in `lib/analytics.js`; this table captures
-- pre-purchase signal (PDP views, search queries, wishlist adds,
-- cart adds, checkout starts) that the orders table can't see.
--
-- Schema decisions:
--   * `event_type` is a CHECK-constrained enum. Adding a new event
--     class is a deliberate schema bump, not a free-form text field
--     — the aggregate queries hard-code the categories they care
--     about and an unknown event_type sliding in unobserved would
--     just be dead rows.
--   * PII identifiers are HASHED at the write site via
--     `b.crypto.namespaceHash` (namespaces `"analytics-session"` /
--     `"analytics-customer"`). Raw email / IP / customer_id /
--     session_id never reach this table. The primitive refuses with
--     TypeError if an operator hands it a value that looks like a
--     raw email or IP, on the principle that a hashed value never
--     contains an `@` or three dots in a row.
--   * `payload_json` is opaque to the primitive — operators put
--     whatever they need there (a search-refinement filter, a
--     wishlist-source attribution) but they're on their own
--     boundary not to embed PII inside the JSON. Size is bounded
--     by `recordEvent` (4 KiB) so a runaway payload can't bloat the
--     row.
--   * Denormalised columns (`product_id`, `search_q`, `page_url`,
--     `user_agent_class`) exist so the aggregate queries can index
--     directly without JSON-decoding every row. `user_agent_class`
--     is a small enum (`desktop` / `mobile` / `bot` / `other`) — a
--     full UA string is PII-adjacent and never persisted.
--   * `occurred_at` is epoch-ms (matches every other table in the
--     codebase). Indexes are `(event_type, occurred_at)` for funnel
--     queries, `(session_id_hash, occurred_at)` for sessionFlow,
--     `(product_id, event_type, occurred_at)` for product-level
--     aggregates, and `(search_q, occurred_at)` for top-terms.

CREATE TABLE IF NOT EXISTS analytics_events (
  id           TEXT NOT NULL PRIMARY KEY,
  event_type   TEXT NOT NULL CHECK (event_type IN (
    'pdp_view','collection_view','search_query',
    'wishlist_add','wishlist_remove','cart_add','cart_remove',
    'checkout_start','checkout_complete','newsletter_signup'
  )),
  -- All PII-related identifiers are hashed before they reach this
  -- table; raw email / IP / customer_id never appear here. The
  -- session_id hash is the join key for funnel queries.
  session_id_hash  TEXT NOT NULL,
  customer_id_hash TEXT,
  -- Event-specific payload as JSON. Operators avoid PII at the
  -- write site; the primitive doesn't decode the JSON.
  payload_json TEXT NOT NULL DEFAULT '{}',
  -- Useful denormalised columns for filter without JSON decoding.
  product_id   TEXT,
  search_q     TEXT,
  page_url     TEXT,
  user_agent_class TEXT,   -- 'desktop' | 'mobile' | 'bot' | 'other' (no full UA stored)
  occurred_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type_time     ON analytics_events(event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session       ON analytics_events(session_id_hash, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_product       ON analytics_events(product_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_search_q      ON analytics_events(search_q, occurred_at);
