"use strict";
/**
 * backorder — out-of-stock SKUs that can still be ordered.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0001
 * (catalog — needs the `inventory` table so the availabilityFor read
 * resolves stock_on_hand) and migration 0035 (the backorder tables).
 *
 * Coverage:
 *   - markBackorderable persists + initialises pending counter to 0
 *   - recordBackorder writes a row + increments the counter; cap is
 *     enforced when configured
 *   - fulfillBackorder flips status + decrements the counter
 *   - availabilityFor returns in_stock when stock_on_hand > 0
 *   - availabilityFor returns backorderable when stock empty + flag
 *     active
 *   - availabilityFor returns out_of_stock when flag inactive (or
 *     never marked)
 *   - arrivalsThisWeek windows correctly on expected_ship_date
 *   - customerBackorders returns newest-first
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop     = require("../../lib");
var backorder = require("../../lib/backorder");
var helpers   = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0035_backorder.sql"].map(function (f) {
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

// Minimal catalog stub — only `inventory.get(sku)` is needed by the
// backorder primitive; the test seeds rows via direct INSERT so the
// availabilityFor read can resolve actual stock_on_hand values
// without dragging in the whole catalog primitive.
function _stubCatalog(query) {
  return {
    inventory: {
      get: async function (sku) {
        var r = await query("SELECT * FROM inventory WHERE sku = ?1", [sku]);
        return r.rows[0] || null;
      },
    },
  };
}

async function _setStock(query, sku, qty) {
  var now = Date.now();
  var existing = await query("SELECT sku FROM inventory WHERE sku = ?1", [sku]);
  if (existing.rows.length) {
    await query(
      "UPDATE inventory SET stock_on_hand = ?1, updated_at = ?2 WHERE sku = ?3",
      [qty, now, sku],
    );
  } else {
    await query(
      "INSERT INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES (?1, ?2, 0, ?3)",
      [sku, qty, now],
    );
  }
}

async function _markBackorderableAndCounterInit() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  var ship = Date.now() + 5 * 24 * 60 * 60 * 1000;
  var cfg = await bo.markBackorderable({
    sku:                       "WDG-PRO-BLK-L",
    max_backorder_quantity:    50,
    expected_ship_date:        ship,
    message:                   "Restocking from supplier",
  });
  check("mark sets sku",                      cfg.sku === "WDG-PRO-BLK-L");
  check("mark sets max_quantity",             cfg.max_quantity === 50);
  check("mark sets expected_ship_date",       cfg.expected_ship_date === ship);
  check("mark sets message",                  cfg.message === "Restocking from supplier");
  check("mark inits pending_quantity to 0",   cfg.pending_quantity === 0);
  check("mark inits active to 1",             cfg.active === 1);

  // Unlimited (null max) is accepted.
  var unlim = await bo.markBackorderable({
    sku:                "WDG-UNLIMITED",
    expected_ship_date: ship,
  });
  check("mark unlimited (no max field)",      unlim.max_quantity === null);
  var nullMax = await bo.markBackorderable({
    sku:                    "WDG-NULL-MAX",
    max_backorder_quantity: null,
    expected_ship_date:     ship,
  });
  check("mark unlimited (explicit null)",     nullMax.max_quantity === null);

  // Re-mark updates without resetting pending_quantity. Seed a
  // pending row first, then re-mark + verify the counter survives.
  await bo.recordBackorder({
    order_id:    bShop.framework.uuid.v7(),
    customer_id: bShop.framework.uuid.v7(),
    sku:         "WDG-PRO-BLK-L",
    quantity:    3,
  });
  var preRemark = await bo.getStatus("WDG-PRO-BLK-L");
  check("pre-remark pending=3",               preRemark.pending_quantity === 3);
  var remarked = await bo.markBackorderable({
    sku:                       "WDG-PRO-BLK-L",
    max_backorder_quantity:    100,
    expected_ship_date:        ship + 1000,
    message:                   "Updated",
  });
  check("re-mark preserves pending counter",  remarked.pending_quantity === 3);
  check("re-mark updates max",                remarked.max_quantity === 100);
  check("re-mark updates message",            remarked.message === "Updated");

  // Refusals
  await assert.rejects(bo.markBackorderable(),                                  /input object required/);
  await assert.rejects(bo.markBackorderable({ sku: "bad sku", expected_ship_date: ship }), /sku/);
  await assert.rejects(bo.markBackorderable({ sku: "WDG-1", expected_ship_date: -1 }), /expected_ship_date/);
  await assert.rejects(bo.markBackorderable({ sku: "WDG-1", expected_ship_date: ship, max_backorder_quantity: -3 }), /max_backorder_quantity/);
  var bigMsg = new Array(282).join("x");
  await assert.rejects(bo.markBackorderable({ sku: "WDG-1", expected_ship_date: ship, message: bigMsg }), /message/);

  // markNotBackorderable flips active=0 and preserves the row
  var off = await bo.markNotBackorderable("WDG-PRO-BLK-L");
  check("markNotBackorderable flips active",  off.active === 0);
  check("markNotBackorderable preserves row", off.pending_quantity === 3);
  var miss = await bo.markNotBackorderable("WDG-NEVER-SEEN");
  check("markNotBackorderable miss = null",   miss === null);
}

async function _recordBackorderCounterAndCap() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  var ship = Date.now() + 5 * 24 * 60 * 60 * 1000;
  await bo.markBackorderable({
    sku:                    "WDG-CAP",
    max_backorder_quantity: 10,
    expected_ship_date:     ship,
  });

  var customer = bShop.framework.uuid.v7();
  var order1 = bShop.framework.uuid.v7();
  var r1 = await bo.recordBackorder({
    order_id: order1, customer_id: customer, sku: "WDG-CAP", quantity: 4,
  });
  check("record returns id",                  typeof r1.id === "string" && r1.id.length === 36);
  check("record status=recorded",             r1.status === "recorded");
  var c1 = await bo.getStatus("WDG-CAP");
  check("counter +4 after first record",      c1.pending_quantity === 4);

  // Second order, same sku, brings pending to 8 (≤ cap of 10)
  var order2 = bShop.framework.uuid.v7();
  await bo.recordBackorder({
    order_id: order2, customer_id: customer, sku: "WDG-CAP", quantity: 4,
  });
  var c2 = await bo.getStatus("WDG-CAP");
  check("counter +4 after second record",     c2.pending_quantity === 8);

  // Third order would push to 11 — refused
  var order3 = bShop.framework.uuid.v7();
  await assert.rejects(bo.recordBackorder({
    order_id: order3, customer_id: customer, sku: "WDG-CAP", quantity: 3,
  }), /max_backorder_quantity/);
  var c3 = await bo.getStatus("WDG-CAP");
  check("counter unchanged on cap refusal",   c3.pending_quantity === 8);

  // Idempotent dedup on (order_id, sku) — replay first order returns
  // dedup and does NOT double-increment.
  var dup = await bo.recordBackorder({
    order_id: order1, customer_id: customer, sku: "WDG-CAP", quantity: 4,
  });
  check("replay returns dedup",               dup.status === "dedup");
  var c4 = await bo.getStatus("WDG-CAP");
  check("dedup does not double-count",        c4.pending_quantity === 8);

  // Atomic cap under a race: a concurrent recordBackorder that takes the
  // remaining capacity between our stale cap read and our counter increment
  // must NOT let pending exceed the cap. A query wrapper injects the competing
  // increment right before this call's line INSERT (i.e. after the early cap
  // read), so only the cap-guarded claim decides the outcome.
  var rq = _makeQuery();
  var raceArmed = false;
  var raceQuery = async function (sql, params) {
    // Fire the competing increment right BEFORE the cap-claim UPDATE (after
    // the stale early read), so only the guarded claim decides the outcome.
    if (raceArmed && /UPDATE backorder_skus SET pending_quantity = pending_quantity \+ /i.test(sql)) {
      raceArmed = false;
      await rq("UPDATE backorder_skus SET pending_quantity = 10 WHERE sku = ?1", ["WDG-RACE"]);
    }
    return rq(sql, params);
  };
  var boRace = backorder.create({ query: raceQuery, catalog: _stubCatalog(raceQuery) });
  await boRace.markBackorderable({ sku: "WDG-RACE", max_backorder_quantity: 10, expected_ship_date: ship });
  await boRace.recordBackorder({ order_id: bShop.framework.uuid.v7(), customer_id: customer, sku: "WDG-RACE", quantity: 8 });
  var raceOrder = bShop.framework.uuid.v7();
  raceArmed = true;
  await assert.rejects(boRace.recordBackorder({
    order_id: raceOrder, customer_id: customer, sku: "WDG-RACE", quantity: 2,
  }), /max_backorder_quantity/);
  var raceCfg = await boRace.getStatus("WDG-RACE");
  check("atomic cap: counter not pushed past cap by a race", raceCfg.pending_quantity === 10);
  var orphan = await rq("SELECT id FROM backorder_lines WHERE order_id = ?1 AND sku = ?2", [raceOrder, "WDG-RACE"]);
  check("atomic cap: refused line reverted (no orphan)",     orphan.rows.length === 0);

  // Refusal: sku not backorderable
  await assert.rejects(bo.recordBackorder({
    order_id:    bShop.framework.uuid.v7(),
    customer_id: customer,
    sku:         "WDG-NEVER-MARKED",
    quantity:    1,
  }), /not currently backorderable/);

  // Refusal: inactive sku
  await bo.markNotBackorderable("WDG-CAP");
  await assert.rejects(bo.recordBackorder({
    order_id:    bShop.framework.uuid.v7(),
    customer_id: customer,
    sku:         "WDG-CAP",
    quantity:    1,
  }), /not currently backorderable/);

  // Refusal: bad input shapes
  await assert.rejects(bo.recordBackorder(),                                       /input object required/);
  await assert.rejects(bo.recordBackorder({
    order_id: "not-a-uuid", customer_id: customer, sku: "WDG-CAP", quantity: 1,
  }), /order_id/);
  await assert.rejects(bo.recordBackorder({
    order_id: bShop.framework.uuid.v7(), customer_id: "nope", sku: "WDG-CAP", quantity: 1,
  }), /customer_id/);
  await assert.rejects(bo.recordBackorder({
    order_id: bShop.framework.uuid.v7(), customer_id: customer, sku: "WDG-CAP", quantity: 0,
  }), /quantity/);
}

async function _fulfillCounterDecrement() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  var ship = Date.now() + 5 * 24 * 60 * 60 * 1000;
  await bo.markBackorderable({
    sku: "WDG-FUL", max_backorder_quantity: 100, expected_ship_date: ship,
  });
  var customer = bShop.framework.uuid.v7();
  var order = bShop.framework.uuid.v7();
  await bo.recordBackorder({
    order_id: order, customer_id: customer, sku: "WDG-FUL", quantity: 7,
  });
  var pre = await bo.getStatus("WDG-FUL");
  check("pre-fulfill pending=7",              pre.pending_quantity === 7);

  var ful = await bo.fulfillBackorder({ order_id: order, sku: "WDG-FUL" });
  check("fulfill returns status=fulfilled",   ful.status === "fulfilled");
  var post = await bo.getStatus("WDG-FUL");
  check("counter -7 after fulfill",           post.pending_quantity === 0);

  // Refuse re-fulfill (status is fulfilled, not pending)
  await assert.rejects(bo.fulfillBackorder({ order_id: order, sku: "WDG-FUL" }),
    /only pending lines/);
  // The counter is debited exactly once: a refused re-fulfill must not
  // decrement pending_quantity again (the line transition and the
  // counter debit are claimed together — the debit only fires when the
  // pending->fulfilled claim wins).
  var postRefuse = await bo.getStatus("WDG-FUL");
  check("counter unchanged after refused re-fulfill", postRefuse.pending_quantity === 0);

  // Refuse missing line
  await assert.rejects(bo.fulfillBackorder({
    order_id: bShop.framework.uuid.v7(), sku: "WDG-FUL",
  }), /no backorder line/);

  // Cancel path also decrements the counter
  var order2 = bShop.framework.uuid.v7();
  await bo.recordBackorder({
    order_id: order2, customer_id: customer, sku: "WDG-FUL", quantity: 5,
  });
  var c1 = await bo.getStatus("WDG-FUL");
  check("pre-cancel pending=5",               c1.pending_quantity === 5);
  var cancelled = await bo.cancelBackorder({
    order_id: order2, sku: "WDG-FUL", reason: "customer changed their mind",
  });
  check("cancel returns status=cancelled",    cancelled.status === "cancelled");
  var c2 = await bo.getStatus("WDG-FUL");
  check("counter -5 after cancel",            c2.pending_quantity === 0);
  // Refuse re-cancel
  await assert.rejects(bo.cancelBackorder({
    order_id: order2, sku: "WDG-FUL", reason: "again",
  }), /only pending lines/);
}

async function _availabilityInStock() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  // Seed inventory with positive stock
  await _setStock(q, "WDG-SHELF", 12);
  // Even if the SKU is also marked backorderable, in_stock wins
  await bo.markBackorderable({
    sku: "WDG-SHELF", expected_ship_date: Date.now() + 86400000,
  });
  var a = await bo.availabilityFor("WDG-SHELF");
  check("availability in_stock when stock>0", a.status === "in_stock");
  check("no expected_ship_date in_stock",     a.expected_ship_date === undefined);
}

async function _availabilityBackorderable() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  // No inventory row at all (catalog empty for this sku)
  var ship = Date.now() + 3 * 24 * 60 * 60 * 1000;
  await bo.markBackorderable({
    sku: "WDG-EMPTY-BO", expected_ship_date: ship, message: "Ships in 3 days",
  });
  var a = await bo.availabilityFor("WDG-EMPTY-BO");
  check("availability=backorderable",         a.status === "backorderable");
  check("availability ship date",             a.expected_ship_date === ship);
  check("availability message",               a.message === "Ships in 3 days");

  // Also backorderable when inventory row exists but stock=0
  await _setStock(q, "WDG-ZERO", 0);
  await bo.markBackorderable({
    sku: "WDG-ZERO", expected_ship_date: ship + 1000,
  });
  var b = await bo.availabilityFor("WDG-ZERO");
  check("availability=backorderable @ stock=0", b.status === "backorderable");
}

async function _availabilityOutOfStock() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  // Never marked backorderable + no inventory
  var a = await bo.availabilityFor("WDG-UNKNOWN");
  check("availability=out_of_stock (no config)", a.status === "out_of_stock");

  // Marked but then flipped off — out_of_stock once stock is 0
  await bo.markBackorderable({
    sku: "WDG-WAS-BO", expected_ship_date: Date.now() + 86400000,
  });
  await bo.markNotBackorderable("WDG-WAS-BO");
  var b = await bo.availabilityFor("WDG-WAS-BO");
  check("availability=out_of_stock (active=0)",  b.status === "out_of_stock");
}

async function _arrivalsThisWeek() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  var now = Date.now();
  var inTwoDays  = now + 2 * 24 * 60 * 60 * 1000;
  var inSixDays  = now + 6 * 24 * 60 * 60 * 1000;
  var inTenDays  = now + 10 * 24 * 60 * 60 * 1000;
  await bo.markBackorderable({ sku: "WDG-WK-A", expected_ship_date: inTwoDays });
  await bo.markBackorderable({ sku: "WDG-WK-B", expected_ship_date: inSixDays });
  await bo.markBackorderable({ sku: "WDG-WK-C", expected_ship_date: inTenDays });

  var customer = bShop.framework.uuid.v7();
  var orderA = bShop.framework.uuid.v7();
  var orderB = bShop.framework.uuid.v7();
  var orderC = bShop.framework.uuid.v7();
  await bo.recordBackorder({ order_id: orderA, customer_id: customer, sku: "WDG-WK-A", quantity: 1 });
  await bo.recordBackorder({ order_id: orderB, customer_id: customer, sku: "WDG-WK-B", quantity: 1 });
  await bo.recordBackorder({ order_id: orderC, customer_id: customer, sku: "WDG-WK-C", quantity: 1 });

  var arrivals = await bo.arrivalsThisWeek();
  check("arrivals returns 2 (within 7d)",     arrivals.length === 2);
  check("arrivals ordered by ship date asc",  arrivals[0].sku === "WDG-WK-A" && arrivals[1].sku === "WDG-WK-B");
  var skus = arrivals.map(function (r) { return r.sku; });
  check("arrivals excludes 10-day-out sku",   skus.indexOf("WDG-WK-C") === -1);

  // Fulfilled lines drop out of arrivals — only pending lines count
  await bo.fulfillBackorder({ order_id: orderA, sku: "WDG-WK-A" });
  var arr2 = await bo.arrivalsThisWeek();
  check("arrivals excludes fulfilled lines",  arr2.length === 1 && arr2[0].sku === "WDG-WK-B");
}

async function _customerBackordersOrdering() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  var ship = Date.now() + 86400000;
  await bo.markBackorderable({ sku: "WDG-C-1", expected_ship_date: ship });
  await bo.markBackorderable({ sku: "WDG-C-2", expected_ship_date: ship });
  await bo.markBackorderable({ sku: "WDG-C-3", expected_ship_date: ship });

  var customer  = bShop.framework.uuid.v7();
  var customer2 = bShop.framework.uuid.v7();
  var ids = [];
  // Record three lines in order; the v7-uuid PK encodes the
  // monotonic ms timestamp so ORDER BY id DESC sorts newest-first.
  for (var i = 0; i < 3; i += 1) {
    var r = await bo.recordBackorder({
      order_id:    bShop.framework.uuid.v7(),
      customer_id: customer,
      sku:         "WDG-C-" + (i + 1),
      quantity:    1,
    });
    ids.push(r.id);
    // Pause one millisecond so the v7-uuid timestamp prefix advances
    // between rows. v7's millisecond resolution would otherwise let
    // the three rows collide on the same prefix and rely on the
    // monotonic sub-ms counter — fine in practice, but the test
    // wants a deterministic ordering signal without depending on
    // that implementation detail.
    await helpers.waitUntil(function (start) {
      return function () { return Date.now() > start; };
    }(Date.now()), { timeoutMs: 2000, intervalMs: 1, label: "ms tick" });
  }

  // Add an unrelated customer's row so the scoping check has signal.
  await bo.recordBackorder({
    order_id:    bShop.framework.uuid.v7(),
    customer_id: customer2,
    sku:         "WDG-C-1",
    quantity:    1,
  });

  var rows = await bo.customerBackorders(customer);
  check("customerBackorders count",           rows.length === 3);
  check("customerBackorders newest first",    rows[0].id === ids[2] && rows[2].id === ids[0]);
  check("customerBackorders scoped to one",   rows.every(function (r) { return r.customer_id === customer; }));

  // pendingForSku scopes to one sku
  var pending = await bo.pendingForSku("WDG-C-1");
  check("pendingForSku returns both rows",    pending.length === 2);
  check("pendingForSku scoped",               pending.every(function (r) { return r.sku === "WDG-C-1"; }));

  // After fulfilling one, pendingForSku drops it
  var first = pending[0];
  await bo.fulfillBackorder({ order_id: first.order_id, sku: "WDG-C-1" });
  var pending2 = await bo.pendingForSku("WDG-C-1");
  check("pendingForSku skips fulfilled",      pending2.length === 1);

  // Refusals
  await assert.rejects(bo.customerBackorders("not-a-uuid"),                       /customer_id/);
}

async function _listBackorderable() {
  var q = _makeQuery();
  var bo = backorder.create({ query: q, catalog: _stubCatalog(q) });
  var ship = Date.now() + 86400000;
  await bo.markBackorderable({ sku: "WDG-L-A", expected_ship_date: ship });
  await bo.markBackorderable({ sku: "WDG-L-B", expected_ship_date: ship + 1000 });
  await bo.markBackorderable({ sku: "WDG-L-C", expected_ship_date: ship + 2000 });
  await bo.markNotBackorderable("WDG-L-B");

  var all = await bo.listBackorderable();
  check("listBackorderable all returns 3",       all.length === 3);
  var active = await bo.listBackorderable({ active_only: true });
  check("listBackorderable active=2",            active.length === 2);
  var skus = active.map(function (r) { return r.sku; });
  check("listBackorderable active excludes off", skus.indexOf("WDG-L-B") === -1);
}

async function _factoryRefusals() {
  assert.throws(function () { backorder.create({}); },                       /catalog/);
  assert.throws(function () { backorder.create({ catalog: {} }); },          /catalog/);
  assert.throws(function () { backorder.create({ catalog: { inventory: {} } }); }, /inventory.get/);
}

async function run() {
  await _markBackorderableAndCounterInit();
  await _recordBackorderCounterAndCap();
  await _fulfillCounterDecrement();
  await _availabilityInStock();
  await _availabilityBackorderable();
  await _availabilityOutOfStock();
  await _arrivalsThisWeek();
  await _customerBackordersOrdering();
  await _listBackorderable();
  await _factoryRefusals();
}

module.exports = { run: run };
