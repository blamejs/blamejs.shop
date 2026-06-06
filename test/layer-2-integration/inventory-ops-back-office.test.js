"use strict";
/**
 * Inventory-ops back-office — the full multi-location journey wired the
 * way server.js / lib/admin.js compose it.
 *
 * Stitches the real catalog, inventory-locations, inventory-receive,
 * stock-transfers, and inventory-writeoffs primitives over ONE in-memory
 * node:sqlite database loaded from the real D1 migrations, plus the real
 * inventory-alerts primitive behind a late-bound low-stock observer —
 * exactly the indirection server.js uses (catalog.onStockChange →
 * lowStockObserver → inventoryAlerts.checkAndFire).
 *
 * What it proves:
 *   - Journey: define locations → receive inbound stock against a location
 *     (both the per-location detail AND the storefront aggregate move) →
 *     open a transfer (origin debited at dispatch) → ship → receive →
 *     reconcile (destination credited) → write-off (both ledgers debited) →
 *     final levels + audit rows are correct.
 *   - Concurrency: a transfer-dispatch racing a checkout-hold for the last
 *     unit at a location can't both win — one debit lands, the other is
 *     refused, and the shelf never goes negative (the same atomic-SQL-guard
 *     serialization the 0.4.0 confirm holds use).
 *   - Low-stock regression from the REAL trigger: a location write-off
 *     mirrored onto the storefront aggregate that crosses a SKU's threshold
 *     fires a low-stock alert row through the shared observer; a receive
 *     that lifts the aggregate back above threshold does not.
 *   - Single-location stores keep working: a store that never defines a
 *     location still drives the catalog aggregate unchanged.
 *
 * Network: zero — every call is in-process.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

// The migrations whose tables this journey touches: catalog (inventory),
// inventory thresholds + alerts, the receive ledger, the location ledger,
// the transfer FSM tables, and the write-off log.
var MIGS = [
  "0001_catalog.sql",
  "0008_inventory_thresholds.sql",
  "0018_inventory_receipts.sql",
  "0034_inventory_locations.sql",
  "0089_stock_transfers.sql",
  "0138_inventory_writeoffs.sql",
].map(function (f) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeDb() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return db;
}

function _queryFor(db) {
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Compose the whole back-office over one DB, with the low-stock observer
// late-bound exactly like server.js does it. Returns the wired surface plus
// the raw db handle for direct assertions.
function _wire() {
  var db = _makeDb();
  var query = _queryFor(db);

  // Late-bound observer indirection — catalog is created BEFORE the alerts
  // primitive (server.js boot order), so the callback closes over a
  // mutable holder rather than the alerts instance directly.
  var lowStockObserver = null;
  var catalog = bShop.catalog.create({
    query: query,
    cursorSecret: "test-catalog",
    onStockChange: function (sku) { return lowStockObserver ? lowStockObserver(sku) : null; },
  });

  var inventoryAlerts = bShop.inventoryAlerts.create({
    query: query,
    // A collector logger so the warn() sink doesn't touch the framework log.
    logger: { warn: function () {} },
  });
  lowStockObserver = function (sku) { return inventoryAlerts.checkAndFire(sku); };

  var inventoryLocations = bShop.inventoryLocations.create({ query: query, catalog: catalog });
  var inventoryReceive   = bShop.inventoryReceive.create({ query: query, catalog: catalog, cursorSecret: "test-recv" });
  var stockTransfers     = bShop.stockTransfers.create({ query: query, inventoryLocations: inventoryLocations, cursorSecret: "test-xfer" });
  var inventoryWriteoffs = bShop.inventoryWriteoffs.create({ query: query, inventoryLocations: inventoryLocations, cursorSecret: "test-wo" });

  return {
    db: db, query: query, catalog: catalog, inventoryAlerts: inventoryAlerts,
    inventoryLocations: inventoryLocations, inventoryReceive: inventoryReceive,
    stockTransfers: stockTransfers, inventoryWriteoffs: inventoryWriteoffs,
  };
}

// Mirror of lib/admin.js `_receiveToLocation`: credit the per-location
// detail AND the storefront aggregate (+ the batched receipt record).
var _recvSeq = 0;
async function _receiveToLocation(w, sku, locationCode, qty, reason) {
  var adj = await w.inventoryLocations.adjustStock({
    sku: sku, location_code: locationCode, delta: qty,
    reason: reason ? ("receive: " + reason) : "receive",
  });
  try {
    _recvSeq += 1;
    var ref = "RCV-T-" + Date.now().toString(36).toUpperCase() + "-" + _recvSeq;
    var draft = await w.inventoryReceive.draft({
      reference: ref, supplier: reason || "", received_by: "admin-console",
      notes: "location: " + locationCode,
      lines: [{ sku: sku, qty_received: qty }],
    });
    await w.inventoryReceive.apply(draft.id);
  } catch (e) {
    try {
      await w.inventoryLocations.adjustStock({ sku: sku, location_code: locationCode, delta: -qty, reason: "receive: rollback" });
    } catch (_e2) { /* drop-silent */ }
    throw e;
  }
  return adj;
}

