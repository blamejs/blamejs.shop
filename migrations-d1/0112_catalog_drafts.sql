-- Catalog drafts — operator-side staging workflow for the catalog.
-- The catalog primitive owns single-row product / variant / price /
-- inventory mutations and the bulk-ops primitive owns filter-based
-- mass updates; catalog-drafts owns the third lane:
--
--   "I'm assembling a batch of N changes (new products, price
--    updates, archives, tag flips) that should land TOGETHER. I want
--    a preview view that shows the resulting catalog state, an
--    operator review window before publication, and the option to
--    undo the whole batch atomically inside a 7-day rollback window
--    if something downstream surfaces a problem the preview missed."
--
-- Three new tables:
--
--   catalog_drafts                — the draft envelope. `slug` is the
--                                   PK; operators address drafts by
--                                   stable handle ("spring-sale-2026",
--                                   "vendor-acme-refresh"). `status`
--                                   walks an open enum
--                                   (open / preview / published /
--                                    cancelled / rolled_back). The
--                                   non-terminal transitions are
--                                   reversible (open <-> preview);
--                                   `published`, `cancelled`, and
--                                   `rolled_back` are terminal.
--                                   `scheduled_publish_at` is an
--                                   optional epoch-ms hint the
--                                   scheduler reads; the primitive
--                                   doesn't auto-publish (publish
--                                   stays operator-initiated for v1
--                                   so a stale draft never lands
--                                   without a fresh human review).
--
--   catalog_draft_changes         — the staged change rows. Each
--                                   change carries a `kind` from a
--                                   closed enum and a `payload_json`
--                                   shaped to that kind. The
--                                   `sequence_order` column gives
--                                   the operator deterministic
--                                   ordering inside the draft so a
--                                   sequence like
--                                   `(create_product, set_price for
--                                   variant of that product)` can be
--                                   authored in the natural order.
--                                   ON DELETE CASCADE from the parent
--                                   draft so a cancelled draft
--                                   doesn't leak orphan change rows.
--
--   catalog_draft_rollback_log    — the rollback audit-trail. When
--                                   `rollbackDraft` reverses a
--                                   published draft, it persists
--                                   both the catalog state captured
--                                   at publish time (the "original"
--                                   state to which the catalog was
--                                   restored) and the state being
--                                   abandoned (the post-publish
--                                   state at the moment of
--                                   rollback). Operators audit the
--                                   round-trip from one row.
--
-- Schema decisions:
--
--   * `kind` on `catalog_draft_changes` is a tight closed enum.
--     Every primitive that integrates with this surface (catalog,
--     bulk-ops, tag-ops, inventory) covers exactly one of these
--     verbs, so a draft is a portable bundle that any of those
--     primitives can consume without inventing a new shape.
--
--   * `payload_json` is shape-validated at the primitive layer
--     (stageChange refuses payloads that don't match the verb's
--     expected fields). The DB stores whatever the primitive wrote;
--     storage-layer validation would be a duplicate of the JS gate
--     and CHECK constraints can't introspect JSON cheaply on D1.
--
--   * `sequence_order` is a per-draft monotonic counter the primitive
--     assigns at stageChange time. Two changes with the same draft
--     slug never share a sequence_order. The PRIMARY KEY is the
--     change id (v7 UUID); `(draft_slug, sequence_order)` is the
--     hot read-order index for listChanges / previewMerged.
--
--   * The 7-day rollback window is enforced at the primitive layer
--     against `published_at + 7d`. No DB-level CHECK because the
--     window is a policy decision (the operator should be able to
--     extend it via a future config knob without a schema change).
--
--   * `owner_id` is operator-supplied and free-form (a UUID, an
--     email, a session id — the primitive doesn't enumerate). The
--     primitive validates only length + control bytes; the calling
--     admin UI decides the namespace.
--
-- Indexes:
--   * `catalog_drafts(status, updated_at DESC)` — operator dashboards
--     filter by status; newest first.
--   * `catalog_drafts(owner_id)` — "show me my drafts" filter for the
--     operator portal.
--   * `catalog_draft_changes(draft_slug, sequence_order)` — the hot
--     read path for listChanges / previewMerged.
--   * `catalog_draft_rollback_log(draft_slug, occurred_at DESC)` —
--     the per-draft rollback audit feed.

CREATE TABLE IF NOT EXISTS catalog_drafts (
  slug                  TEXT NOT NULL PRIMARY KEY,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL CHECK (status IN (
                          'open',
                          'preview',
                          'published',
                          'cancelled',
                          'rolled_back'
                        )),
  scheduled_publish_at  INTEGER,
  published_at          INTEGER,
  cancelled_at          INTEGER,
  rolled_back_at        INTEGER,
  rollback_reason       TEXT,
  cancel_reason         TEXT,
  owner_id              TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_drafts_status_updated
  ON catalog_drafts(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_drafts_owner
  ON catalog_drafts(owner_id);

CREATE TABLE IF NOT EXISTS catalog_draft_changes (
  id              TEXT NOT NULL PRIMARY KEY,
  draft_slug      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'create_product',
                    'update_product',
                    'archive_product',
                    'create_variant',
                    'update_variant',
                    'archive_variant',
                    'set_price',
                    'set_inventory',
                    'add_tag',
                    'remove_tag'
                  )),
  payload_json    TEXT NOT NULL,
  sequence_order  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (draft_slug) REFERENCES catalog_drafts(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_catalog_draft_changes_draft_seq
  ON catalog_draft_changes(draft_slug, sequence_order);

CREATE TABLE IF NOT EXISTS catalog_draft_rollback_log (
  id                    TEXT NOT NULL PRIMARY KEY,
  draft_slug            TEXT NOT NULL,
  original_state_json   TEXT NOT NULL,
  rollback_state_json   TEXT NOT NULL,
  occurred_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_draft_rollback_log_draft
  ON catalog_draft_rollback_log(draft_slug, occurred_at DESC);
