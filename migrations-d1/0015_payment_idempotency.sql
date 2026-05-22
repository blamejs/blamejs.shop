-- Payment idempotency cache.
--
-- Stripe holds idempotency keys for 24 hours; the local row mirrors
-- that window so a replayed mutating call (createPaymentIntent /
-- refund / subscriptions.create / .update / .cancel) returns the
-- stored Stripe response verbatim without re-hitting Stripe. The row
-- carries the SHA3-512 hash of the canonicalised input body so a
-- replay with the SAME key but a DIFFERENT body is detected as a
-- collision and refused at the application layer — silently returning
-- the stored response would let a caller (or an attacker who learned
-- a previously-used key) replay a different amount.
--
-- Cleanup is operator-driven: payment.cleanupExpired() purges rows
-- where expires_at < now. Run on a schedule (daily is fine — the
-- table is small and unindexed deletes scan the whole expired tail
-- in one pass).

CREATE TABLE IF NOT EXISTS payment_idempotency (
  idempotency_key   TEXT    NOT NULL PRIMARY KEY,
  operation         TEXT    NOT NULL CHECK (operation IN (
                              'payment_intent.create',
                              'refund.create',
                              'subscription.create',
                              'subscription.update',
                              'subscription.cancel'
                            )),
  request_hash      TEXT    NOT NULL,
  response_status   INTEGER NOT NULL,
  response_body     TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_idempotency_op_created
  ON payment_idempotency(operation, created_at);
