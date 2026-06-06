-- Per-customer session-revocation epoch — lets erasure, passkey-revoke,
-- and an explicit sign-out terminate a LIVE sealed shop_auth cookie even
-- though that cookie is stateless and self-validating for up to 14 days.
--
-- How it gates: the sealed auth cookie carries an `iat` (issued-at,
-- epoch-ms) stamped at mint. Each authenticated request reads the
-- customer's `sessions_valid_from` here; a cookie whose `iat` is strictly
-- older than that boundary (or that carries no `iat` at all, once a
-- boundary exists) is rejected and the visitor is signed out. Bumping the
-- boundary to "now" therefore invalidates every cookie minted before the
-- bump while leaving freshly-minted cookies valid.
--
-- A customer with no row here has never been revoked — the absence of a
-- row is the default-allow state, so a deploy that adds this table does
-- NOT sign anyone out. A pre-existing cookie (minted before `iat` shipped,
-- so carrying none) keeps working until its natural expiry UNLESS its
-- customer gains a revocation boundary, at which point the missing `iat`
-- can't prove the cookie postdates the boundary and the session ends.

CREATE TABLE IF NOT EXISTS customer_session_revocations (
  customer_id         TEXT NOT NULL PRIMARY KEY,
  sessions_valid_from INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
