"use strict";
/**
 * recommendations — operator-curated overrides + signal-based picks
 * for the storefront recommendation rails.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migrations: 0001 (catalog), 0002 (cart), 0003 (orders), 0043
 * (collections), 0050 (recently_viewed), 0105 (recommendations).
 * Every CHECK on the shipped schema is exercised against the catalog
 * handle the primitive composes.
 *
 * Coverage:
 *   - setOverride inserts an active row, dedupes a re-add, and
 *     refuses (kind=product) when source_id === recommended_id
 *   - recommendForProduct prefers an operator override above any
 *     signal-stage candidate (ordering by weight DESC)
 *   - removeOverride soft-deletes (archived_at populated) AND
 *     setOverride after the remove revives the same row
 *   - listOverrides returns active-only by default, includeArchived
 *     surfaces the soft-deleted history
 *   - recordImpression / recordClick / recordConversion write to
 *     the ledger with the session_id namespace-hashed
 *   - metricsForKind computes CTR + conversion-rate + revenue
 *     attribution from the ledger
 *   - recommendForProduct falls back to category-popular when no
 *     overrides exist (and category-popular surfaces the same-
 *     collection products)
 *   - recommendForCart aggregates the co-purchase signal across
 *     every cart product id and excludes the cart's own products
 *   - recommendForCategory ranks by popularity within a collection
 *   - factory refusals (missing catalog; invalid kind / source_id)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop           = require("../../lib");
var recommendations = require("../../lib/recommendations");
var recentlyViewed  = require("../../lib/recently-viewed");
var helpers         = require("../helpers");
var check           = helpers.check;
var assert          = helpers.assert;

var MIG_CATALOG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");
var MIG_ORDER   = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0003_order.sql");
var MIG_ORDER_PROVIDER = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0950_orders_payment_provider.sql");
var MIG_ORDER_CAPTURE  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0951_orders_paypal_capture_id.sql");
var MIG_COLL    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0043_collections.sql");
var MIG_RV      = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0050_recently_viewed.sql");
var MIG_REC     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0105_recommendations.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_CART, MIG_ORDER, MIG_ORDER_PROVIDER, MIG_ORDER_CAPTURE, MIG_COLL, MIG_RV, MIG_REC].forEach(function (p) {
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

function _newSessionId() {
  return "rec_sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");        // allow:math-random — non-security test fixture
}

async function _seedProductWithVariant(catalog, opts) {
  opts = opts || {};
  var slug = opts.slug || ("rec-" + Math.random().toString(36).slice(2, 10));        // allow:math-random — unique slug per test
  var p = await catalog.products.create({ slug: slug, title: opts.title || "Product", status: "active" });
  var sku = "REC-SKU-" + Math.random().toString(36).slice(2, 10).toUpperCase();        // allow:math-random — unique sku per test
  var v = await catalog.variants.create(p.id, { sku: sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: opts.price || 2000 });
  await catalog.inventory.create(v.sku, { stock_on_hand: opts.stock == null ? 10 : opts.stock });
  return { product: p, variant: v };
}

async function _seedCollection(query, slug, productIds) {
  var ts = Date.now();
  await query(
    "INSERT INTO collections (slug, type, title, description, sort_strategy, created_at, updated_at) " +
    "VALUES (?1, 'manual', ?2, '', 'manual', ?3, ?3)",
    [slug, "Title " + slug, ts],
  );
  for (var i = 0; i < productIds.length; i += 1) {
    await query(
      "INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [_uuid(), slug, productIds[i], i, ts],
    );
  }
}

// Record a paid order containing the supplied (variant, sku, qty)
// triples. Bypasses the order FSM — we just need rows in `orders` +
// `order_lines` for the co-purchase / category-popular joins.
async function _recordOrder(query, customerId, lines) {
  var orderId = _uuid();
  var cartId  = _uuid();
  var ts = Date.now();
  var sessionTag = "rec_sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");        // allow:math-random — test fixture
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionTag, customerId, ts, ts + 60 * 60 * 1000],
  );
  var total = 0;
  for (var i = 0; i < lines.length; i += 1) total += lines[i].amount || 1000;
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', ?5, 0, 0, 0, ?5, NULL, '{}', ?6, ?6)",
    [orderId, cartId, customerId, sessionTag, total, ts],
  );
  for (var j = 0; j < lines.length; j += 1) {
    var line = lines[j];
    await query(
      "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, " +
      "unit_currency, line_total_minor) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'USD', ?7)",
      [_uuid(), orderId, line.variantId, line.sku, line.qty || 1, line.amount || 1000, (line.amount || 1000) * (line.qty || 1)],
    );
  }
  return orderId;
}

async function _makeStack(opts) {
  opts = opts || {};
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var rv      = recentlyViewed.create({ query: query, catalog: catalog });
  var rec     = recommendations.create(Object.assign({
    query: query, catalog: catalog, recentlyViewed: rv,
  }, opts));
  return { query: query, catalog: catalog, rv: rv, rec: rec };
}

// ---- tests --------------------------------------------------------------

async function _setOverrideInsertAndDedup() {
  var s = await _makeStack();
  var src = await _seedProductWithVariant(s.catalog, { slug: "ov-src-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var rec = await _seedProductWithVariant(s.catalog, { slug: "ov-rec-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test

  var first = await s.rec.setOverride({
    kind: "product",
    source_id: src.product.id,
    recommended_product_id: rec.product.id,
    weight: 250,
    position: 0,
  });
  check("setOverride: returns id (uuid shape)",       typeof first.id === "string" && first.id.length === 36);
  check("setOverride: status = inserted",             first.status === "inserted");
  check("setOverride: kind / source / recommended echoed",
    first.kind === "product" &&
    first.source_id === src.product.id &&
    first.recommended_product_id === rec.product.id);
  check("setOverride: weight applied",                first.weight === 250);

  // Re-add the same triple — UPSERT, same row id.
  var second = await s.rec.setOverride({
    kind: "product",
    source_id: src.product.id,
    recommended_product_id: rec.product.id,
    weight: 500,
  });
  check("setOverride: dedup returns same id",         second.id === first.id);
  check("setOverride: dedup status = updated",        second.status === "updated");
  check("setOverride: dedup weight updated",          second.weight === 500);

  var rows = (await s.query(
    "SELECT * FROM recommendation_overrides WHERE source_id = ?1", [src.product.id],
  )).rows;
  check("setOverride: dedup writes only one row",     rows.length === 1);
  check("setOverride: row weight persisted",          Number(rows[0].weight) === 500);

  // Refuses self-recommendation for kind=product / kind=cart.
  await assert.rejects(
    s.rec.setOverride({ kind: "product", source_id: src.product.id, recommended_product_id: src.product.id }),
    /differ/,
  );
  await assert.rejects(
    s.rec.setOverride({ kind: "cart", source_id: src.product.id, recommended_product_id: src.product.id }),
    /differ/,
  );

  // Validation surface.
  await assert.rejects(s.rec.setOverride(),                                            /input object/);
  await assert.rejects(s.rec.setOverride({ kind: "bogus", source_id: src.product.id, recommended_product_id: rec.product.id }), /kind/);
  await assert.rejects(s.rec.setOverride({ kind: "product", source_id: "not-uuid", recommended_product_id: rec.product.id }),   /source_id/);
  await assert.rejects(s.rec.setOverride({ kind: "category", source_id: "Bad Slug", recommended_product_id: rec.product.id }),  /source_id/);
  await assert.rejects(s.rec.setOverride({ kind: "product", source_id: src.product.id, recommended_product_id: "x" }),          /recommended_product_id/);
  await assert.rejects(s.rec.setOverride({ kind: "product", source_id: src.product.id, recommended_product_id: rec.product.id, weight: -1 }), /weight/);
  await assert.rejects(s.rec.setOverride({ kind: "product", source_id: src.product.id, recommended_product_id: rec.product.id, position: -1 }), /position/);
}

async function _recommendForProductUsesOverride() {
  var s = await _makeStack();
  // Anchor + 3 candidates, all renderable (active + in-stock).
  var src   = await _seedProductWithVariant(s.catalog, { slug: "rp-src-"   + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var hand1 = await _seedProductWithVariant(s.catalog, { slug: "rp-h1-"    + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var hand2 = await _seedProductWithVariant(s.catalog, { slug: "rp-h2-"    + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var coBuy = await _seedProductWithVariant(s.catalog, { slug: "rp-cobuy-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test

  // Seed a co-purchase signal: src + coBuy bought in the same order.
  await _recordOrder(s.query, _uuid(), [
    { variantId: src.variant.id,   sku: src.variant.sku },
    { variantId: coBuy.variant.id, sku: coBuy.variant.sku },
  ]);

  // Operator pins two overrides — weight DESC determines order.
  await s.rec.setOverride({
    kind: "product", source_id: src.product.id, recommended_product_id: hand1.product.id, weight: 100,
  });
  await s.rec.setOverride({
    kind: "product", source_id: src.product.id, recommended_product_id: hand2.product.id, weight: 200,
  });

  var picks = await s.rec.recommendForProduct(src.product.id, { limit: 5 });
  check("recommendForProduct: returns picks",          picks.length >= 2);
  check("recommendForProduct: override is first",      picks[0].source === "override");
  check("recommendForProduct: weight DESC ordering",   picks[0].product_id === hand2.product.id && picks[1].product_id === hand1.product.id);
  check("recommendForProduct: never returns self",     picks.every(function (p) { return p.product_id !== src.product.id; }));
  // The co-purchase signal still surfaces below the overrides.
  var coBuyPick = picks.filter(function (p) { return p.product_id === coBuy.product.id; })[0];
  check("recommendForProduct: co-purchase surfaces too", coBuyPick != null && coBuyPick.source === "co_purchase");
}

async function _removeOverrideAndRevive() {
  var s = await _makeStack();
  var src = await _seedProductWithVariant(s.catalog, { slug: "rm-src-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var rec = await _seedProductWithVariant(s.catalog, { slug: "rm-rec-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test

  var inserted = await s.rec.setOverride({
    kind: "product", source_id: src.product.id, recommended_product_id: rec.product.id, weight: 150,
  });

  var removed = await s.rec.removeOverride({
    kind: "product", source_id: src.product.id, recommended_product_id: rec.product.id,
  });
  check("removeOverride: removed count = 1",          removed.removed === 1);

  var row = (await s.query(
    "SELECT * FROM recommendation_overrides WHERE id = ?1", [inserted.id],
  )).rows[0];
  check("removeOverride: archived_at populated",      row != null && row.archived_at != null);

  // Active listing drops it; archived-included listing keeps it.
  var active = await s.rec.listOverrides({ kind: "product", source_id: src.product.id });
  check("listOverrides: active filter drops removed", active.length === 0);
  var withArchived = await s.rec.listOverrides({ kind: "product", source_id: src.product.id, includeArchived: true });
  check("listOverrides: includeArchived surfaces row",
    withArchived.length === 1 && withArchived[0].id === inserted.id);

  // Re-add — should revive the SAME row (preserves audit trail).
  var revived = await s.rec.setOverride({
    kind: "product", source_id: src.product.id, recommended_product_id: rec.product.id, weight: 300,
  });
  check("setOverride: revives same row id",           revived.id === inserted.id);
  check("setOverride: revived status = updated",      revived.status === "updated");
  var revivedRow = (await s.query(
    "SELECT * FROM recommendation_overrides WHERE id = ?1", [inserted.id],
  )).rows[0];
  check("setOverride: revival clears archived_at",    revivedRow.archived_at == null);
  check("setOverride: revival re-applies weight",     Number(revivedRow.weight) === 300);

  // removeOverride on a non-existent triple is a no-op (0 rows).
  var nothing = await s.rec.removeOverride({
    kind: "product", source_id: src.product.id, recommended_product_id: _uuid(),
  });
  check("removeOverride: nonexistent triple = 0",     nothing.removed === 0);
}

async function _ledgerWriteAndHash() {
  var s = await _makeStack();
  var src = await _seedProductWithVariant(s.catalog, { slug: "led-src-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var rec = await _seedProductWithVariant(s.catalog, { slug: "led-rec-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var sid = _newSessionId();

  var t0 = Date.now();
  var impressionRes = await s.rec.recordImpression({
    kind: "product",
    source_id: src.product.id,
    recommended_id: rec.product.id,
    session_id: sid,
    occurred_at: t0,
  });
  check("recordImpression: returns id + event_type",  typeof impressionRes.id === "string" && impressionRes.event_type === "impression");

  await s.rec.recordClick({
    kind: "product",
    source_id: src.product.id,
    recommended_id: rec.product.id,
    session_id: sid,
    occurred_at: t0 + 1000,
  });

  // Conversion w/ order_id.
  var orderId = await _recordOrder(s.query, _uuid(), [
    { variantId: rec.variant.id, sku: rec.variant.sku, amount: 5000 },
  ]);
  await s.rec.recordConversion({
    kind: "product",
    source_id: src.product.id,
    recommended_id: rec.product.id,
    session_id: sid,
    order_id: orderId,
    occurred_at: t0 + 2000,
  });

  var rows = (await s.query(
    "SELECT * FROM recommendation_events WHERE source_id = ?1 ORDER BY occurred_at ASC, id ASC",
    [src.product.id],
  )).rows;
  check("ledger: three rows written",                 rows.length === 3);
  check("ledger: event_type sequence",
    rows[0].event_type === "impression" &&
    rows[1].event_type === "click" &&
    rows[2].event_type === "conversion");
  check("ledger: raw session_id never stored",        rows.every(function (r) {
    return r.session_id_hash !== sid && (r.session_id_hash || "").indexOf(sid) === -1;
  }));
  check("ledger: session hash is sha3-512 hex (128 chars)",
    rows.every(function (r) { return typeof r.session_id_hash === "string" && r.session_id_hash.length === 128; }));
  check("ledger: conversion row carries order_id",    rows[2].order_id === orderId);
  check("ledger: non-conversion rows have null order_id",
    rows[0].order_id == null && rows[1].order_id == null);

  // Validation surface.
  await assert.rejects(s.rec.recordImpression(),                                                              /input object/);
  await assert.rejects(s.rec.recordImpression({ kind: "bogus", source_id: src.product.id, recommended_id: rec.product.id }), /kind/);
  await assert.rejects(s.rec.recordImpression({ kind: "product", source_id: "x", recommended_id: rec.product.id }),          /source_id/);
  await assert.rejects(s.rec.recordImpression({ kind: "product", source_id: src.product.id, recommended_id: "x" }),          /recommended_id/);
  await assert.rejects(s.rec.recordImpression({ kind: "product", source_id: src.product.id, recommended_id: rec.product.id, session_id: "tooshort" }), /session_id/);
}

async function _metricsCTRMath() {
  var s = await _makeStack();
  var src = await _seedProductWithVariant(s.catalog, { slug: "m-src-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var rec = await _seedProductWithVariant(s.catalog, { slug: "m-rec-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test

  // 10 impressions, 2 clicks, 1 conversion → CTR = 0.2, CR = 0.5.
  for (var i = 0; i < 10; i += 1) {
    await s.rec.recordImpression({
      kind: "product", source_id: src.product.id, recommended_id: rec.product.id,
    });
  }
  for (var j = 0; j < 2; j += 1) {
    await s.rec.recordClick({
      kind: "product", source_id: src.product.id, recommended_id: rec.product.id,
    });
  }
  var orderId = await _recordOrder(s.query, _uuid(), [
    { variantId: rec.variant.id, sku: rec.variant.sku, amount: 7500 },
  ]);
  await s.rec.recordConversion({
    kind: "product", source_id: src.product.id, recommended_id: rec.product.id, order_id: orderId,
  });

  var metrics = await s.rec.metricsForKind("product", { source_id: src.product.id });
  check("metrics: impressions = 10",                  metrics.impressions === 10);
  check("metrics: clicks = 2",                        metrics.clicks === 2);
  check("metrics: conversions = 1",                   metrics.conversions === 1);
  check("metrics: CTR = clicks / impressions",        Math.abs(metrics.ctr - 0.2) < 1e-9);
  check("metrics: conversion_rate = conv / clicks",   Math.abs(metrics.conversion_rate - 0.5) < 1e-9);
  check("metrics: revenue attribution by currency",   metrics.revenue_minor_by_currency.USD === 7500);
  check("metrics: source_id echoed when narrowed",    metrics.source_id === src.product.id);

  // Wide query without source_id surfaces the kind-aggregate.
  var wide = await s.rec.metricsForKind("product");
  check("metrics: kind-wide impressions includes narrowed", wide.impressions >= 10);
  check("metrics: wide query has no source_id",       wide.source_id == null);

  // Zero-event case → 0 CTR / 0 CR (no divide-by-zero NaN).
  var emptyMetrics = await s.rec.metricsForKind("category", { source_id: "no-such-collection" });
  check("metrics: empty CTR = 0",                     emptyMetrics.ctr === 0);
  check("metrics: empty conversion_rate = 0",         emptyMetrics.conversion_rate === 0);
  check("metrics: empty revenue empty object",        Object.keys(emptyMetrics.revenue_minor_by_currency).length === 0);

  // Validation: bad window.
  await assert.rejects(s.rec.metricsForKind("product", { since: 1000, until: 500 }), /since/);
  await assert.rejects(s.rec.metricsForKind("bogus"), /kind/);
}

async function _categoryPopularFallback() {
  var s = await _makeStack();
  // Three products in one collection. p1 sells 5, p2 sells 2,
  // p3 sells 0 — popularity ordering is p1 > p2 > p3.
  var src = await _seedProductWithVariant(s.catalog, { slug: "cp-src-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var p1  = await _seedProductWithVariant(s.catalog, { slug: "cp-p1-"  + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var p2  = await _seedProductWithVariant(s.catalog, { slug: "cp-p2-"  + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var p3  = await _seedProductWithVariant(s.catalog, { slug: "cp-p3-"  + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test

  await _seedCollection(s.query, "cp-collection", [src.product.id, p1.product.id, p2.product.id, p3.product.id]);

  // 5 sales of p1 across 5 orders, 2 sales of p2 across 2 orders.
  // Each order contains only the popularity-target so the
  // co-purchase signal from `src` doesn't pollute the fallback we're
  // measuring (the rail prefers co_purchase, but with no order
  // containing both src and the targets, the rail falls through to
  // category_popular).
  for (var i = 0; i < 5; i += 1) {
    await _recordOrder(s.query, _uuid(), [{ variantId: p1.variant.id, sku: p1.variant.sku, qty: 1 }]);
  }
  for (var j = 0; j < 2; j += 1) {
    await _recordOrder(s.query, _uuid(), [{ variantId: p2.variant.id, sku: p2.variant.sku, qty: 1 }]);
  }

  // No overrides — falls through to category_popular.
  var picks = await s.rec.recommendForProduct(src.product.id, { limit: 5 });
  check("category_popular: picks include collection peers", picks.length >= 2);
  // Ordering inside the category_popular stage is sales DESC.
  var byCategory = picks.filter(function (p) { return p.source === "category_popular"; });
  check("category_popular: at least two category picks",   byCategory.length >= 2);
  var ids = byCategory.map(function (p) { return p.product_id; });
  check("category_popular: p1 ranks above p2",
    ids.indexOf(p1.product.id) >= 0 &&
    ids.indexOf(p2.product.id) >= 0 &&
    ids.indexOf(p1.product.id) < ids.indexOf(p2.product.id));
  check("category_popular: self excluded",                ids.indexOf(src.product.id) === -1);

  // recommendForCategory anchored on the slug surfaces the same
  // ranking (no anchor self-exclusion since `src` IS a member).
  var catPicks = await s.rec.recommendForCategory("cp-collection", { limit: 5 });
  var catIds = catPicks.map(function (p) { return p.product_id; });
  check("recommendForCategory: returns members",          catPicks.length >= 2);
  check("recommendForCategory: p1 ranks first",           catIds[0] === p1.product.id);
  check("recommendForCategory: source tagged",            catPicks[0].source === "category_popular");
}

async function _recommendForCartCoPurchase() {
  var s = await _makeStack();
  // Cart contains a + b. Customers who bought a + b also bought c.
  // The picker should surface c.
  var a = await _seedProductWithVariant(s.catalog, { slug: "cart-a-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var b = await _seedProductWithVariant(s.catalog, { slug: "cart-b-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var c = await _seedProductWithVariant(s.catalog, { slug: "cart-c-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test
  var d = await _seedProductWithVariant(s.catalog, { slug: "cart-d-" + Math.random().toString(36).slice(2, 8) });        // allow:math-random — unique slug per test

  // a + c bought together (twice for higher score).
  await _recordOrder(s.query, _uuid(), [
    { variantId: a.variant.id, sku: a.variant.sku },
    { variantId: c.variant.id, sku: c.variant.sku },
  ]);
  await _recordOrder(s.query, _uuid(), [
    { variantId: a.variant.id, sku: a.variant.sku },
    { variantId: c.variant.id, sku: c.variant.sku },
  ]);
  // b + d bought together (once).
  await _recordOrder(s.query, _uuid(), [
    { variantId: b.variant.id, sku: b.variant.sku },
    { variantId: d.variant.id, sku: d.variant.sku },
  ]);

  var picks = await s.rec.recommendForCart([a.product.id, b.product.id], { limit: 5 });
  var pickIds = picks.map(function (p) { return p.product_id; });
  check("recommendForCart: returns picks",                picks.length >= 2);
  check("recommendForCart: includes co-purchase candidates",
    pickIds.indexOf(c.product.id) !== -1 && pickIds.indexOf(d.product.id) !== -1);
  check("recommendForCart: cart items excluded",
    pickIds.indexOf(a.product.id) === -1 && pickIds.indexOf(b.product.id) === -1);
  check("recommendForCart: c (two co-purchases) ranks above d (one)",
    pickIds.indexOf(c.product.id) < pickIds.indexOf(d.product.id));
  check("recommendForCart: co_purchase source tag",
    picks.filter(function (p) { return p.product_id === c.product.id; })[0].source === "co_purchase");

  // Object input shape works the same.
  var objPicks = await s.rec.recommendForCart({ product_ids: [a.product.id] }, { limit: 5 });
  var objIds = objPicks.map(function (p) { return p.product_id; });
  check("recommendForCart: object input shape supported", objIds.indexOf(c.product.id) !== -1);

  // Validation surface.
  await assert.rejects(s.rec.recommendForCart(null),                /product id array/);
  await assert.rejects(s.rec.recommendForCart([]),                  /at least one/);
  await assert.rejects(s.rec.recommendForCart(["not-a-uuid"]),      /product_ids/);
}

async function _factoryRefusals() {
  var query = _makeQuery();
  var threwNoCatalog = false;
  try { recommendations.create({ query: query }); }
  catch (e) { threwNoCatalog = /catalog/.test(e.message); }
  check("create: refuses without catalog",            threwNoCatalog === true);

  var catalog = bShop.catalog.create({ query: query });
  var rec = recommendations.create({ query: query, catalog: catalog });
  check("create: returns surface",
    typeof rec.recommendForProduct === "function" &&
    typeof rec.setOverride === "function" &&
    typeof rec.metricsForKind === "function" &&
    Array.isArray(rec.KINDS) && rec.KINDS.length === 4);

  // recommendForProduct entry-point validation.
  await assert.rejects(rec.recommendForProduct("not-a-uuid"), /product_id/);

  // recommendForCustomer entry-point validation.
  await assert.rejects(rec.recommendForCustomer("not-a-uuid"), /customer_id/);

  // recommendForCategory entry-point validation.
  await assert.rejects(rec.recommendForCategory("Bad Slug"), /slug/);

  // listOverrides validation.
  await assert.rejects(rec.listOverrides(),                       /opts object required/);
  await assert.rejects(rec.listOverrides({ kind: "bogus" }),      /kind/);
}

async function run() {
  await _setOverrideInsertAndDedup();
  await _recommendForProductUsesOverride();
  await _removeOverrideAndRevive();
  await _ledgerWriteAndHash();
  await _metricsCTRMath();
  await _categoryPopularFallback();
  await _recommendForCartCoPurchase();
  await _factoryRefusals();
}

if (require.main === module) {
  run().then(function () {
    console.log("recommendations: OK (" + helpers.getChecks() + " checks)");
  }).catch(function (e) {
    console.error(e && e.stack || e);
    process.exit(1);
  });
}

module.exports = { run: run };
