"use strict";
/**
 * customerActivity — chronological per-customer event timeline.
 *
 * Layer 1 against in-memory node:sqlite loaded from the migrations
 * each source primitive owns + the 0153 cache migration.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/customer-activity.js` directly so the gate exists ahead of
 * the entry-point edit.
 *
 * Coverage:
 *   - forCustomer mixes events from order / wishlist / loyalty /
 *     support / reviews sources, newest-first
 *   - forCustomer kinds filter restricts the feed
 *   - forCustomer cursor paginates deterministically
 *   - summarize() aggregates 30/90/365-day kind counts
 *   - summarize() second call hits the cache
 *   - lastActivityAt returns the newest source timestamp
 *   - inactiveCustomers respects the days threshold
 *   - skip-injected-peers — factory tolerates missing peers cleanly
 *   - validation refusals on bad inputs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var customerActivity = require("../../lib/customer-activity");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql",
  "0011_reviews.sql",
  "0012_wishlist.sql",
  "0022_loyalty.sql",
  "0047_support_tickets.sql",
  "0153_customer_activity_cache.sql",
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

function _validUUID() { return bShop.framework.uuid.v7(); }

// Monotonic counter so per-seed catalog identifiers (slug / sku) never
// collide on the catalog UNIQUE indexes even when two seed calls land
// in the same UUIDv7 millisecond bucket.
var _seedCounter = 0;
function _seedSuffix() { _seedCounter += 1; return String(_seedCounter); }

// Seed a paid order for a given customer so the order_transitions
// path has events to surface. Returns the primitives wired against
// the shared `query` so downstream seed steps (wishlist / loyalty /
// support / reviews) can compose against the same DB.
async function _seedCustomerWithOrder(query, opts) {
  opts = opts || {};
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });

  var suffix = _seedSuffix();
  var slug = opts.slug || ("ca-test-" + suffix);
  var sku  = opts.sku  || ("CA-" + suffix);
  var p = await catalog.products.create({ slug: slug, title: "Activity Test", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2500 });

  var sessionId = _validUUID();
  var c = await cart.create(sessionId, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1 });

  var customerId = opts.customer_id || _validUUID();
  // Insert the customers row so wishlist / reviews FKs (where present)
  // resolve. The customers row is keyed by id PK; an email_hash is
  // required by the migration so feed a deterministic placeholder.
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?4)",
    [customerId, "hash-" + customerId, "Activity Test", Date.now()],
  );

  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sessionId,
    customer_id:       customerId,
    currency:          "USD",
    subtotal_minor:    2500,
    discount_minor:    0,
    tax_minor:         200,
    shipping_minor:    500,
    grand_total_minor: 3200,
    ship_to:           { country: "US" },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               1,
      unit_amount_minor: 2500,
      unit_currency:     "USD",
    }],
  });
  o = await order.transition(o.id, "mark_paid");
  o = await order.transition(o.id, "start_fulfillment");
  o = await order.transition(o.id, "mark_shipped");

  return {
    query:      query,
    order:      order,
    productId:  p.id,
    variantId:  v.id,
    orderRow:   o,
    customerId: customerId,
    sku:        sku,
  };
}

async function _seedWishlistEntry(query, customerId, productId) {
  await query(
    "INSERT INTO wishlist_entries (id, customer_id, product_id, variant_id, notes, created_at) " +
    "VALUES (?1, ?2, ?3, NULL, '', ?4)",
    [_validUUID(), customerId, productId, Date.now() + 1],
  );
}

async function _seedLoyalty(query, customerId) {
  var loyalty = bShop.loyalty.create({ query: query });
  await loyalty.ensureAccount(customerId);
  await loyalty.earn({
    customer_id: customerId,
    points:      120,
    source:      "order-test",
  });
  return loyalty;
}

async function _seedSupportTicket(query, customerId) {
  var support = bShop.supportTickets.create({
    query:        query,
    cursorSecret: "ca-test-support",
  });
  var t = await support.open({
    customer_id:    customerId,
    customer_email: "shopper" + _seedSuffix() + "@example.com",
    subject:        "Where is my order?",
    body:           "I haven't received tracking yet.",
    category:       "order_issue",
    priority:       "high",
  });
  // Direct UPDATE to stamp resolved_at — a quick way to exercise the
  // "support.resolved" event without walking the full FSM.
  await query(
    "UPDATE support_tickets SET resolved_at = ?1 WHERE id = ?2",
    [Date.now() + 50, t.id],
  );
  return { support: support, ticketId: t.id };
}

async function _seedReview(query, customerId, productId) {
  var reviews = bShop.reviews.create({
    query:        query,
    cursorSecret: "ca-test-reviews",
  });
  await reviews.submit({
    product_id:  productId,
    customer_id: customerId,
    rating:      5,
    title:       "Loved it",
    body:        "Solid product, would buy again.",
  });
  return reviews;
}

// ---- forCustomer mixes sources -----------------------------------------

async function _forCustomerMixesSources() {
  var q = _makeQuery();
  var seed = await _seedCustomerWithOrder(q);
  await _seedWishlistEntry(q, seed.customerId, seed.productId);
  var loyalty = await _seedLoyalty(q, seed.customerId);
  var support = await _seedSupportTicket(q, seed.customerId);
  var reviews = await _seedReview(q, seed.customerId, seed.productId);

  var ca = customerActivity.create({
    query:          q,
    cursorSecret:   "ca-test-cursor",
    order:          seed.order,
    wishlist:       { __injected: true },
    loyalty:        loyalty,
    supportTickets: support.support,
    reviews:        reviews,
  });

  var page = await ca.forCustomer({ customer_id: seed.customerId });
  check("forCustomer returns object with events", Array.isArray(page.events));
  check("forCustomer surfaces order.mark_paid",   page.events.some(function (e) { return e.kind === "order.mark_paid"; }));
  check("forCustomer surfaces order.mark_shipped",page.events.some(function (e) { return e.kind === "order.mark_shipped"; }));
  check("forCustomer surfaces wishlist.added",    page.events.some(function (e) { return e.kind === "wishlist.added"; }));
  check("forCustomer surfaces loyalty.earn",      page.events.some(function (e) { return e.kind === "loyalty.earn"; }));
  check("forCustomer surfaces support.opened",    page.events.some(function (e) { return e.kind === "support.opened"; }));
  check("forCustomer surfaces support.resolved",  page.events.some(function (e) { return e.kind === "support.resolved"; }));
  check("forCustomer surfaces review.pending",    page.events.some(function (e) { return e.kind === "review.pending"; }));

  // Newest-first ordering.
  var monotonic = true;
  for (var i = 1; i < page.events.length; i += 1) {
    if (page.events[i].occurred_at > page.events[i - 1].occurred_at) { monotonic = false; break; }
  }
  check("forCustomer newest-first ordering", monotonic);

  // Every event has the documented shape fields.
  var shapeOk = page.events.every(function (e) {
    return typeof e.kind === "string"
        && typeof e.occurred_at === "number"
        && typeof e.title === "string"
        && (e.body === null || typeof e.body === "string")
        && (e.actor === null || typeof e.actor === "string")
        && (e.link === null  || typeof e.link === "string");
  });
  check("forCustomer events have documented shape", shapeOk);
}

// ---- kinds filter ------------------------------------------------------

async function _kindsFilter() {
  var q = _makeQuery();
  var seed = await _seedCustomerWithOrder(q);
  await _seedWishlistEntry(q, seed.customerId, seed.productId);
  var loyalty = await _seedLoyalty(q, seed.customerId);

  var ca = customerActivity.create({
    query:        q,
    cursorSecret: "ca-test-kinds",
    order:        seed.order,
    wishlist:     { __injected: true },
    loyalty:      loyalty,
  });

  var filtered = await ca.forCustomer({
    customer_id: seed.customerId,
    kinds:       ["wishlist.added", "loyalty.earn"],
  });

  check("kinds filter returns only allowed kinds", filtered.events.every(function (e) {
    return e.kind === "wishlist.added" || e.kind === "loyalty.earn";
  }));
  check("kinds filter still surfaces wishlist.added", filtered.events.some(function (e) {
    return e.kind === "wishlist.added";
  }));
  check("kinds filter still surfaces loyalty.earn", filtered.events.some(function (e) {
    return e.kind === "loyalty.earn";
  }));
  check("kinds filter hides order.* events", !filtered.events.some(function (e) {
    return e.kind.indexOf("order.") === 0;
  }));
}

// ---- cursor pagination -------------------------------------------------

async function _cursorPagination() {
  var q = _makeQuery();
  var seed = await _seedCustomerWithOrder(q);

  // Seed a handful of wishlist entries so the page-1 + page-2 split
  // has enough events to be meaningful. The wishlist UNIQUE is on
  // `(customer_id, product_id, COALESCE(variant_id, ''))`, so each
  // entry uses a fresh product_id placeholder.
  for (var i = 0; i < 6; i += 1) {
    await q(
      "INSERT INTO wishlist_entries (id, customer_id, product_id, variant_id, notes, created_at) " +
      "VALUES (?1, ?2, ?3, NULL, '', ?4)",
      [_validUUID(), seed.customerId, _validUUID(), Date.now() + 10 + i],
    );
  }

  var ca = customerActivity.create({
    query:        q,
    cursorSecret: "ca-test-cursor-pag",
    order:        seed.order,
    wishlist:     { __injected: true },
  });

  var firstPage = await ca.forCustomer({
    customer_id: seed.customerId,
    limit:       3,
  });
  check("cursor page-1 returns at most limit",  firstPage.events.length <= 3);
  check("cursor page-1 has next_cursor",        typeof firstPage.next_cursor === "string" && firstPage.next_cursor.length > 0);

  var secondPage = await ca.forCustomer({
    customer_id: seed.customerId,
    limit:       3,
    cursor:      firstPage.next_cursor,
  });
  check("cursor page-2 returns events",         secondPage.events.length > 0);

  // No overlap between the two pages.
  var firstKeys = {};
  for (var f = 0; f < firstPage.events.length; f += 1) {
    firstKeys[firstPage.events[f].occurred_at + "|" + firstPage.events[f].kind] = true;
  }
  var overlap = false;
  for (var s = 0; s < secondPage.events.length; s += 1) {
    if (firstKeys[secondPage.events[s].occurred_at + "|" + secondPage.events[s].kind]) {
      overlap = true; break;
    }
  }
  check("cursor pages do not overlap", !overlap);

  // Cursor with the wrong orderKey is rejected.
  var badCursor = bShop.framework.pagination.encodeCursor({
    orderKey: ["wrong"],
    vals:     [0],
    forward:  true,
  }, "ca-test-cursor-pag");
  await assert.rejects(
    ca.forCustomer({ customer_id: seed.customerId, cursor: badCursor }),
    /cursor orderKey mismatch/,
  );
}

// ---- summarize aggregates ----------------------------------------------

async function _summarizeAggregates() {
  var q = _makeQuery();
  var seed = await _seedCustomerWithOrder(q);
  await _seedWishlistEntry(q, seed.customerId, seed.productId);
  var loyalty = await _seedLoyalty(q, seed.customerId);

  var ca = customerActivity.create({
    query:        q,
    cursorSecret: "ca-test-summarize",
    order:        seed.order,
    wishlist:     { __injected: true },
    loyalty:      loyalty,
  });

  var sum = await ca.summarize({ customer_id: seed.customerId });
  check("summarize returns last_activity_at number",         typeof sum.last_activity_at === "number");
  check("summarize returns kind_counts_30d object",          sum.kind_counts_30d && typeof sum.kind_counts_30d === "object");
  check("summarize returns kind_counts_90d object",          sum.kind_counts_90d && typeof sum.kind_counts_90d === "object");
  check("summarize returns kind_counts_365d object",         sum.kind_counts_365d && typeof sum.kind_counts_365d === "object");
  check("summarize 30d window counts mark_paid",             Number(sum.kind_counts_30d["order.mark_paid"]) === 1);
  check("summarize 30d window counts wishlist.added",        Number(sum.kind_counts_30d["wishlist.added"]) === 1);
  check("summarize 30d window counts loyalty.earn",          Number(sum.kind_counts_30d["loyalty.earn"]) === 1);
  check("summarize 365d window mirrors 30d for fresh seeds", Number(sum.kind_counts_365d["order.mark_paid"]) === 1);
  check("summarize first call is cache miss",                sum.cache_hit === false);

  // Cache now populated; second call hits cache.
  var sum2 = await ca.summarize({ customer_id: seed.customerId });
  check("summarize second call hits cache",                  sum2.cache_hit === true);
  check("summarize cached counts match",                     Number(sum2.kind_counts_30d["order.mark_paid"]) === 1);

  // Cache row landed.
  var cacheRow = (await q(
    "SELECT * FROM customer_activity_cache WHERE customer_id = ?1",
    [seed.customerId],
  )).rows[0];
  check("cache row written by summarize",                    cacheRow != null);
  check("cache row carries last_activity_at",                Number(cacheRow.last_activity_at) > 0);
}

// ---- lastActivityAt convenience ----------------------------------------

async function _lastActivityAtRead() {
  var q = _makeQuery();
  var seed = await _seedCustomerWithOrder(q);

  var ca = customerActivity.create({
    query:        q,
    cursorSecret: "ca-test-last",
    order:        seed.order,
  });

  var last = await ca.lastActivityAt(seed.customerId);
  check("lastActivityAt returns number for active customer", typeof last === "number" && last > 0);

  // Customer that has no events anywhere returns null.
  var bare = _validUUID();
  var empty = await ca.lastActivityAt(bare);
  check("lastActivityAt returns null when no source events", empty === null);
}

// ---- inactiveCustomers respects days threshold -------------------------

async function _inactiveCustomersDaysThreshold() {
  var q = _makeQuery();
  var nowMs = Date.now();

  // Three cache rows: two stale (well past the day-7 cutoff) and one
  // fresh (within the last 24h).
  var freshCustomer  = _validUUID();
  var stale1         = _validUUID();
  var stale2         = _validUUID();
  await q(
    "INSERT INTO customer_activity_cache " +
    "(customer_id, last_activity_at, kind_counts_30d_json, kind_counts_90d_json, kind_counts_365d_json, computed_at) " +
    "VALUES (?1, ?2, '{}', '{}', '{}', ?3)",
    [freshCustomer, nowMs - (1 * 86400000), nowMs],
  );
  await q(
    "INSERT INTO customer_activity_cache " +
    "(customer_id, last_activity_at, kind_counts_30d_json, kind_counts_90d_json, kind_counts_365d_json, computed_at) " +
    "VALUES (?1, ?2, '{}', '{}', '{}', ?3)",
    [stale1, nowMs - (30 * 86400000), nowMs],
  );
  await q(
    "INSERT INTO customer_activity_cache " +
    "(customer_id, last_activity_at, kind_counts_30d_json, kind_counts_90d_json, kind_counts_365d_json, computed_at) " +
    "VALUES (?1, ?2, '{}', '{}', '{}', ?3)",
    [stale2, nowMs - (60 * 86400000), nowMs],
  );

  var ca = customerActivity.create({
    query:        q,
    cursorSecret: "ca-test-inactive",
  });

  var inactive7 = await ca.inactiveCustomers({ days: 7, limit: 50 });
  check("inactiveCustomers(7) returns array",          Array.isArray(inactive7));
  check("inactiveCustomers(7) excludes fresh customer", !inactive7.some(function (r) { return r.customer_id === freshCustomer; }));
  check("inactiveCustomers(7) includes 30-day stale",   inactive7.some(function (r) { return r.customer_id === stale1; }));
  check("inactiveCustomers(7) includes 60-day stale",   inactive7.some(function (r) { return r.customer_id === stale2; }));

  // Tighter window — 45 days — only the 60-day customer is stale.
  var inactive45 = await ca.inactiveCustomers({ days: 45, limit: 50 });
  check("inactiveCustomers(45) excludes 30-day stale",  !inactive45.some(function (r) { return r.customer_id === stale1; }));
  check("inactiveCustomers(45) includes 60-day stale",  inactive45.some(function (r) { return r.customer_id === stale2; }));

  // Ordering: newest-stale first. The 30-day row's last_activity_at
  // is greater than the 60-day row's, so it sorts first in the 7-day
  // sweep.
  var idx30 = -1, idx60 = -1;
  for (var i = 0; i < inactive7.length; i += 1) {
    if (inactive7[i].customer_id === stale1) idx30 = i;
    if (inactive7[i].customer_id === stale2) idx60 = i;
  }
  check("inactiveCustomers newest-stale-first ordering", idx30 >= 0 && idx60 > idx30);

  // Limit clamps the result count.
  var limited = await ca.inactiveCustomers({ days: 7, limit: 1 });
  check("inactiveCustomers respects limit", limited.length <= 1);
}

// ---- skip-injected-peers ----------------------------------------------

async function _skipInjectedPeers() {
  var q = _makeQuery();
  var seed = await _seedCustomerWithOrder(q);
  await _seedWishlistEntry(q, seed.customerId, seed.productId);

  // Wire only `order` — every other source omitted. The factory must
  // still build, and forCustomer must still return order transitions
  // without crashing on the missing peers.
  var ca = customerActivity.create({
    query:        q,
    cursorSecret: "ca-test-skip",
    order:        seed.order,
  });

  var page = await ca.forCustomer({ customer_id: seed.customerId });
  check("skip-peers feed surfaces order events",   page.events.some(function (e) { return e.kind === "order.mark_paid"; }));
  check("skip-peers feed has no wishlist events",  !page.events.some(function (e) { return e.kind.indexOf("wishlist.") === 0; }));
  check("skip-peers feed has no loyalty events",   !page.events.some(function (e) { return e.kind.indexOf("loyalty.") === 0; }));
  check("skip-peers feed has no support events",   !page.events.some(function (e) { return e.kind.indexOf("support.") === 0; }));
  check("skip-peers feed has no review events",    !page.events.some(function (e) { return e.kind.indexOf("review.") === 0; }));

  // summarize still works with only `order` wired.
  var sum = await ca.summarize({ customer_id: seed.customerId });
  check("skip-peers summarize last_activity_at",   typeof sum.last_activity_at === "number" && sum.last_activity_at > 0);
}

// ---- validation refusals ----------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var ca = customerActivity.create({ query: q, cursorSecret: "ca-test-validation" });

  await assert.rejects(ca.forCustomer(),                                 /input object required/);
  await assert.rejects(ca.forCustomer({}),                               /customer_id/);
  await assert.rejects(ca.forCustomer({ customer_id: "not-a-uuid" }),    /customer_id/);
  await assert.rejects(ca.forCustomer({ customer_id: _validUUID(), limit: 0 }),     /limit/);
  await assert.rejects(ca.forCustomer({ customer_id: _validUUID(), limit: 99999 }), /limit/);
  await assert.rejects(ca.forCustomer({ customer_id: _validUUID(), from: -1 }),     /from/);
  await assert.rejects(ca.forCustomer({ customer_id: _validUUID(), from: 200, to: 100 }), /from must be/);
  await assert.rejects(ca.forCustomer({ customer_id: _validUUID(), kinds: "not-an-array" }), /kinds/);
  await assert.rejects(ca.forCustomer({ customer_id: _validUUID(), kinds: ["bad kind"] }),   /kinds/);
  await assert.rejects(ca.forCustomer({ customer_id: _validUUID(), cursor: 12345 }),         /cursor/);

  await assert.rejects(ca.summarize(),                                   /input object required/);
  await assert.rejects(ca.summarize({}),                                 /customer_id/);
  await assert.rejects(ca.summarize({ customer_id: "bad" }),             /customer_id/);

  await assert.rejects(ca.lastActivityAt("bad"),                         /customer_id/);

  await assert.rejects(ca.inactiveCustomers(),                           /options object required/);
  await assert.rejects(ca.inactiveCustomers({ days: 0 }),                /days/);
  await assert.rejects(ca.inactiveCustomers({ days: 999999 }),           /days/);
  await assert.rejects(ca.inactiveCustomers({ days: 30, limit: 0 }),     /limit/);

  await assert.rejects(ca.recentActivity(),                              /options object required/);
  await assert.rejects(ca.recentActivity({ limit: 0 }),                  /limit/);
}

// ---- collectors read a bounded slice, not the whole history -----------
//
// A customer with far more events than a page bound must not read them all
// per panel render. The paginated `forCustomer` read bounds each collector
// to the page size (newest-N at-or-before the cursor); the merge / sort /
// cursor / slice still yields the exact same page the unbounded read would.
// The SUMMARY path stays unbounded so windowed kind-counts remain exact.
async function _collectorReadIsBounded() {
  var rawQuery = _makeQuery();
  // Count how many wishlist rows each collector read pulls, so we can prove
  // the bound actually limited the scan (not just trimmed the output).
  var wishlistRowsRead = 0;
  var query = async function (sql, params) {
    var r = await rawQuery(sql, params);
    if (/FROM wishlist_entries/.test(sql)) wishlistRowsRead += r.rows.length;
    return r;
  };

  var seed = await _seedCustomerWithOrder(query);

  // Seed 220 wishlist entries (> MAX_LIMIT 200) at strictly increasing
  // timestamps so newest-first ordering is unambiguous.
  var TOTAL = 220;
  var base = Date.now();
  for (var i = 0; i < TOTAL; i += 1) {
    await query(
      "INSERT INTO wishlist_entries (id, customer_id, product_id, variant_id, notes, created_at) " +
      "VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
      [_validUUID(), seed.customerId, _validUUID(), "w" + i, base + i],
    );
  }

  var ca = customerActivity.create({
    query:        query,
    cursorSecret: "ca-test-bound",
    order:        seed.order,
    wishlist:     { __injected: true },
  });

  // ---- a single small page reads a BOUNDED slice, not all 220 ----------
  wishlistRowsRead = 0;
  var page1 = await ca.forCustomer({ customer_id: seed.customerId, limit: 10 });
  check("bound: page returns exactly the limit",   page1.events.length === 10);
  // The wishlist collector read at most `limit + 1` rows (the boundary-drop
  // margin), not all 220 — proving the scan is bounded, not just trimmed.
  check("bound: wishlist read is bounded to ~limit", wishlistRowsRead <= 11);
  // The page is the NEWEST events, descending. Newest wishlist note is "w219".
  var newestBody = page1.events[0].body;
  check("bound: page-1 leads with the newest wishlist note", newestBody === "w" + (TOTAL - 1));
  var monotonic = true;
  for (var m = 1; m < page1.events.length; m += 1) {
    if (page1.events[m].occurred_at > page1.events[m - 1].occurred_at) { monotonic = false; break; }
  }
  check("bound: page is newest-first",             monotonic);

  // ---- a cursor walk recovers EVERY event, in order, no gaps/overlaps --
  var seen = {};
  var walkMonotonic = true;
  var prevTs = Infinity;
  var cursor = null;
  var pages = 0;
  do {
    var pg = await ca.forCustomer({ customer_id: seed.customerId, limit: 25, cursor: cursor || undefined });
    for (var k = 0; k < pg.events.length; k += 1) {
      var ev = pg.events[k];
      var key = ev.occurred_at + "|" + ev.kind + "|" + (ev.body || "");
      if (seen[key]) walkMonotonic = false;   // overlap → ordering broke
      seen[key] = true;
      if (ev.occurred_at > prevTs) walkMonotonic = false;  // out of order
      prevTs = ev.occurred_at;
    }
    cursor = pg.next_cursor;
    pages += 1;
  } while (cursor && pages < 50);
  // 220 wishlist + the order transitions (create/paid/fulfilling/shipped = 4).
  var totalSeen = Object.keys(seen).length;
  check("bound: cursor walk recovered every event", totalSeen === TOTAL + 4);
  check("bound: cursor walk stayed newest-first",   walkMonotonic);

  // ---- summary stays UNBOUNDED — windowed counts see all 220 -----------
  var summary = await ca.summarize({ customer_id: seed.customerId });
  check("bound: summary counts ALL wishlist events (unbounded read)",
    summary.kind_counts_365d["wishlist.added"] === TOTAL);
}

async function run() {
  await _forCustomerMixesSources();
  await _kindsFilter();
  await _cursorPagination();
  await _summarizeAggregates();
  await _lastActivityAtRead();
  await _inactiveCustomersDaysThreshold();
  await _skipInjectedPeers();
  await _validationRefusals();
  await _collectorReadIsBounded();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/customer-activity.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — customer-activity (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — customer-activity: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
