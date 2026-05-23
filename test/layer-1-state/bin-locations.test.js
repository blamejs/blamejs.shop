"use strict";
/**
 * bin-locations — per-SKU warehouse bin / aisle / shelf assignments,
 * bin condition flags, append-only bin-audit history, and the
 * pick-path sort used by pick-lists to walk a picker through the
 * floor in minimum-distance order.
 *
 * Layer 1 against in-memory node:sqlite with migration 0186 loaded.
 * The catalog + inventoryLocations dependencies are stubbed locally
 * so this test exercises the primitive in isolation (compositional
 * wiring is the smoke suite's concern).
 *
 * Coverage:
 *   - assignBin happy path persists every coordinate; re-assigning
 *     the same (sku, location, bin) triple updates coordinates in
 *     place; UNIQUE active-row constraint surfaces from a parallel
 *     bypass write
 *   - first active assignment for a (sku, location) becomes primary
 *     by default; subsequent assignments default secondary; an
 *     explicit is_primary: true demotes the previous primary
 *   - binForSku returns the primary when multiple bins hold the SKU
 *     at the same location; falls back to the sole-active row when
 *     no explicit primary exists
 *   - binsForSku returns every active assignment across every
 *     location ordered with the per-location primary first
 *   - skusInBin enumerates one bin's residents
 *   - searchBinsByAisle returns aisle-scoped rows in walk order
 *   - pickPathSort orders by (aisle ASC, shelf ASC, level ASC);
 *     SKUs without an assignment land last; stability across
 *     duplicates + tied coordinates holds
 *   - bulkAssign / bulkUnassign accept N rows; first malformed row
 *     refuses the whole batch
 *   - unassignBin soft-deletes the row and promotes a successor
 *     primary when the archived row was primary
 *   - recordBinAudit computes variance (missing / extra) and persists
 *     the audit row with deterministic JSON
 *   - binCondition upsert path; listBinsWithCondition filters across
 *     locations and inside a single location
 *   - factory refusals on bad inventoryLocations / catalog handles
 *   - inventoryLocations validation refuses an unregistered location;
 *     catalog validation refuses an unknown SKU
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var binLocations = require("../../lib/bin-locations");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0186_bin_locations.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var queryFn = async function (sql, params) {
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
  queryFn.__db = db;
  return queryFn;
}

// Stub inventoryLocations — returns `{ code }` for any code in the
// `known` set, null otherwise (so the primitive's _checkLocation
// refusal path is exercised on unknown codes).
function _invLocStub(known) {
  var set = Object.create(null);
  for (var i = 0; i < (known || []).length; i += 1) set[known[i]] = true;
  return {
    getLocation: async function (code) {
      return set[code] ? { code: code, active: 1 } : null;
    },
  };
}

// Stub catalog — returns `{ sku }` for any SKU in the `known` set,
// null otherwise.
function _catalogStub(known) {
  var set = Object.create(null);
  for (var i = 0; i < (known || []).length; i += 1) set[known[i]] = true;
  return {
    get: async function (sku) {
      return set[sku] ? { sku: sku } : null;
    },
  };
}

function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var svc = binLocations.create({
    query:              q,
    inventoryLocations: opts.inventoryLocations || null,
    catalog:            opts.catalog || null,
  });
  return { q: q, svc: svc };
}

async function _assignBinBasicAndPrimary() {
  var w = _wire();
  var row = await w.svc.assignBin({
    sku: "WIDGET-1", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01",
  });
  check("assignBin returns row",       row && row.sku === "WIDGET-1");
  check("assignBin aisle persisted",   row.aisle === "A");
  check("assignBin shelf persisted",   row.shelf === "01");
  check("assignBin level persisted",   row.level === "01");
  check("first assignment primary",    row.is_primary === true);
  check("assigned_at is positive int", typeof row.assigned_at === "number" && row.assigned_at > 0);
  check("archived_at null on create",  row.archived_at == null);

  // Second assignment for same (sku, location) defaults secondary
  var row2 = await w.svc.assignBin({
    sku: "WIDGET-1", location_code: "WH-EAST",
    bin_label: "B-02-03", aisle: "B", shelf: "02", level: "03",
  });
  check("second assignment secondary",  row2.is_primary === false);

  // binForSku returns the primary
  var primary = await w.svc.binForSku({ sku: "WIDGET-1", location_code: "WH-EAST" });
  check("binForSku returns primary",    primary.bin_label === "A-01-01");

  // Re-assign existing triple updates coordinates in place
  var updated = await w.svc.assignBin({
    sku: "WIDGET-1", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "05",
  });
  check("re-assign updates level",      updated.level === "05");
  // Still the primary
  check("re-assign still primary",      updated.is_primary === true);

  // Explicit is_primary: true demotes the previous primary
  var promoted = await w.svc.assignBin({
    sku: "WIDGET-1", location_code: "WH-EAST",
    bin_label: "B-02-03", aisle: "B", shelf: "02", level: "03",
    is_primary: true,
  });
  check("explicit primary promoted",    promoted.is_primary === true);
  var oldPrimary = await w.svc.binForSku({ sku: "WIDGET-1", location_code: "WH-EAST" });
  check("primary moved to B-02-03",     oldPrimary.bin_label === "B-02-03");

  // Refusals
  await assert.rejects(w.svc.assignBin(),                                                 /input object required/);
  await assert.rejects(w.svc.assignBin({}),                                               /sku/);
  await assert.rejects(w.svc.assignBin({ sku: "WIDGET-1" }),                              /location_code/);
  await assert.rejects(w.svc.assignBin({ sku: "WIDGET-1", location_code: "WH-EAST" }),    /bin_label/);
  await assert.rejects(w.svc.assignBin({ sku: "WIDGET-1", location_code: "WH-EAST",
    bin_label: "X", aisle: "A", shelf: "01" }),                                            /level/);
  await assert.rejects(w.svc.assignBin({ sku: "!!bad!!", location_code: "WH-EAST",
    bin_label: "X", aisle: "A", shelf: "01", level: "01" }),                               /sku/);
  await assert.rejects(w.svc.assignBin({ sku: "WIDGET-1", location_code: "!!bad!!",
    bin_label: "X", aisle: "A", shelf: "01", level: "01" }),                               /location_code/);
  await assert.rejects(w.svc.assignBin({ sku: "WIDGET-1", location_code: "WH-EAST",
    bin_label: "X", aisle: "A", shelf: "01", level: "01", is_primary: "yes" }),            /is_primary/);
}

async function _binForSkuAndBinsForSku() {
  var w = _wire();
  await w.svc.assignBin({ sku: "WIDGET-2", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01" });
  await w.svc.assignBin({ sku: "WIDGET-2", location_code: "WH-EAST",
    bin_label: "C-03-04", aisle: "C", shelf: "03", level: "04" });
  await w.svc.assignBin({ sku: "WIDGET-2", location_code: "STORE-LA",
    bin_label: "Z-99-01", aisle: "Z", shelf: "99", level: "01" });

  // binForSku at WH-EAST returns the primary (the first assignment)
  var primary = await w.svc.binForSku({ sku: "WIDGET-2", location_code: "WH-EAST" });
  check("binForSku WH-EAST primary",        primary.bin_label === "A-01-01");

  // binForSku at STORE-LA returns the sole row even though no
  // explicit primary was requested
  var laBin = await w.svc.binForSku({ sku: "WIDGET-2", location_code: "STORE-LA" });
  check("binForSku STORE-LA sole row",      laBin.bin_label === "Z-99-01");

  // binForSku at unknown location returns null
  var miss = await w.svc.binForSku({ sku: "WIDGET-2", location_code: "WH-WEST" });
  check("binForSku unknown location null",  miss === null);

  // binsForSku returns every active assignment, primary-first per
  // location
  var all = await w.svc.binsForSku("WIDGET-2");
  check("binsForSku total count",           all.length === 3);
  check("binsForSku per-loc primary first", all[0].location_code === "STORE-LA" &&
                                            all[1].location_code === "WH-EAST" &&
                                            all[1].is_primary    === true &&
                                            all[2].location_code === "WH-EAST" &&
                                            all[2].is_primary    === false);

  await assert.rejects(w.svc.binForSku(),                                                /input object required/);
  await assert.rejects(w.svc.binsForSku("!!bad!!"),                                       /sku/);
}

async function _skusInBinAndSearchByAisle() {
  var w = _wire();
  await w.svc.assignBin({ sku: "WIDGET-A", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01" });
  await w.svc.assignBin({ sku: "WIDGET-B", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01" });
  await w.svc.assignBin({ sku: "WIDGET-C", location_code: "WH-EAST",
    bin_label: "A-02-01", aisle: "A", shelf: "02", level: "01" });
  await w.svc.assignBin({ sku: "WIDGET-D", location_code: "WH-EAST",
    bin_label: "B-01-01", aisle: "B", shelf: "01", level: "01" });

  // skusInBin enumerates one bin's residents
  var residents = await w.svc.skusInBin({ location_code: "WH-EAST", bin_label: "A-01-01" });
  check("skusInBin two residents",     residents.length === 2);
  check("skusInBin sorted by sku",     residents[0].sku === "WIDGET-A" &&
                                       residents[1].sku === "WIDGET-B");

  // searchBinsByAisle returns aisle A only, sorted by shelf
  var aisleA = await w.svc.searchBinsByAisle({ location_code: "WH-EAST", aisle: "A" });
  check("searchBinsByAisle filter",    aisleA.length === 3);
  check("searchBinsByAisle order",     aisleA[0].shelf === "01" && aisleA[2].shelf === "02");

  // searchBinsByAisle respects limit
  var limited = await w.svc.searchBinsByAisle({ location_code: "WH-EAST", aisle: "A", limit: 2 });
  check("searchBinsByAisle limit",     limited.length === 2);

  await assert.rejects(w.svc.searchBinsByAisle(),                                          /input object required/);
  await assert.rejects(w.svc.searchBinsByAisle({ location_code: "WH-EAST",
    aisle: "A", limit: 99999 }),                                                            /limit/);
}

async function _pickPathSortOrdersByWalkPath() {
  var w = _wire();
  await w.svc.assignBin({ sku: "ALPHA", location_code: "WH-EAST",
    bin_label: "C-01-01", aisle: "C", shelf: "01", level: "01" });
  await w.svc.assignBin({ sku: "BRAVO", location_code: "WH-EAST",
    bin_label: "A-02-03", aisle: "A", shelf: "02", level: "03" });
  await w.svc.assignBin({ sku: "CHARLIE", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01" });
  await w.svc.assignBin({ sku: "DELTA", location_code: "WH-EAST",
    bin_label: "B-05-02", aisle: "B", shelf: "05", level: "02" });

  // Input out of any natural order — pickPathSort produces the walk
  // path (aisle ASC, shelf ASC, level ASC).
  var sorted = await w.svc.pickPathSort({
    location_code: "WH-EAST",
    skus: ["ALPHA", "BRAVO", "CHARLIE", "DELTA"],
  });
  check("pickPathSort walk order",   sorted.join(",") === "CHARLIE,BRAVO,DELTA,ALPHA");

  // SKU without an assignment lands at the END
  var withUnknown = await w.svc.pickPathSort({
    location_code: "WH-EAST",
    skus: ["DELTA", "UNKNOWN-SKU", "CHARLIE"],
  });
  check("unassigned SKU at end",     withUnknown[withUnknown.length - 1] === "UNKNOWN-SKU");
  check("known SKUs walk-ordered",   withUnknown[0] === "CHARLIE" && withUnknown[1] === "DELTA");

  // Empty input returns []
  var empty = await w.svc.pickPathSort({ location_code: "WH-EAST", skus: [] });
  check("pickPathSort empty input",  Array.isArray(empty) && empty.length === 0);

  // pickPathSort uses the PRIMARY assignment when a SKU lives in
  // multiple bins
  await w.svc.assignBin({ sku: "ALPHA", location_code: "WH-EAST",
    bin_label: "A-00-00", aisle: "A", shelf: "00", level: "00", is_primary: true });
  var primaryUsed = await w.svc.pickPathSort({
    location_code: "WH-EAST", skus: ["ALPHA", "CHARLIE"],
  });
  // ALPHA's primary is now at (A, 00, 00) which sorts before CHARLIE
  check("primary picked for path",   primaryUsed.join(",") === "ALPHA,CHARLIE");

  await assert.rejects(w.svc.pickPathSort(),                                               /input object required/);
  await assert.rejects(w.svc.pickPathSort({ location_code: "WH-EAST" }),                   /skus/);
  await assert.rejects(w.svc.pickPathSort({ location_code: "WH-EAST",
    skus: ["!!bad!!"] }),                                                                   /sku/);
}

async function _unassignBinPromotesSuccessor() {
  var w = _wire();
  await w.svc.assignBin({ sku: "PROMO", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01" });
  await w.svc.assignBin({ sku: "PROMO", location_code: "WH-EAST",
    bin_label: "A-02-01", aisle: "A", shelf: "02", level: "01" });
  await w.svc.assignBin({ sku: "PROMO", location_code: "WH-EAST",
    bin_label: "A-03-01", aisle: "A", shelf: "03", level: "01" });

  var beforePrimary = await w.svc.binForSku({ sku: "PROMO", location_code: "WH-EAST" });
  check("before unassign primary A-01-01", beforePrimary.bin_label === "A-01-01");

  // Archive the primary
  var archived = await w.svc.unassignBin({
    sku: "PROMO", location_code: "WH-EAST", bin_label: "A-01-01",
  });
  check("unassignBin returns sku/loc/bin",  archived.sku === "PROMO" &&
                                            archived.location_code === "WH-EAST" &&
                                            archived.bin_label === "A-01-01");
  check("archived_at stamped",              typeof archived.archived_at === "number" &&
                                            archived.archived_at > 0);

  // Successor promoted
  var afterPrimary = await w.svc.binForSku({ sku: "PROMO", location_code: "WH-EAST" });
  check("successor promoted to primary",    afterPrimary.bin_label === "A-02-01" &&
                                            afterPrimary.is_primary === true);

  // Active assignment list excludes the archived row
  var all = await w.svc.binsForSku("PROMO");
  check("binsForSku excludes archived",     all.length === 2);

  // unassignBin on an already-archived triple refuses
  await assert.rejects(w.svc.unassignBin({
    sku: "PROMO", location_code: "WH-EAST", bin_label: "A-01-01",
  }), /no active assignment/);

  // After re-assigning the archived triple, it lives again (the
  // partial UNIQUE index allows the re-insert because the prior row's
  // archived_at is non-NULL).
  var reborn = await w.svc.assignBin({
    sku: "PROMO", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01",
  });
  check("re-assign after archive lives",    reborn.archived_at == null);

  await assert.rejects(w.svc.unassignBin(),                                                /input object required/);
}

async function _bulkAssignAndUnassign() {
  var w = _wire();
  var rows = [
    { sku: "BULK-1", location_code: "WH-EAST",
      bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01" },
    { sku: "BULK-2", location_code: "WH-EAST",
      bin_label: "A-01-02", aisle: "A", shelf: "01", level: "02" },
    { sku: "BULK-3", location_code: "WH-EAST",
      bin_label: "A-01-03", aisle: "A", shelf: "01", level: "03" },
  ];
  var assigned = await w.svc.bulkAssign(rows);
  check("bulkAssign returns N rows",  assigned.length === 3);
  check("bulkAssign each is primary", assigned.every(function (r) { return r.is_primary === true; }));

  // Each row landed individually
  var allBulk1 = await w.svc.binsForSku("BULK-1");
  check("bulkAssign per-row landed",  allBulk1.length === 1 && allBulk1[0].bin_label === "A-01-01");

  // First malformed row refuses the whole batch
  await assert.rejects(w.svc.bulkAssign([
    { sku: "BULK-OK", location_code: "WH-EAST",
      bin_label: "A-01-04", aisle: "A", shelf: "01", level: "04" },
    { sku: "!!bad!!", location_code: "WH-EAST",
      bin_label: "A-01-05", aisle: "A", shelf: "01", level: "05" },
  ]), /sku/);

  // bulkUnassign by triple
  var unassigned = await w.svc.bulkUnassign([
    { sku: "BULK-1", location_code: "WH-EAST", bin_label: "A-01-01" },
    { sku: "BULK-2", location_code: "WH-EAST", bin_label: "A-01-02" },
  ]);
  check("bulkUnassign returns N rows", unassigned.length === 2);
  check("bulkUnassign archived stamp", typeof unassigned[0].archived_at === "number");

  // bulkAssign accepts empty input
  var emptyAssign = await w.svc.bulkAssign([]);
  check("bulkAssign empty input",     Array.isArray(emptyAssign) && emptyAssign.length === 0);

  await assert.rejects(w.svc.bulkAssign("not-an-array"),                                   /rows must be an array/);
  await assert.rejects(w.svc.bulkUnassign("not-an-array"),                                 /rows must be an array/);
}

async function _recordBinAuditVariance() {
  var w = _wire();
  await w.svc.assignBin({ sku: "AUD-1", location_code: "WH-EAST",
    bin_label: "Z-01-01", aisle: "Z", shelf: "01", level: "01" });
  await w.svc.assignBin({ sku: "AUD-2", location_code: "WH-EAST",
    bin_label: "Z-01-01", aisle: "Z", shelf: "01", level: "01" });

  // Auditor found AUD-1 + a surprise AUD-9; AUD-2 was missing.
  var audit = await w.svc.recordBinAudit({
    location_code: "WH-EAST", bin_label: "Z-01-01",
    audited_by:    "alice@warehouse",
    expected_skus: ["AUD-1", "AUD-2"],
    actual_skus:   ["AUD-1", "AUD-9"],
  });
  check("audit row has id",                typeof audit.id === "string" && audit.id.length > 0);
  check("audit row audited_by persists",   audit.audited_by === "alice@warehouse");
  check("audit row variance.missing",      audit.variance.missing.length === 1 &&
                                           audit.variance.missing[0] === "AUD-2");
  check("audit row variance.extra",        audit.variance.extra.length === 1 &&
                                           audit.variance.extra[0] === "AUD-9");
  check("audit row expected sorted",       audit.expected_skus.join(",") === "AUD-1,AUD-2");
  check("audit row actual sorted",         audit.actual_skus.join(",") === "AUD-1,AUD-9");
  check("audit occurred_at stamped",       typeof audit.occurred_at === "number" &&
                                           audit.occurred_at > 0);

  // No-variance audit produces empty missing + extra
  var clean = await w.svc.recordBinAudit({
    location_code: "WH-EAST", bin_label: "Z-01-01",
    audited_by:    "bob@warehouse",
    expected_skus: ["AUD-1", "AUD-2"],
    actual_skus:   ["AUD-2", "AUD-1"],   // out-of-order on purpose
  });
  check("clean audit no missing",          clean.variance.missing.length === 0);
  check("clean audit no extra",            clean.variance.extra.length === 0);

  // Operator-supplied occurred_at honoured
  var explicit = await w.svc.recordBinAudit({
    location_code: "WH-EAST", bin_label: "Z-01-01",
    audited_by:    "carol@warehouse",
    expected_skus: [],
    actual_skus:   [],
    occurred_at:   1700000000000,
  });
  check("explicit occurred_at honoured",   Number(explicit.occurred_at) === 1700000000000);

  await assert.rejects(w.svc.recordBinAudit(),                                             /input object required/);
  await assert.rejects(w.svc.recordBinAudit({ location_code: "WH-EAST" }),                  /bin_label/);
  await assert.rejects(w.svc.recordBinAudit({
    location_code: "WH-EAST", bin_label: "Z-01-01",
    audited_by:    "!!bad whitespace!!",
    expected_skus: [], actual_skus: [],
  }), /audited_by/);
  await assert.rejects(w.svc.recordBinAudit({
    location_code: "WH-EAST", bin_label: "Z-01-01",
    audited_by:    "alice", expected_skus: ["!!bad!!"], actual_skus: [],
  }), /expected_skus/);
  await assert.rejects(w.svc.recordBinAudit({
    location_code: "WH-EAST", bin_label: "Z-01-01",
    audited_by:    "alice", expected_skus: [], actual_skus: [], occurred_at: -1,
  }), /occurred_at/);
}

async function _binConditionAndListing() {
  var w = _wire();
  var cond1 = await w.svc.binCondition({
    location_code: "WH-EAST", bin_label: "A-01-01", condition: "clean",
  });
  check("binCondition row created",      cond1.condition === "clean");
  check("binCondition updated_at",       typeof cond1.updated_at === "number");

  // Upsert path
  var cond2 = await w.svc.binCondition({
    location_code: "WH-EAST", bin_label: "A-01-01", condition: "damaged",
  });
  check("binCondition upsert",           cond2.condition === "damaged");

  await w.svc.binCondition({
    location_code: "WH-EAST", bin_label: "A-02-01", condition: "needs_audit",
  });
  await w.svc.binCondition({
    location_code: "STORE-LA", bin_label: "X-09-09", condition: "damaged",
  });

  // listBinsWithCondition across all locations
  var damaged = await w.svc.listBinsWithCondition({ condition: "damaged" });
  check("listBinsWithCondition all locs", damaged.length === 2);
  check("listBinsWithCondition order",    damaged[0].location_code === "STORE-LA" &&
                                          damaged[1].location_code === "WH-EAST");

  // Filtered by location_code
  var east = await w.svc.listBinsWithCondition({
    condition: "damaged", location_code: "WH-EAST",
  });
  check("listBinsWithCondition by loc",   east.length === 1 &&
                                          east[0].bin_label === "A-01-01");

  // Empty result for a condition no bin holds
  var unusable = await w.svc.listBinsWithCondition({ condition: "unusable" });
  check("listBinsWithCondition empty",    unusable.length === 0);

  await assert.rejects(w.svc.binCondition(),                                               /input object required/);
  await assert.rejects(w.svc.binCondition({
    location_code: "WH-EAST", bin_label: "A-01-01", condition: "bogus",
  }), /condition/);
  await assert.rejects(w.svc.listBinsWithCondition(),                                       /input object required/);
  await assert.rejects(w.svc.listBinsWithCondition({ condition: "bogus" }),                /condition/);
}

async function _invLocationsAndCatalogGate() {
  // inventoryLocations refuses an unregistered location
  var invStub = _invLocStub(["WH-EAST"]);
  var wInv = _wire({ inventoryLocations: invStub });
  await assert.rejects(wInv.svc.assignBin({
    sku: "X-1", location_code: "WH-WEST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01",
  }), /not registered/);
  // Known location passes
  var ok = await wInv.svc.assignBin({
    sku: "X-1", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01",
  });
  check("inv-validated assign lands",    ok.sku === "X-1");
  // binCondition also gated
  await assert.rejects(wInv.svc.binCondition({
    location_code: "WH-WEST", bin_label: "X", condition: "clean",
  }), /not registered/);
  // recordBinAudit also gated
  await assert.rejects(wInv.svc.recordBinAudit({
    location_code: "WH-WEST", bin_label: "X", audited_by: "alice",
    expected_skus: [], actual_skus: [],
  }), /not registered/);

  // catalog refuses an unknown SKU
  var catStub = _catalogStub(["KNOWN-SKU"]);
  var wCat = _wire({ catalog: catStub });
  await assert.rejects(wCat.svc.assignBin({
    sku: "UNKNOWN-SKU", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01",
  }), /not registered/);
  var okSku = await wCat.svc.assignBin({
    sku: "KNOWN-SKU", location_code: "WH-EAST",
    bin_label: "A-01-01", aisle: "A", shelf: "01", level: "01",
  });
  check("catalog-validated assign lands", okSku.sku === "KNOWN-SKU");
}

async function _factoryRefusals() {
  // inventoryLocations without getLocation refused
  assert.throws(function () {
    binLocations.create({ query: function () {}, inventoryLocations: {} });
  }, /getLocation/);

  // catalog without get refused
  assert.throws(function () {
    binLocations.create({ query: function () {}, catalog: {} });
  }, /get/);
}

async function run() {
  await _assignBinBasicAndPrimary();
  await _binForSkuAndBinsForSku();
  await _skusInBinAndSearchByAisle();
  await _pickPathSortOrdersByWalkPath();
  await _unassignBinPromotesSuccessor();
  await _bulkAssignAndUnassign();
  await _recordBinAuditVariance();
  await _binConditionAndListing();
  await _invLocationsAndCatalogGate();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("bin-locations: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
