"use strict";
/**
 * click-and-collect — buy-online-pickup-in-store (BOPIS) schedule
 * + signature capture + FSM.
 *
 * Layer 1 against in-memory node:sqlite with migration 0126 loaded.
 * The order + notifications + inventoryLocations dependencies are all
 * stubbed locally so this test exercises the primitive in isolation
 * (compositional wiring is covered by the smoke suite).
 *
 * Coverage:
 *   - definePickupLocation create + update + activity flag
 *   - availableLocations active filter + sku filter via injected
 *     inventoryLocations stub
 *   - scheduleAtLocation happy path + capacity gate refusal + lead-
 *     time refusal + degenerate window refusal + unknown location +
 *     re-schedule of an existing row
 *   - FSM transitions: scheduled -> ready -> picked_up writes
 *     timestamps + signature hash + proof kind; markPickedUp drives
 *     the parent order via the injected order stub
 *   - markReadyForPickup enqueues a notification through the injected
 *     stub; notification dispatch failures don't roll back the FSM
 *   - markPickedUp signature_hash deterministic via namespaceHash;
 *     raw signature never persists
 *   - markNoShow happy path + 7-day escalate_after stamp + terminal
 *     refusal
 *   - pickupsForLocation window + status filter
 *   - customerSchedules requires order wiring + reads through
 *     listForCustomer
 *   - factory refusals: bad order / notifications / inventoryLocations
 *     shapes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var clickAndCollect = require("../../lib/click-and-collect");
var bShop           = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0126_click_and_collect.sql");

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

// Simple notifications stub — captures every enqueue so the test can
// assert the recipient + payload shape without wiring the real
// notifications primitive (which carries its own migration footprint).
function _notificationsStub(opts) {
  opts = opts || {};
  var calls = [];
  return {
    enqueue: async function (input) {
      if (opts.fail) throw new Error("notifications-down");
      calls.push(input);
      return { ok: true, id: "notif-" + calls.length };
    },
    calls: calls,
  };
}

// Simple order stub — captures transition() calls and answers
// listForCustomer from an operator-supplied map.
function _orderStub(opts) {
  opts = opts || {};
  var transitions = [];
  var byCustomer = opts.byCustomer || {};
  return {
    transition: async function (id, event, meta) {
      if (opts.transitionThrows) {
        var e = new Error("fsm illegal");
        e.code = opts.transitionThrows;
        throw e;
      }
      transitions.push({ id: id, event: event, meta: meta });
      return { id: id, status: "delivered" };
    },
    listForCustomer: async function (customerId /* , listOpts */) {
      var rows = byCustomer[customerId] || [];
      return { rows: rows, next_cursor: null };
    },
    transitions: transitions,
  };
}

// Simple inventoryLocations stub — exposes stockForSku in the shape
// the primitive expects.
function _invLocationsStub(stockMap) {
  return {
    stockForSku: async function (sku) {
      var rows = stockMap[sku] || [];
      return { sku: sku, by_location: rows };
    },
  };
}

// A handful of valid UUIDv7 strings the tests reuse. b.uuid.v7
// returns a fresh value on every call so we can't lift them to
// module scope.
function _orderId() { return bShop.framework.uuid.v7(); }
function _customerId() { return bShop.framework.uuid.v7(); }

var FUTURE_BASE = Date.now() + 48 * 3600 * 1000;     // 48h from now
var HOUR_MS     = 3600 * 1000;

function _validAddress() {
  return { line1: "123 High St", city: "Bristol", country: "GB" };
}
function _validHours() {
  return { mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" } };
}

async function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var svc = clickAndCollect.create({
    query:              q,
    order:              opts.order || null,
    inventoryLocations: opts.inventoryLocations || null,
    notifications:      opts.notifications || null,
  });
  return { q: q, svc: svc };
}

