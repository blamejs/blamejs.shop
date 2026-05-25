"use strict";
/**
 * @module shop.purchaseOrders
 * @title  Purchase orders — operator-facing record of goods ordered
 *         FROM a vendor / supplier with receipt cascade into inventory
 *
 * @intro
 *   A PO is the operator's record of having placed an order with a
 *   vendor: which SKUs, how many, at what cost, and the lifecycle
 *   beat from draft through to the goods landing and the PO closing.
 *   The PO is upstream of `inventoryReceive`: when goods arrive
 *   against a PO, `recordPartialReceipt` composes the injected
 *   `inventoryReceive.draft + .apply` so the catalog's inventory
 *   table gets the restock alongside the PO line's
 *   quantity_received counter advancing. The catalog therefore
 *   stays the single owner of stock_on_hand mutation; the PO owns
 *   the upstream-procurement audit trail.
 *
 *   FSM:
 *
 *     draft -> submitted -> confirmed -> partially_received -> received -> closed
 *                                                  |
 *                                                  +-> received (full receipt skips partial)
 *
 *     draft|submitted -> cancelled  (operator pulls the PO)
 *
 *     (confirmed and later are NOT cancellable through this surface —
 *      once the vendor has accepted, a cancellation becomes a
 *      separate commercial conversation the operator records via
 *      notes + closePO with a custom workflow upstream.)
 *
 *   Composes:
 *     - vendors           — validates `vendor_slug` exists + is not
 *                           archived before creating a draft against
 *                           it. Injected as `opts.vendors`. Optional
 *                           (when absent the primitive skips the
 *                           vendor-existence check; tests that don't
 *                           wire vendors still run).
 *     - inventoryReceive  — composed at recordPartialReceipt time:
 *                           the per-line `quantity_received` counter
 *                           advances AND the catalog's inventory
 *                           table receives the restock via
 *                           inventoryReceive.draft + .apply.
 *                           Injected as `opts.inventoryReceive`.
 *                           Optional — when absent, the PO line
 *                           counter still advances but the
 *                           inventory restock is the operator's
 *                           responsibility (they call
 *                           inventory-receive.draft directly).
 *     - b.uuid.v7         — PO + line PKs (sortable; B-tree locality)
 *     - b.guardUuid       — strict UUID validation on every po_id
 *                           read
 *
 *   Surface:
 *     createDraft({ vendor_slug, lines: [{ sku, quantity,
 *                  unit_cost_minor, currency? }], notes?,
 *                  expected_delivery? })
 *     submitToVendor({ po_id, submitted_by? })
 *     confirmByVendor({ po_id, confirmed_at, vendor_reference? })
 *     recordPartialReceipt({ po_id, received_lines:
 *                  [{ sku, quantity_received, unit_cost_minor? }],
 *                  reference?, received_by? })
 *     closePO({ po_id })           — requires every line fully
 *                                    received (status === 'received')
 *     cancelPO({ po_id, reason })  — only from draft | submitted
 *     getPO(po_id) / listPOs({ status?, vendor_slug? })
 *     linesForPO(po_id)
 *     update(po_id, patch)         — only on draft status
 *
 *   Storage: `migrations-d1/0099_purchase_orders.sql` — two tables,
 *   `purchase_orders` + `purchase_order_lines`. ON DELETE CASCADE
 *   from po -> lines.
 *
 * @primitive purchaseOrders
 * @related   shop.vendors, shop.inventoryReceive, b.uuid, b.guardUuid
 */

var MAX_NOTES_LEN          = 4000;
var MAX_VENDOR_REF_LEN     = 256;
var MAX_SUBMITTED_BY_LEN   = 256;
var MAX_RECEIVED_BY_LEN    = 256;
var MAX_REFERENCE_LEN      = 128;
var MAX_CANCEL_REASON_LEN  = 280;
var MAX_LINES              = 1000;
var MAX_QUANTITY           = 1000000;        // 1M units per line sanity cap
var MAX_UNIT_COST_MINOR    = 100000000000;   // 1e11 minor units sanity cap
var MAX_SLUG_LEN           = 64;
var MAX_SKU_LEN            = 128;

