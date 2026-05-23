-- Operator audit log — WHO did WHAT to WHICH resource WHEN, on the
-- operator side of the storefront. Distinct from `b.audit` (the
-- framework's lower-level audit log of cryptographic events, security
-- transitions, and admin authentication) and from `analytics` (the
-- customer-side behavioural event stream).
--
-- Surface this table covers:
--
--   * Admin console mutations — operator A edited product X's title,
--     operator B paused promotion Y, operator C changed a tax rate.
--   * Support-ticket state changes — assignee, status, resolution
--     edits made through the agent console.
--   * Price / discount overrides — manual price adjustments on a
--     specific order, one-off coupons applied by an agent.
--   * Manual refunds + manual order-state edits — actions that bypass
--     the storefront's automated paths and need an operator trail.
--   * System / app actor entries — automated jobs that act with
--     elevated privileges (e.g. the nightly subscription-billing
--     runner) still log into this table so the operator can audit
--     "who ran this and when" even when "who" is a machine actor.
--
-- Cryptographic chaining:
--
--   The events table is tamper-evident through a SHA3-512 row hash
--   chain. Every row stores
--
--     prev_hash = previous row's row_hash (ZERO sentinel for first row)
--     row_hash  = SHA3-512(prev_hash || canonical-json(row-without-hashes))
--
--   `canonical-json` is the framework's RFC 8785 walker (sorted keys,
--   stable number formatting, exclusion of the hash columns themselves)
--   so the preimage is byte-identical across deployments. `verifyChain`
--   walks the table in `(occurred_at, id)` order, recomputing each
--   row's expected hash and flagging the first mismatch — any post-hoc
--   edit to a recorded row (or a deletion that breaks the chain
--   linkage) surfaces as a `{ ok: false, reason, break_at, ... }`
--   verdict. The chain is intentionally NOT signed at the row level —
--   sign-the-chain-head workflows live on top, not inside the primitive.
--
-- Enum decisions:
--
--   * `actor_type` is one of `operator` / `system` / `app`. `operator`
--     covers a human acting through the admin console; `system` covers
--     a privileged-job runner (subscription billing, cron); `app`
--     covers an API-key call routed through `b.apiKeys`.
--   * `ua_class` is the bot-guard's classification of the request that
--     drove the action — a small closed set so operators can filter
--     "every action that came from a known-good admin browser" vs
--     "every action that came from an API client". The column is
--     nullable for system-actor entries that have no request context.
--
-- Indexes:
--
--   * `(occurred_at DESC)` — global "what happened last 24h" feed.
--   * `(actor_id, occurred_at DESC)` — per-actor audit trail.
--   * `(resource_kind, resource_id, occurred_at DESC)` — per-resource
--     history (e.g. "show me every change to product X").
--   * `(action, occurred_at)` — action-specific searches (e.g. "every
--     manual refund issued this month").
--
-- Append-only by convention. The primitive offers no `delete` /
-- `update` surface; operators carrying a retention policy archive +
-- truncate at the SQL layer with an explicit migration, which leaves
-- a single break point that `verifyChain` reports.

CREATE TABLE IF NOT EXISTS operator_audit_events (
  id              TEXT NOT NULL PRIMARY KEY,
  actor_type      TEXT NOT NULL CHECK (actor_type IN (
                    'operator',
                    'system',
                    'app'
                  )),
  actor_id        TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_kind   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  before_json     TEXT,
  after_json      TEXT,
  ip_hash         TEXT,
  ua_class        TEXT CHECK (ua_class IS NULL OR ua_class IN (
                    'browser',
                    'mobile_app',
                    'api_client',
                    'cli',
                    'bot',
                    'unknown'
                  )),
  occurred_at     INTEGER NOT NULL,
  prev_hash       TEXT NOT NULL,
  row_hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_events_occurred_at
  ON operator_audit_events(occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_audit_events_actor
  ON operator_audit_events(actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_audit_events_resource
  ON operator_audit_events(resource_kind, resource_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_audit_events_action
  ON operator_audit_events(action, occurred_at);
