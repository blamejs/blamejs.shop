-- Customer impersonation — operator login-as-customer for support
-- troubleshooting, with strict audit trail and automatic timeout.
--
-- An operator with the `can_impersonate_customer` capability begins an
-- impersonation session, the primitive mints a 32-byte base64url
-- bearer (namespace-hashed at rest), and every operator action taken
-- while the session is live is captured in a sibling actions table.
-- The customer is notified out-of-band so the troubleshooting access
-- is never silent. A default 60-minute TTL caps the blast radius if
-- the operator forgets to call `endImpersonation`; the scheduler's
-- `cleanupExpired` walk flips elapsed rows to `expired` so the audit
-- column stays durable.
--
-- `impersonations` — one row per impersonation session. `token_hash`
-- is UNIQUE so the lookup on verify is a primary-key probe. `status`
-- is a four-state CHECK enum:
--   active   — session is live, operator can act as the customer
--   ended    — operator finished and called endImpersonation
--   expired  — TTL elapsed before the operator ended explicitly
--              (terminal — sweep is irrevocable; a new impersonation
--              requires a fresh startImpersonation call)
--   revoked  — operator-side kill switch (suspected misuse, customer
--              complained, etc.) — also terminal
-- `customer_notified_at` is stamped once the notifications peer has
-- enqueued the customer-side "an operator viewed your account"
-- message — distinct from `started_at` so the audit reader can spot
-- the (rare) case where notifications was down when the session
-- opened and the operator forgot to retry. `end_reason` is the short
-- free-form label captured at endImpersonation / revoke time.
--
-- `impersonation_actions` — append-only event log of every operator
-- action taken while the session was live. `resource_kind` +
-- `resource_id` identify the touched record (order, address, refund,
-- etc.); `action` is the operator-defined verb. `occurred_at` is the
-- monotonic timestamp. The CASCADE delete on `impersonation_id` is
-- belt-and-braces — impersonation rows themselves are never deleted
-- in production, but a hand-replayed test environment that drops a
-- row should not leave orphaned action records.
--
-- Indexes:
--   * `(operator_id, status, started_at)` — `listForOperator` reads.
--   * `(customer_id, started_at)` — `listForCustomer` reads.
--   * `(status, expires_at)` — `cleanupExpired` sweep.
--   * `(impersonation_id, occurred_at)` — actions audit reader.

CREATE TABLE IF NOT EXISTS impersonations (
  id                     TEXT NOT NULL PRIMARY KEY,
  operator_id            TEXT NOT NULL,
  customer_id            TEXT NOT NULL,
  token_hash             TEXT NOT NULL UNIQUE,
  reason                 TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN (
                           'active', 'ended', 'expired', 'revoked'
                         )),
  started_at             INTEGER NOT NULL,
  ended_at               INTEGER,
  end_reason             TEXT,
  expires_at             INTEGER NOT NULL,
  customer_notified_at   INTEGER
);

CREATE TABLE IF NOT EXISTS impersonation_actions (
  id                TEXT NOT NULL PRIMARY KEY,
  impersonation_id  TEXT NOT NULL,
  action            TEXT NOT NULL,
  resource_kind     TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  occurred_at       INTEGER NOT NULL,
  FOREIGN KEY (impersonation_id) REFERENCES impersonations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_impersonations_operator_status_started
  ON impersonations(operator_id, status, started_at);

CREATE INDEX IF NOT EXISTS idx_impersonations_customer_started
  ON impersonations(customer_id, started_at);

CREATE INDEX IF NOT EXISTS idx_impersonations_status_expires
  ON impersonations(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_impersonation_actions_session_occurred
  ON impersonation_actions(impersonation_id, occurred_at);
