-- Gift registry: customers create a registry for an occasion
-- (wedding / baby / housewarming / birthday / graduation / other),
-- add items they'd like (sku + qty desired), and share a public or
-- unlisted slug with friends/family. Visitors browse the registry
-- and purchase items, optionally revealing their identity to the
-- owner.
--
-- Three tables, one slug-keyed primary table:
--
--   * `gift_registries` — one row per registry. `slug` is the URL
--     primary key (lowercase alnum + dash, <= 200 chars). The owner
--     is a customer UUID. `occasion` + `privacy` + `status` are
--     CHECK-bounded enums. `status` is the FSM column — registries
--     start `active` and transition to `closed` exactly once
--     (closeRegistry). `closed_at` is the audit breadcrumb for the
--     transition; NULL while active.
--
--   * `gift_registry_items` — items the owner has added to the
--     registry. (registry_slug, sku, variant_id) is the natural
--     identity tuple — re-adding the same sku/variant bumps the
--     existing row rather than spawning a duplicate. `archived_at`
--     soft-deletes a removed item so existing purchase rows retain
--     their item_id FK referent.
--
--   * `gift_registry_purchases` — append-only audit trail of every
--     purchase against the registry. `buyer_customer_id` is nullable
--     (a guest checkout can purchase without registering an
--     account). `reveal_buyer` is the boolean the buyer ticked at
--     checkout — when false, `progressFor` / `getBySlug` MUST NOT
--     surface the buyer's identity to the registry owner, even
--     though the row carries it for audit + refund-path purposes.
--
-- Schema decisions:
--
--   * `occasion` CHECK enum constrains the categorisation operators
--     can build storefront templates against. The set is fixed at
--     migration time so a new occasion is a schema change, not a
--     silent string column drift.
--
--   * `privacy` CHECK enum:
--       - `private`  — only the owner can resolve the slug; never
--         returned by searchPublic.
--       - `unlisted` — anyone who knows the slug can view it; never
--         returned by searchPublic.
--       - `public`   — discoverable via searchPublic + indexed by
--         the storefront landing page.
--
--   * `event_date` is operator-supplied epoch-ms (the event the
--     registry is leading up to — wedding date, baby due date, move-
--     in date). NULL when the operator has no concrete date yet.
--     The storefront sorts public-search results by event_date
--     (soonest first) when set.
--
--   * `shipping_address_id` is nullable — the registry owner may
--     not have decided where gifts ship to at registry-creation
--     time. The checkout primitive resolves the actual ship-to at
--     purchase time; this column is the owner's preferred default.
--
--   * `message` is the optional owner-authored "thank you" /
--     "please don't gift wrap" prose shown above the item list.
--     Capped at 4000 bytes at the app layer.
--
--   * `recipient_name` is the public-facing name shown on the
--     registry page ("Alice & Bob's Wedding Registry"). Capped at
--     200 bytes at the app layer.
--
--   * `quantity_desired` on an item is how many of that sku the
--     owner wants. `progressFor` aggregates purchases against it.
--     `priority` (1 = highest, 5 = lowest) is the owner's hint to
--     gift-givers which items matter most; the storefront sorts
--     items by priority asc, then created_at asc.
--
--   * Indexes drive the four hot read paths:
--       - (owner_customer_id)         — listForOwner
--       - (privacy, status, event_date) — searchPublic
--       - (registry_slug)             — items + purchases lookups
--       - (registry_slug, item_id)    — progressFor aggregation

CREATE TABLE IF NOT EXISTS gift_registries (
  slug                 TEXT NOT NULL PRIMARY KEY,
  owner_customer_id    TEXT NOT NULL,
  title                TEXT NOT NULL,
  occasion             TEXT NOT NULL CHECK (occasion IN ('wedding', 'baby', 'housewarming', 'birthday', 'graduation', 'anniversary', 'other')),
  event_date           INTEGER,
  recipient_name       TEXT NOT NULL,
  shipping_address_id  TEXT,
  message              TEXT NOT NULL DEFAULT '',
  privacy              TEXT NOT NULL CHECK (privacy IN ('private', 'unlisted', 'public')),
  status               TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  closed_at            INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK ((status = 'closed' AND closed_at IS NOT NULL) OR (status = 'active' AND closed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_gift_registries_owner    ON gift_registries(owner_customer_id);
CREATE INDEX IF NOT EXISTS idx_gift_registries_search   ON gift_registries(privacy, status, event_date);
CREATE INDEX IF NOT EXISTS idx_gift_registries_updated  ON gift_registries(updated_at);

CREATE TABLE IF NOT EXISTS gift_registry_items (
  id                TEXT    NOT NULL PRIMARY KEY,
  registry_slug     TEXT    NOT NULL,
  sku               TEXT    NOT NULL,
  variant_id        TEXT,
  quantity_desired  INTEGER NOT NULL CHECK (quantity_desired > 0),
  priority          INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (registry_slug) REFERENCES gift_registries(slug) ON DELETE CASCADE,
  UNIQUE (registry_slug, sku, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_gift_registry_items_slug ON gift_registry_items(registry_slug);

CREATE TABLE IF NOT EXISTS gift_registry_purchases (
  id                  TEXT    NOT NULL PRIMARY KEY,
  registry_slug       TEXT    NOT NULL,
  item_id             TEXT    NOT NULL,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  buyer_customer_id   TEXT,
  buyer_message       TEXT    NOT NULL DEFAULT '',
  reveal_buyer        INTEGER NOT NULL CHECK (reveal_buyer IN (0, 1)),
  occurred_at         INTEGER NOT NULL,
  FOREIGN KEY (registry_slug) REFERENCES gift_registries(slug) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES gift_registry_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gift_registry_purchases_slug  ON gift_registry_purchases(registry_slug);
CREATE INDEX IF NOT EXISTS idx_gift_registry_purchases_item  ON gift_registry_purchases(registry_slug, item_id);