async function _definePickupLocation() {
  var w = await _wire();
  var loc = await w.svc.definePickupLocation({
    code: "STORE-NYC", name: "Manhattan Store",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 2,
  });
  check("definePickupLocation returns row",      loc && loc.code === "STORE-NYC");
  check("definePickupLocation active=1",         Number(loc.active) === 1);
  check("definePickupLocation archived_at null", loc.archived_at == null);
  check("definePickupLocation address parsed",   loc.address.city === "Bristol");
  check("definePickupLocation hours parsed",     loc.hours.mon && loc.hours.mon.open === "09:00");

  // Update in place — change capacity, hours stay
  var updated = await w.svc.definePickupLocation({
    code: "STORE-NYC", name: "Manhattan Flagship",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 8, lead_time_hours: 2,
  });
  check("definePickupLocation update name",     updated.name === "Manhattan Flagship");
  check("definePickupLocation update capacity", Number(updated.capacity_per_hour) === 8);

  // Inactive flag honoured
  var off = await w.svc.definePickupLocation({
    code: "STORE-LA", name: "LA Store",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 2, lead_time_hours: 1, active: false,
  });
  check("definePickupLocation active=false",    Number(off.active) === 0);

  // availableLocations excludes inactive
  var avail = await w.svc.availableLocations();
  check("availableLocations excludes inactive", avail.length === 1 && avail[0].code === "STORE-NYC");

  // Refusals
  await assert.rejects(w.svc.definePickupLocation(),                                    /input object required/);
  await assert.rejects(w.svc.definePickupLocation({}),                                  /code/);
  await assert.rejects(w.svc.definePickupLocation({ code: "STORE-NYC", name: "x",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 0, lead_time_hours: 0 }),                                        /capacity_per_hour/);
  await assert.rejects(w.svc.definePickupLocation({ code: "STORE-NYC", name: "x",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 1, lead_time_hours: -1 }),                                       /lead_time_hours/);
  await assert.rejects(w.svc.definePickupLocation({ code: "STORE-NYC", name: "x",
    address: { line1: "", city: "x", country: "GB" }, hours_json: _validHours(),
    capacity_per_hour: 1, lead_time_hours: 0 }),                                        /line1/);
  await assert.rejects(w.svc.definePickupLocation({ code: "STORE-NYC", name: "x",
    address: _validAddress(), hours_json: "not-an-object",
    capacity_per_hour: 1, lead_time_hours: 0 }),                                        /hours_json/);
}

async function _availableLocationsSkuFilter() {
  var inv = _invLocationsStub({
    "WDG-1": [
      { code: "STORE-NYC", quantity: 5 },
      { code: "STORE-LA",  quantity: 0 },
    ],
  });
  var w = await _wire({ inventoryLocations: inv });
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });
  await w.svc.definePickupLocation({ code: "STORE-LA",  name: "LA",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });

  // Without sku filter — both
  var all = await w.svc.availableLocations();
  check("availableLocations both active",   all.length === 2);

  // With sku filter — only the one with on-hand stock
  var withSku = await w.svc.availableLocations({ sku: "WDG-1" });
  check("availableLocations sku filter",    withSku.length === 1 && withSku[0].code === "STORE-NYC");

  // destination_postal accepted (no ranking yet, just shape gate)
  var withPostal = await w.svc.availableLocations({ destination_postal: "10001" });
  check("availableLocations postal accepted", withPostal.length === 2);

  // Postal-shape refusal
  await assert.rejects(w.svc.availableLocations({ destination_postal: "!!" }),         /destination_postal/);
  await assert.rejects(w.svc.availableLocations({ sku: "!!bad!!" }),                   /sku/);
  await assert.rejects(w.svc.availableLocations({ limit: 9999 }),                      /limit/);
}

