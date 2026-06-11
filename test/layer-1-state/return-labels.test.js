"use strict";
/**
 * returnLabels — operator-funded return-label flow against the
 * returns primitive.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog), 0002 (cart), 0003 (order), 0023 (returns),
 * 0052 (return_labels).
 *
 * Coverage:
 *   - issueLabel persists the row + an `issued` timeline event
 *   - issueLabel refuses when the RMA isn't approved
 *   - happy path: issued → shipped → in_transit → delivered
 *   - markDelivered fans out to returns.markReceived (RMA → received)
 *   - markInTransit accepts repeated carrier scans
 *   - markException is reachable from issued / shipped / in_transit
 *   - illegal transitions refused (markDelivered from issued,
 *     markShipped from delivered, anything from exception)
 *   - getLabel / labelForReturn / pendingPickup / inTransit
 *   - eventsForLabel preserves ordering
 *   - validation refusals (UUIDs, currency, control bytes, bad URL)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var returnLabels = require("../../lib/return-labels");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0023_returns.sql",
  "0052_return_labels.sql",
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

function _uuid() { return bShop.framework.uuid.v7(); }

// Seed: one paid order → one approved RMA against it. The label
// primitive composes the returns primitive directly, so the seed
// stops at "approved" — every test that needs a label starts here.
async function _seedApprovedRma(q) {
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var returns = bShop.returns.create({ query: q });

  var p = await catalog.products.create({ slug: "lab-test", title: "LabelTest", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "LAB-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 4999 });
  var sid = _uuid();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
  var o = await order.createFromCart({
    cart_id:    c.id,
    session_id: sid,
    currency:   "USD",
    subtotal_minor:    9998,
    discount_minor:    0,
    tax_minor:         800,
    shipping_minor:    500,
    grand_total_minor: 11298,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               2,
      unit_amount_minor: 4999,
      unit_currency:     "USD",
    }],
  });

  var customerId = _uuid();
  var rma = await returns.request({
    order_id:    o.id,
    customer_id: customerId,
    reason:      "defective",
    lines: [{
      sku:           v.sku,
      qty:           1,
      order_line_id: o.lines[0].id,
    }],
  });
  await returns.approve(rma.id, { refund_amount_minor: 4999 });
  return { rma: rma, returns: returns };
}

function _labelInput(rmaId) {
  return {
    return_id:       rmaId,
    carrier:         "USPS",
    service_level:   "Ground Advantage",
    weight_grams:    340,
    label_url:       "https://labels.example.com/9400111202509876543210.pdf",
    tracking_number: "9400111202509876543210",
    cost_minor:      795,
    currency:        "USD",
  };
}

async function _issueAndPersist() {
  var q = _makeQuery();
  var seed   = await _seedApprovedRma(q);
  var labels = returnLabels.create({ query: q, returns: seed.returns });

  var lab = await labels.issueLabel(_labelInput(seed.rma.id));
  check("issueLabel returns id",                    typeof lab.id === "string" && lab.id.length === 36);
  check("issueLabel persists status=issued",        lab.status === "issued");
  check("issueLabel persists tracking_number",      lab.tracking_number === "9400111202509876543210");
  check("issueLabel persists cost_minor",           lab.cost_minor === 795);
  check("issueLabel persists currency",             lab.currency === "USD");
  check("issueLabel sets issued_at",                typeof lab.issued_at === "number" && lab.issued_at > 0);
  check("issueLabel leaves shipped_at null",        lab.shipped_at === null);
  check("issueLabel leaves delivered_at null",      lab.delivered_at === null);

  var fetched = await labels.getLabel(lab.id);
  check("getLabel hydrates the row",                fetched.id === lab.id);

  var forReturn = await labels.labelForReturn(seed.rma.id);
  check("labelForReturn finds the label",           forReturn && forReturn.id === lab.id);

  var events = await labels.eventsForLabel(lab.id);
  check("eventsForLabel returns issued event",      events.length === 1 && events[0].event_type === "issued");
  var detail = JSON.parse(events[0].detail_json);
  check("issued event captures weight_grams",       detail.weight_grams === 340);
  check("issued event captures cost_minor",         detail.cost_minor === 795);
}

async function _refusesUnlessApproved() {
  var q = _makeQuery();
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var returns = bShop.returns.create({ query: q });

  var p = await catalog.products.create({ slug: "ref-test", title: "RefuseTest", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "REF-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 1000 });
  var sid = _uuid();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1 });
  var o = await order.createFromCart({
    cart_id:    c.id,
    session_id: sid,
    currency:   "USD",
    subtotal_minor:    1000,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 1000,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               1,
      unit_amount_minor: 1000,
      unit_currency:     "USD",
    }],
  });

  var labels = returnLabels.create({ query: q, returns: returns });

  // Pending RMA — issueLabel refused.
  var pendingRma = await returns.request({
    order_id: o.id,
    reason:   "defective",
    lines:    [{ sku: v.sku, qty: 1 }],
  });
  await assert.rejects(
    labels.issueLabel(_labelInput(pendingRma.id)),
    /refused/,
  );

  // Rejected RMA — refused.
  var rejectedRma = await returns.request({
    order_id: o.id,
    reason:   "defective",
    lines:    [{ sku: v.sku, qty: 1 }],
  });
  await returns.reject(rejectedRma.id, { rejected_reason: "outside window" });
  await assert.rejects(
    labels.issueLabel(_labelInput(rejectedRma.id)),
    /refused/,
  );

  // Unknown return — not-found.
  await assert.rejects(
    labels.issueLabel(_labelInput(_uuid())),
    /not found/,
  );

  // Approved is acceptable.
  var approvedRma = await returns.request({
    order_id: o.id,
    reason:   "defective",
    lines:    [{ sku: v.sku, qty: 1 }],
  });
  await returns.approve(approvedRma.id, { refund_amount_minor: 1000 });
  var lab = await labels.issueLabel(_labelInput(approvedRma.id));
  check("issueLabel succeeds against approved RMA", lab.status === "issued");
}

async function _happyPath() {
  var q = _makeQuery();
  var seed   = await _seedApprovedRma(q);
  var labels = returnLabels.create({ query: q, returns: seed.returns });

  var lab = await labels.issueLabel(_labelInput(seed.rma.id));

  var shipped = await labels.markShipped({ label_id: lab.id });
  check("markShipped transitions to shipped",          shipped.status === "shipped");
  check("markShipped sets shipped_at",                  typeof shipped.shipped_at === "number");

  var scanA = await labels.markInTransit({ label_id: lab.id, location: "LAX hub" });
  check("markInTransit transitions to in_transit",     scanA.status === "in_transit");

  // Re-entry into in_transit on additional carrier scans.
  var scanB = await labels.markInTransit({ label_id: lab.id, location: "SFO hub" });
  check("markInTransit accepts re-entry",              scanB.status === "in_transit");
  var scanC = await labels.markInTransit({ label_id: lab.id, location: "Oakland sort" });
  check("markInTransit accepts a third scan",          scanC.status === "in_transit");

  var delivered = await labels.markDelivered({ label_id: lab.id });
  check("markDelivered transitions to delivered",      delivered.status === "delivered");
  check("markDelivered sets delivered_at",              typeof delivered.delivered_at === "number");

  // Returns FSM should now be in `received` state because the label
  // primitive called the injected returns.markReceived on delivery.
  var rma = await seed.returns.get(seed.rma.id);
  check("delivered flips RMA to received",              rma.status === "received");

  var events = await labels.eventsForLabel(lab.id);
  // issued + shipped + 3 in_transit + delivered = 6 rows
  check("eventsForLabel records full timeline",         events.length === 6);
  check("events ordered by occurred_at asc",            events[0].event_type === "issued");
  check("last event is delivered",                       events[events.length - 1].event_type === "delivered");
  var inTransitCount = events.filter(function (e) { return e.event_type === "in_transit"; }).length;
  check("three in_transit events recorded",              inTransitCount === 3);
}

async function _exceptionPaths() {
  var q = _makeQuery();
  var seed   = await _seedApprovedRma(q);
  var labels = returnLabels.create({ query: q, returns: seed.returns });

  // Issued → exception (carrier never picked it up)
  var lab1 = await labels.issueLabel(_labelInput(seed.rma.id));
  var ex1 = await labels.markException({ label_id: lab1.id, exception: "carrier never collected" });
  check("issued → exception",                          ex1.status === "exception");

  // Shipped → exception
  var seed2 = await _seedApprovedRma(_makeQuery());
  var q2 = _makeQuery();
  // We need a fresh seed for the second case to avoid the
  // already-received RMA preventing further label flows. Easier to
  // build a small inline seed than thread state across two DBs.
  void seed2;
  var seed2b = await _seedApprovedRma(q2);
  var labels2 = returnLabels.create({ query: q2, returns: seed2b.returns });
  var lab2 = await labels2.issueLabel(_labelInput(seed2b.rma.id));
  await labels2.markShipped({ label_id: lab2.id });
  var ex2 = await labels2.markException({ label_id: lab2.id, exception: "package destroyed in transit" });
  check("shipped → exception",                         ex2.status === "exception");

  // In_transit → exception
  var q3 = _makeQuery();
  var seed3 = await _seedApprovedRma(q3);
  var labels3 = returnLabels.create({ query: q3, returns: seed3.returns });
  var lab3 = await labels3.issueLabel(_labelInput(seed3.rma.id));
  await labels3.markShipped({ label_id: lab3.id });
  await labels3.markInTransit({ label_id: lab3.id, location: "in transit" });
  var ex3 = await labels3.markException({ label_id: lab3.id, exception: "lost between hubs" });
  check("in_transit → exception",                      ex3.status === "exception");

  // Exception is terminal — no further transitions allowed.
  await assert.rejects(
    labels3.markDelivered({ label_id: lab3.id }),
    /refused/,
  );
  await assert.rejects(
    labels3.markShipped({ label_id: lab3.id }),
    /refused/,
  );
}

async function _illegalTransitions() {
  var q = _makeQuery();
  var seed   = await _seedApprovedRma(q);
  var labels = returnLabels.create({ query: q, returns: seed.returns });
  var lab = await labels.issueLabel(_labelInput(seed.rma.id));

  // issued → delivered is not allowed (must pass through shipped first)
  await assert.rejects(labels.markDelivered({ label_id: lab.id }), /refused/);
  // issued → in_transit is not allowed
  await assert.rejects(labels.markInTransit({ label_id: lab.id }), /refused/);

  // Drive to delivered and then prove terminal refusal
  await labels.markShipped({ label_id: lab.id });
  await labels.markInTransit({ label_id: lab.id });
  await labels.markDelivered({ label_id: lab.id });
  await assert.rejects(labels.markShipped({ label_id: lab.id }), /refused/);
  await assert.rejects(labels.markInTransit({ label_id: lab.id }), /refused/);
  await assert.rejects(labels.markException({ label_id: lab.id, exception: "n/a" }), /refused/);

  // Not-found label
  await assert.rejects(labels.markShipped({ label_id: _uuid() }), /not found/);
}

async function _listQueries() {
  var q = _makeQuery();
  var seed   = await _seedApprovedRma(q);
  var labels = returnLabels.create({ query: q, returns: seed.returns });

  // Build 3 labels, all against the same approved RMA (legitimate
  // when an operator re-issues after exception).
  var lab1 = await labels.issueLabel(_labelInput(seed.rma.id));
  // ensure issued_at strictly advances so ASC ordering is stable
  await helpers.waitUntil(function () { return Date.now() > lab1.issued_at; }, { timeoutMs: 5000, label: "tick1" });
  var lab2 = await labels.issueLabel(_labelInput(seed.rma.id));
  await helpers.waitUntil(function () { return Date.now() > lab2.issued_at; }, { timeoutMs: 5000, label: "tick2" });
  var lab3 = await labels.issueLabel(_labelInput(seed.rma.id));

  // All three start in `issued` → pendingPickup returns all three.
  var pending = await labels.pendingPickup({ limit: 10 });
  check("pendingPickup returns all issued",           pending.length === 3);

  // Move lab2 to shipped, lab3 to in_transit
  await labels.markShipped({ label_id: lab2.id });
  await labels.markShipped({ label_id: lab3.id });
  await labels.markInTransit({ label_id: lab3.id });

  pending = await labels.pendingPickup({ limit: 10 });
  check("pendingPickup excludes shipped/in_transit",  pending.length === 1 && pending[0].id === lab1.id);

  var transit = await labels.inTransit({ limit: 10 });
  check("inTransit includes shipped + in_transit",    transit.length === 2);
  var ids = transit.map(function (r) { return r.id; }).sort();
  var expectedIds = [lab2.id, lab3.id].sort();
  check("inTransit returns the right rows",            ids[0] === expectedIds[0] && ids[1] === expectedIds[1]);

  // labelForReturn returns the most-recently-issued one
  var latest = await labels.labelForReturn(seed.rma.id);
  check("labelForReturn returns most recent",          latest.id === lab3.id);

  // limit validation
  await assert.rejects(labels.pendingPickup({ limit: 0 }),    /limit/);
  await assert.rejects(labels.pendingPickup({ limit: 9999 }), /limit/);
  await assert.rejects(labels.inTransit({ limit: 0 }),        /limit/);
}

async function _eventsTimeline() {
  var q = _makeQuery();
  var seed   = await _seedApprovedRma(q);
  var labels = returnLabels.create({ query: q, returns: seed.returns });

  var inputAt = Object.assign({}, _labelInput(seed.rma.id), { issued_at: 1700000000000 });
  var lab = await labels.issueLabel(inputAt);
  // Use caller-supplied timestamps so we can assert ordering
  // deterministically without waiting on clock advance.
  await labels.markShipped({ label_id: lab.id, shipped_at: 1700000001000 });
  await labels.markInTransit({ label_id: lab.id, location: "HUB", occurred_at: 1700000002000 });
  await labels.markInTransit({ label_id: lab.id, location: "HUB2", occurred_at: 1700000003000 });
  await labels.markDelivered({ label_id: lab.id, delivered_at: 1700000004000 });

  var events = await labels.eventsForLabel(lab.id);
  check("timeline has 5 rows",                         events.length === 5);
  check("issued event first",                          events[0].event_type === "issued");
  check("shipped event second",                        events[1].event_type === "shipped");
  check("in_transit event third",                      events[2].event_type === "in_transit");
  check("in_transit event fourth",                     events[3].event_type === "in_transit");
  check("delivered event last",                        events[4].event_type === "delivered");

  var shippedDetail = JSON.parse(events[1].detail_json);
  check("shipped event detail carries shipped_at",     shippedDetail.shipped_at === 1700000001000);
  var firstScan = JSON.parse(events[2].detail_json);
  check("in_transit event carries location",           firstScan.location === "HUB");
  var deliveredDetail = JSON.parse(events[4].detail_json);
  check("delivered event detail carries delivered_at", deliveredDetail.delivered_at === 1700000004000);
}

async function _validation() {
  var q = _makeQuery();
  var seed   = await _seedApprovedRma(q);
  var labels = returnLabels.create({ query: q, returns: seed.returns });

  // issueLabel — shape + field validation
  await assert.rejects(labels.issueLabel(),                                 /input object required/);
  await assert.rejects(labels.issueLabel({}),                                /return_id/);
  await assert.rejects(labels.issueLabel({ return_id: "not-uuid" }),         /return_id/);

  var base = _labelInput(seed.rma.id);
  function _with(over) {
    var out = {};
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    for (var k2 in over) {
      if (Object.prototype.hasOwnProperty.call(over, k2)) out[k2] = over[k2];
    }
    return out;
  }

  await assert.rejects(labels.issueLabel(_with({ carrier: "" })),               /carrier/);
  await assert.rejects(labels.issueLabel(_with({ carrier: "x".repeat(200) })),  /carrier/);
  await assert.rejects(labels.issueLabel(_with({ service_level: "" })),         /service_level/);
  await assert.rejects(labels.issueLabel(_with({ weight_grams: 0 })),           /weight_grams/);
  await assert.rejects(labels.issueLabel(_with({ weight_grams: -5 })),          /weight_grams/);
  await assert.rejects(labels.issueLabel(_with({ weight_grams: 1.5 })),         /weight_grams/);
  await assert.rejects(labels.issueLabel(_with({ tracking_number: "" })),       /tracking_number/);
  await assert.rejects(labels.issueLabel(_with({ cost_minor: -1 })),            /cost_minor/);
  await assert.rejects(labels.issueLabel(_with({ currency: "usd" })),           /currency/);
  await assert.rejects(labels.issueLabel(_with({ currency: "ZZZZ" })),          /currency/);

  // label_url runs through b.safeUrl — non-HTTPS, malformed, and
  // credentialed URLs all refuse.
  await assert.rejects(labels.issueLabel(_with({ label_url: "ftp://x/y" })),                       /label_url/);
  await assert.rejects(labels.issueLabel(_with({ label_url: "not-a-url" })),                       /label_url/);
  await assert.rejects(labels.issueLabel(_with({ label_url: "https://user:pass@labels.example.com/x.pdf" })), /label_url/);

  // control bytes
  await assert.rejects(labels.issueLabel(_with({ carrier: "USPS\x00" })),       /control bytes/);

  // transition input shape
  await assert.rejects(labels.markShipped(),                                    /input object required/);
  await assert.rejects(labels.markShipped({ label_id: "not-uuid" }),            /label_id/);
  await assert.rejects(labels.markShipped({ label_id: _uuid(), shipped_at: -1 }), /shipped_at/);
  await assert.rejects(labels.markInTransit({ label_id: _uuid(), occurred_at: "no" }), /occurred_at/);
  await assert.rejects(labels.markException({ label_id: _uuid(), exception: "" }), /exception/);

  // list validators
  await assert.rejects(labels.pendingPickup({ limit: -1 }), /limit/);
  await assert.rejects(labels.inTransit({ limit: -1 }),     /limit/);

  // getLabel + eventsForLabel + labelForReturn validators
  await assert.rejects(labels.getLabel("not-uuid"),         /label_id/);
  await assert.rejects(labels.eventsForLabel("not-uuid"),   /label_id/);
  await assert.rejects(labels.labelForReturn("not-uuid"),   /return_id/);
}

async function run() {
  await _issueAndPersist();
  await _refusesUnlessApproved();
  await _happyPath();
  await _exceptionPaths();
  await _illegalTransitions();
  await _listQueries();
  await _eventsTimeline();
  await _validation();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/return-labels.test.js`.
if (require.main === module) {
  run().then(function () {
    var n = helpers.getChecks();
    process.stdout.write("PASS return-labels (" + n + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("FAIL return-labels: " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
