"use strict";
/**
 * purchase-orders — operator-facing record of goods ordered FROM a
 * vendor; FSM beats from draft through closed; receipt cascade into
 * inventoryReceive at receipt time.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0099.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/purchase-orders.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - createDraft happy path (vendor existence check via stubbed
 *     vendors handle, lines normalised, ids hydrated, status=draft)
 *     + linesForPO read
 *   - FSM transitions: draft -> submitted -> confirmed ->
 *     partially_received -> received -> closed
 *   - recordPartialReceipt composes inventoryReceive.draft + .apply
 *     via stub (call shape captured + asserted)
 *   - closePO refuses unless every line fully received
 *   - cancelPO from draft (allowed) vs from confirmed (refused)
 *   - update only allowed on draft status (notes / expected_delivery
 *     / wholesale lines replace); post-submit update refused
 *   - factory + input validation refusals (bad handles, missing
 *     input, archived vendor, bad slug / sku / qty / unit_cost,
 *     duplicate sku, over-receipt, unknown sku on receipt)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var purchaseOrders = require("../../lib/purchase-orders");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0099_purchase_orders.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  var queryFn = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  queryFn.__db = db;
  return queryFn;
}

// Vendors stub. The PO primitive only calls `getVendor(slug)`; we
// record calls and return a fixture per slug. `archived` triggers
// the PO_VENDOR_ARCHIVED refusal path.
function _stubVendors(seed) {
  var store = Object.create(null);
  Object.keys(seed || {}).forEach(function (k) { store[k] = seed[k]; });
  var calls = [];
  return {
    calls: calls,
    add: function (slug, status) { store[slug] = { slug: slug, status: status || "active" }; },
    archive: function (slug) { if (store[slug]) store[slug].status = "archived"; },
    getVendor: async function (slug) {
      calls.push(slug);
      return store[slug] || null;
    },
  };
}

// inventoryReceive stub. Records the draft + apply call shapes and
// returns deterministic ids so the PO can stamp the receipt result
// onto its hydrated payload. failOn lets a test inject a draft-time
// rejection (e.g. unknown SKU at catalog) to exercise the PO's
// receipt-first-then-counters ordering.
function _stubReceive(opts) {
  opts = opts || {};
  var drafts = [];
  var applies = [];
  var nextId  = 1;
  return {
    drafts:  drafts,
    applies: applies,
    draft: async function (input) {
      drafts.push(input);
      if (opts.failOnDraft) { throw new Error("stub-receive: draft refused"); }
      var id = "rcpt-" + (nextId++);
      return { id: id, reference: input.reference };
    },
    apply: async function (id) {
      applies.push(id);
      if (opts.failOnApply) { throw new Error("stub-receive: apply refused"); }
      return { applied_count: 1, stock_changes: [{ sku: "x", delta: 1 }] };
    },
  };
}

function _setup(opts) {
  opts = opts || {};
  var query = _makeQuery();
  var vendorsStub = _stubVendors(opts.vendors || { "acme-supply": { slug: "acme-supply", status: "active" } });
  var receiveStub = opts.receive !== false ? _stubReceive(opts.receiveOpts || {}) : null;
  var pos = purchaseOrders.create({
    query:            query,
    vendors:          vendorsStub,
    inventoryReceive: receiveStub,
  });
  return { query: query, vendors: vendorsStub, receive: receiveStub, pos: pos };
}

function _validDraft(overrides) {
  return Object.assign({
    vendor_slug: "acme-supply",
    lines: [
      { sku: "WDG-A", quantity: 10, unit_cost_minor: 500, currency: "USD" },
      { sku: "WDG-B", quantity:  5, unit_cost_minor: 300 },
    ],
    notes: "first order",
  }, overrides || {});
}

// ---- 1. createDraft + linesForPO --------------------------------------

async function _createDraftAndLinesForPO() {
  var ctx = _setup();
  var po = await ctx.pos.createDraft(_validDraft());

  check("createDraft returns v7-shaped id",            typeof po.id === "string" && po.id.length >= 32);
  check("createDraft opens status=draft",              po.status === "draft");
  check("createDraft stores vendor_slug",              po.vendor_slug === "acme-supply");
  check("createDraft persists notes",                  po.notes === "first order");
  check("createDraft stamps created_at",               typeof po.created_at === "number");
  check("createDraft stamps updated_at",               typeof po.updated_at === "number");
  check("createDraft submitted_at is null",            po.submitted_at === null);
  check("createDraft confirmed_at is null",            po.confirmed_at === null);
  check("createDraft hydrates two lines",              Array.isArray(po.lines) && po.lines.length === 2);

  // Lines come back sorted by SKU ASC; line A first.
  var lineA = po.lines.filter(function (l) { return l.sku === "WDG-A"; })[0];
  var lineB = po.lines.filter(function (l) { return l.sku === "WDG-B"; })[0];
  check("line A captures qty",                         lineA.quantity_ordered === 10);
  check("line A captures cost",                        lineA.unit_cost_minor === 500);
  check("line A defaults currency=USD",                lineA.currency === "USD");
  check("line A opens qty_received=0",                 lineA.quantity_received === 0);
  check("line B captures qty",                         lineB.quantity_ordered === 5);
  check("line B default currency from explicit USD",   lineB.currency === "USD");

  // vendors.getVendor was called with the slug exactly once.
  check("createDraft consulted vendors.getVendor",     ctx.vendors.calls.length === 1 && ctx.vendors.calls[0] === "acme-supply");

  // linesForPO returns the same hydrated lines (without header).
  var lines = await ctx.pos.linesForPO(po.id);
  check("linesForPO returns 2 lines",                  Array.isArray(lines) && lines.length === 2);
  check("linesForPO entries have qty_ordered",         lines[0].quantity_ordered === 10 || lines[0].quantity_ordered === 5);

  // linesForPO on a missing PO -> null.
  var miss = await ctx.pos.linesForPO("01970000-0000-7000-8000-000000000000");
  check("linesForPO unknown -> null",                  miss === null);

  // getPO + listPOs sanity.
  var got = await ctx.pos.getPO(po.id);
  check("getPO resolves by id",                        got && got.id === po.id);
  var listed = await ctx.pos.listPOs();
  check("listPOs returns the draft",                   listed.length === 1 && listed[0].id === po.id);
  var byStatus = await ctx.pos.listPOs({ status: "draft" });
  check("listPOs filters by status",                   byStatus.length === 1);
  var byVendor = await ctx.pos.listPOs({ vendor_slug: "acme-supply" });
  check("listPOs filters by vendor",                   byVendor.length === 1);
  var byBoth = await ctx.pos.listPOs({ status: "submitted", vendor_slug: "acme-supply" });
  check("listPOs status+vendor narrows correctly",     byBoth.length === 0);
}

// ---- 2. FSM transitions: draft -> ... -> closed -----------------------

async function _fsmFullLifecycle() {
  var ctx = _setup();
  var po = await ctx.pos.createDraft(_validDraft());

  // draft -> submitted
  var submitted = await ctx.pos.submitToVendor({
    po_id: po.id, submitted_by: "ops@example",
  });
  check("submitToVendor -> status=submitted",          submitted.status === "submitted");
  check("submitToVendor stamps submitted_at",          typeof submitted.submitted_at === "number");
  check("submitToVendor stores submitted_by",          submitted.submitted_by === "ops@example");

  // submitted -> confirmed
  var confirmed = await ctx.pos.confirmByVendor({
    po_id: po.id, confirmed_at: Date.now(), vendor_reference: "ACME-PO-9001",
  });
  check("confirmByVendor -> status=confirmed",         confirmed.status === "confirmed");
  check("confirmByVendor stamps confirmed_at",         typeof confirmed.confirmed_at === "number");
  check("confirmByVendor stores vendor_reference",     confirmed.vendor_reference === "ACME-PO-9001");

  // confirmed -> partially_received (receive 4 of 10 on line A)
  var partial = await ctx.pos.recordPartialReceipt({
    po_id: po.id,
    received_lines: [{ sku: "WDG-A", quantity_received: 4 }],
    received_by:    "warehouse@example",
  });
  check("recordPartialReceipt -> partially_received",  partial.status === "partially_received");
  var pLineA = partial.lines.filter(function (l) { return l.sku === "WDG-A"; })[0];
  check("partial advances line A qty_received",        pLineA.quantity_received === 4);
  var pLineB = partial.lines.filter(function (l) { return l.sku === "WDG-B"; })[0];
  check("partial leaves line B untouched",             pLineB.quantity_received === 0);

  // partially_received -> received (receive the remaining 6 on A + all 5 on B)
  var received = await ctx.pos.recordPartialReceipt({
    po_id: po.id,
    received_lines: [
      { sku: "WDG-A", quantity_received: 6 },
      { sku: "WDG-B", quantity_received: 5 },
    ],
  });
  check("full receipt advances PO to received",        received.status === "received");
  var rLineA = received.lines.filter(function (l) { return l.sku === "WDG-A"; })[0];
  var rLineB = received.lines.filter(function (l) { return l.sku === "WDG-B"; })[0];
  check("full receipt line A qty_received=10",         rLineA.quantity_received === 10);
  check("full receipt line B qty_received=5",          rLineB.quantity_received === 5);

  // received -> closed
  var closed = await ctx.pos.closePO({ po_id: po.id });
  check("closePO -> status=closed",                    closed.status === "closed");
  check("closePO stamps closed_at",                    typeof closed.closed_at === "number");

  // Out-of-order refusals across the FSM.
  await assert.rejects(ctx.pos.submitToVendor({ po_id: po.id }),   /TRANSITION_REFUSED|refused/);
  await assert.rejects(ctx.pos.confirmByVendor({
    po_id: po.id, confirmed_at: Date.now(),
  }), /TRANSITION_REFUSED|refused/);
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: po.id,
    received_lines: [{ sku: "WDG-A", quantity_received: 1 }],
  }), /TRANSITION_REFUSED|refused/);
  await assert.rejects(ctx.pos.closePO({ po_id: po.id }),          /TRANSITION_REFUSED|refused/);
}

// ---- 3. recordPartialReceipt composes inventoryReceive ----------------

async function _recordPartialComposesInventoryReceive() {
  var ctx = _setup();
  var po = await ctx.pos.createDraft(_validDraft());
  await ctx.pos.submitToVendor({ po_id: po.id });
  await ctx.pos.confirmByVendor({ po_id: po.id, confirmed_at: Date.now(), vendor_reference: "ACK-1" });

  // First receipt: 4 of WDG-A. Verify the stub got a draft + apply
  // call with the right shape.
  var rcpt = await ctx.pos.recordPartialReceipt({
    po_id: po.id,
    received_lines: [{ sku: "WDG-A", quantity_received: 4 }],
    received_by:    "warehouse",
    reference:      "GR-2026-001",
  });

  check("receive.draft called once",                   ctx.receive.drafts.length === 1);
  var drf = ctx.receive.drafts[0];
  check("draft.reference is operator-supplied",        drf.reference === "GR-2026-001");
  check("draft.supplier is the PO's vendor_slug",      drf.supplier === "acme-supply");
  check("draft.received_by propagates",                drf.received_by === "warehouse");
  check("draft.notes carries po-id link",              typeof drf.notes === "string" && drf.notes.indexOf("purchase-orders:") === 0);
  check("draft.total_currency from line currency",     drf.total_currency === "USD");
  check("draft.lines has one entry",                   Array.isArray(drf.lines) && drf.lines.length === 1);
  check("draft.lines[0].sku matches",                  drf.lines[0].sku === "WDG-A");
  check("draft.lines[0].qty_received matches",         drf.lines[0].qty_received === 4);
  check("draft.lines[0].unit_cost_minor from PO",      drf.lines[0].unit_cost_minor === 500);
  check("draft.lines[0].unit_cost_currency from PO",   drf.lines[0].unit_cost_currency === "USD");

  check("receive.apply called once with draft id",     ctx.receive.applies.length === 1 && ctx.receive.applies[0] === "rcpt-1");

  // The hydrated PO carries the receipt result for the caller.
  check("rcpt.receipt.receipt_id stamped",             rcpt.receipt && rcpt.receipt.receipt_id === "rcpt-1");
  check("rcpt.receipt.applied_count stamped",          rcpt.receipt.applied_count === 1);

  // Second receipt without an operator-supplied reference — the
  // primitive derives a deterministic one from po-id + ts.
  var rcpt2 = await ctx.pos.recordPartialReceipt({
    po_id: po.id,
    received_lines: [{ sku: "WDG-A", quantity_received: 6 }, { sku: "WDG-B", quantity_received: 5 }],
  });
  check("second receipt draft call",                   ctx.receive.drafts.length === 2);
  var drf2 = ctx.receive.drafts[1];
  check("derived reference starts with po-",           typeof drf2.reference === "string" && drf2.reference.indexOf("po-") === 0);
  check("derived reference includes po id",            drf2.reference.indexOf(po.id) !== -1);
  check("second receipt has both skus",                drf2.lines.length === 2);
  check("PO landed in received",                       rcpt2.status === "received");

  // Receipt with the inventoryReceive handle wired but a failure at
  // draft time: PO counters must not advance.
  var ctxFail = _setup({ receiveOpts: { failOnDraft: true } });
  var poF = await ctxFail.pos.createDraft(_validDraft());
  await ctxFail.pos.submitToVendor({ po_id: poF.id });
  await ctxFail.pos.confirmByVendor({ po_id: poF.id, confirmed_at: Date.now() });
  await assert.rejects(ctxFail.pos.recordPartialReceipt({
    po_id: poF.id,
    received_lines: [{ sku: "WDG-A", quantity_received: 4 }],
  }), /draft refused/);
  var stillConfirmed = await ctxFail.pos.getPO(poF.id);
  check("PO stayed confirmed after receive.draft throw", stillConfirmed.status === "confirmed");
  var stillLineA = stillConfirmed.lines.filter(function (l) { return l.sku === "WDG-A"; })[0];
  check("line A qty_received still 0 after draft throw", stillLineA.quantity_received === 0);

  // Without the inventoryReceive handle the PO counters still advance.
  var ctxNoR = _setup({ receive: false });
  var poN = await ctxNoR.pos.createDraft(_validDraft());
  await ctxNoR.pos.submitToVendor({ po_id: poN.id });
  await ctxNoR.pos.confirmByVendor({ po_id: poN.id, confirmed_at: Date.now() });
  var rN = await ctxNoR.pos.recordPartialReceipt({
    po_id: poN.id,
    received_lines: [{ sku: "WDG-A", quantity_received: 3 }],
  });
  check("no-receive-handle still advances PO line",    rN.lines.filter(function (l) { return l.sku === "WDG-A"; })[0].quantity_received === 3);
  check("no-receive-handle leaves rcpt undefined",     rN.receipt === null);
}

// ---- 4. closePO refuses unless every line fully received --------------

async function _closeRefusesPartial() {
  var ctx = _setup();
  var po = await ctx.pos.createDraft(_validDraft());
  await ctx.pos.submitToVendor({ po_id: po.id });
  await ctx.pos.confirmByVendor({ po_id: po.id, confirmed_at: Date.now() });

  // closePO on draft / submitted / confirmed / partially_received
  // all refuse with PO_TRANSITION_REFUSED.
  await assert.rejects(ctx.pos.closePO({ po_id: po.id }), function (e) {
    return /TRANSITION_REFUSED|refused/.test(e.message) && e.code === "PO_TRANSITION_REFUSED";
  });

  // Take a partial receipt; closePO still refuses.
  await ctx.pos.recordPartialReceipt({
    po_id: po.id,
    received_lines: [{ sku: "WDG-A", quantity_received: 4 }],
  });
  await assert.rejects(ctx.pos.closePO({ po_id: po.id }), /refused/);

  // Receive everything; close now succeeds.
  await ctx.pos.recordPartialReceipt({
    po_id: po.id,
    received_lines: [
      { sku: "WDG-A", quantity_received: 6 },
      { sku: "WDG-B", quantity_received: 5 },
    ],
  });
  var closed = await ctx.pos.closePO({ po_id: po.id });
  check("closePO succeeds once received",              closed.status === "closed");

  // Re-close refused (already closed, not 'received').
  await assert.rejects(ctx.pos.closePO({ po_id: po.id }), /refused/);

  // Unknown PO -> PO_NOT_FOUND.
  await assert.rejects(ctx.pos.closePO({
    po_id: "01970000-0000-7000-8000-000000000000",
  }), function (e) { return e.code === "PO_NOT_FOUND"; });
}

// ---- 5. cancelPO from draft vs from confirmed -------------------------

async function _cancelFsm() {
  // draft -> cancelled (allowed)
  var ctx = _setup();
  var poDraft = await ctx.pos.createDraft(_validDraft());
  var cancelledFromDraft = await ctx.pos.cancelPO({
    po_id: poDraft.id, reason: "vendor unresponsive",
  });
  check("cancelPO from draft -> cancelled",            cancelledFromDraft.status === "cancelled");
  check("cancelPO stamps cancelled_at",                typeof cancelledFromDraft.cancelled_at === "number");
  check("cancelPO stores reason",                      cancelledFromDraft.cancel_reason === "vendor unresponsive");

  // submitted -> cancelled (also allowed)
  var poSub = await ctx.pos.createDraft(_validDraft());
  await ctx.pos.submitToVendor({ po_id: poSub.id });
  var cFromSub = await ctx.pos.cancelPO({
    po_id: poSub.id, reason: "operator pulled the PO",
  });
  check("cancelPO from submitted -> cancelled",        cFromSub.status === "cancelled");

  // confirmed -> cancelled REFUSED (commercial conversation).
  var poConf = await ctx.pos.createDraft(_validDraft());
  await ctx.pos.submitToVendor({ po_id: poConf.id });
  await ctx.pos.confirmByVendor({ po_id: poConf.id, confirmed_at: Date.now() });
  await assert.rejects(ctx.pos.cancelPO({
    po_id: poConf.id, reason: "too late",
  }), function (e) {
    return /TRANSITION_REFUSED|refused/.test(e.message) && e.code === "PO_TRANSITION_REFUSED";
  });

  // Re-cancel a cancelled PO refused.
  await assert.rejects(ctx.pos.cancelPO({
    po_id: poDraft.id, reason: "again",
  }), /refused/);

  // Reason required + bounded.
  await assert.rejects(ctx.pos.cancelPO({ po_id: poConf.id }),                  /reason/);
  await assert.rejects(ctx.pos.cancelPO({ po_id: poConf.id, reason: "" }),      /reason/);
  await assert.rejects(ctx.pos.cancelPO({
    po_id: poConf.id, reason: "x".repeat(281),
  }), /reason/);

  // Control byte / zero-width refused in reason.
  await assert.rejects(ctx.pos.cancelPO({
    po_id: poConf.id, reason: "bad\x01reason",
  }), /reason/);

  // Unknown PO -> PO_NOT_FOUND.
  await assert.rejects(ctx.pos.cancelPO({
    po_id: "01970000-0000-7000-8000-000000000000", reason: "x",
  }), function (e) { return e.code === "PO_NOT_FOUND"; });
}

// ---- 6. update only allowed on draft status ---------------------------

async function _updateOnlyOnDraft() {
  var ctx = _setup();
  var po = await ctx.pos.createDraft(_validDraft());

  // Patch notes + expected_delivery on a draft PO.
  var patched = await ctx.pos.update(po.id, {
    notes:             "revised notes",
    expected_delivery: 1700000000000,
  });
  check("update patches notes on draft",               patched.notes === "revised notes");
  check("update patches expected_delivery on draft",   patched.expected_delivery === 1700000000000);
  check("update preserves status=draft",               patched.status === "draft");
  check("update bumps updated_at",                     patched.updated_at >= po.updated_at);

  // Wholesale lines-replace.
  var replaced = await ctx.pos.update(po.id, {
    lines: [
      { sku: "WDG-C", quantity: 7, unit_cost_minor: 800, currency: "EUR" },
    ],
  });
  check("update replaces lines wholesale",             replaced.lines.length === 1 && replaced.lines[0].sku === "WDG-C");
  check("update lines-replace preserves status=draft", replaced.status === "draft");

  // Unknown column refused.
  await assert.rejects(ctx.pos.update(po.id, { vendor_slug: "other" }),         /not updatable/);
  await assert.rejects(ctx.pos.update(po.id, { status: "submitted" }),          /not updatable/);
  await assert.rejects(ctx.pos.update(po.id, { id: "x" }),                      /not updatable/);

  // Empty patch refused.
  await assert.rejects(ctx.pos.update(po.id, {}),                               /at least one column/);

  // Bad patch shapes refused.
  await assert.rejects(ctx.pos.update(po.id),                                   /patch object required/);

  // Submit the PO; update now refuses across the board.
  await ctx.pos.submitToVendor({ po_id: po.id });
  await assert.rejects(ctx.pos.update(po.id, { notes: "too late" }), function (e) {
    return /TRANSITION_REFUSED|refused/.test(e.message) && e.code === "PO_TRANSITION_REFUSED";
  });
  await assert.rejects(ctx.pos.update(po.id, {
    lines: [{ sku: "WDG-D", quantity: 1, unit_cost_minor: 1 }],
  }), /refused/);

  // Unknown PO -> null (no throw).
  var noop = await ctx.pos.update(
    "01970000-0000-7000-8000-000000000000",
    { notes: "x" }
  );
  check("update unknown po -> null",                   noop === null);
}

// ---- 7. factory + input validation refusals ---------------------------

async function _factoryAndInputValidation() {
  // Factory refuses a bad vendors handle (missing getVendor).
  assert.throws(function () {
    purchaseOrders.create({ vendors: { lookup: function () {} } });
  }, /getVendor/);
  // Factory refuses a partial inventoryReceive handle.
  assert.throws(function () {
    purchaseOrders.create({ inventoryReceive: { draft: function () {} } });
  }, /draft \+ apply/);

  var ctx = _setup();

  // createDraft input refusals.
  await assert.rejects(ctx.pos.createDraft(),                                   /input object required/);
  await assert.rejects(ctx.pos.createDraft({ lines: [] }),                      /vendor_slug/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({ vendor_slug: "" })),   /vendor_slug/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({ vendor_slug: "Bad_Slug" })), /vendor_slug/);
  // lines must be a non-empty array.
  await assert.rejects(ctx.pos.createDraft(_validDraft({ lines: [] })),         /lines/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({ lines: "nope" })),     /lines/);
  // line shape.
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    lines: [{ sku: "", quantity: 1, unit_cost_minor: 1 }],
  })), /sku/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    lines: [{ sku: "bad sku", quantity: 1, unit_cost_minor: 1 }],
  })), /sku/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    lines: [{ sku: "WDG-A", quantity: 0, unit_cost_minor: 1 }],
  })), /quantity/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    lines: [{ sku: "WDG-A", quantity: 1.5, unit_cost_minor: 1 }],
  })), /quantity/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    lines: [{ sku: "WDG-A", quantity: 1, unit_cost_minor: -1 }],
  })), /unit_cost_minor/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    lines: [{ sku: "WDG-A", quantity: 1, unit_cost_minor: 1, currency: "usd" }],
  })), /currency/);
  // duplicate SKU on the same PO refused.
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    lines: [
      { sku: "WDG-A", quantity: 1, unit_cost_minor: 1 },
      { sku: "WDG-A", quantity: 2, unit_cost_minor: 2 },
    ],
  })), /duplicate sku/);
  // control byte / zero-width in notes.
  await assert.rejects(ctx.pos.createDraft(_validDraft({ notes: "bad\x01notes" })),
    /notes/);
  await assert.rejects(ctx.pos.createDraft(_validDraft({
    notes: "bad" + String.fromCharCode(0x200B) + "notes",
  })), /zero-width/);
  // oversize notes.
  await assert.rejects(ctx.pos.createDraft(_validDraft({ notes: "x".repeat(4001) })),
    /notes/);
  // expected_delivery must be a non-negative integer.
  await assert.rejects(ctx.pos.createDraft(_validDraft({ expected_delivery: -1 })),
    /expected_delivery/);
  // unknown vendor refused (stubbed vendors handle returns null).
  await assert.rejects(ctx.pos.createDraft(_validDraft({ vendor_slug: "ghost-vendor" })),
    function (e) { return e.code === "PO_VENDOR_NOT_FOUND"; });
  // archived vendor refused.
  ctx.vendors.add("archived-vendor", "archived");
  await assert.rejects(ctx.pos.createDraft(_validDraft({ vendor_slug: "archived-vendor" })),
    function (e) { return e.code === "PO_VENDOR_ARCHIVED"; });

  // Without a vendors handle, the vendor-existence check is skipped.
  var ctxNoV = _setup();
  ctxNoV.pos = purchaseOrders.create({ query: ctxNoV.query });
  var freePO = await ctxNoV.pos.createDraft(_validDraft({ vendor_slug: "no-such-vendor-anywhere" }));
  check("no vendors handle skips existence check",     freePO.vendor_slug === "no-such-vendor-anywhere");

  // submitToVendor input refusals.
  await assert.rejects(ctx.pos.submitToVendor(),                                /input object required/);
  await assert.rejects(ctx.pos.submitToVendor({ po_id: "not-a-uuid" }),         /po_id/);
  await assert.rejects(ctx.pos.submitToVendor({
    po_id: "01970000-0000-7000-8000-000000000000",
  }), function (e) { return e.code === "PO_NOT_FOUND"; });

  // confirmByVendor input refusals.
  await assert.rejects(ctx.pos.confirmByVendor(),                               /input object required/);
  await assert.rejects(ctx.pos.confirmByVendor({ po_id: "not-a-uuid" }),        /po_id/);
  // confirmed_at required.
  var poForConfirm = await ctx.pos.createDraft(_validDraft({ vendor_slug: "acme-supply" }));
  await ctx.pos.submitToVendor({ po_id: poForConfirm.id });
  await assert.rejects(ctx.pos.confirmByVendor({ po_id: poForConfirm.id }),     /confirmed_at/);
  await assert.rejects(ctx.pos.confirmByVendor({
    po_id: poForConfirm.id, confirmed_at: -1,
  }), /confirmed_at/);
  // vendor_reference bounded.
  await assert.rejects(ctx.pos.confirmByVendor({
    po_id: poForConfirm.id, confirmed_at: Date.now(), vendor_reference: "x".repeat(257),
  }), /vendor_reference/);

  // recordPartialReceipt input refusals.
  await assert.rejects(ctx.pos.recordPartialReceipt(),                          /input object required/);
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, received_lines: [],
  }), /received_lines/);
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, received_lines: "nope",
  }), /received_lines/);

  // Confirm the PO so the next receipts have a legal source state.
  await ctx.pos.confirmByVendor({ po_id: poForConfirm.id, confirmed_at: Date.now() });
  // Unknown SKU on a receipt against this PO refused.
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, received_lines: [{ sku: "NOT-ON-PO", quantity_received: 1 }],
  }), /not on PO/);
  // Over-receipt refused.
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, received_lines: [{ sku: "WDG-A", quantity_received: 9999 }],
  }), /over-receipt/);
  // Bad quantity on receipt refused.
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, received_lines: [{ sku: "WDG-A", quantity_received: 0 }],
  }), /quantity_received/);
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, received_lines: [{ sku: "WDG-A", quantity_received: -1 }],
  }), /quantity_received/);
  // Duplicate SKU in received_lines refused.
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, received_lines: [
      { sku: "WDG-A", quantity_received: 1 },
      { sku: "WDG-A", quantity_received: 1 },
    ],
  }), /duplicate sku/);
  // Bad reference shape refused.
  await assert.rejects(ctx.pos.recordPartialReceipt({
    po_id: poForConfirm.id, reference: "bad ref with $$ symbols",
    received_lines: [{ sku: "WDG-A", quantity_received: 1 }],
  }), /reference/);

  // closePO input refusals.
  await assert.rejects(ctx.pos.closePO(),                                       /input object required/);
  await assert.rejects(ctx.pos.closePO({ po_id: "not-a-uuid" }),                /po_id/);

  // cancelPO input refusals.
  await assert.rejects(ctx.pos.cancelPO(),                                      /input object required/);
  await assert.rejects(ctx.pos.cancelPO({ po_id: "not-a-uuid", reason: "x" }),  /po_id/);

  // listPOs filter validation.
  await assert.rejects(ctx.pos.listPOs({ status: "weird" }),                    /status/);
  await assert.rejects(ctx.pos.listPOs({ vendor_slug: "Bad_Slug" }),            /vendor_slug/);

  // getPO bad input.
  await assert.rejects(ctx.pos.getPO(""),                                       /po_id/);
  await assert.rejects(ctx.pos.getPO("not-a-uuid"),                             /po_id/);
}

// ---- bShop handle gate ------------------------------------------------

async function _bShopHandleNotYetWired() {
  // Same gate as the vendors test — the primitive composes against
  // bShop.framework.uuid + .guardUuid, which must already be on the
  // entry-point even before the primitive itself is.
  check("bShop.framework exposes uuid.v7",
    typeof bShop.framework.uuid.v7 === "function");
  check("bShop.framework exposes guardUuid.sanitize",
    bShop.framework.guardUuid && typeof bShop.framework.guardUuid.sanitize === "function");
}

async function run() {
  await _createDraftAndLinesForPO();
  await _fsmFullLifecycle();
  await _recordPartialComposesInventoryReceive();
  await _closeRefusesPartial();
  await _cancelFsm();
  await _updateOnlyOnDraft();
  await _factoryAndInputValidation();
  await _bShopHandleNotYetWired();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/purchase-orders.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - purchase-orders (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