async function _scheduleAtLocationCapacityAndLeadTime() {
  var w = await _wire();
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 2, lead_time_hours: 4 });

  // Lead-time floor refusal: scheduled inside the next 4 hours
  var soonStart = Date.now() + 60 * 1000;
  await assert.rejects(w.svc.scheduleAtLocation({
    order_id: _orderId(), location_code: "STORE-NYC",
    scheduled_window_start: soonStart, scheduled_window_end: soonStart + HOUR_MS,
  }), /lead time/);

  // Degenerate window refusal
  await assert.rejects(w.svc.scheduleAtLocation({
    order_id: _orderId(), location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE,
  }), /scheduled_window_end/);

  // Unknown location refusal
  await assert.rejects(w.svc.scheduleAtLocation({
    order_id: _orderId(), location_code: "NO-SUCH",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  }), /not found/);

  // Two slots in the same hour bucket — both succeed (capacity 2)
  var orderA = _orderId();
  var orderB = _orderId();
  var s1 = await w.svc.scheduleAtLocation({
    order_id: orderA, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + 1800 * 1000,
  });
  check("schedule A status",      s1.status === "scheduled");
  check("schedule A order_id",    s1.order_id === orderA);
  var s2 = await w.svc.scheduleAtLocation({
    order_id: orderB, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE + 1000, scheduled_window_end: FUTURE_BASE + 1000 + 1800 * 1000,
  });
  check("schedule B status",      s2.status === "scheduled");

  // Third slot in the same bucket — refused at capacity
  await assert.rejects(w.svc.scheduleAtLocation({
    order_id: _orderId(), location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE + 2000, scheduled_window_end: FUTURE_BASE + 2000 + 1800 * 1000,
  }), /at capacity/);

  // Re-scheduling order A in the same bucket — succeeds (capacity is
  // not double-counted on the same order)
  var s1b = await w.svc.scheduleAtLocation({
    order_id: orderA, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE + 500, scheduled_window_end: FUTURE_BASE + 500 + 1800 * 1000,
  });
  check("reschedule A same bucket", s1b.status === "scheduled" &&
                                    s1b.scheduled_window_start === FUTURE_BASE + 500);

  // Inactive location refuses scheduling
  await w.svc.definePickupLocation({ code: "STORE-OFF", name: "Closed",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 2, lead_time_hours: 0, active: false });
  await assert.rejects(w.svc.scheduleAtLocation({
    order_id: _orderId(), location_code: "STORE-OFF",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  }), /not active/);
}

async function _fsmTransitions() {
  var notif = _notificationsStub();
  var ord   = _orderStub();
  var w = await _wire({ order: ord, notifications: notif });
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });
  var orderId = _orderId();
  await w.svc.scheduleAtLocation({
    order_id: orderId, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  });

  // Cannot pick_up from scheduled (must go via ready)
  await assert.rejects(w.svc.markPickedUp({
    order_id: orderId, picked_up_at: Date.now(),
    signature: "x", customer_id_proof_kind: "driver_license",
  }), /only ready/);

  // markReadyForPickup enqueues a notification
  var readyTs = Date.now() + 1000;
  var ready = await w.svc.markReadyForPickup({ order_id: orderId, scheduled_for: readyTs });
  check("FSM ready status",                  ready.status === "ready");
  check("FSM ready_at captured",             Number(ready.ready_at) === readyTs);
  check("notification enqueued on ready",    notif.calls.length === 1);
  check("notification recipient = order",    notif.calls[0].recipient_id === orderId);
  check("notification channel",              notif.calls[0].channel === "pickup-ready");
  check("notification event_type",           notif.calls[0].event_type === "pickup_ready");
  check("notification payload location",     notif.calls[0].payload.location_code === "STORE-NYC");

  // Re-ready refused
  await assert.rejects(w.svc.markReadyForPickup({ order_id: orderId }),                 /only scheduled/);

  // markPickedUp captures signature_hash + proof + drives order FSM
  var pickedAt = Date.now() + 2000;
  var sigRaw   = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA";
  var done = await w.svc.markPickedUp({
    order_id: orderId, picked_up_at: pickedAt,
    signature: sigRaw, customer_id_proof_kind: "driver_license",
  });
  check("FSM picked_up status",              done.status === "picked_up");
  check("FSM picked_up_at captured",         Number(done.picked_up_at) === pickedAt);
  check("FSM proof_kind captured",           done.customer_id_proof_kind === "driver_license");
  check("signature_hash is hex",             typeof done.signature_hash === "string" &&
                                             /^[0-9a-f]+$/.test(done.signature_hash));
  // Raw signature never persists — only the hash. The hash must match
  // namespaceHash deterministically.
  var expectedHash = bShop.framework.crypto.namespaceHash(clickAndCollect.SIGNATURE_NAMESPACE, sigRaw);
  check("signature_hash matches namespaceHash", done.signature_hash === expectedHash);
  // Order primitive driven to delivered
  check("order.transition called",           ord.transitions.length === 1 &&
                                             ord.transitions[0].id === orderId &&
                                             ord.transitions[0].event === "mark_delivered");

  // Re-pickup refused
  await assert.rejects(w.svc.markPickedUp({
    order_id: orderId, picked_up_at: pickedAt + 1, signature: "x",
    customer_id_proof_kind: "driver_license",
  }), /only ready/);
}

