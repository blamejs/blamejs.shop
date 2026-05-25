"use strict";
/**
 * split-shipments — plan-then-execute multi-parcel fulfillment.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0003
 * (orders + order_lines), 0021 (shipments + shipment_events) and
 * 0096 (split_shipment_plans). The composition dependencies the
 * primitive exposes — order, orderTracking, backorder,
 * inventoryLocations, vendors — are all stubbed so each strategy
 * branch can be exercised in isolation without dragging the live
 * primitives into the test envelope.
 *
 * Coverage:
 *   - planSplit availability — in-stock vs backordered parcels
 *   - planSplit location     — groups by inventoryLocations.routeOrder
 *   - planSplit manual       — conservation check + persisted plan
 *   - executeSplit           — writes one shipment per parcel via
 *                              the stub orderTracking + flips status
 *   - mergeShipments         — re-points two parcels into one and
 *                              rewrites the plan row's shipment list
 *   - splitsForOrder         — reads back proposed + executed plans
 *   - recommendStrategy      — heuristic returns the right strategy
 *                              for each composition shape
 *   - factory + input validation refusals
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// Require the module directly so this test stays independent of any
// `lib/index.js` export ordering.
var splitShipments = require("../../lib/split-shipments");
var bShop          = require("../../lib/index");
var b              = bShop.framework;

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0003_order.sql", "0206_orders_email_hash.sql",
  "0021_shipments.sql",
  "0096_split_shipments.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = OFF").run();
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

// Seed a `pending` order with N order_lines. Returns
// `{ order_id, lines: [{ id, sku, qty }] }` — the same shape an
// injected `order.get(...)` stub would yield.
async function _seedOrder(q, lineSpecs) {
  var orderId = b.uuid.v7();
  var ts = Date.now();
  await q(
    "INSERT INTO orders (id, cart_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'paid', 'USD', 0, 0, 0, 0, 0, '{}', ?4, ?4)",
    [orderId, b.uuid.v7(), b.uuid.v7(), ts],
  );
  var lines = [];
  for (var i = 0; i < lineSpecs.length; i += 1) {
    var spec = lineSpecs[i];
    var lid = b.uuid.v7();
    await q(
      "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, " +
      "unit_amount_minor, unit_currency, line_total_minor) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 0, 'USD', 0)",
      [lid, orderId, b.uuid.v7(), spec.sku, spec.qty],
    );
    lines.push({ id: lid, sku: spec.sku, qty: spec.qty });
  }
  return { order_id: orderId, lines: lines };
}

// Stand-in order primitive — `order.get(id)` returns
// `{ lines: [...] }` for the seeded order_id, null otherwise. The
// primitive accepts EITHER a wired `order` stub OR a direct SQL
// fallback; exercising both paths keeps the seam honest.
function _stubOrder(seeded) {
  return {
    get: async function (id) {
      if (id !== seeded.order_id) return null;
      return { lines: seeded.lines };
    },
  };
}

// orderTracking stub — captures every createShipment() call so the
// test can assert per-parcel arguments + returns deterministic
// uuid-v7 shipment ids. Also writes a real `shipments` row to the
// in-memory DB so mergeShipments() can re-read it.
function _stubOrderTracking(q) {
  var calls = [];
  return {
    calls: calls,
    createShipment: async function (input) {
      var id = b.uuid.v7();
      var ts = Date.now();
      await q(
        "INSERT INTO shipments (id, order_id, carrier, carrier_other_name, status, " +
        "weight_grams, cost_minor, cost_currency, notes, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'pending', 0, 0, 'USD', ?5, ?6, ?6)",
        [id, input.order_id, input.carrier, input.carrier_other_name || null, input.notes || "", ts],
      );
      calls.push({ id: id, input: input });
      return { id: id, order_id: input.order_id, status: "pending" };
    },
  };
}

// backorder stub — every SKU listed in `pendingMap` returns one
// pending row for the given order_id; everything else returns the
// empty array. Mirrors the real backorder.pendingForSku(sku) shape.
function _stubBackorder(pendingMap) {
  return {
    pendingForSku: async function (sku) {
      var hits = pendingMap[sku] || [];
      return hits.map(function (orderId) { return { order_id: orderId, sku: sku, qty: 1 }; });
    },
  };
}

// inventoryLocations stub — operator-supplied `routeOrder` plan.
// The strategy walks `allocation` (per-location SKU+qty slices) and
// `unfulfillable` (per-SKU shortages). Mirrors the real
// inventoryLocations.routeOrder return shape.
function _stubInventoryLocations(routeResult) {
  return {
    routeOrder: async function (input) {
      void input;
      return routeResult;
    },
  };
}

// vendors stub — per-SKU vendor mapping. SKUs absent from the map
// fall through to the `vendor:unassigned` parcel.
function _stubVendors(vendorMap) {
  return {
    vendorForSku: async function (sku) {
      return vendorMap[sku] || null;
    },
  };
}

// ----- availability strategy -------------------------------------------

async function _planSplitAvailability() {
  var q = _makeQuery();
  var seeded = await _seedOrder(q, [
    { sku: "WDG-1", qty: 2 },
    { sku: "WDG-2", qty: 3 },
    { sku: "WDG-3", qty: 1 },
  ]);
  var pending = {};
  pending["WDG-2"] = [seeded.order_id];
  pending["WDG-3"] = [seeded.order_id];

  var ot  = _stubOrderTracking(q);
  var svc = splitShipments.create({
    query:        q,
    order:        _stubOrder(seeded),
    orderTracking: ot,
    backorder:    _stubBackorder(pending),
  });

  var plan = await svc.planSplit({ order_id: seeded.order_id, strategy: "availability" });

  check("availability plan persisted: id present",        typeof plan.id === "string" && plan.id.length > 0);
  check("availability plan strategy",                     plan.strategy === "availability");
  check("availability plan status proposed",              plan.status === "proposed");
  check("availability plan has 2 parcels",                plan.shipments.length === 2);
  check("availability parcel[0] = in_stock",              plan.shipments[0].rationale === "in_stock");
  check("availability parcel[1] = backordered",           plan.shipments[1].rationale === "backordered");
  check("availability ship-now contains WDG-1",
    plan.shipments[0].lines.length === 1 &&
    plan.shipments[0].lines[0].line_id === seeded.lines[0].id &&
    plan.shipments[0].lines[0].qty === 2);
  check("availability ship-later contains WDG-2 + WDG-3",
    plan.shipments[1].lines.length === 2 &&
    plan.shipments[1].lines[0].line_id === seeded.lines[1].id &&
    plan.shipments[1].lines[1].line_id === seeded.lines[2].id);

  // No orderTracking calls until executeSplit runs.
  check("availability planSplit does not call orderTracking", ot.calls.length === 0);

  // All-in-stock order collapses to one parcel (no empty groups).
  var seededAll = await _seedOrder(q, [{ sku: "WDG-99", qty: 1 }]);
  var planAll = await splitShipments.create({
    query: q, order: _stubOrder(seededAll), orderTracking: ot, backorder: _stubBackorder({}),
  }).planSplit({ order_id: seededAll.order_id, strategy: "availability" });
  check("all-in-stock collapses to single parcel", planAll.shipments.length === 1 &&
    planAll.shipments[0].rationale === "in_stock");

  // availability without backorder wired → refusal at strategy-branch
  // entry (not at factory — backorder is only required when the
  // strategy actually walks it).
  var svcNoBO = splitShipments.create({ query: q, order: _stubOrder(seeded), orderTracking: ot });
  await assert.rejects(svcNoBO.planSplit({ order_id: seeded.order_id, strategy: "availability" }),
    /opts\.backorder required/);
}

// ----- location strategy -----------------------------------------------

async function _planSplitLocation() {
  var q = _makeQuery();
  var seeded = await _seedOrder(q, [
    { sku: "WDG-1", qty: 4 },
    { sku: "WDG-2", qty: 2 },
    { sku: "WDG-3", qty: 1 },
  ]);
  var ot = _stubOrderTracking(q);

  // routeOrder spreads WDG-1 across two warehouses, sources WDG-2
  // wholly from WH-WEST, and reports WDG-3 unfulfillable.
  var routeResult = {
    allocation: [
      { location_code: "WH-EAST", lines: [
        { sku: "WDG-1", quantity: 3 },
      ] },
      { location_code: "WH-WEST", lines: [
        { sku: "WDG-1", quantity: 1 },
        { sku: "WDG-2", quantity: 2 },
      ] },
    ],
    unfulfillable: [
      { sku: "WDG-3", quantity: 1 },
    ],
  };
  var svc = splitShipments.create({
    query:               q,
    order:               _stubOrder(seeded),
    orderTracking:       ot,
    inventoryLocations:  _stubInventoryLocations(routeResult),
  });

  var plan = await svc.planSplit({ order_id: seeded.order_id, strategy: "location" });
  check("location plan has 3 parcels",          plan.shipments.length === 3);
  check("location parcel[0] = WH-EAST",         plan.shipments[0].rationale === "location:WH-EAST");
  check("location parcel[1] = WH-WEST",         plan.shipments[1].rationale === "location:WH-WEST");
  check("location parcel[2] = unfulfillable",   plan.shipments[2].rationale === "unfulfillable");

  // Per-line qty distribution matches the routing slices.
  var east = plan.shipments[0];
  check("WH-EAST WDG-1 line qty=3", east.lines.length === 1 &&
    east.lines[0].line_id === seeded.lines[0].id && east.lines[0].qty === 3);
  var west = plan.shipments[1];
  // First line in WH-WEST consumes the remaining WDG-1 qty (1),
  // second line takes WDG-2 (2).
  check("WH-WEST WDG-1 line qty=1", west.lines[0].line_id === seeded.lines[0].id && west.lines[0].qty === 1);
  check("WH-WEST WDG-2 line qty=2", west.lines[1].line_id === seeded.lines[1].id && west.lines[1].qty === 2);
  var unfu = plan.shipments[2];
  check("unfulfillable WDG-3 line qty=1", unfu.lines.length === 1 &&
    unfu.lines[0].line_id === seeded.lines[2].id && unfu.lines[0].qty === 1);

  // No inventoryLocations wired → refusal at the strategy branch.
  var svcNoLoc = splitShipments.create({ query: q, order: _stubOrder(seeded), orderTracking: ot });
  await assert.rejects(svcNoLoc.planSplit({ order_id: seeded.order_id, strategy: "location" }),
    /opts\.inventoryLocations required/);
}

// ----- manual strategy -------------------------------------------------

async function _planSplitManual() {
  var q = _makeQuery();
  var seeded = await _seedOrder(q, [
    { sku: "WDG-1", qty: 5 },
    { sku: "WDG-2", qty: 2 },
  ]);
  var ot = _stubOrderTracking(q);
  var svc = splitShipments.create({
    query: q, order: _stubOrder(seeded), orderTracking: ot,
  });

  // Split WDG-1's 5 units across two parcels (3 + 2); WDG-2 lands
  // alongside the second WDG-1 slice.
  var plan = await svc.planSplit({
    order_id:  seeded.order_id,
    strategy:  "manual",
    manualPlan: [
      { rationale: "express", lines: [{ line_id: seeded.lines[0].id, qty: 3 }] },
      { rationale: "ground",  lines: [
        { line_id: seeded.lines[0].id, qty: 2 },
        { line_id: seeded.lines[1].id, qty: 2 },
      ] },
    ],
  });

  check("manual plan persisted",                typeof plan.id === "string");
  check("manual plan strategy",                 plan.strategy === "manual");
  check("manual plan has 2 parcels",            plan.shipments.length === 2);
  check("manual parcel[0] rationale",           plan.shipments[0].rationale === "express");
  check("manual parcel[1] rationale",           plan.shipments[1].rationale === "ground");
  check("manual qty split preserved",           plan.shipments[0].lines[0].qty === 3 &&
    plan.shipments[1].lines[0].qty === 2);

  // Conservation refusals
  await assert.rejects(svc.planSplit({
    order_id: seeded.order_id, strategy: "manual",
    manualPlan: [{ lines: [{ line_id: seeded.lines[0].id, qty: 4 }] }],
  }), /manualPlan consumes/);
  await assert.rejects(svc.planSplit({
    order_id: seeded.order_id, strategy: "manual",
    manualPlan: [{ lines: [
      { line_id: seeded.lines[0].id, qty: 5 },
      { line_id: seeded.lines[1].id, qty: 3 },     // over by 1
    ] }],
  }), /manualPlan consumes 3/);
  // Bogus line_id (well-formed UUID that does not belong to the order)
  await assert.rejects(svc.planSplit({
    order_id: seeded.order_id, strategy: "manual",
    manualPlan: [{ lines: [{ line_id: b.uuid.v7(), qty: 1 }] }],
  }), /does not belong to order/);
  // Non-array manualPlan
  await assert.rejects(svc.planSplit({
    order_id: seeded.order_id, strategy: "manual", manualPlan: [],
  }), /non-empty array/);
  await assert.rejects(svc.planSplit({
    order_id: seeded.order_id, strategy: "manual",
  }), /non-empty array/);
}

// ----- executeSplit ----------------------------------------------------

async function _executeSplitWritesShipments() {
  var q = _makeQuery();
  var seeded = await _seedOrder(q, [
    { sku: "WDG-1", qty: 1 },
    { sku: "WDG-2", qty: 1 },
  ]);
  var ot  = _stubOrderTracking(q);
  var svc = splitShipments.create({
    query: q, order: _stubOrder(seeded), orderTracking: ot,
    backorder: _stubBackorder({ "WDG-2": [seeded.order_id] }),
  });

  var plan = await svc.planSplit({ order_id: seeded.order_id, strategy: "availability" });
  check("executeSplit precondition: plan proposed", plan.status === "proposed");

  var executed = await svc.executeSplit({
    order_id: seeded.order_id,
    plan:     plan,
    carrier:  "ups",
  });

  check("executeSplit returns executed plan",     executed.status === "executed");
  check("executeSplit captures shipment ids",     executed.shipment_ids.length === 2);
  check("executeSplit executed_at set",           typeof executed.executed_at === "number" && executed.executed_at > 0);

  // Verify orderTracking received one call per parcel with the right
  // rationale embedded in notes.
  check("executeSplit calls orderTracking 1x per parcel", ot.calls.length === 2);
  check("executeSplit notes parcel 1",
    ot.calls[0].input.notes === "split:in_stock (1/2)" &&
    ot.calls[0].input.carrier === "ups");
  check("executeSplit notes parcel 2",
    ot.calls[1].input.notes === "split:backordered (2/2)" &&
    ot.calls[1].input.carrier === "ups");

  // Shipment rows landed in the DB
  var shipRows = (await q("SELECT * FROM shipments WHERE order_id = ?1 ORDER BY created_at ASC",
    [seeded.order_id])).rows;
  check("executeSplit wrote 2 shipments rows",    shipRows.length === 2);

  // Re-executing a non-proposed plan is refused
  await assert.rejects(svc.executeSplit({ order_id: seeded.order_id, plan: executed }),
    /only proposed plans can be executed/);

  // carrier='other' auto-fills carrier_other_name when missing
  var seeded2 = await _seedOrder(q, [{ sku: "WDG-9", qty: 1 }]);
  var svc2 = splitShipments.create({
    query: q, order: _stubOrder(seeded2), orderTracking: ot,
    backorder: _stubBackorder({}),
  });
  var p2 = await svc2.planSplit({ order_id: seeded2.order_id, strategy: "availability" });
  var e2 = await svc2.executeSplit({ order_id: seeded2.order_id, plan: p2 });
  check("executeSplit default carrier=other",     ot.calls[ot.calls.length - 1].input.carrier === "other");
  check("executeSplit auto-fills carrier_other_name",
    ot.calls[ot.calls.length - 1].input.carrier_other_name === "split-shipment-pending");
  void e2;

  // Plan-belongs-to-different-order refusal
  var seededOther = await _seedOrder(q, [{ sku: "WDG-7", qty: 1 }]);
  var planOther = await svc2.planSplit({
    order_id:   seeded2.order_id,
    strategy:   "manual",
    manualPlan: [{ lines: [{ line_id: seeded2.lines[0].id, qty: 1 }] }],
  });
  await assert.rejects(svc2.executeSplit({ order_id: seededOther.order_id, plan: planOther }),
    /belongs to a different order/);
}

// ----- mergeShipments --------------------------------------------------

async function _mergeShipmentsCombines() {
  var q = _makeQuery();
  var seeded = await _seedOrder(q, [
    { sku: "WDG-1", qty: 1 },
    { sku: "WDG-2", qty: 1 },
    { sku: "WDG-3", qty: 1 },
  ]);
  var ot  = _stubOrderTracking(q);
  var svc = splitShipments.create({
    query: q, order: _stubOrder(seeded), orderTracking: ot,
    backorder: _stubBackorder({ "WDG-2": [seeded.order_id], "WDG-3": [seeded.order_id] }),
  });

  var plan = await svc.planSplit({ order_id: seeded.order_id, strategy: "availability" });
  var executed = await svc.executeSplit({ order_id: seeded.order_id, plan: plan });
  check("mergeShipments precondition: 2 shipment ids", executed.shipment_ids.length === 2);

  var target = executed.shipment_ids[0];
  var source = executed.shipment_ids[1];

  var result = await svc.mergeShipments({
    source_shipment_ids: [source],
    target_shipment_id:  target,
  });
  check("mergeShipments returns target",        result.target_shipment_id === target);
  check("mergeShipments returns sources",       result.merged_source_ids.length === 1 &&
    result.merged_source_ids[0] === source);
  check("mergeShipments timestamps",            typeof result.merged_at === "number" && result.merged_at > 0);

  // Source row's notes get the merged-into marker (preserves audit
  // trail rather than deleting the row).
  var srcRow = (await q("SELECT * FROM shipments WHERE id = ?1", [source])).rows[0];
  check("source shipment notes marker",         srcRow.notes.indexOf("merged-into:" + target) !== -1);

  // Plan row's executed_shipment_ids_json rewritten to drop the
  // source id.
  var after = await svc.splitsForOrder(seeded.order_id);
  check("plan shipment_ids rewritten after merge",
    after[0].shipment_ids.length === 1 && after[0].shipment_ids[0] === target);

  // Refusals
  await assert.rejects(svc.mergeShipments({ source_shipment_ids: [], target_shipment_id: target }),
    /source_shipment_ids must be a non-empty/);
  await assert.rejects(svc.mergeShipments({
    source_shipment_ids: [target], target_shipment_id: target,
  }), /must not contain target_shipment_id/);
  await assert.rejects(svc.mergeShipments({
    source_shipment_ids: ["01999999-9999-7999-8999-999999999999"], target_shipment_id: target,
  }), /source shipment .* not found/);

  // target from a different order should refuse
  var seeded2 = await _seedOrder(q, [{ sku: "WDG-X", qty: 1 }]);
  var svc2 = splitShipments.create({
    query: q, order: _stubOrder(seeded2), orderTracking: ot, backorder: _stubBackorder({}),
  });
  var p2 = await svc2.planSplit({ order_id: seeded2.order_id, strategy: "availability" });
  var e2 = await svc2.executeSplit({ order_id: seeded2.order_id, plan: p2 });
  var foreignTarget = e2.shipment_ids[0];
  await assert.rejects(svc.mergeShipments({
    source_shipment_ids: [target], target_shipment_id: foreignTarget,
  }), /different order/);
}

// ----- splitsForOrder --------------------------------------------------

async function _splitsForOrderReadsPlans() {
  var q = _makeQuery();
  var seeded = await _seedOrder(q, [{ sku: "WDG-1", qty: 1 }]);
  var ot  = _stubOrderTracking(q);
  var svc = splitShipments.create({
    query: q, order: _stubOrder(seeded), orderTracking: ot, backorder: _stubBackorder({}),
  });

  // No plans yet
  var empty = await svc.splitsForOrder(seeded.order_id);
  check("splitsForOrder empty before any plan",  Array.isArray(empty) && empty.length === 0);

  var plan1 = await svc.planSplit({ order_id: seeded.order_id, strategy: "availability" });
  var plan2 = await svc.planSplit({
    order_id: seeded.order_id, strategy: "manual",
    manualPlan: [{ lines: [{ line_id: seeded.lines[0].id, qty: 1 }] }],
  });
  var executed1 = await svc.executeSplit({ order_id: seeded.order_id, plan: plan1 });

  var list = await svc.splitsForOrder(seeded.order_id);
  check("splitsForOrder returns both plans",     list.length === 2);
  // v7 uuids sort lexicographically by creation; DESC = newest first.
  check("splitsForOrder newest first",           list[0].id === plan2.id && list[1].id === plan1.id);
  check("splitsForOrder hydrates executed",      list[1].status === "executed" &&
    list[1].shipment_ids.length === 1 && list[1].shipment_ids[0] === executed1.shipment_ids[0]);
  check("splitsForOrder hydrates proposed",      list[0].status === "proposed" &&
    list[0].shipment_ids.length === 0);

  // cancelPlan flips the proposed plan and splitsForOrder reflects it
  await svc.cancelPlan(plan2.id);
  var listAfter = await svc.splitsForOrder(seeded.order_id);
  check("splitsForOrder reflects cancellation",  listAfter[0].status === "cancelled" &&
    typeof listAfter[0].cancelled_at === "number");

  // Refusal — bad uuid shape
  await assert.rejects(svc.splitsForOrder("not-a-uuid"), /order_id/);
}

// ----- recommendStrategy ----------------------------------------------

async function _recommendStrategyHeuristic() {
  var q = _makeQuery();

  // (1) Mix of in-stock + backordered lines + backorder wired
  //     → 'availability'
  var seededA = await _seedOrder(q, [
    { sku: "WDG-1", qty: 1 },
    { sku: "WDG-2", qty: 1 },
  ]);
  var svcA = splitShipments.create({
    query: q, order: _stubOrder(seededA),
    orderTracking: _stubOrderTracking(q),
    backorder: _stubBackorder({ "WDG-2": [seededA.order_id] }),
  });
  check("recommend availability when mix",
    (await svcA.recommendStrategy(seededA.order_id)) === "availability");

  // (2) Multi-vendor order, no backorder mix → 'vendor'
  var seededV = await _seedOrder(q, [
    { sku: "VEN-A", qty: 1 },
    { sku: "VEN-B", qty: 1 },
  ]);
  var svcV = splitShipments.create({
    query: q, order: _stubOrder(seededV),
    orderTracking: _stubOrderTracking(q),
    backorder: _stubBackorder({}),
    vendors:   _stubVendors({
      "VEN-A": { slug: "acme" },
      "VEN-B": { slug: "globex" },
    }),
  });
  check("recommend vendor when multi-vendor",
    (await svcV.recommendStrategy(seededV.order_id)) === "vendor");

  // (3) Single-vendor order, multi-location routing → 'location'
  var seededL = await _seedOrder(q, [
    { sku: "LOC-1", qty: 2 },
    { sku: "LOC-2", qty: 1 },
  ]);
  var svcL = splitShipments.create({
    query: q, order: _stubOrder(seededL),
    orderTracking: _stubOrderTracking(q),
    backorder: _stubBackorder({}),
    vendors:   _stubVendors({
      "LOC-1": { slug: "house" },
      "LOC-2": { slug: "house" },
    }),
    inventoryLocations: _stubInventoryLocations({
      allocation: [
        { location_code: "WH-EAST", lines: [{ sku: "LOC-1", quantity: 2 }] },
        { location_code: "WH-WEST", lines: [{ sku: "LOC-2", quantity: 1 }] },
      ],
      unfulfillable: [],
    }),
  });
  check("recommend location when multi-location",
    (await svcL.recommendStrategy(seededL.order_id)) === "location");

  // (4) Nothing signals a split → 'manual'
  var seededM = await _seedOrder(q, [{ sku: "PLAIN", qty: 1 }]);
  var svcM = splitShipments.create({
    query: q, order: _stubOrder(seededM),
    orderTracking: _stubOrderTracking(q),
    backorder: _stubBackorder({}),
    vendors:   _stubVendors({ "PLAIN": { slug: "house" } }),
    inventoryLocations: _stubInventoryLocations({
      allocation: [{ location_code: "WH-EAST", lines: [{ sku: "PLAIN", quantity: 1 }] }],
      unfulfillable: [],
    }),
  });
  check("recommend manual when no split signal",
    (await svcM.recommendStrategy(seededM.order_id)) === "manual");

  // (5) routeOrder throwing falls through cleanly to 'manual' rather
  //     than surfacing the routing-layer error.
  var seededR = await _seedOrder(q, [{ sku: "RTERR", qty: 1 }]);
  var svcR = splitShipments.create({
    query: q, order: _stubOrder(seededR),
    orderTracking: _stubOrderTracking(q),
    inventoryLocations: {
      routeOrder: async function () { throw new Error("no active locations"); },
    },
  });
  check("recommend manual when routeOrder throws",
    (await svcR.recommendStrategy(seededR.order_id)) === "manual");

  // Refusals
  await assert.rejects(svcA.recommendStrategy("not-a-uuid"), /order_id/);
  await assert.rejects(svcA.recommendStrategy(b.uuid.v7()),  /not found/);
}

// ----- factory + input validation refusals -----------------------------

async function _factoryAndInputRefusals() {
  var q = _makeQuery();

  // Factory: orderTracking is the only hard requirement.
  assert.throws(function () { splitShipments.create({}); },
    /orderTracking with createShipment\(\) required/);
  assert.throws(function () { splitShipments.create({ orderTracking: {} }); },
    /orderTracking with createShipment\(\) required/);
  assert.throws(function () {
    splitShipments.create({ orderTracking: { createShipment: function () {} },
      order: {} });
  }, /opts\.order must expose a get/);
  assert.throws(function () {
    splitShipments.create({ orderTracking: { createShipment: function () {} },
      backorder: {} });
  }, /opts\.backorder must expose pendingForSku/);
  assert.throws(function () {
    splitShipments.create({ orderTracking: { createShipment: function () {} },
      inventoryLocations: {} });
  }, /opts\.inventoryLocations must expose routeOrder/);
  assert.throws(function () {
    splitShipments.create({ orderTracking: { createShipment: function () {} },
      vendors: {} });
  }, /opts\.vendors must expose vendorForSku/);

  // Exposed constants
  var svc = splitShipments.create({
    query: q, orderTracking: { createShipment: async function () { return { id: b.uuid.v7() }; } },
  });
  check("STRATEGIES exposed",       Array.isArray(svc.STRATEGIES) && svc.STRATEGIES.length === 4);
  check("STATUSES exposed",         Array.isArray(svc.STATUSES) && svc.STATUSES.length === 3);

  // planSplit: input refusals
  await assert.rejects(svc.planSplit(),                                 /input object required/);
  await assert.rejects(svc.planSplit({}),                               /order_id/);
  await assert.rejects(svc.planSplit({ order_id: "nope" }),             /order_id/);
  await assert.rejects(svc.planSplit({
    order_id: b.uuid.v7(), strategy: "bogus",
  }), /strategy must be one of/);

  // Unknown but well-formed order id — falls through to the SQL read,
  // which returns null → "order not found".
  await assert.rejects(svc.planSplit({
    order_id: b.uuid.v7(), strategy: "manual", manualPlan: [{ lines: [] }],
  }), /not found/);

  // Seed an order so the manual-strategy entry refusals hit AFTER the
  // order is found (exercises the strategy-arg validators rather than
  // the precondition path).
  var seeded = await _seedOrder(q, [{ sku: "WDG-1", qty: 1 }]);
  var svc2 = splitShipments.create({
    query: q, order: _stubOrder(seeded),
    orderTracking: { createShipment: async function () { return { id: b.uuid.v7() }; } },
  });
  await assert.rejects(svc2.planSplit({
    order_id: seeded.order_id, strategy: "manual",
    manualPlan: [{ lines: [{ line_id: seeded.lines[0].id, qty: 0 }] }],
  }), /qty must be a positive integer/);
  await assert.rejects(svc2.planSplit({
    order_id: seeded.order_id, strategy: "manual",
    manualPlan: [{ lines: [{ line_id: "not-a-uuid", qty: 1 }] }],
  }), /line_id/);

  // executeSplit: input refusals
  await assert.rejects(svc2.executeSplit(),                                          /input object required/);
  await assert.rejects(svc2.executeSplit({}),                                        /order_id/);
  await assert.rejects(svc2.executeSplit({ order_id: seeded.order_id }),             /plan object required/);
  await assert.rejects(svc2.executeSplit({
    order_id: seeded.order_id, plan: { id: "not-a-uuid" },
  }), /plan\.id/);
  await assert.rejects(svc2.executeSplit({
    order_id: seeded.order_id, plan: { id: b.uuid.v7() },
  }), /plan .* not found/);

  // mergeShipments: input refusals
  await assert.rejects(svc2.mergeShipments(),                                        /input object required/);
  await assert.rejects(svc2.mergeShipments({ target_shipment_id: b.uuid.v7() }),     /source_shipment_ids/);

  // cancelPlan refusals
  await assert.rejects(svc2.cancelPlan("not-a-uuid"),                                /plan_id/);
  await assert.rejects(svc2.cancelPlan(b.uuid.v7()),                                 /plan .* not found/);

  // Order with zero lines (paid but un-itemized) → planSplit refuses
  var orderlessId = b.uuid.v7();
  var ts = Date.now();
  await q(
    "INSERT INTO orders (id, cart_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'paid', 'USD', 0, 0, 0, 0, 0, '{}', ?4, ?4)",
    [orderlessId, b.uuid.v7(), b.uuid.v7(), ts],
  );
  await assert.rejects(svc.planSplit({
    order_id: orderlessId, strategy: "manual",
    manualPlan: [{ lines: [{ line_id: b.uuid.v7(), qty: 1 }] }],
  }), /has no order_lines/);
}

async function run() {
  await _planSplitAvailability();
  await _planSplitLocation();
  await _planSplitManual();
  await _executeSplitWritesShipments();
  await _mergeShipmentsCombines();
  await _splitsForOrderReadsPlans();
  await _recommendStrategyHeuristic();
  await _factoryAndInputRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("split-shipments: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
