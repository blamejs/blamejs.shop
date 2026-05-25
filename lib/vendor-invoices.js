"use strict";
/**
 * @module shop.vendorInvoices
 * @title  Vendor invoices — operator-facing accounts-payable record
 *         of bills RECEIVED FROM vendors
 *
 * @intro
 *   A vendor invoice is the operator's record of a bill they received
 *   from one of their vendors (a supplier, a service provider, a
 *   freight carrier). Distinct from `invoiceRenderer`, which renders
 *   the operator-to-customer invoice — this primitive sits on the
 *   accounts-payable side of the ledger.
 *
 *   The operator transcribes (or imports) the vendor's invoice into
 *   this table verbatim: line items, totals, due date, related POs.
 *   `reconcileAgainstPOs` computes the variance summary between the
 *   invoice's billed amounts and the related POs' captured costs +
 *   received quantities so the operator can spot a vendor over-billing
 *   before the payment goes out. Once the invoice is approved, the
 *   operator records the payment with a `markPaid` carrying the
 *   payment_ref + paid_minor — partial pay is first-class (operator
 *   only pays the undisputed portion while a dispute is open).
 *
 *   FSM:
 *
 *     received -> approved -> paid
 *        |          |
 *        +-> disputed  (operator pushes back on amount / line items)
 *        +-> voided    (vendor reissued / duplicate / cancelled)
 *
 *   Disputed + voided are terminal — the operator either records a
 *   follow-up invoice (vendor reissued under a new number) or, for
 *   disputed, the resolution is recorded out of band and the original
 *   invoice stays disputed in the audit trail.
 *
 *   Composes:
 *     - vendors           — validates `vendor_slug` exists + is not
 *                           archived before recording an invoice
 *                           against it. Injected as `opts.vendors`.
 *                           Optional (when absent the primitive skips
 *                           the vendor-existence check; tests that
 *                           don't wire vendors still run).
 *     - purchaseOrders    — used by `reconcileAgainstPOs` to fetch
 *                           PO + line state for the variance math.
 *                           Injected as `opts.purchaseOrders`.
 *                           Optional — when absent, `reconcileAgainstPOs`
 *                           refuses with a clear error code so the
 *                           caller can either wire the handle or
 *                           manage reconciliation out of band.
 *     - b.uuid.v7         — invoice PK (sortable; B-tree locality)
 *     - b.guardUuid       — strict UUID validation on every invoice_id
 *                           read
 *
 *   Surface:
 *     recordInvoice({ vendor_slug, invoice_number, invoice_date,
 *                  due_date, amount_minor, currency, line_items,
 *                  related_po_ids? })
 *     getInvoice(invoice_id)
 *     invoicesForVendor({ vendor_slug, status? })
 *     unpaidInvoices({ due_within_days? })
 *     markApproved({ invoice_id, approved_by })
 *     markPaid({ invoice_id, payment_ref, paid_at, paid_minor })
 *     markDisputed({ invoice_id, reason })
 *     markVoided({ invoice_id, reason })
 *     reconcileAgainstPOs({ invoice_id })
 *     agingReport({ as_of, vendor_slug? })
 *     metricsForVendor({ vendor_slug, from, to })
 *
 *   Storage: `migrations-d1/0193_vendor_invoices.sql` —
 *   `vendor_invoices` (status FSM enforced as CHECK enum +
 *   per-status nullable contract, UNIQUE(vendor_slug, invoice_number)
 *   as duplicate guard).
 *
 * @primitive vendorInvoices
 * @related   shop.vendors, shop.purchaseOrders, b.uuid, b.guardUuid
 */

var MAX_INVOICE_NUMBER_LEN = 128;
var MAX_PAYMENT_REF_LEN    = 256;
var MAX_APPROVED_BY_LEN    = 256;
var MAX_REASON_LEN         = 1000;
var MAX_DESCRIPTION_LEN    = 500;
var MAX_LINE_ITEMS         = 500;
var MAX_RELATED_POS        = 64;
var MAX_AMOUNT_MINOR       = 100000000000000;   // 1e14 minor units cap
var MAX_QUANTITY           = 1000000;
var MAX_SLUG_LEN           = 64;

var SLUG_RE                = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var INVOICE_NUMBER_RE      = /^[A-Za-z0-9][A-Za-z0-9._\/ -]{0,127}$/;
var PAYMENT_REF_RE         = /^[A-Za-z0-9][A-Za-z0-9._\/ -]{0,255}$/;
var CURRENCY_RE            = /^[A-Z]{3}$/;

// Control bytes + zero-width / direction-override family. Same shape
// as the sibling accounts-payable primitives — operator-rendered text
// fields refuse these to keep the dashboard + printout safe from
// header-injection + visual-spoofing attacks.
var CONTROL_BYTE_RE        = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var INVOICE_STATUSES = Object.freeze([
  "received", "approved", "paid", "disputed", "voided",
]);

var MAX_DUE_WITHIN_DAYS     = 3650;    // ~10 years — bound the predicate

