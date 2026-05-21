"use strict";
/**
 * cart — anonymous + authenticated carts, line lifecycle, merge.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migrations 0001 (catalog) + 0002 (cart) — every CHECK / UNIQUE /
 * FK in the shipped schema is exercised end-to-end.
 *
 * Coverage:
 *   - create + get + bySession
 *   - addLine (price snapshot from catalog + explicit override)
 *   - addLine de-duplicates on (cart_id, variant_id) by bumping qty
 *   - updateLine, removeLine
 *   - merge (anonymous → customer cart, line collision sums qty)
 *   - setCustomer, setStatus
 *   - validation: bad session_id / currency / qty / status
 *   - immutable post-conversion: addLine on a converted cart refuses
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_CATALOG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_CART].forEach(function (p) {
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

async function _setupCatalog(catalog) {
  var p = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", status: "active" });
  var v1 = await catalog.variants.create(p.id, { sku: "WDG-PRO-BLK-L" });
  var v2 = await catalog.variants.create(p.id, { sku: "WDG-PRO-BLK-M" });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2999 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 2499 });
  return { product: p, v1: v1, v2: v2 };
}

function _newSessionId() {
  return "sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");
}

async function _crud() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var { v1, v2 } = await _setupCatalog(catalog);

  var sid = _newSessionId();
  var c = await cart.create(sid, { currency: "USD" });
  check("cart.create returns active row", c.status === "active" && c.currency === "USD");
  check("cart.create sets expires_at",     c.expires_at > c.created_at);
  check("cart.create has no customer",     c.customer_id === null);

  var got = await cart.get(c.id);
  check("cart.get round-trips", got.id === c.id);

  var bySession = await cart.bySession(sid);
  check("cart.bySession finds active row", bySession.id === c.id);

  // Add line — implicit price from catalog
  var l1 = await cart.addLine(c.id, { variant_id: v1.id, qty: 2 });
  check("cart.addLine snapshots unit price",     l1.unit_amount_minor === 2999);
  check("cart.addLine snapshots currency",       l1.unit_currency === "USD");
  check("cart.addLine sets qty",                  l1.qty === 2);
  check("cart.addLine copies sku from variant",   l1.sku === "WDG-PRO-BLK-L");

  // Re-add same variant → de-duplicates by bumping qty
  var l1again = await cart.addLine(c.id, { variant_id: v1.id, qty: 1 });
  check("cart.addLine de-dupes by variant",      l1again.id === l1.id);
  check("cart.addLine bumps qty on re-add",      l1again.qty === 3);

  // Add a different variant
  var l2 = await cart.addLine(c.id, { variant_id: v2.id, qty: 1 });
  check("cart.addLine creates new line for new variant", l2.id !== l1.id);

  var lines = await cart.listLines(c.id);
  check("cart.listLines returns both", lines.length === 2);

  // Update line qty
  var u = await cart.updateLine(l1.id, { qty: 5 });
  check("cart.updateLine changes qty", u.qty === 5);

  // Remove line
  var removed = await cart.removeLine(l2.id);
  check("cart.removeLine returns true",       removed === true);
  var afterRm = await cart.listLines(c.id);
  check("cart.removeLine actually removes",    afterRm.length === 1);
}

async function _explicitPriceSnapshot() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var { v1 }  = await _setupCatalog(catalog);

  var sid = _newSessionId();
  var c = await cart.create(sid, { currency: "USD" });

  // Explicit price snapshot (e.g. on-the-fly admin add)
  var l = await cart.addLine(c.id, {
    variant_id:        v1.id,
    qty:               1,
    unit_amount_minor: 1999,   // override the catalog price
    unit_currency:     "USD",
  });
  check("cart.addLine accepts explicit price",   l.unit_amount_minor === 1999);
}

async function _missingPrice() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  // Variant without a price row in the cart's currency
  var p = await catalog.products.create({ slug: "no-price", title: "NP", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "NP-1" });
  // Only set EUR — cart will be USD
  await catalog.prices.set(v.id, { currency: "EUR", amount_minor: 100 });

  var sid = _newSessionId();
  var c = await cart.create(sid, { currency: "USD" });
  await assert.rejects(cart.addLine(c.id, { variant_id: v.id, qty: 1 }),
    /no current price for variant/);
}

async function _activeSessionUniqueness() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  await _setupCatalog(catalog);

  var sid = _newSessionId();
  await cart.create(sid, { currency: "USD" });
  // Second active cart on the same session is refused by the
  // partial UNIQUE index.
  var threw = false;
  try { await cart.create(sid, { currency: "USD" }); }
  catch (_e) { threw = true; }
  check("only one active cart per session", threw);
}

async function _mergeCart() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var { v1, v2 } = await _setupCatalog(catalog);

  // Anonymous cart with v1 x2 + v2 x1
  var anonCart = await cart.create(_newSessionId(), { currency: "USD" });
  await cart.addLine(anonCart.id, { variant_id: v1.id, qty: 2 });
  await cart.addLine(anonCart.id, { variant_id: v2.id, qty: 1 });

  // Customer cart with v1 x1 (collides)
  var custCart = await cart.create(_newSessionId(), { currency: "USD" });
  await cart.addLine(custCart.id, { variant_id: v1.id, qty: 1 });

  var merged = await cart.merge(anonCart.id, custCart.id);
  check("cart.merge returns surviving cart", merged.id === custCart.id);

  var mergedLines = await cart.listLines(custCart.id);
  // v1 should be 1 + 2 = 3; v2 should be 1.
  var byVar = {};
  mergedLines.forEach(function (l) { byVar[l.variant_id] = l; });
  check("cart.merge sums qty on variant collision",   byVar[v1.id].qty === 3);
  check("cart.merge adds non-colliding line",          byVar[v2.id].qty === 1);

  var anonAfter = await cart.get(anonCart.id);
  check("cart.merge marks source cart abandoned",      anonAfter.status === "abandoned");

  await assert.rejects(cart.merge(custCart.id, custCart.id), /=== toCartId/);
}

async function _customerAndStatus() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var { v1 } = await _setupCatalog(catalog);

  var c = await cart.create(_newSessionId(), { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v1.id, qty: 1 });

  var customerId = bShop.framework.uuid.v7();
  var withCust = await cart.setCustomer(c.id, customerId);
  check("cart.setCustomer attaches id", withCust.customer_id === customerId);

  var converted = await cart.setStatus(c.id, "converted");
  check("cart.setStatus flips status", converted.status === "converted");

  // Post-conversion writes refuse
  await assert.rejects(cart.addLine(c.id, { variant_id: v1.id, qty: 1 }),
    /cart status is converted/);
}

async function _validation() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });

  await assert.rejects(cart.create("bad session id with spaces", { currency: "USD" }), /session_id must be/);
  await assert.rejects(cart.create(_newSessionId(), { currency: "usd" }), /ISO 4217/);
  var c = await cart.create(_newSessionId(), { currency: "USD" });
  await assert.rejects(cart.addLine(c.id, { variant_id: bShop.framework.uuid.v7(), qty: 0 }),  /qty must be a positive integer/);
  await assert.rejects(cart.addLine(c.id, { variant_id: bShop.framework.uuid.v7(), qty: -5 }), /qty must be a positive integer/);
  await assert.rejects(cart.setStatus(c.id, "junk"), /status must be/);
}

async function run() {
  await _crud();
  await _explicitPriceSnapshot();
  await _missingPrice();
  await _activeSessionUniqueness();
  await _mergeCart();
  await _customerAndStatus();
  await _validation();
}

module.exports = { run: run };
