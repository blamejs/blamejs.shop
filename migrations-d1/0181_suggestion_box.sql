-- Suggestion box — customer-submitted product / feature /
-- improvement ideas. Distinct from customer_surveys (operator-driven
-- post-purchase questionnaires) — this is the "users tell us what
-- to build" loop. Customers submit a title + body, browse + vote on
-- other customers' submissions, and operators respond with a status
-- transition through the product-roadmap FSM.
--
-- Two tables:
--
--   suggestions — one row per submitted idea. `customer_id` and
--                 `customer_email_hash` are both nullable so an
--                 anonymous storefront visitor with neither an
--                 account nor a confirmed email can still submit
--                 (and at least one of the two SHOULD be set at the
--                 primitive layer — but the schema doesn't enforce
--                 it because operators occasionally hand-import a
--                 batch from an external feedback tool that didn't
--                 capture identity). The email is hashed via
--                 `b.crypto.namespaceHash("suggestion-box-email",
--                 email)` so the raw email never lands on disk.
--                 `category` is the operator-roadmap bucket
--                 (product_idea / feature_request / improvement /
--                 complaint / general). `status` is the FSM the
--                 operator drives:
--                   open               — submitted, no response yet
--                   under_consideration — operator triaged, evaluating
--                   planned            — committed to the roadmap
--                   shipped            — delivered (terminal)
--                   declined           — won't build (terminal)
--                   duplicate          — merged into another suggestion
--                                        via `canonical_id` link
--                 `vote_count` and `comment_count` are denormalized
--                 counters bumped by voteOnSuggestion / response
--                 writes so the list page renders without a GROUP BY.
--                 `response_text` + `response_by` + `responded_at`
--                 carry the operator's public-facing reply (rendered
--                 as plain text — Markdown rendering happens at the
--                 presentation layer if the operator opts in).
--                 `canonical_id` is the FK target for duplicates —
--                 NULL on a non-duplicate row; pointing at the
--                 canonical suggestion on a row marked duplicate.
--                 `spam_flagged` hides the row from public lists +
--                 the metrics rollup without deleting it (the
--                 operator can un-flag if a false positive). The
--                 `archived_at` soft-delete tombstone is the same
--                 pattern as the other primitives — once archived,
--                 votes / responses / duplicate-linking refuse.
--
--   suggestion_votes — one vote per (suggestion_id, session_id_hash)
--                 via UNIQUE so a repeat-vote from the same browser
--                 session collapses to a no-op. session_id is
--                 hashed via `b.crypto.namespaceHash("suggestion-
--                 box-vote-session", id)` so the raw session id
--                 never lands on disk. `vote` is upvote / downvote;
--                 the denormalized `vote_count` on suggestions is
--                 (#upvotes - #downvotes) — a net score, not a raw
--                 tally, because operators rank the roadmap by
--                 signal-net-noise rather than gross engagement.
--
-- Indexes drive the four hot read paths:
--   * (category, status, vote_count DESC)   — listSuggestions
--     top-voted within a category + status filter
--   * (created_at DESC)                     — listSuggestions newest
--   * (comment_count DESC)                  — most_discussed sort
--   * (suggestion_id) on suggestion_votes   — vote merge on
--     linkDuplicates + per-suggestion vote audit

CREATE TABLE IF NOT EXISTS suggestions (
  id                      TEXT    NOT NULL PRIMARY KEY,
  customer_id             TEXT,
  customer_email_hash     TEXT,
  title                   TEXT    NOT NULL,
  body                    TEXT    NOT NULL,
  category                TEXT    NOT NULL CHECK (category IN (
                            'product_idea', 'feature_request', 'improvement', 'complaint', 'general'
                          )),
  status                  TEXT    NOT NULL CHECK (status IN (
                            'open', 'under_consideration', 'planned', 'shipped', 'declined', 'duplicate'
                          )),
  vote_count              INTEGER NOT NULL DEFAULT 0,
  comment_count           INTEGER NOT NULL DEFAULT 0,
  response_text           TEXT,
  response_by             TEXT,
  responded_at            INTEGER,
  canonical_id            TEXT,
  spam_flagged            INTEGER NOT NULL DEFAULT 0 CHECK (spam_flagged IN (0, 1)),
  archived_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  CHECK ((status = 'duplicate'     AND canonical_id IS NOT NULL)
      OR (status <> 'duplicate'    AND canonical_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_suggestions_category_status_votes
  ON suggestions(category, status, vote_count DESC);

CREATE INDEX IF NOT EXISTS idx_suggestions_created
  ON suggestions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_suggestions_comments
  ON suggestions(comment_count DESC);

CREATE INDEX IF NOT EXISTS idx_suggestions_canonical
  ON suggestions(canonical_id);

CREATE INDEX IF NOT EXISTS idx_suggestions_status
  ON suggestions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS suggestion_votes (
  id                      TEXT    NOT NULL PRIMARY KEY,
  suggestion_id           TEXT    NOT NULL,
  session_id_hash         TEXT    NOT NULL,
  vote                    TEXT    NOT NULL CHECK (vote IN ('upvote', 'downvote')),
  occurred_at             INTEGER NOT NULL,
  UNIQUE (suggestion_id, session_id_hash)
);

CREATE INDEX IF NOT EXISTS idx_suggestion_votes_suggestion
  ON suggestion_votes(suggestion_id, occurred_at DESC);
