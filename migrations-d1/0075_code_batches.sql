-- Code batches: bulk-minted single-use discount codes for campaigns.
--
-- `code_batches` holds one row per operator-issued mint run. The
-- batch records the alphabet / length / prefix / suffix used at mint
-- time so the operator can re-derive the rendered code from a member
-- row without consulting a separate config surface. `count` is the
-- post-mint actual code count (collision retries may have caused the
-- minter to fall short of the requested target — the truth that
-- ships is what's in `code_batch_members`).
--
-- `status` CHECK enumerates the three terminal/operating states:
--   - 'active'    — the batch is live; coupons backing the codes
--                   accept redemption (the coupons primitive owns the
--                   redemption tier).
--   - 'voided'    — operator voided the batch; every backing coupon
--                   was archived in the same call. `void_reason` and
--                   `voided_at` capture the audit pair.
--   - 'exhausted' — every code in the batch has been redeemed. The
--                   minter does not flip this state itself (that's a
--                   coupons-side observation); the column exists so
--                   an operator dashboard query can record the
--                   transition without a schema migration.
--
-- `code_batch_members` is the per-code row. The FK to `code_batches`
-- with ON DELETE CASCADE means a `DELETE FROM code_batches WHERE id =
-- ?` removes every member row in the same statement — useful for
-- operator-side garbage collection of a voided + archived batch.
-- `coupon_code` is UNIQUE across the whole table so two batches
-- minting under the same alphabet can never alias to the same coupon
-- code (a collision would surface as a unique-violation at insert
-- time, which the minter catches and retries).

CREATE TABLE IF NOT EXISTS code_batches (
  id            TEXT NOT NULL PRIMARY KEY,
  label         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'voided', 'exhausted')),
  count         INTEGER NOT NULL CHECK (count >= 0),
  prefix        TEXT NOT NULL DEFAULT '',
  suffix        TEXT NOT NULL DEFAULT '',
  alphabet      TEXT NOT NULL,
  length        INTEGER NOT NULL CHECK (length > 0),
  void_reason   TEXT,
  created_at    INTEGER NOT NULL,
  voided_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_code_batches_status     ON code_batches(status);
CREATE INDEX IF NOT EXISTS idx_code_batches_created_at ON code_batches(created_at);

CREATE TABLE IF NOT EXISTS code_batch_members (
  id            TEXT NOT NULL PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES code_batches(id) ON DELETE CASCADE,
  coupon_code   TEXT NOT NULL UNIQUE,
  minted_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_batch_members_batch_id ON code_batch_members(batch_id, minted_at);
CREATE INDEX IF NOT EXISTS idx_code_batch_members_code     ON code_batch_members(coupon_code);
