"use strict";
/**
 * order-tracking — shipment ledger + carrier-event log.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog), 0002 (cart), 0003 (order), 0021 (shipments).
 *
 * Coverage:
 *   - createShipment (with + without tracking_number; tracking_url shape)
 *   - recordEvent sequential + idempotent on (shipment, status,
 *     occurred_at)
 *   - markShipped / markDelivered transitions + order FSM drive
 *   - multiple shipments per order (split shipment)
 *   - trackingUrl pure helper across every carrier code
 *   - validation: bad carrier / order id / weight / oversized notes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql", "0021_shipments.sql"].map(function (f) {
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
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _validUUID() { return bShop.framework.uuid.v7(); }

// Seed a paid order in `fulfilling` state — the realistic upstream
// position when the first shipment row is created.
async function _seedFulfillingOrder(query) {
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });

  var p = await catalog.products.create({ slug: "trk-test", title: "TrackTest", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "TRK-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 1999 });
  var sessionId = _validUUID();
  var c = await cart.create(sessionId, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1 });

  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sessionId,
    currency:          "USD",
    subtotal_minor:    1999,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    695,
    grand_total_minor: 2694,
    ship_to:           { country: "US" },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               1,
      unit_amount_minor: 1999,
      unit_currency:     "USD",
    }],
  });
  o = await order.transition(o.id, "mark_paid");
  o = await order.transition(o.id, "start_fulfillment");
  o = await order.transition(o.id, "mark_shipped");
  return { order: order, orderRow: o };
}

// ---- createShipment ----------------------------------------------------

async function _createShipmentWithTracking() {
  var q = _makeQuery();
  var seed = await _seedFulfillingOrder(q);
  var trk = bShop.orderTracking.create({ query: q });

  var s = await trk.createShipment({
    order_id:        seed.orderRow.id,
    carrier:         "ups",
    tracking_number: "1Z999AA10123456784",
    weight_grams:    450,
    cost_minor:      695,
    cost_currency:   "USD",
    notes:           "ground; signature on delivery",
  });
  check("createShipment returns id",                typeof s.id === "string" && s.id.length === 36);
  check("createShipment with tracking → url present", typeof s.tracking_url === "string");
  check("createShipment url uses UPS template",       s.tracking_url.indexOf("ups.com/track?tracknum=") !== -1);
  check("createShipment url url-encodes tracking",    s.tracking_url.indexOf("1Z999AA10123456784") !== -1);

  var fetched = await trk.getShipment(s.id);
  check("getShipment round-trips row",                fetched.id === s.id);
  check("getShipment persists status pending",        fetched.status === "pending");
  check("getShipment persists carrier",               fetched.carrier === "ups");
  check("getShipment persists weight",                fetched.weight_grams === 450);
  check("getShipment persists cost",                  fetched.cost_minor === 695);
  check("getShipment persists notes",                 fetched.notes === "ground; signature on delivery");
  check("getShipment exposes tracking_url",           fetched.tracking_url === s.tracking_url);
  check("getShipment events empty on create",         Array.isArray(fetched.events) && fetched.events.length === 0);
}

async function _createShipmentWithoutTracking() {
  var q = _makeQuery();
  var seed = await _seedFulfillingOrder(q);
  var trk = bShop.orderTracking.create({ query: q });

  // No tracking_number yet — label not generated. Carrier still
  // required so the URL helper has something to bind against later.
  var s = await trk.createShipment({
    order_id: seed.orderRow.id,
    carrier:  "fedex",
  });
  check("createShipment no-tracking returns id",      typeof s.id === "string");
  check("createShipment no-tracking → null url",      s.tracking_url === null);

  var fetched = await trk.getShipment(s.id);
  check("getShipment no-tracking row carries null tn", fetched.tracking_number == null);
  check("getShipment no-tracking weight default 0",    fetched.weight_grams === 0);
  check("getShipment no-tracking cost default 0",      fetched.cost_minor === 0);
  check("getShipment no-tracking currency default USD", fetched.cost_currency === "USD");

  // 'other' carrier — requires carrier_other_name; URL stays null.
  var s2 = await trk.createShipment({
    order_id:           seed.orderRow.id,
    carrier:            "other",
    carrier_other_name: "Regional LTL Co.",
    tracking_number:    "RLT-99-7",
  });
  check("createShipment other → null url",            s2.tracking_url === null);
  var f2 = await trk.getShipment(s2.id);
  check("createShipment other persists carrier_name", f2.carrier_other_name === "Regional LTL Co.");
}

// ---- recordEvent -------------------------------------------------------

async function _recordEventSequentialAndIdempotent() {
  var q = _makeQuery();
  var seed = await _seedFulfillingOrder(q);
  var trk = bShop.orderTracking.create({ query: q });
  var s = await trk.createShipment({
    order_id:        seed.orderRow.id,
    carrier:         "usps",
    tracking_number: "9400111202555842761482",
  });

  var t1 = 1700000000000;
  var e1 = await trk.recordEvent({
    shipment_id: s.id,
    status:      "label-created",
    location:    "Origin Facility",
    detail:      "Shipping label generated",
    occurred_at: t1,
  });
  check("recordEvent 1 returns id",                typeof e1.id === "string" && e1.id.length === 36);
  check("recordEvent 1 not duplicate",             e1.duplicate === false);

  var e2 = await trk.recordEvent({
    shipment_id: s.id,
    status:      "in-transit",
    location:    "Distribution Hub",
    occurred_at: t1 + 3600000,
  });
  check("recordEvent 2 not duplicate",             e2.duplicate === false);

  // Idempotent: same (shipment, status, occurred_at) replays.
  var e1dup = await trk.recordEvent({
    shipment_id: s.id,
    status:      "label-created",
    occurred_at: t1,
    // a different location passed through — but the dedupe key is
    // (shipment, status, occurred_at), so the original row wins and
    // the new payload is dropped.
    location:    "Different Place",
  });
  check("recordEvent idempotent flag",             e1dup.duplicate === true);
  check("recordEvent idempotent reuses id",        e1dup.id === e1.id);

  var fetched = await trk.getShipment(s.id);
  check("getShipment events ordered ASC",          fetched.events.length === 2
    && fetched.events[0].status === "label-created"
    && fetched.events[1].status === "in-transit");
  check("getShipment status reflects latest event", fetched.status === "in-transit");
}

// ---- markShipped + markDelivered + order FSM drive --------------------

async function _markShippedAndDelivered() {
  var q = _makeQuery();
  var seed = await _seedFulfillingOrder(q);
  // seed leaves the order in `shipped` (the fulfillment flow already
  // transitioned through mark_shipped) — drive markDelivered through
  // the tracking primitive and assert the order FSM advances.
  var trk = bShop.orderTracking.create({ query: q, order: seed.order });

  var s = await trk.createShipment({
    order_id:        seed.orderRow.id,
    carrier:         "dhl",
    tracking_number: "1234567890",
  });

  var shippedAt = 1700100000000;
  var eta       = 1700700000000;
  var afterShip = await trk.markShipped(s.id, { shipped_at: shippedAt, estimated_delivery_at: eta });
  check("markShipped status → in-transit",         afterShip.status === "in-transit");
  check("markShipped persists shipped_at",         afterShip.shipped_at === shippedAt);
  check("markShipped persists eta",                afterShip.estimated_delivery_at === eta);
  check("markShipped writes one event row",        afterShip.events.length === 1
    && afterShip.events[0].status === "in-transit");

  var deliveredAt = 1700700000000;
  var afterDel    = await trk.markDelivered(s.id, { delivered_at: deliveredAt });
  check("markDelivered status → delivered",        afterDel.status === "delivered");
  check("markDelivered persists delivered_at",     afterDel.delivered_at === deliveredAt);
  check("markDelivered writes second event",       afterDel.events.length === 2);

  // Order FSM should now reflect delivered (driven by the tracking
  // primitive via the optional order dep).
  var refetchOrder = await seed.order.get(seed.orderRow.id);
  check("order FSM advanced to delivered",         refetchOrder.status === "delivered");

  // markDelivered a second time — idempotent at the shipment layer
  // (dedupe on event triple) and tolerant at the order layer (the
  // FSM_NO_TRANSITION on already-delivered is swallowed).
  var again = await trk.markDelivered(s.id, { delivered_at: deliveredAt });
  check("markDelivered idempotent re-fire",        again.status === "delivered"
    && again.events.length === 2);
}

// ---- multi-shipment per order -----------------------------------------

async function _multiShipmentPerOrder() {
  var q = _makeQuery();
  var seed = await _seedFulfillingOrder(q);
  var trk = bShop.orderTracking.create({ query: q });

  var s1 = await trk.createShipment({
    order_id:        seed.orderRow.id,
    carrier:         "ups",
    tracking_number: "1Z111",
  });
  var s2 = await trk.createShipment({
    order_id:        seed.orderRow.id,
    carrier:         "fedex",
    tracking_number: "999999",
    notes:           "backordered SKU; ships separately",
  });

  var list = await trk.listForOrder(seed.orderRow.id);
  check("listForOrder returns both shipments",     list.length === 2);
  check("listForOrder ordered by created_at ASC",   list[0].id === s1.id && list[1].id === s2.id);
  check("listForOrder hydrates tracking_url s1",    list[0].tracking_url.indexOf("ups.com") !== -1);
  check("listForOrder hydrates tracking_url s2",    list[1].tracking_url.indexOf("fedex.com") !== -1);
  check("listForOrder carries notes verbatim",      list[1].notes === "backordered SKU; ships separately");
}

// ---- pure trackingUrl helper ------------------------------------------

async function _trackingUrlAllCarriers() {
  var build = bShop.orderTracking.trackingUrl;
  check("trackingUrl ups",            build("ups", "1Z9").indexOf("ups.com/track?tracknum=1Z9") !== -1);
  check("trackingUrl fedex",          build("fedex", "770").indexOf("fedex.com/fedextrack/?trknbr=770") !== -1);
  check("trackingUrl usps",           build("usps", "9400111").indexOf("tools.usps.com") !== -1
    && build("usps", "9400111").indexOf("qtc_tLabels1=9400111") !== -1);
  check("trackingUrl dhl",            build("dhl", "8888").indexOf("dhl.com") !== -1
    && build("dhl", "8888").indexOf("tracking-id=8888") !== -1);
  check("trackingUrl royal-mail",     build("royal-mail", "RM1").indexOf("royalmail.com") !== -1);
  check("trackingUrl canada-post",    build("canada-post", "CP1").indexOf("canadapost-postescanada.ca") !== -1);
  check("trackingUrl australia-post", build("australia-post", "AP1").indexOf("auspost.com.au") !== -1);
  check("trackingUrl other → null",   build("other", "anything") === null);

  // Encoding for tracking-numbers that carry URL-unsafe glyphs.
  check("trackingUrl encodes plus",   build("ups", "1Z+abc").indexOf("1Z%2Babc") !== -1);
  check("trackingUrl encodes space",  build("ups", "1Z abc").indexOf("1Z%20abc") !== -1);

  // Bad inputs — pure helper returns null rather than throwing.
  check("trackingUrl bad carrier",    build("postnord", "x") === null);
  check("trackingUrl empty tn",       build("ups", "") === null);
  check("trackingUrl non-string tn",  build("ups", 123) === null);
}

// ---- validation refusals ----------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var seed = await _seedFulfillingOrder(q);
  var trk = bShop.orderTracking.create({ query: q });

  // No input
  await assert.rejects(trk.createShipment(),                                                  /input object required/);
  // Bad order_id
  await assert.rejects(trk.createShipment({ order_id: "not-a-uuid", carrier: "ups" }),         /order_id/);
  // Unknown order
  await assert.rejects(trk.createShipment({ order_id: _validUUID(), carrier: "ups" }),         /not found/);
  // Bad carrier
  await assert.rejects(trk.createShipment({ order_id: seed.orderRow.id, carrier: "postnord" }), /carrier must be/);
  // 'other' without carrier_other_name
  await assert.rejects(trk.createShipment({ order_id: seed.orderRow.id, carrier: "other" }),    /carrier_other_name required/);
  // carrier_other_name with a non-'other' carrier — surface the conflict
  await assert.rejects(trk.createShipment({
    order_id:           seed.orderRow.id,
    carrier:            "ups",
    carrier_other_name: "stray label",
  }), /only valid when carrier='other'/);
  // Bad weight
  await assert.rejects(trk.createShipment({ order_id: seed.orderRow.id, carrier: "ups", weight_grams: -1 }),   /weight_grams/);
  await assert.rejects(trk.createShipment({ order_id: seed.orderRow.id, carrier: "ups", weight_grams: 1.5 }),  /weight_grams/);
  // Bad cost
  await assert.rejects(trk.createShipment({ order_id: seed.orderRow.id, carrier: "ups", cost_minor: -10 }),    /cost_minor/);
  // Bad currency
  await assert.rejects(trk.createShipment({ order_id: seed.orderRow.id, carrier: "ups", cost_currency: "usd" }), /cost_currency/);
  // Oversized notes (2048-byte cap)
  var huge = new Array(2050).join("x");
  await assert.rejects(trk.createShipment({ order_id: seed.orderRow.id, carrier: "ups", notes: huge }),         /notes/);
  // Bad tracking_number (control bytes)
  await assert.rejects(trk.createShipment({
    order_id:        seed.orderRow.id,
    carrier:         "ups",
    tracking_number: "1Z\n\rinjection",
  }), /tracking_number/);

  // recordEvent refusals
  await assert.rejects(trk.recordEvent(),                                                    /input object required/);
  await assert.rejects(trk.recordEvent({ shipment_id: "bad", status: "pending" }),            /shipment_id/);
  await assert.rejects(trk.recordEvent({ shipment_id: _validUUID(), status: "teleported" }), /status must be/);
  // Unknown shipment
  await assert.rejects(trk.recordEvent({ shipment_id: _validUUID(), status: "pending" }),     /not found/);

  // markShipped / markDelivered refusals
  await assert.rejects(trk.markShipped("not-a-uuid"),     /shipment_id/);
  await assert.rejects(trk.markShipped(_validUUID()),      /not found/);
  await assert.rejects(trk.markDelivered("not-a-uuid"),    /shipment_id/);
  await assert.rejects(trk.markDelivered(_validUUID()),    /not found/);

  // listForOrder / getShipment refusals
  await assert.rejects(trk.listForOrder("not-a-uuid"),     /order_id/);
  await assert.rejects(trk.getShipment("not-a-uuid"),      /shipment_id/);

  // Factory refuses mis-shaped order dep
  assert.throws(function () { bShop.orderTracking.create({ query: q, order: {} }); },
    /opts\.order must expose a transition/);
}

async function run() {
  await _createShipmentWithTracking();
  await _createShipmentWithoutTracking();
  await _recordEventSequentialAndIdempotent();
  await _markShippedAndDelivered();
  await _multiShipmentPerOrder();
  await _trackingUrlAllCarriers();
  await _validationRefusals();
}

module.exports = { run: run };
