"use strict";
/**
 * shippingLabels — operator-side carrier-label store.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog), 0002 (cart), 0003 (order), 0021 (shipments),
 * 0051 (shipping_labels).
 *
 * The primitive isn't wired through the `bShop` entry point yet —
 * the test requires `lib/shipping-labels.js` directly so the gate
 * exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - requestLabel writes a pending row with parsed customs blob
 *   - markPurchased flips pending → purchased + persists broker fields
 *   - voidLabel flips purchased → voided inside the 30-day window
 *   - voidLabel refuses past the 30-day window
 *   - markUsed flips purchased → used
 *   - FSM refusal classes (re-purchase, void-from-pending, use-after-void)
 *   - labelsForShipment / labelsForOrder hydrate customs
 *   - pendingLabels drains worker queue in created_at order
 *   - voidedInWindow filters by epoch range
 *   - costsByPeriod aggregates per broker + currency, carrier filter
 *   - customsForLabel returns the normalized declaration shape
 *   - validation refusals (bad ids, label_url protocol, weight, etc.)
 *   - getLabel returns null for unknown id
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var shippingLabels = require("../../lib/shipping-labels");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0021_shipments.sql",
  "0051_shipping_labels.sql",
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

// Seed a minimal order + shipment so the FK from shipping_labels →
// shipments resolves. We don't need the full FSM path through the
// order primitive — direct INSERTs against the seeded schema are
// the cheaper path for a per-test fixture, and the labels primitive
// only joins on `shipments`, never on `orders`.
async function _seedOrderAndShipment(query, opts) {
  opts = opts || {};
  var ts = Date.now();
  var orderId = opts.order_id || _validUUID();
  // When the test is staging a split-shipment scenario it passes a
  // pre-existing order_id — the cart + order rows are already in
  // place, only a new shipment row is needed.
  var existing = await query("SELECT id FROM orders WHERE id = ?1", [orderId]);
  if (!existing.rows.length) {
    var cartId = _validUUID();
    await query(
      "INSERT INTO carts (id, session_id, currency, status, created_at, updated_at, expires_at) " +
      "VALUES (?1, ?2, 'USD', 'active', ?3, ?3, ?4)",
      [cartId, _validUUID(), ts, ts + 86400000],
    );
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
      "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
      "ship_to_json, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 0, 0, 0, 0, 0, '{\"country\":\"US\"}', ?5, ?5)",
      [orderId, cartId, opts.customer_id || null, _validUUID(), ts],
    );
  }
  var shipmentId = opts.shipment_id || _validUUID();
  await query(
    "INSERT INTO shipments (id, order_id, tracking_number, carrier, carrier_other_name, " +
    "status, shipped_at, delivered_at, estimated_delivery_at, weight_grams, cost_minor, " +
    "cost_currency, notes, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, NULL, 'pending', NULL, NULL, NULL, 0, 0, 'USD', '', ?4, ?4)",
    [shipmentId, orderId, opts.carrier || "ups", ts],
  );
  return { order_id: orderId, shipment_id: shipmentId };
}

function _validLabelInput(shipmentId, override) {
  var base = {
    shipment_id:   shipmentId,
    carrier:       "ups",
    service_level: "ground",
    weight_grams:  450,
    length_mm:     250,
    width_mm:      150,
    height_mm:     100,
    package_type:  "parcel",
  };
  if (override) {
    for (var k in override) {
      if (Object.prototype.hasOwnProperty.call(override, k)) base[k] = override[k];
    }
  }
  return base;
}

function _validPurchase(labelId, override) {
  var base = {
    label_id:        labelId,
    tracking_number: "1Z999AA10123456784",
    label_url:       "https://easypost.s3.amazonaws.com/labels/abc123.pdf",
    cost_minor:      875,
    currency:        "USD",
    purchased_via:   "easypost",
  };
  if (override) {
    for (var k in override) {
      if (Object.prototype.hasOwnProperty.call(override, k)) base[k] = override[k];
    }
  }
  return base;
}

// ---- requestLabel + happy-path FSM ------------------------------------

async function _requestPurchaseFlow() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  var req = await labels.requestLabel(_validLabelInput(seed.shipment_id, {
    customs_declaration: {
      contents_type:  "merchandise",
      origin_country: "US",
      lines: [{
        description:    "Widget A",
        hs_code:        "8471.30",
        quantity:       2,
        value_minor:    1500,
        origin_country: "US",
      }],
    },
  }));
  check("requestLabel returns id",                typeof req.id === "string" && req.id.length === 36);
  check("requestLabel returns status pending",    req.status === "pending");
  check("requestLabel returns created_at",        Number.isInteger(req.created_at));

  var fetched = await labels.getLabel(req.id);
  check("getLabel round-trips row",               fetched.id === req.id);
  check("getLabel persists carrier",              fetched.carrier === "ups");
  check("getLabel persists service_level",        fetched.service_level === "ground");
  check("getLabel persists weight",               fetched.weight_grams === 450);
  check("getLabel persists dimensions",           fetched.length_mm === 250 && fetched.width_mm === 150 && fetched.height_mm === 100);
  check("getLabel persists package_type",         fetched.package_type === "parcel");
  check("getLabel hydrates customs blob",         fetched.customs && fetched.customs.contents_type === "merchandise");
  check("getLabel customs lines round-trip",      fetched.customs.lines.length === 1
    && fetched.customs.lines[0].hs_code === "8471.30");
  check("getLabel tracking_number null pre-buy",  fetched.tracking_number == null);
  check("getLabel label_url null pre-buy",        fetched.label_url == null);

  // Mark purchased.
  var purchased = await labels.markPurchased(_validPurchase(req.id));
  check("markPurchased status → purchased",       purchased.status === "purchased");
  check("markPurchased persists tracking",        purchased.tracking_number === "1Z999AA10123456784");
  check("markPurchased persists label_url",       purchased.label_url === "https://easypost.s3.amazonaws.com/labels/abc123.pdf");
  check("markPurchased persists cost",            purchased.cost_minor === 875);
  check("markPurchased persists currency",        purchased.currency === "USD");
  check("markPurchased persists purchased_via",   purchased.purchased_via === "easypost");
  check("markPurchased stamps purchased_at",      Number.isInteger(purchased.purchased_at) && purchased.purchased_at > 0);

  // Mark used.
  var used = await labels.markUsed(req.id);
  check("markUsed status → used",                 used.status === "used");
  check("markUsed stamps used_at",                Number.isInteger(used.used_at) && used.used_at >= purchased.purchased_at);
}

// ---- voidLabel inside-window + outside-window -------------------------

async function _voidWithinWindow() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  var req = await labels.requestLabel(_validLabelInput(seed.shipment_id));
  await labels.markPurchased(_validPurchase(req.id));

  var voided = await labels.voidLabel({ label_id: req.id, reason: "operator-requested re-route" });
  check("voidLabel status → voided",              voided.status === "voided");
  check("voidLabel persists reason",              voided.void_reason === "operator-requested re-route");
  check("voidLabel stamps voided_at",             Number.isInteger(voided.voided_at) && voided.voided_at > 0);

  // Idempotent / refusal: voiding again refuses (voided → * not allowed).
  await assert.rejects(
    labels.voidLabel({ label_id: req.id, reason: "double-void" }),
    /refused — label is voided/,
  );
}

async function _voidOutsideWindow() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  var req = await labels.requestLabel(_validLabelInput(seed.shipment_id));
  await labels.markPurchased(_validPurchase(req.id));

  // Force the row's purchased_at backwards into the past, past the
  // 30-day window. Direct UPDATE since the framework has no
  // time-injection knob (epoch-ms is `Date.now()` at the call site).
  var fortyDaysAgo = Date.now() - (40 * 24 * 60 * 60 * 1000);
  await q("UPDATE shipping_labels SET purchased_at = ?1 WHERE id = ?2", [fortyDaysAgo, req.id]);

  await assert.rejects(
    labels.voidLabel({ label_id: req.id, reason: "too-late" }),
    /purchased more than 30 days ago/,
  );

  // Boundary: exactly 30-day-old still voidable (window is inclusive
  // of the 30th-day-from-purchase boundary down to the millisecond).
  var seed2 = await _seedOrderAndShipment(q);
  var labels2 = shippingLabels.create({ query: q });
  var req2 = await labels2.requestLabel(_validLabelInput(seed2.shipment_id));
  await labels2.markPurchased(_validPurchase(req2.id));
  var atBoundary = Date.now() - (30 * 24 * 60 * 60 * 1000) + 1000; // 1s inside the window
  await q("UPDATE shipping_labels SET purchased_at = ?1 WHERE id = ?2", [atBoundary, req2.id]);
  var v2 = await labels2.voidLabel({ label_id: req2.id, reason: "right at boundary" });
  check("voidLabel inside-boundary success",       v2.status === "voided");
}

// ---- FSM transition refusals ------------------------------------------

async function _fsmRefusals() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  // Can't void a pending label (only purchased → voided).
  var req = await labels.requestLabel(_validLabelInput(seed.shipment_id));
  await assert.rejects(
    labels.voidLabel({ label_id: req.id, reason: "premature" }),
    /refused — label is pending/,
  );

  // Can't mark-used a pending label.
  await assert.rejects(
    labels.markUsed(req.id),
    /refused — label is pending/,
  );

  // Can't re-purchase an already-purchased label.
  await labels.markPurchased(_validPurchase(req.id));
  await assert.rejects(
    labels.markPurchased(_validPurchase(req.id, { tracking_number: "OTHER-9" })),
    /refused — label is purchased/,
  );

  // Can't mark-used a voided label.
  var seed2 = await _seedOrderAndShipment(q);
  var req2 = await labels.requestLabel(_validLabelInput(seed2.shipment_id));
  await labels.markPurchased(_validPurchase(req2.id, { tracking_number: "SECOND-1" }));
  await labels.voidLabel({ label_id: req2.id, reason: "abort" });
  await assert.rejects(
    labels.markUsed(req2.id),
    /refused — label is voided/,
  );
}

// ---- labelsForShipment / labelsForOrder hydrate ----------------------

async function _labelsForShipmentAndOrder() {
  var q = _makeQuery();
  // Same order, two shipments (split-shipment), one label each.
  var seedA = await _seedOrderAndShipment(q);
  var seedB = await _seedOrderAndShipment(q, { order_id: seedA.order_id, carrier: "fedex" });

  var labels = shippingLabels.create({ query: q });
  var reqA = await labels.requestLabel(_validLabelInput(seedA.shipment_id));
  // Sleep-free: pin created_at ordering via a direct UPDATE so the
  // assertions don't depend on monotonic-ms wall clock granularity.
  await q("UPDATE shipping_labels SET created_at = ?1 WHERE id = ?2", [1000, reqA.id]);
  var reqB = await labels.requestLabel(_validLabelInput(seedB.shipment_id, {
    carrier: "fedex",
    service_level: "express",
  }));
  await q("UPDATE shipping_labels SET created_at = ?1 WHERE id = ?2", [2000, reqB.id]);

  var perShipA = await labels.labelsForShipment(seedA.shipment_id);
  check("labelsForShipment returns 1 for A",      perShipA.length === 1 && perShipA[0].id === reqA.id);

  var perShipB = await labels.labelsForShipment(seedB.shipment_id);
  check("labelsForShipment returns 1 for B",      perShipB.length === 1 && perShipB[0].id === reqB.id);

  var perOrder = await labels.labelsForOrder(seedA.order_id);
  check("labelsForOrder returns 2",               perOrder.length === 2);
  check("labelsForOrder ordered by created_at",   perOrder[0].id === reqA.id && perOrder[1].id === reqB.id);
  check("labelsForOrder carries A carrier",       perOrder[0].carrier === "ups");
  check("labelsForOrder carries B carrier",       perOrder[1].carrier === "fedex");
  check("labelsForOrder carries B service_level", perOrder[1].service_level === "express");

  // Unknown shipment / order — empty list.
  var none1 = await labels.labelsForShipment(_validUUID());
  check("labelsForShipment unknown → []",         none1.length === 0);
  var none2 = await labels.labelsForOrder(_validUUID());
  check("labelsForOrder unknown → []",            none2.length === 0);
}

// ---- pendingLabels worker drain --------------------------------------

async function _pendingLabelsDrain() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  // Three pending labels, one already purchased — drain should
  // only return the three.
  var p1 = await labels.requestLabel(_validLabelInput(seed.shipment_id, { service_level: "ground" }));
  var p2 = await labels.requestLabel(_validLabelInput(seed.shipment_id, { service_level: "express" }));
  var p3 = await labels.requestLabel(_validLabelInput(seed.shipment_id, { service_level: "priority" }));
  var purchased = await labels.requestLabel(_validLabelInput(seed.shipment_id, { service_level: "overnight" }));
  await labels.markPurchased(_validPurchase(purchased.id));

  // Pin created_at order so the assertion is deterministic.
  await q("UPDATE shipping_labels SET created_at = ?1 WHERE id = ?2", [100, p1.id]);
  await q("UPDATE shipping_labels SET created_at = ?1 WHERE id = ?2", [200, p2.id]);
  await q("UPDATE shipping_labels SET created_at = ?1 WHERE id = ?2", [300, p3.id]);

  var drain = await labels.pendingLabels({});
  check("pendingLabels returns only pending",      drain.length === 3);
  check("pendingLabels ordered created_at ASC",    drain[0].id === p1.id
    && drain[1].id === p2.id && drain[2].id === p3.id);

  // Limit honored.
  var drain2 = await labels.pendingLabels({ limit: 2 });
  check("pendingLabels honors limit",              drain2.length === 2
    && drain2[0].id === p1.id && drain2[1].id === p2.id);

  // Default limit (no opts).
  var drain3 = await labels.pendingLabels();
  check("pendingLabels default limit returns all", drain3.length === 3);
}

// ---- voidedInWindow + costsByPeriod ----------------------------------

async function _voidedAndCostsAggregates() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  // Three purchased + one voided across two brokers + two currencies.
  var l1 = await labels.requestLabel(_validLabelInput(seed.shipment_id, { carrier: "ups" }));
  var l2 = await labels.requestLabel(_validLabelInput(seed.shipment_id, { carrier: "ups" }));
  var l3 = await labels.requestLabel(_validLabelInput(seed.shipment_id, { carrier: "fedex" }));
  var l4 = await labels.requestLabel(_validLabelInput(seed.shipment_id, { carrier: "fedex" }));

  await labels.markPurchased(_validPurchase(l1.id, { cost_minor: 875,  currency: "USD", purchased_via: "easypost" }));
  await labels.markPurchased(_validPurchase(l2.id, { cost_minor: 1200, currency: "USD", purchased_via: "easypost", tracking_number: "1Z2" }));
  await labels.markPurchased(_validPurchase(l3.id, { cost_minor: 950,  currency: "USD", purchased_via: "shippo",   tracking_number: "1Z3" }));
  await labels.markPurchased(_validPurchase(l4.id, { cost_minor: 1500, currency: "EUR", purchased_via: "shippo",   tracking_number: "1Z4" }));

  // Void one BEFORE re-pinning purchased_at into the distant past
  // (the void-window gate uses the row's stored purchased_at vs
  // Date.now(); rewriting purchased_at backwards would push the row
  // outside the window).
  await labels.voidLabel({ label_id: l2.id, reason: "operator changed mind" });

  // Pin purchased_at + voided_at so the window assertions are deterministic.
  await q("UPDATE shipping_labels SET purchased_at = ?1 WHERE id = ?2", [1000, l1.id]);
  await q("UPDATE shipping_labels SET purchased_at = ?1 WHERE id = ?2", [2000, l2.id]);
  await q("UPDATE shipping_labels SET purchased_at = ?1 WHERE id = ?2", [3000, l3.id]);
  await q("UPDATE shipping_labels SET purchased_at = ?1 WHERE id = ?2", [4000, l4.id]);
  await q("UPDATE shipping_labels SET voided_at = ?1 WHERE id = ?2", [5000, l2.id]);

  // voidedInWindow inclusive bounds.
  var voids = await labels.voidedInWindow({ from: 4000, to: 6000 });
  check("voidedInWindow hits the one void",        voids.length === 1 && voids[0].id === l2.id);
  check("voidedInWindow carries reason",           voids[0].void_reason === "operator changed mind");

  var noVoids = await labels.voidedInWindow({ from: 7000, to: 8000 });
  check("voidedInWindow empty when none in range", noVoids.length === 0);

  // costsByPeriod: window covers all four purchases, grouped by
  // (purchased_via, currency).
  var costs = await labels.costsByPeriod({ from: 1, to: 9999 });
  check("costsByPeriod returns 3 groups",          costs.length === 3); // easypost-USD, shippo-USD, shippo-EUR

  // The shape easiest to assert against — synthesize a key-by lookup.
  var byKey = {};
  for (var i = 0; i < costs.length; i += 1) {
    byKey[costs[i].purchased_via + "/" + costs[i].currency] = costs[i];
  }
  check("costsByPeriod easypost-USD sum",          byKey["easypost/USD"]
    && byKey["easypost/USD"].label_count === 2
    && byKey["easypost/USD"].total_minor === 2075);
  check("costsByPeriod shippo-USD sum",            byKey["shippo/USD"]
    && byKey["shippo/USD"].label_count === 1
    && byKey["shippo/USD"].total_minor === 950);
  check("costsByPeriod shippo-EUR sum",            byKey["shippo/EUR"]
    && byKey["shippo/EUR"].label_count === 1
    && byKey["shippo/EUR"].total_minor === 1500);

  // Carrier filter — only ups labels contribute.
  var upsCosts = await labels.costsByPeriod({ from: 1, to: 9999, carrier: "ups" });
  check("costsByPeriod carrier filter ups",        upsCosts.length === 1
    && upsCosts[0].purchased_via === "easypost"
    && upsCosts[0].label_count === 2
    && upsCosts[0].total_minor === 2075);

  // Narrow window — only the first purchase qualifies.
  var narrowCosts = await labels.costsByPeriod({ from: 500, to: 1500 });
  check("costsByPeriod narrow window",             narrowCosts.length === 1
    && narrowCosts[0].purchased_via === "easypost"
    && narrowCosts[0].label_count === 1
    && narrowCosts[0].total_minor === 875);
}

// ---- customsForLabel --------------------------------------------------

async function _customsForLabelShape() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  // No customs declaration — customsForLabel returns null even
  // though the row exists.
  var bare = await labels.requestLabel(_validLabelInput(seed.shipment_id));
  var noCustoms = await labels.customsForLabel(bare.id);
  check("customsForLabel returns null when absent", noCustoms === null);

  var declared = await labels.requestLabel(_validLabelInput(seed.shipment_id, {
    customs_declaration: {
      contents_type:  "gift",
      origin_country: "GB",
      lines: [
        {
          description:    "Hand-bound notebook",
          hs_code:        "4820.10",
          quantity:       3,
          value_minor:    2500,
          origin_country: "GB",
        },
        {
          description:    "Refill pen set",
          hs_code:        "9608.10",
          quantity:       1,
          value_minor:    900,
          origin_country: "GB",
        },
      ],
    },
  }));
  var customs = await labels.customsForLabel(declared.id);
  check("customsForLabel label_id",                 customs.label_id === declared.id);
  check("customsForLabel shipment_id",              customs.shipment_id === seed.shipment_id);
  check("customsForLabel contents_type",            customs.contents_type === "gift");
  check("customsForLabel origin_country",           customs.origin_country === "GB");
  check("customsForLabel lines round-trip",         customs.lines.length === 2
    && customs.lines[0].hs_code === "4820.10"
    && customs.lines[1].hs_code === "9608.10");
  // total_value_minor = (3 * 2500) + (1 * 900) = 7500 + 900 = 8400.
  check("customsForLabel total_value_minor",        customs.total_value_minor === 8400);
  check("customsForLabel total_items",              customs.total_items === 4);
  check("customsForLabel raw is the declaration",   customs.raw && customs.raw.contents_type === "gift");

  // Unknown label → null.
  var miss = await labels.customsForLabel(_validUUID());
  check("customsForLabel unknown → null",           miss === null);
}

// ---- validation refusals ---------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var seed = await _seedOrderAndShipment(q);
  var labels = shippingLabels.create({ query: q });

  // requestLabel
  await assert.rejects(labels.requestLabel(),                                                  /input object required/);
  await assert.rejects(labels.requestLabel({}),                                                /shipment_id/);
  await assert.rejects(labels.requestLabel(_validLabelInput("not-a-uuid")),                    /shipment_id/);
  await assert.rejects(labels.requestLabel(_validLabelInput(_validUUID())),                    /not found/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, { carrier: "postnord" })), /carrier must be/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, { service_level: "" })),   /service_level/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, { weight_grams: 0 })),     /weight_grams/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, { weight_grams: -1 })),    /weight_grams/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, { length_mm: 0 })),        /length_mm/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, { package_type: "crate" })), /package_type/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, {
    customs_declaration: { contents_type: "merchandise", origin_country: "US", lines: [] },
  })), /lines must be a non-empty array/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, {
    customs_declaration: { contents_type: "merchandise", origin_country: "us", lines: [{ description: "x", hs_code: "1", quantity: 1, value_minor: 1, origin_country: "US" }] },
  })), /origin_country must be 2-letter/);
  await assert.rejects(labels.requestLabel(_validLabelInput(seed.shipment_id, {
    customs_declaration: { contents_type: "merchandise", origin_country: "US", lines: [{ description: "x", hs_code: "abc", quantity: 1, value_minor: 1, origin_country: "US" }] },
  })), /hs_code must be digits/);

  // markPurchased
  var req = await labels.requestLabel(_validLabelInput(seed.shipment_id));
  await assert.rejects(labels.markPurchased(),                                                  /input object required/);
  await assert.rejects(labels.markPurchased({}),                                                /label_id/);
  await assert.rejects(labels.markPurchased(_validPurchase(_validUUID())),                      /not found/);
  await assert.rejects(labels.markPurchased(_validPurchase(req.id, { label_url: "http://x/y.pdf" })),                  /label_url/);
  await assert.rejects(labels.markPurchased(_validPurchase(req.id, { label_url: "javascript:alert(1)" })),             /label_url/);
  await assert.rejects(labels.markPurchased(_validPurchase(req.id, { label_url: "data:text/plain,hi" })),              /label_url/);
  await assert.rejects(labels.markPurchased(_validPurchase(req.id, { tracking_number: "1Z\n\r" })),                    /tracking_number/);
  await assert.rejects(labels.markPurchased(_validPurchase(req.id, { cost_minor: -1 })),                               /cost_minor/);
  await assert.rejects(labels.markPurchased(_validPurchase(req.id, { currency: "usd" })),                              /currency/);
  await assert.rejects(labels.markPurchased(_validPurchase(req.id, { purchased_via: "fedex" })),                       /purchased_via/);

  // voidLabel
  await assert.rejects(labels.voidLabel(),                                                      /input object required/);
  await assert.rejects(labels.voidLabel({}),                                                    /label_id/);
  await assert.rejects(labels.voidLabel({ label_id: _validUUID(), reason: "x" }),               /not found/);
  await assert.rejects(labels.voidLabel({ label_id: req.id, reason: "" }),                      /reason/);

  // markUsed
  await assert.rejects(labels.markUsed("not-a-uuid"),                                            /label_id/);
  await assert.rejects(labels.markUsed(_validUUID()),                                            /not found/);

  // getLabel / labelsForShipment / labelsForOrder / customsForLabel
  await assert.rejects(labels.getLabel("not-a-uuid"),                                            /label_id/);
  await assert.rejects(labels.labelsForShipment("not-a-uuid"),                                   /shipment_id/);
  await assert.rejects(labels.labelsForOrder("not-a-uuid"),                                      /order_id/);
  await assert.rejects(labels.customsForLabel("not-a-uuid"),                                     /label_id/);

  // pendingLabels limit bounds
  await assert.rejects(labels.pendingLabels({ limit: 0 }),                                       /limit/);
  await assert.rejects(labels.pendingLabels({ limit: 1.5 }),                                     /limit/);
  await assert.rejects(labels.pendingLabels({ limit: 999 }),                                     /limit/);

  // voidedInWindow / costsByPeriod opts shape
  await assert.rejects(labels.voidedInWindow(),                                                  /opts object required/);
  await assert.rejects(labels.voidedInWindow({ from: 0, to: 100 }),                              /from/);
  await assert.rejects(labels.voidedInWindow({ from: 200, to: 100 }),                            /to must be >= from/);
  await assert.rejects(labels.costsByPeriod(),                                                   /opts object required/);
  await assert.rejects(labels.costsByPeriod({ from: 1, to: 100, carrier: "postnord" }),          /carrier must be/);

  // Factory refusal (cursorSecret shape, when provided)
  assert.throws(function () { shippingLabels.create({ query: q, cursorSecret: 42 }); },          /cursorSecret/);

  // getLabel unknown → null (not a refusal — the read verb returns null for absent rows).
  var unknown = await labels.getLabel(_validUUID());
  check("getLabel unknown → null",                  unknown === null);
}

async function run() {
  await _requestPurchaseFlow();
  await _voidWithinWindow();
  await _voidOutsideWindow();
  await _fsmRefusals();
  await _labelsForShipmentAndOrder();
  await _pendingLabelsDrain();
  await _voidedAndCostsAggregates();
  await _customsForLabelShape();
  await _validationRefusals();
}

if (require.main === module) {
  run().then(function () {
    process.stdout.write("shipping-labels: PASS (" + helpers.getChecks() + " checks)\n");
  }, function (e) {
    process.stderr.write("shipping-labels: FAIL\n" + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}

module.exports = { run: run };
