"use strict";
/**
 * pick-lists — warehouse fulfillment worksheet that consolidates N
 * open orders into an aisle-sequenced picker route.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0003
 * (orders + order_lines) and migration 0118 (pick_lists +
 * pick_list_lines). The order + orderTracking composition deps are
 * stubbed so the FSM coverage focuses on the pick-list primitive
 * itself: the orderTracking stub captures every createShipment fan-
 * out, and the order stub returns whatever the test seeded into the
 * in-memory orders + order_lines tables (the SQL is the source of
 * truth — the stub is a thin pass-through so the schema gates still
 * fire on bad data).
 *
 * Coverage:
 *   - generateList: aisle sort with binForSku resolver + sku-fallback
 *     when inventoryLocations isn't wired
 *   - generateList: sort_by enum produces stable orderings
 *     (aisle / sku / priority / order_id)
 *   - generateList: max_lines cap truncates downstream orders
 *   - generateList: auto-select from eligible-state queue when
 *     order_ids omitted
 *   - generateList: refusals (bad input, missing order, ineligible
 *     order state, duplicate order_id)
 *   - confirmLine: stamps actual / picker / picked_at, transitions
 *     generated -> in_progress on first confirm, idempotent re-confirm
 *   - markListComplete: refuses when any line is unconfirmed,
 *     transitions in_progress -> complete, fans out one shipment per
 *     parent order via the orderTracking stub
 *   - cancelList: refuses without a reason, transitions
 *     generated|in_progress -> cancelled, refused on complete
 *   - discrepanciesFor: zero / short / over picks all surface
 *   - factory refusals: missing order, missing orderTracking
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// Require the modules directly so this test stays independent of any
// lib/index.js export ordering — the operator wires the primitive
// into the package surface manually after the patch lands.
var pickLists = require("../../lib/pick-lists");
var bShop     = require("../../lib/index");
var b         = bShop.framework;

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0118_pick_lists.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // 0003 references carts(id) as a FK — orders rows seeded by the
  // test don't have a matching carts row, so the test runs with FK
  // enforcement OFF (matches the posture of split-shipments.test.js,
  // which seeds the same orders table without a carts parent).
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

// Seed one order + N order_lines. Status defaults to 'paid' so the
// order is eligible for pick-list consolidation; tests that need
// other statuses pass them explicitly.
async function _seedOrder(q, lineSpecs, statusOpt) {
  var orderId = b.uuid.v7();
  var ts = Date.now();
  var status = statusOpt || "paid";
  await q(
    "INSERT INTO orders (id, cart_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'USD', 0, 0, 0, 0, 0, '{}', ?5, ?5)",
    [orderId, b.uuid.v7(), b.uuid.v7(), status, ts],
  );
  var lines = [];
  for (var i = 0; i < lineSpecs.length; i += 1) {
    var spec = lineSpecs[i];
    var lid = b.uuid.v7();
    await q(
      "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, " +
      "unit_amount_minor, unit_currency, line_total_minor) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 0, 'USD', 0)",
      [lid, orderId, spec.variant_id || b.uuid.v7(), spec.sku, spec.qty],
    );
    lines.push({ id: lid, sku: spec.sku, qty: spec.qty });
  }
  return { order_id: orderId, status: status, lines: lines };
}

// Thin order primitive stub — reads the seeded data directly off the
// in-memory DB so the SQL schema gates (CHECK enums, NOT NULL,
// etc.) still fire on bad seed data. Matches the real
// `order.get(id)` shape: `{ id, status, lines: [{ sku, qty,
// variant_id }] }`.
function _stubOrder(q) {
  return {
    get: async function (id) {
      var rows = (await q("SELECT * FROM orders WHERE id = ?1", [id])).rows;
      if (!rows.length) return null;
      var o = rows[0];
      o.lines = (await q("SELECT * FROM order_lines WHERE order_id = ?1 ORDER BY id ASC", [id])).rows;
      return o;
    },
  };
}

// orderTracking stub — captures every createShipment fan-out so the
// test can assert per-order coverage + returns deterministic uuid-v7
// shipment ids the markListComplete result echoes back. The stub mirrors
// the real primitive's carrier contract (the enum + the
// carrier_other_name-required-when-'other' rule) so the fan-out is
// exercised against the production shape, not a permissive mock that
// would let an invalid carrier slip through.
var _OT_CARRIERS = ["ups", "fedex", "usps", "dhl", "royal-mail", "canada-post", "australia-post", "other"];
function _stubOrderTracking() {
  var calls = [];
  return {
    calls: calls,
    createShipment: async function (input) {
      if (_OT_CARRIERS.indexOf(input.carrier) === -1) {
        throw new TypeError("order-tracking.createShipment: carrier must be one of " + _OT_CARRIERS.join(", "));
      }
      if (input.carrier === "other" && (typeof input.carrier_other_name !== "string" || !input.carrier_other_name.length)) {
        throw new TypeError("order-tracking.createShipment: carrier_other_name required when carrier='other'");
      }
      var id = b.uuid.v7();
      calls.push({ id: id, input: input });
      return { id: id, order_id: input.order_id, status: "pending" };
    },
  };
}

// inventoryLocations stub exposing the optional `binForSku` verb the
// primitive probes for. Returns whatever the operator maps in;
// missing entries fall back to the sku itself (the primitive's
// default path).
function _stubInventoryLocations(binMap) {
  return {
    binForSku: async function (sku, _locationCode) {
      return Object.prototype.hasOwnProperty.call(binMap, sku) ? binMap[sku] : null;
    },
  };
}

async function _generateAisleSortHappyPath() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  // Bin map crosses two aisles — WDG-1 in aisle 1, WDG-2 in aisle 3,
  // WDG-3 in aisle 2 — so the aisle sort interleaves SKUs from the
  // same order in walk order.
  var locs = _stubInventoryLocations({
    "WDG-1": "A1-B01",
    "WDG-2": "A3-B05",
    "WDG-3": "A2-B02",
  });
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot, inventoryLocations: locs,
  });
  var oA = await _seedOrder(q, [
    { sku: "WDG-1", qty: 2 },
    { sku: "WDG-2", qty: 1 },
  ]);
  var oB = await _seedOrder(q, [
    { sku: "WDG-3", qty: 3 },
    { sku: "WDG-1", qty: 1 },
  ]);

  var list = await svc.generateList({
    location_code: "WH-EAST",
    order_ids: [oA.order_id, oB.order_id],
    // sort_by defaults to aisle
  });

  check("generateList returns id",         typeof list.id === "string" && list.id.length > 0);
  check("generateList status=generated",   list.status === "generated");
  check("generateList location captured",  list.location_code === "WH-EAST");
  check("generateList sort_by default",    list.sort_by === "aisle");
  check("generateList generated_at",       typeof list.generated_at === "number" && list.generated_at > 0);
  check("generateList line count = 4",     list.lines.length === 4);

  // Aisle order: A1-B01 (WDG-1 x2), A2-B02 (WDG-3), A3-B05 (WDG-2).
  // Two WDG-1 lines (one per order) collide on aisle position; the
  // secondary sort is sku ASC then order_id ASC, but both lines share
  // sku so it's order_id ASC.
  check("aisle row 0 = A1-B01",            list.lines[0].aisle_position === "A1-B01");
  check("aisle row 1 = A1-B01",            list.lines[1].aisle_position === "A1-B01");
  check("aisle row 2 = A2-B02",            list.lines[2].aisle_position === "A2-B02");
  check("aisle row 3 = A3-B05",            list.lines[3].aisle_position === "A3-B05");
  check("aisle row 2 sku",                 list.lines[2].sku === "WDG-3");
  check("aisle row 3 sku",                 list.lines[3].sku === "WDG-2");
  check("aisle row 0 expected_quantity",   list.lines[0].expected_quantity === 1 || list.lines[0].expected_quantity === 2);
  check("aisle row actual_quantity null",  list.lines[0].actual_quantity == null);
  check("aisle row picked_at null",        list.lines[0].picked_at == null);
}

async function _generateSortByEnum() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
    // No inventoryLocations wired — aisle_position falls back to sku
  });
  // Seed orders. Use a deterministic order so we can assert exact
  // sequences. Order A has sku "AAA" + "CCC"; Order B has sku "BBB".
  var oA = await _seedOrder(q, [
    { sku: "AAA", qty: 1 },
    { sku: "CCC", qty: 1 },
  ]);
  var oB = await _seedOrder(q, [{ sku: "BBB", qty: 2 }]);

  // sort_by=sku → alphabetic sku ordering: AAA, BBB, CCC
  var bySku = await svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id, oB.order_id],
    sort_by: "sku",
  });
  check("sort_by sku row 0",               bySku.lines[0].sku === "AAA");
  check("sort_by sku row 1",               bySku.lines[1].sku === "BBB");
  check("sort_by sku row 2",               bySku.lines[2].sku === "CCC");
  check("sort_by sku fallback aisle=sku",  bySku.lines[0].aisle_position === "AAA");

  // sort_by=priority → operator's order_id sequence wins. We pass
  // [oB, oA] so oB's lines come first.
  var byPrio = await svc.generateList({
    location_code: "WH",
    order_ids: [oB.order_id, oA.order_id],
    sort_by: "priority",
  });
  check("sort_by priority row 0 = oB",     byPrio.lines[0].order_id === oB.order_id);
  check("sort_by priority row 0 sku",      byPrio.lines[0].sku === "BBB");
  check("sort_by priority row 1 = oA",     byPrio.lines[1].order_id === oA.order_id);

  // sort_by=order_id → lexicographic on order_id (uuid v7 is
  // chronologically sortable so the older order sorts first).
  var byOid = await svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id, oB.order_id],
    sort_by: "order_id",
  });
  // Whichever id is lexicographically smaller comes first.
  var firstExpected = oA.order_id < oB.order_id ? oA.order_id : oB.order_id;
  check("sort_by order_id row 0",          byOid.lines[0].order_id === firstExpected);

  // Refusal: bad sort_by enum
  await assert.rejects(svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id],
    sort_by: "bogus",
  }), /sort_by/);
}

async function _generateMaxLinesCap() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
  });
  // Three orders, each with two lines = 6 total lines available.
  var oA = await _seedOrder(q, [{ sku: "A1", qty: 1 }, { sku: "A2", qty: 1 }]);
  var oB = await _seedOrder(q, [{ sku: "B1", qty: 1 }, { sku: "B2", qty: 1 }]);
  var oC = await _seedOrder(q, [{ sku: "C1", qty: 1 }, { sku: "C2", qty: 1 }]);

  // Cap at 3 lines — the third order is skipped entirely, and the
  // second order might be partially included depending on order.
  var list = await svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id, oB.order_id, oC.order_id],
    max_lines: 3,
    sort_by:   "priority",
  });
  check("max_lines cap truncates",         list.lines.length === 3);
  // Priority order: all of A's lines (2) + first of B's (1).
  // Confirm C is absent.
  var hasC = false;
  for (var i = 0; i < list.lines.length; i += 1) {
    if (list.lines[i].order_id === oC.order_id) hasC = true;
  }
  check("max_lines drops downstream order", !hasC);

  // Refusal: bad max_lines
  await assert.rejects(svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id],
    max_lines: 0,
  }), /max_lines/);
  await assert.rejects(svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id],
    max_lines: 999999,
  }), /max_lines/);
}

async function _generateAutoSelect() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
  });
  // Mix eligible + ineligible orders.
  var oPaid       = await _seedOrder(q, [{ sku: "P1", qty: 1 }], "paid");
  var oFulfilling = await _seedOrder(q, [{ sku: "F1", qty: 1 }], "fulfilling");
  await _seedOrder(q, [{ sku: "S1", qty: 1 }], "shipped");      // ineligible
  await _seedOrder(q, [{ sku: "X1", qty: 1 }], "cancelled");    // ineligible

  var list = await svc.generateList({
    location_code: "WH",
  });
  check("auto-select picks 2 lines",       list.lines.length === 2);
  var orderIdsSeen = {};
  list.lines.forEach(function (l) { orderIdsSeen[l.order_id] = true; });
  check("auto-select includes paid",       orderIdsSeen[oPaid.order_id]);
  check("auto-select includes fulfilling", orderIdsSeen[oFulfilling.order_id]);

  // No eligible orders → refusal.
  var q2 = _makeQuery();
  var svc2 = pickLists.create({
    query: q2, order: _stubOrder(q2), orderTracking: _stubOrderTracking(),
  });
  await _seedOrder(q2, [{ sku: "X", qty: 1 }], "shipped");
  await assert.rejects(svc2.generateList({ location_code: "WH" }),                         /no eligible orders/);
}

async function _generateRefusals() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
  });
  var oPaid     = await _seedOrder(q, [{ sku: "A", qty: 1 }], "paid");
  var oShipped  = await _seedOrder(q, [{ sku: "B", qty: 1 }], "shipped");

  await assert.rejects(svc.generateList(),                                                 /input object required/);
  await assert.rejects(svc.generateList({}),                                               /location_code/);
  await assert.rejects(svc.generateList({ location_code: "" }),                            /location_code/);
  await assert.rejects(svc.generateList({ location_code: "WH", order_ids: [] }),           /non-empty array/);
  // Missing order
  await assert.rejects(svc.generateList({
    location_code: "WH",
    order_ids: ["01999999-9999-7999-8999-999999999999"],
  }), /not found/);
  // Ineligible state
  await assert.rejects(svc.generateList({
    location_code: "WH",
    order_ids: [oShipped.order_id],
  }), /status shipped/);
  // Duplicate order_id
  await assert.rejects(svc.generateList({
    location_code: "WH",
    order_ids: [oPaid.order_id, oPaid.order_id],
  }), /duplicate order_id/);
}

async function _confirmLineFsm() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
  });
  var oA = await _seedOrder(q, [
    { sku: "A1", qty: 2 },
    { sku: "A2", qty: 5 },
  ]);
  var list = await svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id],
    sort_by: "sku",
  });
  check("FSM start status",                list.status === "generated");

  // Confirm line 0 — clean pick (actual_quantity omitted defaults to expected)
  var line0 = list.lines[0];
  var l1 = await svc.confirmLine({
    list_id:   list.id,
    line_id:   line0.id,
    picker_id: "picker-42",
  });
  check("FSM transition on first confirm", l1.status === "in_progress");
  var ln0 = l1.lines.filter(function (x) { return x.id === line0.id; })[0];
  check("confirmLine actual=expected",     ln0.actual_quantity === line0.expected_quantity);
  check("confirmLine picker stamped",      ln0.picked_by === "picker-42");
  check("confirmLine picked_at stamped",   typeof ln0.picked_at === "number" && ln0.picked_at > 0);

  // Confirm line 1 — short pick (actual_quantity explicit 3 of 5)
  var line1 = list.lines[1];
  var l2 = await svc.confirmLine({
    list_id:         list.id,
    line_id:         line1.id,
    picker_id:       "picker-42",
    actual_quantity: 3,
  });
  var ln1 = l2.lines.filter(function (x) { return x.id === line1.id; })[0];
  check("confirmLine short pick stamped",  ln1.actual_quantity === 3);
  check("FSM remains in_progress",         l2.status === "in_progress");

  // Re-confirm line 0 with a different value (recount).
  var l3 = await svc.confirmLine({
    list_id:         list.id,
    line_id:         line0.id,
    picker_id:       "picker-99",
    actual_quantity: 2,
  });
  var ln0b = l3.lines.filter(function (x) { return x.id === line0.id; })[0];
  check("confirmLine recount overwrites",  ln0b.actual_quantity === 2);
  check("confirmLine recount picker",      ln0b.picked_by === "picker-99");

  // Refusals
  await assert.rejects(svc.confirmLine(),                                                  /input object required/);
  await assert.rejects(svc.confirmLine({ list_id: list.id, line_id: line0.id }),           /picker_id/);
  // Line not on the list
  await assert.rejects(svc.confirmLine({
    list_id: list.id,
    line_id: b.uuid.v7(),
    picker_id: "p",
  }), /not on list/);
  // Negative actual_quantity
  await assert.rejects(svc.confirmLine({
    list_id: list.id,
    line_id: line0.id,
    picker_id: "p",
    actual_quantity: -1,
  }), /actual_quantity/);
}

async function _markCompleteAndFanOut() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
  });
  var oA = await _seedOrder(q, [{ sku: "A1", qty: 1 }, { sku: "A2", qty: 1 }]);
  var oB = await _seedOrder(q, [{ sku: "B1", qty: 1 }]);

  var list = await svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id, oB.order_id],
    sort_by: "priority",
  });
  check("markComplete preflight lines",    list.lines.length === 3);

  // Refuse markListComplete while lines are unconfirmed
  await assert.rejects(svc.markListComplete({ list_id: list.id }),                         /has not been confirmed/);

  // Confirm every line
  for (var i = 0; i < list.lines.length; i += 1) {
    await svc.confirmLine({
      list_id:   list.id,
      line_id:   list.lines[i].id,
      picker_id: "picker-1",
    });
  }

  var result = await svc.markListComplete({ list_id: list.id });
  check("markComplete status",             result.status === "complete");
  check("markComplete completed_at",       typeof result.completed_at === "number" && result.completed_at > 0);
  check("markComplete shipments len",      result.shipments.length === 2);

  // Each parent order got exactly one createShipment call
  var orderIds = result.shipments.map(function (s) { return s.order_id; }).sort();
  var seedOrderIds = [oA.order_id, oB.order_id].sort();
  check("markComplete fans out per order", orderIds[0] === seedOrderIds[0] && orderIds[1] === seedOrderIds[1]);
  check("orderTracking received 2 calls",  ot.calls.length === 2);
  check("orderTracking notes carry list",  ot.calls[0].input.notes === "pick-list:" + list.id);
  check("orderTracking carrier=other",     ot.calls[0].input.carrier === "other");
  check("orderTracking pickup label",      ot.calls[0].input.carrier_other_name === "pickup");

  // Refuse re-completing a complete list (the list is terminal)
  await assert.rejects(svc.markListComplete({ list_id: list.id }),                         /only generated or in_progress/);

  // Concurrency: two markListComplete callers racing on a freshly-
  // confirmed list must NOT both fan out shipments. The completion is
  // claimed by a conditional UPDATE (WHERE status IN
  // ('generated','in_progress')) before any createShipment fires, so
  // exactly one caller wins the claim and runs the fan-out; the loser
  // refuses. Without the atomic claim both callers pass the JS status
  // check and each create one shipment per parent order (double-create).
  var qC = _makeQuery();
  var otC = _stubOrderTracking();
  var svcC = pickLists.create({
    query: qC, order: _stubOrder(qC), orderTracking: otC,
  });
  var ocA = await _seedOrder(qC, [{ sku: "A1", qty: 1 }, { sku: "A2", qty: 1 }]);
  var ocB = await _seedOrder(qC, [{ sku: "B1", qty: 1 }]);
  var listC = await svcC.generateList({
    location_code: "WH", order_ids: [ocA.order_id, ocB.order_id], sort_by: "priority",
  });
  for (var ci = 0; ci < listC.lines.length; ci += 1) {
    await svcC.confirmLine({ list_id: listC.id, line_id: listC.lines[ci].id, picker_id: "p" });
  }
  var raced = await Promise.allSettled([
    svcC.markListComplete({ list_id: listC.id }),
    svcC.markListComplete({ list_id: listC.id }),
  ]);
  var fulfilled = raced.filter(function (r) { return r.status === "fulfilled"; });
  var rejected  = raced.filter(function (r) { return r.status === "rejected"; });
  check("race: exactly one markComplete wins", fulfilled.length === 1 && rejected.length === 1);
  // 2 parent orders => exactly 2 shipments total, never 4 (the
  // double-create the unguarded check-then-act would produce).
  check("race: no double shipment fan-out",    otC.calls.length === 2);
  check("race: winner returns 2 shipments",    fulfilled[0].value.shipments.length === 2);
  // Refuse cancelling a complete list
  await assert.rejects(svc.cancelList({ list_id: list.id, reason: "too late" }),           /only generated or in_progress/);
  // Refuse confirming on a complete list
  await assert.rejects(svc.confirmLine({
    list_id: list.id, line_id: list.lines[0].id, picker_id: "p",
  }), /only generated or in_progress/);
}

async function _cancelListPath() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
  });
  var oA = await _seedOrder(q, [{ sku: "A1", qty: 1 }]);
  var list = await svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id],
  });

  // Refusals: missing input, missing reason
  await assert.rejects(svc.cancelList(),                                                   /input object required/);
  await assert.rejects(svc.cancelList({ list_id: list.id }),                               /reason/);
  await assert.rejects(svc.cancelList({ list_id: list.id, reason: "" }),                   /reason/);

  // Cancel a generated list
  var cancelled = await svc.cancelList({
    list_id: list.id, reason: "shift ended early",
  });
  check("cancelList status",               cancelled.status === "cancelled");
  check("cancelList reason persisted",     cancelled.cancel_reason === "shift ended early");
  check("cancelList cancelled_at",         typeof cancelled.cancelled_at === "number" && cancelled.cancelled_at > 0);
  // Lines are retained for the audit trail
  check("cancelList retains lines",        cancelled.lines.length === 1);

  // Cannot confirm / re-complete / re-cancel a cancelled list
  await assert.rejects(svc.confirmLine({
    list_id: list.id, line_id: list.lines[0].id, picker_id: "p",
  }), /only generated or in_progress/);
  await assert.rejects(svc.markListComplete({ list_id: list.id }),                         /only generated or in_progress/);
  await assert.rejects(svc.cancelList({ list_id: list.id, reason: "again" }),              /only generated or in_progress/);

  // Cancel an in_progress list (confirm one line first)
  var oB = await _seedOrder(q, [{ sku: "B1", qty: 1 }]);
  var l2 = await svc.generateList({ location_code: "WH", order_ids: [oB.order_id] });
  await svc.confirmLine({ list_id: l2.id, line_id: l2.lines[0].id, picker_id: "p" });
  var l2c = await svc.cancelList({ list_id: l2.id, reason: "stock disappeared" });
  check("cancel in_progress -> cancelled", l2c.status === "cancelled");
}

async function _discrepanciesAndReads() {
  var q = _makeQuery();
  var ot = _stubOrderTracking();
  var svc = pickLists.create({
    query: q, order: _stubOrder(q), orderTracking: ot,
  });
  var oA = await _seedOrder(q, [
    { sku: "A1", qty: 5 },
    { sku: "A2", qty: 3 },
    { sku: "A3", qty: 2 },
  ]);
  var list = await svc.generateList({
    location_code: "WH",
    order_ids: [oA.order_id],
    sort_by: "sku",
  });

  // Pick: A1 clean (5), A2 short (1 of 3), A3 over (4 of 2)
  await svc.confirmLine({ list_id: list.id, line_id: list.lines[0].id, picker_id: "p", actual_quantity: 5 });
  await svc.confirmLine({ list_id: list.id, line_id: list.lines[1].id, picker_id: "p", actual_quantity: 1 });
  await svc.confirmLine({ list_id: list.id, line_id: list.lines[2].id, picker_id: "p", actual_quantity: 4 });

  var diffs = await svc.discrepanciesFor(list.id);
  check("discrepanciesFor count",          diffs.length === 3);
  var bySku = {};
  diffs.forEach(function (d) { bySku[d.sku] = d; });
  check("discrepanciesFor clean = 0",      bySku["A1"].discrepancy === 0);
  check("discrepanciesFor short = +2",     bySku["A2"].discrepancy === 2);
  check("discrepanciesFor over = -2",      bySku["A3"].discrepancy === -2);
  check("discrepanciesFor carries aisle",  typeof bySku["A1"].aisle_position === "string");

  // Unknown list_id → null (UUID shape gate fires on garbage)
  var miss = await svc.discrepanciesFor("01999999-9999-7999-8999-999999999999");
  check("discrepanciesFor miss = null",    miss === null);

  // getList: hydrated header + lines, null on miss
  var hyd = await svc.getList(list.id);
  check("getList hydrates lines",          hyd.lines.length === 3);
  var hydMiss = await svc.getList("01999999-9999-7999-8999-999999999999");
  check("getList miss = null",             hydMiss === null);

  // listLists: filter by status + location
  var byStatus = await svc.listLists({ status: "in_progress" });
  check("listLists status filter",         byStatus.length === 1 && byStatus[0].id === list.id);
  var byLoc = await svc.listLists({ location_code: "WH" });
  check("listLists location filter",       byLoc.length === 1 && byLoc[0].id === list.id);
  var byBoth = await svc.listLists({ location_code: "WH", status: "complete" });
  check("listLists no match = empty",      byBoth.length === 0);

  // listLists refusals
  await assert.rejects(svc.listLists({ status: "bogus" }),                                 /status/);
  await assert.rejects(svc.listLists({ location_code: "" }),                               /location_code/);
}

async function _factoryRefusals() {
  // Missing order
  assert.throws(function () { pickLists.create({}); },                                     /order/);
  assert.throws(function () { pickLists.create({ order: null }); },                        /order/);
  // Missing orderTracking
  assert.throws(function () {
    pickLists.create({ order: { get: function () {} } });
  }, /orderTracking/);
  // orderTracking missing createShipment
  assert.throws(function () {
    pickLists.create({
      order:         { get: function () {} },
      orderTracking: { foo: function () {} },
    });
  }, /orderTracking/);
}

async function run() {
  await _generateAisleSortHappyPath();
  await _generateSortByEnum();
  await _generateMaxLinesCap();
  await _generateAutoSelect();
  await _generateRefusals();
  await _confirmLineFsm();
  await _markCompleteAndFanOut();
  await _cancelListPath();
  await _discrepanciesAndReads();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("pick-lists: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
