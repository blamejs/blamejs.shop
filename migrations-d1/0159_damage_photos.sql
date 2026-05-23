-- Damage photos: operator-uploaded image attachments for damage and
-- quality-control events. Each row captures a SHA3-512 digest +
-- byte_size + content_type + signed-URL reference into operator-owned
-- object storage (R2 / S3). The image bytes themselves never land in
-- this table; the operator's CDN / object store carries those.
--
-- Subject kinds (CHECK enum) — what the photo documents:
--   writeoff             — pairs with an inventory_writeoffs row
--   return               — pairs with an order-return row
--   quality_check        — bench QC failure record
--   damaged_receipt      — receipt arrived damaged from the supplier
--   customer_complaint   — customer-supplied evidence on a complaint
--
-- The `subject_id` is opaque to this primitive — the foreign primitive
-- owns the id-shape contract. Stored as TEXT so writeoffs (UUID v7),
-- returns (order id format), and complaints (ticket id format) can all
-- coexist without a schema rev each time a new subject_kind is added.
--
-- `sha3_512` is the lowercase 128-char hex digest of the original
-- image bytes. Two uploads with the same digest are by definition the
-- same image — findDuplicatesBySha exposes this for fraud detection
-- (the same "damaged unit" photo submitted against three different
-- writeoffs is a strong shrinkage-fraud signal).
--
-- `source_url` is a signed-URL reference into the operator's object
-- store. Validated as https-only via b.safeUrl at the application
-- layer; the column itself just holds the string.
--
-- `archived_at` is the soft-delete timestamp. Archived photos drop out
-- of photosForSubject (operators don't want a stale screenshot showing
-- in the active evidence list) but remain in findDuplicatesBySha (the
-- fraud signal survives archival).
--
-- `replaced_by_id` + `replaced_at` + `replace_reason` form a replace-
-- chain: when an operator notices the uploaded photo was the wrong
-- one, replacePhoto mints a new row and flags the old one as superseded
-- without losing the audit trail.
--
-- Indexes:
--   * (subject_kind, subject_id, archived_at) — photosForSubject + the
--     metricsForKind aggregate are the hot read paths
--   * (sha3_512) — findDuplicatesBySha fraud lookup
--   * (occurred_at) — metricsForKind period scan

CREATE TABLE IF NOT EXISTS damage_photos (
  id                  TEXT NOT NULL PRIMARY KEY,
  subject_kind        TEXT NOT NULL CHECK (subject_kind IN (
                        'writeoff', 'return', 'quality_check',
                        'damaged_receipt', 'customer_complaint'
                      )),
  subject_id          TEXT NOT NULL,
  content_type        TEXT NOT NULL,
  sha3_512            TEXT NOT NULL,
  byte_size           INTEGER NOT NULL,
  source_url          TEXT NOT NULL,
  caption             TEXT,
  uploaded_by         TEXT NOT NULL,
  archived_at         INTEGER,
  archive_reason      TEXT,
  replaced_by_id      TEXT,
  replaced_at         INTEGER,
  replace_reason      TEXT,
  occurred_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_damage_photos_subject
  ON damage_photos(subject_kind, subject_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_damage_photos_sha3
  ON damage_photos(sha3_512);
CREATE INDEX IF NOT EXISTS idx_damage_photos_occurred_at
  ON damage_photos(occurred_at);
