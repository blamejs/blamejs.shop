-- Operator activity feed: per-operator timeline aggregator for the
-- admin homepage. Read-only primitive whose only writes land in the
-- `operator_activity_cache` row this migration defines. Every event
-- the feed surfaces lives in its source primitive's canonical table —
-- `operator_audit_events` (migration 0074), `support_tickets`
-- (migration 0047), `operator_inbox_messages` (migration 0175),
-- `operator_sessions` (migration 0165). The cache here exists so the
-- admin homepage can render "what each operator did most recently"
-- without walking every source on each load.
--
-- One row per `operator_id`. `last_activity_at` is the newest event
-- timestamp across every wired source the last time the cache was
-- refreshed; `recent_actions_json` is a top-N counts-by-kind blob the
-- summarize/topActions calls populate; `computed_at` is the per-
-- factory monotonic stamp the freshness gate consults.
--
-- The cache is deliberately optional — operatorActivityFeed.recompute
-- IS NOT exposed as a public method; the cache is populated only as a
-- memoization side-effect of summarizeForOperator. The feed
-- methods (forOperator / teamFeed / topActions) always walk the live
-- sources; the cache is just a fast-path for the homepage strip.
--
-- One index on (last_activity_at DESC) drives the admin-homepage
-- "operators sorted by recent activity" sweep.

CREATE TABLE IF NOT EXISTS operator_activity_cache (
  operator_id          TEXT    NOT NULL PRIMARY KEY,
  last_activity_at     INTEGER NOT NULL,
  recent_actions_json  TEXT    NOT NULL DEFAULT '{}',
  computed_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_activity_cache_last_activity
  ON operator_activity_cache(last_activity_at DESC);
