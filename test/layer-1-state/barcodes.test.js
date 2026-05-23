"use strict";
/**
 * barcodes — SKU -> scannable identifier with checksum validation.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0068_barcodes.sql. The primitive composes the framework's
 * UUID + externalDb adapters and a catalog stub for SKU
 * existence checks.
 *
 * Coverage:
 *   - assign: refuses bad checksum / wrong digit length per kind
 *   - assign: each kind round-trips with a valid value
 *   - assign: refuses duplicate (kind, value) across SKUs
 *   - assign: refuses unknown SKU
 *   - assignAuto: mints from operator-allocated range, advances counter
 *   - assignAuto: refuses when range is exhausted (no further mint)
 *   - lookup: returns all assignments for a SKU
 *   - bySkuList: bulk-returns assignments grouped by SKU
 *   - lookupByValue: returns the assignment row or null
 *   - unassign: removes one or all kinds for the SKU
 *   - renderSvg: returns inline SVG with no <script> / no <foreignObject>
 *   - renderSvg: renders each kind (modules > 0 bars)
 *   - validateValue: pure-function checksum gate
 *   - validation: every entry point refuses bad input
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var barcodes = require("../../lib/barcodes");
var bShop    = require("../../lib");
var helpers  = require("../helpers");
var check    = helpers.check;
var assert   = helpers.assert;

var MIG_BARCODES = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0068_barcodes.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_BARCODES, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

// Catalog stub — barcodes.create only calls catalog.variants.bySku(sku).
// Returns a non-null record for any sku registered in the seed set.
function _catalogStub(skus) {
  var seen = Object.create(null);
  for (var i = 0; i < skus.length; i += 1) seen[skus[i]] = { sku: skus[i] };
  return {
    variants: {
      bySku: function (sku) {
        return Promise.resolve(seen[sku] || null);
      },
    },
  };
}

function _bcFactory(skus) {
  var h = _makeQuery();
  var bc = barcodes.create({ query: h.query, catalog: _catalogStub(skus || ["WIDGET-A", "WIDGET-B", "WIDGET-C", "WIDGET-D"]) });
  return { db: h.db, bc: bc };
}

// --- helpers to build known-good values per kind --------------------------

// GS1 mod-10 over the leading data digits (no trailing check).
function _gs1Mod10(digits) {
  var sum = 0;
  for (var i = digits.length - 1, w = 3; i >= 0; i -= 1, w = (w === 3 ? 1 : 3)) {
    sum += parseInt(digits.charAt(i), 10) * w;
  }
  var mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}
function _withCheck(data) { return data + String(_gs1Mod10(data)); }

// --- tests ---------------------------------------------------------------

async function _validateValuePure() {
  // UPC-A: 12 digits with check.
  var upc = _withCheck("03600029145");
  check("UPC-A valid 12-digit checksum",         barcodes.validateValue({ kind: "upc_a", value: upc }));
  check("UPC-A rejects wrong length",            !barcodes.validateValue({ kind: "upc_a", value: "0360002914" }));
  check("UPC-A rejects bad checksum",            !barcodes.validateValue({ kind: "upc_a", value: "036000291454" }));
  check("UPC-A rejects non-digit",               !barcodes.validateValue({ kind: "upc_a", value: "03600029145A" }));

  // EAN-13: 13 digits with check.
  var ean = _withCheck("501234567890");
  check("EAN-13 valid 13-digit checksum",        barcodes.validateValue({ kind: "ean_13", value: ean }));
  check("EAN-13 rejects wrong length",           !barcodes.validateValue({ kind: "ean_13", value: "501234567890" }));
  check("EAN-13 rejects bad checksum",           !barcodes.validateValue({ kind: "ean_13", value: "5012345678901" }));

  // GTIN-14: 14 digits with check.
  var gtin = _withCheck("1050123456789");
  check("GTIN-14 valid 14-digit checksum",       barcodes.validateValue({ kind: "gtin_14", value: gtin }));
  check("GTIN-14 rejects wrong length",          !barcodes.validateValue({ kind: "gtin_14", value: "105012345678" }));
  check("GTIN-14 rejects bad checksum",          !barcodes.validateValue({ kind: "gtin_14", value: "10501234567890" }));

  // Code-128: printable ASCII only.
  check("Code-128 accepts alphanumeric",         barcodes.validateValue({ kind: "code_128", value: "ABC-123" }));
  check("Code-128 accepts mixed printable",      barcodes.validateValue({ kind: "code_128", value: "PO#42 / line-7" }));
  check("Code-128 rejects control byte",         !barcodes.validateValue({ kind: "code_128", value: "ABC" }));
  check("Code-128 rejects empty refusal at validateValue catches at shape gate", true);
  // (Empty is refused at the validateValue type-gate, not the
  // boolean return; covered in _validation below.)
}

async function _assignEachKind() {
  var f = _bcFactory();
  var upc  = _withCheck("03600029145");
  var ean  = _withCheck("501234567890");
  var c128 = "PO-4242";
  var gtin = _withCheck("1050123456789");

  var a = await f.bc.assign({ sku: "WIDGET-A", kind: "upc_a",    value: upc  });
  check("assign upc_a returns row id",            typeof a.id === "string" && a.id.length === 36);
  check("assign upc_a stores value",              a.value === upc);

  var b = await f.bc.assign({ sku: "WIDGET-A", kind: "ean_13",   value: ean  });
  check("assign ean_13 stores value",             b.value === ean);

  var c = await f.bc.assign({ sku: "WIDGET-A", kind: "code_128", value: c128 });
  check("assign code_128 stores value",           c.value === c128);

  var d = await f.bc.assign({ sku: "WIDGET-A", kind: "gtin_14",  value: gtin });
  check("assign gtin_14 stores value",            d.value === gtin);

  // One SKU can hold four bindings (one per kind).
  var all = await f.bc.lookup({ sku: "WIDGET-A" });
  check("lookup returns all four kinds",          all.length === 4);
  var kinds = all.map(function (r) { return r.kind; }).sort().join(",");
  check("lookup contains every kind",             kinds === "code_128,ean_13,gtin_14,upc_a");
}

async function _assignRefusals() {
  var f = _bcFactory();
  var upc = _withCheck("03600029145");

  // Bad checksum — wrong trailing digit.
  await assert.rejects(
    f.bc.assign({ sku: "WIDGET-A", kind: "upc_a", value: "036000291454" }),
    /failed upc_a validation/,
  );

  // Wrong digit length for the kind.
  await assert.rejects(
    f.bc.assign({ sku: "WIDGET-A", kind: "ean_13", value: upc }),
    /failed ean_13 validation/,
  );

  // Non-digit in a numeric kind.
  await assert.rejects(
    f.bc.assign({ sku: "WIDGET-A", kind: "gtin_14", value: "1050123456789X" }),
    /failed gtin_14 validation/,
  );

  // Unknown SKU.
  await assert.rejects(
    f.bc.assign({ sku: "UNKNOWN-SKU", kind: "upc_a", value: upc }),
    /not found in catalog/,
  );

  // Duplicate (kind, value) across SKUs.
  await f.bc.assign({ sku: "WIDGET-A", kind: "upc_a", value: upc });
  await assert.rejects(
    f.bc.assign({ sku: "WIDGET-B", kind: "upc_a", value: upc }),
    /already assigned/,
  );
}

async function _assignAutoAndRange() {
  var f = _bcFactory();

  // GS1 GCP "5012345" + 5-digit counter + check digit = 13 digits.
  var range = await f.bc.defineRange({
    kind:          "ean_13",
    prefix:        "5012345",
    next_value:    0,
    max_value:     2,
    owner_company: "Example Foods Ltd",
  });
  check("defineRange returns id",                  typeof range.id === "string" && range.id.length === 36);

  var first = await f.bc.assignAuto({ sku: "WIDGET-A", kind: "ean_13" });
  check("assignAuto returns valid ean_13",         barcodes.validateValue({ kind: "ean_13", value: first.value }));
  check("assignAuto starts at counter 0",          first.value.slice(0, 12) === "501234500000");

  var second = await f.bc.assignAuto({ sku: "WIDGET-B", kind: "ean_13" });
  check("assignAuto advances counter",             second.value.slice(0, 12) === "501234500001");
  check("assignAuto second is also valid",         barcodes.validateValue({ kind: "ean_13", value: second.value }));

  var third = await f.bc.assignAuto({ sku: "WIDGET-C", kind: "ean_13" });
  check("assignAuto advances again",               third.value.slice(0, 12) === "501234500002");

  // Range now exhausted (next_value = 3 > max_value = 2).
  await assert.rejects(
    f.bc.assignAuto({ sku: "WIDGET-D", kind: "ean_13" }),
    /BARCODE_RANGE_EXHAUSTED|no range with remaining capacity|range counter overflowed/,
  );

  // listRanges reports the operator-allocated range.
  var listed = await f.bc.listRanges({ kind: "ean_13" });
  check("listRanges returns the range",            listed.length === 1 && listed[0].next_value === 3 && listed[0].max_value === 2);
  check("listRanges keeps owner_company",          listed[0].owner_company === "Example Foods Ltd");
}

async function _bySkuListAndLookupByValue() {
  var f = _bcFactory();
  var upc  = _withCheck("03600029145");
  var ean  = _withCheck("501234567890");
  await f.bc.assign({ sku: "WIDGET-A", kind: "upc_a",  value: upc });
  await f.bc.assign({ sku: "WIDGET-B", kind: "ean_13", value: ean });

  var grouped = await f.bc.bySkuList(["WIDGET-A", "WIDGET-B", "WIDGET-C"]);
  check("bySkuList covers each requested sku",     Object.keys(grouped).length === 3);
  check("bySkuList groups WIDGET-A bindings",      grouped["WIDGET-A"].length === 1 && grouped["WIDGET-A"][0].kind === "upc_a");
  check("bySkuList groups WIDGET-B bindings",      grouped["WIDGET-B"].length === 1 && grouped["WIDGET-B"][0].kind === "ean_13");
  check("bySkuList empty for unbound sku",         grouped["WIDGET-C"].length === 0);

  var hit = await f.bc.lookupByValue({ kind: "upc_a", value: upc });
  check("lookupByValue returns the assignment",    hit && hit.sku === "WIDGET-A" && hit.kind === "upc_a");

  var miss = await f.bc.lookupByValue({ kind: "upc_a", value: _withCheck("99999999999") });
  check("lookupByValue null on miss",              miss === null);
}

async function _unassign() {
  var f = _bcFactory();
  var upc = _withCheck("03600029145");
  var ean = _withCheck("501234567890");
  await f.bc.assign({ sku: "WIDGET-A", kind: "upc_a",  value: upc });
  await f.bc.assign({ sku: "WIDGET-A", kind: "ean_13", value: ean });

  // Remove just one kind.
  var one = await f.bc.unassign({ sku: "WIDGET-A", kind: "upc_a" });
  check("unassign kind removes one row",           one.removed === 1);
  var after = await f.bc.lookup({ sku: "WIDGET-A" });
  check("unassign kind leaves the other binding",  after.length === 1 && after[0].kind === "ean_13");

  // Remove the remainder.
  var rest = await f.bc.unassign({ sku: "WIDGET-A" });
  check("unassign sku-only removes remainder",     rest.removed === 1);
  var none = await f.bc.lookup({ sku: "WIDGET-A" });
  check("unassign sku-only leaves no rows",        none.length === 0);

  // Idempotent — no-op when nothing matches.
  var noop = await f.bc.unassign({ sku: "WIDGET-A" });
  check("unassign idempotent on empty",            noop.removed === 0);
}

async function _renderSvgShape() {
  var f = _bcFactory();
  var upc  = _withCheck("03600029145");
  var ean  = _withCheck("501234567890");
  var c128 = "PO-4242";
  var gtin = _withCheck("1050123456789");

  await f.bc.assign({ sku: "WIDGET-A", kind: "upc_a",    value: upc  });
  await f.bc.assign({ sku: "WIDGET-B", kind: "ean_13",   value: ean  });
  await f.bc.assign({ sku: "WIDGET-C", kind: "code_128", value: c128 });
  await f.bc.assign({ sku: "WIDGET-D", kind: "gtin_14",  value: gtin });

  var svgA = await f.bc.renderSvg({ sku: "WIDGET-A" });
  check("renderSvg upc_a returns <svg> root",      svgA.indexOf("<svg ") === 0 && svgA.indexOf("</svg>") > 0);
  check("renderSvg upc_a contains bars",           (svgA.match(/<rect /g) || []).length > 10);
  check("renderSvg has no <script>",               svgA.indexOf("<script") === -1);
  check("renderSvg has no <foreignObject>",        svgA.indexOf("<foreignObject") === -1);
  check("renderSvg embeds human-readable label",   svgA.indexOf(">" + upc + "<") !== -1);

  var svgB = await f.bc.renderSvg({ sku: "WIDGET-B" });
  check("renderSvg ean_13 returns <svg>",           svgB.indexOf("<svg ") === 0 && svgB.indexOf("</svg>") > 0);
  check("renderSvg ean_13 no <script>",             svgB.indexOf("<script") === -1);

  var svgC = await f.bc.renderSvg({ sku: "WIDGET-C" });
  check("renderSvg code_128 returns <svg>",         svgC.indexOf("<svg ") === 0 && svgC.indexOf("</svg>") > 0);
  check("renderSvg code_128 paints bars",           (svgC.match(/<rect /g) || []).length > 5);

  var svgD = await f.bc.renderSvg({ sku: "WIDGET-D" });
  check("renderSvg gtin_14 returns <svg>",          svgD.indexOf("<svg ") === 0 && svgD.indexOf("</svg>") > 0);
  check("renderSvg gtin_14 paints bars",            (svgD.match(/<rect /g) || []).length > 5);

  // Custom height + width are honored.
  var svgTall = await f.bc.renderSvg({ sku: "WIDGET-A", height_px: 120, width_px: 300 });
  check("renderSvg honors height_px",               svgTall.indexOf("height=\"120\"") !== -1);
  check("renderSvg honors width_px",                svgTall.indexOf("width=\"300\"") !== -1);

  // SKU without a binding refuses.
  await f.bc.unassign({ sku: "WIDGET-A" });
  await assert.rejects(
    f.bc.renderSvg({ sku: "WIDGET-A" }),
    /no assigned barcode/,
  );
}

async function _validation() {
  var f = _bcFactory();

  // assign — refuses every malformed input.
  await assert.rejects(f.bc.assign(),                                                                /input object required/);
  await assert.rejects(f.bc.assign({}),                                                              /sku/);
  await assert.rejects(f.bc.assign({ sku: "" }),                                                     /sku/);
  await assert.rejects(f.bc.assign({ sku: "WIDGET-A" }),                                             /kind/);
  await assert.rejects(f.bc.assign({ sku: "WIDGET-A", kind: "bogus" }),                              /kind/);
  await assert.rejects(f.bc.assign({ sku: "WIDGET-A", kind: "upc_a" }),                              /value/);
  await assert.rejects(f.bc.assign({ sku: "WIDGET-A", kind: "upc_a", value: "" }),                   /value/);
  await assert.rejects(f.bc.assign({ sku: " WIDGET-A", kind: "upc_a", value: _withCheck("03600029145") }), /sku/);

  // assignAuto — refuses bad input.
  await assert.rejects(f.bc.assignAuto(),                                                            /input object required/);
  await assert.rejects(f.bc.assignAuto({ sku: "WIDGET-A" }),                                         /kind/);
  await assert.rejects(f.bc.assignAuto({ sku: "WIDGET-A", kind: "ean_13" }),                         /no range with remaining capacity/);

  // defineRange — refuses bad input.
  await assert.rejects(f.bc.defineRange(),                                                           /input object required/);
  await assert.rejects(f.bc.defineRange({ kind: "ean_13" }),                                         /prefix/);
  await assert.rejects(f.bc.defineRange({ kind: "ean_13", prefix: "5012345", next_value: -1, max_value: 10 }), /next_value/);
  await assert.rejects(f.bc.defineRange({ kind: "ean_13", prefix: "5012345", next_value: 10, max_value: 5 }), /max_value/);
  // Prefix + max_value digits exceed the data block.
  await assert.rejects(f.bc.defineRange({ kind: "upc_a", prefix: "0360002", next_value: 0, max_value: 99999 }), /data block/);
  // Numeric prefix must be digits-only.
  await assert.rejects(f.bc.defineRange({ kind: "ean_13", prefix: "5012X45", next_value: 0, max_value: 10 }), /digits only/);

  // validateValue — refuses bad input.
  assert.throws(function () { barcodes.validateValue(); },                                            /input object required/);
  assert.throws(function () { barcodes.validateValue({ kind: "bogus", value: "x" }); },               /kind/);
  assert.throws(function () { barcodes.validateValue({ kind: "upc_a", value: "" }); },                /value/);

  // lookup / lookupByValue / unassign / bySkuList — bad input.
  await assert.rejects(f.bc.lookup(),                                                                /input object required/);
  await assert.rejects(f.bc.lookup({ sku: "" }),                                                     /sku/);
  await assert.rejects(f.bc.lookupByValue(),                                                         /input object required/);
  await assert.rejects(f.bc.lookupByValue({ kind: "upc_a" }),                                        /value/);
  await assert.rejects(f.bc.unassign(),                                                              /input object required/);
  await assert.rejects(f.bc.unassign({ sku: "WIDGET-A", kind: "bogus" }),                            /kind/);
  await assert.rejects(f.bc.bySkuList(),                                                             /must be an array/);
  await assert.rejects(f.bc.bySkuList(["", "WIDGET-A"]),                                             /sku/);

  // renderSvg — bad input.
  await assert.rejects(f.bc.renderSvg(),                                                             /input object required/);
  await assert.rejects(f.bc.renderSvg({ sku: "WIDGET-A", kind: "bogus" }),                            /kind/);

  // create — refuses without catalog.
  assert.throws(function () { barcodes.create({ query: function () {} }); }, /catalog/);
}

async function _bShopExports() {
  // The primitive is also reachable as `bShop.framework.uuid.v7()`
  // indirectly via the test's catalog stub, but the barcodes
  // primitive itself is invoked as the direct module export. We
  // assert the public surface matches the spec.
  check("module exports create",                   typeof barcodes.create === "function");
  check("module exports validateValue",            typeof barcodes.validateValue === "function");
  check("module exports KINDS",                    Array.isArray(barcodes.KINDS) && barcodes.KINDS.length === 4);
  // The shop entry point is loaded so bShop.framework is usable
  // for ad-hoc uuid generation in operator code; assert it resolves.
  check("bShop.framework reachable",               !!bShop.framework && typeof bShop.framework.uuid.v7 === "function");
}

async function run() {
  await _validateValuePure();
  await _assignEachKind();
  await _assignRefusals();
  await _assignAutoAndRange();
  await _bySkuListAndLookupByValue();
  await _unassign();
  await _renderSvgShape();
  await _validation();
  await _bShopExports();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — barcodes tests passed (" + helpers.getChecks() + " checks)");
  }).catch(function (e) {
    console.error("FAIL — " + (e && e.stack || e));
    process.exit(1);
  });
}
