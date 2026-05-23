-- Order tags: free-form operator-applied labels on orders.
--
-- Operators tag orders for workflow routing — "rush",
-- "fraud-review", "wholesale", "demo", "vip-customer", "manual-
-- pack". Tags are applied two ways:
--
--   1. Manually, by an operator from the admin UI (`applyTag`).
--   2. Automatically, by a rule (`defineRule` + `applyRulesToOrder`).
--      Rule conditions predicate on order shape — order total,
--      ship-to country, line count, customer segment — and emit the
--      tag slug they govern. Rules are evaluated per-order on
--      demand (typically at order confirmation, via the order
--      FSM's `paid` transition); they don't run as a background
--      sweep.
--
-- Three tables:
--
--   order_tags_defined        — one row per tag definition. `slug`
--                               is the operator-facing handle
--                               (UNIQUE). `color` is a 6-hex CSS
--                               color the admin UI renders the
--                               tag pill in. `default_color_for_
--                               status`, when non-null, marks the
--                               tag as the default color source
--                               for one of the order FSM states —
--                               so a "rush" tag with default-
--                               color-for-status='pending' lets
--                               the admin UI color pending orders
--                               with the rush palette even before
--                               the tag is applied. `archived_at`
--                               non-null hides the tag from
--                               listTags by default; existing
--                               assignments are preserved.
--
--   order_tag_assignments     — one row per (order_id, tag_slug,
--                               applied_at) tuple. Soft-delete via
--                               `removed_at` so the history of who
--                               applied / removed which tag and
--                               when stays intact. The partial
--                               UNIQUE index ensures only one
--                               active (non-removed) assignment
--                               per (order, tag) exists at a time
--                               — a re-apply after removal is a
--                               new row with a fresh `applied_at`.
--                               `applied_at` is per-(order, tag)
--                               strictly monotonic so two writes
--                               in the same millisecond order
--                               deterministically.
--
--   order_tag_rules           — one row per auto-application rule.
--                               `conditions_json` carries the
--                               AND-composed predicate bag
--                               (total_minor_min,
--                               total_minor_max, country_in,
--                               line_count_min,
--                               customer_segment_in). `tag_slug`
--                               names the tag the rule emits when
--                               every predicate matches. Archived
--                               rules are skipped by
--                               `applyRulesToOrder`.

CREATE TABLE IF NOT EXISTS order_tags_defined (
  slug                          TEXT NOT NULL PRIMARY KEY,
  title                         TEXT NOT NULL,
  description                   TEXT NOT NULL DEFAULT '',
  color                         TEXT NOT NULL,
  default_color_for_status      TEXT,
  archived_at                   INTEGER,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  CHECK (length(color) = 7),
  CHECK (default_color_for_status IS NULL OR default_color_for_status IN
         ('pending', 'paid', 'fulfilling', 'shipped', 'delivered', 'refunded', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_order_tags_defined_archived
  ON order_tags_defined(archived_at);

CREATE TABLE IF NOT EXISTS order_tag_assignments (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  tag_slug      TEXT NOT NULL,
  applied_by    TEXT NOT NULL,
  applied_at    INTEGER NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  removed_at    INTEGER,
  removed_by    TEXT,
  FOREIGN KEY (tag_slug) REFERENCES order_tags_defined(slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_tag_assignments_active
  ON order_tag_assignments(order_id, tag_slug)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_tag_assignments_order
  ON order_tag_assignments(order_id, applied_at);
CREATE INDEX IF NOT EXISTS idx_order_tag_assignments_tag
  ON order_tag_assignments(tag_slug, applied_at);
CREATE INDEX IF NOT EXISTS idx_order_tag_assignments_active_tag
  ON order_tag_assignments(tag_slug, order_id)
  WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS order_tag_rules (
  slug              TEXT NOT NULL PRIMARY KEY,
  conditions_json   TEXT NOT NULL DEFAULT '{}',
  tag_slug          TEXT NOT NULL,
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (tag_slug) REFERENCES order_tags_defined(slug)
);

CREATE INDEX IF NOT EXISTS idx_order_tag_rules_archived
  ON order_tag_rules(archived_at);
CREATE INDEX IF NOT EXISTS idx_order_tag_rules_tag
  ON order_tag_rules(tag_slug);
