-- Clickstream — server-side page-event capture for storefront pages.
-- Distinct from `analytics_events` (0019_analytics_events.sql): that
-- table carries the operator-relevant funnel signal (PDP view, cart
-- add, checkout start/complete, search query). `clickstream_*`
-- captures the explicit page-event layer underneath — every page view
-- + click + form submit + scroll-depth + video-engagement + dwell
-- record an operator would otherwise need a third-party JS tag for.
--
-- Two tables, both written from the request lifecycle (page render
-- side and form/fetch handler side):
--
--   * `clickstream_pageviews` — one row per server-rendered page
--     response. The application calls `recordPageView` from the page
--     handler with the session-cookie value (hashed at the write site
--     under namespace `clickstream-session`) + the request path +
--     referrer + a coarse UA class (`desktop` / `mobile` / `tablet` /
--     `bot` / `other`). `customer_id_hash` is optional — present when
--     the request is authenticated. `occurred_at` defaults to the
--     write-site clock but can be operator-supplied for backfills /
--     batch ingestion from a queue.
--
--   * `clickstream_events` — one row per intra-page event. `kind` is
--     a CHECK-constrained enum:
--       * `click` / `form_submit` / `form_abandon` — explicit UI
--         interactions captured by the form handler or a stable
--         client-bridge endpoint (the client posts a beacon, the
--         server validates + records — no third-party JS required).
--       * `video_play` / `video_complete` — media engagement
--         milestones; `payload_json` carries the source/asset id.
--       * `scroll_depth` — coarse milestones the client beacons at
--         (25 / 50 / 75 / 100); `payload_json.depth` carries the
--         integer percent.
--       * `dwell` — explicit time-on-page sample posted on unload /
--         visibility-change; `payload_json.ms` carries the millisecond
--         duration. The primitive uses this for `dwellByPage` p95.
--     `element` is a short CSS-selector-ish opaque token (operator
--     decides — a `data-track` attribute, `nav-cart-link`, etc.).
--     `payload_json` is the JSON-encoded operator payload (bounded
--     at the write site so a runaway client can't bloat the row).
--
-- PII posture mirrors `analytics_events`: `session_id` and
-- `customer_id` are SHA3-512 namespace-hashed before the row reaches
-- the database. The primitive refuses raw email / IP shapes at every
-- write entry point (see lib/clickstream.js `_refuseRawPii`). The
-- `path` / `page_path` columns are application-internal URLs (no
-- query string; the primitive strips it at the write site) so PII in
-- query parameters never reaches the table.
--
-- Indexes drive the seven read paths the primitive exposes:
--   * (path, occurred_at)              — topPages window aggregate
--   * (session_id_hash, occurred_at)   — sessionPath timeline
--   * (occurred_at)                    — bouncerate / dwellByPage
--                                        window without a path
--                                        predicate
--   * (page_path, kind, occurred_at)   — topClicks per-page + funnel
--   * (kind, occurred_at)              — kind-scoped rollups
--   * (session_id_hash on events)      — sessionPath timeline cross-
--                                        table join

CREATE TABLE IF NOT EXISTS clickstream_pageviews (
  id                TEXT    NOT NULL PRIMARY KEY,
  session_id_hash   TEXT    NOT NULL,
  path              TEXT    NOT NULL,
  referrer          TEXT,
  ua_class          TEXT    NOT NULL CHECK (ua_class IN ('desktop', 'mobile', 'tablet', 'bot', 'other')),
  customer_id_hash  TEXT,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clickstream_pageviews_path     ON clickstream_pageviews(path, occurred_at);
CREATE INDEX IF NOT EXISTS idx_clickstream_pageviews_session  ON clickstream_pageviews(session_id_hash, occurred_at);
CREATE INDEX IF NOT EXISTS idx_clickstream_pageviews_time     ON clickstream_pageviews(occurred_at);
CREATE INDEX IF NOT EXISTS idx_clickstream_pageviews_customer ON clickstream_pageviews(customer_id_hash, occurred_at);

CREATE TABLE IF NOT EXISTS clickstream_events (
  id                TEXT    NOT NULL PRIMARY KEY,
  session_id_hash   TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN (
    'click', 'form_submit', 'form_abandon',
    'video_play', 'video_complete',
    'scroll_depth', 'dwell'
  )),
  element           TEXT,
  payload_json      TEXT    NOT NULL DEFAULT '{}',
  page_path         TEXT    NOT NULL,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clickstream_events_session  ON clickstream_events(session_id_hash, occurred_at);
CREATE INDEX IF NOT EXISTS idx_clickstream_events_page     ON clickstream_events(page_path, kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_clickstream_events_kind     ON clickstream_events(kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_clickstream_events_time     ON clickstream_events(occurred_at);
