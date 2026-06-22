-- inventory_adjustments idempotency key + atomic keyed credit
--
-- A keyed idempotency column for stock credits that are one step of a larger
-- non-transactional flow (stock-transfer reconciliation, and future callers
-- that credit a shelf as part of a multi-statement operation). D1 has no
-- interactive transactions, so a hand-rolled "apply the credit" then "record
-- that it was applied" would always leave a single-statement gap to crash
-- through. This migration closes the gap by making the credit and its
-- idempotency record ONE atomic statement: the keyed audit-row INSERT carries
-- an AFTER INSERT trigger that upserts the shelf in the same statement.
--
-- The column is nullable: every existing audit row, and every credit/debit
-- that is already atomic on its own (plain adjustStock / setStock), leaves it
-- NULL. SQLite/D1 treats NULLs as distinct in a UNIQUE index, so the index
-- below enforces single-application only on the keyed rows while letting any
-- number of un-keyed rows coexist.
ALTER TABLE inventory_adjustments ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_adjustments_idempotency_key
  ON inventory_adjustments(idempotency_key);

-- Atomic keyed credit. Fires only for keyed rows (idempotency_key NOT NULL),
-- so plain adjustStock / transferStock audit rows (NULL key, already upserted
-- in application code) are untouched. A replay re-presenting the same key hits
-- the unique index, inserts nothing, and never reaches this trigger — so the
-- shelf is credited exactly once. Because the trigger runs inside the INSERT
-- statement, the credit and the key commit or roll back together: there is no
-- window in which the key is durable but the stock was not credited.
CREATE TRIGGER IF NOT EXISTS trg_inventory_adjustments_keyed_credit
AFTER INSERT ON inventory_adjustments
WHEN NEW.idempotency_key IS NOT NULL
BEGIN
  INSERT INTO inventory_stock (sku, location_code, quantity, updated_at)
  VALUES (NEW.sku, NEW.location_code, NEW.delta, NEW.occurred_at)
  ON CONFLICT(sku, location_code) DO UPDATE SET
    quantity = quantity + NEW.delta,
    updated_at = NEW.occurred_at;
END;
