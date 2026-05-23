-- Print-on-demand: supplier-agnostic binding from internal SKU to a
-- supplier's print spec + per-order fulfillment record.
--
-- Operators selling print-on-demand goods (Printful / Printify / Gelato /
-- Lulu / Gooten / Cloudprinter / custom integrations) need the storefront
-- to keep doing what it already does — catalog + cart + checkout + order
-- — while the fulfillment path forwards the order to a third-party press
-- that prints + ships the physical good. The shop never holds inventory
-- for these SKUs; the supplier holds the press time + the artwork + the
-- blank product.
--
-- Schema decisions:
--   * `pod_bindings.sku` is the primary key — one binding per internal
--     SKU. An operator switching a SKU from Printful to Printify
--     updates the same row (rebind); the binding history isn't an
--     audit log here (the operator-facing diff is the storefront
--     order shape, not the supplier choice).
--   * `supplier` is a CHECK enum of the seven supported integrations.
--     `custom` is the escape hatch for an operator with a smaller
--     supplier their own worker drives — the binding still carries
--     the product/variant/artwork tuple so the worker has one place
--     to look up "what do I send this supplier".
--   * `supplier_product_id` + `supplier_variant_id` are the
--     supplier's own identifiers for the blank product (e.g. a
--     Printful catalog product like "Unisex Heavyweight T-Shirt")
--     and the variant (size + color). The shop doesn't validate
--     them — the supplier's API is the source of truth, and the
--     operator's worker surfaces validation errors back through
--     the `markFulfillmentFailed` path.
--   * `artwork_url` is the externally hosted print artwork. The
--     primitive doesn't fetch + cache — the supplier downloads it
--     on receipt of the order. Operators are expected to use
--     R2 / S3 / signed URLs as appropriate to their setup.
--   * `position_json` is an opaque JSON blob carrying placement
--     ({x, y, w, h, dpi}) for the artwork on the blank. Supplier
--     APIs accept different shapes; the primitive stores whatever
--     the operator hands in and the worker translates to the
--     supplier's wire format.
--   * `colorway` is the artwork colorway (light vs dark logo, etc.) —
--     nullable because many bindings are single-colorway.
--   * `cost_minor` is the operator's wholesale cost from the supplier
--     in minor units (cents). Used for margin reporting via
--     `costForOrder(lines)`; storefront price comes from the pricing
--     primitive, not from here.
--
--   * `pod_fulfillments` is the per-order forward-to-supplier record.
--     A `forwardOrder` call writes one row in `pending` status; the
--     operator's worker picks pending rows up, calls the supplier's
--     API, and transitions to `submitted` (with the supplier's
--     reference) / `failed` (with an error message) / `cancelled`
--     (with a reason). The supplier's webhook (or the worker
--     polling) transitions `submitted` → `shipped` with tracking.
--   * `status` CHECK enum is the FSM:
--       pending   — written by forwardOrder, awaiting worker
--       submitted — worker called supplier, has supplier_order_id
--       shipped   — supplier handed to carrier, has tracking
--       failed    — worker / supplier returned a hard error
--       cancelled — operator cancelled before submission
--   * `supplier_order_id` / `tracking_number` / `carrier` / `error`
--     are nullable — each lands at the relevant FSM transition.
--   * Indexes cover the three operator-facing lookups: worker queue
--     drain (status, created_at), per-order list (order_id), and
--     per-supplier queue drain (supplier, status).

CREATE TABLE IF NOT EXISTS pod_bindings (
  sku                  TEXT NOT NULL PRIMARY KEY,
  supplier             TEXT NOT NULL CHECK (supplier IN (
                          'printful', 'printify', 'gelato', 'lulu',
                          'gooten', 'cloudprinter', 'custom')),
  supplier_product_id  TEXT NOT NULL,
  supplier_variant_id  TEXT NOT NULL,
  artwork_url          TEXT NOT NULL,
  position_json        TEXT NOT NULL DEFAULT '{}',
  colorway             TEXT,
  cost_minor           INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pod_fulfillments (
  id                  TEXT NOT NULL PRIMARY KEY,
  order_id            TEXT NOT NULL,
  supplier            TEXT NOT NULL CHECK (supplier IN (
                         'printful', 'printify', 'gelato', 'lulu',
                         'gooten', 'cloudprinter', 'custom')),
  status              TEXT NOT NULL CHECK (status IN (
                         'pending', 'submitted', 'shipped', 'failed', 'cancelled')),
  lines_json          TEXT NOT NULL DEFAULT '[]',
  shipping_json       TEXT NOT NULL DEFAULT '{}',
  supplier_order_id   TEXT,
  tracking_number     TEXT,
  carrier             TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  submitted_at        INTEGER,
  shipped_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pod_bindings_supplier             ON pod_bindings(supplier);
CREATE INDEX IF NOT EXISTS idx_pod_fulfillments_status_created   ON pod_fulfillments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pod_fulfillments_order            ON pod_fulfillments(order_id);
CREATE INDEX IF NOT EXISTS idx_pod_fulfillments_supplier_status  ON pod_fulfillments(supplier, status);