async function _markReadyForPickupNotificationFailureSilent() {
  var notif = _notificationsStub({ fail: true });
  var w = await _wire({ notifications: notif });
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });
  var orderId = _orderId();
  await w.svc.scheduleAtLocation({
    order_id: orderId, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  });
  var ready = await w.svc.markReadyForPickup({ order_id: orderId });
  // FSM still moved even though the notifications dispatcher threw —
  // the operator's hold-shelf is already committed; the notification
  // failure must be drop-silent.
  check("ready landed despite notif failure", ready.status === "ready");
}

async function _markPickedUpOrderFsmAlreadyDelivered() {
  // The order FSM may be ahead of the schedule (operator hand-flipped
  // the order). markPickedUp swallows the fsm/illegal-transition code
  // so the schedule still lands.
  var ord = _orderStub({ transitionThrows: "fsm/illegal-transition" });
  var w = await _wire({ order: ord });
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });
  var orderId = _orderId();
  await w.svc.scheduleAtLocation({
    order_id: orderId, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  });
  await w.svc.markReadyForPickup({ order_id: orderId });
  var done = await w.svc.markPickedUp({
    order_id: orderId, picked_up_at: Date.now(),
    signature: "sig", customer_id_proof_kind: "passport",
  });
  check("picked_up survives fsm/illegal", done.status === "picked_up");

  // A non-illegal-transition error propagates
  var ord2 = _orderStub({ transitionThrows: "some/other-code" });
  var w2 = await _wire({ order: ord2 });
  await w2.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });
  var orderId2 = _orderId();
  await w2.svc.scheduleAtLocation({
    order_id: orderId2, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  });
  await w2.svc.markReadyForPickup({ order_id: orderId2 });
  await assert.rejects(w2.svc.markPickedUp({
    order_id: orderId2, picked_up_at: Date.now(),
    signature: "x", customer_id_proof_kind: "passport",
  }), /fsm illegal/);
}

async function _markNoShowAndEscalation() {
  var w = await _wire();
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });
  var orderId = _orderId();
  await w.svc.scheduleAtLocation({
    order_id: orderId, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  });
  var ns = await w.svc.markNoShow({ order_id: orderId, reason: "customer never arrived" });
  check("no_show status",                 ns.status === "no_show");
  check("no_show_at stamped",             typeof ns.no_show_at === "number" && ns.no_show_at > 0);
  check("escalate_after = 7d later",      Number(ns.escalate_after) ===
                                          Number(ns.no_show_at) + 7 * 24 * 3600 * 1000);
  check("no_show reason exposed",         ns.no_show_reason === "customer never arrived");

  // Cannot transition out of terminal no_show
  await assert.rejects(w.svc.markReadyForPickup({ order_id: orderId }),                 /only scheduled/);
  await assert.rejects(w.svc.markNoShow({ order_id: orderId, reason: "again" }),         /only scheduled or ready/);
  await assert.rejects(w.svc.markPickedUp({
    order_id: orderId, picked_up_at: Date.now(),
    signature: "x", customer_id_proof_kind: "passport",
  }), /only ready/);

  // markNoShow refusals
  await assert.rejects(w.svc.markNoShow(),                                              /input object required/);
  await assert.rejects(w.svc.markNoShow({ order_id: orderId }),                          /reason/);
  await assert.rejects(w.svc.markNoShow({ order_id: orderId, reason: "" }),              /reason/);
}

