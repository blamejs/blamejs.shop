-- inventory_adjustments idempotency key
--
-- A keyed idempotency column for stock credits that are one step of a larger
-- non-transactional flow (stock-transfer reconciliation, and future callers
-- that credit a shelf as part of a multi-statement operation). The keyed
-- credit verb (inventoryLocations.creditOnce) writes this audit row as its
-- claim: a retry that re-presents the same key inserts nothing and credits
-- nothing, so the shelf is never double-credited.
--
-- The column is nullable: every existing audit row, and every credit/debit
-- that is already atomic on its own (plain adjustStock / setStock), leaves it
-- NULL. SQLite/D1 treats NULLs as distinct in a UNIQUE index, so the index
-- below enforces single-application only on the keyed rows while letting any
-- number of un-keyed rows coexist.
ALTER TABLE inventory_adjustments ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_adjustments_idempotency_key
  ON inventory_adjustments(idempotency_key);
