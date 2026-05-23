"use strict";
/**
 * variants — option-axis matrix layer on top of catalog.products.
 *
 * Layer 1 against in-memory node:sqlite. Loads both
 * `migrations-d1/0001_catalog.sql` (for the `products` parent table
 * referenced by the variants FKs) and `migrations-d1/0033_product_
 * variants.sql` so every CHECK / UNIQUE / FK declared in the live
 * D1 schema is exercised end-to-end.
 *
 * Coverage:
 *   - defineAxis: happy path + refusal classes (duplicate axis,
 *     empty options, case-insensitive duplicate option labels,
 *     bad axis_name shape, oversized values, non-existent product)
 *   - generateMatrix: cartesian-product correctness (2x3 = 6,
 *     2x3x2 = 12), and refuses when no axes exist
 *   - materializeMatrix: writes the cartesian rows with the
 *     sku_prefix slug shape, idempotent re-run with a freshly-added
 *     axis option only inserts the new rows
 *   - findVariant: exact-match returns the row, missing combination
 *     returns null, archived variants excluded
 *   - archiveVariant: row drops out of the default list but still
 *     resolves via getVariant + variantsForProduct({ include_
 *     archived: true })
 *   - archiveAxisOption: cascades the archive to every live variant
 *     carrying the (axis, option) pair
 *   - updateVariant: allowlist (sku / price_minor / weight_grams /
 *     image_url / inventory_count / archived) round-trips; unknown
 *     key throws; image_url scheme allowlist enforced
 *   - unarchiveVariant: round-trips the archive bit
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop    = require("../../lib");
var variantsLib = require("../../lib/variants");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_CATALOG  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_VARIANTS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0033_product_variants.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_CATALOG,  "utf8")).forEach(function (s) { db.prepare(s).run(); });
  _splitSchema(nodeFs.readFileSync(MIG_VARIANTS, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// Spin up a product so variants ops have a real parent row to FK
// against. The catalog instance is wired into the variants factory so
// `defineAxis` validates the product_id against the live catalog.
async function _setup() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query, cursorSecret: "test-secret-variants" });
  var variants = variantsLib.create({ query: query, catalog: catalog });
  var product = await catalog.products.create({
    slug:   "test-shirt",
    title:  "Test Shirt",
    status: "active",
  });
  return { query: query, catalog: catalog, variants: variants, product: product };
}

async function _defineAxisHappyAndRefusals() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  var color = await v.defineAxis({
    product_id: pid,
    axis_name:  "color",
    options:    ["red", "blue", "green"],
  });
  check("defineAxis: returns id (uuid shape)",         typeof color.id === "string" && color.id.length === 36);
  check("defineAxis: stores axis_name verbatim",       color.axis_name === "color");
  check("defineAxis: stamps position = 0 on first",    color.position === 0);
  check("defineAxis: stores all 3 option rows",        color.options.length === 3);
  check("defineAxis: positions options in input order", color.options[0].option_value === "red" && color.options[1].option_value === "blue" && color.options[2].option_value === "green");

  var size = await v.defineAxis({
    product_id: pid,
    axis_name:  "size",
    options:    ["S", "M", "L", "XL"],
  });
  check("defineAxis: second axis takes position = 1",  size.position === 1);

  // Refusals
  await assert.rejects(v.defineAxis(),                                                          /input object required/);
  await assert.rejects(v.defineAxis({ product_id: pid, axis_name: "color", options: ["x"] }),   /already registered/);
  await assert.rejects(v.defineAxis({ product_id: pid, axis_name: "weight", options: [] }),     /non-empty array/);
  await assert.rejects(v.defineAxis({ product_id: pid, axis_name: "weight", options: ["red", "RED"] }), /duplicate option label/);
  await assert.rejects(v.defineAxis({ product_id: pid, axis_name: "Bad Name", options: ["x"] }), /axis_name must match/);
  await assert.rejects(v.defineAxis({ product_id: pid, axis_name: "weight", options: ["a", ""] }), /options\[1\]/);
  await assert.rejects(v.defineAxis({ product_id: "not-a-uuid", axis_name: "weight", options: ["x"] }), /product_id/);
  var validButMissing = "00000000-0000-7000-8000-000000000000";
  await assert.rejects(v.defineAxis({ product_id: validButMissing, axis_name: "weight", options: ["x"] }), /no product matches/);
  await assert.rejects(v.defineAxis({ product_id: pid, axis_name: "ctrl", options: ["bad\nvalue"] }), /control bytes/);
}

async function _generateMatrix2x3And2x3x2() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  // 2 axes: color (3) × size (2) = 6
  await v.defineAxis({ product_id: pid, axis_name: "color", options: ["red", "blue", "green"] });
  await v.defineAxis({ product_id: pid, axis_name: "size",  options: ["S", "M"] });

  var matrix = await v.generateMatrix(pid);
  check("generateMatrix: cartesian count for 3x2 = 6", matrix.length === 6);
  var combos = matrix.map(function (m) { return m.axis_values.color + "/" + m.axis_values.size; });
  combos.sort();
  check("generateMatrix: covers every (color, size) combo",
    combos.join(",") === "blue/M,blue/S,green/M,green/S,red/M,red/S");

  // Add a third axis: fit (2) → 3 × 2 × 2 = 12
  await v.defineAxis({ product_id: pid, axis_name: "fit", options: ["slim", "regular"] });
  var matrix3 = await v.generateMatrix(pid);
  check("generateMatrix: cartesian count for 3x2x2 = 12", matrix3.length === 12);

  // Refuses on product with no axes
  var bare = await ctx.catalog.products.create({ slug: "no-axes", title: "Bare" });
  await assert.rejects(v.generateMatrix(bare.id), /no axes registered/);
}

async function _materializeMatrixWithSkuPrefix() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  await v.defineAxis({ product_id: pid, axis_name: "color", options: ["Navy Blue", "Forest Green"] });
  await v.defineAxis({ product_id: pid, axis_name: "size",  options: ["S", "M", "L"] });

  var result = await v.materializeMatrix(pid, {
    sku_prefix:       "TSHIRT",
    base_price_minor: 1999,
  });
  check("materializeMatrix: inserts 6 rows (2x3)",   result.inserted.length === 6);
  check("materializeMatrix: skipped 0 on fresh run", result.skipped === 0);
  check("materializeMatrix: total 6",                result.total === 6);

  // SKUs slugged: spaces -> hyphens, uppercase -> lowercase, prefix preserved-cased then lowered
  var skus = result.inserted.map(function (r) { return r.sku; }).sort();
  check("materializeMatrix: slug shape lowercase + hyphenated",
    skus[0] === "tshirt-forest-green-l"
    && skus[1] === "tshirt-forest-green-m"
    && skus[2] === "tshirt-forest-green-s"
    && skus[3] === "tshirt-navy-blue-l"
    && skus[4] === "tshirt-navy-blue-m"
    && skus[5] === "tshirt-navy-blue-s");

  // Every row carries the base price
  check("materializeMatrix: every variant carries base_price_minor", result.inserted.every(function (r) { return r.price_minor === 1999; }));

  // Idempotent re-run with a freshly added axis option only inserts
  // the missing rows.
  var axes = (await ctx.query(
    "SELECT id FROM product_variant_axes WHERE product_id = ?1 AND axis_name = 'size'",
    [pid],
  )).rows;
  var newOptId = bShop.framework.uuid.v7();
  await ctx.query(
    "INSERT INTO product_variant_axis_options (id, axis_id, option_value, position, archived_at) VALUES (?1, ?2, 'XL', 99, NULL)",
    [newOptId, axes[0].id],
  );
  var rerun = await v.materializeMatrix(pid, {
    sku_prefix:       "TSHIRT",
    base_price_minor: 1999,
  });
  check("materializeMatrix: re-run inserts only the 2 new rows", rerun.inserted.length === 2);
  check("materializeMatrix: re-run skips the 6 existing rows",   rerun.skipped === 6);
  check("materializeMatrix: re-run total = 8",                   rerun.total === 8);

  // Refusal: bad sku_prefix
  await assert.rejects(v.materializeMatrix(pid, { sku_prefix: "has spaces", base_price_minor: 0 }), /sku_prefix/);
  await assert.rejects(v.materializeMatrix(pid, { sku_prefix: "TSHIRT", base_price_minor: -1 }),   /base_price_minor/);
}

async function _findVariantExactMatch() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  await v.defineAxis({ product_id: pid, axis_name: "color", options: ["red", "blue"] });
  await v.defineAxis({ product_id: pid, axis_name: "size",  options: ["S", "M", "L"] });
  await v.materializeMatrix(pid, { sku_prefix: "T", base_price_minor: 500 });

  var hit = await v.findVariant({
    product_id:  pid,
    axis_values: { color: "red", size: "L" },
  });
  check("findVariant: exact-match returns the row",   hit !== null);
  check("findVariant: sku matches the slugged shape", hit.sku === "t-red-l");
  check("findVariant: axis_values map round-trips",   hit.axis_values.color === "red" && hit.axis_values.size === "L");

  // Key ordering doesn't matter — canonical-JSON normalises
  var hitReordered = await v.findVariant({
    product_id:  pid,
    axis_values: { size: "L", color: "red" },
  });
  check("findVariant: key order is insignificant", hitReordered !== null && hitReordered.id === hit.id);

  // Missing combination returns null
  var miss = await v.findVariant({
    product_id:  pid,
    axis_values: { color: "green", size: "L" },
  });
  check("findVariant: unknown combination returns null", miss === null);

  // Refusals
  await assert.rejects(v.findVariant(),                                                  /input object required/);
  await assert.rejects(v.findVariant({ product_id: pid }),                                /axis_values/);
  await assert.rejects(v.findVariant({ product_id: pid, axis_values: {} }),               /at least one entry/);
  await assert.rejects(v.findVariant({ product_id: pid, axis_values: { "Bad Name": "x" } }), /axis_name/);
}

async function _archiveVariantHidesFromDefaultList() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  await v.defineAxis({ product_id: pid, axis_name: "color", options: ["red", "blue"] });
  await v.defineAxis({ product_id: pid, axis_name: "size",  options: ["S", "M"] });
  var mat = await v.materializeMatrix(pid, { sku_prefix: "T", base_price_minor: 100 });
  var target = mat.inserted[0];

  var listBefore = await v.variantsForProduct(pid);
  check("variantsForProduct: lists all 4 before archive", listBefore.length === 4);

  var archived = await v.archiveVariant(target.id);
  check("archiveVariant: stamps archived_at on the row", archived.archived_at !== null && typeof archived.archived_at === "number");

  var listAfter = await v.variantsForProduct(pid);
  check("variantsForProduct: default list excludes archived row",   listAfter.length === 3);
  check("variantsForProduct: archived row not in default list",     !listAfter.some(function (r) { return r.id === target.id; }));

  // Id-lookup still resolves so historic order lines render
  var still = await v.getVariant(target.id);
  check("getVariant: archived row still resolves by id", still !== null && still.id === target.id);

  // include_archived: true returns the full set
  var listAll = await v.variantsForProduct(pid, { include_archived: true });
  check("variantsForProduct: include_archived lists all 4", listAll.length === 4);

  // findVariant excludes archived rows
  var missArchived = await v.findVariant({
    product_id:  pid,
    axis_values: still.axis_values,
  });
  check("findVariant: archived row excluded from lookup", missArchived === null);

  // unarchive round-trips
  var unarchived = await v.unarchiveVariant(target.id);
  check("unarchiveVariant: clears archived_at", unarchived.archived_at === null);
  var listRestored = await v.variantsForProduct(pid);
  check("variantsForProduct: unarchive restores to default list", listRestored.length === 4);

  // Missing id returns null on archive
  var bogus = "00000000-0000-7000-8000-000000000000";
  check("archiveVariant: missing id returns null", (await v.archiveVariant(bogus)) === null);
}

async function _archiveAxisOptionCascades() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  await v.defineAxis({ product_id: pid, axis_name: "color", options: ["red", "blue", "green"] });
  await v.defineAxis({ product_id: pid, axis_name: "size",  options: ["S", "M"] });
  await v.materializeMatrix(pid, { sku_prefix: "T", base_price_minor: 100 });

  var beforeLive = await v.variantsForProduct(pid);
  check("archiveAxisOption: 6 live variants before archive", beforeLive.length === 6);

  // Archive color=red — cascades to (red,S) and (red,M) variants
  var result = await v.archiveAxisOption({
    product_id:   pid,
    axis_name:    "color",
    option_value: "red",
  });
  check("archiveAxisOption: cascaded 2 variants",        result.cascaded_variant_ids.length === 2);
  check("archiveAxisOption: stamps archived_at on option", typeof result.archived_at === "number");

  var afterLive = await v.variantsForProduct(pid);
  check("archiveAxisOption: live list drops to 4",       afterLive.length === 4);
  check("archiveAxisOption: no live variant carries red", afterLive.every(function (r) { return r.axis_values.color !== "red"; }));

  // Archived rows still resolve via getVariant for historic order lines
  for (var i = 0; i < result.cascaded_variant_ids.length; i += 1) {
    var hit = await v.getVariant(result.cascaded_variant_ids[i]);
    check("archiveAxisOption: cascaded row resolves by id", hit !== null && hit.archived_at !== null);
  }

  // findVariant against an archived combination returns null
  var miss = await v.findVariant({
    product_id:  pid,
    axis_values: { color: "red", size: "S" },
  });
  check("archiveAxisOption: findVariant against archived combo returns null", miss === null);

  // Refusals
  await assert.rejects(v.archiveAxisOption({ product_id: pid, axis_name: "color",   option_value: "purple" }), /no option/);
  await assert.rejects(v.archiveAxisOption({ product_id: pid, axis_name: "missing", option_value: "red" }),    /no axis/);
}

async function _updateVariantAllowlist() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  await v.defineAxis({ product_id: pid, axis_name: "color", options: ["red"] });
  await v.defineAxis({ product_id: pid, axis_name: "size",  options: ["M"] });
  var mat = await v.materializeMatrix(pid, { sku_prefix: "T", base_price_minor: 100 });
  var variant = mat.inserted[0];

  var patched = await v.updateVariant(variant.id, {
    sku:             "t-custom-sku",
    price_minor:     2500,
    weight_grams:    180,
    image_url:       "https://cdn.example.com/img/red-m.jpg",
    inventory_count: 42,
  });
  check("updateVariant: sku patched",             patched.sku === "t-custom-sku");
  check("updateVariant: price_minor patched",     patched.price_minor === 2500);
  check("updateVariant: weight_grams patched",    patched.weight_grams === 180);
  check("updateVariant: image_url patched",       patched.image_url === "https://cdn.example.com/img/red-m.jpg");
  check("updateVariant: inventory_count patched", patched.inventory_count === 42);

  // archived: true flips archived_at to a timestamp
  var archivedRow = await v.updateVariant(variant.id, { archived: true });
  check("updateVariant: archived=true sets archived_at", archivedRow.archived_at !== null && typeof archivedRow.archived_at === "number");
  // archived: false clears it
  var liveRow = await v.updateVariant(variant.id, { archived: false });
  check("updateVariant: archived=false clears archived_at", liveRow.archived_at === null);

  // image_url allowlist: javascript: refused
  await assert.rejects(v.updateVariant(variant.id, { image_url: "javascript:alert(1)" }), /image_url/);
  // image_url allowlist: data: refused
  await assert.rejects(v.updateVariant(variant.id, { image_url: "data:image/png;base64,xxx" }), /image_url/);
  // image_url allowlist: /-rooted path accepted
  var pathPatch = await v.updateVariant(variant.id, { image_url: "/assets/img/red-m.jpg" });
  check("updateVariant: /-rooted path accepted", pathPatch.image_url === "/assets/img/red-m.jpg");

  // Unknown patch key refused
  await assert.rejects(v.updateVariant(variant.id, { product_id: pid }), /unknown patch key/);
  await assert.rejects(v.updateVariant(variant.id, { archived_at: 12345 }), /unknown patch key/);
  await assert.rejects(v.updateVariant(variant.id, { axis_values_json: "{}" }), /unknown patch key/);

  // Negative integers refused
  await assert.rejects(v.updateVariant(variant.id, { price_minor: -1 }), /price_minor/);
  await assert.rejects(v.updateVariant(variant.id, { inventory_count: -5 }), /inventory_count/);
  await assert.rejects(v.updateVariant(variant.id, { weight_grams: 1.5 }), /weight_grams/);

  // Empty patch refused
  await assert.rejects(v.updateVariant(variant.id, {}), /no updatable fields/);

  // Bad sku refused
  await assert.rejects(v.updateVariant(variant.id, { sku: "has spaces" }), /sku/);
}

async function _emptyMatrixAndProductMismatch() {
  var ctx = await _setup();
  var v = ctx.variants;
  var pid = ctx.product.id;

  // No axes yet — generate / materialize both refuse
  await assert.rejects(v.generateMatrix(pid), /no axes registered/);
  await assert.rejects(v.materializeMatrix(pid, { sku_prefix: "T", base_price_minor: 0 }), /no axes registered/);

  // Archive every option of one axis → generateMatrix sees an empty axis
  await v.defineAxis({ product_id: pid, axis_name: "color", options: ["red"] });
  await v.defineAxis({ product_id: pid, axis_name: "size",  options: ["S"] });
  await v.archiveAxisOption({ product_id: pid, axis_name: "color", option_value: "red" });
  await assert.rejects(v.generateMatrix(pid), /no live options/);

  // findVariant against missing product returns null (no row matches)
  var bogusProduct = "00000000-0000-7000-8000-000000000000";
  var noMatch = await v.findVariant({ product_id: bogusProduct, axis_values: { color: "red" } });
  check("findVariant: missing product returns null", noMatch === null);
}

async function run() {
  await _defineAxisHappyAndRefusals();
  await _generateMatrix2x3And2x3x2();
  await _materializeMatrixWithSkuPrefix();
  await _findVariantExactMatch();
  await _archiveVariantHidesFromDefaultList();
  await _archiveAxisOptionCascades();
  await _updateVariantAllowlist();
  await _emptyMatrixAndProductMismatch();
}

module.exports = { run: run };