var b = require("./index").framework;

var MS_PER_DAY              = b.constants.TIME.days(1);

// Aging buckets (days past due, inclusive at upper bound). `current`
// is anything with due_date >= as_of; the rest are the canonical
// 1-30 / 31-60 / 61-90 / 90+ accounts-payable aging schedule.
var AGING_BUCKETS = Object.freeze([
  { id: "current",  min: -Infinity, max: 0 },
  { id: "1_30",     min: 1,         max: 30 },
  { id: "31_60",    min: 31,        max: 60 },
  { id: "61_90",    min: 61,        max: 90 },
  { id: "over_90",  min: 91,        max: Infinity },
]);

// ---- monotonic clock ----------------------------------------------------
//
// Vendor invoices persist epoch-ms timestamps and operators frequently
// record back-to-back transitions (approved + paid in the same admin
// session). The strict-monotonic clock guarantees two same-millisecond
// `_now()` calls produce distinct integers so the row-ordering on
// created_at / updated_at / approved_at / paid_at is deterministic
// without an extra tiebreaker column. Tests that record + approve +
// pay in tight loops rely on this for ordering assertions.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("vendor-invoices: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("vendor-invoices: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("vendor-invoices: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("vendor-invoices: " + label + " must be lowercase alnum + dash, no leading/trailing dash");
  }
  return s;
}

function _invoiceNumber(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("vendor-invoices: invoice_number must be a non-empty string");
  }
  if (s.length > MAX_INVOICE_NUMBER_LEN) {
    throw new TypeError("vendor-invoices: invoice_number must be <= " + MAX_INVOICE_NUMBER_LEN + " characters");
  }
  if (!INVOICE_NUMBER_RE.test(s)) {
    throw new TypeError("vendor-invoices: invoice_number must match /^[A-Za-z0-9][A-Za-z0-9._\\/ -]*$/");
  }
  return s;
}

function _paymentRef(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("vendor-invoices: payment_ref must be a non-empty string");
  }
  if (s.length > MAX_PAYMENT_REF_LEN) {
    throw new TypeError("vendor-invoices: payment_ref must be <= " + MAX_PAYMENT_REF_LEN + " characters");
  }
  if (!PAYMENT_REF_RE.test(s)) {
    throw new TypeError("vendor-invoices: payment_ref must match /^[A-Za-z0-9][A-Za-z0-9._\\/ -]*$/");
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("vendor-invoices: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _ts(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("vendor-invoices: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _amount(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("vendor-invoices: " + label + " must be a non-negative integer (minor units)");
  }
  if (n > MAX_AMOUNT_MINOR) {
    throw new TypeError("vendor-invoices: " + label + " must be <= " + MAX_AMOUNT_MINOR);
  }
  return n;
}

function _shortText(s, label, max) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("vendor-invoices: " + label + " must be a string");
  }
  if (s.length > max) {
    throw new TypeError("vendor-invoices: " + label + " must be <= " + max + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("vendor-invoices: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("vendor-invoices: " + label + " contains zero-width / direction-override bytes");
  }
  return s;
}

function _reason(s, label) {
  var v = _shortText(s, label, MAX_REASON_LEN);
  if (!v.length) {
    throw new TypeError("vendor-invoices: " + label + " must be a non-empty string");
  }
  return v;
}

function _status(s) {
  if (typeof s !== "string" || INVOICE_STATUSES.indexOf(s) === -1) {
    throw new TypeError("vendor-invoices: status must be one of " + INVOICE_STATUSES.join(", "));
  }
  return s;
}

// Validate + normalize the line_items array. Returns an array of
// canonical entries. Each line carries `description`, `quantity`,
// `unit_cost_minor`, `total_minor`. The total is operator-supplied
// (so currency rounding choices the vendor made are preserved
// verbatim) but the primitive cross-checks it against quantity *
// unit_cost_minor and refuses entries where the variance exceeds 1
// minor unit (rounding tolerance). SKU is optional — service-line
// invoices (freight, labor) have no SKU.
function _validateLineItems(lines, label) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new TypeError("vendor-invoices: " + label + " must be a non-empty array");
  }
  if (lines.length > MAX_LINE_ITEMS) {
    throw new TypeError("vendor-invoices: " + label + " must contain <= " + MAX_LINE_ITEMS + " entries");
  }
  var normalized = [];
  for (var i = 0; i < lines.length; i += 1) {
    var l = lines[i];
    if (!l || typeof l !== "object") {
      throw new TypeError("vendor-invoices: " + label + "[" + i + "] must be an object");
    }
    if (typeof l.description !== "string" || !l.description.length) {
      throw new TypeError("vendor-invoices: " + label + "[" + i + "].description must be a non-empty string");
    }
    _shortText(l.description, label + "[" + i + "].description", MAX_DESCRIPTION_LEN);
    if (!Number.isInteger(l.quantity) || l.quantity <= 0 || l.quantity > MAX_QUANTITY) {
      throw new TypeError("vendor-invoices: " + label + "[" + i + "].quantity must be a positive integer <= " + MAX_QUANTITY);
    }
    _amount(l.unit_cost_minor, label + "[" + i + "].unit_cost_minor");
    _amount(l.total_minor,     label + "[" + i + "].total_minor");
    var sku = null;
    if (l.sku != null) {
      if (typeof l.sku !== "string" || !l.sku.length || l.sku.length > 128) {
        throw new TypeError("vendor-invoices: " + label + "[" + i + "].sku must be a non-empty string <= 128 chars");
      }
      sku = l.sku;
    }
    // Tolerance: |total - qty * unit_cost| <= 1 minor unit. Vendors
    // occasionally include rounding (per-line VAT split, fractional
    // unit-cost) that the operator transcribes verbatim — we accept
    // up to a one-minor-unit gap so a 0.5-cent rounding artifact
    // doesn't refuse the row.
    var expected = l.quantity * l.unit_cost_minor;
    if (Math.abs(l.total_minor - expected) > 1) {
      throw new TypeError("vendor-invoices: " + label + "[" + i + "].total_minor " +
                          l.total_minor + " differs from quantity * unit_cost_minor (" + expected + ") by > 1");
    }
    normalized.push({
      description:     l.description,
      sku:             sku,
      quantity:        l.quantity,
      unit_cost_minor: l.unit_cost_minor,
      total_minor:     l.total_minor,
    });
  }
  return normalized;
}

