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

  // Re-scan within dedupe window — no fresh fire.
  var rv2 = await w.alerts.scanAndDispatch({});
  check("re-scan dedupes — sent = 0",              rv2.sent === 0);
  check("re-scan accounted in skipped",            rv2.skipped >= 1);
  check("re-scan skipped_by.recent_dedupe = 1",    rv2.skipped_by.recent_dedupe === 1);

  // metricsForPolicy reflects the one delivery.
  var metrics = await w.alerts.metricsForPolicy({
    slug: "drop-20",
    from: 0,
    to:   Date.now() + 86400000,
  });
  check("metricsForPolicy total = 1",              metrics.total === 1);
  check("metricsForPolicy by_channel.email = 1",   metrics.by_channel.email === 1);
}

async function _scanAndDispatchFiresOnBackInStock() {
  var customerId = _uuid();
  var w = _wire({ emails: (function () { var m = {}; m[customerId] = "bob@example.com"; return m; })() });
  await w.alerts.defineAlertPolicy({
    slug: "restock-any", trigger: "back_in_stock", threshold: {},
  });
  var seed = await _seedCatalog(w.query, { initial_stock: 5 });
  await w.wishlist.add({ customer_id: customerId, product_id: seed.product.id, variant_id: seed.variant.id });

  var rv = await w.alerts.scanAndDispatch({});
  check("back_in_stock fires when in-stock",       rv.sent === 1);
  check("email handle called once",                w.email.calls.length === 1);
  check("email handle product title rendered",     w.email.calls[0].product_title === "Widget");
  check("email handle price slot is dash",         w.email.calls[0].old_price === "—" && w.email.calls[0].new_price === "—");

  // Drain stock to zero — next scan does not fire (still dedupe + zero).
  await w.query("UPDATE inventory SET stock_on_hand = 0 WHERE sku = ?1", [seed.variant.sku]);
  var rv2 = await w.alerts.scanAndDispatch({});
  check("post-drain scan does not re-fire",        rv2.sent === 0);
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
  var seed = await _seedCatalog(w.query, { initial_amount_minor: 5000 });
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

  // Different trigger still fires (opt-out is per-trigger).
  await w.alerts.defineAlertPolicy({ slug: "back", trigger: "back_in_stock", threshold: {} });
  // back_in_stock evaluator finds inventory > 0 — should fire.
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

async function run() {
  await _defineAlertPolicyPersistsAndRefusesRedefine();
  await _scanAndDispatchFiresOnPriceDrop();
  await _scanAndDispatchFiresOnBackInStock();
  await _scanAndDispatchBelowThresholdDoesNotFire();
  await _weeklyCapBlocksDelivery();
  await _unsubscribeFromAlertKindBlocks();
  await _markAlertSentUpdatesChannel();
  await _customerAlertHistoryPaginates();
  await _scanAndDispatchSkipsWithoutEmailResolver();
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
