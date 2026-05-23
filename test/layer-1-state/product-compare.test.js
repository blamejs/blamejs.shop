"use strict";
/**
 * product-compare — storefront side-by-side product comparison basket.
 *
 * Layer 1 against in-memory node:sqlite with migration 0195 loaded.
 * The catalog dependency is stubbed locally so the test exercises the
 * primitive in isolation (compositional wiring is covered by the
 * smoke suite).
 *
 * Coverage:
 *   - addToCompare happy path + idempotent re-add + cap refusal at 4
 *   - removeFromCompare drops a product + idempotent on miss + empty-
 *     basket shape on no-prior-session
 *   - getCompareList round-trip + empty-basket shape on miss
 *   - clearCompareList drops the row + reports cleared count
 *   - compareTable shape with stub catalog: default attributes,
 *     custom attribute selection, unknown product id surfaces as
 *     null, refuses without catalog wiring
 *   - defineCompareAttribute persists + upserts + shadows defaults +
 *     surfaces through listAttributes
 *   - recordImpression + popularCompares window math, distinct-
 *     session count, ordering, cleanupOlderThan sweep
 *   - validation surface: bad session id / product id / attribute
 *     shape / popularCompares window / cleanup days
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var productCompare = require("../../lib/product-compare");
var bShop          = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0195_product_compare.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// Catalog stub — returns whatever the operator-supplied map says for
// each product id; an unknown id returns null. Each product row models
// the obvious catalog shape (product + nested variants array + a
// metadata bag) so the resolver paths (variant column / product
// column / metadata bag) exercise without dragging the real catalog
// primitive's migration footprint into this layer-1 test.
function _catalogStub(byId) {
  byId = byId || {};
  return {
    getProduct: async function (id) {
      if (Object.prototype.hasOwnProperty.call(byId, id)) return byId[id];
      return null;
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _sessionId() {
  // 32 chars of [A-Za-z0-9_-] — comfortably inside the 16-64 range.
  var alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  var out = "";
  for (var i = 0; i < 32; i += 1) {
    out += alpha.charAt(Math.floor(Math.random() * alpha.length));
  }
  return out;
}

function _factory(catalogOpts) {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    pc:    productCompare.create({
      query:   h.query,
      catalog: catalogOpts === false ? undefined : _catalogStub(catalogOpts || {}),
    }),
  };
}

// ---- addToCompare cap ---------------------------------------------------

async function _addToCompareCap() {
  var f = _factory();
  var sid = _sessionId();
  var customerId = _uuid();

  var p1 = _uuid();
  var p2 = _uuid();
  var p3 = _uuid();
  var p4 = _uuid();
  var p5 = _uuid();

  var r1 = await f.pc.addToCompare({ session_id: sid, product_id: p1, customer_id: customerId });
  check("addToCompare returns list row",     r1 && Array.isArray(r1.product_ids) && r1.product_ids.length === 1);
  check("addToCompare customer recorded",    r1.customer_id === customerId);
  check("addToCompare first id matches",     r1.product_ids[0] === p1);
  check("addToCompare session hashed",        typeof r1.session_id_hash === "string"
                                              && r1.session_id_hash !== sid
                                              && r1.session_id_hash.length > 16);

  var r2 = await f.pc.addToCompare({ session_id: sid, product_id: p2 });
  check("addToCompare second product",        r2.product_ids.length === 2 && r2.product_ids[1] === p2);
  check("addToCompare customer sticky",       r2.customer_id === customerId);

  var r3 = await f.pc.addToCompare({ session_id: sid, product_id: p3 });
  check("addToCompare third product",         r3.product_ids.length === 3);

  var r4 = await f.pc.addToCompare({ session_id: sid, product_id: p4 });
  check("addToCompare fourth product",        r4.product_ids.length === 4);

  // Idempotent re-add of an existing product.
  var rIdem = await f.pc.addToCompare({ session_id: sid, product_id: p2 });
  check("addToCompare idempotent re-add",     rIdem.product_ids.length === 4);
  check("addToCompare order stable on re-add", rIdem.product_ids[1] === p2);

  // Fifth product refused with COMPARE_FULL.
  await assert.rejects(
    f.pc.addToCompare({ session_id: sid, product_id: p5 }),
    function (err) { return err && err.code === "COMPARE_FULL"; },
  );
}

// ---- removeFromCompare --------------------------------------------------

async function _removeFromCompare() {
  var f = _factory();
  var sid = _sessionId();
  var p1 = _uuid();
  var p2 = _uuid();
  var p3 = _uuid();

  await f.pc.addToCompare({ session_id: sid, product_id: p1 });
  await f.pc.addToCompare({ session_id: sid, product_id: p2 });
  await f.pc.addToCompare({ session_id: sid, product_id: p3 });

  var r = await f.pc.removeFromCompare({ session_id: sid, product_id: p2 });
  check("removeFromCompare drops product",    r.product_ids.length === 2);
  check("removeFromCompare order preserved",  r.product_ids[0] === p1 && r.product_ids[1] === p3);

  // Idempotent remove (already gone).
  var rIdem = await f.pc.removeFromCompare({ session_id: sid, product_id: p2 });
  check("removeFromCompare idempotent miss",  rIdem.product_ids.length === 2);

  // Removing from an unknown session returns the empty-basket shape.
  var rEmpty = await f.pc.removeFromCompare({ session_id: _sessionId(), product_id: p1 });
  check("removeFromCompare empty session",    Array.isArray(rEmpty.product_ids) && rEmpty.product_ids.length === 0);
  check("removeFromCompare empty id null",    rEmpty.id === null);
}

// ---- get + clear --------------------------------------------------------

async function _getAndClear() {
  var f = _factory();
  var sid = _sessionId();
  var p1 = _uuid();

  // Empty-basket shape on miss.
  var empty = await f.pc.getCompareList({ session_id: sid });
  check("getCompareList empty shape",         Array.isArray(empty.product_ids) && empty.product_ids.length === 0);
  check("getCompareList empty id null",       empty.id === null);

  await f.pc.addToCompare({ session_id: sid, product_id: p1 });
  var got = await f.pc.getCompareList({ session_id: sid });
  check("getCompareList round-trip",          got.product_ids.length === 1 && got.product_ids[0] === p1);

  // clearCompareList drops the row.
  var cleared = await f.pc.clearCompareList({ session_id: sid });
  check("clearCompareList cleared count 1",   cleared.cleared === 1);
  var after = await f.pc.getCompareList({ session_id: sid });
  check("clearCompareList drops the row",     after.product_ids.length === 0);

  // Re-clear is idempotent.
  var clearedAgain = await f.pc.clearCompareList({ session_id: sid });
  check("clearCompareList idempotent zero",   clearedAgain.cleared === 0);
}

// ---- compareTable shape with stub catalog -------------------------------

async function _compareTableShape() {
  var pidA = _uuid();
  var pidB = _uuid();
  var products = {};
  products[pidA] = {
    id:       pidA,
    brand:    "Acme",
    vendor:   "Acme Industries",
    variants: [{ sku: "ACME-001", price_minor: 1999, weight: 0.5, inventory_status: "in_stock" }],
    metadata: { dimensions: "10x20x5 cm" },
  };
  products[pidB] = {
    id:       pidB,
    brand:    "Globex",
    vendor:   "Globex Corp",
    variants: [{ sku: "GLB-002", price_minor: 4500, weight: 1.2, inventory_status: "low_stock" }],
    metadata: { dimensions: "30x40x10 cm" },
  };
  var f = _factory(products);
  var sid = _sessionId();
  await f.pc.addToCompare({ session_id: sid, product_id: pidA });
  await f.pc.addToCompare({ session_id: sid, product_id: pidB });

  var table = await f.pc.compareTable({ session_id: sid });
  check("compareTable products length 2",     Array.isArray(table.products) && table.products.length === 2);
  check("compareTable product_ids match",      table.product_ids[0] === pidA && table.product_ids[1] === pidB);
  check("compareTable rows count = defaults",  table.rows.length === productCompare.DEFAULT_ATTRIBUTE_SLUGS.length);

  // Spot-check a row from each source kind.
  var priceRow = table.rows.filter(function (r) { return r.attribute.slug === "price"; })[0];
  check("compareTable price row present",      priceRow && priceRow.values_per_product.length === 2);
  check("compareTable price A 1999",           priceRow.values_per_product[0] === 1999);
  check("compareTable price B 4500",           priceRow.values_per_product[1] === 4500);
  check("compareTable price format currency",  priceRow.attribute.format === "currency");

  var skuRow = table.rows.filter(function (r) { return r.attribute.slug === "sku"; })[0];
  check("compareTable sku A ACME-001",         skuRow.values_per_product[0] === "ACME-001");
  check("compareTable sku B GLB-002",          skuRow.values_per_product[1] === "GLB-002");

  var brandRow = table.rows.filter(function (r) { return r.attribute.slug === "brand"; })[0];
  check("compareTable brand A Acme",           brandRow.values_per_product[0] === "Acme");
  check("compareTable brand B Globex",         brandRow.values_per_product[1] === "Globex");

  var dimRow = table.rows.filter(function (r) { return r.attribute.slug === "dimensions"; })[0];
  check("compareTable dimensions A from meta", dimRow.values_per_product[0] === "10x20x5 cm");
  check("compareTable dimensions B from meta", dimRow.values_per_product[1] === "30x40x10 cm");

  // Unknown product id surfaces as null + null cells (deleted between
  // add and table-render).
  var pidGhost = _uuid();
  await f.pc.addToCompare({ session_id: sid, product_id: pidGhost });
  var tableGhost = await f.pc.compareTable({ session_id: sid });
  check("compareTable ghost product is null",  tableGhost.products[2] === null);
  var ghostPrice = tableGhost.rows.filter(function (r) { return r.attribute.slug === "price"; })[0];
  check("compareTable ghost cell is null",      ghostPrice.values_per_product[2] === null);

  // Custom attribute selection — picks a subset.
  var subset = await f.pc.compareTable({
    session_id: sid,
    attributes: ["price", "brand"],
  });
  check("compareTable custom attrs length 2", subset.rows.length === 2);
  check("compareTable custom attrs order",     subset.rows[0].attribute.slug === "price"
                                               && subset.rows[1].attribute.slug === "brand");

  // Unknown attribute slug refused.
  await assert.rejects(
    f.pc.compareTable({ session_id: sid, attributes: ["price", "phantom"] }),
    /not defined/,
  );

  // Duplicate attribute slug refused.
  await assert.rejects(
    f.pc.compareTable({ session_id: sid, attributes: ["price", "price"] }),
    /duplicates a previous entry/,
  );

  // Empty attributes array refused.
  await assert.rejects(
    f.pc.compareTable({ session_id: sid, attributes: [] }),
    /non-empty array/,
  );

  // compareTable without catalog wiring refuses.
  var noCatalog = _factory(false);
  await assert.rejects(
    noCatalog.pc.compareTable({ session_id: sid }),
    /catalog must be wired/,
  );
}

// ---- defineCompareAttribute ---------------------------------------------

async function _defineAttribute() {
  var f = _factory({});

  // Define a brand-new attribute.
  var warranty = await f.pc.defineCompareAttribute({
    slug:   "warranty_years",
    label:  "Warranty (years)",
    source: "metadata",
    format: "number",
  });
  check("defineCompareAttribute persists",     warranty && warranty.slug === "warranty_years");
  check("defineCompareAttribute source",        warranty.source === "metadata");
  check("defineCompareAttribute format",        warranty.format === "number");
  check("defineCompareAttribute archived null", warranty.archived_at === null);
  check("defineCompareAttribute created_at",    typeof warranty.created_at === "number" && warranty.created_at > 0);

  // listAttributes surfaces it alongside the defaults.
  var list1 = await f.pc.listAttributes();
  check("listAttributes contains defaults",     list1.filter(function (a) { return a.slug === "price"; }).length === 1);
  check("listAttributes contains custom",        list1.filter(function (a) { return a.slug === "warranty_years"; }).length === 1);
  var customRow = list1.filter(function (a) { return a.slug === "warranty_years"; })[0];
  check("listAttributes custom not default",     customRow.default === false);
  var defaultRow = list1.filter(function (a) { return a.slug === "price"; })[0];
  check("listAttributes default flagged",        defaultRow.default === true);

  // listAttributes alphabetical.
  for (var i = 1; i < list1.length; i += 1) {
    if (list1[i].slug < list1[i - 1].slug) {
      throw new Error("listAttributes must be alphabetical, got " + list1[i].slug + " after " + list1[i - 1].slug);
    }
  }
  check("listAttributes alphabetical",           true);

  // Upsert: redefining the slug updates in place.
  var warrantyV2 = await f.pc.defineCompareAttribute({
    slug:   "warranty_years",
    label:  "Years of warranty",
    source: "metadata",
    format: "number",
  });
  check("defineCompareAttribute upsert label",   warrantyV2.label === "Years of warranty");

  // Operator-defined shadow of a default — overrides the baked-in
  // descriptor (point `price` at a metadata key instead of variant).
  var shadowed = await f.pc.defineCompareAttribute({
    slug:   "price",
    label:  "Listed price",
    source: "metadata",
    format: "currency",
  });
  check("defineCompareAttribute shadows default", shadowed.source === "metadata");
  var list2 = await f.pc.listAttributes();
  var priceRow = list2.filter(function (a) { return a.slug === "price"; })[0];
  check("listAttributes shadowed not default",    priceRow.default === false);
  check("listAttributes shadowed label",          priceRow.label === "Listed price");

  // compareTable picks up the shadowed source.
  var pid = _uuid();
  var catalogProds = {};
  catalogProds[pid] = {
    id:       pid,
    variants: [{ sku: "X", price_minor: 999 }],
    metadata: { price: 1234 },
  };
  var f2 = _factory(catalogProds);
  await f2.pc.defineCompareAttribute({ slug: "price", label: "Listed price", source: "metadata", format: "currency" });
  var sid = _sessionId();
  await f2.pc.addToCompare({ session_id: sid, product_id: pid });
  var table = await f2.pc.compareTable({ session_id: sid, attributes: ["price"] });
  check("compareTable uses shadowed source",     table.rows[0].values_per_product[0] === 1234);
}

// ---- popularCompares + recordImpression + cleanup ----------------------

async function _popularComparesMath() {
  var f = _factory({});

  var pidA = _uuid();
  var pidB = _uuid();
  var pidC = _uuid();

  var sid1 = _sessionId();
  var sid2 = _sessionId();
  var sid3 = _sessionId();

  // pidA: 3 impressions across 2 sessions
  await f.pc.recordImpression({ product_id: pidA, source_kind: "collection_page",        session_id: sid1 });
  await f.pc.recordImpression({ product_id: pidA, source_kind: "search_results",         session_id: sid1 });
  await f.pc.recordImpression({ product_id: pidA, source_kind: "collection_page",        session_id: sid2 });

  // pidB: 2 impressions across 2 sessions
  await f.pc.recordImpression({ product_id: pidB, source_kind: "product_recommendation", session_id: sid1 });
  await f.pc.recordImpression({ product_id: pidB, source_kind: "collection_page",        session_id: sid3 });

  // pidC: 1 impression
  await f.pc.recordImpression({ product_id: pidC, source_kind: "customer_account",       session_id: sid1 });

  var from = 1;
  var to   = Date.now() + 60000;

  var pop = await f.pc.popularCompares({ from: from, to: to });
  check("popularCompares 3 entries",             pop.length === 3);

  var rowA = pop.filter(function (r) { return r.product_id === pidA; })[0];
  var rowB = pop.filter(function (r) { return r.product_id === pidB; })[0];
  var rowC = pop.filter(function (r) { return r.product_id === pidC; })[0];
  check("popularCompares A impressions 3",       rowA.impressions === 3);
  check("popularCompares A distinct 2",          rowA.distinct_sessions === 2);
  check("popularCompares B impressions 2",       rowB.impressions === 2);
  check("popularCompares B distinct 2",          rowB.distinct_sessions === 2);
  check("popularCompares C impressions 1",       rowC.impressions === 1);
  check("popularCompares C distinct 1",          rowC.distinct_sessions === 1);

  // Order: A (3) > {B, C} where B has 2, C has 1.
  check("popularCompares A ranked first",        pop[0].product_id === pidA);
  check("popularCompares B ranked second",       pop[1].product_id === pidB);
  check("popularCompares C ranked third",        pop[2].product_id === pidC);

  // Limit truncates.
  var top1 = await f.pc.popularCompares({ from: from, to: to, limit: 1 });
  check("popularCompares limit truncates",       top1.length === 1 && top1[0].product_id === pidA);

  // Window outside the data — empty.
  var future = await f.pc.popularCompares({ from: to + 1000, to: to + 2000 });
  check("popularCompares empty window",          future.length === 0);

  // recordImpression refuses bad source_kind.
  await assert.rejects(
    f.pc.recordImpression({ product_id: pidA, source_kind: "Bad Kind", session_id: sid1 }),
    /source_kind/,
  );

  // popularCompares refuses inverted window.
  await assert.rejects(
    f.pc.popularCompares({ from: to, to: from }),
    /from must be <= to/,
  );

  // cleanup with days=0 sweeps every row whose timestamp is strictly
  // less than _now() — the impressions above all have timestamps in
  // the past, so all 6 land in the sweep.
  // Also seed a basket so the lists-cleanup branch runs.
  var sidBasket = _sessionId();
  await f.pc.addToCompare({ session_id: sidBasket, product_id: pidA });

  var swept = await f.pc.cleanupOlderThan(0);
  check("cleanupOlderThan reports baskets",      swept.baskets_removed === 1);
  check("cleanupOlderThan reports impressions",  swept.impressions_removed === 6);

  var popAfter = await f.pc.popularCompares({ from: from, to: to });
  check("cleanupOlderThan drained impressions",  popAfter.length === 0);
}

// ---- validation surface -------------------------------------------------

async function _validationSurface() {
  var f = _factory({});
  var sid = _sessionId();

  // addToCompare
  await assert.rejects(f.pc.addToCompare(),                                            /input object required/);
  await assert.rejects(f.pc.addToCompare({}),                                          /session_id/);
  await assert.rejects(f.pc.addToCompare({ session_id: "short" }),                     /session_id/);
  await assert.rejects(f.pc.addToCompare({ session_id: sid, product_id: "not-uuid" }), /product_id/);
  await assert.rejects(
    f.pc.addToCompare({ session_id: sid, product_id: _uuid(), customer_id: "bad" }),
    /customer_id/,
  );

  // removeFromCompare
  await assert.rejects(f.pc.removeFromCompare(),                                       /input object required/);
  await assert.rejects(f.pc.removeFromCompare({}),                                     /session_id/);

  // getCompareList
  await assert.rejects(f.pc.getCompareList(),                                          /input object required/);
  await assert.rejects(f.pc.getCompareList({ session_id: "" }),                        /session_id/);

  // clearCompareList
  await assert.rejects(f.pc.clearCompareList(),                                        /input object required/);

  // compareTable
  await assert.rejects(f.pc.compareTable(),                                            /input object required/);
  await assert.rejects(f.pc.compareTable({ session_id: "x" }),                         /session_id/);
  await assert.rejects(f.pc.compareTable({ session_id: sid, attributes: "nope" }),    /non-empty array/);
  await assert.rejects(f.pc.compareTable({ session_id: sid, attributes: ["Bad Slug"] }),  /must match/);

  // defineCompareAttribute
  await assert.rejects(f.pc.defineCompareAttribute(),                                  /input object required/);
  await assert.rejects(f.pc.defineCompareAttribute({}),                                /slug/);
  await assert.rejects(f.pc.defineCompareAttribute({ slug: "Bad" }),                   /slug/);
  await assert.rejects(
    f.pc.defineCompareAttribute({ slug: "ok-slug", label: "" }),
    /label/,
  );
  await assert.rejects(
    f.pc.defineCompareAttribute({ slug: "ok-slug", label: "L", source: "bogus", format: "text" }),
    /source/,
  );
  await assert.rejects(
    f.pc.defineCompareAttribute({ slug: "ok-slug", label: "L", source: "product", format: "bogus" }),
    /format/,
  );

  // recordImpression
  await assert.rejects(f.pc.recordImpression(),                                        /input object required/);
  await assert.rejects(
    f.pc.recordImpression({ product_id: "bad", source_kind: "x", session_id: sid }),
    /product_id/,
  );
  await assert.rejects(
    f.pc.recordImpression({ product_id: _uuid(), source_kind: "", session_id: sid }),
    /source_kind/,
  );
  await assert.rejects(
    f.pc.recordImpression({ product_id: _uuid(), source_kind: "ok", session_id: "x" }),
    /session_id/,
  );

  // popularCompares
  await assert.rejects(f.pc.popularCompares(),                                         /input object required/);
  await assert.rejects(f.pc.popularCompares({ from: 0, to: 100 }),                     /from/);
  await assert.rejects(f.pc.popularCompares({ from: 50, to: 0 }),                      /to/);
  await assert.rejects(f.pc.popularCompares({ from: 1, to: 100, limit: 0 }),           /limit/);
  await assert.rejects(f.pc.popularCompares({ from: 1, to: 100, limit: 99999 }),       /limit/);

  // cleanupOlderThan
  await assert.rejects(f.pc.cleanupOlderThan("week"),                                  /days/);
  await assert.rejects(f.pc.cleanupOlderThan(-1),                                      /days/);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("MAX_COMPARE exported",              productCompare.MAX_COMPARE === 4);
  check("ATTRIBUTE_SOURCES exported",         Array.isArray(productCompare.ATTRIBUTE_SOURCES)
                                              && productCompare.ATTRIBUTE_SOURCES.indexOf("variant") !== -1
                                              && productCompare.ATTRIBUTE_SOURCES.indexOf("product") !== -1
                                              && productCompare.ATTRIBUTE_SOURCES.indexOf("metadata") !== -1);
  check("ATTRIBUTE_FORMATS exported",         Array.isArray(productCompare.ATTRIBUTE_FORMATS)
                                              && productCompare.ATTRIBUTE_FORMATS.indexOf("currency") !== -1
                                              && productCompare.ATTRIBUTE_FORMATS.indexOf("text") !== -1);
  check("DEFAULT_ATTRIBUTE_SLUGS exported",   Array.isArray(productCompare.DEFAULT_ATTRIBUTE_SLUGS)
                                              && productCompare.DEFAULT_ATTRIBUTE_SLUGS.length === 7);
  check("DEFAULT_ATTRIBUTES includes price",  productCompare.DEFAULT_ATTRIBUTES.some(function (a) { return a.slug === "price"; }));
  check("SESSION_NAMESPACE exported",         typeof productCompare.SESSION_NAMESPACE === "string"
                                              && productCompare.SESSION_NAMESPACE.length > 0);

  var inst = productCompare.create({ query: _makeQuery().query });
  check("instance exposes MAX_COMPARE",       inst.MAX_COMPARE === 4);
  check("instance exposes ATTRIBUTE_SOURCES", inst.ATTRIBUTE_SOURCES.length === productCompare.ATTRIBUTE_SOURCES.length);
}

async function run() {
  await _addToCompareCap();
  await _removeFromCompare();
  await _getAndClear();
  await _compareTableShape();
  await _defineAttribute();
  await _popularComparesMath();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - product-compare (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
