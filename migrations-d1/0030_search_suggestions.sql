-- Search suggestions — autocomplete dropdown data for the
-- storefront search input. Three independent tables backing the
-- three categories the dropdown surfaces:
--
--   * `featured_search_suggestions` — operator-curated rows. Typing
--     a prefix that matches `prefix` (e.g. `free` -> "Free shipping
--     over $50") surfaces the row alongside the product / popular-
--     query suggestions. Each row carries a `priority` so the
--     operator can pin a row above peers and a `(starts_at,
--     expires_at)` window so time-bound promotions evict
--     themselves.
--   * `search_query_log` — append-only log of customer-typed
--     search strings, feeding the "popular searches" category.
--     The raw query is stored (it's user-typed search text, not
--     PII); the session identifier is hashed via
--     `b.crypto.namespaceHash` at the write site so the log holds
--     no recoverable customer-side identifier.
--
-- Schema decisions:
--   * `prefix` on `featured_search_suggestions` is lowercased at
--     the write site so the index lookup is a plain equality on
--     the typed prefix (already lowercased by the primitive). No
--     case-folding collation, no LIKE — substring matches across
--     the prefix bucket would defeat operator-pinned ordering.
--   * `query_normalized` on `search_query_log` is the lowercased +
--     trimmed form of the customer-typed string. The aggregate
--     query for "popular" uses `LIKE q || '%'` against the
--     `(query_normalized, occurred_at)` index so the recent-window
--     filter and the prefix filter share an index seek.
--   * `result_count` is the count of matching products the
--     storefront search returned at log time. Used by the
--     dashboard to spot zero-result terms (a signal for "we
--     should stock this" or "our search misses this synonym").
--   * `occurred_at` is epoch-ms (every other table in the
--     codebase agrees). `idx_search_query_log_occurred` exists
--     for the retention cleanup scan, which is a range delete
--     keyed only on the timestamp.
--   * Status enum on featured rows is the FSM the
--     suggest / addFeatured / updateFeatured surface honours:
--     `draft` (operator authoring), `active` (visible), `expired`
--     (kept for audit; never surfaced).

CREATE TABLE IF NOT EXISTS featured_search_suggestions (
  id            TEXT NOT NULL PRIMARY KEY,
  prefix        TEXT NOT NULL,                  -- the typed-prefix this featured-suggestion triggers on; lowercased
  display_text  TEXT NOT NULL,                  -- what the dropdown shows
  link_url      TEXT NOT NULL,                  -- where the click goes
  priority      INTEGER NOT NULL DEFAULT 0,
  starts_at     INTEGER NOT NULL,
  expires_at    INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('active','expired','draft')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_query_log (
  -- For "popular searches" suggestions. Privacy: the raw search
  -- query is stored (it's user-typed search text, not PII) but the
  -- session ID hash is the only customer-side identifier.
  id                TEXT NOT NULL PRIMARY KEY,
  query_normalized  TEXT NOT NULL,              -- lowercased, trimmed
  session_id_hash   TEXT NOT NULL,
  result_count      INTEGER NOT NULL DEFAULT 0,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_featured_prefix              ON featured_search_suggestions(prefix, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_search_query_log_normalized  ON search_query_log(query_normalized, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_query_log_occurred    ON search_query_log(occurred_at);
