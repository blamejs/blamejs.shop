"use strict";
/**
 * quantityDiscounts — automatic per-line price-break schedules.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migrations: 0001 (catalog) + 0044 (qd_tier_sets / qd_tiers). The
 * catalog primitive is composed live (using the same in-memory
 * query) so the variants.bySku lookup the primitive depends on
 * exercises real SQL, not a mock.
 *
 * Coverage:
 *   - defineTier at sku / product / collection_slug / vendor /
 *     category / global scope
 *   - defineTier refuses overlapping min_quantity within one set
 *   - defineTier refuses unknown sku at scope = 'sku'
 *   - getTiersForLine returns rules ordered by scope-specificity
 *   - applyToLine for each discount_kind (percent_off,
 *     amount_off_each, amount_off_total, fixed_each_price)
 *   - applyToLine picks the best (lowest final price) rule when
 *     multiple non-exclusive sets stack
 *   - applyToLine: exclusive set wins outright even at higher price
 *   - applyToCart aggregates per-line breakdown + totals
 *   - archive removes the set from active eval; unarchive restores
 *   - update tiers wholesale + update exclusive flag
 *   - list filters by scope + archived
 *   - tierBreakdown renders the schedule with sample-unit math
 *   - factory guards: catalog handle is required
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop             = require("../../lib");
var quantityDiscounts = require("../../lib/quantity-discounts");
var helpers           = require("../helpers");
var check             = helpers.check;
var assert            = helpers.assert;

var MIGS = ["0001_catalog.sql", "0044_quantity_discounts.sql"].map(function (f) {
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

async function _seedVariants(query, skus) {
  var catalog = bShop.catalog.create({ query: query });
  var p = await catalog.products.create({ slug: "p-" + Date.now() + "-" + Math.floor(Math.random() * 1e6), title: "P", status: "active" });
  for (var i = 0; i < skus.length; i += 1) {
    await catalog.variants.create(p.id, { sku: skus[i] });
  }
  return { catalog: catalog, productId: p.id };
}

// ---- defineTier happy + each scope -------------------------------------

async function _defineTierEveryScope() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["WIDGET-A", "WIDGET-B"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  // SKU scope
  var skuSet = await qd.defineTier({
    scope: "sku", scope_id: "WIDGET-A",
    tiers: [
      { min_quantity: 5,  discount_kind: "percent_off", value: 1000 },   // 10%
      { min_quantity: 10, discount_kind: "percent_off", value: 2000 },   // 20%
    ],
  });
  check("defineTier sku scope returns id",        typeof skuSet.id === "string" && skuSet.id.length > 0);
  check("defineTier sku scope preserves scope_id", skuSet.scope_id === "WIDGET-A");
  check("defineTier sku scope has 2 tiers",       skuSet.tiers.length === 2);
  check("defineTier sku scope sort_order assigned", skuSet.tiers[0].sort_order === 0 && skuSet.tiers[1].sort_order === 1);
  check("defineTier defaults exclusive=false",     skuSet.exclusive === false);

  // Product scope
  var prodSet = await qd.defineTier({
    scope: "product", scope_id: seeded.productId,
    tiers: [{ min_quantity: 3, discount_kind: "amount_off_each", value: 100 }],
  });
  check("defineTier product scope",                prodSet.scope === "product" && prodSet.scope_id === seeded.productId);

  // Collection slug scope
  var collSet = await qd.defineTier({
    scope: "collection_slug", scope_id: "summer-sale",
    tiers: [{ min_quantity: 2, discount_kind: "percent_off", value: 500 }],
  });
  check("defineTier collection_slug scope",        collSet.scope === "collection_slug" && collSet.scope_id === "summer-sale");

  // Vendor scope
  var vendSet = await qd.defineTier({
    scope: "vendor", scope_id: "acme-co",
    tiers: [{ min_quantity: 100, discount_kind: "percent_off", value: 300 }],
  });
  check("defineTier vendor scope",                 vendSet.scope === "vendor");

  // Category scope
  var catSet = await qd.defineTier({
    scope: "category", scope_id: "tools",
    tiers: [{ min_quantity: 4, discount_kind: "fixed_each_price", value: 999 }],
  });
  check("defineTier category scope",               catSet.scope === "category");

  // Global scope
  var globalSet = await qd.defineTier({
    scope: "global", scope_id: null,
    tiers: [{ min_quantity: 20, discount_kind: "percent_off", value: 100 }],
  });
  check("defineTier global scope_id null",         globalSet.scope === "global" && globalSet.scope_id === null);
}

// ---- defineTier refusals + overlap-refusal -----------------------------

async function _defineTierRefusals() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["KNOWN-SKU"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  // No input
  await assert.rejects(qd.defineTier(),                           /input object required/);
  // Bad scope
  await assert.rejects(qd.defineTier({ scope: "bogus", scope_id: "x", tiers: [{ min_quantity: 1, discount_kind: "percent_off", value: 100 }] }), /scope/);
  // scope_id required when scope <> 'global'
  await assert.rejects(qd.defineTier({ scope: "sku", scope_id: null, tiers: [{ min_quantity: 1, discount_kind: "percent_off", value: 100 }] }), /scope_id/);
  // scope_id forbidden when scope = 'global'
  await assert.rejects(qd.defineTier({ scope: "global", scope_id: "x", tiers: [{ min_quantity: 1, discount_kind: "percent_off", value: 100 }] }), /null/);
  // Empty tiers
  await assert.rejects(qd.defineTier({ scope: "sku", scope_id: "KNOWN-SKU", tiers: [] }), /non-empty array/);
  // Bad discount_kind
  await assert.rejects(qd.defineTier({ scope: "sku", scope_id: "KNOWN-SKU", tiers: [{ min_quantity: 1, discount_kind: "WAT", value: 100 }] }), /discount_kind/);
  // Negative value
  await assert.rejects(qd.defineTier({ scope: "sku", scope_id: "KNOWN-SKU", tiers: [{ min_quantity: 1, discount_kind: "percent_off", value: -1 }] }), /value/);
  // bps > 10000
  await assert.rejects(qd.defineTier({ scope: "sku", scope_id: "KNOWN-SKU", tiers: [{ min_quantity: 1, discount_kind: "percent_off", value: 10001 }] }), /percent_off/);
  // Zero min_quantity
  await assert.rejects(qd.defineTier({ scope: "sku", scope_id: "KNOWN-SKU", tiers: [{ min_quantity: 0, discount_kind: "percent_off", value: 100 }] }), /min_quantity/);
  // Overlap refusal
  await assert.rejects(qd.defineTier({
    scope: "sku", scope_id: "KNOWN-SKU",
    tiers: [
      { min_quantity: 5, discount_kind: "percent_off",     value: 1000 },
      { min_quantity: 5, discount_kind: "amount_off_each", value: 50 },
    ],
  }), /duplicate min_quantity|overlapping thresholds/);
  // Unknown SKU at scope = 'sku' refused
  await assert.rejects(qd.defineTier({
    scope: "sku", scope_id: "NOT-IN-CATALOG",
    tiers: [{ min_quantity: 1, discount_kind: "percent_off", value: 100 }],
  }), /not found in catalog/);
}

// ---- applyToLine per discount kind -------------------------------------

async function _applyToLineEachKind() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["A-SKU"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  // percent_off — 10% off unit when qty >= 5
  await qd.defineTier({
    scope: "sku", scope_id: "A-SKU",
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 1000 }],
  });
  var r1 = await qd.applyToLine({ line: { sku: "A-SKU", quantity: 5, unit_price_minor: 1000 } });
  check("percent_off discounted_unit",      r1.discounted_unit_minor === 900);   // 1000 * 0.9
  check("percent_off line_subtotal",        r1.line_subtotal_minor === 4500);
  check("percent_off line_discount",        r1.line_discount_minor === 500);
  check("percent_off applied_tier_id set",  typeof r1.applied_tier_id === "string");

  // Below threshold — no discount
  var rUnder = await qd.applyToLine({ line: { sku: "A-SKU", quantity: 4, unit_price_minor: 1000 } });
  check("below-threshold no discount",      rUnder.discounted_unit_minor === 1000 && rUnder.applied_tier_id === null);
  check("below-threshold subtotal full",    rUnder.line_subtotal_minor === 4000);

  // amount_off_each — $1 off per unit at qty >= 3
  await _seedVariants(q, ["B-SKU"]);   // separate product for cleanliness
  var qd2 = quantityDiscounts.create({ query: q, catalog: seeded.catalog });
  await qd2.defineTier({
    scope: "sku", scope_id: "B-SKU",
    tiers: [{ min_quantity: 3, discount_kind: "amount_off_each", value: 100 }],
  });
  var r2 = await qd2.applyToLine({ line: { sku: "B-SKU", quantity: 3, unit_price_minor: 1000 } });
  check("amount_off_each discounted_unit",  r2.discounted_unit_minor === 900);
  check("amount_off_each line_subtotal",    r2.line_subtotal_minor === 2700);

  // amount_off_total — flat $5 off the line at qty >= 2
  await _seedVariants(q, ["C-SKU"]);
  await qd2.defineTier({
    scope: "sku", scope_id: "C-SKU",
    tiers: [{ min_quantity: 2, discount_kind: "amount_off_total", value: 500 }],
  });
  var r3 = await qd2.applyToLine({ line: { sku: "C-SKU", quantity: 2, unit_price_minor: 1000 } });
  check("amount_off_total line_subtotal",   r3.line_subtotal_minor === 1500);
  check("amount_off_total line_discount",   r3.line_discount_minor === 500);

  // fixed_each_price — set the unit to $7.99 at qty >= 4
  await _seedVariants(q, ["D-SKU"]);
  await qd2.defineTier({
    scope: "sku", scope_id: "D-SKU",
    tiers: [{ min_quantity: 4, discount_kind: "fixed_each_price", value: 799 }],
  });
  var r4 = await qd2.applyToLine({ line: { sku: "D-SKU", quantity: 4, unit_price_minor: 1000 } });
  check("fixed_each_price discounted_unit", r4.discounted_unit_minor === 799);
  check("fixed_each_price line_subtotal",   r4.line_subtotal_minor === 3196);
  check("fixed_each_price line_discount",   r4.line_discount_minor === 804);   // 4*1000 - 4*799
}

// ---- scope-specificity + stacking pick best ----------------------------

async function _stackingPicksBest() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["STACK-SKU"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  // Global rule: 5% off at qty >= 5
  await qd.defineTier({
    scope: "global", scope_id: null,
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 500 }],
  });
  // Product rule: 10% off at qty >= 5
  await qd.defineTier({
    scope: "product", scope_id: seeded.productId,
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 1000 }],
  });
  // SKU rule: 15% off at qty >= 5
  await qd.defineTier({
    scope: "sku", scope_id: "STACK-SKU",
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 1500 }],
  });

  // getTiersForLine returns rules ordered sku > product > global
  var ordered = await qd.getTiersForLine({
    sku:        "STACK-SKU",
    product_id: seeded.productId,
    quantity:   5,
  });
  check("getTiersForLine returns 3 buckets",        ordered.length === 3);
  check("getTiersForLine most-specific first",      ordered[0].tier_set.scope === "sku");
  check("getTiersForLine product next",             ordered[1].tier_set.scope === "product");
  check("getTiersForLine global last",              ordered[2].tier_set.scope === "global");

  // applyToLine picks the best (lowest final price) — the SKU rule.
  var r = await qd.applyToLine({
    line: { sku: "STACK-SKU", product_id: seeded.productId, quantity: 5, unit_price_minor: 1000 },
  });
  check("stacking picks best (sku 15% off)",        r.discounted_unit_minor === 850);
  check("stacking applied_tier_id matches sku set", r.applied_tier_id === ordered[0].applicable[0].id);
}

// ---- exclusive override ------------------------------------------------

async function _exclusiveOverrides() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["EXC-SKU"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  // SKU rule: aggressive 50% off (the "best" by raw math)
  await qd.defineTier({
    scope: "sku", scope_id: "EXC-SKU",
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 5000 }],
  });

  // Global EXCLUSIVE rule: 10% off. Less aggressive but exclusive
  // — should win regardless of better non-exclusive options.
  await qd.defineTier({
    scope: "global", scope_id: null, exclusive: true,
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 1000 }],
  });

  var r = await qd.applyToLine({
    line: { sku: "EXC-SKU", product_id: seeded.productId, quantity: 5, unit_price_minor: 1000 },
  });
  check("exclusive set wins over more-aggressive non-exclusive", r.discounted_unit_minor === 900);
  check("exclusive applied_tier_id non-null",                    typeof r.applied_tier_id === "string");
}

// ---- applyToCart aggregation -------------------------------------------

async function _applyToCartAggregation() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["BULK-A", "BULK-B"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  await qd.defineTier({
    scope: "sku", scope_id: "BULK-A",
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 1000 }],
  });
  await qd.defineTier({
    scope: "sku", scope_id: "BULK-B",
    tiers: [{ min_quantity: 3, discount_kind: "amount_off_each", value: 200 }],
  });

  var cart = await qd.applyToCart({
    lines: [
      { sku: "BULK-A", quantity: 5, unit_price_minor: 1000 },   // 5 * 900 = 4500
      { sku: "BULK-B", quantity: 3, unit_price_minor: 1000 },   // 3 *  800 = 2400
      { sku: "OTHER",  quantity: 1, unit_price_minor: 500  },   // no discount, 500
    ],
  });
  check("applyToCart per-line rows",          cart.lines.length === 3);
  check("applyToCart subtotal sum",           cart.subtotal_minor === 7400);
  check("applyToCart discount sum",           cart.discount_total_minor === 1100);
  check("applyToCart original total sum",     cart.original_total_minor === 8500);
  check("applyToCart line A discounted_unit", cart.lines[0].discounted_unit_minor === 900);
  check("applyToCart line C no discount",     cart.lines[2].applied_tier_id === null);
}

// ---- archive + unarchive + list ----------------------------------------

async function _archiveLifecycle() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["ARCH-SKU"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  var s = await qd.defineTier({
    scope: "sku", scope_id: "ARCH-SKU",
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 1000 }],
  });

  // Active eval picks it up
  var beforeArchive = await qd.applyToLine({ line: { sku: "ARCH-SKU", quantity: 5, unit_price_minor: 1000 } });
  check("pre-archive discount applied",       beforeArchive.discounted_unit_minor === 900);

  // Archive
  var archived = await qd.archive(s.id);
  check("archive returns true",               archived === true);
  // Archive idempotency — second archive is a no-op
  var archivedAgain = await qd.archive(s.id);
  check("archive idempotent (already archived)", archivedAgain === false);

  // Active eval skips it
  var afterArchive = await qd.applyToLine({ line: { sku: "ARCH-SKU", quantity: 5, unit_price_minor: 1000 } });
  check("post-archive no discount",           afterArchive.discounted_unit_minor === 1000);
  check("post-archive applied_tier_id null",  afterArchive.applied_tier_id === null);

  // list() default hides archived
  var activeList = await qd.list({ scope: "sku" });
  check("list default hides archived",        activeList.length === 0);

  // list({ archived: true }) shows them
  var archivedList = await qd.list({ scope: "sku", archived: true });
  check("list archived=true shows it",        archivedList.length === 1 && archivedList[0].id === s.id);

  // list({ archived: null }) shows both
  var allList = await qd.list({ archived: null });
  check("list archived=null shows all",       allList.length === 1);

  // Unarchive restores
  var un = await qd.unarchive(s.id);
  check("unarchive returns true",             un === true);
  var unAgain = await qd.unarchive(s.id);
  check("unarchive idempotent",               unAgain === false);
  var afterUnarchive = await qd.applyToLine({ line: { sku: "ARCH-SKU", quantity: 5, unit_price_minor: 1000 } });
  check("post-unarchive discount restored",   afterUnarchive.discounted_unit_minor === 900);
}

// ---- update tiers + exclusive ------------------------------------------

async function _updateLifecycle() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["UPD-SKU"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  var s = await qd.defineTier({
    scope: "sku", scope_id: "UPD-SKU",
    tiers: [{ min_quantity: 5, discount_kind: "percent_off", value: 1000 }],
  });

  // Patch exclusive flag
  var p1 = await qd.update(s.id, { exclusive: true });
  check("update exclusive flag",              p1.exclusive === true);

  // Tier rewrite
  var p2 = await qd.update(s.id, {
    tiers: [
      { min_quantity: 2,  discount_kind: "percent_off", value: 500  },
      { min_quantity: 10, discount_kind: "percent_off", value: 2500 },
    ],
  });
  check("update tiers replaced",              p2.tiers.length === 2);
  check("update tiers min_quantity 2",        p2.tiers[0].min_quantity === 2);
  check("update tiers min_quantity 10",       p2.tiers[1].min_quantity === 10);

  // Empty patch refused
  await assert.rejects(qd.update(s.id, {}), /no updatable fields/);

  // Update overlap refused
  await assert.rejects(qd.update(s.id, {
    tiers: [
      { min_quantity: 5, discount_kind: "percent_off",     value: 500 },
      { min_quantity: 5, discount_kind: "amount_off_each", value: 50 },
    ],
  }), /duplicate min_quantity|overlapping thresholds/);

  // Update on missing returns null
  var miss = await qd.update("nonexistent-id", { exclusive: false });
  check("update missing returns null",        miss === null);
}

// ---- tierBreakdown -----------------------------------------------------

async function _tierBreakdownRenders() {
  var q = _makeQuery();
  var seeded = await _seedVariants(q, ["BD-SKU"]);
  var qd = quantityDiscounts.create({ query: q, catalog: seeded.catalog });

  await qd.defineTier({
    scope: "sku", scope_id: "BD-SKU",
    tiers: [
      { min_quantity: 5,  discount_kind: "percent_off", value: 1000 },
      { min_quantity: 10, discount_kind: "percent_off", value: 2000 },
    ],
  });

  // No sample price — just the schedule
  var bare = await qd.tierBreakdown({ scope: "sku", scope_id: "BD-SKU" });
  check("tierBreakdown returns scope",          bare.scope === "sku");
  check("tierBreakdown rows count",             bare.rows.length === 2);
  check("tierBreakdown first row min_quantity", bare.rows[0].min_quantity === 5);
  check("tierBreakdown first row no sample",    bare.rows[0].sample_discounted_unit_minor === undefined);

  // With sample unit price — every row carries sample math
  var withSample = await qd.tierBreakdown({
    scope: "sku", scope_id: "BD-SKU",
    sample_unit_price_minor: 1000,
  });
  check("tierBreakdown sample row 5",           withSample.rows[0].sample_discounted_unit_minor === 900);
  check("tierBreakdown sample row 5 subtotal",  withSample.rows[0].sample_line_subtotal_minor === 4500);
  check("tierBreakdown sample row 10",          withSample.rows[1].sample_discounted_unit_minor === 800);

  // Archived sets are skipped
  var sets = await qd.list({ scope: "sku" });
  await qd.archive(sets[0].id);
  var afterArchive = await qd.tierBreakdown({ scope: "sku", scope_id: "BD-SKU" });
  check("tierBreakdown skips archived sets",    afterArchive.rows.length === 0);
}

// ---- factory guards ----------------------------------------------------

async function _factoryGuards() {
  assert.throws(function () { quantityDiscounts.create({}); },                            /catalog/);
  assert.throws(function () { quantityDiscounts.create({ catalog: {} }); },               /catalog/);
  assert.throws(function () { quantityDiscounts.create({ catalog: { variants: {} } }); }, /catalog/);
}

async function run() {
  await _defineTierEveryScope();
  await _defineTierRefusals();
  await _applyToLineEachKind();
  await _stackingPicksBest();
  await _exclusiveOverrides();
  await _applyToCartAggregation();
  await _archiveLifecycle();
  await _updateLifecycle();
  await _tierBreakdownRenders();
  await _factoryGuards();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — quantity-discounts (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — quantity-discounts: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
