-- Captured failure detail on the error log, so a server-side 5xx-class
-- error is readable from the operator console + the admin JSON API
-- rather than only from the container's local stdout.
--
-- `lib/error-log.js` already records HTTP-response metadata (status /
-- path / method / UA class) for broken-link triage and slow-render
-- alerting, but it carried no column for the EXCEPTION TEXT a failing
-- request produced. Without one, a checkout-confirm 500 (and every
-- other catch that scrubs its detail before responding) sent the
-- message only to the framework audit sink, which lives in the
-- container's local data dir — invisible to `wrangler tail` and to any
-- CLI/tooling pulling errors over HTTP.
--
--   * `message` is the scrubbed, length-bounded error string the catch
--     would otherwise have lost. NULL on every pre-existing row and on
--     the response-metadata rows the request lifecycle records — only
--     the server-error capture path writes it, so a partial index on
--     `message IS NOT NULL` isolates the captured-error feed from the
--     high-volume 404/observability rows.
--
-- Ring-buffer retention: the capture path keeps only the newest N
-- message-bearing rows (older captures are deleted on write), so the
-- feed is self-trimming and never unbounded. The partial index below
-- backs both the newest-first console scan and that trim's
-- "rows beyond the cap" subquery.

ALTER TABLE error_log ADD COLUMN message TEXT;

-- Newest-first scan over the captured-error feed + the retention trim.
-- Partial (message IS NOT NULL) so it indexes only the captured-error
-- rows, not the high-volume response-metadata rows.
CREATE INDEX IF NOT EXISTS idx_error_log_message_time
  ON error_log(occurred_at DESC, id DESC)
  WHERE message IS NOT NULL;
