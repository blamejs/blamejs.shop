-- Dropship forwarding — general-purpose drop-ship vendor binding +
-- per-order forward-to-vendor record. Distinct from
-- `pod_bindings` / `pod_fulfillments` (those are print-on-demand
-- specific: each row carries supplier-product-id +
-- supplier-variant-id + artwork-url + position metadata for the
-- print pipeline). A drop-ship binding is simpler: the operator
-- ties a storefront SKU to a vendor slug + per-unit wholesale cost
-- + lead-time + return-policy snapshot. The vendor receives the
-- order line + the customer shipping address, fulfills, and ships
-- tracking back through the operator's worker.
--
-- Two tables:
--
--   dropship_bindings      — one row per SKU, vendor-bound. `sku`
--                            is the PRIMARY KEY (one vendor per
--                            SKU; rebind via unbind + bind, not
--                            patch). `vendor_slug` is the operator-
--                            chosen vendor handle (no FK on the
--                            vendors primitive — drop-ship works
--                            standalone; the operator may run with
--                            a flat vendor list outside the
--                            vendors registry). `cost_minor` +
--                            `currency` capture the wholesale unit
--                            cost at bind time (operator may patch
--                            via the operator console — the
--                            primitive's read shape reports the
--                            current binding's cost, not an
--                            historical snapshot). `lead_time_days`
--                            is the vendor's published fulfillment
--                            window; the storefront uses it to
--                            compute the displayed "ships in N
--                            days" copy. `return_policy` is the
--                            vendor's free-text policy snapshot
--                            (operators surface it on the product
--                            page so customers see the vendor's
--                            terms, not just the operator's
--                            blanket policy). `archived_at` is
--                            soft-delete: an archived binding
--                            still resolves on legacy orders'
--                            forwardings but `forwardOrder`
--                            refuses to write a fresh row against
--                            it.
--
--   dropship_forwardings   — per-order, per-vendor forwarding row.
--                            ONE row per (order, vendor, SKU) —
--                            unlike `pod_fulfillments` which
--                            bundles every line from one supplier
--                            into a single row, drop-ship splits
--                            because each line carries its own
--                            vendor_ref + tracking number on the
--                            return leg (the vendor's downstream
--                            system stamps a per-line PO). The FSM:
--
--                              queued     — written by forwardOrder
--                              accepted   — vendor acknowledged
--                                           (markVendorAccepted
--                                           stamps vendor_ref +
--                                           eta)
--                              shipped    — vendor handed package
--                                           to carrier
--                                           (markVendorShipped
--                                           stamps carrier +
--                                           tracking_number +
--                                           shipped_at)
--                              delivered  — carrier confirmed
--                                           delivery
--                                           (markVendorDelivered
--                                           stamps delivered_at)
--                              failed     — terminal; vendor
--                                           refused or aborted
--                                           (markVendorFailed
--                                           stamps fail_reason +
--                                           failed_at)
--                              returned   — terminal; customer
--                                           returned the goods
--                                           (markVendorReturned
--                                           stamps returned_at)
--
--                            Allowed transitions:
--                              queued     -> accepted, failed
--                              accepted   -> shipped,  failed
--                              shipped    -> delivered, failed, returned
--                              delivered  -> returned
--                              failed     — terminal
--                              returned   — terminal
--
--                            `shipping_address_json` captures the
--                            customer's ship-to address at forward
--                            time so a later edit of the order's
--                            shipping address does NOT silently
--                            redirect a vendor's in-flight
--                            shipment. `occurred_at` is the wall-
--                            clock stamp at write time; the
--                            transition columns
--                            (shipped_at / delivered_at /
--                            failed_at / returned_at) carry the
--                            operator-supplied or auto-stamped
--                            event time for each FSM beat.

CREATE TABLE IF NOT EXISTS dropship_bindings (
  sku                       TEXT NOT NULL PRIMARY KEY,
  vendor_slug               TEXT NOT NULL,
  cost_minor                INTEGER NOT NULL CHECK (cost_minor >= 0),
  currency                  TEXT NOT NULL,
  lead_time_days            INTEGER NOT NULL CHECK (lead_time_days >= 0 AND lead_time_days <= 365),
  return_policy             TEXT NOT NULL,
  archived_at               INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dropship_bindings_vendor
  ON dropship_bindings(vendor_slug, sku);
CREATE INDEX IF NOT EXISTS idx_dropship_bindings_archived
  ON dropship_bindings(archived_at)
  WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS dropship_forwardings (
  id                        TEXT NOT NULL PRIMARY KEY,
  order_id                  TEXT NOT NULL,
  vendor_slug               TEXT NOT NULL,
  sku                       TEXT NOT NULL,
  quantity                  INTEGER NOT NULL CHECK (quantity > 0),
  shipping_address_json     TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN (
    'queued', 'accepted', 'shipped', 'delivered', 'failed', 'returned'
  )),
  vendor_ref                TEXT,
  eta                       INTEGER,
  carrier                   TEXT,
  tracking_number           TEXT,
  shipped_at                INTEGER,
  delivered_at              INTEGER,
  failed_at                 INTEGER,
  returned_at               INTEGER,
  fail_reason               TEXT,
  occurred_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dropship_forwardings_order
  ON dropship_forwardings(order_id, occurred_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_dropship_forwardings_vendor_status
  ON dropship_forwardings(vendor_slug, status, occurred_at ASC);
CREATE INDEX IF NOT EXISTS idx_dropship_forwardings_pending
  ON dropship_forwardings(status, occurred_at ASC, id ASC)
  WHERE status IN ('queued', 'accepted');
