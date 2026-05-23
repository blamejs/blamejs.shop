"use strict";
/**
 * cycle-counting — scheduled physical inventory audits.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0034
 * (inventory locations + stock + adjustments) + migration 0108
 * (cycle_counts + cycle_count_lines). The inventoryLocations
 * primitive is wired live so finalizeCount({ apply_adjustments: true })
 * exercises the real adjustStock path; the catalog is a stub that
 * exposes the three reads the primitive depends on
 * (inventory.get / skusForAbcClass / allActiveSkus + the optional
 * unitValueMinor).
 *
 * Coverage:
 *   - defineCount happy paths: rotating + abc + full kinds; the
 *     header lands at status='scheduled' with no lines yet
 *   - defineCount refusals: missing input, bad slug/kind, scope
 *     mismatch with kind (rotating without skus, abc without
 *     abc_class, full without all_active=true), duplicate slug
 *   - worksheetFor materializes the SKU list with expected
 *     quantities — global path (no location_code) reads
 *     catalog.inventory.get; per-location path reads
 *     inventoryLocations.stockForSku; idempotent on second call
 *   - worksheetFor transitions scheduled -> in_progress; refuses on
 *     finalized/cancelled counts
 *   - recordCount overwrites the prior actual_quantity (recount) and
 *     stamps counted_by + counted_at; refuses SKUs not on the
 *     worksheet
 *   - finalizeCount with apply_adjustments writes per-shelf
 *     adjustments through inventoryLocations.adjustStock — the
 *     inventory_adjustments audit log captures the cycle-count slug
 *   - finalizeCount aggregates variance_count + variance_value_minor
 *     onto the header; NULL actual_quantity treated as 0 (every
 *     expected unit a discrepancy)
 *   - discrepanciesFor returns only non-zero variance lines after
 *     finalize; null on unknown slug
 *   - cancelCount with reason transitions to cancelled; refuses
 *     finalized counts
 *   - listCounts filters by kind + date range
 *   - historyForSku paginates across counts that touched the SKU
 *   - factory refusals: missing catalog; non-object inventoryLocations
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// Require the modules directly so the test stays independent of
// `lib/index.js` export ordering (the operator wires the primitive
// into the package surface manually after the patch lands).
var cycleCounting      = require("../../lib/cycle-counting");
var inventoryLocations = require("../../lib/inventory-locations");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0034_inventory_locations.sql",
  "0108_cycle_counting.sql",
].map(function (f) {
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

// Catalog stub: a single inventory + ABC + active SKU registry the
// tests seed up front. The shape mirrors the contract the primitive
// requires — inventory.get(sku) returns null on miss, an object with
// stock_on_hand on hit; skusForAbcClass + allActiveSkus return arrays;
// unitValueMinor returns the per-SKU value in minor units (cents).
function _makeCatalog(seeds) {
  seeds = seeds || {};
  var inv    = seeds.inventory       || {};
  var byAbc  = seeds.byAbc           || {};
  var active = seeds.allActiveSkus   || [];
  var values = seeds.unitValueMinor  || {};
  return {
    inventory: {
      get: async function (sku) {
        if (!(sku in inv)) return null;
        return { sku: sku, stock_on_hand: inv[sku] };
      },
    },
    skusForAbcClass: async function (cls) { return (byAbc[cls] || []).slice(); },
    allActiveSkus:   async function ()    { return active.slice(); },
    unitValueMinor:  async function (sku) {
      return Object.prototype.hasOwnProperty.call(values, sku) ? values[sku] : 0;
    },
  };
}

// Build a fully-wired pair: inventoryLocations + cycleCounting that
// composes it. Returns both so the test can assert against the shelf
// via inventoryLocations.stockForSku.
async function _wire(catalogSeeds) {
  var q = _makeQuery();
  var locSvc = inventoryLocations.create({ query: q, catalog: {} });
  await locSvc.defineLocation({ code: "WH-EAST", name: "East Warehouse", type: "warehouse", priority: 1 });
  await locSvc.defineLocation({ code: "WH-WEST", name: "West Warehouse", type: "warehouse", priority: 5 });
  var catalog = _makeCatalog(catalogSeeds);
  var ccSvc = cycleCounting.create({ query: q, catalog: catalog, inventoryLocations: locSvc });
  return { q: q, locSvc: locSvc, ccSvc: ccSvc, catalog: catalog };
}

async function _defineCountAndKinds() {
  var wired = await _wire({
    inventory: { "WDG-1": 50, "WDG-2": 30 },
    byAbc:     { A: ["WDG-1", "WDG-2"] },
    allActiveSkus: ["WDG-1", "WDG-2", "WDG-3"],
  });
  var ccSvc = wired.ccSvc;
  var schedAt = Date.now() + 60 * 60 * 1000;

  // rotating
  var r = await ccSvc.defineCount({
    slug: "cc-q4-rotating-001",
    kind: "rotating",
    scope: { skus: ["WDG-1", "WDG-2"] },
    scheduled_at: schedAt,
  });
  check("rotating: status=scheduled",       r.status === "scheduled");
  check("rotating: kind=rotating",          r.kind === "rotating");
  check("rotating: scope.skus persisted",   r.scope.skus.length === 2);
  check("rotating: no lines yet",           r.lines.length === 0);
  check("rotating: variance_count null",    r.variance_count == null);
  check("rotating: created_at set",         typeof r.created_at === "number" && r.created_at > 0);

  // abc
  var a = await ccSvc.defineCount({
    slug: "cc-q4-abc-class-a",
    kind: "abc",
    scope: { abc_class: "A" },
    scheduled_at: schedAt,
    location_code: "WH-EAST",
  });
  check("abc: kind=abc",                    a.kind === "abc");
  check("abc: scope.abc_class persisted",   a.scope.abc_class === "A");
  check("abc: location_code persisted",     a.location_code === "WH-EAST");

  // full
  var f = await ccSvc.defineCount({
    slug: "cc-annual-full",
    kind: "full",
    scope: { all_active: true },
    scheduled_at: schedAt,
  });
  check("full: kind=full",                  f.kind === "full");
  check("full: scope.all_active=true",      f.scope.all_active === true);

  // Refusals
  await assert.rejects(ccSvc.defineCount(),                                            /input object required/);
  await assert.rejects(ccSvc.defineCount({}),                                          /slug/);
  await assert.rejects(ccSvc.defineCount({ slug: "x", kind: "bogus",
    scope: { skus: ["WDG-1"] }, scheduled_at: schedAt }),                              /kind/);
  await assert.rejects(ccSvc.defineCount({ slug: "x", kind: "rotating",
    scope: { abc_class: "A" }, scheduled_at: schedAt }),                               /rotating requires scope.skus/);
  await assert.rejects(ccSvc.defineCount({ slug: "x", kind: "rotating",
    scope: { skus: [] }, scheduled_at: schedAt }),                                     /non-empty array/);
  await assert.rejects(ccSvc.defineCount({ slug: "x", kind: "rotating",
    scope: { skus: ["WDG-1", "WDG-1"] }, scheduled_at: schedAt }),                     /duplicate sku/);
  await assert.rejects(ccSvc.defineCount({ slug: "x", kind: "abc",
    scope: {}, scheduled_at: schedAt }),                                               /abc_class/);
  await assert.rejects(ccSvc.defineCount({ slug: "x", kind: "full",
    scope: { all_active: false }, scheduled_at: schedAt }),                            /all_active === true/);
  await assert.rejects(ccSvc.defineCount({ slug: "x", kind: "rotating",
    scope: { skus: ["WDG-1"] }, scheduled_at: -1 }),                                   /scheduled_at/);
  // Duplicate slug
  await assert.rejects(ccSvc.defineCount({
    slug: "cc-q4-rotating-001", kind: "rotating",
    scope: { skus: ["WDG-1"] }, scheduled_at: schedAt,
  }), /already exists/);
}

async function _worksheetForResolvesAndIdempotent() {
  var wired = await _wire({
    inventory: { "WDG-1": 50, "WDG-2": 30 },
    byAbc:     { A: ["WDG-1"], B: ["WDG-2"] },
    allActiveSkus: ["WDG-1", "WDG-2", "WDG-3"],
  });
  var ccSvc = wired.ccSvc, locSvc = wired.locSvc;

  // Global (no location_code) — expected qty pulled from
  // catalog.inventory.get(sku)
  await ccSvc.defineCount({
    slug: "global-rotating",
    kind: "rotating",
    scope: { skus: ["WDG-1", "WDG-2", "WDG-3"] },
    scheduled_at: Date.now(),
  });
  var lines = await ccSvc.worksheetFor("global-rotating");
  check("global worksheet: 3 lines",        lines.length === 3);
  var bySku = {};
  lines.forEach(function (l) { bySku[l.sku] = l; });
  check("global worksheet: WDG-1 expected=50", bySku["WDG-1"].expected_quantity === 50);
  check("global worksheet: WDG-2 expected=30", bySku["WDG-2"].expected_quantity === 30);
  // Unknown SKU → catalog.inventory.get returns null → expected=0
  check("global worksheet: unknown sku=0",  bySku["WDG-3"].expected_quantity === 0);

  // Status transitions to in_progress
  var hyd = await ccSvc.getCount("global-rotating");
  check("worksheetFor moves status to in_progress", hyd.status === "in_progress");

  // Per-location — expected qty pulled from inventoryLocations.stockForSku
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 17 });
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-WEST", quantity: 8 });
  await ccSvc.defineCount({
    slug: "east-rotating",
    kind: "rotating",
    scope: { skus: ["WDG-1"] },
    scheduled_at: Date.now(),
    location_code: "WH-EAST",
  });
  var eastLines = await ccSvc.worksheetFor("east-rotating");
  check("east worksheet: 1 line",           eastLines.length === 1);
  check("east worksheet: expected=17",      eastLines[0].expected_quantity === 17);
  check("east worksheet: location_code",    eastLines[0].location_code === "WH-EAST");

  // Idempotent — second call returns the same lines, doesn't double-insert
  var again = await ccSvc.worksheetFor("east-rotating");
  check("worksheetFor idempotent count",    again.length === 1);
  check("worksheetFor idempotent id",       again[0].id === eastLines[0].id);

  // ABC kind: catalog.skusForAbcClass drives the SKU list
  await ccSvc.defineCount({
    slug: "abc-a",
    kind: "abc",
    scope: { abc_class: "A" },
    scheduled_at: Date.now(),
  });
  var abcLines = await ccSvc.worksheetFor("abc-a");
  check("abc worksheet: 1 sku (WDG-1)",     abcLines.length === 1 && abcLines[0].sku === "WDG-1");

  // Full kind: catalog.allActiveSkus drives
  await ccSvc.defineCount({
    slug: "full-1",
    kind: "full",
    scope: { all_active: true },
    scheduled_at: Date.now(),
  });
  var fullLines = await ccSvc.worksheetFor("full-1");
  check("full worksheet: all active skus",  fullLines.length === 3);

  // Refusals
  await assert.rejects(ccSvc.worksheetFor("nope-not-real"),                            /not found/);

  // Cancelled count refuses worksheet
  await ccSvc.defineCount({ slug: "to-cancel", kind: "rotating",
    scope: { skus: ["WDG-1"] }, scheduled_at: Date.now() });
  await ccSvc.cancelCount({ slug: "to-cancel", reason: "typo" });
  await assert.rejects(ccSvc.worksheetFor("to-cancel"),                                /cancelled|finalized/);
}

async function _recordCountAndVariance() {
  var wired = await _wire({
    inventory: { "WDG-1": 50, "WDG-2": 30 },
  });
  var ccSvc = wired.ccSvc;

  await ccSvc.defineCount({
    slug: "rec-1",
    kind: "rotating",
    scope: { skus: ["WDG-1", "WDG-2"] },
    scheduled_at: Date.now(),
  });
  await ccSvc.worksheetFor("rec-1");

  // Record both counts
  var updated = await ccSvc.recordCount({
    slug: "rec-1",
    lines: [
      { sku: "WDG-1", actual_quantity: 48, counted_by: "alice@warehouse" },
      { sku: "WDG-2", actual_quantity: 32, counted_by: "alice@warehouse" },
    ],
  });
  check("recordCount: lines returned",      updated.length === 2);
  var bySku = {};
  updated.forEach(function (l) { bySku[l.sku] = l; });
  check("recordCount: WDG-1 actual",        bySku["WDG-1"].actual_quantity === 48);
  check("recordCount: WDG-1 counted_by",    bySku["WDG-1"].counted_by === "alice@warehouse");
  check("recordCount: WDG-1 counted_at set",
    typeof bySku["WDG-1"].counted_at === "number" && bySku["WDG-1"].counted_at > 0);

  // Recount: overwrite WDG-1
  var recount = await ccSvc.recordCount({
    slug: "rec-1",
    lines: [{ sku: "WDG-1", actual_quantity: 49, counted_by: "bob@warehouse" }],
  });
  var bySku2 = {};
  recount.forEach(function (l) { bySku2[l.sku] = l; });
  check("recordCount: recount overwrites",  bySku2["WDG-1"].actual_quantity === 49);
  check("recordCount: recount new counter", bySku2["WDG-1"].counted_by === "bob@warehouse");
  check("recordCount: WDG-2 untouched",     bySku2["WDG-2"].actual_quantity === 32);

  // Refusals
  await assert.rejects(ccSvc.recordCount(),                                            /input object required/);
  await assert.rejects(ccSvc.recordCount({ slug: "rec-1", lines: [] }),                /non-empty array/);
  await assert.rejects(ccSvc.recordCount({ slug: "rec-1",
    lines: [{ sku: "WDG-1", actual_quantity: -1 }] }),                                 /actual_quantity/);
  await assert.rejects(ccSvc.recordCount({ slug: "rec-1",
    lines: [{ sku: "WDG-9999", actual_quantity: 1 }] }),                               /not on the worksheet/);
  await assert.rejects(ccSvc.recordCount({ slug: "rec-1",
    lines: [
      { sku: "WDG-1", actual_quantity: 1 },
      { sku: "WDG-1", actual_quantity: 2 },
    ] }),                                                                              /duplicate/);
  await assert.rejects(ccSvc.recordCount({ slug: "no-such", lines: [{ sku: "WDG-1", actual_quantity: 1 }] }),
    /not found/);
}

async function _finalizeWritesAdjustments() {
  var wired = await _wire({
    unitValueMinor: { "WDG-1": 1000, "WDG-2": 500 }, // $10, $5
  });
  var ccSvc = wired.ccSvc, locSvc = wired.locSvc;

  // Seed per-location stock so the worksheet captures expected qty
  // from inventoryLocations.stockForSku
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 30 });

  await ccSvc.defineCount({
    slug: "fin-1",
    kind: "rotating",
    scope: { skus: ["WDG-1", "WDG-2"] },
    scheduled_at: Date.now(),
    location_code: "WH-EAST",
  });
  await ccSvc.worksheetFor("fin-1");

  // Operator counts: WDG-1 short 3, WDG-2 over 1 (rare but possible)
  await ccSvc.recordCount({
    slug: "fin-1",
    lines: [
      { sku: "WDG-1", location_code: "WH-EAST", actual_quantity: 47, counted_by: "alice" },
      { sku: "WDG-2", location_code: "WH-EAST", actual_quantity: 31, counted_by: "alice" },
    ],
  });

  // Pre-finalize: shelf still has the original stock (no adjustments yet)
  var preW1 = await locSvc.stockForSku("WDG-1");
  check("pre-finalize: WDG-1 shelf untouched",
    preW1.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 50);

  var result = await ccSvc.finalizeCount({ slug: "fin-1", apply_adjustments: true });
  check("finalize: variance_count=2",       result.variance_count === 2);
  // |−3| * 1000 + |+1| * 500 = 3500
  check("finalize: variance_value_minor",   result.variance_value_minor === 3500);
  check("finalize: adjustments_written=2",  result.adjustments_written === 2);

  // Shelf now reflects the count
  var postW1 = await locSvc.stockForSku("WDG-1");
  check("post-finalize: WDG-1 shelf=47",
    postW1.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 47);
  var postW2 = await locSvc.stockForSku("WDG-2");
  check("post-finalize: WDG-2 shelf=31",
    postW2.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 31);

  // Header captures the rolled-up numbers
  var header = await ccSvc.getCount("fin-1");
  check("finalize: header status=finalized", header.status === "finalized");
  check("finalize: header variance_count",   header.variance_count === 2);
  check("finalize: header value",            header.variance_value_minor === 3500);
  check("finalize: finalized_at set",
    typeof header.finalized_at === "number" && header.finalized_at > 0);
  // Lines now carry the variance column
  var byLine = {};
  header.lines.forEach(function (l) { byLine[l.sku] = l; });
  check("finalize: WDG-1 line variance=-3",  byLine["WDG-1"].variance === -3);
  check("finalize: WDG-2 line variance=+1",  byLine["WDG-2"].variance === 1);

  // Audit log carries the cycle-count slug as the reason
  var audits = (await wired.q(
    "SELECT * FROM inventory_adjustments WHERE reason = ?1 ORDER BY occurred_at ASC",
    ["cycle-count:fin-1"],
  )).rows;
  check("finalize: 2 audit rows written",   audits.length === 2);

  // Cannot re-finalize
  await assert.rejects(ccSvc.finalizeCount({ slug: "fin-1" }),                         /only scheduled or in_progress/);

  // NULL actual_quantity treated as 0 — every expected unit is a discrepancy
  await locSvc.setStock({ sku: "WDG-3", location_code: "WH-EAST", quantity: 25 });
  await ccSvc.defineCount({ slug: "fin-uncounted", kind: "rotating",
    scope: { skus: ["WDG-3"] }, scheduled_at: Date.now(), location_code: "WH-EAST" });
  await ccSvc.worksheetFor("fin-uncounted");
  // No recordCount call — actual_quantity stays NULL
  var noRec = await ccSvc.finalizeCount({ slug: "fin-uncounted", apply_adjustments: true });
  check("uncounted: variance_count=1",       noRec.variance_count === 1);
  check("uncounted: adjustments_written=1",  noRec.adjustments_written === 1);
  var postW3 = await locSvc.stockForSku("WDG-3");
  // actual=0, expected=25 → variance = -25 → shelf goes to 0
  var w3East = postW3.by_location.find(function (l) { return l.code === "WH-EAST"; });
  check("uncounted: shelf zeroed",          (!w3East ? 0 : w3East.quantity) === 0);

  // apply_adjustments=false: variance computed, no shelf writes
  await locSvc.setStock({ sku: "WDG-4", location_code: "WH-EAST", quantity: 10 });
  await ccSvc.defineCount({ slug: "fin-dryrun", kind: "rotating",
    scope: { skus: ["WDG-4"] }, scheduled_at: Date.now(), location_code: "WH-EAST" });
  await ccSvc.worksheetFor("fin-dryrun");
  await ccSvc.recordCount({ slug: "fin-dryrun",
    lines: [{ sku: "WDG-4", location_code: "WH-EAST", actual_quantity: 7 }] });
  var dry = await ccSvc.finalizeCount({ slug: "fin-dryrun" });
  check("dryrun: variance_count=1",         dry.variance_count === 1);
  check("dryrun: adjustments_written=0",    dry.adjustments_written === 0);
  var dryW4 = await locSvc.stockForSku("WDG-4");
  check("dryrun: shelf untouched",
    dryW4.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 10);
}

async function _discrepanciesAndReadVerbs() {
  var wired = await _wire({
    inventory: { "WDG-1": 100, "WDG-2": 200, "WDG-3": 50 },
  });
  var ccSvc = wired.ccSvc;

  await ccSvc.defineCount({
    slug: "disc-1",
    kind: "rotating",
    scope: { skus: ["WDG-1", "WDG-2", "WDG-3"] },
    scheduled_at: Date.now(),
  });
  await ccSvc.worksheetFor("disc-1");
  await ccSvc.recordCount({
    slug: "disc-1",
    lines: [
      { sku: "WDG-1", actual_quantity: 95 },   // short 5
      { sku: "WDG-2", actual_quantity: 200 },  // clean
      { sku: "WDG-3", actual_quantity: 55 },   // over 5
    ],
  });

  // Pre-finalize: discrepanciesFor returns []
  var pre = await ccSvc.discrepanciesFor("disc-1");
  check("pre-finalize: discrepanciesFor empty", pre.length === 0);

  await ccSvc.finalizeCount({ slug: "disc-1" });

  // Post-finalize: only non-zero variance lines
  var diffs = await ccSvc.discrepanciesFor("disc-1");
  check("discrepanciesFor: 2 non-zero",     diffs.length === 2);
  var bySku = {};
  diffs.forEach(function (d) { bySku[d.sku] = d; });
  check("discrepanciesFor: WDG-1 short",    bySku["WDG-1"].variance === -5);
  check("discrepanciesFor: WDG-3 over",     bySku["WDG-3"].variance === 5);
  check("discrepanciesFor: WDG-2 absent",   !bySku["WDG-2"]);

  // Unknown slug
  var miss = await ccSvc.discrepanciesFor("no-such-slug");
  check("discrepanciesFor: unknown=null",   miss === null);

  // listCounts: filter by kind + date range. Pick a future window
  // that the earlier disc-1 count (scheduled at the test's start
  // wall-clock) can't sit inside, so the range filter check is
  // deterministic on fast runners where Date.now() collisions are
  // common.
  var futureBase = Date.now() + 1000 * 60 * 60 * 24; // +1 day
  await ccSvc.defineCount({ slug: "list-rot",  kind: "rotating",
    scope: { skus: ["WDG-1"] }, scheduled_at: futureBase });
  await ccSvc.defineCount({ slug: "list-full", kind: "full",
    scope: { all_active: true }, scheduled_at: futureBase + 10 });
  var allCounts = await ccSvc.listCounts();
  check("listCounts: all returns ≥ 3",      allCounts.length >= 3);
  var rotOnly = await ccSvc.listCounts({ kind: "rotating" });
  rotOnly.forEach(function (r) {
    check("listCounts: kind=rotating filter strict", r.kind === "rotating");
  });
  var inRange = await ccSvc.listCounts({ from: futureBase, to: futureBase + 10 });
  check("listCounts: range filter",         inRange.length === 2);

  // listCounts hydrates scope
  check("listCounts: scope hydrated",
    rotOnly[0].scope && typeof rotOnly[0].scope === "object");

  // listCounts refusals
  await assert.rejects(ccSvc.listCounts({ kind: "bogus" }),                            /kind/);
  await assert.rejects(ccSvc.listCounts({ from: -1 }),                                 /from/);
}

async function _cancelAndHistory() {
  var wired = await _wire({
    inventory: { "WDG-1": 100 },
  });
  var ccSvc = wired.ccSvc;

  await ccSvc.defineCount({
    slug: "cancel-me",
    kind: "rotating",
    scope: { skus: ["WDG-1"] },
    scheduled_at: Date.now(),
  });
  var cancelled = await ccSvc.cancelCount({ slug: "cancel-me", reason: "rescheduled to next week" });
  check("cancelCount: status=cancelled",    cancelled.status === "cancelled");
  check("cancelCount: reason persisted",    cancelled.cancel_reason === "rescheduled to next week");
  check("cancelCount: cancelled_at set",
    typeof cancelled.cancelled_at === "number" && cancelled.cancelled_at > 0);

  // Cannot re-cancel
  await assert.rejects(ccSvc.cancelCount({ slug: "cancel-me", reason: "again" }),      /cancelled|terminal/);

  // Cannot cancel a finalized count
  await ccSvc.defineCount({ slug: "cancel-fin", kind: "rotating",
    scope: { skus: ["WDG-1"] }, scheduled_at: Date.now() });
  await ccSvc.worksheetFor("cancel-fin");
  await ccSvc.finalizeCount({ slug: "cancel-fin" });
  await assert.rejects(ccSvc.cancelCount({ slug: "cancel-fin", reason: "too late" }),  /finalized|terminal/);

  // cancelCount refusals
  await assert.rejects(ccSvc.cancelCount(),                                            /input object required/);
  await assert.rejects(ccSvc.cancelCount({ slug: "cancel-me" }),                       /reason/);
  await assert.rejects(ccSvc.cancelCount({ slug: "cancel-me", reason: "" }),           /reason/);
  await assert.rejects(ccSvc.cancelCount({ slug: "no-such", reason: "x" }),            /not found/);

  // historyForSku: every line across every count that touched the SKU
  await ccSvc.defineCount({ slug: "h-1", kind: "rotating",
    scope: { skus: ["WDG-1"] }, scheduled_at: Date.now() });
  await ccSvc.worksheetFor("h-1");
  await ccSvc.recordCount({ slug: "h-1", lines: [{ sku: "WDG-1", actual_quantity: 95 }] });
  await ccSvc.finalizeCount({ slug: "h-1" });

  await ccSvc.defineCount({ slug: "h-2", kind: "rotating",
    scope: { skus: ["WDG-1"] }, scheduled_at: Date.now() });
  await ccSvc.worksheetFor("h-2");
  await ccSvc.recordCount({ slug: "h-2", lines: [{ sku: "WDG-1", actual_quantity: 90 }] });
  await ccSvc.finalizeCount({ slug: "h-2" });

  var hist = await ccSvc.historyForSku("WDG-1");
  // Three counts touched WDG-1 (cancel-me + h-1 + h-2)
  check("historyForSku: ≥ 3 lines",         hist.rows.length >= 3);
  check("historyForSku: cursor null when single page", hist.next_cursor === null);

  // Pagination with limit=1 returns a cursor
  var paged = await ccSvc.historyForSku("WDG-1", { limit: 1 });
  check("historyForSku: limit=1",           paged.rows.length === 1);
  check("historyForSku: next cursor",       typeof paged.next_cursor === "string");
  var nextPage = await ccSvc.historyForSku("WDG-1", { limit: 1, cursor: paged.next_cursor });
  check("historyForSku: next page returns",  nextPage.rows.length === 1);
  check("historyForSku: rows differ across pages",
    nextPage.rows[0].id !== paged.rows[0].id);

  // historyForSku refusals
  await assert.rejects(ccSvc.historyForSku("WDG-1", { cursor: "bogus" }),              /cursor/);
  await assert.rejects(ccSvc.historyForSku("WDG-1", { limit: 0 }),                     /limit/);
}

async function _factoryRefusals() {
  var q = _makeQuery();
  // Missing catalog
  assert.throws(function () { cycleCounting.create({ query: q }); },                   /catalog/);
  assert.throws(function () { cycleCounting.create({ query: q, catalog: null }); },    /catalog/);
  // Non-object inventoryLocations
  assert.throws(function () {
    cycleCounting.create({ query: q, catalog: _makeCatalog(), inventoryLocations: "wat" });
  }, /inventoryLocations/);
  // cursorSecret required in production
  var origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(function () {
      cycleCounting.create({ query: q, catalog: _makeCatalog() });
    }, /cursorSecret is required/);
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
  }

  // finalizeCount({ apply_adjustments: true }) without inventoryLocations
  // wired in — refuses at the call site, not at boot.
  var noLocSvc = cycleCounting.create({ query: q, catalog: _makeCatalog({
    inventory: { "WDG-1": 10 },
  }) });
  await noLocSvc.defineCount({
    slug: "no-loc",
    kind: "rotating",
    scope: { skus: ["WDG-1"] },
    scheduled_at: Date.now(),
  });
  await noLocSvc.worksheetFor("no-loc");
  await assert.rejects(noLocSvc.finalizeCount({ slug: "no-loc", apply_adjustments: true }),
    /inventoryLocations/);
  // Without apply_adjustments, no inventoryLocations needed — computes
  // variance only.
  var result = await noLocSvc.finalizeCount({ slug: "no-loc" });
  check("finalize no-loc: variance computed",   result.variance_count === 1);
  check("finalize no-loc: no adjustments",      result.adjustments_written === 0);
}

async function run() {
  await _defineCountAndKinds();
  await _worksheetForResolvesAndIdempotent();
  await _recordCountAndVariance();
  await _finalizeWritesAdjustments();
  await _discrepanciesAndReadVerbs();
  await _cancelAndHistory();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("cycle-counting: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
