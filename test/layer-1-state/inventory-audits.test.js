"use strict";
/**
 * inventory-audits — periodic full-inventory audits (year-end /
 * quarter-end / spot) with snapshot + reconciliation + optional shelf
 * adjustment write-through.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0034
 * (inventory locations + stock + adjustments) + migration 0197
 * (inventory_audits + inventory_audit_lines). The inventoryLocations
 * primitive is wired live so finalizeAudit({ apply_adjustments: true })
 * exercises the real adjustStock path; costLayers is a stub that
 * returns per-SKU unit cost in minor units (cents).
 *
 * Coverage:
 *   - openAudit happy paths: full / quarterly / spot kinds with the
 *     four scope values; header lands at status='open' with no lines;
 *     scope='location' refuses without location_codes; duplicate slug
 *     refused
 *   - recordScanLine captures expected_qty from inventoryLocations at
 *     scan time; transitions open -> in_progress on first scan;
 *     re-scanning the same (sku, location_code) overwrites the prior
 *     counted_qty; refuses location_code outside the audit's
 *     location_codes set
 *   - markRecount patches recount_qty + recounted_by + recounted_at
 *     on an existing line; refuses lines that don't already exist;
 *     recount value wins over counted_qty at finalize
 *   - finalizeAudit aggregates variance_count + variance_value_minor
 *     onto the header (via costLayers stub); apply_adjustments writes
 *     per-shelf adjustments through inventoryLocations.adjustStock
 *     with reason "inventory-audit:<slug>"
 *   - variancesForAudit returns only non-zero variance lines; null on
 *     unknown audit
 *   - cancelAudit transitions to cancelled with reason; refuses
 *     finalized audits
 *   - listAudits filters by kind / status / year
 *   - historyForSku joins audit header to surface every audit
 *     touching a SKU
 *   - compareToPriorAudit picks the prior finalized audit of the
 *     same kind and surfaces per-(sku, location) variance deltas
 *   - factory refusals: bad inventoryLocations / costLayers shapes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var inventoryAudits    = require("../../lib/inventory-audits");
var inventoryLocations = require("../../lib/inventory-locations");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0034_inventory_locations.sql",
  "0197_inventory_audits.sql",
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

// costLayers stub: seed per-SKU unit cost in minor units (cents).
// SKUs absent from the seed return null → primitive treats as 0 in
// the variance_value_minor roll-up.
function _makeCostLayers(seeds) {
  seeds = seeds || {};
  return {
    unitCostMinor: async function (sku) {
      return Object.prototype.hasOwnProperty.call(seeds, sku) ? seeds[sku] : null;
    },
  };
}

// Build a fully-wired pair: inventoryLocations + inventoryAudits that
// composes it. Returns both so the test can assert against the shelf
// via inventoryLocations.stockForSku.
async function _wire(costSeeds) {
  var q = _makeQuery();
  var locSvc = inventoryLocations.create({ query: q, catalog: {} });
  await locSvc.defineLocation({ code: "WH-EAST", name: "East Warehouse", type: "warehouse", priority: 1 });
  await locSvc.defineLocation({ code: "WH-WEST", name: "West Warehouse", type: "warehouse", priority: 5 });
  var costLayers = _makeCostLayers(costSeeds);
  var auditSvc = inventoryAudits.create({
    query:              q,
    inventoryLocations: locSvc,
    costLayers:         costLayers,
  });
  return { q: q, locSvc: locSvc, auditSvc: auditSvc };
}

async function _openAuditAndKinds() {
  var wired = await _wire();
  var auditSvc = wired.auditSvc;
  var schedAt = Date.now() + 60 * 60 * 1000;

  // full / scope=all
  var f = await auditSvc.openAudit({
    slug: "audit-yr-2026-full",
    kind: "full",
    scope: "all",
    scheduled_at: schedAt,
  });
  check("full: status=open",                 f.status === "open");
  check("full: kind=full",                   f.kind === "full");
  check("full: scope=all",                   f.scope === "all");
  check("full: id set",                      typeof f.id === "string" && f.id.length > 0);
  check("full: no lines yet",                f.lines.length === 0);
  check("full: variance_count null",         f.variance_count == null);
  check("full: created_at set",
    typeof f.created_at === "number" && f.created_at > 0);
  check("full: location_codes null",         f.location_codes === null);

  // quarterly / scope=category (no location_codes — covers every wired location)
  var q = await auditSvc.openAudit({
    slug: "audit-q4-cat-widgets",
    kind: "quarterly",
    scope: "category",
    scheduled_at: schedAt,
  });
  check("quarterly: kind=quarterly",         q.kind === "quarterly");
  check("quarterly: scope=category",         q.scope === "category");

  // spot / scope=location — requires location_codes
  var s = await auditSvc.openAudit({
    slug: "audit-spot-east",
    kind: "spot",
    scope: "location",
    scheduled_at: schedAt,
    location_codes: ["WH-EAST"],
  });
  check("spot: kind=spot",                   s.kind === "spot");
  check("spot: scope=location",              s.scope === "location");
  check("spot: location_codes persisted",
    s.location_codes.length === 1 && s.location_codes[0] === "WH-EAST");

  // Refusals
  await assert.rejects(auditSvc.openAudit(),                                              /input object required/);
  await assert.rejects(auditSvc.openAudit({}),                                            /slug/);
  await assert.rejects(auditSvc.openAudit({ slug: "x", kind: "bogus", scope: "all",
    scheduled_at: schedAt }),                                                             /kind/);
  await assert.rejects(auditSvc.openAudit({ slug: "x", kind: "full", scope: "bogus",
    scheduled_at: schedAt }),                                                             /scope/);
  await assert.rejects(auditSvc.openAudit({ slug: "x", kind: "spot", scope: "location",
    scheduled_at: schedAt }),                                                             /location_codes/);
  await assert.rejects(auditSvc.openAudit({ slug: "x", kind: "spot", scope: "location",
    scheduled_at: schedAt, location_codes: [] }),                                         /non-empty/);
  await assert.rejects(auditSvc.openAudit({ slug: "x", kind: "spot", scope: "location",
    scheduled_at: schedAt, location_codes: ["WH-EAST", "WH-EAST"] }),                     /duplicate/);
  await assert.rejects(auditSvc.openAudit({ slug: "x", kind: "full", scope: "all",
    scheduled_at: -1 }),                                                                  /scheduled_at/);
  // Duplicate slug
  await assert.rejects(auditSvc.openAudit({
    slug: "audit-yr-2026-full", kind: "full", scope: "all", scheduled_at: schedAt,
  }), /already exists/);
}

async function _recordScanLineAndWorksheet() {
  var wired = await _wire();
  var auditSvc = wired.auditSvc, locSvc = wired.locSvc;

  // Seed per-location stock so recordScanLine captures expected_qty
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 30 });

  var audit = await auditSvc.openAudit({
    slug: "scan-1",
    kind: "spot",
    scope: "location",
    scheduled_at: Date.now(),
    location_codes: ["WH-EAST"],
  });
  var auditId = audit.id;

  // First scan transitions open -> in_progress + captures expected_qty
  var afterScan1 = await auditSvc.recordScanLine({
    audit_id:      auditId,
    sku:           "WDG-1",
    location_code: "WH-EAST",
    counted_qty:   47,
    counter_id:    "alice@warehouse",
  });
  check("recordScanLine: status=in_progress", afterScan1.status === "in_progress");
  check("recordScanLine: 1 line",             afterScan1.lines.length === 1);
  check("recordScanLine: expected_qty=50",    afterScan1.lines[0].expected_qty === 50);
  check("recordScanLine: counted_qty=47",     afterScan1.lines[0].counted_qty === 47);
  check("recordScanLine: counted_by",         afterScan1.lines[0].counted_by === "alice@warehouse");
  check("recordScanLine: counted_at set",
    typeof afterScan1.lines[0].counted_at === "number" && afterScan1.lines[0].counted_at > 0);

  // Second scan adds a new line for WDG-2
  await auditSvc.recordScanLine({
    audit_id:      auditId,
    sku:           "WDG-2",
    location_code: "WH-EAST",
    counted_qty:   31,
    counter_id:    "alice@warehouse",
  });
  var hyd = await auditSvc.getAudit(auditId);
  check("recordScanLine: 2 lines",            hyd.lines.length === 2);

  // Re-scanning the same (sku, location_code) overwrites
  var rescan = await auditSvc.recordScanLine({
    audit_id:      auditId,
    sku:           "WDG-1",
    location_code: "WH-EAST",
    counted_qty:   48,
    counter_id:    "bob@warehouse",
  });
  var byKey = {};
  rescan.lines.forEach(function (l) { byKey[l.sku] = l; });
  check("recordScanLine: rescan overwrites",  byKey["WDG-1"].counted_qty === 48);
  check("recordScanLine: rescan new counter", byKey["WDG-1"].counted_by === "bob@warehouse");
  check("recordScanLine: still 2 lines",      rescan.lines.length === 2);

  // location_code outside the audit's location_codes set → refused
  await assert.rejects(auditSvc.recordScanLine({
    audit_id:      auditId,
    sku:           "WDG-1",
    location_code: "WH-WEST",
    counted_qty:   1,
    counter_id:    "alice",
  }), /not in this audit's location_codes/);

  // Refusals
  await assert.rejects(auditSvc.recordScanLine(),                                         /input object required/);
  await assert.rejects(auditSvc.recordScanLine({ audit_id: "not-a-uuid", sku: "WDG-1",
    location_code: "WH-EAST", counted_qty: 1, counter_id: "x" }),                         /audit_id/);
  await assert.rejects(auditSvc.recordScanLine({ audit_id: auditId, sku: "WDG-1",
    location_code: "WH-EAST", counted_qty: -1, counter_id: "x" }),                        /counted_qty/);
  await assert.rejects(auditSvc.recordScanLine({ audit_id: auditId, sku: "WDG-1",
    location_code: "WH-EAST", counted_qty: 1 }),                                          /counter_id/);

  // Unknown audit
  var bogusId = "00000000-0000-7000-8000-000000000000";
  await assert.rejects(auditSvc.recordScanLine({
    audit_id: bogusId, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 1, counter_id: "alice",
  }), /not found/);
}

async function _markRecountAndOverride() {
  var wired = await _wire();
  var auditSvc = wired.auditSvc, locSvc = wired.locSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });

  var audit = await auditSvc.openAudit({
    slug: "recount-1",
    kind: "spot",
    scope: "location",
    scheduled_at: Date.now(),
    location_codes: ["WH-EAST"],
  });

  // Without a recordScanLine first, markRecount refuses
  await assert.rejects(auditSvc.markRecount({
    audit_id: audit.id, sku: "WDG-1", location_code: "WH-EAST",
    recount_qty: 49, recount_by: "supervisor",
  }), /no scan line/);

  // Record original count (variance 50 → 45 = -5)
  await auditSvc.recordScanLine({
    audit_id: audit.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 45, counter_id: "alice",
  });

  // Supervisor recounts: actual was 49 (typo on the first scan)
  var afterRecount = await auditSvc.markRecount({
    audit_id:      audit.id,
    sku:           "WDG-1",
    location_code: "WH-EAST",
    recount_qty:   49,
    recount_by:    "supervisor",
  });
  var line = afterRecount.lines[0];
  check("markRecount: recount_qty=49",        line.recount_qty === 49);
  check("markRecount: recounted_by",          line.recounted_by === "supervisor");
  check("markRecount: recounted_at set",
    typeof line.recounted_at === "number" && line.recounted_at > 0);
  check("markRecount: counted_qty preserved", line.counted_qty === 45);

  // Refusals
  await assert.rejects(auditSvc.markRecount(),                                            /input object required/);
  await assert.rejects(auditSvc.markRecount({ audit_id: audit.id, sku: "WDG-1",
    location_code: "WH-EAST", recount_qty: -1, recount_by: "x" }),                        /recount_qty/);
  await assert.rejects(auditSvc.markRecount({ audit_id: audit.id, sku: "WDG-1",
    location_code: "WH-EAST", recount_qty: 49 }),                                         /recount_by/);
}

async function _finalizeWritesAdjustments() {
  var wired = await _wire({
    "WDG-1": 1000, // $10
    "WDG-2": 500,  // $5
  });
  var auditSvc = wired.auditSvc, locSvc = wired.locSvc;

  // Seed per-location stock so recordScanLine captures expected_qty
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 30 });

  var audit = await auditSvc.openAudit({
    slug: "fin-1",
    kind: "quarterly",
    scope: "location",
    scheduled_at: Date.now(),
    location_codes: ["WH-EAST"],
  });

  // Operator counts: WDG-1 short 3 (47 vs 50), WDG-2 over 1 (31 vs 30)
  await auditSvc.recordScanLine({
    audit_id: audit.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 47, counter_id: "alice",
  });
  await auditSvc.recordScanLine({
    audit_id: audit.id, sku: "WDG-2", location_code: "WH-EAST",
    counted_qty: 31, counter_id: "alice",
  });

  // Pre-finalize: shelf still has the original stock
  var preW1 = await locSvc.stockForSku("WDG-1");
  check("pre-finalize: WDG-1 shelf untouched",
    preW1.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 50);

  var result = await auditSvc.finalizeAudit({ audit_id: audit.id, apply_adjustments: true });
  check("finalize: variance_count=2",        result.variance_count === 2);
  // |-3| * 1000 + |+1| * 500 = 3500
  check("finalize: variance_value_minor",    result.variance_value_minor === 3500);
  check("finalize: adjustments_written=2",   result.adjustments_written === 2);

  // Shelf now reflects the count
  var postW1 = await locSvc.stockForSku("WDG-1");
  check("post-finalize: WDG-1 shelf=47",
    postW1.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 47);
  var postW2 = await locSvc.stockForSku("WDG-2");
  check("post-finalize: WDG-2 shelf=31",
    postW2.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 31);

  // Header captures the rolled-up numbers
  var header = await auditSvc.getAudit(audit.id);
  check("finalize: header status=finalized", header.status === "finalized");
  check("finalize: header variance_count",   header.variance_count === 2);
  check("finalize: header value",            header.variance_value_minor === 3500);
  check("finalize: finalized_at set",
    typeof header.finalized_at === "number" && header.finalized_at > 0);

  // Audit log on inventory_adjustments carries the audit slug
  var audits = (await wired.q(
    "SELECT * FROM inventory_adjustments WHERE reason = ?1 ORDER BY occurred_at ASC",
    ["inventory-audit:fin-1"],
  )).rows;
  check("finalize: 2 audit rows written",    audits.length === 2);

  // Cannot re-finalize
  await assert.rejects(auditSvc.finalizeAudit({ audit_id: audit.id }),                    /only open or in_progress/);

  // recount_qty wins over counted_qty at finalize
  await locSvc.setStock({ sku: "WDG-3", location_code: "WH-EAST", quantity: 100 });
  var rcAudit = await auditSvc.openAudit({
    slug: "fin-recount", kind: "spot", scope: "location",
    scheduled_at: Date.now(), location_codes: ["WH-EAST"],
  });
  // Original scan says 80 (would be variance -20)
  await auditSvc.recordScanLine({
    audit_id: rcAudit.id, sku: "WDG-3", location_code: "WH-EAST",
    counted_qty: 80, counter_id: "alice",
  });
  // Recount says 100 (correct; variance 0)
  await auditSvc.markRecount({
    audit_id: rcAudit.id, sku: "WDG-3", location_code: "WH-EAST",
    recount_qty: 100, recount_by: "supervisor",
  });
  var rcResult = await auditSvc.finalizeAudit({ audit_id: rcAudit.id, apply_adjustments: true });
  check("recount: variance_count=0",         rcResult.variance_count === 0);
  check("recount: adjustments_written=0",    rcResult.adjustments_written === 0);
  var rcPost = await locSvc.stockForSku("WDG-3");
  check("recount: shelf untouched",
    rcPost.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 100);

  // apply_adjustments=false: variance computed, no shelf writes
  await locSvc.setStock({ sku: "WDG-4", location_code: "WH-EAST", quantity: 10 });
  var dryAudit = await auditSvc.openAudit({
    slug: "fin-dryrun", kind: "spot", scope: "location",
    scheduled_at: Date.now(), location_codes: ["WH-EAST"],
  });
  await auditSvc.recordScanLine({
    audit_id: dryAudit.id, sku: "WDG-4", location_code: "WH-EAST",
    counted_qty: 7, counter_id: "alice",
  });
  var dry = await auditSvc.finalizeAudit({ audit_id: dryAudit.id });
  check("dryrun: variance_count=1",          dry.variance_count === 1);
  check("dryrun: adjustments_written=0",     dry.adjustments_written === 0);
  var dryW4 = await locSvc.stockForSku("WDG-4");
  check("dryrun: shelf untouched",
    dryW4.by_location.find(function (l) { return l.code === "WH-EAST"; }).quantity === 10);
}

async function _readsAndCancel() {
  var wired = await _wire();
  var auditSvc = wired.auditSvc, locSvc = wired.locSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 100 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 200 });
  await locSvc.setStock({ sku: "WDG-3", location_code: "WH-EAST", quantity: 50 });

  // variancesForAudit pre-finalize is [] (variance NULL on lines)
  var pre = await auditSvc.openAudit({
    slug: "var-1", kind: "quarterly", scope: "location",
    scheduled_at: Date.now(), location_codes: ["WH-EAST"],
  });
  await auditSvc.recordScanLine({
    audit_id: pre.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 95, counter_id: "alice",
  });
  await auditSvc.recordScanLine({
    audit_id: pre.id, sku: "WDG-2", location_code: "WH-EAST",
    counted_qty: 200, counter_id: "alice",
  });
  await auditSvc.recordScanLine({
    audit_id: pre.id, sku: "WDG-3", location_code: "WH-EAST",
    counted_qty: 55, counter_id: "alice",
  });
  var preVar = await auditSvc.variancesForAudit(pre.id);
  check("pre-finalize: variancesForAudit []", preVar.length === 0);

  await auditSvc.finalizeAudit({ audit_id: pre.id });

  // Post-finalize: only non-zero variance lines
  var diffs = await auditSvc.variancesForAudit(pre.id);
  check("variancesForAudit: 2 non-zero",     diffs.length === 2);
  var bySku = {};
  diffs.forEach(function (d) { bySku[d.sku] = d; });
  check("variancesForAudit: WDG-1 short",    bySku["WDG-1"].variance === -5);
  check("variancesForAudit: WDG-3 over",     bySku["WDG-3"].variance === 5);
  check("variancesForAudit: WDG-2 absent",   !bySku["WDG-2"]);

  // Unknown audit
  var miss = await auditSvc.variancesForAudit("00000000-0000-7000-8000-000000000000");
  check("variancesForAudit: unknown=null",   miss === null);

  // listAudits filters
  var futureYear = new Date().getUTCFullYear() + 2;
  var futureBase = Date.UTC(futureYear, 5, 1, 0, 0, 0, 0); // June 1 of futureYear
  await auditSvc.openAudit({ slug: "list-full", kind: "full", scope: "all",
    scheduled_at: futureBase });
  await auditSvc.openAudit({ slug: "list-q", kind: "quarterly", scope: "all",
    scheduled_at: futureBase + 10 });
  var allList = await auditSvc.listAudits();
  check("listAudits: all returns ≥ 3",       allList.length >= 3);
  var fullOnly = await auditSvc.listAudits({ kind: "full" });
  fullOnly.forEach(function (r) {
    check("listAudits: kind=full strict", r.kind === "full");
  });
  var byStatus = await auditSvc.listAudits({ status: "open" });
  byStatus.forEach(function (r) {
    check("listAudits: status=open strict", r.status === "open");
  });
  var byYear = await auditSvc.listAudits({ year: futureYear });
  check("listAudits: year filter",           byYear.length === 2);

  // listAudits refusals
  await assert.rejects(auditSvc.listAudits({ kind: "bogus" }),                            /kind/);
  await assert.rejects(auditSvc.listAudits({ status: "bogus" }),                          /status/);
  await assert.rejects(auditSvc.listAudits({ year: 99 }),                                 /year/);

  // historyForSku joins audit header
  var hist = await auditSvc.historyForSku("WDG-1");
  check("historyForSku: ≥ 1 line",           hist.length >= 1);
  check("historyForSku: audit slug present",
    typeof hist[0].audit_slug === "string" && hist[0].audit_slug.length > 0);

  // cancelAudit
  var c = await auditSvc.openAudit({
    slug: "cancel-me", kind: "spot", scope: "location",
    scheduled_at: Date.now(), location_codes: ["WH-EAST"],
  });
  var cancelled = await auditSvc.cancelAudit({ audit_id: c.id, reason: "rescheduled to next week" });
  check("cancelAudit: status=cancelled",     cancelled.status === "cancelled");
  check("cancelAudit: reason persisted",     cancelled.cancel_reason === "rescheduled to next week");
  check("cancelAudit: cancelled_at set",
    typeof cancelled.cancelled_at === "number" && cancelled.cancelled_at > 0);

  // Cannot re-cancel
  await assert.rejects(auditSvc.cancelAudit({ audit_id: c.id, reason: "again" }),         /cancelled|terminal/);

  // Cannot cancel a finalized audit
  await assert.rejects(auditSvc.cancelAudit({ audit_id: pre.id, reason: "too late" }),    /finalized|terminal/);

  // cancelAudit refusals
  await assert.rejects(auditSvc.cancelAudit(),                                            /input object required/);
  await assert.rejects(auditSvc.cancelAudit({ audit_id: c.id }),                          /reason/);
  await assert.rejects(auditSvc.cancelAudit({ audit_id: c.id, reason: "" }),              /reason/);
}

async function _compareToPriorAudit() {
  var wired = await _wire();
  var auditSvc = wired.auditSvc, locSvc = wired.locSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 100 });
  await locSvc.setStock({ sku: "WDG-2", location_code: "WH-EAST", quantity: 50 });

  var baseTs = Date.now();

  // Prior audit (Q3): WDG-1 short 3, WDG-2 clean
  var prior = await auditSvc.openAudit({
    slug: "audit-q3",
    kind: "quarterly",
    scope: "location",
    scheduled_at: baseTs,
    location_codes: ["WH-EAST"],
  });
  await auditSvc.recordScanLine({
    audit_id: prior.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 97, counter_id: "alice",
  });
  await auditSvc.recordScanLine({
    audit_id: prior.id, sku: "WDG-2", location_code: "WH-EAST",
    counted_qty: 50, counter_id: "alice",
  });
  await auditSvc.finalizeAudit({ audit_id: prior.id });

  // Current audit (Q4): WDG-1 short 5 (worsening), WDG-2 over 2
  // Use the post-Q3-adjustment stock as the new baseline. Since we
  // didn't apply_adjustments above, the shelf is unchanged at 100/50.
  var current = await auditSvc.openAudit({
    slug: "audit-q4",
    kind: "quarterly",
    scope: "location",
    scheduled_at: baseTs + 60 * 1000,
    location_codes: ["WH-EAST"],
  });
  await auditSvc.recordScanLine({
    audit_id: current.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 95, counter_id: "alice",
  });
  await auditSvc.recordScanLine({
    audit_id: current.id, sku: "WDG-2", location_code: "WH-EAST",
    counted_qty: 52, counter_id: "alice",
  });
  await auditSvc.finalizeAudit({ audit_id: current.id });

  var cmp = await auditSvc.compareToPriorAudit({ audit_id: current.id });
  check("compareToPriorAudit: prior matched",  cmp.prior_audit_id === prior.id);
  check("compareToPriorAudit: 2 deltas",       cmp.deltas.length === 2);
  var byKey = {};
  cmp.deltas.forEach(function (d) { byKey[d.sku] = d; });
  check("compareToPriorAudit: WDG-1 prior=-3", byKey["WDG-1"].prior_variance === -3);
  check("compareToPriorAudit: WDG-1 cur=-5",   byKey["WDG-1"].current_variance === -5);
  check("compareToPriorAudit: WDG-1 delta=-2", byKey["WDG-1"].delta === -2);
  check("compareToPriorAudit: WDG-2 prior=0",  byKey["WDG-2"].prior_variance === 0);
  check("compareToPriorAudit: WDG-2 cur=+2",   byKey["WDG-2"].current_variance === 2);
  check("compareToPriorAudit: WDG-2 delta=+2", byKey["WDG-2"].delta === 2);

  // No prior audit of same kind for a fresh kind → prior_audit_id null
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 100 });
  var lone = await auditSvc.openAudit({
    slug: "audit-lone-full", kind: "full", scope: "location",
    scheduled_at: Date.now() + 100, location_codes: ["WH-EAST"],
  });
  await auditSvc.recordScanLine({
    audit_id: lone.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 100, counter_id: "alice",
  });
  await auditSvc.finalizeAudit({ audit_id: lone.id });
  var loneCmp = await auditSvc.compareToPriorAudit({ audit_id: lone.id });
  check("compareToPriorAudit: lone=null prior", loneCmp.prior_audit_id === null);
  check("compareToPriorAudit: lone deltas=[]",  loneCmp.deltas.length === 0);

  // Refuses non-finalized audits
  var unfin = await auditSvc.openAudit({
    slug: "audit-unfin", kind: "quarterly", scope: "location",
    scheduled_at: Date.now() + 200, location_codes: ["WH-EAST"],
  });
  await assert.rejects(auditSvc.compareToPriorAudit({ audit_id: unfin.id }),
    /only works on finalized/);

  // Refusals
  await assert.rejects(auditSvc.compareToPriorAudit(),                                    /input object required/);
  await assert.rejects(auditSvc.compareToPriorAudit({ audit_id: "not-a-uuid" }),          /audit_id/);
}

async function _factoryRefusals() {
  var q = _makeQuery();
  // Non-object inventoryLocations
  assert.throws(function () {
    inventoryAudits.create({ query: q, inventoryLocations: "wat" });
  }, /inventoryLocations/);
  // inventoryLocations missing stockForSku
  assert.throws(function () {
    inventoryAudits.create({ query: q, inventoryLocations: { unrelated: function () {} } });
  }, /stockForSku/);
  // Non-object costLayers
  assert.throws(function () {
    inventoryAudits.create({ query: q, costLayers: "wat" });
  }, /costLayers/);
  // Non-object inventorySnapshots
  assert.throws(function () {
    inventoryAudits.create({ query: q, inventorySnapshots: "wat" });
  }, /inventorySnapshots/);

  // finalizeAudit({ apply_adjustments: true }) without inventoryLocations
  // refuses at the call site, not at boot.
  var noLocSvc = inventoryAudits.create({ query: q });
  // openAudit doesn't need inventoryLocations
  var locSvc = inventoryLocations.create({ query: q, catalog: {} });
  await locSvc.defineLocation({ code: "WH-EAST", name: "East", type: "warehouse", priority: 1 });
  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 10 });
  // But recordScanLine does — capture expected_qty requires it.
  // Wire a separate svc that has inventoryLocations so we can open + scan;
  // then call finalize on the no-loc svc to assert the apply_adjustments
  // refusal at the call site.
  var wiredSvc = inventoryAudits.create({ query: q, inventoryLocations: locSvc });
  var a = await wiredSvc.openAudit({
    slug: "no-loc-audit", kind: "spot", scope: "location",
    scheduled_at: Date.now(), location_codes: ["WH-EAST"],
  });
  await wiredSvc.recordScanLine({
    audit_id: a.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 8, counter_id: "alice",
  });
  // noLocSvc shares the same DB; calling finalize there with
  // apply_adjustments=true refuses up front.
  await assert.rejects(noLocSvc.finalizeAudit({ audit_id: a.id, apply_adjustments: true }),
    /inventoryLocations/);
  // Without apply_adjustments, no inventoryLocations needed — computes
  // variance only.
  var result = await noLocSvc.finalizeAudit({ audit_id: a.id });
  check("finalize no-loc: variance computed", result.variance_count === 1);
  check("finalize no-loc: no adjustments",    result.adjustments_written === 0);

  // recordScanLine without inventoryLocations refuses (needs expected_qty)
  var freshSvc = inventoryAudits.create({ query: q });
  var fresh = await freshSvc.openAudit({
    slug: "fresh-no-loc", kind: "spot", scope: "location",
    scheduled_at: Date.now(), location_codes: ["WH-EAST"],
  });
  await assert.rejects(freshSvc.recordScanLine({
    audit_id: fresh.id, sku: "WDG-1", location_code: "WH-EAST",
    counted_qty: 1, counter_id: "alice",
  }), /inventoryLocations/);
}

async function run() {
  await _openAuditAndKinds();
  await _recordScanLineAndWorksheet();
  await _markRecountAndOverride();
  await _finalizeWritesAdjustments();
  await _readsAndCancel();
  await _compareToPriorAudit();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("inventory-audits: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
