"use strict";
/**
 * wishlist — customer-saved products / variants.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0012 (wishlist_entries). The primitive itself only touches its
 * own table — no catalog / customers FK enforcement at the DB
 * layer — so the test can stand up the schema in isolation.
 *
 * Coverage:
 *   - add: new entry persists with status "added"
 *   - add: dedup on the (customer, product, variant) tuple returns
 *     status "dedup" with the original id
 *   - add: NULL-variant collapses to a single tuple (a repeat NULL
 *     add is also dedup)
 *   - add: variant-level + product-level entries for the same
 *     product coexist as distinct tuples
 *   - remove: existing row deletes (removed: true), absent row is a
 *     no-op (removed: false)
 *   - listForCustomer: empty result, populated result, cursor
 *     forward-pagination, scopes by customer_id
 *   - listForCustomer: cursor-tamper refused, limit bounds refused
 *   - isWishlisted: true after add, false after remove
 *   - countForProduct: distinct customers only (same customer with
 *     two variants of the same product counts once)
 *   - popularProducts: sorted by count desc, limit honoured
 *   - refusals: missing customer_id, missing product_id, oversized
 *     notes, control-byte notes, empty input object, non-string
 *     notes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_WISHLIST = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0012_wishlist.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_WISHLIST, "utf8")).forEach(function (s) {
    db.prepare(s).run();
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

async function _addNewThenDedup() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var customer = _uuid();
  var product  = _uuid();

  var first = await wishlist.add({ customer_id: customer, product_id: product });
  check("add: returns id (uuid shape)",      typeof first.id === "string" && first.id.length === 36);
  check("add: first call status = added",    first.status === "added");

  var second = await wishlist.add({ customer_id: customer, product_id: product });
  check("add: dedup returns same id",        second.id === first.id);
  check("add: second call status = dedup",   second.status === "dedup");

  // NULL-variant dedup — explicit null and absent variant_id collapse to the same tuple
  var third = await wishlist.add({ customer_id: customer, product_id: product, variant_id: null });
  check("add: explicit null variant dedups", third.id === first.id && third.status === "dedup");
}

async function _addProductAndVariantCoexist() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var customer = _uuid();
  var product  = _uuid();
  var variant  = _uuid();

  var atProductLevel = await wishlist.add({ customer_id: customer, product_id: product });
  var atVariantLevel = await wishlist.add({ customer_id: customer, product_id: product, variant_id: variant });
  check("add: product-level + variant-level are distinct",
    atProductLevel.id !== atVariantLevel.id
    && atProductLevel.status === "added"
    && atVariantLevel.status === "added");

  // Second variant-level add on the SAME variant dedups
  var repeatVariant = await wishlist.add({ customer_id: customer, product_id: product, variant_id: variant });
  check("add: variant-level dedup matches the variant tuple",
    repeatVariant.id === atVariantLevel.id && repeatVariant.status === "dedup");
}

async function _addStoresNotes() {
  var q = _makeQuery();
  var wishlist = bShop.wishlist.create({ query: q });
  var customer = _uuid();
  var product  = _uuid();

  var saved = await wishlist.add({
    customer_id: customer,
    product_id:  product,
    notes:       "for my birthday in March",
  });
  var row = (await q("SELECT * FROM wishlist_entries WHERE id = ?1", [saved.id])).rows[0];
  check("add: persists notes column",        row && row.notes === "for my birthday in March");
}

async function _removeExistingAndAbsent() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var customer = _uuid();
  var product  = _uuid();

  await wishlist.add({ customer_id: customer, product_id: product });

  var hit = await wishlist.remove({ customer_id: customer, product_id: product });
  check("remove: existing row removed=true",   hit.removed === true);

  var miss = await wishlist.remove({ customer_id: customer, product_id: product });
  check("remove: absent row removed=false",    miss.removed === false);

  // Variant-scoped remove leaves product-scoped row in place
  var variant = _uuid();
  await wishlist.add({ customer_id: customer, product_id: product });
  await wishlist.add({ customer_id: customer, product_id: product, variant_id: variant });

  var variantOnly = await wishlist.remove({ customer_id: customer, product_id: product, variant_id: variant });
  check("remove: variant-scoped removes only the variant row", variantOnly.removed === true);
  var stillThere = await wishlist.isWishlisted({ customer_id: customer, product_id: product });
  check("remove: product-level row survives variant-level remove", stillThere === true);
}

async function _listForCustomerEmptyAndPopulated() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var customer = _uuid();

  var empty = await wishlist.listForCustomer(customer, { limit: 10 });
  check("listForCustomer: empty rows array",   Array.isArray(empty.rows) && empty.rows.length === 0);
  check("listForCustomer: empty nextCursor",   empty.nextCursor === null);

  // Four entries — created sequentially so created_at ordering is meaningful
  var products = [_uuid(), _uuid(), _uuid(), _uuid()];
  var added = [];
  for (var i = 0; i < products.length; i += 1) {
    var entry = await wishlist.add({ customer_id: customer, product_id: products[i] });
    added.push(entry.id);
    // Spin briefly so each created_at advances at least 1ms
    if (i < products.length - 1) {
      var beforeMs = Date.now();
      await helpers.waitUntil(function () { return Date.now() > beforeMs; },
        { timeoutMs: 100, label: "ms tick between wishlist adds" });
    }
  }

  var page = await wishlist.listForCustomer(customer, { limit: 10 });
  check("listForCustomer: returns 4 rows",     page.rows.length === 4);
  check("listForCustomer: nextCursor null when no more pages",
    page.nextCursor === null);
  // Most recently added surfaces first (created_at DESC).
  check("listForCustomer: orders by created_at DESC",
    page.rows[0].id === added[added.length - 1]);

  // Other customer's entries are excluded
  var otherEntries = await wishlist.listForCustomer(_uuid(), { limit: 10 });
  check("listForCustomer: scopes by customer_id", otherEntries.rows.length === 0);
}

async function _listForCustomerCursorPagination() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var customer = _uuid();
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var e = await wishlist.add({ customer_id: customer, product_id: _uuid() });
    ids.push(e.id);
    var beforeMs = Date.now();
    await helpers.waitUntil(function () { return Date.now() > beforeMs; },
      { timeoutMs: 100, label: "ms tick between wishlist adds" });
  }

  var pageA = await wishlist.listForCustomer(customer, { limit: 2 });
  check("listForCustomer: pageA has 2 rows",   pageA.rows.length === 2);
  check("listForCustomer: pageA nextCursor present", typeof pageA.nextCursor === "string" && pageA.nextCursor.length > 0);

  var pageB = await wishlist.listForCustomer(customer, { limit: 2, cursor: pageA.nextCursor });
  check("listForCustomer: pageB has 2 rows",   pageB.rows.length === 2);
  check("listForCustomer: pageB nextCursor present", typeof pageB.nextCursor === "string");

  var pageC = await wishlist.listForCustomer(customer, { limit: 2, cursor: pageB.nextCursor });
  check("listForCustomer: pageC has remaining 1 row", pageC.rows.length === 1);
  check("listForCustomer: pageC nextCursor null",     pageC.nextCursor === null);

  // No id is observed twice across the three pages, all 5 covered
  var seen = {};
  pageA.rows.concat(pageB.rows).concat(pageC.rows).forEach(function (r) { seen[r.id] = true; });
  check("listForCustomer: cursor pages cover every row exactly once",
    Object.keys(seen).length === 5);

  // Cursor tamper — flip the trailing chars
  var tampered = pageA.nextCursor.slice(0, -2) + (pageA.nextCursor.endsWith("==") ? "AA" : "XX");
  await assert.rejects(
    wishlist.listForCustomer(customer, { limit: 2, cursor: tampered }),
    /cursor/i,
  );

  // Limit bounds
  await assert.rejects(wishlist.listForCustomer(customer, { limit: 0 }),    /limit/);
  await assert.rejects(wishlist.listForCustomer(customer, { limit: 9999 }), /limit/);
}

async function _isWishlistedTrueFalse() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var customer = _uuid();
  var product  = _uuid();

  var beforeAdd = await wishlist.isWishlisted({ customer_id: customer, product_id: product });
  check("isWishlisted: false before add",        beforeAdd === false);

  await wishlist.add({ customer_id: customer, product_id: product });
  var afterAdd = await wishlist.isWishlisted({ customer_id: customer, product_id: product });
  check("isWishlisted: true after add",          afterAdd === true);

  await wishlist.remove({ customer_id: customer, product_id: product });
  var afterRemove = await wishlist.isWishlisted({ customer_id: customer, product_id: product });
  check("isWishlisted: false after remove",      afterRemove === false);

  // variant-specific true/false branches
  var variant = _uuid();
  await wishlist.add({ customer_id: customer, product_id: product, variant_id: variant });
  var variantHit = await wishlist.isWishlisted({ customer_id: customer, product_id: product, variant_id: variant });
  check("isWishlisted: variant-scoped true",     variantHit === true);
  var variantMiss = await wishlist.isWishlisted({ customer_id: customer, product_id: product, variant_id: _uuid() });
  check("isWishlisted: other variant false",     variantMiss === false);
}

async function _countForProductDistinct() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var product  = _uuid();
  var variantA = _uuid();
  var variantB = _uuid();
  var customer1 = _uuid();
  var customer2 = _uuid();
  var customer3 = _uuid();

  await wishlist.add({ customer_id: customer1, product_id: product, variant_id: variantA });
  await wishlist.add({ customer_id: customer1, product_id: product, variant_id: variantB });
  await wishlist.add({ customer_id: customer2, product_id: product });
  await wishlist.add({ customer_id: customer3, product_id: product, variant_id: variantA });

  var count = await wishlist.countForProduct(product);
  check("countForProduct: counts distinct customers (3, not 4)", count === 3);

  var empty = await wishlist.countForProduct(_uuid());
  check("countForProduct: 0 for un-wishlisted product",         empty === 0);
}

async function _popularProductsSorted() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var hot      = _uuid();
  var warm     = _uuid();
  var cold     = _uuid();

  // hot: 3 distinct customers
  await wishlist.add({ customer_id: _uuid(), product_id: hot });
  await wishlist.add({ customer_id: _uuid(), product_id: hot });
  await wishlist.add({ customer_id: _uuid(), product_id: hot });
  // warm: 2 distinct customers
  await wishlist.add({ customer_id: _uuid(), product_id: warm });
  await wishlist.add({ customer_id: _uuid(), product_id: warm });
  // cold: 1 customer
  await wishlist.add({ customer_id: _uuid(), product_id: cold });

  var popular = await wishlist.popularProducts({ limit: 10 });
  check("popularProducts: returns 3 rows",       popular.length === 3);
  check("popularProducts: sorted by count desc",
    popular[0].product_id === hot && popular[0].count === 3
    && popular[1].product_id === warm && popular[1].count === 2
    && popular[2].product_id === cold && popular[2].count === 1);

  var truncated = await wishlist.popularProducts({ limit: 2 });
  check("popularProducts: limit honoured",       truncated.length === 2);

  // Default limit path (no opts)
  var defaultPop = await wishlist.popularProducts();
  check("popularProducts: default limit returns all 3", defaultPop.length === 3);
}

async function _refusals() {
  var wishlist = bShop.wishlist.create({ query: _makeQuery() });
  var validId  = _uuid();
  var bigNote  = new Array(282).join("x");                 // 281 chars
  var ctrlNote = "ok\nthen\bsmuggle";

  await assert.rejects(wishlist.add(),                                                /input object required/);
  await assert.rejects(wishlist.add({}),                                              /customer_id/);
  await assert.rejects(wishlist.add({ customer_id: validId }),                        /product_id/);
  await assert.rejects(wishlist.add({ customer_id: "not-a-uuid", product_id: validId }), /customer_id/);
  await assert.rejects(wishlist.add({ customer_id: validId, product_id: "not-a-uuid" }), /product_id/);
  await assert.rejects(
    wishlist.add({ customer_id: validId, product_id: validId, variant_id: "not-a-uuid" }),
    /variant_id/,
  );
  await assert.rejects(
    wishlist.add({ customer_id: validId, product_id: validId, notes: bigNote }),
    /notes/,
  );
  await assert.rejects(
    wishlist.add({ customer_id: validId, product_id: validId, notes: ctrlNote }),
    /notes/,
  );
  await assert.rejects(
    wishlist.add({ customer_id: validId, product_id: validId, notes: 42 }),
    /notes/,
  );

  await assert.rejects(wishlist.remove(),                                             /input object required/);
  await assert.rejects(wishlist.remove({}),                                           /customer_id/);
  await assert.rejects(wishlist.remove({ customer_id: validId }),                     /product_id/);

  await assert.rejects(wishlist.isWishlisted(),                                       /input object required/);
  await assert.rejects(wishlist.isWishlisted({}),                                     /customer_id/);
  await assert.rejects(wishlist.isWishlisted({ customer_id: validId }),               /product_id/);

  await assert.rejects(wishlist.listForCustomer("not-a-uuid"),                        /customer_id/);
  await assert.rejects(wishlist.countForProduct("not-a-uuid"),                        /product_id/);
  await assert.rejects(
    wishlist.listForCustomer(validId, { cursor: 42 }),
    /cursor/,
  );
}

async function _productionRequiresCursorSecret() {
  var prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    var threw = false;
    try {
      bShop.wishlist.create({ query: _makeQuery() });
    } catch (e) {
      threw = /cursorSecret/.test(e.message);
    }
    check("create: throws in production without cursorSecret", threw === true);

    // Supplied secret — no throw
    var w = bShop.wishlist.create({ query: _makeQuery(), cursorSecret: "test-secret" });
    check("create: accepts cursorSecret in production",        typeof w.add === "function");
  } finally {
    process.env.NODE_ENV = prev;
  }
}

async function run() {
  await _addNewThenDedup();
  await _addProductAndVariantCoexist();
  await _addStoresNotes();
  await _removeExistingAndAbsent();
  await _listForCustomerEmptyAndPopulated();
  await _listForCustomerCursorPagination();
  await _isWishlistedTrueFalse();
  await _countForProductDistinct();
  await _popularProductsSorted();
  await _refusals();
  await _productionRequiresCursorSecret();
}

module.exports = { run: run };
