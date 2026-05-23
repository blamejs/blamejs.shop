-- Search ranking — operator-tunable storefront search reranking.
--
-- Three tables. The first holds named weight sets that the storefront
-- search reranker reads on every query; the second pins individual
-- products to a fixed position for a specific query (the
-- merchandising override); the third records impression / click /
-- purchase events keyed by the weight set in force when the result
-- list was rendered so operators can A/B two weight sets and read
-- click-through + conversion numbers per set.
--
-- `search_weight_sets` — one row per named weight set. `slug` is the
-- stable operator-chosen identifier. `weights_json` is a flat object
-- mapping signal name (popularity, recency, rating, availability,
-- margin, …) to a finite numeric multiplier — signals not present on
-- a result contribute zero; signals on the result not present in the
-- weights JSON contribute zero. `active` flips one set into the live
-- ranker; exactly one set is ever `active = 1` (the primitive
-- enforces this in transaction: setActiveWeights flips the prior
-- active set to 0 in the same call). `archived_at` soft-deletes a
-- weight set without breaking the FK that search_events carries to
-- it for historical metrics.
--
-- `search_manual_pins` — (query, product_id) -> position. Pins always
-- come first in the rendered result list, ordered by `position` ASC
-- with ties broken by `created_at` ASC so a re-pinned slot still
-- sorts deterministically. `query` is normalised at the entry point
-- (lowercased + whitespace-collapsed) so case + extra spaces don't
-- create phantom pin sets. UNIQUE on (query, product_id) so re-pinning
-- the same (query, product) replaces the position in place.
--
-- `search_events` — append-only event log. (query, product_id,
-- weights_slug, event_type, occurred_at). `event_type` is one of
-- `impression`, `click`, `purchase`; the rollup math reads counts per
-- type to compute CTR + conversion per weight set per window.
-- `position` is the 1-indexed rank of the product in the rendered
-- result list when the event fired (so the operator can see "click-
-- through at position 1 vs position 5" if they want to dig in
-- later); the rollup itself doesn't use it. `session_id_hash` is
-- SHA3-512 of (`search-ranking-session`, raw_session) — the raw
-- session id never lands on disk; the column is nullable for
-- impression / click rows that don't carry a session (the operator's
-- worker can be wired without a session capture).
--
-- Indexes:
--   * `search_weight_sets.active` — the storefront ranker reads the
--     active set on every search; the index makes the lookup an O(1)
--     index probe.
--   * `(query)` on `search_manual_pins` — `pinsForQuery` is the hot
--     read; the index covers it with a single seek.
--   * `(weights_slug, event_type, occurred_at)` on `search_events` —
--     `metricsForWeights` aggregates by (weights_slug, event_type)
--     inside a closed time window; this is the covering index.

CREATE TABLE IF NOT EXISTS search_weight_sets (
  slug          TEXT NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  weights_json  TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_weight_sets_active
  ON search_weight_sets(active, archived_at);

CREATE TABLE IF NOT EXISTS search_manual_pins (
  query         TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  position      INTEGER NOT NULL CHECK (position > 0),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (query, product_id)
);

CREATE INDEX IF NOT EXISTS idx_search_manual_pins_query
  ON search_manual_pins(query, position ASC, created_at ASC);

CREATE TABLE IF NOT EXISTS search_events (
  id                TEXT NOT NULL PRIMARY KEY,
  query             TEXT NOT NULL,
  product_id        TEXT,
  weights_slug      TEXT NOT NULL,
  event_type        TEXT NOT NULL CHECK (event_type IN ('impression', 'click', 'purchase')),
  position          INTEGER,
  session_id_hash   TEXT,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_events_weights_type_time
  ON search_events(weights_slug, event_type, occurred_at);

CREATE INDEX IF NOT EXISTS idx_search_events_query
  ON search_events(query, occurred_at DESC);
