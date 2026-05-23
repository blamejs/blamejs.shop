-- Search synonyms — query rewriting + typo correction for the
-- storefront search input. Three independent tables, each owned by
-- the `searchSynonyms` primitive:
--
--   * `search_synonym_groups` — operator-curated groups that map
--     user-typed terms to canonical search vocabulary. `kind`
--     enumerates the group shape:
--       - `bidirectional` — any term in the group matches every
--         other term (e.g. {tee, t-shirt, tshirt}). The canonical
--         representative is the first term.
--       - `directional` — terms[0..N-1] all rewrite to terms[N];
--         the last entry is the canonical destination. Used for
--         brand-name canonicalisation ({iphone, i-phone} -> iphone).
--     `terms_json` is the array of group members as a JSON string.
--     `slug` is the operator-chosen identifier ([a-z0-9-]+) and is
--     the primary key so the operator's authoring UI can patch /
--     delete by a stable handle.
--   * `search_typos` — known misspelling -> correction pairs. The
--     misspelling is the primary key (lowercased) so the rewrite
--     path is a single equality lookup per token.
--   * `search_stopwords` — terms removed from the canonical query
--     before any other rewrite step ("the", "of", "and", …). The
--     word is the primary key, lowercased at the write site.
--
-- Schema decisions:
--   * All term / word storage is lowercased + trimmed at the write
--     site so the rewrite path never has to case-fold at read time.
--   * `kind` carries a CHECK constraint mirroring the primitive's
--     enum so a hand-crafted INSERT can't poison the rewrite cache
--     with an unknown shape.
--   * `created_at` / `updated_at` are epoch-ms (every other table
--     in the codebase agrees).
--   * Indexes — the rewrite path is "load all groups + typos +
--     stopwords once per primitive instance" so PKs + (kind) are
--     the only seeks we issue. `idx_search_synonym_groups_kind` is
--     present so an operator dashboard filtered by kind doesn't
--     scan the whole table.

CREATE TABLE IF NOT EXISTS search_synonym_groups (
  slug         TEXT NOT NULL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('bidirectional', 'directional')),
  terms_json   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_synonym_groups_kind
  ON search_synonym_groups(kind);

CREATE TABLE IF NOT EXISTS search_typos (
  misspelling  TEXT NOT NULL PRIMARY KEY,
  correction   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_stopwords (
  word         TEXT NOT NULL PRIMARY KEY,
  added_at     INTEGER NOT NULL
);
