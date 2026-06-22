"use strict";
/**
 * stock-transfers — audited multi-step stock movement between
 * inventory locations.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0034
 * (inventory locations + stock + adjustments) and migration 0089
 * (stock_transfers + lines + events). The inventoryLocations
 * primitive is wired live — the transfers primitive composes its
 * adjustStock / getLocation / stockForSku verbs to debit the origin
 * and credit the destination, so the audit log on
 * inventory_adjustments + the timeline on stock_transfer_events
 * together describe every shelf-level change.
 *
 * Coverage:
 *   - openTransfer happy path: validates locations + lines, debits
 *     origin per SKU, persists header + lines + 'open' event,
 *     returns hydrated transfer
 *   - openTransfer refusals: missing input, bad codes, same source
 *     and destination, duplicate sku in lines, unknown location,
 *     insufficient stock at origin (no debit lands)
 *   - FSM transitions: open -> shipped -> in_transit -> received ->
 *     reconciled writes the expected timestamp columns + appends
 *     event rows in order
 *   - markReceived exact match: no discrepancy on any line + no
 *     destination credit until reconcile fires
 *   - reconcile exact match: destination shelf incremented by
 *     received qty, discrepancy column is 0 on every line
 *   - markReceived short ship: per-SKU quantity_received < shipped
 *     → reconcile flags discrepancy + credits only the received qty
 *   - discrepanciesFor returns every line (zero and non-zero diffs)
 *   - markException terminates a non-terminal transfer; refuses on
 *     already-terminal states
 *   - factory refusals: missing inventoryLocations + missing verbs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// Require the modules directly so this test stays independent of
// `lib/index.js` export ordering (the operator wires the primitive
// into the package surface manually after the patch lands).
var stockTransfers     = require("../../lib/stock-transfers");
var inventoryLocations = require("../../lib/inventory-locations");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0034_inventory_locations.sql",
  "0233_inventory_adjustments_idempotency_key.sql",
  "0089_stock_transfers.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  // Split on statement terminators, but keep CREATE TRIGGER ... BEGIN ... END
  // blocks whole: a trigger body carries inner `;` that must NOT split it.
  var raw = noComments.split(/;\s*(?:\n|$)/);
  var stmts = [];
  var pending = null;
  for (var i = 0; i < raw.length; i += 1) {
    var part = raw[i];
    if (pending !== null) {
      pending += ";\n" + part;
      if (/\bEND\b/i.test(part)) { stmts.push(pending.trim()); pending = null; }
      continue;
    }
    if (/\bBEGIN\b/i.test(part) && !/\bEND\b/i.test(part)) { pending = part; continue; }
    var t = part.trim();
    if (t) stmts.push(t);
  }
  if (pending !== null) stmts.push(pending.trim());
  return stmts.filter(Boolean);
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
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  queryFn.__db = db;
  return queryFn;
}

// Minimal catalog stub — inventoryLocations.create only checks it's
// an object; the primitive doesn't read from it.
function _stubCatalog() { return {}; }

// Build a fully-wired pair: an inventoryLocations svc + a
// stock-transfers svc that composes it. Returns both so the tests
// can assert against the shelf via inventoryLocations.stockForSku.
async function _wire() {
  var q = _makeQuery();
  var locSvc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await locSvc.defineLocation({ code: "WH-EAST", name: "East Warehouse", type: "warehouse", priority: 1 });
  await locSvc.defineLocation({ code: "WH-WEST", name: "West Warehouse", type: "warehouse", priority: 5 });
  await locSvc.defineLocation({ code: "STORE-NYC", name: "Manhattan Store", type: "retail", priority: 10 });
  var stSvc = stockTransfers.create({ query: q, inventoryLocations: locSvc });
  return { q: q, locSvc: locSvc, stSvc: stSvc };
}

async function _openTransferHappyPath() {
  var wired = await _wire();
  var locSvc = wired.locSvc, stSvc = wired.stSvc;

  // Seed origin shelves
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 20 });

  var t = await stSvc.openTransfer({
    from_location: "WH-EAST",
    to_location:   "WH-WEST",
    lines: [
      { sku: "WDG-1", quantity: 10 },
      { sku: "WDG-2", quantity:  5 },
    ],
    expected_eta: Date.now() + 72 * 60 * 60 * 1000,
    reason: "Q4 rebalance",
  });

  check("openTransfer returns id",            typeof t.id === "string" && t.id.length > 0);
  check("openTransfer status=open",           t.status === "open");
  check("openTransfer from_location",         t.from_location === "WH-EAST");
  check("openTransfer to_location",           t.to_location === "WH-WEST");
  check("openTransfer reason captured",       t.reason === "Q4 rebalance");
  check("openTransfer opened_at set",         typeof t.opened_at === "number" && t.opened_at > 0);
  check("openTransfer shipped_at null",       t.shipped_at == null);
  check("openTransfer lines count",           t.lines.length === 2);

  // Origin debited; destination untouched until reconcile.
  var east = await locSvc.stockForSku("WDG-1");
  var atEast = east.by_location.find(function (l) { return l.code === "WH-EAST"; });
  check("origin debited for WDG-1",           atEast && atEast.quantity === 40);
  var west = east.by_location.find(function (l) { return l.code === "WH-WEST"; });
  check("destination NOT credited at open",   !west);

  var east2 = await locSvc.stockForSku("WDG-2");
  var atEast2 = east2.by_location.find(function (l) { return l.code === "WH-EAST"; });
  check("origin debited for WDG-2",           atEast2 && atEast2.quantity === 15);

  // Event log has the open event
  var events = (await wired.q(
    "SELECT * FROM stock_transfer_events WHERE transfer_id = ?1 ORDER BY occurred_at ASC",
    [t.id],
  )).rows;
  check("open event written",                 events.length === 1 && events[0].event_type === "open");
  check("open event location is origin",      events[0].location === "WH-EAST");
}

async function _openTransferRefusals() {
  var wired = await _wire();
  var locSvc = wired.locSvc, stSvc = wired.stSvc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 5 });

  await assert.rejects(stSvc.openTransfer(),                                                     /input object required/);
  await assert.rejects(stSvc.openTransfer({}),                                                   /from_location/);
  await assert.rejects(stSvc.openTransfer({ from_location: "WH-EAST", to_location: "WH-EAST",
    lines: [{ sku: "WDG-1", quantity: 1 }] }),                                                   /must differ/);
  await assert.rejects(stSvc.openTransfer({ from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [] }),                                                                                /lines must be a non-empty/);
  await assert.rejects(stSvc.openTransfer({ from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 1 }, { sku: "WDG-1", quantity: 1 }] }),                    /duplicate sku/);
  await assert.rejects(stSvc.openTransfer({ from_location: "WH-EAST", to_location: "NO-SUCH",
    lines: [{ sku: "WDG-1", quantity: 1 }] }),                                                   /to_location/);
  await assert.rejects(stSvc.openTransfer({ from_location: "NO-SUCH", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 1 }] }),                                                   /from_location/);
  await assert.rejects(stSvc.openTransfer({ from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 0 }] }),                                                   /quantity/);
  // Insufficient stock at origin — no debit lands, no header written
  await assert.rejects(stSvc.openTransfer({ from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 9999 }] }),                                                /insufficient stock/);
  var sfs = await locSvc.stockForSku("WDG-1");
  check("insufficient-stock refusal leaves shelf untouched",
    sfs.by_location[0].quantity === 5);
  var headers = (await wired.q("SELECT COUNT(*) AS n FROM stock_transfers", [])).rows[0];
  check("insufficient-stock refusal leaves no header", Number(headers.n) === 0);
}

async function _fsmTransitions() {
  var wired = await _wire();
  var locSvc = wired.locSvc, stSvc = wired.stSvc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });

  var t = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 10 }],
  });
  check("FSM start = open",                   t.status === "open");

  // ship
  var shipTs = Date.now() + 1000;
  var t2 = await stSvc.markShipped({
    transfer_id: t.id, shipped_at: shipTs,
    carrier: "Acme Freight", tracking_number: "TRK-12345",
  });
  check("FSM ship status",                    t2.status === "shipped");
  check("FSM shipped_at captured",            t2.shipped_at === shipTs);
  check("FSM carrier captured",               t2.carrier === "Acme Freight");
  check("FSM tracking captured",              t2.tracking_number === "TRK-12345");

  // in_transit (with a scan beat)
  var t3 = await stSvc.markInTransit({
    transfer_id: t.id, location: "HUB-CHI", occurred_at: shipTs + 1000,
  });
  check("FSM in_transit status",              t3.status === "in_transit");

  // Repeat in_transit — idempotent on status, event log still grows
  var preEvents = (await wired.q(
    "SELECT COUNT(*) AS n FROM stock_transfer_events WHERE transfer_id = ?1",
    [t.id],
  )).rows[0].n;
  await stSvc.markInTransit({ transfer_id: t.id, location: "HUB-DEN" });
  var postEvents = (await wired.q(
    "SELECT COUNT(*) AS n FROM stock_transfer_events WHERE transfer_id = ?1",
    [t.id],
  )).rows[0].n;
  check("FSM in_transit re-scan logs an event", Number(postEvents) === Number(preEvents) + 1);

  // receive (exact match)
  var rxTs = shipTs + 2000;
  var t4 = await stSvc.markReceived({
    transfer_id: t.id,
    received_lines: [{ sku: "WDG-1", quantity_received: 10 }],
    received_at: rxTs,
  });
  check("FSM received status",                t4.status === "received");
  check("FSM received_at captured",           t4.received_at === rxTs);
  check("FSM receive captures qty",           t4.lines[0].quantity_received === 10);

  // reconcile
  var t5 = await stSvc.reconcile({ transfer_id: t.id });
  check("FSM reconciled status",              t5.status === "reconciled");
  check("FSM reconciled_at set",              typeof t5.reconciled_at === "number" && t5.reconciled_at > 0);
  check("FSM exact match: discrepancy=0",     t5.lines[0].discrepancy === 0);

  // Destination credited
  var west = await locSvc.stockForSku("WDG-1");
  var atWest = west.by_location.find(function (l) { return l.code === "WH-WEST"; });
  check("FSM destination credited",           atWest && atWest.quantity === 10);
  // Total stock unchanged — open debited 10, reconcile credited 10
  check("FSM total preserved",                west.total === 50);

  // Refuse re-shipping a reconciled transfer
  await assert.rejects(stSvc.markShipped({ transfer_id: t.id }),                                 /only open transfers/);
  await assert.rejects(stSvc.markReceived({ transfer_id: t.id, received_lines: [] }),            /only shipped or in_transit/);
  await assert.rejects(stSvc.reconcile({ transfer_id: t.id }),                                   /only received transfers/);
}

async function _markReceivedShortShip() {
  var wired = await _wire();
  var locSvc = wired.locSvc, stSvc = wired.stSvc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 30 });

  // Ship 10 WDG-1 + 8 WDG-2
  var t = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [
      { sku: "WDG-1", quantity: 10 },
      { sku: "WDG-2", quantity:  8 },
    ],
  });
  await stSvc.markShipped({ transfer_id: t.id });

  // Receive only 7 WDG-1 (short 3) and ALL 8 WDG-2 (clean)
  await stSvc.markReceived({
    transfer_id: t.id,
    received_lines: [
      { sku: "WDG-1", quantity_received: 7 },
      { sku: "WDG-2", quantity_received: 8 },
    ],
  });

  var reconciled = await stSvc.reconcile({ transfer_id: t.id });

  // Discrepancy column flagged
  var byLine = {};
  reconciled.lines.forEach(function (l) { byLine[l.sku] = l; });
  check("short-ship discrepancy WDG-1",       byLine["WDG-1"].discrepancy === 3);
  check("clean-ship discrepancy WDG-2",       byLine["WDG-2"].discrepancy === 0);

  // Destination credited with RECEIVED qty (not shipped qty)
  var w1 = await locSvc.stockForSku("WDG-1");
  var w1West = w1.by_location.find(function (l) { return l.code === "WH-WEST"; });
  check("short-ship credits received only",   w1West && w1West.quantity === 7);
  // Total down by 3 (the lost units)
  check("short-ship total reflects loss",     w1.total === 47);

  var w2 = await locSvc.stockForSku("WDG-2");
  check("clean-ship total preserved",         w2.total === 30);

  // Missing-SKU short-ship: ship 5 WDG-1, receive received_lines=[]
  // → discrepancy = 5 (every shipped unit was lost), destination
  // credited nothing.
  await locSvc.setStock({ sku: "WDG-3", location_code: "WH-EAST", quantity: 20 });
  var t2 = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-3", quantity: 5 }],
  });
  await stSvc.markShipped({ transfer_id: t2.id });
  await stSvc.markReceived({ transfer_id: t2.id, received_lines: [] });
  var rec2 = await stSvc.reconcile({ transfer_id: t2.id });
  check("missing-rx discrepancy = shipped",   rec2.lines[0].discrepancy === 5);
  check("missing-rx received = 0",            rec2.lines[0].quantity_received === 0);
  var w3 = await locSvc.stockForSku("WDG-3");
  var w3West = w3.by_location.find(function (l) { return l.code === "WH-WEST"; });
  check("missing-rx destination uncredited",  !w3West);
}

async function _discrepanciesFor() {
  var wired = await _wire();
  var locSvc = wired.locSvc, stSvc = wired.stSvc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 50 });

  var t = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [
      { sku: "WDG-1", quantity: 10 },
      { sku: "WDG-2", quantity: 10 },
    ],
  });
  await stSvc.markShipped({ transfer_id: t.id });
  await stSvc.markReceived({
    transfer_id: t.id,
    received_lines: [
      { sku: "WDG-1", quantity_received: 8 },   // short 2
      { sku: "WDG-2", quantity_received: 10 },  // clean
    ],
  });
  await stSvc.reconcile({ transfer_id: t.id });

  var diffs = await stSvc.discrepanciesFor(t.id);
  check("discrepanciesFor returns every line", diffs.length === 2);
  var bySku = {};
  diffs.forEach(function (d) { bySku[d.sku] = d; });
  check("discrepanciesFor WDG-1 short",        bySku["WDG-1"].discrepancy === 2);
  check("discrepanciesFor WDG-1 shipped",      bySku["WDG-1"].quantity_shipped === 10);
  check("discrepanciesFor WDG-1 received",     bySku["WDG-1"].quantity_received === 8);
  check("discrepanciesFor WDG-2 zero diff",    bySku["WDG-2"].discrepancy === 0);

  // Unknown transfer id → null (guardUuid still validates shape)
  var unknown = await stSvc.discrepanciesFor("01999999-9999-7999-8999-999999999999");
  check("discrepanciesFor unknown id = null",  unknown === null);
}

async function _markExceptionPath() {
  var wired = await _wire();
  var locSvc = wired.locSvc, stSvc = wired.stSvc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });

  var t = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 10 }],
  });
  await stSvc.markShipped({ transfer_id: t.id });

  // Truck lost — flag as exception
  var ex = await stSvc.markException({ transfer_id: t.id, reason: "carrier lost the pallet" });
  check("markException status",               ex.status === "exception");
  check("markException reason persisted",     ex.exception_reason === "carrier lost the pallet");

  // Origin shelf stays debited (operator compensates via a separate
  // inventoryLocations.setStock correction)
  var east = await locSvc.stockForSku("WDG-1");
  var atEast = east.by_location.find(function (l) { return l.code === "WH-EAST"; });
  check("exception leaves origin debited",    atEast && atEast.quantity === 40);

  // Destination uncredited
  var west = east.by_location.find(function (l) { return l.code === "WH-WEST"; });
  check("exception leaves destination empty", !west);

  // Cannot re-enter the FSM from exception
  await assert.rejects(stSvc.markShipped({ transfer_id: t.id }),                                 /only open transfers/);
  await assert.rejects(stSvc.markException({ transfer_id: t.id, reason: "again" }),              /cannot transition/);

  // markException refusals
  await assert.rejects(stSvc.markException(),                                                    /input object required/);
  await assert.rejects(stSvc.markException({ transfer_id: t.id }),                               /reason/);

  // Reconciled transfer cannot be flagged exception
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 10 });
  var t2 = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-2", quantity: 5 }],
  });
  await stSvc.markShipped({ transfer_id: t2.id });
  await stSvc.markReceived({ transfer_id: t2.id,
    received_lines: [{ sku: "WDG-2", quantity_received: 5 }] });
  await stSvc.reconcile({ transfer_id: t2.id });
  await assert.rejects(stSvc.markException({ transfer_id: t2.id, reason: "too late" }),          /cannot transition/);
}

async function _listAndTransfersForLocation() {
  var wired = await _wire();
  var locSvc = wired.locSvc, stSvc = wired.stSvc;
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST",   quantity: 100 });
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-WEST",   quantity: 100 });

  var tA = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 5 }],
  });
  var tB = await stSvc.openTransfer({
    from_location: "WH-WEST", to_location: "STORE-NYC",
    lines: [{ sku: "WDG-1", quantity: 3 }],
  });
  // Reconcile B to push it out of the open set
  await stSvc.markShipped({ transfer_id: tB.id });
  await stSvc.markReceived({ transfer_id: tB.id,
    received_lines: [{ sku: "WDG-1", quantity_received: 3 }] });
  await stSvc.reconcile({ transfer_id: tB.id });

  // listOpen returns only A
  var open = await stSvc.listOpen();
  check("listOpen excludes reconciled",       open.length === 1 && open[0].id === tA.id);

  // listOpen scoped by from_location
  var fromEast = await stSvc.listOpen({ from_location: "WH-EAST" });
  check("listOpen from_location filter",      fromEast.length === 1 && fromEast[0].id === tA.id);
  var fromWest = await stSvc.listOpen({ from_location: "WH-WEST" });
  check("listOpen from_location empty when reconciled", fromWest.length === 0);

  // transfersForLocation includes terminal transfers (the full history)
  var asOrigin = await stSvc.transfersForLocation({
    location_code: "WH-WEST", role: "origin",
  });
  check("transfersForLocation origin includes terminal", asOrigin.rows.length === 1 && asOrigin.rows[0].id === tB.id);
  var asDest = await stSvc.transfersForLocation({
    location_code: "STORE-NYC", role: "destination",
  });
  check("transfersForLocation destination",   asDest.rows.length === 1 && asDest.rows[0].id === tB.id);

  // Refusals
  await assert.rejects(stSvc.transfersForLocation({ location_code: "WH-EAST", role: "bogus" }),  /role/);
  await assert.rejects(stSvc.transfersForLocation({ location_code: "WH-EAST" }),                 /role/);
  await assert.rejects(stSvc.transfersForLocation({ location_code: "", role: "origin" }),        /location_code/);

  // getTransfer for a hydrated single
  var hyd = await stSvc.getTransfer(tA.id);
  check("getTransfer hydrates lines",         hyd && hyd.lines.length === 1);
  // Returns null on miss
  var miss = await stSvc.getTransfer("01999999-9999-7999-8999-999999999999");
  check("getTransfer miss returns null",      miss === null);
}

async function _factoryRefusals() {
  // Missing inventoryLocations
  assert.throws(function () { stockTransfers.create({}); },                                      /inventoryLocations/);
  assert.throws(function () { stockTransfers.create({ inventoryLocations: null }); },            /inventoryLocations/);
  // Wired with a stub missing adjustStock
  assert.throws(function () {
    stockTransfers.create({ inventoryLocations: { getLocation: function () {}, stockForSku: function () {} } });
  }, /adjustStock/);
  // Wired with a stub missing creditOnce — reconcile credits the destination
  // through creditOnce, so a stub without it must be refused at boot, not at
  // first reconcile (after the status claim has already flipped).
  assert.throws(function () {
    stockTransfers.create({ inventoryLocations: {
      adjustStock: function () {}, getLocation: function () {}, stockForSku: function () {},
    } });
  }, /creditOnce/);
  // cursorSecret required in production
  var origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(function () {
      stockTransfers.create({
        inventoryLocations: {
          adjustStock: function () {}, creditOnce: function () {}, getLocation: function () {}, stockForSku: function () {},
        },
      });
    }, /cursorSecret is required/);
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
  }
}

// Regression: a crash between crediting the destination and stamping the line
// discrepancy must NOT double-credit on the retry. The destination credit is
// keyed (creditOnce), so the re-run is a no-op rather than minting phantom
// inventory. Before the keyed credit, the stamp-failure path rolled the status
// claim back to 'received' with the line's discrepancy still NULL, so the retry
// re-credited the shelf a second time.
async function _reconcileCreditsExactlyOnceAcrossStampCrash() {
  var q = _makeQuery();
  var armed = true;
  var qWrap = async function (sql, params) {
    if (armed && /^\s*UPDATE stock_transfer_lines SET discrepancy/.test(sql)) {
      armed = false;   // one-shot: only the first stamp throws
      throw new Error("injected: discrepancy stamp failed");
    }
    return q(sql, params);
  };
  var locSvc = inventoryLocations.create({ query: qWrap, catalog: _stubCatalog() });
  await locSvc.defineLocation({ code: "WH-EAST", name: "East Warehouse", type: "warehouse", priority: 1 });
  await locSvc.defineLocation({ code: "WH-WEST", name: "West Warehouse", type: "warehouse", priority: 5 });
  var stSvc = stockTransfers.create({ query: qWrap, inventoryLocations: locSvc });

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  var t = await stSvc.openTransfer({
    from_location: "WH-EAST", to_location: "WH-WEST",
    lines: [{ sku: "WDG-1", quantity: 10 }],
  });
  await stSvc.markShipped({ transfer_id: t.id });
  await stSvc.markReceived({
    transfer_id: t.id,
    received_lines: [{ sku: "WDG-1", quantity_received: 10 }],
  });

  // First reconcile: creditOnce credits the destination, then the discrepancy
  // stamp throws -> the status claim rolls back to 'received'.
  await assert.rejects(stSvc.reconcile({ transfer_id: t.id }), /injected: discrepancy stamp failed/);

  var rolledBack = (await q("SELECT status FROM stock_transfers WHERE id = ?1", [t.id])).rows[0];
  check("status rolled back to received after stamp crash", rolledBack.status === "received");

  // The credit DID land on the first attempt (creditOnce won the claim).
  var westMid = await locSvc.stockForSku("WDG-1");
  var atWestMid = westMid.by_location.find(function (l) { return l.code === "WH-WEST"; });
  check("destination credited once after the failed reconcile", atWestMid && atWestMid.quantity === 10);

  // Retry reconcile (the stamp no longer throws). creditOnce sees the same key
  // and is a no-op -> destination stays at 10, NOT 20.
  var done = await stSvc.reconcile({ transfer_id: t.id });
  check("retry reconcile succeeds", done.status === "reconciled");
  check("retry stamps discrepancy = 0", done.lines[0].discrepancy === 0);

  var west = await locSvc.stockForSku("WDG-1");
  var atWest = west.by_location.find(function (l) { return l.code === "WH-WEST"; });
  check("destination credited EXACTLY once across crash+retry", atWest && atWest.quantity === 10);
  check("total stock preserved — no phantom inventory", west.total === 50);

  // Exactly one keyed credit row exists for this line.
  var lineRow = (await q("SELECT id FROM stock_transfer_lines WHERE transfer_id = ?1", [t.id])).rows[0];
  var creditRows = (await q(
    "SELECT COUNT(*) AS n FROM inventory_adjustments WHERE idempotency_key = ?1",
    ["stock-transfer:reconcile:" + t.id + ":" + lineRow.id],
  )).rows[0];
  check("exactly one keyed credit row for the line", Number(creditRows.n) === 1);
}

async function run() {
  await _openTransferHappyPath();
  await _openTransferRefusals();
  await _fsmTransitions();
  await _markReceivedShortShip();
  await _discrepanciesFor();
  await _markExceptionPath();
  await _listAndTransfersForLocation();
  await _factoryRefusals();
  await _reconcileCreditsExactlyOnceAcrossStampCrash();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("stock-transfers: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
