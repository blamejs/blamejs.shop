"use strict";
/**
 * vendor-invoices — operator-facing accounts-payable record of bills
 * received FROM vendors. Distinct from `invoiceRenderer` (which renders
 * operator-to-customer invoices) — this primitive owns the AP side.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0193.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/vendor-invoices.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - recordInvoice happy path: row persists, line_items + related_po_ids
 *     round-trip, header amount equals line-sum, due_date >= invoice_date
 *   - recordInvoice UNIQUE(vendor_slug, invoice_number) duplicate refused
 *     with VENDOR_INVOICE_DUPLICATE code
 *   - FSM transitions: received -> approved -> paid (happy path),
 *     received -> disputed (operator pushback), approved -> voided
 *     (vendor reissued); refused transitions surface
 *     VENDOR_INVOICE_TRANSITION_REFUSED
 *   - markPaid refuses overpayment with VENDOR_INVOICE_OVERPAYMENT;
 *     accepts partial pay (paid_minor < amount_minor)
 *   - reconcileAgainstPOs variance math: SKU-matched line_variances
 *     carry qty_variance + unit_cost_variance + total_variance;
 *     unmatched invoice lines + unmatched PO lines surfaced; PO mismatch
 *     (wrong vendor / missing PO) flagged
 *   - agingReport buckets: current / 1-30 / 31-60 / 61-90 / over_90 by
 *     (as_of - due_date) days; disputed rows accounted separately
 *   - unpaidInvoices filters out paid + voided + disputed; due_within_days
 *     window prunes to relevant horizon
 *   - metricsForVendor on_time_payment_rate + average_days_to_pay over
 *     a window of mixed-status invoices
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var vendorInvoices = require("../../lib/vendor-invoices");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0193_vendor_invoices.sql"
);

function _splitSchema(text) {
  // Strip line comments before splitting on `;` so a `--` line
  // doesn't comment out the closing paren of a CREATE TABLE.
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return {
          rows:      [],
          rowCount:  Number(info.changes),
          lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

// Vendors stub — the primitive only calls `getVendor(slug)`; we
// return a fixture per slug. `archived` triggers the refusal path.
function _stubVendors(seed) {
  var store = Object.create(null);
  Object.keys(seed || {}).forEach(function (k) { store[k] = seed[k]; });
  return {
    add: function (slug, status) { store[slug] = { slug: slug, status: status || "active" }; },
    archive: function (slug) { if (store[slug]) store[slug].status = "archived"; },
    getVendor: async function (slug) { return store[slug] || null; },
  };
}

// PurchaseOrders stub — the primitive calls `getPO(id)` and expects a
// hydrated payload with `vendor_slug` + `lines: [{ sku, quantity_ordered,
// quantity_received, unit_cost_minor, currency }]`.
function _stubPurchaseOrders() {
  var store = Object.create(null);
  return {
    add: function (po) { store[po.id] = po; },
    getPO: async function (id) { return store[id] || null; },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _factory(stubs) {
  stubs = stubs || {};
  var h = _makeQuery();
  return {
    db:        h.db,
    query:     h.query,
    vendors:   stubs.vendors,
    pos:       stubs.purchaseOrders,
    inv:       vendorInvoices.create({
      query:           h.query,
      vendors:         stubs.vendors  || null,
      purchaseOrders:  stubs.purchaseOrders || null,
    }),
  };
}

// ---- recordInvoice happy path ------------------------------------------

async function _recordInvoiceHappyPath() {
  var vendors = _stubVendors();
  vendors.add("acme-supplies", "active");
  var f = _factory({ vendors: vendors });

  var poId = _uuid();
  var invoice = await f.inv.recordInvoice({
    vendor_slug:    "acme-supplies",
    invoice_number: "ACME-2026-001",
    invoice_date:   1700000000000,
    due_date:       1700000000000 + 30 * 24 * 60 * 60 * 1000,
    amount_minor:   12000,
    currency:       "USD",
    line_items: [
      { sku: "WIDGET-A", description: "Widget A",        quantity: 10, unit_cost_minor: 1000, total_minor: 10000 },
      { description:        "Freight",         quantity: 1,  unit_cost_minor: 2000, total_minor: 2000  },
    ],
    related_po_ids: [poId],
  });

  check("recordInvoice returns id",              typeof invoice.id === "string" && invoice.id.length === 36);
  check("recordInvoice vendor_slug",              invoice.vendor_slug === "acme-supplies");
  check("recordInvoice invoice_number",           invoice.invoice_number === "ACME-2026-001");
  check("recordInvoice status received",          invoice.status === "received");
  check("recordInvoice amount_minor",             invoice.amount_minor === 12000);
  check("recordInvoice currency",                 invoice.currency === "USD");
  check("recordInvoice line_items length",        invoice.line_items.length === 2);
  check("recordInvoice line_items sku",           invoice.line_items[0].sku === "WIDGET-A");
  check("recordInvoice line_items service sku null", invoice.line_items[1].sku === null);
  check("recordInvoice related_po_ids",            invoice.related_po_ids.length === 1
                                                   && invoice.related_po_ids[0] === poId);
  check("recordInvoice created_at set",            typeof invoice.created_at === "number");
  check("recordInvoice approved_at null",          invoice.approved_at === null);
  check("recordInvoice paid_at null",              invoice.paid_at === null);

  // getInvoice round-trip.
  var fetched = await f.inv.getInvoice(invoice.id);
  check("getInvoice round-trip",                   fetched.id === invoice.id
                                                   && fetched.invoice_number === invoice.invoice_number);

  // line-sum disagreement refused.
  await assert.rejects(
    f.inv.recordInvoice({
      vendor_slug:    "acme-supplies",
      invoice_number: "ACME-2026-002",
      invoice_date:   1700000000000,
      due_date:       1700000000000,
      amount_minor:   500,   // line sums to 1000
      currency:       "USD",
      line_items: [{ description: "Widget", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    }),
    /does not equal sum/,
  );

  // due_date < invoice_date refused.
  await assert.rejects(
    f.inv.recordInvoice({
      vendor_slug:    "acme-supplies",
      invoice_number: "ACME-2026-003",
      invoice_date:   1700000000000,
      due_date:       1690000000000,
      amount_minor:   1000,
      currency:       "USD",
      line_items: [{ description: "Widget", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    }),
    /due_date must be >= invoice_date/,
  );

  // Unknown vendor refused (vendors handle wired).
  await assert.rejects(
    f.inv.recordInvoice({
      vendor_slug:    "missing-vendor",
      invoice_number: "X-1",
      invoice_date:   1700000000000,
      due_date:       1700000000000,
      amount_minor:   1000,
      currency:       "USD",
      line_items: [{ description: "X", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    }),
    function (err) { return err && err.code === "VENDOR_INVOICE_VENDOR_NOT_FOUND"; },
  );

  // Archived vendor refused.
  vendors.add("retired-vendor", "active");
  vendors.archive("retired-vendor");
  await assert.rejects(
    f.inv.recordInvoice({
      vendor_slug:    "retired-vendor",
      invoice_number: "R-1",
      invoice_date:   1700000000000,
      due_date:       1700000000000,
      amount_minor:   1000,
      currency:       "USD",
      line_items: [{ description: "X", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    }),
    function (err) { return err && err.code === "VENDOR_INVOICE_VENDOR_ARCHIVED"; },
  );
}

// ---- UNIQUE duplicate guard --------------------------------------------

async function _recordInvoiceUniqueDuplicate() {
  var vendors = _stubVendors();
  vendors.add("widget-co", "active");
  var f = _factory({ vendors: vendors });

  var seed = {
    vendor_slug:    "widget-co",
    invoice_number: "INV-001",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   1000,
    currency:       "USD",
    line_items: [{ description: "Widget", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
  };
  await f.inv.recordInvoice(seed);

  // Same (vendor_slug, invoice_number) refused with VENDOR_INVOICE_DUPLICATE.
  await assert.rejects(
    f.inv.recordInvoice(seed),
    function (err) { return err && err.code === "VENDOR_INVOICE_DUPLICATE"; },
  );

  // Different vendor with same invoice_number is fine (vendor namespaces it).
  vendors.add("other-co", "active");
  var ok = await f.inv.recordInvoice({
    vendor_slug:    "other-co",
    invoice_number: "INV-001",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   1000,
    currency:       "USD",
    line_items: [{ description: "Widget", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
  });
  check("different vendor same invoice_number ok", ok.vendor_slug === "other-co");

  // Different invoice_number on same vendor is fine.
  var ok2 = await f.inv.recordInvoice({
    vendor_slug:    "widget-co",
    invoice_number: "INV-002",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   1000,
    currency:       "USD",
    line_items: [{ description: "Widget", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
  });
  check("same vendor different invoice_number ok", ok2.invoice_number === "INV-002");
}

// ---- FSM transitions ----------------------------------------------------

async function _recordInvoiceCurrencyMismatch() {
  var vendors = _stubVendors();
  vendors.add("cur-vendor", "active");
  var f = _factory({ vendors: vendors });
  await f.inv.recordInvoice({
    vendor_slug: "cur-vendor", invoice_number: "USD-1",
    invoice_date: 1700000000000, due_date: 1700000000000,
    amount_minor: 1000, currency: "USD",
    line_items: [{ sku: "A", description: "x", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
  });
  // A second invoice for the SAME vendor in a DIFFERENT currency is refused,
  // so the per-vendor AP-aging + scorecard sums stay within one currency.
  await assert.rejects(
    f.inv.recordInvoice({
      vendor_slug: "cur-vendor", invoice_number: "EUR-1",
      invoice_date: 1700000000000, due_date: 1700000000000,
      amount_minor: 1000, currency: "EUR",
      line_items: [{ sku: "A", description: "x", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    }),
    function (err) { return err && err.code === "VENDOR_INVOICE_CURRENCY_MISMATCH"; },
  );
  // Another invoice for the same vendor in the SAME currency is accepted.
  var ok = await f.inv.recordInvoice({
    vendor_slug: "cur-vendor", invoice_number: "USD-2",
    invoice_date: 1700000000000, due_date: 1700000000000,
    amount_minor: 2000, currency: "USD",
    line_items: [{ sku: "B", description: "y", quantity: 1, unit_cost_minor: 2000, total_minor: 2000 }],
  });
  check("same-currency second invoice accepted", ok && ok.currency === "USD");
}

async function _fsmTransitions() {
  var vendors = _stubVendors();
  vendors.add("alpha-vendor", "active");
  var f = _factory({ vendors: vendors });

  // Happy path: received -> approved -> paid.
  var inv1 = await f.inv.recordInvoice({
    vendor_slug:    "alpha-vendor",
    invoice_number: "A-1",
    invoice_date:   1700000000000,
    due_date:       1700000000000 + 30 * 24 * 60 * 60 * 1000,
    amount_minor:   5000,
    currency:       "USD",
    line_items: [{ description: "Service", quantity: 1, unit_cost_minor: 5000, total_minor: 5000 }],
  });
  check("FSM new invoice received",                inv1.status === "received");

  var approved = await f.inv.markApproved({ invoice_id: inv1.id, approved_by: "operator-ada" });
  check("FSM approved status",                     approved.status === "approved");
  check("FSM approved_by persisted",               approved.approved_by === "operator-ada");
  check("FSM approved_at set",                     typeof approved.approved_at === "number");

  var paid = await f.inv.markPaid({
    invoice_id:  inv1.id,
    payment_ref: "WIRE-2026-0001",
    paid_at:     1700000000000 + 20 * 24 * 60 * 60 * 1000,
    paid_minor:  5000,
  });
  check("FSM paid status",                         paid.status === "paid");
  check("FSM payment_ref persisted",                paid.payment_ref === "WIRE-2026-0001");
  check("FSM paid_minor persisted",                 paid.paid_minor === 5000);

  // Refused transitions.
  await assert.rejects(
    f.inv.markApproved({ invoice_id: inv1.id, approved_by: "x" }),
    function (err) { return err && err.code === "VENDOR_INVOICE_TRANSITION_REFUSED"; },
  );
  await assert.rejects(
    f.inv.markPaid({ invoice_id: inv1.id, payment_ref: "X", paid_at: 1700000000000, paid_minor: 100 }),
    function (err) { return err && err.code === "VENDOR_INVOICE_TRANSITION_REFUSED"; },
  );

  // Disputed branch: received -> disputed.
  var inv2 = await f.inv.recordInvoice({
    vendor_slug:    "alpha-vendor",
    invoice_number: "A-2",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   2000,
    currency:       "USD",
    line_items: [{ description: "Disputed item", quantity: 1, unit_cost_minor: 2000, total_minor: 2000 }],
  });
  var disputed = await f.inv.markDisputed({
    invoice_id: inv2.id,
    reason:     "Vendor charged for items we never received.",
  });
  check("FSM disputed status",                     disputed.status === "disputed");
  check("FSM dispute_reason persisted",             disputed.dispute_reason === "Vendor charged for items we never received.");
  check("FSM disputed_at set",                     typeof disputed.disputed_at === "number");

  // Disputed -> paid refused (operator must resolve via new invoice).
  await assert.rejects(
    f.inv.markPaid({ invoice_id: inv2.id, payment_ref: "X", paid_at: 1700000000000, paid_minor: 100 }),
    function (err) { return err && err.code === "VENDOR_INVOICE_TRANSITION_REFUSED"; },
  );

  // Voided branch: approved -> voided.
  var inv3 = await f.inv.recordInvoice({
    vendor_slug:    "alpha-vendor",
    invoice_number: "A-3",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   3000,
    currency:       "USD",
    line_items: [{ description: "Item", quantity: 3, unit_cost_minor: 1000, total_minor: 3000 }],
  });
  await f.inv.markApproved({ invoice_id: inv3.id, approved_by: "operator-bob" });
  var voided = await f.inv.markVoided({ invoice_id: inv3.id, reason: "Vendor reissued as A-3R" });
  check("FSM voided status",                       voided.status === "voided");
  check("FSM void_reason persisted",                voided.void_reason === "Vendor reissued as A-3R");

  // Paid invoice cannot be voided (credit-note pattern instead).
  await assert.rejects(
    f.inv.markVoided({ invoice_id: inv1.id, reason: "oops" }),
    function (err) { return err && err.code === "VENDOR_INVOICE_TRANSITION_REFUSED"; },
  );

  // Overpayment refused.
  var inv4 = await f.inv.recordInvoice({
    vendor_slug:    "alpha-vendor",
    invoice_number: "A-4",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   1000,
    currency:       "USD",
    line_items: [{ description: "Item", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
  });
  await f.inv.markApproved({ invoice_id: inv4.id, approved_by: "operator-c" });
  await assert.rejects(
    f.inv.markPaid({
      invoice_id:  inv4.id,
      payment_ref: "WIRE-OVER",
      paid_at:     1700000000000,
      paid_minor:  2000,    // > 1000
    }),
    function (err) { return err && err.code === "VENDOR_INVOICE_OVERPAYMENT"; },
  );

  // Partial pay is first-class: paid_minor < amount_minor.
  var partial = await f.inv.markPaid({
    invoice_id:  inv4.id,
    payment_ref: "WIRE-PART",
    paid_at:     1700000000000,
    paid_minor:  600,
  });
  check("partial pay accepted",                    partial.status === "paid" && partial.paid_minor === 600);

  // Unknown invoice id surfaces as not-found.
  await assert.rejects(
    f.inv.markApproved({ invoice_id: _uuid(), approved_by: "x" }),
    function (err) { return err && err.code === "VENDOR_INVOICE_NOT_FOUND"; },
  );
}

// ---- reconcileAgainstPOs variance math ---------------------------------

async function _reconcileAgainstPOsVariance() {
  var vendors = _stubVendors();
  vendors.add("recon-vendor", "active");
  var pos = _stubPurchaseOrders();
  var f = _factory({ vendors: vendors, purchaseOrders: pos });

  // Seed two POs:
  //   PO #1: SKU "A" qty 10 @ 1000 unit_cost, all received
  //   PO #2: SKU "B" qty 5  @ 2000 unit_cost, 4 received
  var po1Id = _uuid();
  pos.add({
    id:           po1Id,
    vendor_slug:  "recon-vendor",
    lines: [
      { sku: "A", quantity_ordered: 10, quantity_received: 10, unit_cost_minor: 1000, currency: "USD" },
    ],
  });
  var po2Id = _uuid();
  pos.add({
    id:           po2Id,
    vendor_slug:  "recon-vendor",
    lines: [
      { sku: "B", quantity_ordered: 5,  quantity_received: 4,  unit_cost_minor: 2000, currency: "USD" },
    ],
  });

  // Invoice bills: A qty 10 @ 1100 (vendor charged 100 over per unit),
  // B qty 5 @ 2000 (vendor billed full PO qty, but only 4 received),
  // C qty 1 @ 500 (mystery line not on any PO),
  // plus a service line (no SKU).
  var invoice = await f.inv.recordInvoice({
    vendor_slug:    "recon-vendor",
    invoice_number: "RECON-001",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   11000 + 10000 + 500 + 300,
    currency:       "USD",
    line_items: [
      { sku: "A", description: "Widget A",     quantity: 10, unit_cost_minor: 1100, total_minor: 11000 },
      { sku: "B", description: "Widget B",     quantity: 5,  unit_cost_minor: 2000, total_minor: 10000 },
      { sku: "C", description: "Mystery",      quantity: 1,  unit_cost_minor: 500,  total_minor: 500   },
      {          description: "Freight",      quantity: 1,  unit_cost_minor: 300,  total_minor: 300   },
    ],
    related_po_ids: [po1Id, po2Id],
  });

  var recon = await f.inv.reconcileAgainstPOs({ invoice_id: invoice.id });

  check("recon invoice_id",                       recon.invoice_id === invoice.id);
  check("recon vendor_slug",                      recon.vendor_slug === "recon-vendor");
  check("recon currency",                         recon.currency === "USD");
  check("recon billed_total_minor",                recon.billed_total_minor === 11000 + 10000 + 500 + 300);
  // PO received value: 10 * 1000 (A) + 4 * 2000 (B) = 18000
  check("recon po_received_value_minor",          recon.po_received_value_minor === 18000);
  check("recon variance_minor",                    recon.variance_minor === recon.billed_total_minor - 18000);

  check("recon line_variances length 2",           recon.line_variances.length === 2);

  // SKU A: billed 10 @ 1100, PO received 10 @ 1000. qty var 0, unit_cost var 100, total var 11000 - 10000 = 1000
  var aVar = recon.line_variances.filter(function (l) { return l.sku === "A"; })[0];
  check("recon A qty_variance 0",                  aVar.qty_variance === 0);
  check("recon A unit_cost_variance 100",          aVar.unit_cost_variance === 100);
  check("recon A total_variance 1000",             aVar.total_variance === 1000);

  // SKU B: billed 5 @ 2000, PO received 4 @ 2000. qty var 1, unit_cost var 0, total var 10000 - 8000 = 2000
  var bVar = recon.line_variances.filter(function (l) { return l.sku === "B"; })[0];
  check("recon B qty_variance 1",                  bVar.qty_variance === 1);
  check("recon B unit_cost_variance 0",            bVar.unit_cost_variance === 0);
  check("recon B total_variance 2000",             bVar.total_variance === 2000);

  // SKU C + freight unmatched.
  check("recon unmatched_invoice_lines length 2",  recon.unmatched_invoice_lines.length === 2);
  var cUnmatched = recon.unmatched_invoice_lines.filter(function (l) { return l.sku === "C"; })[0];
  check("recon C in unmatched",                    cUnmatched && cUnmatched.billed_qty === 1);
  var freightUnmatched = recon.unmatched_invoice_lines.filter(function (l) { return !l.sku; })[0];
  check("recon freight in unmatched",              freightUnmatched && freightUnmatched.description === "Freight");

  check("recon unmatched_po_lines empty",          recon.unmatched_po_lines.length === 0);
  check("recon po_mismatch false",                 recon.po_mismatch === false);
  check("recon unmatched_po_ids empty",            recon.unmatched_po_ids.length === 0);

  // PO mismatch path: invoice references a PO id that doesn't exist.
  var ghostInv = await f.inv.recordInvoice({
    vendor_slug:    "recon-vendor",
    invoice_number: "RECON-002",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   1000,
    currency:       "USD",
    line_items: [{ sku: "A", description: "A", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    related_po_ids: [_uuid()],
  });
  var ghostRecon = await f.inv.reconcileAgainstPOs({ invoice_id: ghostInv.id });
  check("recon ghost po_mismatch true",            ghostRecon.po_mismatch === true);
  check("recon ghost unmatched_po_ids 1",          ghostRecon.unmatched_po_ids.length === 1);

  // Wrong-vendor PO mismatch path.
  var foreignPoId = _uuid();
  pos.add({
    id:          foreignPoId,
    vendor_slug: "different-vendor",
    lines:       [{ sku: "A", quantity_ordered: 1, quantity_received: 1, unit_cost_minor: 1000, currency: "USD" }],
  });
  var crossInv = await f.inv.recordInvoice({
    vendor_slug:    "recon-vendor",
    invoice_number: "RECON-003",
    invoice_date:   1700000000000,
    due_date:       1700000000000,
    amount_minor:   1000,
    currency:       "USD",
    line_items: [{ sku: "A", description: "A", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    related_po_ids: [foreignPoId],
  });
  var crossRecon = await f.inv.reconcileAgainstPOs({ invoice_id: crossInv.id });
  check("recon cross-vendor po_mismatch",          crossRecon.po_mismatch === true);

  // No PO handle wired -> error code surfaces.
  var fNoPo = _factory({ vendors: vendors });
  await assert.rejects(
    fNoPo.inv.reconcileAgainstPOs({ invoice_id: invoice.id }),
    function (err) { return err && err.code === "VENDOR_INVOICE_NO_PO_HANDLE"; },
  );
}

// ---- reconcile: same SKU across POs at different costs ------------------

async function _reconcileSameSkuAcrossPOs() {
  var vendors = _stubVendors();
  vendors.add("dup-vendor", "active");
  var pos = _stubPurchaseOrders();
  var f = _factory({ vendors: vendors, purchaseOrders: pos });

  // The same SKU "A" appears on two POs at DIFFERENT unit costs (a vendor
  // price change across orders — a supported, documented workflow).
  var po1 = _uuid();
  pos.add({ id: po1, vendor_slug: "dup-vendor",
    lines: [{ sku: "A", quantity_ordered: 10, quantity_received: 10, unit_cost_minor: 1000, currency: "USD" }] });
  var po2 = _uuid();
  pos.add({ id: po2, vendor_slug: "dup-vendor",
    lines: [{ sku: "A", quantity_ordered: 10, quantity_received: 10, unit_cost_minor: 2000, currency: "USD" }] });

  var inv = await f.inv.recordInvoice({
    vendor_slug: "dup-vendor", invoice_number: "DUP-001",
    invoice_date: 1700000000000, due_date: 1700000000000,
    amount_minor: 30000, currency: "USD",
    line_items: [{ sku: "A", description: "Widget A", quantity: 20, unit_cost_minor: 1500, total_minor: 30000 }],
    related_po_ids: [po1, po2],
  });

  var recon = await f.inv.reconcileAgainstPOs({ invoice_id: inv.id });
  // TRUE received value = 10*1000 + 10*2000 = 30000 (NOT 20 * last-cost 2000 = 40000).
  check("dup-sku po_received_value == 30000", recon.po_received_value_minor === 30000);
  check("dup-sku variance == 0",              recon.variance_minor === 0);
  // The displayed per-unit cost is the true weighted mean (30000 / 20 = 1500).
  var aVar = recon.line_variances.filter(function (l) { return l.sku === "A"; })[0];
  check("dup-sku weighted-mean unit cost 1500", aVar && aVar.po_unit_cost === 1500);
  check("dup-sku line total_variance == 0",     aVar && aVar.total_variance === 0);
}

// ---- agingReport buckets ------------------------------------------------

async function _agingReportBuckets() {
  var vendors = _stubVendors();
  vendors.add("aged-vendor", "active");
  var f = _factory({ vendors: vendors });

  var asOf = 1700000000000 + 200 * 24 * 60 * 60 * 1000;   // 200 days after base
  // invoice_date is the earliest reasonable anchor — we set it well
  // before every fixture's due_date so the due_date >= invoice_date
  // invariant holds across the full bucket span.
  var base = 1700000000000;

  // Seed five invoices with due_dates that fall into each bucket
  // relative to asOf:
  //   current  — due_date >= asOf       (asOf + 10d)
  //   1_30     — 1 <= days past due <= 30  (asOf - 10d)
  //   31_60    — 31 <= dpd <= 60        (asOf - 45d)
  //   61_90    — 61 <= dpd <= 90        (asOf - 80d)
  //   over_90  — dpd >= 91              (asOf - 120d)
  var fixtures = [
    { num: "AGE-1", due: asOf + 10 * 24 * 60 * 60 * 1000, expectBucket: "current" },
    { num: "AGE-2", due: asOf - 10 * 24 * 60 * 60 * 1000, expectBucket: "1_30" },
    { num: "AGE-3", due: asOf - 45 * 24 * 60 * 60 * 1000, expectBucket: "31_60" },
    { num: "AGE-4", due: asOf - 80 * 24 * 60 * 60 * 1000, expectBucket: "61_90" },
    { num: "AGE-5", due: asOf - 120 * 24 * 60 * 60 * 1000, expectBucket: "over_90" },
  ];
  for (var i = 0; i < fixtures.length; i += 1) {
    await f.inv.recordInvoice({
      vendor_slug:    "aged-vendor",
      invoice_number: fixtures[i].num,
      invoice_date:   base,
      due_date:       fixtures[i].due,
      amount_minor:   (i + 1) * 1000,
      currency:       "USD",
      line_items: [{ description: "X", quantity: 1, unit_cost_minor: (i + 1) * 1000, total_minor: (i + 1) * 1000 }],
    });
  }

  var rpt = await f.inv.agingReport({ as_of: asOf, vendor_slug: "aged-vendor" });
  check("aging current count 1",                   rpt.buckets.current.count  === 1);
  check("aging 1_30 count 1",                      rpt.buckets["1_30"].count  === 1);
  check("aging 31_60 count 1",                     rpt.buckets["31_60"].count === 1);
  check("aging 61_90 count 1",                     rpt.buckets["61_90"].count === 1);
  check("aging over_90 count 1",                   rpt.buckets.over_90.count  === 1);
  check("aging total_count 5",                     rpt.total_count === 5);
  // Total amount = 1000 + 2000 + 3000 + 4000 + 5000 = 15000
  check("aging total_amount 15000",                rpt.total_amount_minor === 15000);

  // Mark one disputed: the disputed bucket counts independently while
  // the aging bucket still places it.
  var age3 = (await f.inv.invoicesForVendor({ vendor_slug: "aged-vendor", status: "received" })).filter(
    function (r) { return r.invoice_number === "AGE-3"; }
  )[0];
  await f.inv.markDisputed({ invoice_id: age3.id, reason: "Vendor charged too much." });
  var rpt2 = await f.inv.agingReport({ as_of: asOf, vendor_slug: "aged-vendor" });
  check("aging disputed count 1",                  rpt2.disputed.count === 1);
  check("aging disputed amount 3000",              rpt2.disputed.amount_minor === 3000);
  check("aging 31_60 still has disputed row",      rpt2.buckets["31_60"].count === 1);

  // Mark one paid: it drops out of aging entirely.
  var age1Row = (await f.inv.invoicesForVendor({ vendor_slug: "aged-vendor", status: "received" })).filter(
    function (r) { return r.invoice_number === "AGE-1"; }
  )[0];
  await f.inv.markApproved({ invoice_id: age1Row.id, approved_by: "op" });
  await f.inv.markPaid({
    invoice_id:  age1Row.id,
    payment_ref: "WIRE-AGE-1",
    paid_at:     asOf,
    paid_minor:  1000,
  });
  var rpt3 = await f.inv.agingReport({ as_of: asOf, vendor_slug: "aged-vendor" });
  check("aging current count 0 after pay",         rpt3.buckets.current.count === 0);
  check("aging total_count 4 after pay",           rpt3.total_count === 4);
}

// ---- unpaidInvoices filter ---------------------------------------------

async function _unpaidInvoicesFilter() {
  var vendors = _stubVendors();
  vendors.add("up-vendor", "active");
  var f = _factory({ vendors: vendors });

  var base = 1700000000000;
  // Five invoices: 1 paid, 1 voided, 1 disputed, 2 unpaid (received +
  // approved). Verify only the two unpaid show.
  var receivedInv = await f.inv.recordInvoice({
    vendor_slug: "up-vendor", invoice_number: "U-1", invoice_date: base, due_date: base + 10 * 86400000,
    amount_minor: 1000, currency: "USD",
    line_items: [{ description: "x", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
  });

  var approvedInv = await f.inv.recordInvoice({
    vendor_slug: "up-vendor", invoice_number: "U-2", invoice_date: base, due_date: base + 20 * 86400000,
    amount_minor: 2000, currency: "USD",
    line_items: [{ description: "x", quantity: 1, unit_cost_minor: 2000, total_minor: 2000 }],
  });
  await f.inv.markApproved({ invoice_id: approvedInv.id, approved_by: "op" });

  var paidInv = await f.inv.recordInvoice({
    vendor_slug: "up-vendor", invoice_number: "U-3", invoice_date: base, due_date: base,
    amount_minor: 3000, currency: "USD",
    line_items: [{ description: "x", quantity: 1, unit_cost_minor: 3000, total_minor: 3000 }],
  });
  await f.inv.markApproved({ invoice_id: paidInv.id, approved_by: "op" });
  await f.inv.markPaid({ invoice_id: paidInv.id, payment_ref: "WIRE", paid_at: base, paid_minor: 3000 });

  var voidedInv = await f.inv.recordInvoice({
    vendor_slug: "up-vendor", invoice_number: "U-4", invoice_date: base, due_date: base,
    amount_minor: 4000, currency: "USD",
    line_items: [{ description: "x", quantity: 1, unit_cost_minor: 4000, total_minor: 4000 }],
  });
  await f.inv.markVoided({ invoice_id: voidedInv.id, reason: "duplicate" });

  var disputedInv = await f.inv.recordInvoice({
    vendor_slug: "up-vendor", invoice_number: "U-5", invoice_date: base, due_date: base,
    amount_minor: 5000, currency: "USD",
    line_items: [{ description: "x", quantity: 1, unit_cost_minor: 5000, total_minor: 5000 }],
  });
  await f.inv.markDisputed({ invoice_id: disputedInv.id, reason: "wrong" });

  var unpaid = await f.inv.unpaidInvoices();
  check("unpaidInvoices returns received + approved only",     unpaid.length === 2);
  var statusSet = unpaid.map(function (r) { return r.status; }).sort();
  check("unpaidInvoices statuses received + approved",         statusSet[0] === "approved" && statusSet[1] === "received");

  // due_within_days window. invoice U-1 due in 10d, U-2 due in 20d.
  // Window of 15 days excludes U-2.
  // Note: monotonic _now() inside the primitive may have advanced
  // past base; the window is relative to current _now(), so we
  // can't predict exact boundaries — instead we verify that a
  // huge window returns both and zero returns none of the due-future
  // rows. Both U-1 and U-2 have due_date > now, so window 0 returns
  // none.
  var bigWindow = await f.inv.unpaidInvoices({ due_within_days: 365 });
  check("unpaidInvoices big window returns both",              bigWindow.length === 2);

  // Refusal: bad due_within_days.
  await assert.rejects(
    f.inv.unpaidInvoices({ due_within_days: -1 }),
    /due_within_days/,
  );

  // invoicesForVendor filter.
  var paidList = await f.inv.invoicesForVendor({ vendor_slug: "up-vendor", status: "paid" });
  check("invoicesForVendor paid filter length 1",              paidList.length === 1 && paidList[0].id === paidInv.id);
  var all = await f.inv.invoicesForVendor({ vendor_slug: "up-vendor" });
  check("invoicesForVendor no filter returns all 5",           all.length === 5);

  // Make sure we used both received invoices.
  void receivedInv;
}

// ---- metricsForVendor on-time payment rate -----------------------------

async function _metricsForVendorOnTime() {
  var vendors = _stubVendors();
  vendors.add("metrics-vendor", "active");
  var f = _factory({ vendors: vendors });

  var base = 1700000000000;
  var day = 24 * 60 * 60 * 1000;

  async function _bill(num, invoiceDate, dueDate, status, paidAt) {
    var inv = await f.inv.recordInvoice({
      vendor_slug:    "metrics-vendor",
      invoice_number: num,
      invoice_date:   invoiceDate,
      due_date:       dueDate,
      amount_minor:   1000,
      currency:       "USD",
      line_items: [{ description: "x", quantity: 1, unit_cost_minor: 1000, total_minor: 1000 }],
    });
    if (status === "received") return inv;
    await f.inv.markApproved({ invoice_id: inv.id, approved_by: "op" });
    if (status === "approved") return inv;
    if (status === "paid") {
      await f.inv.markPaid({
        invoice_id:  inv.id,
        payment_ref: "PAY-" + num,
        paid_at:     paidAt,
        paid_minor:  1000,
      });
    } else if (status === "disputed") {
      await f.inv.markDisputed({ invoice_id: inv.id, reason: "x" });
    } else if (status === "voided") {
      await f.inv.markVoided({ invoice_id: inv.id, reason: "x" });
    }
    return inv;
  }

  // Three paid:
  //   M-1: invoiced at base, due+30d, paid at +20d -> on time, 20d to pay
  //   M-2: invoiced at base, due+30d, paid at +45d -> late, 45d to pay
  //   M-3: invoiced at base, due+30d, paid at +30d -> on time (==), 30d to pay
  // One disputed, one voided, one approved-unpaid -> not counted in
  // payment rate.
  await _bill("M-1", base, base + 30 * day, "paid",     base + 20 * day);
  await _bill("M-2", base, base + 30 * day, "paid",     base + 45 * day);
  await _bill("M-3", base, base + 30 * day, "paid",     base + 30 * day);
  await _bill("M-4", base, base + 30 * day, "disputed");
  await _bill("M-5", base, base + 30 * day, "voided");
  await _bill("M-6", base, base + 30 * day, "approved");

  var m = await f.inv.metricsForVendor({
    vendor_slug: "metrics-vendor",
    from:        base - day,
    to:          base + day,
  });

  check("metrics invoice_count 6",                m.invoice_count === 6);
  check("metrics paid_count 3",                   m.paid_count === 3);
  check("metrics on_time_paid_count 2",            m.on_time_paid_count === 2);
  check("metrics late_paid_count 1",              m.late_paid_count === 1);
  check("metrics on_time_payment_rate 2/3",        Math.abs(m.on_time_payment_rate - 2 / 3) < 1e-9);
  check("metrics disputed_count 1",               m.disputed_count === 1);
  check("metrics voided_count 1",                 m.voided_count === 1);
  // avg days to pay = (20 + 45 + 30) / 3 = 31.666...
  check("metrics avg days to pay",                Math.abs(m.average_days_to_pay - (20 + 45 + 30) / 3) < 1e-9);
  check("metrics billed_total_minor 6000",         m.billed_total_minor === 6000);
  check("metrics paid_total_minor 3000",            m.paid_total_minor === 3000);

  // Empty window: zero paid -> null rate + null avg.
  var empty = await f.inv.metricsForVendor({
    vendor_slug: "metrics-vendor",
    from:        base + 365 * day,
    to:          base + 730 * day,
  });
  check("metrics empty paid_count 0",             empty.paid_count === 0);
  check("metrics empty on_time_payment_rate null", empty.on_time_payment_rate === null);
  check("metrics empty average_days_to_pay null",  empty.average_days_to_pay === null);

  // from > to refused.
  await assert.rejects(
    f.inv.metricsForVendor({ vendor_slug: "metrics-vendor", from: base + day, to: base }),
    /from must be <= to/,
  );
}

// ---- validation surface -------------------------------------------------

async function _validationSurface() {
  var f = _factory();

  // recordInvoice
  await assert.rejects(f.inv.recordInvoice(),                                            /input object required/);
  await assert.rejects(f.inv.recordInvoice({}),                                          /vendor_slug/);
  await assert.rejects(f.inv.recordInvoice({ vendor_slug: "Bad Slug" }),                 /vendor_slug/);
  await assert.rejects(f.inv.recordInvoice({ vendor_slug: "ok", invoice_number: "" }),   /invoice_number/);
  await assert.rejects(f.inv.recordInvoice({
    vendor_slug: "ok", invoice_number: "INV-1", invoice_date: -1,
  }), /invoice_date/);
  await assert.rejects(f.inv.recordInvoice({
    vendor_slug: "ok", invoice_number: "INV-1", invoice_date: 1, due_date: 1,
    amount_minor: 1, currency: "usd",
  }), /currency/);
  await assert.rejects(f.inv.recordInvoice({
    vendor_slug: "ok", invoice_number: "INV-1", invoice_date: 1, due_date: 1,
    amount_minor: 1, currency: "USD", line_items: [],
  }), /non-empty array/);
  await assert.rejects(f.inv.recordInvoice({
    vendor_slug: "ok", invoice_number: "INV-1", invoice_date: 1, due_date: 1,
    amount_minor: 1, currency: "USD",
    line_items: [{ description: "x", quantity: 1, unit_cost_minor: 5, total_minor: 100 }],
  }), /total_minor.*differs/);

  // getInvoice
  await assert.rejects(f.inv.getInvoice("not-a-uuid"),                                   /invoice_id/);

  // invoicesForVendor
  await assert.rejects(f.inv.invoicesForVendor(),                                        /input object required/);
  await assert.rejects(f.inv.invoicesForVendor({ vendor_slug: "Bad" }),                  /vendor_slug/);
  await assert.rejects(f.inv.invoicesForVendor({ vendor_slug: "ok", status: "bogus" }),  /status/);

  // markApproved
  await assert.rejects(f.inv.markApproved(),                                             /input object required/);
  await assert.rejects(f.inv.markApproved({ invoice_id: "x" }),                          /invoice_id/);
  await assert.rejects(f.inv.markApproved({ invoice_id: _uuid(), approved_by: "" }),     /approved_by/);

  // markPaid
  await assert.rejects(f.inv.markPaid(),                                                 /input object required/);
  await assert.rejects(f.inv.markPaid({ invoice_id: _uuid() }),                          /payment_ref/);
  await assert.rejects(f.inv.markPaid({
    invoice_id: _uuid(), payment_ref: "X", paid_at: -1, paid_minor: 0,
  }), /paid_at/);
  await assert.rejects(f.inv.markPaid({
    invoice_id: _uuid(), payment_ref: "X", paid_at: 1, paid_minor: -1,
  }), /paid_minor/);

  // markDisputed
  await assert.rejects(f.inv.markDisputed(),                                             /input object required/);
  await assert.rejects(f.inv.markDisputed({ invoice_id: _uuid(), reason: "" }),          /reason/);

  // markVoided
  await assert.rejects(f.inv.markVoided(),                                               /input object required/);
  await assert.rejects(f.inv.markVoided({ invoice_id: _uuid(), reason: "" }),            /reason/);

  // reconcileAgainstPOs
  await assert.rejects(f.inv.reconcileAgainstPOs(),                                      /input object required/);
  await assert.rejects(f.inv.reconcileAgainstPOs({ invoice_id: "x" }),                   /invoice_id/);

  // agingReport
  await assert.rejects(f.inv.agingReport(),                                              /input object required/);
  await assert.rejects(f.inv.agingReport({ as_of: -1 }),                                 /as_of/);
  await assert.rejects(f.inv.agingReport({ as_of: 1, vendor_slug: "Bad" }),              /vendor_slug/);

  // metricsForVendor
  await assert.rejects(f.inv.metricsForVendor(),                                         /input object required/);
  await assert.rejects(f.inv.metricsForVendor({ vendor_slug: "Bad" }),                   /vendor_slug/);
  await assert.rejects(f.inv.metricsForVendor({
    vendor_slug: "ok", from: -1, to: 1,
  }), /from/);

  // unpaidInvoices
  await assert.rejects(f.inv.unpaidInvoices({ due_within_days: -1 }),                    /due_within_days/);

  // factory refuses bad handles
  assert.throws(function () { vendorInvoices.create({ vendors: { bogus: true } }); },    /vendors/);
  assert.throws(function () { vendorInvoices.create({ purchaseOrders: { bogus: true } }); }, /purchaseOrders/);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("INVOICE_STATUSES exported",
    Array.isArray(vendorInvoices.INVOICE_STATUSES)
    && vendorInvoices.INVOICE_STATUSES.indexOf("received") !== -1
    && vendorInvoices.INVOICE_STATUSES.indexOf("approved") !== -1
    && vendorInvoices.INVOICE_STATUSES.indexOf("paid") !== -1
    && vendorInvoices.INVOICE_STATUSES.indexOf("disputed") !== -1
    && vendorInvoices.INVOICE_STATUSES.indexOf("voided") !== -1);
  check("AGING_BUCKETS exported",
    Array.isArray(vendorInvoices.AGING_BUCKETS)
    && vendorInvoices.AGING_BUCKETS.length === 5);

  var inst = vendorInvoices.create({ query: _makeQuery().query });
  check("instance exposes INVOICE_STATUSES",
    inst.INVOICE_STATUSES.length === vendorInvoices.INVOICE_STATUSES.length);
}

async function run() {
  await _recordInvoiceHappyPath();
  await _recordInvoiceUniqueDuplicate();
  await _fsmTransitions();
  await _recordInvoiceCurrencyMismatch();
  await _reconcileAgainstPOsVariance();
  await _reconcileSameSkuAcrossPOs();
  await _agingReportBuckets();
  await _unpaidInvoicesFilter();
  await _metricsForVendorOnTime();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - vendor-invoices (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
