-- webhook DLQ: one dead-letter row per original delivery.
--
-- A delivery moves to webhook_dlq once after its attempts reach the
-- max. Before this constraint, manually retrying an already-exhausted
-- delivery re-ran the failure path and inserted a FRESH webhook_dlq row
-- on every click — duplicate dead-letter rows for the same delivery,
-- and the original delivery's `attempts` climbing past the max. The
-- retry path now refuses to re-attempt an exhausted delivery, and the
-- DLQ insert is existence-guarded; this UNIQUE is the schema-level
-- backstop so a duplicate dead-letter row can't land even under a race.
--
-- SQLite can't add a UNIQUE constraint to an existing table in place, so
-- a UNIQUE INDEX carries the constraint. Existing deployments may hold
-- duplicate (delivery_id) rows from the pre-fix behaviour; collapse them
-- to the earliest dead-letter row per delivery before the index builds
-- (the earliest row is the real first-drop; later rows are the
-- duplicate re-clicks).

DELETE FROM webhook_dlq
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY delivery_id ORDER BY dropped_at ASC, id ASC
    ) AS rn
    FROM webhook_dlq
  )
  WHERE rn = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_dlq_delivery_unique
  ON webhook_dlq(delivery_id);