async function _pickupsForLocationFilter() {
  var w = await _wire();
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 10, lead_time_hours: 0 });

  var orderA = _orderId(); var orderB = _orderId(); var orderC = _orderId();
  await w.svc.scheduleAtLocation({
    order_id: orderA, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE,                scheduled_window_end: FUTURE_BASE + HOUR_MS,
  });
  await w.svc.scheduleAtLocation({
    order_id: orderB, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE + 2 * HOUR_MS,  scheduled_window_end: FUTURE_BASE + 3 * HOUR_MS,
  });
  await w.svc.scheduleAtLocation({
    order_id: orderC, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE + 5 * HOUR_MS,  scheduled_window_end: FUTURE_BASE + 6 * HOUR_MS,
  });
  await w.svc.markReadyForPickup({ order_id: orderB });

  var window = await w.svc.pickupsForLocation({
    location_code: "STORE-NYC", from: FUTURE_BASE, to: FUTURE_BASE + 4 * HOUR_MS,
  });
  check("pickupsForLocation window count",      window.length === 2);
  check("pickupsForLocation window ordered",    window[0].order_id === orderA && window[1].order_id === orderB);

  var ready = await w.svc.pickupsForLocation({
    location_code: "STORE-NYC", from: FUTURE_BASE, to: FUTURE_BASE + 10 * HOUR_MS,
    status: "ready",
  });
  check("pickupsForLocation status=ready",      ready.length === 1 && ready[0].order_id === orderB);

  var scheduled = await w.svc.pickupsForLocation({
    location_code: "STORE-NYC", from: FUTURE_BASE, to: FUTURE_BASE + 10 * HOUR_MS,
    status: "scheduled",
  });
  check("pickupsForLocation status=scheduled",  scheduled.length === 2);

  // Refusals
  await assert.rejects(w.svc.pickupsForLocation(),                                       /opts object required/);
  await assert.rejects(w.svc.pickupsForLocation({ location_code: "STORE-NYC",
    from: FUTURE_BASE, to: FUTURE_BASE - 1 }),                                            /to must be >= from/);
  await assert.rejects(w.svc.pickupsForLocation({ location_code: "STORE-NYC",
    from: FUTURE_BASE, to: FUTURE_BASE + 1, status: "bogus" }),                          /status/);
}

async function _customerSchedules() {
  // Without an order primitive, customerSchedules refuses
  var wBare = await _wire();
  await assert.rejects(wBare.svc.customerSchedules(_customerId()),                       /order must be wired/);

  // With order wired, customer's order rows resolve via listForCustomer
  var customerId = _customerId();
  var orderA = _orderId();
  var orderB = _orderId();
  var ord = _orderStub({
    byCustomer: (function () { var m = {}; m[customerId] = [{ id: orderA }, { id: orderB }]; return m; })(),
  });
  var w = await _wire({ order: ord });
  await w.svc.definePickupLocation({ code: "STORE-NYC", name: "Manhattan",
    address: _validAddress(), hours_json: _validHours(),
    capacity_per_hour: 4, lead_time_hours: 0 });
  await w.svc.scheduleAtLocation({
    order_id: orderA, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE, scheduled_window_end: FUTURE_BASE + HOUR_MS,
  });
  await w.svc.scheduleAtLocation({
    order_id: orderB, location_code: "STORE-NYC",
    scheduled_window_start: FUTURE_BASE + 2 * HOUR_MS, scheduled_window_end: FUTURE_BASE + 3 * HOUR_MS,
  });

  var rows = await w.svc.customerSchedules(customerId);
  check("customerSchedules returns both",         rows.length === 2);
  check("customerSchedules order_ids resolved",   rows.every(function (r) {
    return r.order_id === orderA || r.order_id === orderB;
  }));

  // A customer with no orders returns []
  var emptyRows = await w.svc.customerSchedules(_customerId());
  check("customerSchedules empty when no orders", emptyRows.length === 0);

  // getScheduleByOrder miss returns null
  var miss = await w.svc.getScheduleByOrder(_orderId());
  check("getScheduleByOrder miss returns null",   miss === null);
}

async function _factoryRefusals() {
  // order without transition / listForCustomer refused
  assert.throws(function () {
    clickAndCollect.create({ query: function () {}, order: { listForCustomer: function () {} } });
  }, /transition/);
  assert.throws(function () {
    clickAndCollect.create({ query: function () {}, order: { transition: function () {} } });
  }, /listForCustomer/);
  // inventoryLocations without stockForSku refused
  assert.throws(function () {
    clickAndCollect.create({ query: function () {}, inventoryLocations: {} });
  }, /stockForSku/);
  // notifications without enqueue refused
  assert.throws(function () {
    clickAndCollect.create({ query: function () {}, notifications: {} });
  }, /enqueue/);
}

async function run() {
  await _definePickupLocation();
  await _availableLocationsSkuFilter();
  await _scheduleAtLocationCapacityAndLeadTime();
  await _fsmTransitions();
  await _markReadyForPickupNotificationFailureSilent();
  await _markPickedUpOrderFsmAlreadyDelivered();
  await _markNoShowAndEscalation();
  await _pickupsForLocationFilter();
  await _customerSchedules();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("click-and-collect: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
