-- Inventory snapshots: point-in-time inventory captures for audit
-- and reconciliation.
--
-- An operator running on a multi-location inventory still has to
-- answer questions that span time: "what did stock look like at
-- close of business yesterday?", "did we lose units between the
-- monthly cycle count and today?", "which SKU had the largest
-- swing across the holiday weekend?" A live read against the
-- catalog `inventory` table (or the per-location `inventory_stock`
-- table) only answers "right now." A snapshot pins a copy of the
-- per-(sku, location_code) counts at a chosen moment so the next
-- snapshot can be compared against it row-by-row.
--
-- Schema decisions:
--   * `inventory_snapshots.id` is a v7 UUID (millisecond-prefixed,
--     lexicographically sortable — B-tree-locality wins on the PK).
--   * `label` is operator-supplied free text (e.g. "EOM-2026-05",
--     "post-holiday cycle count"). Not unique — operators
--     occasionally re-take a snapshot under the same label after a
--     reconciliation; the id stays unique and the label is just a
--     human handle.
--   * `taken_at` is the snapshot's wall-clock moment (epoch ms).
--     Indexed DESC so `listSnapshots` returns latest-first without
--     a sort step. `purgeOlderThan(days)` deletes by this column.
--   * `reason` captures why the operator took the snapshot
--     ("EOM close", "pre-migration baseline", "post-incident
--     reconciliation"). Capped at 4000 chars at the application
--     layer; column is unbounded TEXT.
--   * `sku_count` / `location_count` / `total_units` are cached
--     aggregates set at takeSnapshot time so list / summary
--     views don't have to re-aggregate the row table.
--   * `hash_sha3_512` is a hex-encoded SHA3-512 digest of the
--     canonical newline-joined `<sku>|<location_or_->|<qty>` lines.
--     It's tamper-evident: any post-hoc edit to inventory_snapshot_rows
--     re-computes to a different hash, and the summary verb compares
--     the stored hash against a fresh re-compute on demand.
--
--   * `inventory_snapshot_rows.snapshot_id` is FK CASCADE so deleting
--     the parent snapshot (purgeOlderThan / explicit DELETE) drops
--     every row with it.
--   * `location_code` is NULLABLE because operators that haven't
--     wired the inventory-locations primitive only have the catalog
--     single-bucket `stock_on_hand`; that row stores location_code
--     = NULL to mean "no per-location detail captured."
--   * The composite index on (snapshot_id, sku, location_code)
--     gives `deltaBetween` and per-snapshot reads an indexed scan
--     instead of a full-row sequential walk.
--   * The (sku, taken_at DESC) index lets an operator ask "show me
--     the last 10 snapshot counts for SKU X" without scanning the
--     whole row table.

CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id              TEXT NOT NULL PRIMARY KEY,
  label           TEXT NOT NULL DEFAULT '',
  taken_at        INTEGER NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  sku_count       INTEGER NOT NULL DEFAULT 0 CHECK (sku_count >= 0),
  location_count  INTEGER NOT NULL DEFAULT 0 CHECK (location_count >= 0),
  total_units     INTEGER NOT NULL DEFAULT 0 CHECK (total_units >= 0),
  hash_sha3_512   TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_snapshot_rows (
  id             TEXT NOT NULL PRIMARY KEY,
  snapshot_id    TEXT NOT NULL,
  sku            TEXT NOT NULL,
  location_code  TEXT,
  quantity       INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  captured_at    INTEGER NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES inventory_snapshots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_taken_at        ON inventory_snapshots(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshot_rows_snap_sku_loc ON inventory_snapshot_rows(snapshot_id, sku, location_code);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshot_rows_sku_taken    ON inventory_snapshot_rows(sku);
