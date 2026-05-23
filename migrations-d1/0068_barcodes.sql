-- Barcodes: map SKUs to scannable identifier values (UPC-A, EAN-13,
-- Code-128, GTIN-14) for printable label / receipt / packing-slip use.
--
-- `barcode_assignments` is the SKU -> (kind, value) binding table.
-- One SKU can hold multiple bindings (a product may carry a retail
-- UPC-A on the consumer pack and a GTIN-14 on the outer case), but
-- the (kind, value) pair is globally unique — two SKUs cannot share
-- a barcode value within the same kind. The CHECK on `kind`
-- enforces the closed enum at the storage tier so a typo never
-- silently splits the index.
--
-- `barcode_ranges` is the operator-allocated value pool used by
-- assignAuto. A range owns a contiguous span of digits below a
-- shared prefix (e.g. EAN-13 GS1 company prefix + item-reference
-- block). `next_value` is the running counter; the auto-mint verb
-- reads it, computes the checksum, writes the assignment, and
-- increments. `max_value` is the inclusive upper bound — auto-mint
-- refuses (and the operator must allocate another range) once
-- `next_value > max_value`. `owner_company` is the optional GS1
-- company-prefix string for operator-side identification; the
-- primitive itself doesn't validate it against any registry.

CREATE TABLE IF NOT EXISTS barcode_assignments (
  id             TEXT NOT NULL PRIMARY KEY,
  sku            TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('upc_a', 'ean_13', 'code_128', 'gtin_14')),
  value          TEXT NOT NULL,
  assigned_at    INTEGER NOT NULL,
  UNIQUE (kind, value)
);

CREATE INDEX IF NOT EXISTS idx_barcode_assignments_sku       ON barcode_assignments(sku);
CREATE INDEX IF NOT EXISTS idx_barcode_assignments_kind_val  ON barcode_assignments(kind, value);

CREATE TABLE IF NOT EXISTS barcode_ranges (
  id             TEXT NOT NULL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('upc_a', 'ean_13', 'code_128', 'gtin_14')),
  prefix         TEXT NOT NULL,
  next_value     INTEGER NOT NULL CHECK (next_value >= 0),
  max_value      INTEGER NOT NULL CHECK (max_value >= 0),
  owner_company  TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_barcode_ranges_kind_next ON barcode_ranges(kind, next_value);
