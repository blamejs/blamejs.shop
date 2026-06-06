"use strict";
/**
 * wishlistAlerts — notify customers when wishlist items go on sale or
 * come back in stock.
 *
 * Layer 1 against in-memory node:sqlite loaded from:
 *   - 0001 (catalog: products / variants / prices / inventory)
 *   - 0012 (wishlist_entries)
 *   - 0156 (wishlist_alert_policies / wishlist_alerts_sent /
 *           wishlist_alert_unsubscribes)
 *
 * Direct require of `lib/wishlist-alerts.js` — the primitive isn't
 * wired into `lib/index.js` (entry-point edit is out of scope for this
 * ship; same posture as refundAutomation / planChanges).
 *
 * Coverage:
 *   - defineAlertPolicy persists every column; refuses redefine
 *   - defineAlertPolicy refuses bad threshold for price_drop
 *   - scanAndDispatch fires when a price_drop condition matches +
 *     writes the sent-ledger row
 *   - scanAndDispatch fires when a back_in_stock condition matches
 *   - max_alerts_per_week_per_customer caps deliveries
 *   - unsubscribeFromAlertKind blocks future sends for that trigger
 *   - markAlertSent updates the channel on an existing row
 *   - metricsForPolicy rolls counts by channel in a time window
 *   - customerAlertHistory paginates with HMAC-tagged cursor
 *   - refusals: bad slug, bad trigger, bad threshold shape, missing
 *     handles at factory time
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var wishlistAlerts = require("../../lib/wishlist-alerts");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0012_wishlist.sql",
  "0156_wishlist_alerts.sql",
  "0214_wishlist_alert_state.sql",
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
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Stub email handle — records every sendWishlistDiscount call so the
// gates can verify composition without going through `b.mail`.
function _stubEmail() {
  var calls = [];
  var nextResult = { ok: true, id: "msg_stub" };
  return {
    calls: calls,
    setNextResult: function (r) { nextResult = r; },
    handle: {
      sendWishlistDiscount: async function (input) {
        calls.push(input);
        if (nextResult instanceof Error) throw nextResult;
        return nextResult;
      },
    },
  };
}

// Standing fixture — products + variants + initial price + inventory.
// Returns the ids needed for the test assertions.
async function _seedCatalog(query, opts) {
  opts = opts || {};
  var catalog = bShop.catalog.create({ query: query });
  var prod = await catalog.products.create({ slug: opts.slug || "widget", title: opts.title || "Widget", status: "active" });
  var variant = await catalog.variants.create(prod.id, { sku: opts.sku || "SKU-1" });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: opts.initial_amount_minor || 5000 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: opts.initial_stock != null ? opts.initial_stock : 10 });
  return { catalog: catalog, product: prod, variant: variant };
}

// Build the trio every test needs: query + catalog + wishlist + alerts.
function _wire(extra) {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var wishlist = bShop.wishlist.create({ query: query });
  var emailStub = _stubEmail();
  var emailForCustomerMap = (extra || {}).emails || {};
  var alerts = wishlistAlerts.create(Object.assign({
    query:    query,
    wishlist: wishlist,
    catalog:  catalog,
    email:    emailStub.handle,
    emailForCustomer: async function (customerId) { return emailForCustomerMap[customerId] || null; },
  }, extra || {}));
  return {
    query:    query,
    catalog:  catalog,
    wishlist: wishlist,
    email:    emailStub,
    alerts:   alerts,
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- tests --------------------------------------------------------------

async function _defineAlertPolicyPersistsAndRefusesRedefine() {
  var w = _wire();
  var p = await w.alerts.defineAlertPolicy({
    slug:                             "drop-20",
    trigger:                          "price_drop",
    threshold:                        { percent_off_bps_min: 2000 },
    max_alerts_per_week_per_customer: 3,
  });
  check("defineAlertPolicy returns slug",                p.slug === "drop-20");
  check("defineAlertPolicy returns trigger",             p.trigger === "price_drop");
  check("defineAlertPolicy returns threshold",           p.threshold && p.threshold.percent_off_bps_min === 2000);
  check("defineAlertPolicy returns weekly cap",          p.max_alerts_per_week_per_customer === 3);
  check("defineAlertPolicy created_at integer",          Number.isInteger(p.created_at) && p.created_at > 0);
  check("defineAlertPolicy archived_at null",            p.archived_at === null);

  // Round-trip via getAlertPolicy.
  var got = await w.alerts.getAlertPolicy("drop-20");
  check("getAlertPolicy round-trip slug",                got.slug === "drop-20");
  check("getAlertPolicy round-trip threshold preserved", got.threshold.percent_off_bps_min === 2000);

  // Refuse redefine — same posture as refundAutomation.
  await assert.rejects(w.alerts.defineAlertPolicy({
    slug: "drop-20", trigger: "price_drop", threshold: { percent_off_bps_min: 3000 },
  }), /already exists/);

  // Back-in-stock policy with NULL cap.
  var bis = await w.alerts.defineAlertPolicy({
    slug: "back-in", trigger: "back_in_stock", threshold: {},
  });
  check("back_in_stock weekly cap null",                 bis.max_alerts_per_week_per_customer === null);

  // listAlertPolicies returns both.
  var live = await w.alerts.listAlertPolicies({ live_only: true });
  check("listAlertPolicies returns 2 live",              live.length === 2);

  // archiveAlertPolicy hides from live-only.
  var arc = await w.alerts.archiveAlertPolicy("drop-20");
  check("archiveAlertPolicy returns archived: true",     arc.archived === true);
  var liveAfter = await w.alerts.listAlertPolicies({ live_only: true });
  check("post-archive live count 1",                     liveAfter.length === 1);
  // Re-archive is idempotent at the API surface (returns archived: false).
  var arc2 = await w.alerts.archiveAlertPolicy("drop-20");
  check("re-archive returns archived: false",            arc2.archived === false);
}

async function _scanAndDispatchFiresOnPriceDrop() {
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "alice@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({
    slug: "drop-20", trigger: "price_drop", threshold: { percent_off_bps_min: 2000 },
  });
  var seed = await _seedCatalog(w.query, { initial_amount_minor: 5000 });
  // Drop price from 50.00 → 35.00 (30% off, exceeds 20% threshold).
  await seed.catalog.prices.set(seed.variant.id, { currency: "USD", amount_minor: 3500 });

  await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });

  var rv = await w.alerts.scanAndDispatch({});
  check("scanAndDispatch scanned 1 entry",         rv.scanned === 1);
  check("scanAndDispatch candidates = 1",          rv.candidates === 1);
  check("scanAndDispatch sent = 1",                rv.sent === 1);
  check("email handle called once",                w.email.calls.length === 1);
  check("email handle got customer email",         w.email.calls[0].customer_email === "alice@example.com");
  check("email handle got product title",          w.email.calls[0].product_title === "Widget");
  check("email handle got discount_pct",           w.email.calls[0].discount_pct === "30%");

  // Re-scan against the SAME drop depth — no fresh fire. The transition
  // gate catches the steady drop (the price hasn't dropped further) before
  // the dedupe window would; either way the steady state never re-fires.
  var rv2 = await w.alerts.scanAndDispatch({});
  check("re-scan steady drop — sent = 0",          rv2.sent === 0);
  check("re-scan accounted in skipped",            rv2.skipped >= 1);
  check("re-scan skipped_by.no_deeper_drop = 1",   rv2.skipped_by.no_deeper_drop === 1);

  // Even a re-scan a full dedupe window later still does not re-fire a
  // steady drop — the transition gate, not the dedupe window, is the
  // guard now (P2-A: steady state must never re-fire, dedupe or not).
  var rv3 = await w.alerts.scanAndDispatch({ now: Date.now() + 8 * 86400000 });
  check("re-scan past dedupe window still no re-fire", rv3.sent === 0);

  // metricsForPolicy reflects the one delivery.
  var metrics = await w.alerts.metricsForPolicy({
    slug: "drop-20",
    from: 0,
    to:   Date.now() + 86400000,
  });
  check("metricsForPolicy total = 1",              metrics.total === 1);
  check("metricsForPolicy by_channel.email = 1",   metrics.by_channel.email === 1);
}

// back_in_stock fires on the out -> in TRANSITION, never on a steady
// in-stock state. An item already in stock when first wishlisted has no
// observed restock event, so it does NOT fire; a restock AFTER an
// observed out-of-stock sweep does. A steady in-stock state never
// re-fires, dedupe window or not (P2-A).
async function _scanAndDispatchFiresOnBackInStock() {
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "bob@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({
    slug: "restock-any", trigger: "back_in_stock", threshold: {},
  });
  // Seed OUT of stock so the scanner observes the out state first.
  var seed = await _seedCatalog(w.query, { initial_stock: 0 });
  await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });

  // Sweep 1: out of stock — observe the out state, fire nothing.
  var rv0 = await w.alerts.scanAndDispatch({});
  check("out-of-stock first sweep fires nothing",  rv0.sent === 0);
  check("out-of-stock accounted still_out_of_stock", rv0.skipped_by.still_out_of_stock === 1);

  // Sweep 2: an item that was ALREADY in stock at first observation does
  // NOT fire — there's no observed restock. Verify with a second item.
  var inStockSeed = await _seedCatalog(w.query, { slug: "already-in", title: "AlreadyIn", sku: "SKU-AI", initial_stock: 7 });
  await w.wishlist.add({ customer_id: customerId, product_id: inStockSeed.product.id, variant_id: inStockSeed.variant.id });
  var rvFirstSeen = await w.alerts.scanAndDispatch({});
  check("already-in-stock first observation does not fire", rvFirstSeen.sent === 0);
  check("already-in accounted no_restock_transition",
    rvFirstSeen.skipped_by.no_restock_transition >= 1);

  // Restock the originally-out item: out -> in transition fires once.
  await w.query("UPDATE inventory SET stock_on_hand = 5 WHERE sku = ?1", [seed.variant.sku]);
  var beforeCalls = w.email.calls.length;
  var rv = await w.alerts.scanAndDispatch({});
  check("back_in_stock fires on out->in transition", rv.sent === 1);
  check("email handle called for the restock",      w.email.calls.length === beforeCalls + 1);
  var restockCall = w.email.calls[w.email.calls.length - 1];
  check("email handle product title rendered",      restockCall.product_title === "Widget");
  check("email handle price slot is dash",          restockCall.old_price === "—" && restockCall.new_price === "—");

  // Steady in-stock — a re-scan a full dedupe window later does NOT
  // re-fire (P2-A: steady state never re-fires).
  var rv2 = await w.alerts.scanAndDispatch({ now: Date.now() + 8 * 86400000 });
  check("steady in-stock does not re-fire",          rv2.sent === 0);

  // Drain to zero then restock again — a SECOND genuine transition fires.
  await w.query("UPDATE inventory SET stock_on_hand = 0 WHERE sku = ?1", [seed.variant.sku]);
  await w.alerts.scanAndDispatch({ now: Date.now() + 16 * 86400000 });   // observe out
  await w.query("UPDATE inventory SET stock_on_hand = 3 WHERE sku = ?1", [seed.variant.sku]);
  var rv3 = await w.alerts.scanAndDispatch({ now: Date.now() + 17 * 86400000 });
  check("second out->in transition fires again",     rv3.sent === 1);
}

async function _scanAndDispatchBelowThresholdDoesNotFire() {
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "ada@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({
    slug: "drop-20", trigger: "price_drop", threshold: { percent_off_bps_min: 2000 },
  });
  var seed = await _seedCatalog(w.query, { initial_amount_minor: 5000 });
  // Drop only 10% — below the 20% threshold.
  await seed.catalog.prices.set(seed.variant.id, { currency: "USD", amount_minor: 4500 });
  await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });

  var rv = await w.alerts.scanAndDispatch({});
  check("below-threshold drop does not fire",      rv.sent === 0);
  check("below-threshold accounted in skipped_by", rv.skipped_by.below_threshold === 1);
}

async function _weeklyCapBlocksDelivery() {
  // Three customers, three wishlisted variants — each customer's
  // weekly cap is 1 — only one delivery per customer should land
  // even though two policies match.
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "cap@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({
    slug: "drop-policy", trigger: "price_drop", threshold: { percent_off_bps_min: 1000 },
    max_alerts_per_week_per_customer: 1,
  });
  // Three variants for the same customer, each price-dropped.
  var s1 = await _seedCatalog(w.query, { slug: "a", title: "A", sku: "SKU-A1", initial_amount_minor: 5000 });
  var s2 = await _seedCatalog(w.query, { slug: "b", title: "B", sku: "SKU-B1", initial_amount_minor: 5000 });
  var s3 = await _seedCatalog(w.query, { slug: "c", title: "C", sku: "SKU-C1", initial_amount_minor: 5000 });
  await s1.catalog.prices.set(s1.variant.id, { currency: "USD", amount_minor: 3500 });
  await s2.catalog.prices.set(s2.variant.id, { currency: "USD", amount_minor: 3500 });
  await s3.catalog.prices.set(s3.variant.id, { currency: "USD", amount_minor: 3500 });
  await w.wishlist.add({ customer_id: customerId, product_id: s1.product.id, variant_id: s1.variant.id });
  await w.wishlist.add({ customer_id: customerId, product_id: s2.product.id, variant_id: s2.variant.id });
  await w.wishlist.add({ customer_id: customerId, product_id: s3.product.id, variant_id: s3.variant.id });

  var rv = await w.alerts.scanAndDispatch({});
  check("weekly cap = 1 → exactly one delivery",  rv.sent === 1);
  check("weekly cap accounted in skipped_by",     rv.skipped_by.weekly_cap_reached >= 2);
}

async function _unsubscribeFromAlertKindBlocks() {
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "no@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({
    slug: "drop", trigger: "price_drop", threshold: { percent_off_bps_min: 1000 },
  });
  // Seed OUT of stock so a later restock is an observable transition.
  var seed = await _seedCatalog(w.query, { initial_amount_minor: 5000, initial_stock: 0 });
  await seed.catalog.prices.set(seed.variant.id, { currency: "USD", amount_minor: 3500 });
  await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });

  // Customer opts out of price_drop before the scan.
  var u = await w.alerts.unsubscribeFromAlertKind({ customer_id: customerId, trigger: "price_drop" });
  check("unsubscribe returns id",                  typeof u.id === "string" && u.id.length > 0);
  check("unsubscribe returns status",              u.status === "unsubscribed");

  var rv = await w.alerts.scanAndDispatch({});
  check("opted-out customer never fires",          rv.sent === 0);
  check("opted-out accounted in skipped_by",       rv.skipped_by.unsubscribed === 1);

  // Re-unsubscribe is idempotent.
  var u2 = await w.alerts.unsubscribeFromAlertKind({ customer_id: customerId, trigger: "price_drop" });
  check("re-unsubscribe returns already-unsubscribed", u2.status === "already-unsubscribed");

  // Different trigger still fires (opt-out is per-trigger). Define the
  // back_in_stock policy, observe the out state, then restock so the
  // out -> in transition fires through the price_drop opt-out.
  await w.alerts.defineAlertPolicy({ slug: "back", trigger: "back_in_stock", threshold: {} });
  await w.alerts.scanAndDispatch({});   // observe out-of-stock for the back policy
  await w.query("UPDATE inventory SET stock_on_hand = 4 WHERE sku = ?1", [seed.variant.sku]);
  var rv2 = await w.alerts.scanAndDispatch({});
  check("back_in_stock fires through price_drop opt-out",  rv2.sent === 1);
}

async function _markAlertSentUpdatesChannel() {
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "ch@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({
    slug: "drop", trigger: "price_drop", threshold: { percent_off_bps_min: 1000 },
  });
  var seed = await _seedCatalog(w.query, { initial_amount_minor: 5000 });
  await seed.catalog.prices.set(seed.variant.id, { currency: "USD", amount_minor: 3500 });
  await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });
  var rv = await w.alerts.scanAndDispatch({});
  check("setup: one delivery",                    rv.sent === 1);

  // History returns the ledger row.
  var hist = await w.alerts.customerAlertHistory({ customer_id: customerId, limit: 10 });
  check("history returns 1 row",                  hist.rows.length === 1);
  check("history channel is email",               hist.rows[0].channel === "email");
  var alertId = hist.rows[0].id;

  // markAlertSent — operator records an off-table SMS resend.
  var marked = await w.alerts.markAlertSent({ alert_id: alertId, channel: "sms" });
  check("markAlertSent returns channel sms",      marked.channel === "sms");
  check("markAlertSent returns same id",          marked.id === alertId);

  // metricsForPolicy reflects the channel switch (no double count).
  var metrics = await w.alerts.metricsForPolicy({ slug: "drop", from: 0, to: Date.now() + 86400000 });
  check("metricsForPolicy total still 1",         metrics.total === 1);
  check("metricsForPolicy by_channel.sms = 1",    metrics.by_channel.sms === 1);
  check("metricsForPolicy by_channel.email = 0",  metrics.by_channel.email === 0);

  // markAlertSent refuses an unknown id.
  await assert.rejects(w.alerts.markAlertSent({ alert_id: "does-not-exist", channel: "sms" }), /not found/);
  // Refuse bad channel.
  await assert.rejects(w.alerts.markAlertSent({ alert_id: alertId, channel: "carrier-pigeon" }), /channel must be/);
}

async function _customerAlertHistoryPaginates() {
  // Wire a factory with no email delivery — we'll write ledger rows
  // directly through the dispatcher's normal happy path to populate
  // pagination input.
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "page@example.com"; return m; })() });

  // Three policies + three variants — three deliveries land on the
  // same customer, then we paginate with limit = 2.
  var slugs = ["p1", "p2", "p3"];
  for (var i = 0; i < slugs.length; i += 1) {
    await w.alerts.defineAlertPolicy({
      slug: slugs[i], trigger: "price_drop", threshold: { percent_off_bps_min: 1 },
    });
  }
  for (var j = 0; j < 3; j += 1) {
    var seed = await _seedCatalog(w.query, { slug: "p-" + j, title: "P" + j, sku: "SKU-P" + j, initial_amount_minor: 5000 });
    await seed.catalog.prices.set(seed.variant.id, { currency: "USD", amount_minor: 100 });
    await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });
  }
  var rv = await w.alerts.scanAndDispatch({});
  // 3 entries * 3 policies = 9 evaluations, all fire (no dedupe within
  // one scan because each (sku, policy) tuple is unique).
  check("scan dispatched 9 alerts",                rv.sent === 9);

  // Page through with limit = 4 — expect 4, 4, 1.
  var first = await w.alerts.customerAlertHistory({ customer_id: customerId, limit: 4 });
  check("first page returns 4 rows",               first.rows.length === 4);
  check("first page hands a nextCursor",           typeof first.nextCursor === "string" && first.nextCursor.length > 0);
  var second = await w.alerts.customerAlertHistory({ customer_id: customerId, limit: 4, cursor: first.nextCursor });
  check("second page returns 4 rows",              second.rows.length === 4);
  var third = await w.alerts.customerAlertHistory({ customer_id: customerId, limit: 4, cursor: second.nextCursor });
  check("third page returns 1 row",                third.rows.length === 1);
  check("third page has no nextCursor",            third.nextCursor === null);

  // Tampered cursor refused.
  await assert.rejects(
    w.alerts.customerAlertHistory({ customer_id: customerId, cursor: "not-a-real-cursor" }),
    /cursor/,
  );
}

async function _refusalsAndFactoryShape() {
  var w = _wire();

  // Bad slug / trigger / threshold shapes.
  await assert.rejects(
    w.alerts.defineAlertPolicy({ slug: "BAD SLUG", trigger: "price_drop", threshold: { percent_off_bps_min: 1 } }),
    /slug must match/,
  );
  await assert.rejects(
    w.alerts.defineAlertPolicy({ slug: "drop", trigger: "no-such-trigger", threshold: {} }),
    /trigger must be one of/,
  );
  await assert.rejects(
    w.alerts.defineAlertPolicy({ slug: "drop", trigger: "price_drop", threshold: { percent_off_bps_min: 0 } }),
    /percent_off_bps_min must be/,
  );
  await assert.rejects(
    w.alerts.defineAlertPolicy({ slug: "drop", trigger: "price_drop", threshold: { percent_off_bps_min: 99999 } }),
    /percent_off_bps_min must be/,
  );
  await assert.rejects(
    w.alerts.defineAlertPolicy({ slug: "drop", trigger: "back_in_stock", threshold: { percent_off_bps_min: 100 } }),
    /empty object/,
  );
  await assert.rejects(
    w.alerts.defineAlertPolicy({ slug: "drop", trigger: "price_drop", threshold: { percent_off_bps_min: 100, extra: 1 } }),
    /accepts only percent_off_bps_min/,
  );

  // Bad weekly cap.
  await assert.rejects(
    w.alerts.defineAlertPolicy({
      slug: "drop", trigger: "price_drop",
      threshold: { percent_off_bps_min: 100 },
      max_alerts_per_week_per_customer: 0,
    }),
    /max_alerts_per_week_per_customer/,
  );

  // unsubscribeFromAlertKind refuses bad customer_id / trigger.
  await assert.rejects(
    w.alerts.unsubscribeFromAlertKind({ customer_id: "not-a-uuid", trigger: "price_drop" }),
    /customer_id/,
  );
  await assert.rejects(
    w.alerts.unsubscribeFromAlertKind({ customer_id: _uuid(), trigger: "bogus" }),
    /trigger must be/,
  );

  // metricsForPolicy bounds.
  await assert.rejects(
    w.alerts.metricsForPolicy({ slug: "drop", from: -1, to: 1 }),
    /from must be/,
  );
  await assert.rejects(
    w.alerts.metricsForPolicy({ slug: "drop", from: 100, to: 50 }),
    /to must be/,
  );

  // markAlertSent bad input.
  await assert.rejects(w.alerts.markAlertSent({ alert_id: "", channel: "email" }), /alert_id/);
  await assert.rejects(w.alerts.markAlertSent({ alert_id: "x" }), /channel must be/);

  // Factory rejects missing wishlist / catalog / email handles.
  assert.throws(
    function () { wishlistAlerts.create({ query: w.query }); },
    /wishlist must expose/,
  );
  assert.throws(
    function () { wishlistAlerts.create({ query: w.query, wishlist: w.wishlist }); },
    /catalog must expose/,
  );
  assert.throws(
    function () { wishlistAlerts.create({ query: w.query, wishlist: w.wishlist, catalog: w.catalog }); },
    /email must expose/,
  );
  assert.throws(
    function () {
      wishlistAlerts.create({
        query:       w.query,
        wishlist:    w.wishlist,
        catalog:     w.catalog,
        email:       { sendWishlistDiscount: function () { return null; } },
        stockAlerts: { not: "shaped" },
      });
    },
    /stockAlerts must expose/,
  );

  // customerAlertHistory shape refusals.
  await assert.rejects(w.alerts.customerAlertHistory({ customer_id: "not-a-uuid" }), /customer_id/);
}

async function _scanAndDispatchSkipsWithoutEmailResolver() {
  // No emailForCustomer wired — every otherwise-firing candidate gets
  // accounted as `no_email` and the ledger stays empty.
  var customerId = _uuid();
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var wishlist = bShop.wishlist.create({ query: query });
  var emailStub = _stubEmail();
  var alerts = wishlistAlerts.create({
    query:    query,
    wishlist: wishlist,
    catalog:  catalog,
    email:    emailStub.handle,
    // emailForCustomer intentionally omitted
  });
  await alerts.defineAlertPolicy({
    slug: "drop", trigger: "price_drop", threshold: { percent_off_bps_min: 1 },
  });
  var seed = await _seedCatalog(query, { initial_amount_minor: 5000 });
  await seed.catalog.prices.set(seed.variant.id, { currency: "USD", amount_minor: 100 });
  await wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });

  var rv = await alerts.scanAndDispatch({});
  check("no_email candidate is accounted, not sent",  rv.sent === 0);
  check("candidates = 1",                              rv.candidates === 1);
  check("skipped_by.no_email = 1",                     rv.skipped_by.no_email === 1);
  check("email handle never called",                   emailStub.calls.length === 0);
}

// Money-precision: the dispatched email price strings come from
// pricing.format (locale + zero-decimal aware), NOT a hand-rolled
// /100 + concat. A JPY price drop must render "¥3,000" (no minor
// unit) — the float-money path would have produced the wrong
// "30 JPY". Seeds a JPY-priced variant via a per-customer currency
// resolver so prices.current(variant, "JPY") is what the scanner reads.
async function _dispatchedEmailUsesPricingFormat() {
  var customerId = _uuid();
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var wishlist = bShop.wishlist.create({ query: query });
  var emailStub = _stubEmail();
  var alerts = wishlistAlerts.create({
    query:    query,
    wishlist: wishlist,
    catalog:  catalog,
    email:    emailStub.handle,
    emailForCustomer: async function () { return "yen@example.com"; },
    currencyForCustomer: function () { return "JPY"; },
  });
  await alerts.defineAlertPolicy({
    slug: "drop-jpy", trigger: "price_drop", threshold: { percent_off_bps_min: 1000 },
  });
  // Seed a JPY-priced variant: baseline 5000 JPY → 3000 JPY (40% off).
  var prod = await catalog.products.create({ slug: "yen-widget", title: "Yen Widget", status: "active" });
  var variant = await catalog.variants.create(prod.id, { sku: "SKU-JPY" });
  await catalog.prices.set(variant.id, { currency: "JPY", amount_minor: 5000 });
  await catalog.prices.set(variant.id, { currency: "JPY", amount_minor: 3000 });
  await catalog.inventory.create(variant.sku, { stock_on_hand: 10 });
  await wishlist.add({ customer_id: customerId, product_id: prod.id, variant_id: variant.id });

  var rv = await alerts.scanAndDispatch({});
  check("JPY price drop fires",                  rv.sent === 1);
  check("JPY new_price is yen-formatted",        emailStub.calls[0].new_price === "¥3,000");
  check("JPY old_price is yen-formatted",        emailStub.calls[0].old_price === "¥5,000");
  check("JPY new_price has NO float fraction",   emailStub.calls[0].new_price.indexOf(".") === -1);
}

// isUnsubscribedFromTrigger (now exported) reads the opt-out state; the
// new resubscribeToAlertKind verb inverts unsubscribeFromAlertKind.
async function _optOutReadAndResubscribe() {
  var customerId = _uuid();
  var w = _wire();
  check("starts subscribed (no opt-out row)",
    (await w.alerts.isUnsubscribedFromTrigger(customerId, "price_drop")) === false);

  await w.alerts.unsubscribeFromAlertKind({ customer_id: customerId, trigger: "price_drop" });
  check("isUnsubscribedFromTrigger true after opt-out",
    (await w.alerts.isUnsubscribedFromTrigger(customerId, "price_drop")) === true);
  // Per-trigger: a different trigger is unaffected.
  check("other trigger still subscribed",
    (await w.alerts.isUnsubscribedFromTrigger(customerId, "back_in_stock")) === false);

  var re = await w.alerts.resubscribeToAlertKind({ customer_id: customerId, trigger: "price_drop" });
  check("resubscribe returns resubscribed",      re.status === "resubscribed");
  check("isUnsubscribedFromTrigger false after resubscribe",
    (await w.alerts.isUnsubscribedFromTrigger(customerId, "price_drop")) === false);

  // Idempotent — re-subscribing when already subscribed is a no-op.
  var re2 = await w.alerts.resubscribeToAlertKind({ customer_id: customerId, trigger: "price_drop" });
  check("re-resubscribe returns already-subscribed", re2.status === "already-subscribed");

  // Bad input refused (same validation as unsubscribe).
  await assert.rejects(
    w.alerts.resubscribeToAlertKind({ customer_id: "not-a-uuid", trigger: "price_drop" }),
    /customer_id/,
  );
  await assert.rejects(
    w.alerts.resubscribeToAlertKind({ customer_id: _uuid(), trigger: "bogus" }),
    /trigger must be/,
  );
}

// P2-A regression: a steady state must NEVER re-fire across an unbounded
// number of sweeps spanning many dedupe windows — the transition gate,
// not the 24h dedupe window, is what suppresses the flood. Walks a steady
// in-stock item AND a steady-depth price drop across 30 daily sweeps and
// asserts exactly one fire each (on the genuine transition only).
async function _steadyStateNeverRefiresAcrossManyWindows() {
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "steady@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({ slug: "bis", trigger: "back_in_stock", threshold: {} });
  await w.alerts.defineAlertPolicy({
    slug: "pd", trigger: "price_drop", threshold: { percent_off_bps_min: 1000 },
  });
  // Item starts OUT of stock at its baseline price.
  var seed = await _seedCatalog(w.query, { initial_amount_minor: 5000, initial_stock: 0 });
  await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });

  var DAY = 86400000;
  var t0  = Date.now();
  // Sweep 0: observe out-of-stock, baseline price → nothing fires.
  await w.alerts.scanAndDispatch({ now: t0 });
  // Now restock AND drop the price 30% — both are genuine transitions.
  await w.query("UPDATE inventory SET stock_on_hand = 9 WHERE sku = ?1", [seed.variant.sku]);
  await seed.catalog.prices.set(seed.variant.id, { currency: "USD", amount_minor: 3500 });

  var totalSent = 0;
  for (var d = 1; d <= 30; d += 1) {
    var rv = await w.alerts.scanAndDispatch({ now: t0 + d * DAY });
    totalSent += rv.sent;
  }
  // The transition happened ONCE per policy (the day-1 sweep); the other
  // 29 sweeps see steady state and fire nothing. Two policies → 2 total.
  check("steady state across 30 windows fires exactly twice (one per policy)", totalSent === 2);
  var ledger = await w.query("SELECT COUNT(*) AS n FROM wishlist_alerts_sent WHERE customer_id = ?1", [customerId]);
  check("ledger holds exactly the two transition fires", Number(ledger.rows[0].n) === 2);
}

// P3-C regression: two concurrent sweeps racing the SAME (customer, sku,
// policy) transition must result in exactly ONE delivery — the dedupe +
// weekly-cap guard is an atomic conditional INSERT (the claim), not a
// read-then-write. The query wrapper yields the event loop before every
// statement so the two sweeps genuinely interleave their reads + writes.
async function _concurrentSweepsClaimAtomically() {
  var customerId = _uuid();
  var query    = _makeQuery();
  // Latency-injecting wrapper: yield a macrotask before each statement so
  // two in-flight sweeps interleave (models the D1 network round-trip).
  var slowQuery = async function (sql, params) {
    await new Promise(function (r) { setTimeout(r, 0); });   // allow:test-promise-settimeout-sleep — models per-statement network latency to force interleaving, not a wait-for-event sleep
    return query(sql, params);
  };
  var catalog  = bShop.catalog.create({ query: query });
  var wishlist = bShop.wishlist.create({ query: query });
  var mk = function () {
    var emailStub = _stubEmail();
    return {
      email: emailStub,
      alerts: wishlistAlerts.create({
        query:    slowQuery,
        wishlist: wishlist,
        catalog:  catalog,
        email:    emailStub.handle,
        emailForCustomer: async function () { return "race@example.com"; },
      }),
    };
  };
  var setup = mk();
  // weekly cap = 1: at most one alert this week for this customer.
  await setup.alerts.defineAlertPolicy({
    slug: "race", trigger: "back_in_stock", threshold: {}, max_alerts_per_week_per_customer: 1,
  });
  var seed = await _seedCatalog(query, { initial_stock: 0 });
  await wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });
  // Observe the out state, then restock so the next sweep has a real
  // out -> in transition to race on.
  await setup.alerts.scanAndDispatch({ now: Date.now() });
  await query("UPDATE inventory SET stock_on_hand = 6 WHERE sku = ?1", [seed.variant.sku]);

  var a = mk(), c = mk();
  var now = Date.now() + 1000;
  var results = await Promise.all([
    a.alerts.scanAndDispatch({ now: now }),
    c.alerts.scanAndDispatch({ now: now }),
  ]);
  var totalSent = results[0].sent + results[1].sent;
  check("concurrent sweeps: exactly one wins the claim", totalSent === 1);
  var ledger = await query("SELECT COUNT(*) AS n FROM wishlist_alerts_sent WHERE customer_id = ?1", [customerId]);
  check("concurrent sweeps: exactly one ledger row (no double-send past cap)",
    Number(ledger.rows[0].n) === 1);
  var emailCount = a.email.calls.length + c.email.calls.length;
  check("concurrent sweeps: exactly one email sent", emailCount === 1);
}

async function run() {
  await _defineAlertPolicyPersistsAndRefusesRedefine();
  await _scanAndDispatchFiresOnPriceDrop();
  await _scanAndDispatchFiresOnBackInStock();
  await _steadyStateNeverRefiresAcrossManyWindows();
  await _concurrentSweepsClaimAtomically();
  await _scanAndDispatchBelowThresholdDoesNotFire();
  await _weeklyCapBlocksDelivery();
  await _unsubscribeFromAlertKindBlocks();
  await _markAlertSentUpdatesChannel();
  await _customerAlertHistoryPaginates();
  await _scanAndDispatchSkipsWithoutEmailResolver();
  await _dispatchedEmailUsesPricingFormat();
  await _optOutReadAndResubscribe();
  await _refusalsAndFactoryShape();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("wishlist-alerts.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("wishlist-alerts.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
