-- Customer merge — operator-driven deduplication of customer
-- accounts. Same person, two registrations (different email
-- addresses, different passkeys, registered at different points
-- in the customer's lifetime). The operator picks a canonical
-- (target) customer and the duplicate (source); a merge plan is
-- proposed (dry-run shows affected row counts per primitive);
-- once executed, every order / subscription / loyalty-ledger
-- entry / review / address / payment-method that referenced the
-- source is reparented onto the target. The source customer row
-- is soft-archived and a redirect marker is recorded so any later
-- lookup of the source id transparently resolves to the target.
--
-- Two tables:
--
--   customer_merges          — the merge event itself. One row per
--     proposed/executed/rolled_back/cancelled merge. `plan_json` is
--     the structured affected-row count snapshot captured at
--     proposeMerge time; it's frozen on executeMerge so a rollback
--     within the 7-day window has the exact reparent footprint to
--     reverse. `status` is the FSM-visible flag:
--
--       proposed     — dry-run plan recorded; no rows reparented
--       executed     — reparent committed; redirect marker live
--       rolled_back  — reparent reversed; redirect cleared
--       cancelled    — proposed plan dropped without ever executing
--
--     `executed_at`, `executed_by`, `rolled_back_at`, `rollback_reason`,
--     `cancelled_at`, `cancel_reason` are all nullable — they're
--     stamped on the corresponding transition. `requested_by` is
--     the operator who proposed the merge (audit trail); separate
--     from `executed_by` so a four-eyes workflow (operator A
--     proposes, operator B executes) is observable.
--
--   customer_merge_redirects — `source_customer_id` (the merged-
--     from id) -> `target_customer_id` (the canonical id).
--     PRIMARY KEY on source_customer_id so every source id resolves
--     to exactly one target. `executed_at` carries the redirect
--     creation timestamp; rollback within the 7-day window deletes
--     the row outright (the source customer is un-archived in the
--     same transaction). After 7 days the redirect is permanent —
--     rollback refuses past the window.

CREATE TABLE IF NOT EXISTS customer_merges (
  id                       TEXT NOT NULL PRIMARY KEY,
  source_customer_id       TEXT NOT NULL,
  target_customer_id       TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('proposed', 'executed', 'rolled_back', 'cancelled')),
  plan_json                TEXT NOT NULL,
  requested_by             TEXT NOT NULL,
  executed_at              INTEGER,
  executed_by              TEXT,
  rolled_back_at           INTEGER,
  rollback_reason          TEXT,
  cancelled_at             INTEGER,
  cancel_reason            TEXT,
  created_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_merges_source
  ON customer_merges(source_customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_merges_target
  ON customer_merges(target_customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_merges_status_created
  ON customer_merges(status, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_merge_redirects (
  source_customer_id       TEXT NOT NULL PRIMARY KEY,
  target_customer_id       TEXT NOT NULL,
  merge_id                 TEXT NOT NULL,
  executed_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_merge_redirects_target
  ON customer_merge_redirects(target_customer_id);
