"use strict";
/**
 * orderTags — free-form operator-applied labels on orders.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations 0002
 * (cart, referenced by orders.cart_id) + 0003 (orders + order_lines) +
 * 0049 (customer_segments, referenced by the rule customer_segment_in
 * predicate) + 0137 (order_tags_defined + order_tag_assignments +
 * order_tag_rules). Every CHECK / UNIQUE in the shipped schema is
 * exercised against seeded orders.
 *
 * Coverage:
 *   - defineTag: persists slug + color + default_color_for_status;
 *     duplicate slug refused; bad color / status / slug shapes refused
 *   - applyTag: writes assignment row; UNIQUE refuses double-apply;
 *     archived tag refused; unknown tag refused
 *   - removeTag: soft-deletes (removed_at / removed_by set); re-apply
 *     after removal succeeds with a fresh monotonic applied_at
 *   - monotonic clock: apply + remove + reapply within the same
 *     millisecond produces strictly-increasing applied_at values
 *   - tagsForOrder: filters removed assignments; hydrates tag
 *     metadata; honors apply-order
 *   - ordersWithTag: HMAC-tagged cursor pagination; tamper refused
 *   - popularTags: ranks by active-assignment count; ignores archived
 *   - defineRule + applyRulesToOrder: matches total + country +
 *     line_count + customer_segment predicates; idempotent on
 *     re-evaluation; archived rules skipped
 *   - listTags / archiveTag / updateTag: archive hides by default;
 *     updateTag patches color / title / status; unknown slugs refused
 *   - historyForOrder: append-only timeline (apply + remove events)
 *   - production guards cursorSecret
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop     = require("../../lib");
var orderTags = require("../../lib/order-tags");
var helpers   = require("../helpers");
var check     = helpers.check;
var assert    = helpers.assert;

var MIG_CART     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");
var MIG_ORDER    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0003_order.sql");
var MIG_ORDER_PROVIDER = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0950_orders_payment_provider.sql");
var MIG_ORDER_CAPTURE  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0951_orders_paypal_capture_id.sql");
var MIG_SEGMENTS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0049_customer_segments.sql");
var MIG_TAGS     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0137_order_tags.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CART, MIG_ORDER, MIG_ORDER_PROVIDER, MIG_ORDER_CAPTURE, MIG_SEGMENTS, MIG_TAGS].forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
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

// Seed a cart row so an orders.cart_id FK has a target.
async function _seedCart(query) {
  var id = _uuid();
  var ts = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, 'USD', 'converted', ?3, ?3, ?4)",
    [id, "sess_" + id.slice(0, 8), ts, ts + 365 * 24 * 60 * 60 * 1000],
  );
  return id;
}

// Insert an orders row + optionally N order_lines so line_count predicates
// have something to predicate against.
async function _seedOrder(query, opts) {
  opts = opts || {};
  var cartId = await _seedCart(query);
  var id = _uuid();
  var status   = opts.status   || "paid";
  var currency = opts.currency || "USD";
  var grand    = opts.grand_total_minor == null ? 10000 : opts.grand_total_minor;
  var country  = opts.country  || "US";
  var createdAt = opts.created_at == null ? Date.now() : opts.created_at;
  var customerId = opts.customer_id == null ? null : opts.customer_id;
  var shipTo = JSON.stringify({ country: country });
  await query(
    "INSERT INTO orders " +
    "(id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    " discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    " payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, ?8, NULL, ?9, ?10, ?10)",
    [id, cartId, customerId, "sess_" + id.slice(0, 8), status, currency, grand, grand, shipTo, createdAt],
  );
  var lineCount = opts.line_count == null ? 1 : opts.line_count;
  for (var i = 0; i < lineCount; i += 1) {
    var lineId = _uuid();
    await query(
      "INSERT INTO order_lines " +
      "(id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [lineId, id, _uuid(), "SKU-" + i, 1, grand, currency, grand],
    );
  }
  return id;
}

// Seed a customer_segments row + a membership row so the
// customer_segment_in predicate has something to predicate against.
async function _seedSegment(query, slug, customerId) {
  var segId = _uuid();
  var ts = Date.now();
  await query(
    "INSERT INTO customer_segments " +
    "(id, slug, title, description, rules_json, archived_at, " +
    " last_recomputed_at, last_member_count, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, '', '{}', NULL, ?4, 1, ?4, ?4)",
    [segId, slug, slug, ts],
  );
  await query(
    "INSERT INTO customer_segment_membership (segment_id, customer_id, evaluated_at) " +
    "VALUES (?1, ?2, ?3)",
    [segId, customerId, ts],
  );
}

// ---- tests --------------------------------------------------------------

async function _defineTagAndDuplicate() {
  var query = _makeQuery();
  var t = orderTags.create({ query: query });

  var rush = await t.defineTag({
    slug:        "rush",
    title:       "Rush",
    description: "Priority pick + pack",
    color:       "#ff3366",
    default_color_for_status: "paid",
  });
  check("defineTag: returns slug",            rush.slug === "rush");
  check("defineTag: title preserved",         rush.title === "Rush");
  check("defineTag: color preserved",         rush.color === "#ff3366");
  check("defineTag: default_color_for_status preserved",
        rush.default_color_for_status === "paid");
  check("defineTag: not archived",            rush.archived_at == null);
  check("defineTag: created_at set",          typeof rush.created_at === "number");

  // Duplicate slug refused.
  await assert.rejects(
    t.defineTag({ slug: "rush", title: "another", color: "#000000" }),
    /already defined/,
  );

  // Bad shape refusals.
  await assert.rejects(
    t.defineTag({ slug: "Bad Slug!", title: "x", color: "#000000" }),
    /slug/,
  );
  await assert.rejects(
    t.defineTag({ slug: "ok", title: "x", color: "red" }),
    /color/,
  );
  await assert.rejects(
    t.defineTag({ slug: "ok", title: "x", color: "#FF0000" }),
    /color/,    // upper-case rejected — canonical form is lowercase
  );
  await assert.rejects(
    t.defineTag({ slug: "ok", title: "x", color: "#ff0000", default_color_for_status: "bogus" }),
    /default_color_for_status/,
  );
  await assert.rejects(
    t.defineTag({ slug: "ok", title: "", color: "#ff0000" }),
    /title/,
  );

  // Tag with no default_color_for_status — null persisted.
  var demo = await t.defineTag({ slug: "demo", title: "Demo", color: "#888888" });
  check("defineTag: dcfs null when omitted", demo.default_color_for_status === null);
}

async function _applyTagAndUniqueRefusal() {
  var query = _makeQuery();
  var t = orderTags.create({ query: query });

  await t.defineTag({ slug: "rush", title: "Rush", color: "#ff3366" });
  var orderId = await _seedOrder(query, {});

  var a = await t.applyTag({
    order_id:   orderId,
    tag_slug:   "rush",
    applied_by: "ops:alice",
    reason:     "customer called in",
  });
  check("applyTag: returns assignment id",    typeof a.id === "string" && a.id.length > 0);
  check("applyTag: order_id preserved",       a.order_id === orderId);
  check("applyTag: tag_slug preserved",       a.tag_slug === "rush");
  check("applyTag: applied_by preserved",     a.applied_by === "ops:alice");
  check("applyTag: reason preserved",         a.reason === "customer called in");
  check("applyTag: applied_at set",           typeof a.applied_at === "number");
  check("applyTag: removed_at null",          a.removed_at == null);

  // Double-apply refused — UNIQUE partial index says one active per pair.
  await assert.rejects(
    t.applyTag({ order_id: orderId, tag_slug: "rush", applied_by: "ops:bob" }),
    /already active/,
  );

  // Apply unknown tag refused.
  await assert.rejects(
    t.applyTag({ order_id: orderId, tag_slug: "nonexistent", applied_by: "ops:bob" }),
    /unknown tag_slug/,
  );

  // Apply archived tag refused.
  await t.defineTag({ slug: "old", title: "Old", color: "#444444" });
  await t.archiveTag("old");
  await assert.rejects(
    t.applyTag({ order_id: orderId, tag_slug: "old", applied_by: "ops:bob" }),
    /archived/,
  );

  // Bad order_id shape refused.
  await assert.rejects(
    t.applyTag({ order_id: "not-a-uuid", tag_slug: "rush", applied_by: "ops:bob" }),
    /order_id/,
  );

  // Bad applied_by shape refused.
  await assert.rejects(
    t.applyTag({ order_id: orderId, tag_slug: "rush", applied_by: "" }),
    /applied_by/,
  );
}

async function _removeTagSoftDelete() {
  var query = _makeQuery();
  var t = orderTags.create({ query: query });

  await t.defineTag({ slug: "fraud-review", title: "Fraud review", color: "#cc0000" });
  var orderId = await _seedOrder(query, {});

  await t.applyTag({ order_id: orderId, tag_slug: "fraud-review", applied_by: "ops:alice" });
  var removed = await t.removeTag({ order_id: orderId, tag_slug: "fraud-review", removed_by: "ops:bob" });
  check("removeTag: removed_at set",          typeof removed.removed_at === "number");
  check("removeTag: removed_by set",          removed.removed_by === "ops:bob");
  check("removeTag: applied_at preserved",    typeof removed.applied_at === "number");
  check("removeTag: removed_at > applied_at", removed.removed_at > removed.applied_at);

  // tagsForOrder filters the removed row.
  var active = await t.tagsForOrder(orderId);
  check("tagsForOrder: removed filtered",     active.length === 0);

  // Re-apply after removal succeeds — second row, fresh applied_at.
  var reapplied = await t.applyTag({ order_id: orderId, tag_slug: "fraud-review", applied_by: "ops:carol" });
  check("applyTag: re-apply succeeds after removal", reapplied.removed_at == null);
  check("applyTag: re-apply has fresh applied_at",   reapplied.applied_at >= removed.removed_at);
  check("applyTag: re-apply has different id",       reapplied.id !== removed.id);

  // tagsForOrder shows the reapplied tag.
  var active2 = await t.tagsForOrder(orderId);
  check("tagsForOrder: reapplied visible",    active2.length === 1 && active2[0].tag_slug === "fraud-review");

  // Removing a non-active tag refused.
  await t.removeTag({ order_id: orderId, tag_slug: "fraud-review", removed_by: "ops:carol" });
  await assert.rejects(
    t.removeTag({ order_id: orderId, tag_slug: "fraud-review", removed_by: "ops:carol" }),
    /not active/,
  );
}

async function _monotonicClock() {
  // Rapid-fire apply / remove / reapply against the same (order, tag)
  // pair — the monotonic-clock bumper guarantees strictly-increasing
  // applied_at values even when wall-clock ms ties.
  var query = _makeQuery();
  var t = orderTags.create({ query: query });

  await t.defineTag({ slug: "wholesale", title: "Wholesale", color: "#0066ff" });
  var orderId = await _seedOrder(query, {});

  // Three apply + remove cycles in tight succession.
  var firstApply  = await t.applyTag({ order_id: orderId, tag_slug: "wholesale", applied_by: "ops:1" });
  await t.removeTag({ order_id: orderId, tag_slug: "wholesale", removed_by: "ops:1" });
  var secondApply = await t.applyTag({ order_id: orderId, tag_slug: "wholesale", applied_by: "ops:2" });
  await t.removeTag({ order_id: orderId, tag_slug: "wholesale", removed_by: "ops:2" });
  var thirdApply  = await t.applyTag({ order_id: orderId, tag_slug: "wholesale", applied_by: "ops:3" });

  check("monotonic: 2nd applied_at strictly > 1st", secondApply.applied_at > firstApply.applied_at);
  check("monotonic: 3rd applied_at strictly > 2nd", thirdApply.applied_at > secondApply.applied_at);

  // history shows all three apply + two remove events ordered by timestamp.
  var history = await t.historyForOrder(orderId);
  check("history: 5 events recorded",               history.length === 5);
  check("history: ordered ascending",
        history.every(function (e, i) { return i === 0 || history[i - 1].at <= e.at; }));
  var applies = history.filter(function (e) { return e.kind === "apply"; });
  var removes = history.filter(function (e) { return e.kind === "remove"; });
  check("history: 3 apply events",                  applies.length === 3);
  check("history: 2 remove events",                 removes.length === 2);
}

async function _defineRuleAndApplyRulesToOrder() {
  var query = _makeQuery();
  var t = orderTags.create({ query: query });

  await t.defineTag({ slug: "wholesale",     title: "Wholesale",   color: "#0066ff" });
  await t.defineTag({ slug: "uk-shipment",   title: "UK shipment", color: "#ff0066" });
  await t.defineTag({ slug: "bulk-order",    title: "Bulk order",  color: "#00cc66" });
  await t.defineTag({ slug: "vip",           title: "VIP",         color: "#ffcc00" });

  // Total >= $500 → wholesale.
  await t.defineRule({
    slug:       "high-total",
    conditions: { total_minor_min: 50000 },
    tag_slug:   "wholesale",
  });
  // Ship-to UK → uk-shipment.
  await t.defineRule({
    slug:       "uk-ship",
    conditions: { country_in: ["GB"] },
    tag_slug:   "uk-shipment",
  });
  // line_count >= 5 → bulk-order.
  await t.defineRule({
    slug:       "many-lines",
    conditions: { line_count_min: 5 },
    tag_slug:   "bulk-order",
  });
  // customer_segment_in ['vip-segment'] → vip.
  await t.defineRule({
    slug:       "vip-customer",
    conditions: { customer_segment_in: ["vip-segment"] },
    tag_slug:   "vip",
  });

  // Order 1: high total + UK + many lines + VIP customer → all 4 rules match.
  var custVip = _uuid();
  await _seedSegment(query, "vip-segment", custVip);
  var bigOrder = await _seedOrder(query, {
    customer_id:        custVip,
    grand_total_minor:  100000,
    country:            "GB",
    line_count:         6,
  });
  var report = await t.applyRulesToOrder(bigOrder);
  check("applyRulesToOrder: 4 rules matched",     report.applied.length === 4);
  check("applyRulesToOrder: wholesale applied",   report.applied.indexOf("wholesale")   !== -1);
  check("applyRulesToOrder: uk-shipment applied", report.applied.indexOf("uk-shipment") !== -1);
  check("applyRulesToOrder: bulk-order applied",  report.applied.indexOf("bulk-order")  !== -1);
  check("applyRulesToOrder: vip applied",         report.applied.indexOf("vip")         !== -1);

  // Idempotent — second invocation skips already-applied.
  var rerun = await t.applyRulesToOrder(bigOrder);
  check("applyRulesToOrder: rerun applied empty", rerun.applied.length === 0);
  check("applyRulesToOrder: 4 skipped as already_applied",
        rerun.skipped.filter(function (s) { return s.reason === "already_applied"; }).length === 4);

  // Small US order — nothing matches.
  var smallOrder = await _seedOrder(query, {
    grand_total_minor: 1000, country: "US", line_count: 1,
  });
  var smallReport = await t.applyRulesToOrder(smallOrder);
  check("applyRulesToOrder: small order matches 0", smallReport.applied.length === 0);
  check("applyRulesToOrder: small order skipped 4", smallReport.skipped.length === 4);

  // tagsForOrder reflects the big-order tags.
  var bigTags = await t.tagsForOrder(bigOrder);
  check("tagsForOrder: 4 active tags",            bigTags.length === 4);
  check("tagsForOrder: applied_by names rule",
        bigTags.every(function (tag) { return tag.applied_by.indexOf("rule:") === 0; }));

  // defineRule refusals.
  await assert.rejects(
    t.defineRule({ slug: "x", conditions: { bogus_key: 1 }, tag_slug: "wholesale" }),
    /unknown condition key/,
  );
  await assert.rejects(
    t.defineRule({ slug: "x", conditions: {}, tag_slug: "wholesale" }),
    /at least one predicate/,
  );
  await assert.rejects(
    t.defineRule({ slug: "x", conditions: { total_minor_min: 100 }, tag_slug: "does-not-exist" }),
    /tag_slug/,
  );
  await assert.rejects(
    t.defineRule({ slug: "x", conditions: { country_in: ["gb"] }, tag_slug: "wholesale" }),
    /country/,
  );
  await assert.rejects(
    t.defineRule({
      slug: "x",
      conditions: { total_minor_min: 100, total_minor_max: 50 },
      tag_slug: "wholesale",
    }),
    /total_minor_min/,
  );
  // Duplicate rule slug.
  await assert.rejects(
    t.defineRule({ slug: "high-total", conditions: { total_minor_min: 1 }, tag_slug: "wholesale" }),
    /already defined/,
  );
}

async function _ordersWithTagPagination() {
  var query = _makeQuery();
  var t = orderTags.create({ query: query });

  await t.defineTag({ slug: "rush", title: "Rush", color: "#ff3366" });

  // Seed 5 orders all tagged rush.
  var orderIds = [];
  for (var i = 0; i < 5; i += 1) {
    var oid = await _seedOrder(query, {});
    orderIds.push(oid);
    await t.applyTag({ order_id: oid, tag_slug: "rush", applied_by: "ops:1" });
  }
  var sortedExpected = orderIds.slice().sort();

  var page1 = await t.ordersWithTag({ tag_slug: "rush", limit: 2 });
  check("ordersWithTag page1: 2 ids",          page1.order_ids.length === 2);
  check("ordersWithTag page1: cursor present", typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);

  var page2 = await t.ordersWithTag({ tag_slug: "rush", limit: 2, cursor: page1.next_cursor });
  check("ordersWithTag page2: 2 ids",            page2.order_ids.length === 2);
  check("ordersWithTag page2: strictly after p1", page2.order_ids[0] > page1.order_ids[1]);

  var page3 = await t.ordersWithTag({ tag_slug: "rush", limit: 2, cursor: page2.next_cursor });
  check("ordersWithTag page3: 1 id (tail)",      page3.order_ids.length === 1);
  check("ordersWithTag page3: no further cursor", page3.next_cursor === null);

  var combined = page1.order_ids.concat(page2.order_ids).concat(page3.order_ids);
  check("ordersWithTag: combined = sorted seed",
        combined.length === sortedExpected.length
        && combined.every(function (id, ix) { return id === sortedExpected[ix]; }));

  // Tampered cursor refused.
  await assert.rejects(t.ordersWithTag({ tag_slug: "rush", cursor: "not-a-real-cursor" }), /cursor/);
  await assert.rejects(t.ordersWithTag({ tag_slug: "rush", cursor: 42 }), /cursor/);

  // Cursor minted under a different secret is refused.
  var crossSeg = orderTags.create({ query: query, cursorSecret: "different-secret" });
  await assert.rejects(crossSeg.ordersWithTag({ tag_slug: "rush", cursor: page1.next_cursor }), /cursor/);

  // Removed tag drops out of ordersWithTag.
  await t.removeTag({ order_id: orderIds[0], tag_slug: "rush", removed_by: "ops:1" });
  var page1Post = await t.ordersWithTag({ tag_slug: "rush", limit: 10 });
  check("ordersWithTag: removed assignment filtered",
        page1Post.order_ids.length === 4 && page1Post.order_ids.indexOf(orderIds[0]) === -1);
}

async function _popularTagsAndListAndUpdate() {
  var query = _makeQuery();
  var t = orderTags.create({ query: query });

  await t.defineTag({ slug: "rush",    title: "Rush",     color: "#ff3366" });
  await t.defineTag({ slug: "demo",    title: "Demo",     color: "#888888" });
  await t.defineTag({ slug: "archive-me", title: "Old",   color: "#444444" });

  // 3 rush, 1 demo, 1 archive-me (then we archive archive-me).
  for (var i = 0; i < 3; i += 1) {
    var oid = await _seedOrder(query, {});
    await t.applyTag({ order_id: oid, tag_slug: "rush", applied_by: "ops:1" });
  }
  var demoOrder = await _seedOrder(query, {});
  await t.applyTag({ order_id: demoOrder, tag_slug: "demo", applied_by: "ops:1" });
  var archOrder = await _seedOrder(query, {});
  await t.applyTag({ order_id: archOrder, tag_slug: "archive-me", applied_by: "ops:1" });

  var popular = await t.popularTags({ limit: 10 });
  check("popularTags: 3 tags ranked",         popular.length === 3);
  check("popularTags: rush #1 with count 3",  popular[0].tag_slug === "rush" && popular[0].count === 3);
  check("popularTags: rush color hydrated",   popular[0].color === "#ff3366");

  // Archive archive-me → popularTags drops it.
  await t.archiveTag("archive-me");
  var popularPostArc = await t.popularTags({ limit: 10 });
  check("popularTags: archived tag dropped",
        popularPostArc.length === 2
        && popularPostArc.every(function (p) { return p.tag_slug !== "archive-me"; }));

  // listTags default vs include_archived.
  var active = await t.listTags();
  check("listTags default: active only",
        active.length === 2 && active.every(function (tag) { return tag.archived_at == null; }));
  var all = await t.listTags({ include_archived: true });
  check("listTags include_archived: all",     all.length === 3);

  // updateTag.
  var patched = await t.updateTag("rush", {
    color: "#ff0000",
    description: "Top of the queue",
    default_color_for_status: "fulfilling",
  });
  check("updateTag: color patched",                 patched.color === "#ff0000");
  check("updateTag: description patched",           patched.description === "Top of the queue");
  check("updateTag: default_color_for_status patched", patched.default_color_for_status === "fulfilling");
  check("updateTag: title preserved",               patched.title === "Rush");

  // Bad updateTag refused.
  await assert.rejects(t.updateTag("nonexistent", { color: "#000000" }), /unknown slug/);
  await assert.rejects(t.updateTag("rush", { color: "red" }),            /color/);

  // Archive idempotent.
  var arc1 = await t.archiveTag("archive-me");
  check("archiveTag: idempotent",                   arc1.archived_at != null);
  await assert.rejects(t.archiveTag("does-not-exist"), /unknown slug/);
}

async function _productionRequiresCursorSecret() {
  var prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    var threw = false;
    try {
      orderTags.create({ query: _makeQuery() });
    } catch (e) {
      threw = /cursorSecret/.test(e.message);
    }
    check("create: throws in production without cursorSecret", threw === true);

    var t = orderTags.create({ query: _makeQuery(), cursorSecret: "test-secret" });
    check("create: accepts cursorSecret in production",        typeof t.defineTag === "function");
  } finally {
    process.env.NODE_ENV = prev;
  }
}

async function run() {
  await _defineTagAndDuplicate();
  await _applyTagAndUniqueRefusal();
  await _removeTagSoftDelete();
  await _monotonicClock();
  await _defineRuleAndApplyRulesToOrder();
  await _ordersWithTagPagination();
  await _popularTagsAndListAndUpdate();
  await _productionRequiresCursorSecret();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK order-tags (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL order-tags:", err && err.stack || err);
    process.exit(1);
  });
}