// Mirror of lib/admin.js `_writeoffFromLocation`: debit the per-location
// detail (via the writeoffs primitive) AND the storefront aggregate; reverse
// + surface when the aggregate refuses (would oversell held stock).
async function _writeoffFromLocation(w, input) {
  var row = await w.inventoryWriteoffs.recordWriteoff(input);
  if (input.location_code) {
    var mirror = await w.catalog.inventory.adjustOnHand(input.sku, -input.quantity);
    if (mirror && mirror.adjusted === false) {
      try { await w.inventoryWriteoffs.reverseWriteoff({ id: row.id, reason: "aggregate-conflict" }); }
      catch (_e) { /* drop-silent */ }
      throw new TypeError("writeoff: would oversell held stock for " + input.sku);
    }
  }
  return row;
}

async function _qtyAt(w, sku, locationCode) {
  var sfs = await w.inventoryLocations.stockForSku(sku);
  for (var i = 0; i < sfs.by_location.length; i += 1) {
    if (sfs.by_location[i].code === locationCode) return sfs.by_location[i].quantity;
  }
  return 0;
}

async function _aggregate(w, sku) {
  var inv = await w.catalog.inventory.get(sku);
  return inv ? { on_hand: inv.stock_on_hand, held: inv.stock_held } : null;
}

async function _auditCount(w, sku) {
  var r = await w.query("SELECT COUNT(*) AS n FROM inventory_adjustments WHERE sku = ?1", [sku]);
  return r.rows[0] ? Number(r.rows[0].n) : 0;
}

// ---- the journey --------------------------------------------------------

