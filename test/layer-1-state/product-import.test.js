"use strict";
/**
 * product-import — operator-managed bulk loader for products +
 * variants + prices + inventory + media. Distinct from
 * `catalogImport` (a thin synchronous CSV adapter); this primitive
 * tracks each run + per-row error in `product_imports` /
 * `product_import_errors`, supports three input formats, and exposes
 * a duplicate-SKU policy.
 *
 * Coverage:
 *   - dryRun against flat_csv: counts increment, catalog stays empty
 *   - happy path import: products + variants + prices + inventory persist
 *   - on_conflict = update reconciles existing rows
 *   - on_conflict = skip leaves existing rows untouched
 *   - on_conflict = error surfaces a duplicate_sku row-error
 *   - CSV with quoted commas + RFC-4180 quote-doubling parses cleanly
 *   - shopify_json shape converts price decimals to minor units
 *   - within-import duplicate-SKU dedupe surfaces as row-error
 *   - errorsForImport retrieval reads from product_import_errors
 *   - listImports filters by status
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib/product-import");
var catalogModule = require("../../lib/catalog");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var CATALOG_MIGRATION = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var IMPORTS_MIGRATION = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0069_product_imports.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [CATALOG_MIGRATION, IMPORTS_MIGRATION].forEach(function (mig) {
    var schema = nodeFs.readFileSync(mig, "utf8");
    _splitSchema(schema).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
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
}

var HEADER = bShop.FLAT_CSV_HEADER.join(",");

function _buildCsv(rows) {
  return [HEADER].concat(rows).join("\n") + "\n";
}

// Parse the CSV manually (mirroring the importer's b.csv path) so the
// test owns the array-of-arrays shape `importRows` expects. The
// importer's own `importFromCsv` wrapper is exercised separately.
function _parseCsvRows(csv) {
  // Minimal RFC-4180 splitter — handles quoted cells with embedded
  // commas + doubled-quote escapes. The framework's b.csv covers
  // the full grammar; this helper exists only to feed the importer.
  var out = [];
  var row = [];
  var cell = "";
  var inQuotes = false;
  for (var i = 0; i < csv.length; i += 1) {
    var c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i += 1; continue; }
        inQuotes = false; continue;
      }
      cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(cell); cell = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i += 1;
      if (row.length || cell.length) { row.push(cell); out.push(row); }
      row = []; cell = "";
      continue;
    }
    cell += c;
  }
  if (row.length || cell.length) { row.push(cell); out.push(row); }
  return out;
}

async function _dryRunCsv() {
  var query   = _makeQuery();
  var catalog = catalogModule.create({ query: query });
  var imp     = bShop.create({ query: query, catalog: catalog });

  var csv = _buildCsv([
    "dry-1,Dry 1,active,A description,DRY-1-A,Std,100,USD,1000,10,,,",
    "dry-1,Dry 1,active,A description,DRY-1-B,Lg,200,USD,2000,20,,,",
    "dry-2,Dry 2,active,Second,DRY-2-A,One,300,USD,3000,30,,,",
  ]);
  var rows = _parseCsvRows(csv);

  var result = await imp.dryRun({ rows: rows, format: "flat_csv" });
  check("dry_run flag set",         result.dry_run === true);
  check("dry_run status complete",  result.status === "complete");
  check("dry_run no row-errors",    result.rows_errored === 0);
  check("dry_run products counted", result.products_created === 2);
  check("dry_run variants counted", result.variants_created === 3);

  // No products persisted.
  var p = await catalog.products.bySlug("dry-1");
  check("dry_run wrote no products", p === null);
  var inv = await catalog.inventory.get("DRY-1-A");
  check("dry_run wrote no inventory", inv === null);

  // The run row IS persisted (operators audit dry-runs).
  var listed = await imp.listImports({});
  check("dry_run recorded a run row", listed.rows.length === 1);
  check("dry_run run row format",     listed.rows[0].format === "flat_csv");
}

async function _happyPathImport() {
  var query   = _makeQuery();
  var catalog = catalogModule.create({ query: query });
  var imp     = bShop.create({ query: query, catalog: catalog });

  var csv = _buildCsv([
    "hp-1,Happy 1,active,A description,HP-1-A,Std,100,USD,1000,10,products/hp-1.jpg,image/jpeg,Front",
    "hp-1,Happy 1,active,A description,HP-1-B,Lg,200,USD,2000,20,,,",
    "hp-2,Happy 2,draft,Another,HP-2-A,One,300,USD,3000,30,,,",
  ]);
  var rows = _parseCsvRows(csv);

  var result = await imp.importRows({ rows: rows, format: "flat_csv", on_conflict: "error" });
  check("happy status complete",     result.status === "complete");
  check("happy no row-errors",       result.rows_errored === 0);
  check("happy 2 products created",  result.products_created === 2);
  check("happy 3 variants created",  result.variants_created === 3);

  // Catalog rows persisted.
  var p = await catalog.products.bySlug("hp-1");
  check("hp-1 persisted",     p && p.title === "Happy 1" && p.status === "active");
  var variants = await catalog.variants.listForProduct(p.id);
  check("hp-1 has 2 variants", variants.length === 2);
  var price = await catalog.prices.current(variants[0].id, "USD");
  check("hp-1 variant price persisted", price && price.amount_minor === 1000);
  var inv = await catalog.inventory.get("HP-1-A");
  check("hp-1 inventory persisted", inv && inv.stock_on_hand === 10);

  // lastReport echoes the result.
  var last = imp.lastReport();
  check("lastReport echoes status",  last.status === "complete");
  check("lastReport echoes counts",  last.variants_created === 3);
}

async function _onConflictModes() {
  var query   = _makeQuery();
  var catalog = catalogModule.create({ query: query });
  var imp     = bShop.create({ query: query, catalog: catalog });

  // Seed: a product already exists in the catalog.
  var csvSeed = _buildCsv([
    "seed-1,Seed 1,active,Original desc,SEED-1-A,Std,100,USD,1000,10,,,",
  ]);
  await imp.importRows({ rows: _parseCsvRows(csvSeed), format: "flat_csv", on_conflict: "error" });

  // on_conflict = "skip" — same SKU re-imported. The existing
  // catalog row is untouched, the row counts as skipped.
  var csvDup = _buildCsv([
    "seed-1,Seed 1,active,UPDATED DESC,SEED-1-A,Std-new,500,USD,9999,99,,,",
  ]);
  var rSkip = await imp.importRows({ rows: _parseCsvRows(csvDup), format: "flat_csv", on_conflict: "skip" });
  check("skip status complete",       rSkip.status === "complete");
  check("skip counts as skipped",     rSkip.rows_skipped >= 1);
  check("skip no row-errors",         rSkip.rows_errored === 0);
  var seed1 = await catalog.products.bySlug("seed-1");
  check("skip left description alone", seed1.description === "Original desc");
  var seed1v = await catalog.variants.bySku("SEED-1-A");
  check("skip left weight alone",     seed1v.weight_grams === 100);

  // on_conflict = "update" — same SKU, different title + weight.
  // The existing variant + product update in place.
  var rUpd = await imp.importRows({ rows: _parseCsvRows(csvDup), format: "flat_csv", on_conflict: "update" });
  check("update status complete",     rUpd.status === "complete");
  check("update products_updated++",  rUpd.products_updated === 1);
  check("update variants_updated++",  rUpd.variants_updated === 1);
  var seed1b = await catalog.products.bySlug("seed-1");
  check("update changed description", seed1b.description === "UPDATED DESC");
  var seed1vb = await catalog.variants.bySku("SEED-1-A");
  check("update changed weight",      seed1vb.weight_grams === 500);
  var seed1p = await catalog.prices.current(seed1vb.id, "USD");
  check("update changed price",       seed1p.amount_minor === 9999);

  // on_conflict = "error" — same SKU, the variant insert refuses
  // at the catalog UNIQUE level and the driver records it as a
  // row-error rather than aborting.
  var rErr = await imp.importRows({ rows: _parseCsvRows(csvDup), format: "flat_csv", on_conflict: "error" });
  check("error status complete (driver doesn't abort)", rErr.status === "complete");
  check("error row-error recorded",   rErr.rows_errored === 1);
  check("error has duplicate_sku code",
    rErr.errors[0].error_code === "duplicate_sku");
}

async function _quotedCommas() {
  var query   = _makeQuery();
  var catalog = catalogModule.create({ query: query });
  var imp     = bShop.create({ query: query, catalog: catalog });

  // Quoted comma inside product_description + a doubled quote
  // inside variant_title.
  var csv =
    HEADER + "\n" +
    'qc-1,"Title, with comma",active,"A description, with two, commas","QC-1-A","Std ""quoted""",100,USD,1000,10,,,\n';
  var rows = _parseCsvRows(csv);

  var result = await imp.importRows({ rows: rows, format: "flat_csv", on_conflict: "error" });
  check("quoted-comma no errors",     result.rows_errored === 0);
  check("quoted-comma 1 product",     result.products_created === 1);
  var p = await catalog.products.bySlug("qc-1");
  check("quoted-comma title preserved",
    p.title === "Title, with comma");
  check("quoted-comma description preserved",
    p.description === "A description, with two, commas");
  var v = await catalog.variants.bySku("QC-1-A");
  check("quoted-comma variant title preserved",
    v.title === 'Std "quoted"');
}

async function _shopifyJsonShape() {
  var query   = _makeQuery();
  var catalog = catalogModule.create({ query: query });
  var imp     = bShop.create({ query: query, catalog: catalog });

  var products = [
    {
      handle: "shop-1",
      title:  "Shopify Product 1",
      status: "active",
      body_html: "<p>A description.</p>",
      variants: [
        { sku: "SHOP-1-A", title: "Standard", price: "19.99",  grams: 250, inventory_quantity: 5, currency: "USD" },
        { sku: "SHOP-1-B", title: "Large",    price: "29.99",  grams: 400, inventory_quantity: 3, currency: "USD" },
      ],
      images: [
        { src: "products/shop-1.jpg", alt: "Front" },
      ],
    },
    {
      handle: "shop-2",
      title:  "Shopify Product 2",
      status: "draft",
      variants: [
        { sku: "SHOP-2-A", price: "5.00", grams: 100, inventory_quantity: 10 },
      ],
    },
  ];
  var result = await imp.importRows({ rows: products, format: "shopify_json", on_conflict: "error" });
  check("shopify status complete",      result.status === "complete");
  check("shopify no row-errors",        result.rows_errored === 0);
  check("shopify 2 products created",   result.products_created === 2);
  check("shopify 3 variants created",   result.variants_created === 3);

  var p = await catalog.products.bySlug("shop-1");
  check("shopify product slug = handle", p && p.slug === "shop-1");
  var v = await catalog.variants.bySku("SHOP-1-A");
  var price = await catalog.prices.current(v.id, "USD");
  // 19.99 → 1999 minor units.
  check("shopify price decimal → minor", price.amount_minor === 1999);
  // Product-level media attached.
  var media = await catalog.media.listForProduct(p.id);
  check("shopify product image attached", media.length === 1 && media[0].r2_key === "products/shop-1.jpg");
}

async function _withinImportDedupe() {
  var query   = _makeQuery();
  var catalog = catalogModule.create({ query: query });
  var imp     = bShop.create({ query: query, catalog: catalog });

  // Same SKU twice in the same upload — row-error regardless of
  // on_conflict policy.
  var csv = _buildCsv([
    "dd-1,DD 1,active,desc,DUPE-SKU,A,100,USD,1000,10,,,",
    "dd-2,DD 2,active,desc,DUPE-SKU,B,200,USD,2000,20,,,",
    "dd-3,DD 3,active,desc,UNIQUE-SKU,C,300,USD,3000,30,,,",
  ]);
  var rows = _parseCsvRows(csv);

  var result = await imp.importRows({ rows: rows, format: "flat_csv", on_conflict: "update" });
  check("dedupe found 1 row-error",   result.rows_errored === 1);
  check("dedupe error code",          result.errors[0].error_code === "duplicate_sku_in_import");
  check("dedupe sku echoed",          result.errors[0].sku === "DUPE-SKU");
  // The first DUPE-SKU row should have persisted; the second was rejected.
  var v = await catalog.variants.bySku("DUPE-SKU");
  check("first DUPE-SKU row persisted", v && v.title === "A");
  var u = await catalog.variants.bySku("UNIQUE-SKU");
  check("UNIQUE-SKU row persisted", u !== null);
}

async function _errorsForImportRetrieval() {
  var query   = _makeQuery();
  var catalog = catalogModule.create({ query: query });
  var imp     = bShop.create({ query: query, catalog: catalog });

  // Trigger 2 row-errors: bad numeric in row 1, duplicate-SKU-in-
  // import across rows 2 and 3.
  var csv = _buildCsv([
    "ef-1,EF 1,active,desc,EF-1-A,Std,not-a-number,USD,1000,10,,,",
    "ef-2,EF 2,active,desc,SAME-SKU,A,100,USD,1000,10,,,",
    "ef-3,EF 3,active,desc,SAME-SKU,B,200,USD,2000,20,,,",
    "ef-4,EF 4,active,desc,EF-4-A,Std,100,USD,1000,10,,,",
  ]);
  var rows = _parseCsvRows(csv);

  var result = await imp.importRows({ rows: rows, format: "flat_csv", on_conflict: "error" });
  check("errors collected in report", result.rows_errored === 2);

  // Read the errors back out of the DB through the public API.
  var got = await imp.errorsForImport(result.import_id);
  check("errorsForImport returned 2 rows", got.rows.length === 2);
  check("errors have row_index",           got.rows[0].row_index >= 1);
  check("errors have error_code",          got.rows[0].error_code && got.rows[0].error_code.length > 0);

  // Bad UUID refuses.
  await assert.rejects(imp.errorsForImport("not-a-uuid"), /import_id/);

  // listImports finds the run.
  var listed = await imp.listImports({ status: "complete" });
  check("listImports filtered by status", listed.rows.length === 1);
  check("listImports row carries counts", listed.rows[0].rows_errored === 2);
}

async function _factoryValidation() {
  assert.throws(function () { bShop.create({}); }, /catalog required/);

  var catalog = catalogModule.create({ query: _makeQuery() });
  var imp = bShop.create({ query: _makeQuery(), catalog: catalog });

  // Bad format.
  await assert.rejects(imp.importRows({ rows: [], format: "xml" }),
    /format must be one of/);
  // Bad on_conflict.
  await assert.rejects(imp.importRows({ rows: [], format: "flat_csv", on_conflict: "wrong" }),
    /on_conflict must be one of/);
  // Rows not array.
  await assert.rejects(imp.importRows({ rows: "not array", format: "flat_csv" }),
    /rows must be an array/);
}

async function run() {
  await _dryRunCsv();
  await _happyPathImport();
  await _onConflictModes();
  await _quotedCommas();
  await _shopifyJsonShape();
  await _withinImportDedupe();
  await _errorsForImportRetrieval();
  await _factoryValidation();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    var n = helpers.getChecks();
    process.stdout.write("product-import: " + n + " checks passed\n");
  }).catch(function (e) {
    process.stderr.write("product-import: FAILED — " + (e && e.stack || e) + "\n");
    process.exitCode = 1;
  });
}
