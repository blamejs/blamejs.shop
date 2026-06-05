"use strict";
/**
 * inventory hold / decrement / release — the checkout-time stock math.
 *
 * Layer 1 against in-memory node:sqlite loaded from 0001 (catalog) +
 * 0008 (low_stock_threshold). Exercises the atomic conditional-UPDATE
 * guards that keep the buy path oversell-safe:
 *
 *   - hold reserves available stock (on_hand − held) and refuses when
 *     the line would overdraw the shelf (rowCount 0 → held:false);
 *   - hold against an un-tracked SKU (no row) returns null (unlimited);
 *   - decrement converts a hold to a real shelf debit and is idempotent
 *     (a second call against an already-debited hold is a no-op);
 *   - release returns held units to available;
 *   - the conditional guard refuses a hold that exceeds what's left after
 *     a prior hold, so two reservations can't both take the last unit.
 */

var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var MIGS = ["0001_catalog.sql", "0008_inventory_thresholds.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _setup() {
  var mem = helpers.memD1Query(MIGS);
  var catalog = bShop.catalog.create({ query: mem.query });
  return { catalog: catalog, inv: catalog.inventory };
}

async function _holdMath() {
  var s = _setup();
  await s.inv.create("HM-1", { stock_on_hand: 10 });

  var h1 = await s.inv.hold("HM-1", 3);
  check("hold returns held:true",          h1 && h1.held === true);
  var row = await s.inv.get("HM-1");
  check("hold raises stock_held",          row.stock_held === 3);
  check("hold leaves on_hand untouched",   row.stock_on_hand === 10);
  // available = on_hand - held = 7

  var h2 = await s.inv.hold("HM-1", 7);
  check("second hold drains to available", h2.held === true);
  row = await s.inv.get("HM-1");
  check("held now equals on_hand",         row.stock_held === 10);
}

async function _holdRefusesOverdraw() {
  var s = _setup();
  await s.inv.create("HM-2", { stock_on_hand: 5 });
  await s.inv.hold("HM-2", 4);                       // available now 1

  var refused = await s.inv.hold("HM-2", 2);         // needs 2, only 1 free
  check("overdraw hold refused",           refused && refused.held === false);
  var row = await s.inv.get("HM-2");
  check("refused hold leaves held at 4",   row.stock_held === 4);

  var lastUnit = await s.inv.hold("HM-2", 1);        // exactly the 1 left
  check("exact-fit hold succeeds",         lastUnit.held === true);
  row = await s.inv.get("HM-2");
  check("held now full at 5",              row.stock_held === 5);
  check("no overdraw — held <= on_hand",   row.stock_held <= row.stock_on_hand);
}

async function _holdUntrackedSkuIsUnlimited() {
  var s = _setup();
  // No inventory.create → no row. A hold against it returns null so the
  // checkout treats the SKU as unlimited and lets the line through.
  var res = await s.inv.hold("NO-ROW-SKU", 99);
  check("untracked SKU hold returns null", res === null);
}

async function _decrementConvertsHold() {
  var s = _setup();
  await s.inv.create("HM-3", { stock_on_hand: 8 });
  await s.inv.hold("HM-3", 3);

  var d = await s.inv.decrement("HM-3", 3);
  check("decrement reports decremented",   d && d.decremented === true);
  var row = await s.inv.get("HM-3");
  check("decrement lowers on_hand",        row.stock_on_hand === 5);
  check("decrement clears the held units", row.stock_held === 0);
}

async function _decrementIsIdempotent() {
  var s = _setup();
  await s.inv.create("HM-4", { stock_on_hand: 6 });
  await s.inv.hold("HM-4", 2);
  await s.inv.decrement("HM-4", 2);                  // on_hand 4, held 0

  // A re-delivered paid event would call decrement again against the same
  // (now-consumed) hold. The guard (stock_held >= qty) no longer matches,
  // so it's a no-op — on_hand stays 4, not 2.
  var again = await s.inv.decrement("HM-4", 2);
  check("re-decrement is a no-op",         again && again.decremented === false);
  var row = await s.inv.get("HM-4");
  check("on_hand unchanged on re-deliver", row.stock_on_hand === 4);
  check("held stays 0",                    row.stock_held === 0);
}

async function _releaseReturnsToAvailable() {
  var s = _setup();
  await s.inv.create("HM-5", { stock_on_hand: 10 });
  await s.inv.hold("HM-5", 4);

  await s.inv.release("HM-5", 4);
  var row = await s.inv.get("HM-5");
  check("release clears the hold",         row.stock_held === 0);
  check("release leaves on_hand intact",   row.stock_on_hand === 10);

  // A double-release (e.g. a re-cancel) floors at zero — never negative.
  await s.inv.release("HM-5", 4);
  row = await s.inv.get("HM-5");
  check("double-release floors at zero",   row.stock_held === 0);
}

async function run() {
  await _holdMath();
  await _holdRefusesOverdraw();
  await _holdUntrackedSkuIsUnlimited();
  await _decrementConvertsHold();
  await _decrementIsIdempotent();
  await _releaseReturnsToAvailable();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("inventory-hold-decrement OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("inventory-hold-decrement FAIL: " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