var SLUG_RE                = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var SKU_RE                 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE            = /^[A-Z]{3}$/;
var REFERENCE_RE           = /^[A-Za-z0-9][A-Za-z0-9._\/ -]{0,127}$/;

// Control bytes + zero-width / direction-override family — same shape
// as vendors. Operator-rendered text fields refuse these to keep the
// downstream dashboard / printout safe from header-injection +
// visual-spoofing attacks.
var CONTROL_BYTE_RE        = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var PO_STATUSES = Object.freeze([
  "draft", "submitted", "confirmed", "partially_received",
  "received", "closed", "cancelled",
]);

// Mutable columns for `update(po_id, patch)`. Only draft POs may
// mutate; once submitted, the PO is the vendor-facing contract and
// changes route through a separate revision workflow the operator
// owns. vendor_slug is immutable post-create — a different vendor
// is a new PO.
var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "notes", "expected_delivery", "lines",
]);

// Framework handle (the vendored blamejs); index.js re-exports this as .framework.
var b = require("./vendor/blamejs");

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("purchase-orders: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("purchase-orders: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("purchase-orders: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("purchase-orders: " + label + " must be lowercase alnum + dash, no leading/trailing dash");
  }
  return s;
}

function _sku(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("purchase-orders: sku must be a non-empty string");
  }
  if (s.length > MAX_SKU_LEN) {
    throw new TypeError("purchase-orders: sku must be <= " + MAX_SKU_LEN + " characters");
  }
  if (!SKU_RE.test(s)) {
    throw new TypeError("purchase-orders: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("purchase-orders: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _reference(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REFERENCE_LEN || !REFERENCE_RE.test(s)) {
    throw new TypeError("purchase-orders: " + (label || "reference") +
      " must be a non-empty string <= " + MAX_REFERENCE_LEN +
      " chars matching /^[A-Za-z0-9][A-Za-z0-9._\\/ -]*$/");
  }
  return s;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("purchase-orders: " + label + " must be a positive integer");
  }
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("purchase-orders: " + label + " must be a non-negative integer");
  }
}

function _quantity(n, label) {
  _positiveInt(n, label);
  if (n > MAX_QUANTITY) {
    throw new TypeError("purchase-orders: " + label + " must be <= " + MAX_QUANTITY);
  }
}

function _unitCost(n, label) {
  _nonNegInt(n, label);
  if (n > MAX_UNIT_COST_MINOR) {
    throw new TypeError("purchase-orders: " + label + " must be <= " + MAX_UNIT_COST_MINOR);
  }
}

function _ts(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("purchase-orders: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _shortText(s, label, max) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("purchase-orders: " + label + " must be a string");
  }
  if (s.length > max) {
    throw new TypeError("purchase-orders: " + label + " must be <= " + max + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("purchase-orders: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("purchase-orders: " + label + " contains zero-width / direction-override bytes");
  }
  return s;
}

function _status(s) {
  if (typeof s !== "string" || PO_STATUSES.indexOf(s) === -1) {
    throw new TypeError("purchase-orders: status must be one of " + PO_STATUSES.join(", "));
  }
  return s;
}

function _now() { return Date.now(); }

// Validate + normalize the `lines` array. Returns an array of
// `{ sku, quantity, unit_cost_minor, currency }` with defaults
// applied. Refuses duplicate SKUs — the same SKU twice on a PO is a
// merge-up-front concern, not a per-line decision.
function _validateLines(lines, label) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new TypeError("purchase-orders: " + label + " must be a non-empty array");
  }
  if (lines.length > MAX_LINES) {
    throw new TypeError("purchase-orders: " + label + " must contain <= " + MAX_LINES + " entries");
  }
  var seen = Object.create(null);
  var normalized = [];
  for (var i = 0; i < lines.length; i += 1) {
    var l = lines[i];
    if (!l || typeof l !== "object") {
      throw new TypeError("purchase-orders: " + label + "[" + i + "] must be an object");
    }
    var sku = _sku(l.sku);
    _quantity(l.quantity, label + "[" + i + "].quantity");
    _unitCost(l.unit_cost_minor, label + "[" + i + "].unit_cost_minor");
    var currency = l.currency == null ? "USD" : _currency(l.currency);
    if (seen[sku]) {
      throw new TypeError("purchase-orders: duplicate sku " + JSON.stringify(sku) + " in " + label);
    }
    seen[sku] = true;
    normalized.push({
      sku:             sku,
      quantity:        l.quantity,
      unit_cost_minor: l.unit_cost_minor,
      currency:        currency,
    });
  }
  return normalized;
}

