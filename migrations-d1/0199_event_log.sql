-- Event log — universal append-only application event stream.
--
-- Distinct from the other event-flavoured tables in the schema:
--
--   analytics (0014)              — customer behavioural events (page
--                                   views, add-to-cart, etc.). Customer-
--                                   indexed, sample-able, retention-
--                                   bounded.
--   operator_audit_events (0074)  — cryptographically chained record
--                                   of operator mutations (admin
--                                   console actions, price overrides,
--                                   refunds). Tamper-evident.
--   error_log (0064)              — HTTP 4xx/5xx response events.
--                                   Request-lifecycle-only, hashed
--                                   session, percentile maths.
--
-- `event_log` is the cross-cutting application event stream: a domain
-- event publisher landed; a background job dispatched / completed;
-- a cache invalidated; a webhook arrived; a feature flag flipped; a
-- secret rotated. The dimensions an operator searches on are
-- consistent across every callsite — `kind` (the event vocabulary),
-- `subject_kind` + `subject_id` (the noun the event acted on),
-- `actor_kind` + `actor_id` (who or what produced the event), and
-- `severity` (debug/info/warning/critical, four-rung CHECK).
--
-- `payload_json` is an optional opaque blob the producer attaches for
-- post-hoc forensics. It's never indexed — every queryable dimension
-- is its own column so the read paths stay deterministic.
--
-- Indexes:
--   * (kind, occurred_at DESC) — every per-kind feed + `topKinds`
--     aggregator. The DESC suffix matches the newest-first scan the
--     query method ships.
--   * (subject_kind, subject_id, occurred_at DESC) — "what happened
--     to subject X" trace. The product/order/customer dashboards walk
--     this index when rendering the per-resource event strip.
--   * (actor_id, occurred_at DESC) — "what did actor Y do" trace.
--     Operator-debugging the storefront uses this to scope a session
--     replay to a single source.
--   * (severity, occurred_at DESC) — severity filter for the
--     operator alerting dashboard. Critical-only rollups read this
--     index directly.
--   * (occurred_at) — `purgeOlderThan` retention sweep + cross-kind
--     time-window scans that don't pin a single kind/subject/actor.

CREATE TABLE IF NOT EXISTS event_log (
  id                  TEXT NOT NULL PRIMARY KEY,
  kind                TEXT NOT NULL,
  subject_kind        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  actor_kind          TEXT,
  actor_id            TEXT,
  payload_json        TEXT,
  severity            TEXT NOT NULL CHECK (severity IN (
                          'debug', 'info', 'warning', 'critical'
                       )),
  source              TEXT,
  occurred_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_log_kind_time
  ON event_log(kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_subject_time
  ON event_log(subject_kind, subject_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_actor_time
  ON event_log(actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_severity_time
  ON event_log(severity, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_time
  ON event_log(occurred_at);