async function _fullJourney() {
  var w = _wire();

  // A tracked SKU in the catalog aggregate (single-bucket source of truth).
  await w.catalog.inventory.create("WIDGET-1", { stock_on_hand: 0 });

  // Two locations.
  await w.inventoryLocations.defineLocation({ code: "WH-EAST", name: "East", type: "warehouse", priority: 1 });
  await w.inventoryLocations.defineLocation({ code: "WH-WEST", name: "West", type: "warehouse", priority: 5 });

  // Receive 20 to EAST: per-location detail + aggregate both move.
  await _receiveToLocation(w, "WIDGET-1", "WH-EAST", 20, "PO-1001");
  check("receive: EAST has 20", (await _qtyAt(w, "WIDGET-1", "WH-EAST")) === 20);
  check("receive: aggregate on_hand 20", (await _aggregate(w, "WIDGET-1")).on_hand === 20);
  // The batched-receipt history was populated (not a dark, always-empty panel).
  var recvPage = await w.inventoryReceive.list({ limit: 50 });
  check("receive: a receipt record exists", recvPage.rows.length === 1 && recvPage.rows[0].status === "applied");

  // Open a transfer of 8 EAST→WEST. Stock leaves the origin at dispatch.
  var t = await w.stockTransfers.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WIDGET-1", quantity: 8 }], reason: "rebalance",
  });
  check("transfer: opened", t.status === "open");
  check("transfer: EAST debited at dispatch (20-8=12)", (await _qtyAt(w, "WIDGET-1", "WH-EAST")) === 12);
  check("transfer: WEST not yet credited", (await _qtyAt(w, "WIDGET-1", "WH-WEST")) === 0);
  // The transfer did NOT touch the aggregate — total across locations is
  // unchanged, so the storefront count holds steady.
  check("transfer: aggregate unchanged (20)", (await _aggregate(w, "WIDGET-1")).on_hand === 20);

  // Ship → receive (full qty) → reconcile. Destination credited at reconcile.
  await w.stockTransfers.markShipped({ transfer_id: t.id, carrier: "ACME", tracking_number: "TRK-1" });
  await w.stockTransfers.markReceived({ transfer_id: t.id, received_lines: [{ sku: "WIDGET-1", quantity_received: 8 }] });
  var done = await w.stockTransfers.reconcile({ transfer_id: t.id });
  check("transfer: reconciled", done.status === "reconciled");
  check("transfer: WEST credited (8)", (await _qtyAt(w, "WIDGET-1", "WH-WEST")) === 8);
  check("transfer: EAST still 12", (await _qtyAt(w, "WIDGET-1", "WH-EAST")) === 12);
  check("transfer: aggregate still 20", (await _aggregate(w, "WIDGET-1")).on_hand === 20);
  var disc = await w.stockTransfers.discrepanciesFor(t.id);
  check("transfer: zero discrepancy on a clean receive", disc[0].discrepancy === 0);

  // Reason-coded write-off of 3 at EAST: both ledgers debited, audit row.
  var auditBefore = await _auditCount(w, "WIDGET-1");
  await _writeoffFromLocation(w, { sku: "WIDGET-1", location_code: "WH-EAST", quantity: 3, reason: "damaged", actor: "op" });
  check("writeoff: EAST 12-3=9", (await _qtyAt(w, "WIDGET-1", "WH-EAST")) === 9);
  check("writeoff: aggregate 20-3=17", (await _aggregate(w, "WIDGET-1")).on_hand === 17);
  check("writeoff: an audit row was written", (await _auditCount(w, "WIDGET-1")) > auditBefore);

  // Final invariant: per-location total === aggregate on_hand.
  var sfs = await w.inventoryLocations.stockForSku("WIDGET-1");
  check("invariant: per-location total (9+8=17) === aggregate (17)",
    sfs.total === 17 && (await _aggregate(w, "WIDGET-1")).on_hand === 17);
}

// A transfer-dispatch debit racing a checkout-hold against the SAME SKU for
// the last unit at a location can't both win — the atomic conditional UPDATE
// guard refuses one. (The per-location debit and the aggregate hold guard
// different columns; the per-location race is between the transfer dispatch
// and any other per-location debit. We race two same-location debits — a
// transfer dispatch and a write-off — for the last unit.)
async function _concurrentLastUnit() {
  var w = _wire();
  await w.catalog.inventory.create("RARE-1", { stock_on_hand: 0 });
  await w.inventoryLocations.defineLocation({ code: "STORE", name: "Store", type: "retail", priority: 1 });
  await w.inventoryLocations.defineLocation({ code: "BACK", name: "Backroom", type: "warehouse", priority: 5 });
  await _receiveToLocation(w, "RARE-1", "STORE", 1, "last-unit");
  check("race: STORE seeded with exactly 1", (await _qtyAt(w, "RARE-1", "STORE")) === 1);

  // Two debits of the last unit at STORE, fired concurrently:
  //   A) a transfer dispatch STORE→BACK
  //   B) a direct adjustStock debit (stands in for a checkout/pick debit)
  var results = await Promise.allSettled([
    w.stockTransfers.openTransfer({
      from_location: "STORE", to_location: "BACK",
      lines: [{ sku: "RARE-1", quantity: 1 }], reason: "race-A",
    }),
    w.inventoryLocations.adjustStock({ sku: "RARE-1", location_code: "STORE", delta: -1, reason: "race-B" }),
  ]);
  var wins = results.filter(function (r) { return r.status === "fulfilled"; }).length;
  var losses = results.filter(function (r) { return r.status === "rejected"; }).length;
  check("race: exactly one debit won", wins === 1);
  check("race: exactly one debit was refused", losses === 1);
  // The shelf is exactly 0 — never negative, never double-debited.
  check("race: STORE shelf is exactly 0", (await _qtyAt(w, "RARE-1", "STORE")) === 0);
}