// ---- row hydration ------------------------------------------------------

function _hydratePO(row) {
  if (!row) return null;
  return {
    id:                row.id,
    vendor_slug:       row.vendor_slug,
    status:            row.status,
    expected_delivery: row.expected_delivery == null ? null : Number(row.expected_delivery),
    vendor_reference:  row.vendor_reference == null ? null : row.vendor_reference,
    notes:             row.notes == null ? "" : row.notes,
    submitted_at:      row.submitted_at == null ? null : Number(row.submitted_at),
    submitted_by:      row.submitted_by == null ? null : row.submitted_by,
    confirmed_at:      row.confirmed_at == null ? null : Number(row.confirmed_at),
    closed_at:         row.closed_at == null ? null : Number(row.closed_at),
    cancelled_at:      row.cancelled_at == null ? null : Number(row.cancelled_at),
    cancel_reason:     row.cancel_reason == null ? null : row.cancel_reason,
    created_at:        Number(row.created_at),
    updated_at:        Number(row.updated_at),
  };
}

function _hydrateLine(row) {
  return {
    id:                row.id,
    po_id:             row.po_id,
    sku:               row.sku,
    quantity_ordered:  Number(row.quantity_ordered),
    quantity_received: Number(row.quantity_received),
    unit_cost_minor:   Number(row.unit_cost_minor),
    currency:          row.currency,
    created_at:        Number(row.created_at),
    updated_at:        Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // The vendors handle is optional — when wired, createDraft refuses
  // to open a PO against an unknown or archived vendor. When absent,
  // the operator has chosen to manage vendor existence out of band
  // (tests that don't load the vendors migration still exercise the
  // PO surface).
  var vendorsHandle = opts.vendors || null;
  if (vendorsHandle && (typeof vendorsHandle.getVendor !== "function")) {
    throw new TypeError("purchase-orders.create: opts.vendors must expose getVendor(slug) when provided");
  }
  // The inventoryReceive handle is optional too. When wired,
  // recordPartialReceipt composes inventoryReceive.draft + .apply so
  // the catalog's inventory table gets the restock alongside the PO
  // counter advancing. When absent, the PO counter still advances
  // but the inventory restock is the operator's responsibility.
  var receiveHandle = opts.inventoryReceive || null;
  if (receiveHandle && (typeof receiveHandle.draft !== "function" ||
                       typeof receiveHandle.apply !== "function")) {
    throw new TypeError("purchase-orders.create: opts.inventoryReceive must expose draft + apply when provided");
  }

  async function _getPORaw(id) {
    var r = await query("SELECT * FROM purchase_orders WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getLinesRaw(poId) {
    var r = await query(
      "SELECT * FROM purchase_order_lines WHERE po_id = ?1 ORDER BY sku ASC",
      [poId],
    );
    return r.rows;
  }

  async function _hydrated(id) {
    var po = await _getPORaw(id);
    if (!po) return null;
    var lines = await _getLinesRaw(id);
    var out = _hydratePO(po);
    out.lines = lines.map(_hydrateLine);
    return out;
  }

  // Decide the receipt-driven status transition. If every line is
  // fully received (received >= ordered for all lines), the PO moves
  // to 'received'. If some lines have any receipts, it's
  // 'partially_received'. Else the prior status holds.
  function _statusAfterReceipt(lines, priorStatus) {
    var anyReceived  = false;
    var allFull      = true;
    for (var i = 0; i < lines.length; i += 1) {
      var got = Number(lines[i].quantity_received || 0);
      var ord = Number(lines[i].quantity_ordered);
      if (got > 0) anyReceived = true;
      if (got < ord) allFull = false;
    }
    if (allFull) return "received";
    if (anyReceived) return "partially_received";
    return priorStatus;
  }

  return {
    PO_STATUSES:               PO_STATUSES.slice(),
    MAX_NOTES_LEN:             MAX_NOTES_LEN,
    MAX_VENDOR_REF_LEN:        MAX_VENDOR_REF_LEN,
    MAX_SUBMITTED_BY_LEN:      MAX_SUBMITTED_BY_LEN,
    MAX_RECEIVED_BY_LEN:       MAX_RECEIVED_BY_LEN,
    MAX_REFERENCE_LEN:         MAX_REFERENCE_LEN,
    MAX_CANCEL_REASON_LEN:     MAX_CANCEL_REASON_LEN,
    MAX_LINES:                 MAX_LINES,
    MAX_QUANTITY:              MAX_QUANTITY,
    MAX_UNIT_COST_MINOR:       MAX_UNIT_COST_MINOR,

    // Open a draft PO. Validates the vendor exists + is not archived
    // when the vendors handle is wired. The lines array is captured
    // with per-SKU quantity + unit_cost + currency. No vendor
    // notification side-effects fire — that's submitToVendor's job.
    createDraft: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("purchase-orders.createDraft: input object required");
      }
      var vendorSlug = _slug(input.vendor_slug, "vendor_slug");
      var lines      = _validateLines(input.lines, "lines");
      var notes      = _shortText(input.notes, "notes", MAX_NOTES_LEN);
      var expected   = _ts(input.expected_delivery, "expected_delivery");

      if (vendorsHandle) {
        var v = await vendorsHandle.getVendor(vendorSlug);
        if (!v) {
          var miss = new Error("purchase-orders.createDraft: vendor " + JSON.stringify(vendorSlug) + " not found");
          miss.code = "PO_VENDOR_NOT_FOUND";
          throw miss;
        }
        if (v.status === "archived") {
          var arch = new Error("purchase-orders.createDraft: vendor " + JSON.stringify(vendorSlug) + " is archived");
          arch.code = "PO_VENDOR_ARCHIVED";
          throw arch;
        }
      }

      var id = b.uuid.v7();
      var ts = _now();

      try {
        await query(
          "INSERT INTO purchase_orders " +
          "(id, vendor_slug, status, expected_delivery, vendor_reference, notes, " +
          " submitted_at, submitted_by, confirmed_at, closed_at, cancelled_at, " +
          " cancel_reason, created_at, updated_at) " +
          "VALUES (?1, ?2, 'draft', ?3, NULL, ?4, NULL, NULL, NULL, NULL, NULL, NULL, ?5, ?5)",
          [id, vendorSlug, expected, notes, ts],
        );
        for (var i = 0; i < lines.length; i += 1) {
          var l = lines[i];
          await query(
            "INSERT INTO purchase_order_lines " +
            "(id, po_id, sku, quantity_ordered, quantity_received, unit_cost_minor, " +
            " currency, created_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?7)",
            [b.uuid.v7(), id, l.sku, l.quantity, l.unit_cost_minor, l.currency, ts],
          );
        }
      } catch (e) {
        // Best-effort rollback — D1 doesn't expose a transaction
        // handle to this primitive, so the compensating DELETE drops
        // the header + ON DELETE CASCADE clears any landed lines.
        try { await query("DELETE FROM purchase_orders WHERE id = ?1", [id]); }
        catch (_e2) { /* drop-silent — the original error is what the caller needs */ }
        throw e;
      }

      return await _hydrated(id);
    },

    // FSM: draft -> submitted. Captures the operator identity (or
    // automation tag) that pushed the PO out to the vendor. Refuses
    // anything but draft.
    submitToVendor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("purchase-orders.submitToVendor: input object required");
      }
      var poId         = _id(input.po_id, "po_id");
      var submittedBy  = _shortText(input.submitted_by, "submitted_by", MAX_SUBMITTED_BY_LEN);
      var current      = await _getPORaw(poId);
      if (!current) {
        var miss = new Error("purchase-orders.submitToVendor: PO " + poId + " not found");
        miss.code = "PO_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "draft") {
        var refused = new Error("purchase-orders.submitToVendor: refused — PO is " + current.status +
          ", only draft POs can be submitted");
        refused.code = "PO_TRANSITION_REFUSED";
        throw refused;
      }
      var ts = _now();
      await query(
        "UPDATE purchase_orders SET status = 'submitted', submitted_at = ?1, " +
        "submitted_by = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, submittedBy || null, poId],
      );
      return await _hydrated(poId);
    },

    // FSM: submitted -> confirmed. Captures vendor's confirmation
    // timestamp + reference number. The operator supplies confirmed_at
    // explicitly — the vendor's confirmation arrives async (email /
    // EDI / phone) and the operator stamps the wall-clock when they
    // log the acknowledgement.
    confirmByVendor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("purchase-orders.confirmByVendor: input object required");
      }
      var poId = _id(input.po_id, "po_id");
      if (input.confirmed_at == null) {
        throw new TypeError("purchase-orders.confirmByVendor: confirmed_at required (epoch ms)");
      }
      var confirmedAt = _ts(input.confirmed_at, "confirmed_at");
      var vendorRef   = _shortText(input.vendor_reference, "vendor_reference", MAX_VENDOR_REF_LEN);
      var current     = await _getPORaw(poId);
      if (!current) {
        var miss = new Error("purchase-orders.confirmByVendor: PO " + poId + " not found");
        miss.code = "PO_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "submitted") {
        var refused = new Error("purchase-orders.confirmByVendor: refused — PO is " + current.status +
          ", only submitted POs can be confirmed");
        refused.code = "PO_TRANSITION_REFUSED";
        throw refused;
      }
      var ts = _now();
      await query(
        "UPDATE purchase_orders SET status = 'confirmed', confirmed_at = ?1, " +
        "vendor_reference = ?2, updated_at = ?3 WHERE id = ?4",
        [confirmedAt, vendorRef || null, ts, poId],
      );
      return await _hydrated(poId);
    },

    // Record a partial (or full) receipt against a confirmed /
    // partially_received PO. Walks `received_lines`, advances each
    // line's quantity_received, optionally updates the captured
    // unit_cost_minor (vendor invoiced different to quoted), and
    // recomputes the PO status: any-received -> partially_received,
    // every-line-full -> received. Composes inventoryReceive.draft +
    // .apply when the handle is wired so the catalog's inventory
    // table gets the restock in lockstep.
    //
    // Refuses receipts against SKUs that weren't on the PO, refuses
    // over-receipt (received + new > ordered), refuses transitions
    // from non-confirmed/partial states (draft / submitted / closed /
    // cancelled / received).
    recordPartialReceipt: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("purchase-orders.recordPartialReceipt: input object required");
      }
      var poId = _id(input.po_id, "po_id");
      if (!Array.isArray(input.received_lines) || !input.received_lines.length) {
        throw new TypeError("purchase-orders.recordPartialReceipt: received_lines must be a non-empty array");
      }
      var receivedBy = _shortText(input.received_by, "received_by", MAX_RECEIVED_BY_LEN);
      var reference  = input.reference != null
        ? _reference(input.reference, "reference")
        : null;

      // Validate received_lines shape up front; build a sku -> entry
      // map so the per-line UPDATE pass is O(lines).
      var rxMap = Object.create(null);
      for (var i = 0; i < input.received_lines.length; i += 1) {
        var rl = input.received_lines[i];
        if (!rl || typeof rl !== "object") {
          throw new TypeError("purchase-orders.recordPartialReceipt: received_lines[" + i + "] must be an object");
        }
        var sku = _sku(rl.sku);
        _quantity(rl.quantity_received, "received_lines[" + i + "].quantity_received");
        if (rl.unit_cost_minor != null) {
          _unitCost(rl.unit_cost_minor, "received_lines[" + i + "].unit_cost_minor");
        }
        if (Object.prototype.hasOwnProperty.call(rxMap, sku)) {
          throw new TypeError("purchase-orders.recordPartialReceipt: duplicate sku " +
            JSON.stringify(sku) + " in received_lines");
        }
        rxMap[sku] = {
          quantity_received: rl.quantity_received,
          unit_cost_minor:   rl.unit_cost_minor == null ? null : rl.unit_cost_minor,
        };
      }

      var current = await _getPORaw(poId);
      if (!current) {
        var miss = new Error("purchase-orders.recordPartialReceipt: PO " + poId + " not found");
        miss.code = "PO_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "confirmed" && current.status !== "partially_received") {
        var refused = new Error("purchase-orders.recordPartialReceipt: refused — PO is " +
          current.status + ", only confirmed or partially_received POs can record receipts");
        refused.code = "PO_TRANSITION_REFUSED";
        throw refused;
      }

      var lines = await _getLinesRaw(poId);
      var skuToLine = Object.create(null);
      for (var s = 0; s < lines.length; s += 1) {
        skuToLine[lines[s].sku] = lines[s];
      }

      // Pre-flight: every sku in received_lines must be on the PO,
      // and the new running total can't exceed quantity_ordered. The
      // pre-flight runs before any UPDATE so a single bad line
      // doesn't half-apply the receipt.
      var rxSkus = Object.keys(rxMap);
      for (var t = 0; t < rxSkus.length; t += 1) {
        var rsku = rxSkus[t];
        var line = skuToLine[rsku];
        if (!line) {
          throw new TypeError("purchase-orders.recordPartialReceipt: sku " +
            JSON.stringify(rsku) + " is not on PO " + poId);
        }
        var prior = Number(line.quantity_received || 0);
        var addQ  = rxMap[rsku].quantity_received;
        var ord   = Number(line.quantity_ordered);
        if (prior + addQ > ord) {
          throw new TypeError("purchase-orders.recordPartialReceipt: over-receipt for sku " +
            JSON.stringify(rsku) + " — ordered=" + ord + ", already_received=" + prior +
            ", attempting to add=" + addQ);
        }
      }

      // Compose inventoryReceive.draft + apply BEFORE advancing the
      // PO counters. If the catalog refuses (unknown SKU, decimal
      // qty, etc.) the PO state stays consistent with the catalog —
      // a half-applied receipt across two writeable surfaces is the
      // worst-case for reconciliation. The receipt primitive's draft
      // step requires a unique `reference`; when the caller didn't
      // supply one, derive a deterministic-per-call value from the
      // PO id + occurrence timestamp so two recordPartialReceipt
      // calls on the same PO produce distinct receipt rows.
      var ts = _now();
      var receiptResult = null;
      if (receiveHandle) {
        var receiptRef = reference != null
          ? reference
          : ("po-" + poId + "-" + ts);
        var receiptLines = [];
        for (var u = 0; u < rxSkus.length; u += 1) {
          var rxe = rxMap[rxSkus[u]];
          var lineForCurrency = skuToLine[rxSkus[u]];
          var unitCost = rxe.unit_cost_minor != null
            ? rxe.unit_cost_minor
            : Number(lineForCurrency.unit_cost_minor);
          receiptLines.push({
            sku:                rxSkus[u],
            qty_received:       rxe.quantity_received,
            unit_cost_minor:    unitCost,
            unit_cost_currency: lineForCurrency.currency,
          });
        }
        var draft = await receiveHandle.draft({
          reference:      receiptRef,
          supplier:       current.vendor_slug,
          received_by:    receivedBy,
          notes:          "purchase-orders:" + poId,
          total_currency: skuToLine[rxSkus[0]].currency,
          received_at:    ts,
          lines:          receiptLines,
        });
        var applied = await receiveHandle.apply(draft.id);
        receiptResult = {
          receipt_id:    draft.id,
          applied_count: applied.applied_count,
          stock_changes: applied.stock_changes,
        };
      }

      // Now advance the PO counters. The pre-flight cap above
      // guarantees no over-receipt; the inventoryReceive composition
      // (if wired) has already landed without throwing.
      for (var v = 0; v < rxSkus.length; v += 1) {
        var line2  = skuToLine[rxSkus[v]];
        var rxe2   = rxMap[rxSkus[v]];
        var newQty = Number(line2.quantity_received || 0) + rxe2.quantity_received;
        if (rxe2.unit_cost_minor != null) {
          await query(
            "UPDATE purchase_order_lines SET quantity_received = ?1, " +
            "unit_cost_minor = ?2, updated_at = ?3 WHERE id = ?4",
            [newQty, rxe2.unit_cost_minor, ts, line2.id],
          );
        } else {
          await query(
            "UPDATE purchase_order_lines SET quantity_received = ?1, updated_at = ?2 WHERE id = ?3",
            [newQty, ts, line2.id],
          );
        }
      }

      // Recompute the PO-level status from the now-current line
      // state. The status transition only flips forward (no
      // 'received' -> 'partially_received' regression).
      var updatedLines = await _getLinesRaw(poId);
      var nextStatus   = _statusAfterReceipt(updatedLines, current.status);
      if (nextStatus !== current.status) {
        await query(
          "UPDATE purchase_orders SET status = ?1, updated_at = ?2 WHERE id = ?3",
          [nextStatus, ts, poId],
        );
      } else {
        await query(
          "UPDATE purchase_orders SET updated_at = ?1 WHERE id = ?2",
          [ts, poId],
        );
      }

      var hydrated = await _hydrated(poId);
      hydrated.receipt = receiptResult;
      return hydrated;
    },

    // FSM: received -> closed. The PO is fully reconciled — every
    // ordered unit accounted for. Refuses if the PO isn't in the
    // 'received' state (operator can't close a partial PO; they
    // either await full receipt or move the open lines to a new PO
    // and cancel this one upstream of confirmation).
    closePO: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("purchase-orders.closePO: input object required");
      }
      var poId = _id(input.po_id, "po_id");
      var current = await _getPORaw(poId);
      if (!current) {
        var miss = new Error("purchase-orders.closePO: PO " + poId + " not found");
        miss.code = "PO_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "received") {
        var refused = new Error("purchase-orders.closePO: refused — PO is " + current.status +
          ", only fully-received POs can be closed");
        refused.code = "PO_TRANSITION_REFUSED";
        throw refused;
      }
      // Defensive cross-check: every line received >= ordered. The
      // recordPartialReceipt path guarantees status advances to
      // 'received' only when every line is full, but verifying at
      // close time costs one read and rules out a corrupted state
      // path closing a PO with phantom open lines.
      var lines = await _getLinesRaw(poId);
      for (var i = 0; i < lines.length; i += 1) {
        if (Number(lines[i].quantity_received) < Number(lines[i].quantity_ordered)) {
          var badState = new Error("purchase-orders.closePO: refused — line for sku " +
            JSON.stringify(lines[i].sku) + " is not fully received");
          badState.code = "PO_LINE_NOT_FULL";
          throw badState;
        }
      }
      var ts = _now();
      await query(
        "UPDATE purchase_orders SET status = 'closed', closed_at = ?1, updated_at = ?1 WHERE id = ?2",
        [ts, poId],
      );
      return await _hydrated(poId);
    },

    // FSM: draft|submitted -> cancelled. Once the vendor has
    // confirmed, cancellation is a commercial conversation, not a
    // database transition — the operator records the outcome via
    // notes and either receives the goods anyway or closes the PO
    // by a custom path the operator pipeline owns.
    cancelPO: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("purchase-orders.cancelPO: input object required");
      }
      var poId = _id(input.po_id, "po_id");
      var reason = _shortText(input.reason, "reason", MAX_CANCEL_REASON_LEN);
      if (!reason.length) {
        throw new TypeError("purchase-orders.cancelPO: reason must be a non-empty string");
      }
      var current = await _getPORaw(poId);
      if (!current) {
        var miss = new Error("purchase-orders.cancelPO: PO " + poId + " not found");
        miss.code = "PO_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "draft" && current.status !== "submitted") {
        var refused = new Error("purchase-orders.cancelPO: refused — PO is " + current.status +
          ", only draft or submitted POs can be cancelled through this surface");
        refused.code = "PO_TRANSITION_REFUSED";
        throw refused;
      }
      var ts = _now();
      await query(
        "UPDATE purchase_orders SET status = 'cancelled', cancelled_at = ?1, " +
        "cancel_reason = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, reason, poId],
      );
      return await _hydrated(poId);
    },

    // Read a hydrated PO + its lines. Returns null on miss so the
    // caller-handler maps cleanly to HTTP 404.
    getPO: async function (poId) {
      var id = _id(poId, "po_id");
      return await _hydrated(id);
    },

    // List POs. Optional `status` + `vendor_slug` filters. Sorted by
    // created_at DESC so the operator's freshest POs land at the top.
    listPOs: async function (listOpts) {
      listOpts = listOpts || {};
      var hasStatus = listOpts.status !== undefined && listOpts.status !== null;
      var hasVendor = listOpts.vendor_slug !== undefined && listOpts.vendor_slug !== null;
      if (hasStatus) _status(listOpts.status);
      if (hasVendor) _slug(listOpts.vendor_slug, "vendor_slug");
      var sql, params;
      if (hasStatus && hasVendor) {
        sql = "SELECT * FROM purchase_orders WHERE status = ?1 AND vendor_slug = ?2 " +
              "ORDER BY created_at DESC, id DESC";
        params = [listOpts.status, listOpts.vendor_slug];
      } else if (hasStatus) {
        sql = "SELECT * FROM purchase_orders WHERE status = ?1 " +
              "ORDER BY created_at DESC, id DESC";
        params = [listOpts.status];
      } else if (hasVendor) {
        sql = "SELECT * FROM purchase_orders WHERE vendor_slug = ?1 " +
              "ORDER BY created_at DESC, id DESC";
        params = [listOpts.vendor_slug];
      } else {
        sql = "SELECT * FROM purchase_orders ORDER BY created_at DESC, id DESC";
        params = [];
      }
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var hydrated = _hydratePO(r.rows[i]);
        hydrated.lines = (await _getLinesRaw(r.rows[i].id)).map(_hydrateLine);
        out.push(hydrated);
      }
      return out;
    },

    // Read lines only (without the PO header). Useful for receipt
    // reconciliation UIs that already have the header loaded.
    linesForPO: async function (poId) {
      var id = _id(poId, "po_id");
      var current = await _getPORaw(id);
      if (!current) return null;
      var rows = await _getLinesRaw(id);
      return rows.map(_hydrateLine);
    },

    // Patch-style update. Only ALLOWED_UPDATE_COLUMNS may change, and
    // only while the PO is in 'draft' state. Updating `lines`
    // replaces the entire line set (operator-driven full revision);
    // partial-line edits on a draft PO are an upstream concern the
    // operator does by composing createDraft + delete-and-replace if
    // the granularity matters more than the wholesale replace.
    update: async function (poId, patch) {
      var id = _id(poId, "po_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("purchase-orders.update: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("purchase-orders.update: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError("purchase-orders.update: column '" + keys[i] + "' not updatable");
        }
      }

      var current = await _getPORaw(id);
      if (!current) return null;
      if (current.status !== "draft") {
        var refused = new Error("purchase-orders.update: refused — PO is " + current.status +
          ", only draft POs can be updated");
        refused.code = "PO_TRANSITION_REFUSED";
        throw refused;
      }

      var ts = _now();
      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
        _set("notes", _shortText(patch.notes, "notes", MAX_NOTES_LEN));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "expected_delivery")) {
        _set("expected_delivery", _ts(patch.expected_delivery, "expected_delivery"));
      }

      var hasLinesPatch = Object.prototype.hasOwnProperty.call(patch, "lines");
      var nextLines = null;
      if (hasLinesPatch) {
        nextLines = _validateLines(patch.lines, "lines");
      }

      // Always bump updated_at — every update path advances the
      // freshness signal, even when only a lines-replace happens
      // (the per-row updated_at on lines covers lines; the header
      // updated_at covers the PO).
      if (sets.length) {
        _set("updated_at", ts);
        params.push(id);
        var sql = "UPDATE purchase_orders SET " + sets.join(", ") + " WHERE id = ?" + idx;
        await query(sql, params);
      } else {
        await query(
          "UPDATE purchase_orders SET updated_at = ?1 WHERE id = ?2",
          [ts, id],
        );
      }

      if (hasLinesPatch) {
        // Replace lines wholesale. ON DELETE CASCADE isn't useful
        // here (we're not deleting the parent); a direct DELETE +
        // re-INSERT keeps the operation explicit. The pre-flight
        // validation in _validateLines guarantees the replacement
        // shape is well-formed.
        await query("DELETE FROM purchase_order_lines WHERE po_id = ?1", [id]);
        for (var k = 0; k < nextLines.length; k += 1) {
          var l = nextLines[k];
          await query(
            "INSERT INTO purchase_order_lines " +
            "(id, po_id, sku, quantity_ordered, quantity_received, unit_cost_minor, " +
            " currency, created_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?7)",
            [b.uuid.v7(), id, l.sku, l.quantity, l.unit_cost_minor, l.currency, ts],
          );
        }
      }

      return await _hydrated(id);
    },
  };
}

module.exports = {
  create:       create,
  PO_STATUSES:  PO_STATUSES,
};