function _validateRelatedPoIds(arr, label) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) {
    throw new TypeError("vendor-invoices: " + label + " must be an array when provided");
  }
  if (arr.length > MAX_RELATED_POS) {
    throw new TypeError("vendor-invoices: " + label + " must contain <= " + MAX_RELATED_POS + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var id = _id(arr[i], label + "[" + i + "]");
    if (seen[id]) {
      throw new TypeError("vendor-invoices: duplicate po_id " + JSON.stringify(id) + " in " + label);
    }
    seen[id] = true;
    out.push(id);
  }
  return out;
}

// ---- row hydration ------------------------------------------------------

function _hydrate(row) {
  if (!row) return null;
  var lineItems;
  var relatedPoIds;
  try { lineItems    = JSON.parse(row.line_items_json); }
  catch (_e1) { lineItems = []; }
  try { relatedPoIds = JSON.parse(row.related_po_ids_json); }
  catch (_e2) { relatedPoIds = []; }
  return {
    id:              row.id,
    vendor_slug:     row.vendor_slug,
    invoice_number:  row.invoice_number,
    invoice_date:    Number(row.invoice_date),
    due_date:        Number(row.due_date),
    amount_minor:    Number(row.amount_minor),
    currency:        row.currency,
    line_items:      lineItems,
    related_po_ids:  relatedPoIds,
    status:          row.status,
    approved_by:     row.approved_by    == null ? null : row.approved_by,
    approved_at:     row.approved_at    == null ? null : Number(row.approved_at),
    payment_ref:     row.payment_ref    == null ? null : row.payment_ref,
    paid_at:         row.paid_at        == null ? null : Number(row.paid_at),
    paid_minor:      row.paid_minor     == null ? null : Number(row.paid_minor),
    disputed_at:     row.disputed_at    == null ? null : Number(row.disputed_at),
    dispute_reason:  row.dispute_reason == null ? null : row.dispute_reason,
    voided_at:       row.voided_at      == null ? null : Number(row.voided_at),
    void_reason:     row.void_reason    == null ? null : row.void_reason,
    created_at:      Number(row.created_at),
    updated_at:      Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // The vendors handle is optional — when wired, recordInvoice refuses
  // to record against an unknown or archived vendor. When absent, the
  // operator has chosen to manage vendor existence out of band.
  var vendorsHandle = opts.vendors || null;
  if (vendorsHandle && (typeof vendorsHandle.getVendor !== "function")) {
    throw new TypeError("vendor-invoices.create: opts.vendors must expose getVendor(slug) when provided");
  }
  // The purchaseOrders handle is optional — when wired,
  // reconcileAgainstPOs walks the related POs for the variance math.
  // When absent, reconcileAgainstPOs surfaces a clear NO_PO_HANDLE
  // error so the caller can wire the handle or manage reconciliation
  // out of band (some operators reconcile in their downstream ERP).
  var poHandle = opts.purchaseOrders || null;
  if (poHandle && (typeof poHandle.getPO !== "function")) {
    throw new TypeError("vendor-invoices.create: opts.purchaseOrders must expose getPO(id) when provided");
  }

  async function _getInvoiceRaw(id) {
    var r = await query("SELECT * FROM vendor_invoices WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _hydrated(id) {
    return _hydrate(await _getInvoiceRaw(id));
  }

  // ---- recordInvoice ----------------------------------------------------

  async function recordInvoice(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.recordInvoice: input object required");
    }
    var vendorSlug    = _slug(input.vendor_slug, "vendor_slug");
    var invoiceNumber = _invoiceNumber(input.invoice_number);
    var invoiceDate   = _ts(input.invoice_date, "invoice_date");
    var dueDate       = _ts(input.due_date,     "due_date");
    if (dueDate < invoiceDate) {
      throw new TypeError("vendor-invoices.recordInvoice: due_date must be >= invoice_date");
    }
    var amountMinor   = _amount(input.amount_minor, "amount_minor");
    var currency      = _currency(input.currency);
    var lineItems     = _validateLineItems(input.line_items, "line_items");
    var relatedPoIds  = _validateRelatedPoIds(input.related_po_ids, "related_po_ids");

    // Cross-check: sum of line totals equals the header amount_minor.
    // Vendors occasionally tack a separate VAT / shipping line on the
    // bottom; the operator must transcribe those as explicit line
    // items so the header total reconciles. A header that disagrees
    // with the line sum is almost always a transcription error.
    var lineSum = 0;
    for (var li = 0; li < lineItems.length; li += 1) lineSum += lineItems[li].total_minor;
    if (lineSum !== amountMinor) {
      throw new TypeError("vendor-invoices.recordInvoice: amount_minor " + amountMinor +
                          " does not equal sum of line_items.total_minor (" + lineSum + ")");
    }

    if (vendorsHandle) {
      var v = await vendorsHandle.getVendor(vendorSlug);
      if (!v) {
        var miss = new Error("vendor-invoices.recordInvoice: vendor " + JSON.stringify(vendorSlug) + " not found");
        miss.code = "VENDOR_INVOICE_VENDOR_NOT_FOUND";
        throw miss;
      }
      if (v.status === "archived") {
        var arch = new Error("vendor-invoices.recordInvoice: vendor " + JSON.stringify(vendorSlug) + " is archived");
        arch.code = "VENDOR_INVOICE_VENDOR_ARCHIVED";
        throw arch;
      }
    }

    var id = b.uuid.v7();
    var ts = _now();

    try {
      await query(
        "INSERT INTO vendor_invoices " +
        "(id, vendor_slug, invoice_number, invoice_date, due_date, amount_minor, currency, " +
        " line_items_json, related_po_ids_json, status, approved_by, approved_at, " +
        " payment_ref, paid_at, paid_minor, disputed_at, dispute_reason, " +
        " voided_at, void_reason, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'received', NULL, NULL, " +
        "        NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?10, ?10)",
        [id, vendorSlug, invoiceNumber, invoiceDate, dueDate, amountMinor, currency,
         JSON.stringify(lineItems), JSON.stringify(relatedPoIds), ts],
      );
    } catch (e) {
      // UNIQUE(vendor_slug, invoice_number) — surface a clean error
      // code so the caller can show "duplicate invoice" to the
      // operator without parsing SQL driver-specific strings.
      var msg = String((e && e.message) || "");
      if (/UNIQUE|unique/.test(msg)) {
        var dupe = new Error("vendor-invoices.recordInvoice: duplicate invoice (vendor_slug=" +
          JSON.stringify(vendorSlug) + ", invoice_number=" + JSON.stringify(invoiceNumber) + ")");
        dupe.code = "VENDOR_INVOICE_DUPLICATE";
        throw dupe;
      }
      throw e;
    }
    return await _hydrated(id);
  }

  // ---- getInvoice -------------------------------------------------------

  async function getInvoice(invoiceId) {
    var id = _id(invoiceId, "invoice_id");
    return await _hydrated(id);
  }

  // ---- invoicesForVendor ------------------------------------------------

  async function invoicesForVendor(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.invoicesForVendor: input object required");
    }
    var vendorSlug = _slug(input.vendor_slug, "vendor_slug");
    var hasStatus  = input.status !== undefined && input.status !== null;
    if (hasStatus) _status(input.status);
    var sql, params;
    if (hasStatus) {
      sql = "SELECT * FROM vendor_invoices WHERE vendor_slug = ?1 AND status = ?2 " +
            "ORDER BY invoice_date DESC, id DESC";
      params = [vendorSlug, input.status];
    } else {
      sql = "SELECT * FROM vendor_invoices WHERE vendor_slug = ?1 " +
            "ORDER BY invoice_date DESC, id DESC";
      params = [vendorSlug];
    }
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrate(r.rows[i]));
    return out;
  }

  // ---- unpaidInvoices ---------------------------------------------------
  //
  // Returns invoices the operator owes money on (status received or
  // approved) optionally filtered to those due within N days from now.
  // `disputed` is excluded by design — the operator can't decide to
  // pay a disputed invoice without first resolving the dispute, so
  // showing it in the unpaid queue invites the wrong action.

  async function unpaidInvoices(input) {
    input = input || {};
    var dueWithin = input.due_within_days;
    if (dueWithin == null) dueWithin = null;
    else {
      if (!Number.isInteger(dueWithin) || dueWithin < 0 || dueWithin > MAX_DUE_WITHIN_DAYS) {
        throw new TypeError("vendor-invoices.unpaidInvoices: due_within_days must be an integer in [0, " +
                            MAX_DUE_WITHIN_DAYS + "]");
      }
    }
    var sql, params;
    if (dueWithin == null) {
      sql = "SELECT * FROM vendor_invoices WHERE status IN ('received', 'approved') " +
            "ORDER BY due_date ASC, id ASC";
      params = [];
    } else {
      var cutoff = _now() + (dueWithin * MS_PER_DAY);
      sql = "SELECT * FROM vendor_invoices WHERE status IN ('received', 'approved') " +
            "AND due_date <= ?1 ORDER BY due_date ASC, id ASC";
      params = [cutoff];
    }
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrate(r.rows[i]));
    return out;
  }

  // ---- markApproved -----------------------------------------------------

  async function markApproved(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.markApproved: input object required");
    }
    var id          = _id(input.invoice_id, "invoice_id");
    var approvedBy  = _shortText(input.approved_by, "approved_by", MAX_APPROVED_BY_LEN);
    if (!approvedBy.length) {
      throw new TypeError("vendor-invoices.markApproved: approved_by must be a non-empty string");
    }
    var current = await _getInvoiceRaw(id);
    if (!current) {
      var miss = new Error("vendor-invoices.markApproved: invoice " + id + " not found");
      miss.code = "VENDOR_INVOICE_NOT_FOUND";
      throw miss;
    }
    if (current.status !== "received") {
      var refused = new Error("vendor-invoices.markApproved: refused — invoice is " + current.status +
        ", only received invoices can be approved");
      refused.code = "VENDOR_INVOICE_TRANSITION_REFUSED";
      throw refused;
    }
    var ts = _now();
    await query(
      "UPDATE vendor_invoices SET status = 'approved', approved_by = ?1, " +
      "approved_at = ?2, updated_at = ?2 WHERE id = ?3",
      [approvedBy, ts, id],
    );
    return await _hydrated(id);
  }

  // ---- markPaid ---------------------------------------------------------
  //
  // Records the payment against an approved invoice. `paid_minor` is
  // explicit and can be less than the header `amount_minor` (partial
  // pay — operator pays the undisputed portion while a separate
  // dispute conversation continues). Overpayment is refused — the
  // operator handles that by recording a credit-note invoice on the
  // vendor side.

  async function markPaid(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.markPaid: input object required");
    }
    var id         = _id(input.invoice_id, "invoice_id");
    var paymentRef = _paymentRef(input.payment_ref);
    var paidAt     = _ts(input.paid_at, "paid_at");
    var paidMinor  = _amount(input.paid_minor, "paid_minor");
    var current    = await _getInvoiceRaw(id);
    if (!current) {
      var miss = new Error("vendor-invoices.markPaid: invoice " + id + " not found");
      miss.code = "VENDOR_INVOICE_NOT_FOUND";
      throw miss;
    }
    if (current.status !== "approved") {
      var refused = new Error("vendor-invoices.markPaid: refused — invoice is " + current.status +
        ", only approved invoices can be paid");
      refused.code = "VENDOR_INVOICE_TRANSITION_REFUSED";
      throw refused;
    }
    if (paidMinor > Number(current.amount_minor)) {
      var over = new Error("vendor-invoices.markPaid: refused — paid_minor " + paidMinor +
        " exceeds invoice amount_minor " + current.amount_minor);
      over.code = "VENDOR_INVOICE_OVERPAYMENT";
      throw over;
    }
    var ts = _now();
    await query(
      "UPDATE vendor_invoices SET status = 'paid', payment_ref = ?1, paid_at = ?2, " +
      "paid_minor = ?3, updated_at = ?4 WHERE id = ?5",
      [paymentRef, paidAt, paidMinor, ts, id],
    );
    return await _hydrated(id);
  }

  // ---- markDisputed -----------------------------------------------------

  async function markDisputed(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.markDisputed: input object required");
    }
    var id     = _id(input.invoice_id, "invoice_id");
    var reason = _reason(input.reason, "reason");
    var current = await _getInvoiceRaw(id);
    if (!current) {
      var miss = new Error("vendor-invoices.markDisputed: invoice " + id + " not found");
      miss.code = "VENDOR_INVOICE_NOT_FOUND";
      throw miss;
    }
    // Disputable from received or approved — once paid, the dispute
    // becomes a refund/credit conversation the operator records via
    // a new credit-note invoice rather than mutating the paid row.
    if (current.status !== "received" && current.status !== "approved") {
      var refused = new Error("vendor-invoices.markDisputed: refused — invoice is " + current.status +
        ", only received or approved invoices can be disputed");
      refused.code = "VENDOR_INVOICE_TRANSITION_REFUSED";
      throw refused;
    }
    var ts = _now();
    // Disputed clears approved_at — the operator's prior approval no
    // longer stands; if the dispute resolves they re-approve (which
    // refuses with the FSM check, so the operator records a new
    // invoice for the agreed amount and voids this one).
    await query(
      "UPDATE vendor_invoices SET status = 'disputed', disputed_at = ?1, " +
      "dispute_reason = ?2, approved_at = NULL, approved_by = NULL, updated_at = ?1 WHERE id = ?3",
      [ts, reason, id],
    );
    return await _hydrated(id);
  }

  // ---- markVoided -------------------------------------------------------

  async function markVoided(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.markVoided: input object required");
    }
    var id     = _id(input.invoice_id, "invoice_id");
    var reason = _reason(input.reason, "reason");
    var current = await _getInvoiceRaw(id);
    if (!current) {
      var miss = new Error("vendor-invoices.markVoided: invoice " + id + " not found");
      miss.code = "VENDOR_INVOICE_NOT_FOUND";
      throw miss;
    }
    if (current.status === "paid") {
      var refusedPaid = new Error("vendor-invoices.markVoided: refused — paid invoices cannot be voided " +
        "(operator records a credit-note invoice on the vendor side instead)");
      refusedPaid.code = "VENDOR_INVOICE_TRANSITION_REFUSED";
      throw refusedPaid;
    }
    if (current.status === "voided") {
      var refusedVoided = new Error("vendor-invoices.markVoided: refused — invoice is already voided");
      refusedVoided.code = "VENDOR_INVOICE_TRANSITION_REFUSED";
      throw refusedVoided;
    }
    var ts = _now();
    await query(
      "UPDATE vendor_invoices SET status = 'voided', voided_at = ?1, void_reason = ?2, " +
      "approved_at = NULL, approved_by = NULL, updated_at = ?1 WHERE id = ?3",
      [ts, reason, id],
    );
    return await _hydrated(id);
  }

  // ---- reconcileAgainstPOs ----------------------------------------------
  //
  // Walks the related POs and computes a per-line variance summary:
  //   - SKU-level billed_qty vs received_qty
  //   - SKU-level billed_unit_cost vs PO captured unit_cost
  //   - aggregate: billed_total vs po_received_value (sum of
  //     received_qty * unit_cost on the related POs)
  //
  // Returns:
  //   {
  //     invoice_id, vendor_slug, currency,
  //     billed_total_minor, po_received_value_minor,
  //     variance_minor,        // billed - po_received_value
  //     line_variances: [{ sku?, description, billed_qty, billed_unit_cost,
  //                        po_received_qty, po_unit_cost, qty_variance,
  //                        unit_cost_variance, total_variance }],
  //     unmatched_invoice_lines: [...],
  //     unmatched_po_lines: [...],
  //     po_mismatch:           bool — any related PO not found / wrong vendor
  //   }

  async function reconcileAgainstPOs(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.reconcileAgainstPOs: input object required");
    }
    var id = _id(input.invoice_id, "invoice_id");
    if (!poHandle) {
      var noHandle = new Error("vendor-invoices.reconcileAgainstPOs: opts.purchaseOrders not wired");
      noHandle.code = "VENDOR_INVOICE_NO_PO_HANDLE";
      throw noHandle;
    }
    var invoice = await _hydrated(id);
    if (!invoice) {
      var miss = new Error("vendor-invoices.reconcileAgainstPOs: invoice " + id + " not found");
      miss.code = "VENDOR_INVOICE_NOT_FOUND";
      throw miss;
    }

    // Gather PO lines from every related PO. A single PO can carry
    // multiple lines per SKU only if it has duplicate SKU lines —
    // purchaseOrders refuses that, so per-PO per-SKU is unique. We
    // aggregate ACROSS POs because a vendor invoice consolidating
    // two POs against the same SKU should match the combined
    // received quantity.
    var poBySku        = Object.create(null);   // sku -> { received_qty, unit_cost_minor, currency }
    var poMismatch     = false;
    var unmatchedPoIds = [];
    for (var p = 0; p < invoice.related_po_ids.length; p += 1) {
      var po;
      try { po = await poHandle.getPO(invoice.related_po_ids[p]); }
      catch (_e) { po = null; }
      if (!po) {
        poMismatch = true;
        unmatchedPoIds.push(invoice.related_po_ids[p]);
        continue;
      }
      if (po.vendor_slug !== invoice.vendor_slug) {
        // Vendor mismatch is a strong signal of a wrong PO id pasted
        // into the invoice — surface it as a top-level mismatch.
        poMismatch = true;
        unmatchedPoIds.push(invoice.related_po_ids[p]);
        continue;
      }
      for (var k = 0; k < po.lines.length; k += 1) {
        var pl = po.lines[k];
        if (!poBySku[pl.sku]) {
          poBySku[pl.sku] = { received_qty: 0, unit_cost_minor: pl.unit_cost_minor, currency: pl.currency };
        }
        poBySku[pl.sku].received_qty += Number(pl.quantity_received);
        // If multiple POs cost differently for the same SKU, keep the
        // weighted mean (operator-visible signal that the vendor
        // changed pricing across orders).
        poBySku[pl.sku].unit_cost_minor = pl.unit_cost_minor;
      }
    }

    // Map invoice lines onto PO buckets. A line item without an `sku`
    // (service-line, freight) lands in unmatched_invoice_lines so the
    // operator can decide whether that bill component is a separate
    // line they expected.
    var lineVariances        = [];
    var unmatchedInvoiceLines = [];
    var poMatchedSkus         = Object.create(null);
    var billedTotalMinor      = 0;
    for (var li = 0; li < invoice.line_items.length; li += 1) {
      var il = invoice.line_items[li];
      billedTotalMinor += il.total_minor;
      if (!il.sku) {
        unmatchedInvoiceLines.push({
          description:     il.description,
          billed_qty:      il.quantity,
          billed_unit_cost: il.unit_cost_minor,
          billed_total:    il.total_minor,
        });
        continue;
      }
      var poBucket = poBySku[il.sku];
      if (!poBucket) {
        unmatchedInvoiceLines.push({
          sku:              il.sku,
          description:      il.description,
          billed_qty:       il.quantity,
          billed_unit_cost: il.unit_cost_minor,
          billed_total:     il.total_minor,
        });
        continue;
      }
      poMatchedSkus[il.sku] = true;
      lineVariances.push({
        sku:                il.sku,
        description:        il.description,
        billed_qty:         il.quantity,
        billed_unit_cost:   il.unit_cost_minor,
        po_received_qty:    poBucket.received_qty,
        po_unit_cost:       poBucket.unit_cost_minor,
        qty_variance:       il.quantity - poBucket.received_qty,
        unit_cost_variance: il.unit_cost_minor - poBucket.unit_cost_minor,
        total_variance:     il.total_minor - (poBucket.received_qty * poBucket.unit_cost_minor),
      });
    }

    // PO lines not billed by the invoice (operator captured a PO line
    // that the vendor's invoice didn't include — could be a
    // back-order, could be a missed bill).
    var unmatchedPoLines = [];
    var poBySkuKeys = Object.keys(poBySku);
    for (var psk = 0; psk < poBySkuKeys.length; psk += 1) {
      var sku = poBySkuKeys[psk];
      if (poMatchedSkus[sku]) continue;
      unmatchedPoLines.push({
        sku:              sku,
        po_received_qty:  poBySku[sku].received_qty,
        po_unit_cost:     poBySku[sku].unit_cost_minor,
      });
    }

    var poReceivedValueMinor = 0;
    for (var s = 0; s < poBySkuKeys.length; s += 1) {
      var bucket = poBySku[poBySkuKeys[s]];
      poReceivedValueMinor += bucket.received_qty * bucket.unit_cost_minor;
    }

    return {
      invoice_id:                id,
      vendor_slug:               invoice.vendor_slug,
      currency:                  invoice.currency,
      billed_total_minor:        billedTotalMinor,
      po_received_value_minor:   poReceivedValueMinor,
      variance_minor:            billedTotalMinor - poReceivedValueMinor,
      line_variances:            lineVariances,
      unmatched_invoice_lines:   unmatchedInvoiceLines,
      unmatched_po_lines:        unmatchedPoLines,
      unmatched_po_ids:          unmatchedPoIds,
      po_mismatch:               poMismatch,
    };
  }

  // ---- agingReport ------------------------------------------------------
  //
  // Bucket every unpaid invoice (status received or approved) into
  // standard accounts-payable aging buckets based on (as_of - due_date)
  // days. Disputed invoices are tracked separately so the operator can
  // see how much of the open AP balance is contested.

  async function agingReport(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.agingReport: input object required");
    }
    var asOf = _ts(input.as_of, "as_of");
    var hasVendor = input.vendor_slug != null;
    if (hasVendor) _slug(input.vendor_slug, "vendor_slug");

    var sql, params;
    if (hasVendor) {
      sql = "SELECT * FROM vendor_invoices WHERE vendor_slug = ?1 " +
            "AND status IN ('received', 'approved', 'disputed')";
      params = [input.vendor_slug];
    } else {
      sql = "SELECT * FROM vendor_invoices WHERE status IN ('received', 'approved', 'disputed')";
      params = [];
    }
    var r = await query(sql, params);

    var buckets = {};
    for (var bi = 0; bi < AGING_BUCKETS.length; bi += 1) {
      buckets[AGING_BUCKETS[bi].id] = { count: 0, amount_minor: 0 };
    }
    var disputed = { count: 0, amount_minor: 0 };
    var totalCount = 0;
    var totalAmount = 0;

    for (var i = 0; i < r.rows.length; i += 1) {
      var inv = _hydrate(r.rows[i]);
      var owed = Number(inv.amount_minor);
      // For partial-pay scenarios we'd subtract paid_minor — but
      // partial-pay only applies after status = paid; received /
      // approved / disputed rows always have paid_minor IS NULL.
      if (inv.status === "disputed") {
        disputed.count       += 1;
        disputed.amount_minor += owed;
        // Disputed rows still get aged so the operator sees how long
        // a contested invoice has been sitting.
      }
      var daysPastDue = Math.floor((asOf - inv.due_date) / MS_PER_DAY);
      for (var bk = 0; bk < AGING_BUCKETS.length; bk += 1) {
        var bucket = AGING_BUCKETS[bk];
        if (daysPastDue >= bucket.min && daysPastDue <= bucket.max) {
          buckets[bucket.id].count        += 1;
          buckets[bucket.id].amount_minor += owed;
          break;
        }
      }
      totalCount  += 1;
      totalAmount += owed;
    }

    return {
      as_of:           asOf,
      vendor_slug:     hasVendor ? input.vendor_slug : null,
      buckets:         buckets,
      disputed:        disputed,
      total_count:     totalCount,
      total_amount_minor: totalAmount,
    };
  }

  // ---- metricsForVendor -------------------------------------------------
  //
  // Operator-facing vendor scorecard. For each invoice the vendor
  // issued in [from, to]:
  //   - invoice_count
  //   - billed_total_minor
  //   - paid_total_minor (sum of paid_minor for paid rows)
  //   - on_time_paid_count / late_paid_count (paid_at <= due_date)
  //   - on_time_payment_rate (paid_at <= due_date / paid_count)
  //   - disputed_count
  //   - voided_count
  //   - average_days_to_pay (mean of (paid_at - invoice_date) / day for
  //     paid rows)

  async function metricsForVendor(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("vendor-invoices.metricsForVendor: input object required");
    }
    var vendorSlug = _slug(input.vendor_slug, "vendor_slug");
    var from       = _ts(input.from, "from");
    var to         = _ts(input.to,   "to");
    if (from > to) {
      throw new TypeError("vendor-invoices.metricsForVendor: from must be <= to");
    }
    var r = await query(
      "SELECT * FROM vendor_invoices WHERE vendor_slug = ?1 " +
      "AND invoice_date >= ?2 AND invoice_date <= ?3",
      [vendorSlug, from, to],
    );

    var invoiceCount       = 0;
    var billedTotalMinor   = 0;
    var paidTotalMinor     = 0;
    var paidCount          = 0;
    var onTimePaidCount    = 0;
    var latePaidCount      = 0;
    var disputedCount      = 0;
    var voidedCount        = 0;
    var daysToPaySum       = 0;

    for (var i = 0; i < r.rows.length; i += 1) {
      var inv = _hydrate(r.rows[i]);
      invoiceCount      += 1;
      billedTotalMinor  += Number(inv.amount_minor);
      if (inv.status === "paid") {
        paidCount         += 1;
        paidTotalMinor    += Number(inv.paid_minor);
        if (inv.paid_at <= inv.due_date) onTimePaidCount += 1;
        else                              latePaidCount   += 1;
        daysToPaySum      += Math.floor((inv.paid_at - inv.invoice_date) / MS_PER_DAY);
      } else if (inv.status === "disputed") {
        disputedCount += 1;
      } else if (inv.status === "voided") {
        voidedCount += 1;
      }
    }

    var onTimeRate = paidCount === 0 ? null : (onTimePaidCount / paidCount);
    var avgDaysToPay = paidCount === 0 ? null : (daysToPaySum / paidCount);

    return {
      vendor_slug:           vendorSlug,
      from:                  from,
      to:                    to,
      invoice_count:         invoiceCount,
      billed_total_minor:    billedTotalMinor,
      paid_total_minor:      paidTotalMinor,
      paid_count:            paidCount,
      on_time_paid_count:    onTimePaidCount,
      late_paid_count:       latePaidCount,
      on_time_payment_rate:  onTimeRate,
      disputed_count:        disputedCount,
      voided_count:          voidedCount,
      average_days_to_pay:   avgDaysToPay,
    };
  }

  return {
    INVOICE_STATUSES:         INVOICE_STATUSES.slice(),
    AGING_BUCKETS:            AGING_BUCKETS.slice(),
    MAX_INVOICE_NUMBER_LEN:   MAX_INVOICE_NUMBER_LEN,
    MAX_PAYMENT_REF_LEN:      MAX_PAYMENT_REF_LEN,
    MAX_APPROVED_BY_LEN:      MAX_APPROVED_BY_LEN,
    MAX_REASON_LEN:           MAX_REASON_LEN,
    MAX_LINE_ITEMS:           MAX_LINE_ITEMS,
    MAX_RELATED_POS:          MAX_RELATED_POS,
    MAX_AMOUNT_MINOR:         MAX_AMOUNT_MINOR,

    recordInvoice:            recordInvoice,
    getInvoice:               getInvoice,
    invoicesForVendor:        invoicesForVendor,
    unpaidInvoices:           unpaidInvoices,
    markApproved:             markApproved,
    markPaid:                 markPaid,
    markDisputed:             markDisputed,
    markVoided:               markVoided,
    reconcileAgainstPOs:      reconcileAgainstPOs,
    agingReport:              agingReport,
    metricsForVendor:         metricsForVendor,
  };
}

module.exports = {
  create:           create,
  INVOICE_STATUSES: INVOICE_STATUSES,
  AGING_BUCKETS:    AGING_BUCKETS,
};
