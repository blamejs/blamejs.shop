-- Operator audit-chain checkpoint anchors.
--
-- The operator_audit_events chain (0074) is hash-linked but NOT signed:
-- every row carries prev_hash + row_hash, so `verifyChain` catches a
-- single edited or deleted row. But the linkage is only as strong as the
-- hash function is collision-resistant AGAINST AN EDITOR WHO CAN REWRITE
-- THE WHOLE TABLE — an attacker with write access can re-hash every row
-- from a forged genesis and the chain stays internally consistent. A
-- full-chain rewrite is then undetectable.
--
-- These checkpoints anchor the chain tip out-of-band. Periodically the
-- operator chain's head row_hash is signed with the framework's
-- post-quantum audit-signing key (b.auditSign — SLH-DSA-SHAKE-256f by
-- default), the same key the framework's own audit chain checkpoints
-- with. The private key lives only in the sealed audit-sign keyfile, NOT
-- in the database, so an attacker with D1 write access can rewrite the
-- chain but CANNOT forge a checkpoint signature over the rewritten tip —
-- `verifyCheckpoints` then surfaces the mismatch.
--
--   signature = auditSign.sign(
--     "blamejs-operator-audit-checkpoint-v1\n" ||
--     at_row_id          \n ||
--     at_occurred_at      \n ||
--     at_row_hash         \n ||
--     created_at
--   )
--
-- `at_row_hash` pins the anchored tip; `public_key_fingerprint` records
-- which signing key produced the signature so a key rotation is visible
-- (a checkpoint signed under an old fingerprint is reported by the verify
-- path rather than silently failing). One row per checkpoint; the verify
-- path walks them oldest-first and re-derives each signature.

CREATE TABLE IF NOT EXISTS operator_audit_checkpoints (
  id                     TEXT NOT NULL PRIMARY KEY,
  created_at             INTEGER NOT NULL,
  at_row_id              TEXT NOT NULL,
  at_occurred_at         INTEGER NOT NULL,
  at_row_hash            TEXT NOT NULL,
  signature              TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_checkpoints_created_at
  ON operator_audit_checkpoints(created_at ASC);
