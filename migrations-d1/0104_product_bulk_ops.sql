-- Product bulk operations — operator-side bulk-mutation surface for
-- the catalog. The catalog primitive owns single-row create / update /
-- archive against products + variants + prices + inventory; this
-- migration adds the supporting tables for *bulk* mutation across a
-- filter expression, plus the append-only audit trail every bulk
-- operation writes a row to.
--
-- Three new tables, plus one read-side audit log:
--
--   product_tags             — (product_id, tag) join table. Operators
--                              tag products with free-form lowercase
--                              labels ("sale", "new-arrival",
--                              "clearance") so the storefront and the
--                              bulk-ops surface can address a slice of
--                              the catalog by label. Composite PK
--                              refuses double-add of the same tag on
--                              one product. `added_at` stamps the
--                              insertion for audit. ON DELETE CASCADE
--                              from products so an archived-then-
--                              hard-deleted product doesn't leak
--                              orphan tag rows. The `tag` column is
--                              shape-validated at the primitive (lower-
--                              case alnum + dash, 1-64 chars); the DB
--                              stores whatever the primitive writes.
--
--   product_categories       — (product_id, category) join table.
--                              Distinct from `collections` (operator-
--                              curated lists with positioning + smart
--                              rules) — categories are a flat lookup
--                              the bulk-ops filter slices on. A product
--                              can belong to multiple categories
--                              (apparel + clearance + outdoor) so the
--                              shape is a join table rather than a
--                              single column on products. Composite PK
--                              keeps the join idempotent.
--
--   product_bulk_audit       — append-only audit row per bulk
--                              operation. Every bulk mutation
--                              (set_price / adjust_price / archive /
--                              unarchive / add_tag / remove_tag /
--                              set_inventory) writes one row with:
--                                * `kind` — the operation discriminator
--                                  (CHECK enum)
--                                * `filter_json` — the resolved filter
--                                  the operator passed (preserved as
--                                  JSON so a later audit can replay
--                                  the targeting)
--                                * `params_json` — the operation's
--                                  parameters (new price, percent
--                                  delta, tag value, etc.)
--                                * `affected_count` — how many rows
--                                  the operation actually changed
--                                * `performed_at` — epoch ms timestamp
--                                * `actor_id` — operator-supplied
--                                  caller id (nullable for system /
--                                  automation contexts)
--                              The id is a v7 UUID so the audit log
--                              sorts by insertion order without a
--                              separate sequence column.
--
-- Indexes:
--   * `product_tags(tag)` — tag_any / tag_all filter resolution scans
--     by tag value.
--   * `product_categories(category)` — category filter resolution
--     scans by category value.
--   * `product_bulk_audit(kind, performed_at DESC)` — audit-trail
--     drill-down by operation type, newest first.
--   * `product_bulk_audit(performed_at)` — unfiltered audit-trail
--     pagination by time.

CREATE TABLE IF NOT EXISTS product_tags (
  product_id    TEXT NOT NULL,
  tag           TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (product_id, tag),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_tags_tag
  ON product_tags(tag);
CREATE INDEX IF NOT EXISTS idx_product_tags_product
  ON product_tags(product_id);

CREATE TABLE IF NOT EXISTS product_categories (
  product_id    TEXT NOT NULL,
  category      TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (product_id, category),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category
  ON product_categories(category);
CREATE INDEX IF NOT EXISTS idx_product_categories_product
  ON product_categories(product_id);

CREATE TABLE IF NOT EXISTS product_bulk_audit (
  id              TEXT NOT NULL PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
    'set_price', 'adjust_price', 'archive', 'unarchive',
    'add_tag', 'remove_tag', 'set_inventory'
  )),
  filter_json     TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  affected_count  INTEGER NOT NULL CHECK (affected_count >= 0),
  performed_at    INTEGER NOT NULL,
  actor_id        TEXT
);

CREATE INDEX IF NOT EXISTS idx_product_bulk_audit_kind_performed
  ON product_bulk_audit(kind, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_bulk_audit_performed
  ON product_bulk_audit(performed_at);
