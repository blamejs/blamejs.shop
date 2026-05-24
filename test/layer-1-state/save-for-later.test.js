"use strict";
/**
 * save-for-later — storefront panel adjacent to the cart.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migrations: 0001 (catalog), 0002 (cart), 0035 (backorder), and
 * 0041 (save_for_later). Every UNIQUE / CHECK in the shipped schema
 * is exercised against the catalog handle the primitive composes.
 *
 * Coverage:
 *   - moveFromCart: atomic move (cart line gone, save row written,
 *     snapshot price + variant + quantity preserved)
 *   - moveToCart with use_price="saved": cart line uses the snapshot
 *     price even after the catalog price moved
 *   - moveToCart with use_price="current": cart line picks up the
 *     fresh catalog price
 *   - moveToCart refuses an out-of-stock + not-backorderable SKU
 *   - moveToCart succeeds on out-of-stock + backorderable SKU
 *   - add: direct save (no cart line) persists the snapshot inputs
 *   - add: dedup via UNIQUE(customer, sku, variant) — second add
 *     returns status "dedup"
 *   - staleCheck: flags is_stale (price changed), is_unavailable
 *     (variant gone), is_low_stock (catalog stock < saved qty +
 *     not backorderable)
 *   - repriceAll: bulk-update touches only rows whose price moved
 *   - expireOlderThan: removes rows older than `days`
 *   - listForCustomer: pagination + tamper-refused cursor
 *   - countForCustomer / remove / clear
 *   - refusals: missing customer_id, bad use_price, oversized notes,
 *     non-positive quantity, negative snapshot price, non-string
 *     notes, control-byte notes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_CATALOG   = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART      = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");
var MIG_BACKORDER = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0035_backorder.sql");
var MIG_SAVE      = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0041_save_for_later.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_CART, MIG_BACKORDER, MIG_SAVE].forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
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

function _uuid() { return bShop.framework.uuid.v7(); }

function _newSessionId() {
  // Random 12-char alnum/_/- so the cart primitive's session-id
  // shape gate (16-64 chars of [A-Za-z0-9_-]) is satisfied.
  return "sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");        // allow:math-random — non-security test fixture
}

// Shared setup: a product with two variants priced in USD, plus a
// catalog inventory row per SKU so the stock gate has something to
// read.
async function _seedCatalog(catalog, opts) {
  opts = opts || {};
  var p = await catalog.products.create({ slug: "widget-pro-" + Math.random().toString(36).slice(2, 8), title: "Widget Pro", status: "active" });        // allow:math-random — unique slug per test
  var v1 = await catalog.variants.create(p.id, { sku: "WDG-" + Math.random().toString(36).slice(2, 8).toUpperCase() });   // allow:math-random — unique SKU per test
  var v2 = await catalog.variants.create(p.id, { sku: "WDG-" + Math.random().toString(36).slice(2, 8).toUpperCase() });   // allow:math-random — unique SKU per test
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: opts.price1 || 2999 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: opts.price2 || 4500 });
  await catalog.inventory.create(v1.sku, { stock_on_hand: opts.stock1 == null ? 50 : opts.stock1 });
  await catalog.inventory.create(v2.sku, { stock_on_hand: opts.stock2 == null ? 50 : opts.stock2 });
  return { product: p, v1: v1, v2: v2 };
}

async function _makeStack(opts) {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var sfl     = bShop.saveForLater.create({ query: query, catalog: catalog, currency: "USD" });
  var seeded  = await _seedCatalog(catalog, opts || {});
  return { query: query, catalog: catalog, cart: cart, sfl: sfl, seeded: seeded };
}

// ---- tests --------------------------------------------------------------

async function _moveFromCartAtomic() {
  var s = await _makeStack();
  var sid = _newSessionId();
  var cart = await s.cart.create(sid, { currency: "USD" });
  var line = await s.cart.addLine(cart.id, { variant_id: s.seeded.v1.id, qty: 3 });

  var customer = _uuid();
  var moved = await s.sfl.moveFromCart({
    customer_id: customer,
    cart_id:     cart.id,
    line_id:     line.id,
  });
  check("moveFromCart: returns id",          typeof moved.id === "string" && moved.id.length === 36);
  check("moveFromCart: status = added",      moved.status === "added");
  check("moveFromCart: returns sku",         moved.sku === s.seeded.v1.sku);

  // Cart line is gone.
  var afterCartLines = await s.cart.listLines(cart.id);
  check("moveFromCart: cart line removed",   afterCartLines.length === 0);

  // Save row landed with the right shape.
  var savedRow = (await s.query("SELECT * FROM save_for_later WHERE id = ?1", [moved.id])).rows[0];
  check("moveFromCart: save row written",                savedRow != null);
  check("moveFromCart: snapshot price preserved",        savedRow.snapshot_price_minor === 2999);
  check("moveFromCart: quantity preserved",              savedRow.quantity === 3);
  check("moveFromCart: variant preserved",               savedRow.variant_id === s.seeded.v1.id);
  check("moveFromCart: sku preserved",                   savedRow.sku === s.seeded.v1.sku);
  check("moveFromCart: source_cart_id breadcrumb",       savedRow.source_cart_id === cart.id);
  check("moveFromCart: source_line_id breadcrumb",       savedRow.source_line_id === line.id);
  check("moveFromCart: last_repriced_at null on insert", savedRow.last_repriced_at == null);
}

async function _moveFromCartUnknownLineRefuses() {
  var s = await _makeStack();
  var sid = _newSessionId();
  var cart = await s.cart.create(sid, { currency: "USD" });
  var customer = _uuid();

  await assert.rejects(
    s.sfl.moveFromCart({ customer_id: customer, cart_id: cart.id, line_id: _uuid() }),
    /not found/,
  );
}

async function _moveToCartUsePriceSavedVsCurrent() {
  var s = await _makeStack({ price1: 2999 });
  var sid = _newSessionId();
  var cart = await s.cart.create(sid, { currency: "USD" });
  var line = await s.cart.addLine(cart.id, { variant_id: s.seeded.v1.id, qty: 2 });

  var customer = _uuid();
  var moved = await s.sfl.moveFromCart({
    customer_id: customer,
    cart_id:     cart.id,
    line_id:     line.id,
  });

  // Catalog price moves.
  await s.catalog.prices.set(s.seeded.v1.id, { currency: "USD", amount_minor: 3999 });

  // Re-add at the saved snapshot price (2999).
  var savedCart = await s.cart.create(_newSessionId(), { currency: "USD" });
  var savedBack = await s.sfl.moveToCart({
    customer_id: customer,
    save_id:     moved.id,
    cart_id:     savedCart.id,
    use_price:   "saved",
  });
  check("moveToCart use_price='saved': line at snapshot price",
    savedBack.unit_amount_minor === 2999 && savedBack.priced_from === "saved");
  check("moveToCart use_price='saved': sku preserved",   savedBack.sku === s.seeded.v1.sku);
  check("moveToCart use_price='saved': qty preserved",   savedBack.quantity === 2);
  check("moveToCart use_price='saved': currency",        savedBack.unit_currency === "USD");

  // The save row is gone after moveToCart.
  var savedAfter = (await s.query("SELECT * FROM save_for_later WHERE id = ?1", [moved.id])).rows;
  check("moveToCart: save row deleted",                  savedAfter.length === 0);

  // The cart line landed.
  var lines = await s.cart.listLines(savedCart.id);
  check("moveToCart: cart line created",                 lines.length === 1 && lines[0].sku === s.seeded.v1.sku);

  // Set up a second save row, re-add at current price (3999).
  var line2 = await s.cart.addLine(savedCart.id, { variant_id: s.seeded.v2.id, qty: 1 });
  var moved2 = await s.sfl.moveFromCart({
    customer_id: customer,
    cart_id:     savedCart.id,
    line_id:     line2.id,
  });
  await s.catalog.prices.set(s.seeded.v2.id, { currency: "USD", amount_minor: 5500 });
  var thirdCart = await s.cart.create(_newSessionId(), { currency: "USD" });
  var current = await s.sfl.moveToCart({
    customer_id: customer,
    save_id:     moved2.id,
    cart_id:     thirdCart.id,
    use_price:   "current",
  });
  check("moveToCart use_price='current': line at current catalog price",
    current.unit_amount_minor === 5500 && current.priced_from === "current");
}

async function _moveToCartRefusesOutOfStockNotBackorderable() {
  var s = await _makeStack({ stock1: 5 });
  var sid = _newSessionId();
  var cart = await s.cart.create(sid, { currency: "USD" });
  var line = await s.cart.addLine(cart.id, { variant_id: s.seeded.v1.id, qty: 3 });

  var customer = _uuid();
  var moved = await s.sfl.moveFromCart({
    customer_id: customer,
    cart_id:     cart.id,
    line_id:     line.id,
  });

  // Drop stock below saved quantity.
  await s.query(
    "UPDATE inventory SET stock_on_hand = ?1 WHERE sku = ?2",
    [1, s.seeded.v1.sku],
  );

  var newCart = await s.cart.create(_newSessionId(), { currency: "USD" });
  await assert.rejects(
    s.sfl.moveToCart({
      customer_id: customer,
      save_id:     moved.id,
      cart_id:     newCart.id,
      use_price:   "saved",
    }),
    /out of stock/,
  );

  // The save row survives the refusal.
  var saved = (await s.query("SELECT * FROM save_for_later WHERE id = ?1", [moved.id])).rows[0];
  check("moveToCart refusal: save row preserved", saved != null);

  // Mark the SKU backorderable — moveToCart now succeeds.
  var now = Date.now();
  await s.query(
    "INSERT INTO backorder_skus (sku, max_quantity, expected_ship_date, message, pending_quantity, active, created_at, updated_at) " +
    "VALUES (?1, NULL, ?2, '', 0, 1, ?3, ?3)",
    [s.seeded.v1.sku, now + 7 * 24 * 60 * 60 * 1000, now],
  );

  var ok = await s.sfl.moveToCart({
    customer_id: customer,
    save_id:     moved.id,
    cart_id:     newCart.id,
    use_price:   "saved",
  });
  check("moveToCart: backorderable SKU bypasses stock gate", ok.unit_amount_minor === 2999);
}

async function _addDedupViaUnique() {
  var s = await _makeStack();
  var customer = _uuid();

  var first = await s.sfl.add({
    customer_id:          customer,
    sku:                  s.seeded.v1.sku,
    variant_id:           s.seeded.v1.id,
    quantity:             1,
    snapshot_price_minor: 2999,
    notes:                "for the office desk",
  });
  check("add: returns id (uuid shape)",      typeof first.id === "string" && first.id.length === 36);
  check("add: first call status = added",    first.status === "added");

  // Second add on the same (customer, sku, variant) is a dedup.
  var second = await s.sfl.add({
    customer_id:          customer,
    sku:                  s.seeded.v1.sku,
    variant_id:           s.seeded.v1.id,
    quantity:             5,
    snapshot_price_minor: 9999,
  });
  check("add: dedup returns the same id",    second.id === first.id);
  check("add: dedup status = dedup",         second.status === "dedup");

  // The original row is preserved (the second add does NOT clobber
  // quantity / snapshot price — INSERT OR IGNORE).
  var row = (await s.query("SELECT * FROM save_for_later WHERE id = ?1", [first.id])).rows[0];
  check("add: dedup leaves original quantity",   row.quantity === 1);
  check("add: dedup leaves original price",      row.snapshot_price_minor === 2999);
  check("add: notes persisted on first insert",  row.notes === "for the office desk");

  // A different variant of the same product coexists.
  var different = await s.sfl.add({
    customer_id:          customer,
    sku:                  s.seeded.v2.sku,
    variant_id:           s.seeded.v2.id,
    quantity:             2,
    snapshot_price_minor: 4500,
  });
  check("add: different variant adds a new row", different.id !== first.id && different.status === "added");
}

async function _staleCheckFlags() {
  var s = await _makeStack({ price1: 2999, price2: 4500, stock1: 50, stock2: 50 });
  var customer = _uuid();

  // Row A — will become stale (price moves).
  var a = await s.sfl.add({
    customer_id:          customer,
    sku:                  s.seeded.v1.sku,
    variant_id:           s.seeded.v1.id,
    quantity:             1,
    snapshot_price_minor: 2999,
  });
  // Row B — will become unavailable (variant deleted).
  var b = await s.sfl.add({
    customer_id:          customer,
    sku:                  s.seeded.v2.sku,
    variant_id:           s.seeded.v2.id,
    quantity:             3,
    snapshot_price_minor: 4500,
  });

  // Move the catalog price on row A.
  await s.catalog.prices.set(s.seeded.v1.id, { currency: "USD", amount_minor: 3500 });

  // Drop stock under row B's quantity — but row B is also going to
  // be unavailable, so we need a third row purely for low-stock.
  // Set up a new variant + low stock for row C.
  var p2 = await s.catalog.products.create({ slug: "second-" + Math.random().toString(36).slice(2, 8), title: "Second", status: "active" });        // allow:math-random — unique slug per test
  var v3 = await s.catalog.variants.create(p2.id, { sku: "LOW-" + Math.random().toString(36).slice(2, 8).toUpperCase() });   // allow:math-random — unique SKU per test
  await s.catalog.prices.set(v3.id, { currency: "USD", amount_minor: 1500 });
  await s.catalog.inventory.create(v3.sku, { stock_on_hand: 1 });

  var c = await s.sfl.add({
    customer_id:          customer,
    sku:                  v3.sku,
    variant_id:           v3.id,
    quantity:             5,
    snapshot_price_minor: 1500,
  });

  // Now actually delete the variant for row B.
  await s.catalog.variants.delete(s.seeded.v2.id);

  var report = await s.sfl.staleCheck(customer);
  check("staleCheck: returns one row per save",   report.length === 3);

  var byId = {};
  report.forEach(function (r) { byId[r.id] = r; });

  check("staleCheck: A flagged is_stale (price moved)",
    byId[a.id].is_stale === true && byId[a.id].is_unavailable === false && byId[a.id].current_price_minor === 3500);
  check("staleCheck: B flagged is_unavailable (variant gone)",
    byId[b.id].is_unavailable === true);
  check("staleCheck: C flagged is_low_stock (stock < qty + not backorderable)",
    byId[c.id].is_low_stock === true && byId[c.id].is_stale === false && byId[c.id].is_unavailable === false);
}

async function _repriceAllBulk() {
  var s = await _makeStack({ price1: 2999, price2: 4500 });
  var customer = _uuid();

  var a = await s.sfl.add({
    customer_id:          customer,
    sku:                  s.seeded.v1.sku,
    variant_id:           s.seeded.v1.id,
    quantity:             1,
    snapshot_price_minor: 2999,
  });
  var b = await s.sfl.add({
    customer_id:          customer,
    sku:                  s.seeded.v2.sku,
    variant_id:           s.seeded.v2.id,
    quantity:             1,
    snapshot_price_minor: 4500,
  });

  // Only v1 moves.
  await s.catalog.prices.set(s.seeded.v1.id, { currency: "USD", amount_minor: 3500 });

  var result = await s.sfl.repriceAll(customer);
  check("repriceAll: returns count of changed rows", result.changed === 1);

  var aRow = (await s.query("SELECT * FROM save_for_later WHERE id = ?1", [a.id])).rows[0];
  var bRow = (await s.query("SELECT * FROM save_for_later WHERE id = ?1", [b.id])).rows[0];
  check("repriceAll: changed row updated",       aRow.snapshot_price_minor === 3500 && aRow.last_repriced_at != null);
  check("repriceAll: unchanged row untouched",   bRow.snapshot_price_minor === 4500 && bRow.last_repriced_at == null);

  // Second call — no further changes.
  var second = await s.sfl.repriceAll(customer);
  check("repriceAll: idempotent on second call", second.changed === 0);
}

async function _expireOlderThan() {
  var s = await _makeStack();
  var customer = _uuid();

  // Two fresh saves — within the retention window.
  var fresh1 = await s.sfl.add({
    customer_id: customer, sku: s.seeded.v1.sku, variant_id: s.seeded.v1.id,
    quantity: 1, snapshot_price_minor: 2999,
  });
  var fresh2 = await s.sfl.add({
    customer_id: customer, sku: s.seeded.v2.sku, variant_id: s.seeded.v2.id,
    quantity: 1, snapshot_price_minor: 4500,
  });

  // Backdate fresh1 by 100 days.
  var oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000;
  await s.query("UPDATE save_for_later SET saved_at = ?1 WHERE id = ?2", [oldTs, fresh1.id]);

  var result = await s.sfl.expireOlderThan(90);
  check("expireOlderThan: returns removed count", result.removed === 1);

  var afterRows = (await s.query("SELECT id FROM save_for_later WHERE customer_id = ?1", [customer])).rows;
  check("expireOlderThan: old row gone",          afterRows.length === 1 && afterRows[0].id === fresh2.id);

  // days=0 — remove everything. Wait a tick so fresh2's saved_at
  // is strictly < the threshold the call computes.
  var beforeMs = Date.now();
  await helpers.waitUntil(function () { return Date.now() > beforeMs; },
    { timeoutMs: 100, label: "ms tick before expireOlderThan(0)" });
  var nuked = await s.sfl.expireOlderThan(0);
  check("expireOlderThan(0): clears every row",   nuked.removed === 1);
}

async function _listAndPagination() {
  var s = await _makeStack();
  var customer = _uuid();
  var other    = _uuid();

  // Other-customer noise — must not appear in our list.
  await s.sfl.add({
    customer_id: other, sku: s.seeded.v1.sku, variant_id: s.seeded.v1.id,
    quantity: 1, snapshot_price_minor: 2999,
  });

  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    // Make a new variant each time so the UNIQUE(customer, sku, variant) doesn't dedup.
    var p = await s.catalog.products.create({ slug: "p-" + i + "-" + Math.random().toString(36).slice(2, 6), title: "P" + i, status: "active" });        // allow:math-random — unique slug per test
    var v = await s.catalog.variants.create(p.id, { sku: "PAGE-" + i + "-" + Math.random().toString(36).slice(2, 6).toUpperCase() });   // allow:math-random — unique SKU per test
    await s.catalog.prices.set(v.id, { currency: "USD", amount_minor: 1000 + i });
    await s.catalog.inventory.create(v.sku, { stock_on_hand: 10 });
    var added = await s.sfl.add({
      customer_id: customer, sku: v.sku, variant_id: v.id,
      quantity: 1, snapshot_price_minor: 1000 + i,
    });
    ids.push(added.id);
    var beforeMs = Date.now();
    await helpers.waitUntil(function () { return Date.now() > beforeMs; },
      { timeoutMs: 100, label: "ms tick between save adds" });
  }

  // Customer count.
  var count = await s.sfl.countForCustomer(customer);
  check("countForCustomer: returns own-customer count", count === 5);

  // Page A.
  var pageA = await s.sfl.listForCustomer({ customer_id: customer, limit: 2 });
  check("listForCustomer: pageA has 2 rows",       pageA.rows.length === 2);
  check("listForCustomer: pageA cursor present",   typeof pageA.nextCursor === "string" && pageA.nextCursor.length > 0);
  check("listForCustomer: orders saved_at DESC",   pageA.rows[0].id === ids[ids.length - 1]);

  // Page B.
  var pageB = await s.sfl.listForCustomer({ customer_id: customer, limit: 2, cursor: pageA.nextCursor });
  check("listForCustomer: pageB has 2 rows",       pageB.rows.length === 2);

  // Page C.
  var pageC = await s.sfl.listForCustomer({ customer_id: customer, limit: 2, cursor: pageB.nextCursor });
  check("listForCustomer: pageC has remaining 1", pageC.rows.length === 1);
  check("listForCustomer: pageC nextCursor null", pageC.nextCursor === null);

  // No duplicates across pages.
  var seen = {};
  pageA.rows.concat(pageB.rows).concat(pageC.rows).forEach(function (r) { seen[r.id] = true; });
  check("listForCustomer: every row exactly once", Object.keys(seen).length === 5);

  // Tampered cursor refused.
  var tampered = (pageA.nextCursor.charAt(0) === "A" ? "B" : "A") + pageA.nextCursor.slice(1);
  await assert.rejects(
    s.sfl.listForCustomer({ customer_id: customer, limit: 2, cursor: tampered }),
    /cursor/i,
  );

  // Limit bounds.
  await assert.rejects(s.sfl.listForCustomer({ customer_id: customer, limit: 0 }),    /limit/);
  await assert.rejects(s.sfl.listForCustomer({ customer_id: customer, limit: 9999 }), /limit/);
}

async function _removeAndClear() {
  var s = await _makeStack();
  var customer = _uuid();

  var added = await s.sfl.add({
    customer_id: customer, sku: s.seeded.v1.sku, variant_id: s.seeded.v1.id,
    quantity: 1, snapshot_price_minor: 2999,
  });

  // Other customer can't remove it.
  var bystander = _uuid();
  var noTouch = await s.sfl.remove({ customer_id: bystander, save_id: added.id });
  check("remove: scoped to customer_id (other cust no-op)", noTouch.removed === false);

  var hit = await s.sfl.remove({ customer_id: customer, save_id: added.id });
  check("remove: own customer removes",                     hit.removed === true);

  var miss = await s.sfl.remove({ customer_id: customer, save_id: added.id });
  check("remove: absent row no-op",                         miss.removed === false);

  // clear() drops everything for the customer.
  await s.sfl.add({
    customer_id: customer, sku: s.seeded.v1.sku, variant_id: s.seeded.v1.id,
    quantity: 1, snapshot_price_minor: 2999,
  });
  await s.sfl.add({
    customer_id: customer, sku: s.seeded.v2.sku, variant_id: s.seeded.v2.id,
    quantity: 1, snapshot_price_minor: 4500,
  });
  var cleared = await s.sfl.clear(customer);
  check("clear: returns count removed",        cleared.removed === 2);
  var leftCount = await s.sfl.countForCustomer(customer);
  check("clear: customer rows gone",            leftCount === 0);
}

async function _refusals() {
  var s = await _makeStack();
  var validId = _uuid();
  var bigNote = new Array(282).join("x");        // 281 chars
  var ctrlNote = "ok\nthen\bsmuggle";

  // create-time refusals
  var threw = false;
  try { bShop.saveForLater.create({ query: s.query }); } catch (e) { threw = /catalog/.test(e.message); }
  check("create: refuses without catalog",      threw === true);

  var threwBad = false;
  try { bShop.saveForLater.create({ query: s.query, catalog: s.catalog, currency: "usd" }); } catch (e) { threwBad = /currency/.test(e.message); }
  check("create: refuses non-ISO-4217 currency", threwBad === true);

  // add()
  await assert.rejects(s.sfl.add(),                                                          /input object required/);
  await assert.rejects(s.sfl.add({}),                                                        /customer_id/);
  await assert.rejects(s.sfl.add({ customer_id: validId }),                                  /sku/);
  await assert.rejects(s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku }),            /quantity/);
  await assert.rejects(s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku, quantity: 0 }), /quantity/);
  await assert.rejects(s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku, quantity: -1 }), /quantity/);
  await assert.rejects(s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku, quantity: 1 }), /snapshot_price_minor/);
  await assert.rejects(s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku, quantity: 1, snapshot_price_minor: -1 }), /snapshot_price_minor/);
  await assert.rejects(
    s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku, quantity: 1, snapshot_price_minor: 999, notes: bigNote }),
    /notes/,
  );
  await assert.rejects(
    s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku, quantity: 1, snapshot_price_minor: 999, notes: ctrlNote }),
    /notes/,
  );
  await assert.rejects(
    s.sfl.add({ customer_id: validId, sku: s.seeded.v1.sku, quantity: 1, snapshot_price_minor: 999, notes: 42 }),
    /notes/,
  );
  await assert.rejects(
    s.sfl.add({ customer_id: "not-a-uuid", sku: s.seeded.v1.sku, quantity: 1, snapshot_price_minor: 999 }),
    /customer_id/,
  );
  await assert.rejects(
    s.sfl.add({ customer_id: validId, sku: "bad sku with spaces", quantity: 1, snapshot_price_minor: 999 }),
    /sku/,
  );

  // moveFromCart
  await assert.rejects(s.sfl.moveFromCart(),                              /input object required/);
  await assert.rejects(s.sfl.moveFromCart({}),                            /customer_id/);
  await assert.rejects(s.sfl.moveFromCart({ customer_id: validId }),      /cart_id/);
  await assert.rejects(s.sfl.moveFromCart({ customer_id: validId, cart_id: validId }), /line_id/);

  // moveToCart
  await assert.rejects(s.sfl.moveToCart(),                                /input object required/);
  await assert.rejects(s.sfl.moveToCart({ customer_id: validId, save_id: validId, cart_id: validId }), /use_price/);
  await assert.rejects(
    s.sfl.moveToCart({ customer_id: validId, save_id: validId, cart_id: validId, use_price: "lol" }),
    /use_price/,
  );

  // remove
  await assert.rejects(s.sfl.remove(),                                    /input object required/);
  await assert.rejects(s.sfl.remove({}),                                  /customer_id/);
  await assert.rejects(s.sfl.remove({ customer_id: validId }),            /save_id/);

  // listForCustomer
  await assert.rejects(s.sfl.listForCustomer(),                            /input object required/);
  await assert.rejects(s.sfl.listForCustomer({}),                          /customer_id/);
  await assert.rejects(s.sfl.listForCustomer({ customer_id: validId, cursor: 42 }), /cursor/);

  // countForCustomer / clear / staleCheck / repriceAll
  await assert.rejects(s.sfl.countForCustomer("not-a-uuid"), /customer_id/);
  await assert.rejects(s.sfl.clear("not-a-uuid"),            /customer_id/);
  await assert.rejects(s.sfl.staleCheck("not-a-uuid"),       /customer_id/);
  await assert.rejects(s.sfl.repriceAll("not-a-uuid"),       /customer_id/);

  // expireOlderThan
  await assert.rejects(s.sfl.expireOlderThan(-1),    /days/);
  await assert.rejects(s.sfl.expireOlderThan(1.5),   /days/);
  await assert.rejects(s.sfl.expireOlderThan("7"),   /days/);
}

async function _productionRequiresCursorSecret() {
  var s = await _makeStack();
  var prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    var threw = false;
    try {
      bShop.saveForLater.create({ query: s.query, catalog: s.catalog });
    } catch (e) {
      threw = /cursorSecret/.test(e.message);
    }
    check("create: throws in production without cursorSecret", threw === true);

    var sfl = bShop.saveForLater.create({ query: s.query, catalog: s.catalog, cursorSecret: "test-secret" });
    check("create: accepts cursorSecret in production",        typeof sfl.add === "function");
  } finally {
    process.env.NODE_ENV = prev;
  }
}

async function run() {
  await _moveFromCartAtomic();
  await _moveFromCartUnknownLineRefuses();
  await _moveToCartUsePriceSavedVsCurrent();
  await _moveToCartRefusesOutOfStockNotBackorderable();
  await _addDedupViaUnique();
  await _staleCheckFlags();
  await _repriceAllBulk();
  await _expireOlderThan();
  await _listAndPagination();
  await _removeAndClear();
  await _refusals();
  await _productionRequiresCursorSecret();
}

module.exports = { run: run };
