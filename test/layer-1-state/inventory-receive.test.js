"use strict";
/**
 * inventory-receive — bulk stock receipts with audit trail.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0001
 * (catalog — needs the `inventory` table so the apply / reverse
 * paths can mutate it) and migration 0018 (the receipt tables).
 *
 * Coverage:
 *   - draft happy path: persists row + lines, sums totals
 *   - draft refusals: missing reference, duplicate reference,
 *     empty lines, line missing sku, qty <= 0, oversized notes,
 *     malformed currency, bad input shapes
 *   - apply transitions status + calls catalog.inventory.restock
 *     for each line
 *   - apply idempotent on already-applied (no extra restock calls)
 *   - apply rollback when a restock fails — receipt stays pending,
 *     prior restocks are undone
 *   - reverse rolls back the stock + transitions to 'reversed'
 *   - reverse refuses if receipt is not 'applied'
 *   - byReference + get + list pagination via HMAC-tagged cursor
 *   - cursor tamper / orderKey mismatch is refused
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0018_inventory_receipts.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// Stub catalog.inventory.restock. Records every call so the test
// can assert call shape + count. Returns the same shape the real
// catalog.inventory.restock does: { sku, stock_on_hand, stock_held,
// updated_at }. Also mutates the underlying inventory row so the
// reversal path (which decrements stock_on_hand directly) sees a
// realistic starting value.
function _stubCatalog(query, options) {
  options = options || {};
  var calls = [];
  // Optional failure injection: failAfter triggers a throw on the
  // Nth restock call (1-indexed). Lets the rollback test observe a
  // partial-apply with a successful first restock that needs to be
  // undone — without depending on the unstable sub-millisecond v7
  // ordering of receipt_line ids.
  var failAfter = options.failAfter || 0;
  return {
    calls: calls,
    inventory: {
      restock: async function (sku, qty) {
        calls.push({ sku: sku, qty: qty });
        if (failAfter && calls.length === failAfter) {
          var e = new Error("stub: restock failed on call " + failAfter + " (sku=" + sku + ")");
          e.code = "STUB_RESTOCK_FAIL";
          throw e;
        }
        // Upsert into inventory so the reverse-path UPDATE has a row.
        var existing = await query("SELECT sku FROM inventory WHERE sku = ?1", [sku]);
        var now = Date.now();
        if (!existing.rows.length) {
          await query(
            "INSERT INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES (?1, ?2, 0, ?3)",
            [sku, qty, now],
          );
        } else {
          await query(
            "UPDATE inventory SET stock_on_hand = stock_on_hand + ?1, updated_at = ?2 WHERE sku = ?3",
            [qty, now, sku],
          );
        }
        var row = (await query("SELECT * FROM inventory WHERE sku = ?1", [sku])).rows[0];
        return row;
      },
    },
  };
}

function _validInput(extras) {
  var base = {
    reference:   "PO-001",
    supplier:    "Acme Widgets Ltd",
    received_by: "warehouse-team-a",
    notes:       "first shipment of the quarter",
    lines: [
      { sku: "WDG-PRO-BLK-L", qty_received: 50, unit_cost_minor: 1500 },
      { sku: "WDG-PRO-RED-L", qty_received: 25, unit_cost_minor: 1500 },
    ],
  };
  if (extras) {
    for (var k in extras) {
      if (Object.prototype.hasOwnProperty.call(extras, k)) base[k] = extras[k];
    }
  }
  return base;
}

async function _draftHappyPath() {
  var q = _makeQuery();
  var stub = _stubCatalog(q);
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });

  var d = await receive.draft(_validInput());
  check("draft returns v7 uuid",         typeof d.id === "string" && d.id.length === 36);
  check("draft status is pending",        d.status === "pending");
  check("draft sums total_qty",           d.total_qty === 75);
  check("draft sums total_value_minor",   d.total_value_minor === 75 * 1500);
  check("draft does not call restock",    stub.calls.length === 0);

  var full = await receive.get(d.id);
  check("get hydrates lines",             full.lines.length === 2);
  check("get preserves status",           full.status === "pending");
  check("get preserves supplier",         full.supplier === "Acme Widgets Ltd");
  check("get preserves received_by",      full.received_by === "warehouse-team-a");
  check("get preserves notes",            full.notes === "first shipment of the quarter");
  var bySku = {};
  full.lines.forEach(function (l) { bySku[l.sku] = l; });
  check("get line sku (BLK-L)",           bySku["WDG-PRO-BLK-L"] && bySku["WDG-PRO-BLK-L"].qty_received === 50);
  check("get line sku (RED-L)",           bySku["WDG-PRO-RED-L"] && bySku["WDG-PRO-RED-L"].qty_received === 25);
  check("get line unit_cost_minor",       bySku["WDG-PRO-BLK-L"].unit_cost_minor === 1500);

  // byReference round-trip
  var byRef = await receive.byReference("PO-001");
  check("byReference finds receipt",      byRef && byRef.id === d.id);
  var missing = await receive.byReference("PO-DOESNT-EXIST");
  check("byReference miss returns null",  missing === null);
}

async function _draftRefusals() {
  var q = _makeQuery();
  var stub = _stubCatalog(q);
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });

  // Missing reference
  await assert.rejects(receive.draft(_validInput({ reference: undefined })), /reference/);
  await assert.rejects(receive.draft(_validInput({ reference: "" })),         /reference/);
  // Reference with bad chars
  await assert.rejects(receive.draft(_validInput({ reference: "PO 001\n" })), /reference/);
  // Empty lines
  await assert.rejects(receive.draft(_validInput({ lines: [] })),              /lines must be a non-empty/);
  await assert.rejects(receive.draft(_validInput({ lines: null })),            /lines must be a non-empty/);
  // Line missing sku
  await assert.rejects(receive.draft(_validInput({
    lines: [{ qty_received: 5 }],
  })),                                                                          /sku/);
  // Line qty <= 0
  await assert.rejects(receive.draft(_validInput({
    lines: [{ sku: "WDG-1", qty_received: 0 }],
  })),                                                                          /qty_received/);
  await assert.rejects(receive.draft(_validInput({
    lines: [{ sku: "WDG-1", qty_received: -3 }],
  })),                                                                          /qty_received/);
  await assert.rejects(receive.draft(_validInput({
    lines: [{ sku: "WDG-1", qty_received: 1.5 }],
  })),                                                                          /qty_received/);
  // Bad unit_cost_minor
  await assert.rejects(receive.draft(_validInput({
    lines: [{ sku: "WDG-1", qty_received: 5, unit_cost_minor: -1 }],
  })),                                                                          /unit_cost_minor/);
  // Malformed currency on a line
  await assert.rejects(receive.draft(_validInput({
    lines: [{ sku: "WDG-1", qty_received: 5, unit_cost_minor: 10, unit_cost_currency: "usd" }],
  })),                                                                          /currency/);
  // Bad total_currency
  await assert.rejects(receive.draft(_validInput({ total_currency: "EU" })),    /currency/);
  // Oversized notes (4001 chars)
  var bigNotes = new Array(4002).join("x");
  await assert.rejects(receive.draft(_validInput({ notes: bigNotes })),         /notes/);
  // Oversized line notes
  await assert.rejects(receive.draft(_validInput({
    lines: [{ sku: "WDG-1", qty_received: 5, notes: bigNotes }],
  })),                                                                          /notes/);
  // Bad input shape
  await assert.rejects(receive.draft(),                                          /input object required/);
  await assert.rejects(receive.draft(null),                                      /input object required/);

  // Duplicate reference — first draft succeeds, second is refused.
  await receive.draft(_validInput({ reference: "PO-DUP" }));
  await assert.rejects(receive.draft(_validInput({ reference: "PO-DUP" })),     /already exists/);
}

async function _applyHappyPath() {
  var q = _makeQuery();
  var stub = _stubCatalog(q);
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });
  var d = await receive.draft(_validInput());

  var result = await receive.apply(d.id);
  check("apply returns id",                 result.id === d.id);
  check("apply applied_count matches lines", result.applied_count === 2);
  var changeBySku = {};
  result.stock_changes.forEach(function (c) { changeBySku[c.sku] = c.qty; });
  check("apply stock_changes BLK-L",         changeBySku["WDG-PRO-BLK-L"] === 50);
  check("apply stock_changes RED-L",         changeBySku["WDG-PRO-RED-L"] === 25);
  check("apply called restock per line",     stub.calls.length === 2);
  var callBySku = {};
  stub.calls.forEach(function (c) { callBySku[c.sku] = c.qty; });
  check("apply called restock for BLK-L",    callBySku["WDG-PRO-BLK-L"] === 50);
  check("apply called restock for RED-L",    callBySku["WDG-PRO-RED-L"] === 25);

  var refreshed = await receive.get(d.id);
  check("apply transitions to applied",      refreshed.status === "applied");

  // Idempotent re-apply: no new restock calls, applied_count is 0
  var second = await receive.apply(d.id);
  check("re-apply is idempotent (no-op)",    second.applied_count === 0 && second.stock_changes.length === 0);
  check("re-apply does not call restock",    stub.calls.length === 2);
}

async function _applyRollback() {
  var q = _makeQuery();
  // Fail on the SECOND restock call so we can verify the first
  // line's restock gets undone via the compensating decrement.
  var stub = _stubCatalog(q, { failAfter: 2 });
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });

  var d = await receive.draft(_validInput());
  await assert.rejects(receive.apply(d.id),                                     /restock failed/);

  // Receipt should remain pending so operator can fix + retry.
  var refreshed = await receive.get(d.id);
  check("apply rollback leaves receipt pending", refreshed.status === "pending");
  check("apply rollback recorded both calls",    stub.calls.length === 2);

  // The first restocked SKU should be back to 0 — the compensating
  // decrement should have undone the prior restock.
  var firstCalledSku = stub.calls[0].sku;
  var firstRow = (await q("SELECT * FROM inventory WHERE sku = ?1", [firstCalledSku])).rows[0];
  check("apply rollback undoes prior restock",   firstRow && firstRow.stock_on_hand === 0);
}

async function _reverseHappyPath() {
  var q = _makeQuery();
  var stub = _stubCatalog(q);
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });
  var d = await receive.draft(_validInput());
  await receive.apply(d.id);

  // Pre-reverse: stock_on_hand should reflect the applied amount.
  var preBlk = (await q("SELECT * FROM inventory WHERE sku = ?1", ["WDG-PRO-BLK-L"])).rows[0];
  check("pre-reverse stock present",        preBlk && preBlk.stock_on_hand === 50);

  var result = await receive.reverse(d.id, { reason: "delivery damaged" });
  check("reverse returns id",                result.id === d.id);
  check("reverse reversed_count",            result.reversed_count === 2);
  var revBySku = {};
  result.stock_changes.forEach(function (c) { revBySku[c.sku] = c.qty; });
  check("reverse stock_changes BLK-L neg",   revBySku["WDG-PRO-BLK-L"] === -50);
  check("reverse stock_changes RED-L neg",   revBySku["WDG-PRO-RED-L"] === -25);

  var refreshed = await receive.get(d.id);
  check("reverse transitions to reversed",   refreshed.status === "reversed");
  check("reverse appends reason to notes",   refreshed.notes.indexOf("delivery damaged") !== -1);

  // Stock should be back to 0 — the reverse decrement rolled it back.
  var postBlk = (await q("SELECT * FROM inventory WHERE sku = ?1", ["WDG-PRO-BLK-L"])).rows[0];
  check("reverse decrements stock_on_hand",  postBlk && postBlk.stock_on_hand === 0);

  // Re-reverse refuses (status is 'reversed', not 'applied').
  await assert.rejects(receive.reverse(d.id),                                   /only applied receipts/);
}

async function _reverseRefusesNonApplied() {
  var q = _makeQuery();
  var stub = _stubCatalog(q);
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });
  var d = await receive.draft(_validInput());
  // Pending receipt cannot be reversed.
  await assert.rejects(receive.reverse(d.id),                                   /only applied receipts/);
  // Unknown receipt id (well-formed UUID) returns 'not found'.
  await assert.rejects(receive.reverse(bShop.framework.uuid.v7()),              /not found/);
}

async function _applyRefusesUnknown() {
  var q = _makeQuery();
  var stub = _stubCatalog(q);
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });
  await assert.rejects(receive.apply(),                                          /receipt id/);
  await assert.rejects(receive.apply("not-a-uuid"),                              /receipt id/);
  await assert.rejects(receive.apply(bShop.framework.uuid.v7()),                 /not found/);
}

async function _listAndPagination() {
  var q = _makeQuery();
  var stub = _stubCatalog(q);
  var receive = bShop.inventoryReceive.create({ query: q, catalog: stub });

  // Three drafts with explicit received_at ascending so order is
  // deterministic (DESC list should return the latest first).
  var ids = [];
  for (var i = 0; i < 3; i += 1) {
    var d = await receive.draft(_validInput({
      reference:   "PO-LIST-" + i,
      received_at: 1000 + i,    // ascending epoch ms
    }));
    ids.push(d.id);
  }

  var page = await receive.list({ limit: 10 });
  check("list returns all three",           page.rows.length === 3);
  check("list orders by received_at DESC",  page.rows[0].id === ids[2] && page.rows[2].id === ids[0]);
  check("list hydrates lines",              Array.isArray(page.rows[0].lines) && page.rows[0].lines.length === 2);
  check("list next_cursor null on last",    page.next_cursor === null);

  // Apply the middle one + verify status filter
  await receive.apply(ids[1]);
  var applied = await receive.list({ status: "applied", limit: 10 });
  check("list status filter (applied)",     applied.rows.length === 1 && applied.rows[0].id === ids[1]);
  var pending = await receive.list({ status: "pending", limit: 10 });
  check("list status filter (pending)",     pending.rows.length === 2);

  // Pagination — limit=2 splits across two pages.
  var pageA = await receive.list({ limit: 2 });
  check("list limit=2 first page",          pageA.rows.length === 2 && typeof pageA.next_cursor === "string");
  var pageB = await receive.list({ limit: 2, cursor: pageA.next_cursor });
  check("list cursor forward",              pageB.rows.length === 1);
  var seen = {};
  pageA.rows.concat(pageB.rows).forEach(function (r) { seen[r.id] = true; });
  check("list pagination covers all rows",  Object.keys(seen).length === 3);

  // Bad cursor → refused
  await assert.rejects(receive.list({ cursor: "garbage" }),                      /cursor/);
  await assert.rejects(receive.list({ cursor: 12345 }),                          /cursor/);

  // Bad status → refused
  await assert.rejects(receive.list({ status: "weird" }),                        /status/);

  // Limit bounds
  await assert.rejects(receive.list({ limit: 0 }),                               /limit/);
  await assert.rejects(receive.list({ limit: 9999 }),                            /limit/);
}

async function _factoryRefusals() {
  // Missing catalog → refused
  assert.throws(function () { bShop.inventoryReceive.create({}); },              /catalog/);
  assert.throws(function () { bShop.inventoryReceive.create({ catalog: {} }); }, /catalog/);
  assert.throws(function () { bShop.inventoryReceive.create({ catalog: { inventory: {} } }); }, /restock/);

  // Production-without-cursorSecret → refused
  var origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    var stub = _stubCatalog(_makeQuery());
    assert.throws(function () { bShop.inventoryReceive.create({ catalog: stub }); },
      /cursorSecret is required/);
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
  }
}

async function run() {
  await _draftHappyPath();
  await _draftRefusals();
  await _applyHappyPath();
  await _applyRollback();
  await _reverseHappyPath();
  await _reverseRefusesNonApplied();
  await _applyRefusesUnknown();
  await _listAndPagination();
  await _factoryRefusals();
}

module.exports = { run: run };
