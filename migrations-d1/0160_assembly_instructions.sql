-- Assembly / care / unboxing instructions — operator authors per-SKU
-- instructions (PDF link / video link / inline Markdown / external
-- link) the storefront surfaces on the order-detail page and the
-- customer portal. The view log feeds support metrics ("did the
-- customer ever open the instructions before opening the ticket?")
-- and the "unviewed orders" nudge ("you haven't opened the assembly
-- guide for the desk you ordered last week — here's the link").
--
-- Two tables:
--
--   product_instructions
--     One row per (sku, locale, version). A SKU may carry multiple
--     locales; redefining the same locale appends a new version row
--     so the operator can preview the next revision before flipping
--     `published`. Only one published row per (sku, locale) at a
--     time — the publishVersion verb un-publishes prior versions in
--     the same locale.
--
--   product_instruction_views
--     Append-only view log. One row per recordView call. Either
--     order_id OR customer_id may be present (the storefront calls
--     with both when the customer is logged in; the order-confirmation
--     email's "open instructions" link can call with order_id only).
--     session_id_hash captures anonymous browse — the raw session id
--     never lands here.
--
-- Indexes target the hot reads:
--   - getInstruction / listForSku: (sku, locale, published)
--   - popularInstructions:         (occurred_at) + (instruction_id)
--   - viewsForCustomer:            (customer_id, occurred_at)
--   - unviewedForCustomer:         (order_id), (customer_id)

CREATE TABLE IF NOT EXISTS product_instructions (
  id                TEXT NOT NULL PRIMARY KEY,
  sku               TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('pdf', 'video', 'markdown', 'external_link')),
  content_url       TEXT,
  content_markdown  TEXT,
  locale            TEXT NOT NULL,
  version           INTEGER NOT NULL CHECK (version > 0),
  published         INTEGER NOT NULL CHECK (published IN (0, 1)),
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_instructions_sku_locale
  ON product_instructions(sku, locale, published)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_instructions_sku
  ON product_instructions(sku)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS product_instruction_views (
  id               TEXT NOT NULL PRIMARY KEY,
  instruction_id   TEXT NOT NULL,
  order_id         TEXT,
  customer_id      TEXT,
  session_id_hash  TEXT,
  occurred_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_instruction_views_instruction_time
  ON product_instruction_views(instruction_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_product_instruction_views_customer_time
  ON product_instruction_views(customer_id, occurred_at)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_instruction_views_order
  ON product_instruction_views(order_id)
  WHERE order_id IS NOT NULL;
