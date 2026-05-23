"use strict";
/**
 * orderTimeline — aggregated event feed across order / shipment /
 * notes / returns / fraud / shipping-label / notification sources.
 *
 * Layer 1 against in-memory node:sqlite loaded from the migrations
 * each source primitive owns + the 0054 cache migration.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/order-timeline.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - forOrder mixes events from order / shipment / notes / returns
 *     / fraud / shipping-label / notification sources, newest-first
 *   - customer_visible_only flag filters internal events
 *     (start_fulfillment, internal notes, fraud decisions, labels)
 *   - summarize() builds milestones from order_transitions
 *   - customerVisibleFor() applies per-locale title overrides
 *   - recentActivity() flattens across orders + scopes to customer
 *   - cache freshness — second summarize() hits the cached row
 *     unless a new source event lands afterwards
 *   - skip-injected-peers — factory tolerates missing peers cleanly
 *   - validation refusals on bad inputs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var orderTimeline = require("../../lib/order-timeline");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql",
  "0021_shipments.sql",
  "0023_returns.sql",
  "0024_notifications.sql",
  "0037_order_notes.sql",
  "0038_fraud_screenings.sql",
  "0051_shipping_labels.sql",
  "0054_order_timeline_cache.sql",
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

// Monotonic counter so per-seed catalog identifiers (slug / sku)
// never collide on the catalog UNIQUE indexes even when two seed
// calls land in the same UUIDv7 millisecond bucket.
var _seedCounter = 0;
function _seedSuffix() { _seedCounter += 1; return String(_seedCounter); }

// Seed a paid+shipped order on its way through fulfillment. Returns
// every primitive wired against the shared `query` so tests that
// want to add notes / returns / fraud rows can compose downstream.
async function _seedRichOrder(query, opts) {
  opts = opts || {};
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var orderTracking = bShop.orderTracking.create({ query: query });
  var orderNotes = bShop.orderNotes.create({ query: query, cursorSecret: "ot-test-notes" });
  var returns = bShop.returns.create({ query: query, cursorSecret: "ot-test-returns" });
  var fraudScreen = bShop.fraudScreen.create({ query: query, cursorSecret: "ot-test-fraud" });

  // Unique slug + sku per seed call so multiple seeds against the
  // same in-memory DB don't collide on the catalog UNIQUE indexes.
  var suffix = _seedSuffix();
  var slug = opts.slug || ("ot-test-" + suffix);
  var sku  = opts.sku  || ("OT-" + suffix);
  var p = await catalog.products.create({ slug: slug, title: "Timeline Test", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 4999 });
  var sessionId = _validUUID();
  var c = await cart.create(sessionId, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1 });

  var customerId = opts.customer_id || _validUUID();
  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sessionId,
    customer_id:       customerId,
    currency:          "USD",
    subtotal_minor:    4999,
    discount_minor:    0,
    tax_minor:         400,
    shipping_minor:    695,
    grand_total_minor: 6094,
    ship_to:           { country: "US" },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               1,
      unit_amount_minor: 4999,
      unit_currency:     "USD",
    }],
  });
  o = await order.transition(o.id, "mark_paid");
  o = await order.transition(o.id, "start_fulfillment");
  o = await order.transition(o.id, "mark_shipped");

  // One shipment + two carrier events.
  var sh = await orderTracking.createShipment({
    order_id:        o.id,
    carrier:         "ups",
    tracking_number: "1Z999AA10123456784",
    weight_grams:    450,
  });
  await orderTracking.recordEvent({
    shipment_id: sh.id,
    status:      "in-transit",
    location:    "Origin Facility",
    detail:      "Departed origin",
    occurred_at: Date.now() + 100,
  });
  await orderTracking.recordEvent({
    shipment_id: sh.id,
    status:      "out-for-delivery",
    location:    "Local depot",
    detail:      "On the truck",
    occurred_at: Date.now() + 200,
  });

  return {
    query:         query,
    order:         order,
    orderTracking: orderTracking,
    orderNotes:    orderNotes,
    returns:       returns,
    fraudScreen:   fraudScreen,
    orderRow:      o,
    shipmentId:    sh.id,
    customerId:    customerId,
    sku:           sku,
  };
}

// ---- forOrder mixes sources --------------------------------------------

async function _forOrderMixesSources() {
  var q = _makeQuery();
  var seed = await _seedRichOrder(q);

  // Customer-visible note (renders on order page) + internal note.
  await seed.orderNotes.add({
    order_id:   seed.orderRow.id,
    author:     "operator",
    visibility: "customer_visible",
    body:       "We bumped your order to expedited shipping.",
  });
  await seed.orderNotes.add({
    order_id:   seed.orderRow.id,
    author:     "operator",
    visibility: "internal",
    body:       "Customer is a VIP — handle white-glove.",
  });

  // RMA round-trip.
  var rma = await seed.returns.request({
    order_id: seed.orderRow.id,
    reason:   "defective",
    lines:    [{ sku: seed.sku, qty: 1 }],
  });
  await seed.returns.approve(rma.id, { refund_amount_minor: 4999, refund_currency: "USD" });

  // Fraud screen verdict.
  await seed.fraudScreen.screen({
    order_draft: {
      order_id:            seed.orderRow.id,
      email:               "shopper@example.com",
      currency:            "USD",
      total_minor:         6094,
      session_age_seconds: 120,
      shipping_address:    { country: "US" },
      billing_address:     { country: "US" },
      line_count:          1,
    },
  });

  // Shipping label row (direct INSERT since the shippingLabels
  // primitive surface isn't wired into bShop yet — the table is
  // canonical at 0051).
  await q(
    "INSERT INTO shipping_labels (id, shipment_id, carrier, service_level, " +
    "weight_grams, length_mm, width_mm, height_mm, package_type, status, " +
    "tracking_number, label_url, cost_minor, currency, purchased_via, " +
    "created_at, purchased_at) " +
    "VALUES (?1, ?2, 'ups', 'ground', 450, 300, 200, 100, 'parcel', " +
    "'purchased', '1Z999AA10123456784', 'https://labels.example/1.pdf', " +
    "895, 'USD', 'easypost', ?3, ?4)",
    [_validUUID(), seed.shipmentId, Date.now() - 1000, Date.now() - 500],
  );

  // Notification keyed by payload_json containing the order_id.
  var notifyTs = Date.now() + 300;
  await q(
    "INSERT INTO notifications (id, recipient_id, recipient_id_hash, channel, " +
    "event_type, title, body, payload_json, status, scheduled_at, sent_at, " +
    "retry_count, created_at, updated_at) " +
    "VALUES (?1, 'rcpt-hash', 'rcpt-hash', 'email', 'order.shipped', " +
    "'Your order shipped', 'Tracking link inside.', ?2, 'sent', ?3, ?3, 0, ?3, ?3)",
    [
      _validUUID(),
      JSON.stringify({ order_id: seed.orderRow.id, shipment_id: seed.shipmentId }),
      notifyTs,
    ],
  );

  var tl = orderTimeline.create({
    query:          q,
    order:          seed.order,
    orderTracking:  seed.orderTracking,
    orderNotes:     seed.orderNotes,
    returns:        seed.returns,
    fraudScreen:    seed.fraudScreen,
    shippingLabels: { __injected: true }, // marker — table query inside
    notifications:  { __injected: true }, // marker — payload-LIKE inside
  });

  var feed = await tl.forOrder({ order_id: seed.orderRow.id });
  check("forOrder returns array",                          Array.isArray(feed));
  check("forOrder mixes order events",                     feed.some(function (e) { return e.kind === "order.mark_paid"; }));
  check("forOrder mixes shipment events",                  feed.some(function (e) { return e.kind === "shipment.in-transit"; }));
  check("forOrder mixes notes (customer-visible)",         feed.some(function (e) { return e.kind === "note.customer_visible"; }));
  check("forOrder mixes notes (internal)",                 feed.some(function (e) { return e.kind === "note.internal"; }));
  check("forOrder mixes return.requested",                 feed.some(function (e) { return e.kind === "return.requested"; }));
  check("forOrder mixes return.approved",                  feed.some(function (e) { return e.kind === "return.approved"; }));
  check("forOrder mixes fraud.decision",                   feed.some(function (e) { return e.kind === "fraud.decision"; }));
  check("forOrder mixes label.requested",                  feed.some(function (e) { return e.kind === "label.requested"; }));
  check("forOrder mixes label.purchased",                  feed.some(function (e) { return e.kind === "label.purchased"; }));
  check("forOrder mixes notification.order.shipped",       feed.some(function (e) { return e.kind === "notification.order.shipped"; }));

  // Newest-first ordering: each consecutive pair has b.occurred_at
  // <= a.occurred_at.
  var monotonic = true;
  for (var i = 1; i < feed.length; i += 1) {
    if (feed[i].occurred_at > feed[i - 1].occurred_at) { monotonic = false; break; }
  }
  check("forOrder newest-first ordering",                  monotonic);

  // Every event has the documented shape fields.
  var shapeOk = feed.every(function (e) {
    return typeof e.kind === "string"
        && typeof e.occurred_at === "number"
        && typeof e.title === "string"
        && (e.body === null || typeof e.body === "string")
        && (e.actor === null || typeof e.actor === "string")
        && (e.link === null || typeof e.link === "string");
  });
  check("forOrder events have documented shape",           shapeOk);

  // Shipment event has a tracking URL link.
  var shipEv = feed.filter(function (e) { return e.kind === "shipment.in-transit"; })[0];
  check("forOrder shipment event surfaces tracking link",  typeof shipEv.link === "string" && shipEv.link.indexOf("ups.com") !== -1);
}

// ---- customer_visible_only filter --------------------------------------

async function _customerVisibleOnlyFilter() {
  var q = _makeQuery();
  var seed = await _seedRichOrder(q);

  await seed.orderNotes.add({
    order_id:   seed.orderRow.id,
    author:     "operator",
    visibility: "customer_visible",
    body:       "Customer-facing note.",
  });
  await seed.orderNotes.add({
    order_id:   seed.orderRow.id,
    author:     "operator",
    visibility: "internal",
    body:       "Internal-only handoff.",
  });
  await seed.fraudScreen.screen({
    order_draft: {
      order_id:            seed.orderRow.id,
      email:               "shopper2@example.com",
      currency:            "USD",
      total_minor:         6094,
      session_age_seconds: 240,
      shipping_address:    { country: "US" },
      billing_address:     { country: "US" },
      line_count:          1,
    },
  });

  var tl = orderTimeline.create({
    query:         q,
    order:         seed.order,
    orderTracking: seed.orderTracking,
    orderNotes:    seed.orderNotes,
    fraudScreen:   seed.fraudScreen,
  });

  var visible = await tl.forOrder({
    order_id:              seed.orderRow.id,
    customer_visible_only: true,
  });

  check("customer_visible_only hides internal notes",  !visible.some(function (e) { return e.kind === "note.internal"; }));
  check("customer_visible_only hides fraud decisions", !visible.some(function (e) { return e.kind === "fraud.decision"; }));
  check("customer_visible_only hides start_fulfillment", !visible.some(function (e) { return e.kind === "order.start_fulfillment"; }));
  check("customer_visible_only surfaces customer note", visible.some(function (e) { return e.kind === "note.customer_visible"; }));
  check("customer_visible_only surfaces order.mark_paid", visible.some(function (e) { return e.kind === "order.mark_paid"; }));
  check("customer_visible_only surfaces order.mark_shipped", visible.some(function (e) { return e.kind === "order.mark_shipped"; }));

  // Sanity: the unfiltered feed includes everything the filtered
  // feed dropped.
  var all = await tl.forOrder({ order_id: seed.orderRow.id });
  check("forOrder default includes internal events",   all.some(function (e) { return e.kind === "note.internal"; }));
  check("forOrder default includes fraud decision",    all.some(function (e) { return e.kind === "fraud.decision"; }));
}

// ---- summarize milestones ---------------------------------------------

async function _summarizeMilestones() {
  var q = _makeQuery();
  var seed = await _seedRichOrder(q);

  var tl = orderTimeline.create({
    query:         q,
    order:         seed.order,
    orderTracking: seed.orderTracking,
  });

  var sum = await tl.summarize(seed.orderRow.id);
  check("summarize returns status",        sum.status === "shipped");
  check("summarize returns event_count",   typeof sum.event_count === "number" && sum.event_count > 0);
  check("summarize returns first_event_at", typeof sum.first_event_at === "number");
  check("summarize returns last_event_at",  typeof sum.last_event_at === "number");
  check("summarize milestones.paid_at",     typeof sum.milestones.paid_at === "number");
  check("summarize milestones.fulfilled_at", typeof sum.milestones.fulfilled_at === "number");
  check("summarize milestones.shipped_at",  typeof sum.milestones.shipped_at === "number");
  check("summarize no delivered_at yet",    sum.milestones.delivered_at == null);
  check("summarize no refunded_at yet",     sum.milestones.refunded_at == null);
  check("summarize first hit no cache",     sum.cache_hit === false);

  // Cache is now populated; the second call hits the cached row.
  var sum2 = await tl.summarize(seed.orderRow.id);
  check("summarize second call hits cache", sum2.cache_hit === true);
  check("summarize cached event_count matches", sum2.event_count === sum.event_count);

  // Confirm the cache row landed.
  var cacheRow = (await q(
    "SELECT * FROM order_timeline_cache WHERE order_id = ?1",
    [seed.orderRow.id],
  )).rows[0];
  check("cache row written by summarize",        cacheRow != null);
  check("cache row carries event_count",         Number(cacheRow.event_count) === sum.event_count);
  check("cache row carries milestones_json",     cacheRow.milestones_json.indexOf("paid_at") !== -1);
}

// ---- customerVisibleFor localization ----------------------------------

async function _customerVisibleForLocale() {
  var q = _makeQuery();
  var seed = await _seedRichOrder(q);
  await seed.orderNotes.add({
    order_id:   seed.orderRow.id,
    author:     "operator",
    visibility: "customer_visible",
    body:       "Bumped to expedited.",
  });

  var tl = orderTimeline.create({
    query:         q,
    order:         seed.order,
    orderTracking: seed.orderTracking,
    orderNotes:    seed.orderNotes,
  });

  var en = await tl.customerVisibleFor(seed.orderRow.id, { locale: "en-US" });
  check("customerVisibleFor en locale echoes",  en.locale === "en-US");
  check("customerVisibleFor en order.mark_paid title", en.events.some(function (e) {
    return e.kind === "order.mark_paid" && e.title === "Payment received";
  }));
  check("customerVisibleFor en shipped title", en.events.some(function (e) {
    return e.kind === "order.mark_shipped" && e.title === "Order shipped";
  }));

  var es = await tl.customerVisibleFor(seed.orderRow.id, { locale: "es" });
  check("customerVisibleFor es locale echoes",  es.locale === "es");
  check("customerVisibleFor es order.mark_paid title", es.events.some(function (e) {
    return e.kind === "order.mark_paid" && e.title === "Pago recibido";
  }));

  var de = await tl.customerVisibleFor(seed.orderRow.id, { locale: "de-CH" });
  // de-CH falls back to the de catalog via primary-subtag resolution.
  check("customerVisibleFor de-CH falls back to de", de.events.some(function (e) {
    return e.kind === "order.mark_paid" && e.title === "Zahlung erhalten";
  }));

  // Locale with no entry falls back to canonical English.
  var ja = await tl.customerVisibleFor(seed.orderRow.id, { locale: "ja-JP" });
  check("customerVisibleFor unknown locale falls back to English", ja.events.some(function (e) {
    return e.kind === "order.mark_paid" && e.title === "Payment received";
  }));

  // No internal events leak.
  check("customerVisibleFor never includes start_fulfillment", !en.events.some(function (e) {
    return e.kind === "order.start_fulfillment";
  }));
}

// ---- recentActivity feed ----------------------------------------------

async function _recentActivityFeed() {
  var q = _makeQuery();
  var customerA = _validUUID();
  var customerB = _validUUID();
  var seedA = await _seedRichOrder(q, { customer_id: customerA });
  var seedB = await _seedRichOrder(q, { customer_id: customerB });

  var tl = orderTimeline.create({
    query:         q,
    order:         seedA.order,
    orderTracking: seedA.orderTracking,
  });

  // Warm the cache so the scope query has a last_event_at.
  await tl.summarize(seedA.orderRow.id);
  await tl.summarize(seedB.orderRow.id);

  var feed = await tl.recentActivity({ limit: 50 });
  check("recentActivity returns array",                Array.isArray(feed));
  check("recentActivity includes events from order A", feed.some(function (e) { return e.order_id === seedA.orderRow.id; }));
  check("recentActivity includes events from order B", feed.some(function (e) { return e.order_id === seedB.orderRow.id; }));
  check("recentActivity newest-first",                 feed.length < 2 || feed[0].occurred_at >= feed[1].occurred_at);
  check("recentActivity respects limit",               feed.length <= 50);
  check("recentActivity carries order_id on each row", feed.every(function (e) { return typeof e.order_id === "string"; }));

  var scoped = await tl.recentActivity({ limit: 20, customer_id: customerA });
  check("recentActivity customer scope hides other orders", scoped.every(function (e) { return e.order_id === seedA.orderRow.id; }));
}

// ---- cache freshness --------------------------------------------------

async function _cacheFreshness() {
  var q = _makeQuery();
  var seed = await _seedRichOrder(q);

  var tl = orderTimeline.create({
    query:         q,
    order:         seed.order,
    orderTracking: seed.orderTracking,
    orderNotes:    bShop.orderNotes.create({ query: q, cursorSecret: "ot-cache-test" }),
  });

  var first = await tl.summarize(seed.orderRow.id);
  check("cache miss on first summarize",  first.cache_hit === false);

  var hit = await tl.summarize(seed.orderRow.id);
  check("cache hit on second summarize",  hit.cache_hit === true);

  // New order event invalidates the cache.
  await seed.order.transition(seed.orderRow.id, "mark_delivered");

  var third = await tl.summarize(seed.orderRow.id);
  check("cache invalidated by new order event", third.cache_hit === false);
  check("summarize picks up new milestone",     typeof third.milestones.delivered_at === "number");
  check("summarize reflects new status",        third.status === "delivered");

  // purgeStaleCache removes rows older than the bound.
  var purge = await tl.purgeStaleCache(0); // bound=0 means purge ALL via fallback default
  // The fallback default keeps anything written in the last 60 minutes,
  // so a fresh row stays. Use a large bound to keep, tiny to purge —
  // here, default (CACHE_TTL_MS * 12) keeps the fresh row.
  check("purgeStaleCache returns shape",  typeof purge.purged === "number");
}

// ---- skip-injected-peers ----------------------------------------------

async function _skipInjectedPeers() {
  var q = _makeQuery();
  var seed = await _seedRichOrder(q);

  // Wire only `order` — every other source omitted. The factory
  // must still build, and forOrder must still return the order
  // transitions.
  var tl = orderTimeline.create({
    query: q,
    order: seed.order,
  });

  var feed = await tl.forOrder({ order_id: seed.orderRow.id });
  check("skip-peers feed surfaces order events",   feed.some(function (e) { return e.kind === "order.mark_paid"; }));
  check("skip-peers feed has no shipment events",  !feed.some(function (e) { return e.kind.indexOf("shipment.") === 0; }));
  check("skip-peers feed has no notes",            !feed.some(function (e) { return e.kind.indexOf("note.") === 0; }));
  check("skip-peers feed has no returns",          !feed.some(function (e) { return e.kind.indexOf("return.") === 0; }));
  check("skip-peers feed has no fraud",            !feed.some(function (e) { return e.kind.indexOf("fraud.") === 0; }));

  // summarize still works with only the order primitive wired.
  var sum = await tl.summarize(seed.orderRow.id);
  check("skip-peers summarize milestones.paid_at", typeof sum.milestones.paid_at === "number");
}

// ---- validation refusals ----------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var tl = orderTimeline.create({ query: q });

  await assert.rejects(tl.forOrder(),                                   /input object required/);
  await assert.rejects(tl.forOrder({}),                                 /order_id/);
  await assert.rejects(tl.forOrder({ order_id: "not-a-uuid" }),         /order_id/);
  await assert.rejects(tl.forOrder({ order_id: _validUUID(), customer_visible_only: "yes" }), /customer_visible_only/);

  await assert.rejects(tl.summarize("not-a-uuid"),                      /order_id/);

  await assert.rejects(tl.customerVisibleFor(_validUUID()),             /options object required/);
  await assert.rejects(tl.customerVisibleFor(_validUUID(), {}),         /locale/);
  await assert.rejects(tl.customerVisibleFor(_validUUID(), { locale: "english" }), /locale/);

  await assert.rejects(tl.compareOrders(),                              /2-element array/);
  await assert.rejects(tl.compareOrders([_validUUID()]),                /2-element array/);
  await assert.rejects(tl.compareOrders(["bad", _validUUID()]),         /orderIds\[0\]/);

  await assert.rejects(tl.recentActivity(),                             /options object required/);
  await assert.rejects(tl.recentActivity({ limit: 0 }),                 /limit/);
  await assert.rejects(tl.recentActivity({ limit: 9999 }),              /limit/);
  await assert.rejects(tl.recentActivity({ limit: 10, customer_id: "bad" }), /customer_id/);
}

// ---- compareOrders ----------------------------------------------------

async function _compareOrdersSideBySide() {
  var q = _makeQuery();
  var seedA = await _seedRichOrder(q);
  var seedB = await _seedRichOrder(q);

  var tl = orderTimeline.create({
    query:         q,
    order:         seedA.order,
    orderTracking: seedA.orderTracking,
  });

  var cmp = await tl.compareOrders([seedA.orderRow.id, seedB.orderRow.id]);
  check("compareOrders.a.order_id matches",         cmp.a.order_id === seedA.orderRow.id);
  check("compareOrders.b.order_id matches",         cmp.b.order_id === seedB.orderRow.id);
  check("compareOrders.a.timeline is array",        Array.isArray(cmp.a.timeline));
  check("compareOrders.b.timeline is array",        Array.isArray(cmp.b.timeline));
  check("compareOrders.a has mark_paid",            cmp.a.timeline.some(function (e) { return e.kind === "order.mark_paid"; }));
  check("compareOrders.b has mark_paid",            cmp.b.timeline.some(function (e) { return e.kind === "order.mark_paid"; }));
}

async function run() {
  await _forOrderMixesSources();
  await _customerVisibleOnlyFilter();
  await _summarizeMilestones();
  await _customerVisibleForLocale();
  await _recentActivityFeed();
  await _cacheFreshness();
  await _skipInjectedPeers();
  await _validationRefusals();
  await _compareOrdersSideBySide();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/order-timeline.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — order-timeline (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — order-timeline: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