// Low-stock alert fires through the REAL observer trigger: a location
// write-off mirrored onto the aggregate that crosses the threshold writes an
// alert row. A receive back above threshold does not add another.
async function _lowStockFromRealTrigger() {
  var w = _wire();
  await w.catalog.inventory.create("THRESH-1", { stock_on_hand: 0 });
  await w.catalog.inventory.setThreshold("THRESH-1", 5);
  await w.inventoryLocations.defineLocation({ code: "MAIN", name: "Main", type: "warehouse", priority: 1 });

  // Receive 10 — aggregate available (10) is above threshold (5), so the
  // observer fires checkAndFire but no alert is written.
  await _receiveToLocation(w, "THRESH-1", "MAIN", 10, "stock-in");
  var alerts0 = await w.inventoryAlerts.list({ sku: "THRESH-1" });
  check("low-stock: receive above threshold writes no alert", alerts0.length === 0);

  // Write off 7 at MAIN → aggregate available drops to 3 (< 5). The write-off
  // mirrors onto the aggregate, which fires the observer → an alert row.
  await _writeoffFromLocation(w, { sku: "THRESH-1", location_code: "MAIN", quantity: 7, reason: "shrinkage", actor: "op" });
  var alerts1 = await w.inventoryAlerts.list({ sku: "THRESH-1" });
  check("low-stock: write-off crossing threshold fires an alert", alerts1.length === 1);
  check("low-stock: alert captured available=3, threshold=5",
    alerts1[0].available_at_alert === 3 && alerts1[0].threshold === 5);

  // Receive 20 back → available 23 (> 5). The observer fires but writes no
  // new alert (above threshold).
  await _receiveToLocation(w, "THRESH-1", "MAIN", 20, "replenish");
  var alerts2 = await w.inventoryAlerts.list({ sku: "THRESH-1" });
  check("low-stock: receive back above threshold adds no new alert", alerts2.length === 1);
}

// A store that never defines a location keeps using the catalog aggregate
// unchanged — the back-office adds no breaking change to single-bucket
// stock semantics.
async function _singleLocationUnchanged() {
  var w = _wire();
  await w.catalog.inventory.create("SOLO-1", { stock_on_hand: 4 });
  // No locations defined. The classic restock path still works.
  var after = await w.catalog.inventory.restock("SOLO-1", 6);
  check("single-location: restock still works with zero locations", after.stock_on_hand === 10);
  // A hold + decrement (the buy path) is unaffected.
  var held = await w.catalog.inventory.hold("SOLO-1", 2);
  check("single-location: hold still works", held.held === true);
  var dec = await w.catalog.inventory.decrement("SOLO-1", 2);
  check("single-location: decrement still works", dec.decremented === true);
  var inv = await w.catalog.inventory.get("SOLO-1");
  check("single-location: final on_hand 8, held 0", inv.stock_on_hand === 8 && inv.stock_held === 0);
}

// The transfer refuses to dispatch more than the origin holds — no money
// created, the origin shelf is untouched on refusal.
async function _transferInsufficientRefuses() {
  var w = _wire();
  await w.catalog.inventory.create("SCARCE-1", { stock_on_hand: 0 });
  await w.inventoryLocations.defineLocation({ code: "A", name: "A", type: "warehouse", priority: 1 });
  await w.inventoryLocations.defineLocation({ code: "B", name: "B", type: "warehouse", priority: 2 });
  await _receiveToLocation(w, "SCARCE-1", "A", 2, "seed");
  var threw = false;
  try {
    await w.stockTransfers.openTransfer({
      from_location: "A", to_location: "B",
      lines: [{ sku: "SCARCE-1", quantity: 5 }], reason: "over",
    });
  } catch (e) { threw = e instanceof TypeError; }
  check("transfer: over-dispatch refused with a TypeError", threw);
  check("transfer: origin shelf untouched on refusal (still 2)", (await _qtyAt(w, "SCARCE-1", "A")) === 2);
  check("transfer: no half-opened transfer persisted", (await w.stockTransfers.listOpen({})).length === 0);
}

async function run() {
  await _fullJourney();
  await _concurrentLastUnit();
  await _lowStockFromRealTrigger();
  await _singleLocationUnchanged();
  await _transferInsufficientRefuses();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("inventory-ops-back-office OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("inventory-ops-back-office FAIL: " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
