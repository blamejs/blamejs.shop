-- Operator (staff) login sessions — the cookie-bearing session that
-- represents a logged-in admin/support/fulfillment user inside the
-- operator console.
--
-- Distinct from `customer_portal_sessions` (migration 0072), which is
-- the customer-facing self-serve link. THIS table represents an
-- authenticated STAFF session: the operator finished a primary-credential
-- challenge (and, depending on role policy, an MFA step), and the row
-- here is the durable handle that the console's session middleware
-- validates on every subsequent request until logout / expiry / revoke.
--
-- Threat model + schema decisions:
--
--   * `token_hash` is the lookup key. The plaintext bearer is a
--     32-byte CSPRNG draw hashed via
--     `namespaceHash("operator-session-token", plaintext)`. A database
--     dump never carries live bearers — every row stores only the hash.
--     UNIQUE is explicit so a future PK swap preserves the invariant.
--
--   * `ip_hash` is REQUIRED at create time and is checked on every
--     `verifyToken`. The staff session is bound to the originating IP
--     hash; a presentation from a different IP hash misses. This is
--     deliberately stricter than the customer portal (which treats
--     `ip_hash` as advisory) — staff sessions defend access to
--     pricing / customer PII / order history, so a stolen cookie that
--     leaves the operator's network is refused.
--
--   * `status` is the FSM column. Five terminal values:
--       issued       — fresh, redeemable, not yet expired, MFA may
--                      still be required (see `mfa_required` +
--                      `mfa_verified_at`)
--       active       — verifyToken has flipped the row out of `issued`
--                      on the first successful presentation (and the
--                      MFA gate has been satisfied if required); the
--                      cookie is now a live operator session bearer
--       expired      — the scheduler `expireOlderThan` walk stamped
--                      this; lazy gate. Operators who never run the
--                      scheduler see issued/active rows past their ttl
--                      and rely on the `expires_at` runtime check in
--                      verifyToken — the status column is the durable
--                      record for audit, not the live gate.
--       revoked      — operator-initiated kill via `revokeSession`
--                      (logout, password reset, "we think this account
--                      is compromised") OR auto-revoked by
--                      lockoutCheck threshold trip
--       locked_out   — recorded by lockoutCheck when the per-IP failed-
--                      verify counter trips threshold; verify on a
--                      locked-out row refuses
--
--   * `mfa_required` (boolean, stored as 0/1) — set by the create call
--     based on the operator's role policy. When 1, the session reaches
--     `active` only AFTER `recordMfaVerification(session_id)` flips
--     `mfa_verified_at` from NULL → ts. `verifyToken` refuses with a
--     `requires_mfa: true` shape until that flip happens. When 0, the
--     session jumps straight to `active` on the first successful
--     verify.
--
--   * `mfa_verified_at` is the stamp recording when MFA was satisfied.
--     Nullable until the step-up happens; non-null forevermore once
--     stamped.
--
--   * `ttl_seconds` defaults to 8 hours (28_800). Staff working a full
--     shift do not have to re-authenticate mid-day; the 8h ceiling is
--     short enough that an unattended console session lapses overnight.
--
--   * Three indexes:
--       (operator_id, created_at desc) — `listForOperator` pagination.
--       (status, expires_at)           — scheduler `expireOlderThan`
--                                        walk + "show me every live
--                                        active session" audit reads.
--       (operator_id, status)          — quick check "does this
--                                        operator have ANY live
--                                        session right now?"
--
-- Companion table `operator_failed_logins` records per-IP failed-
-- verify events for the lockoutCheck primitive. The lockout threshold
-- is enforced application-side via `lockoutCheck(ip_hash)` reading the
-- last N minutes of rows here; the DB stores the raw events so an
-- auditor can reconstruct the timeline.

CREATE TABLE IF NOT EXISTS operator_sessions (
  id                TEXT    NOT NULL PRIMARY KEY,
  operator_id       TEXT    NOT NULL,
  token_hash        TEXT    NOT NULL UNIQUE,
  ip_hash           TEXT    NOT NULL,
  ua_class          TEXT,
  status            TEXT    NOT NULL CHECK (status IN (
                      'issued',
                      'active',
                      'expired',
                      'revoked',
                      'locked_out'
                    )),
  mfa_required      INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required IN (0, 1)),
  mfa_verified_at   INTEGER,
  activated_at      INTEGER,
  revoked_at        INTEGER,
  revoke_reason     TEXT,
  ttl_seconds       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator
  ON operator_sessions(operator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_status_expiry
  ON operator_sessions(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator_status
  ON operator_sessions(operator_id, status);

CREATE TABLE IF NOT EXISTS operator_failed_logins (
  id              TEXT    NOT NULL PRIMARY KEY,
  ip_hash         TEXT    NOT NULL,
  operator_id     TEXT,
  reason          TEXT    NOT NULL,
  occurred_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_failed_logins_ip
  ON operator_failed_logins(ip_hash, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_failed_logins_operator
  ON operator_failed_logins(operator_id, occurred_at DESC)
  WHERE operator_id IS NOT NULL;
