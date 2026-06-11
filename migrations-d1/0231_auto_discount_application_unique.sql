-- One application row per (rule, order) — the idempotency backbone for
-- redemption recording and the pre-charge claim's retry-reuse semantics.
-- De-duplicate first so the index can build on a table that accumulated
-- doubles under the previous unconditional insert (keep the earliest row;
-- the counter the duplicates inflated is reconcilable from the rows).
DELETE FROM auto_discount_applications
 WHERE id NOT IN (
   SELECT MIN(id) FROM auto_discount_applications GROUP BY rule_slug, order_id
 );
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_discount_apps_rule_order
  ON auto_discount_applications(rule_slug, order_id);
