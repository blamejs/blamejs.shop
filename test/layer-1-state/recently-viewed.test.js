"use strict";
/**
 * recently-viewed — per-customer / per-session product browse log.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migrations: 0001 (catalog), 0002 (cart), 0003 (orders) and 0050
 * (recently_viewed). Every UNIQUE / CHECK in the shipped schema is
 * exercised against the catalog handle the primitive composes.
 *
 * Coverage:
 *   - recordView inserts a new row with view_count = 1
 *   - recordView dedups inside the 5-minute window (same row,
 *     view_count incremented, last_viewed_at moved forward)
 *   - recordView resets view_count to 1 outside the dedup window
 *     but still updates last_viewed_at
 *   - recordView refuses without customer_id AND session_id
 *   - recordView with session_id namespace-hashes the value
 *     (raw cookie never persists)
 *   - per-subject cap trims the oldest row when a write would
 *     push the count past the cap
 *   - forCustomer returns newest-first
 *   - forCustomer({ exclude_purchased: true }) filters out
 *     products the customer has already bought
 *   - forSession looks up the same row that recordView wrote
 *   - merge folds a session's history into the customer record
 *     (sums view_count for collisions, claims fresh rows in place)
 *   - recommend returns co-viewed products (sorted by score desc,
 *     seed-viewed + purchased excluded)
 *   - cleanupOlderThan prunes rows older than the cutoff
 *   - purgeCustomer drops every row for the customer
 *   - factory refusals: missing catalog
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var recentlyViewed = require("../../lib/recently-viewed");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_CATALOG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");
var MIG_ORDER   = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0003_order.sql");
var MIG_RV      = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0050_recently_viewed.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_CART, MIG_ORDER, MIG_RV].forEach(function (p) {
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
  // 16-64 chars of [A-Za-z0-9_-] to satisfy the shape gate.
  return "sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");        // allow:math-random — non-security test fixture
}

async function _seedProduct(catalog, opts) {
  opts = opts || {};
  var slug = opts.slug || ("prod-" + Math.random().toString(36).slice(2, 10));        // allow:math-random — unique slug per test
  var p = await catalog.products.create({ slug: slug, title: opts.title || "Product", status: "active" });
  return p;
}

async function _seedProductWithVariant(catalog, opts) {
  opts = opts || {};
  var p = await _seedProduct(catalog, opts);
  var sku = "SKU-" + Math.random().toString(36).slice(2, 10).toUpperCase();        // allow:math-random — unique sku per test
  var v = await catalog.variants.create(p.id, { sku: sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: opts.price || 2000 });
  await catalog.inventory.create(v.sku, { stock_on_hand: opts.stock == null ? 10 : opts.stock });
  return { product: p, variant: v };
}

async function _makeStack(opts) {
  opts = opts || {};
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var rv      = recentlyViewed.create(Object.assign({ query: query, catalog: catalog }, opts));
  return { query: query, catalog: catalog, rv: rv };
}

// Record an order line for a customer so exclude_purchased / recommend
// can see purchase history. Bypasses the order FSM — we just need rows
// in `orders` + `order_lines` for the join in the primitive's queries.
async function _recordOrder(query, customerId, variantId, sku) {
  var orderId = bShop.framework.uuid.v7();
  var cartId  = bShop.framework.uuid.v7();
  var ts = Date.now();
  var sessionTag = "sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");        // allow:math-random — test fixture
  // Seed a carts row so the orders → carts FK resolves under
  // PRAGMA foreign_keys = ON.
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionTag, customerId, ts, ts + 60 * 60 * 1000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 1000, 0, 0, 0, 1000, NULL, '{}', ?5, ?5)",
    [orderId, cartId, customerId, sessionTag, ts],
  );
  var lineId = bShop.framework.uuid.v7();
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, " +
    "unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 1000, 'USD', 1000)",
    [lineId, orderId, variantId, sku],
  );
}

// ---- tests --------------------------------------------------------------

async function _recordInsertAndDedup() {
  var s = await _makeStack();
  var customer = _uuid();
  var p = await _seedProduct(s.catalog);

  var first = await s.rv.recordView({ customer_id: customer, product_id: p.id });
  check("recordView: returns id (uuid shape)",       typeof first.id === "string" && first.id.length === 36);
  check("recordView: first call status = inserted",  first.status === "inserted");
  check("recordView: first call view_count = 1",     first.view_count === 1);

  // Second view inside the dedup window — same row, view_count = 2.
  var second = await s.rv.recordView({ customer_id: customer, product_id: p.id });
  check("recordView: dedup returns same id",         second.id === first.id);
  check("recordView: dedup status = updated",        second.status === "updated");
  check("recordView: dedup view_count incremented",  second.view_count === 2);

  // Exactly one row in storage.
  var rows = (await s.query(
    "SELECT * FROM recently_viewed WHERE customer_id = ?1", [customer],
  )).rows;
  check("recordView: dedup writes only one row",     rows.length === 1);
  check("recordView: view_count persisted to DB",    Number(rows[0].view_count) === 2);
  check("recordView: viewed_at preserved on dedup",  Number(rows[0].viewed_at) <= Number(rows[0].last_viewed_at));
}

async function _recordResetsCountOutsideDedupWindow() {
  var s = await _makeStack();
  var customer = _uuid();
  var p = await _seedProduct(s.catalog);

  var t0 = Date.now() - 10 * 60 * 1000;        // 10 minutes ago
  await s.rv.recordView({ customer_id: customer, product_id: p.id, occurred_at: t0 });
  var second = await s.rv.recordView({ customer_id: customer, product_id: p.id });
  check("recordView: outside window resets view_count to 1", second.view_count === 1);
  check("recordView: outside window still status = updated", second.status === "updated");
}

async function _recordRefusesWithoutSubject() {
  var s = await _makeStack();
  var p = await _seedProduct(s.catalog);

  await assert.rejects(s.rv.recordView(),                                /input object required/);
  await assert.rejects(s.rv.recordView({ product_id: p.id }),            /customer_id.*session_id/);
  await assert.rejects(
    s.rv.recordView({ customer_id: _uuid() }),
    /product_id/,
  );
  await assert.rejects(
    s.rv.recordView({ customer_id: "not-a-uuid", product_id: p.id }),
    /customer_id/,
  );
  await assert.rejects(
    s.rv.recordView({ session_id: "tooshort", product_id: p.id }),
    /session_id/,
  );
  await assert.rejects(
    s.rv.recordView({ customer_id: _uuid(), product_id: p.id, occurred_at: -1 }),
    /occurred_at/,
  );
}

async function _sessionIdNamespaceHashed() {
  var s = await _makeStack();
  var sid = _newSessionId();
  var p = await _seedProduct(s.catalog);

  await s.rv.recordView({ session_id: sid, product_id: p.id });

  var row = (await s.query(
    "SELECT * FROM recently_viewed WHERE product_id = ?1", [p.id],
  )).rows[0];
  check("session: row written",                       row != null);
  check("session: raw session_id never stored",       row.session_id_hash !== sid && (row.session_id_hash || "").indexOf(sid) === -1);
  check("session: hash is sha3-512 hex (128 chars)",  typeof row.session_id_hash === "string" && row.session_id_hash.length === 128);
  check("session: customer_id is null for anon row",  row.customer_id == null);

  // forSession looks up the same row by re-hashing the supplied id.
  var listed = await s.rv.forSession(sid);
  check("forSession: returns the anon row",           listed.length === 1 && listed[0].product_id === p.id);

  // A different session id MUST NOT find the row.
  var otherList = await s.rv.forSession(_newSessionId());
  check("forSession: other session can't see the row", otherList.length === 0);
}

async function _perSubjectCapTrims() {
  var s = await _makeStack({ perSubjectCap: 3 });
  var customer = _uuid();
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var p = await _seedProduct(s.catalog, { slug: "cap-" + i + "-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
    ids.push(p.id);
    // Spread last_viewed_at so the cap-trim deterministically removes the oldest.
    await s.rv.recordView({
      customer_id: customer,
      product_id:  p.id,
      occurred_at: Date.now() - (5 - i) * 1000,
    });
  }
  var rows = await s.rv.forCustomer(customer, { limit: 10 });
  check("perSubjectCap: count is capped",              rows.length === 3);
  // The cap keeps the 3 newest (ids[2], ids[3], ids[4]).
  var keptIds = rows.map(function (r) { return r.product_id; }).sort();
  var expectKept = [ids[2], ids[3], ids[4]].sort();
  check("perSubjectCap: kept newest",                  JSON.stringify(keptIds) === JSON.stringify(expectKept));
}

async function _forCustomerExcludePurchased() {
  var s = await _makeStack();
  var customer = _uuid();
  var v1 = await _seedProductWithVariant(s.catalog, { slug: "ep-1-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var v2 = await _seedProductWithVariant(s.catalog, { slug: "ep-2-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var v3 = await _seedProductWithVariant(s.catalog, { slug: "ep-3-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test

  // Spread views so the order is deterministic.
  await s.rv.recordView({ customer_id: customer, product_id: v1.product.id, occurred_at: Date.now() - 3000 });
  await s.rv.recordView({ customer_id: customer, product_id: v2.product.id, occurred_at: Date.now() - 2000 });
  await s.rv.recordView({ customer_id: customer, product_id: v3.product.id, occurred_at: Date.now() - 1000 });

  // Customer purchased v2.
  await _recordOrder(s.query, customer, v2.variant.id, v2.variant.sku);

  // Without the filter — all three appear, newest first.
  var all = await s.rv.forCustomer(customer);
  check("forCustomer: returns all rows newest-first", all.length === 3 && all[0].product_id === v3.product.id);

  // With the filter — purchased product (v2) is filtered out.
  var filtered = await s.rv.forCustomer(customer, { exclude_purchased: true });
  var filteredIds = filtered.map(function (r) { return r.product_id; }).sort();
  check("forCustomer: exclude_purchased drops bought product",
    filtered.length === 2 &&
    filteredIds.indexOf(v2.product.id) === -1 &&
    filteredIds.indexOf(v1.product.id) !== -1 &&
    filteredIds.indexOf(v3.product.id) !== -1);
}

async function _mergeSessionIntoCustomer() {
  var s = await _makeStack();
  var customer = _uuid();
  var sid = _newSessionId();
  var pA = await _seedProduct(s.catalog, { slug: "merge-a-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var pB = await _seedProduct(s.catalog, { slug: "merge-b-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var pC = await _seedProduct(s.catalog, { slug: "merge-c-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test

  // Pre-login: session viewed A and B.
  await s.rv.recordView({ session_id: sid, product_id: pA.id, occurred_at: Date.now() - 5000 });
  await s.rv.recordView({ session_id: sid, product_id: pB.id, occurred_at: Date.now() - 4000 });
  // Customer already had A and C from a prior authed session.
  await s.rv.recordView({ customer_id: customer, product_id: pA.id, occurred_at: Date.now() - 60 * 60 * 1000 });
  await s.rv.recordView({ customer_id: customer, product_id: pC.id, occurred_at: Date.now() - 3000 });

  var result = await s.rv.merge({ session_id: sid, customer_id: customer });
  check("merge: returns merged + claimed counts",
    result.merged === 1 && result.claimed === 1);

  // Customer's history now spans A, B, C — three products.
  var afterCustomer = await s.rv.forCustomer(customer, { limit: 10 });
  var customerIds = afterCustomer.map(function (r) { return r.product_id; }).sort();
  var expectIds   = [pA.id, pB.id, pC.id].sort();
  check("merge: customer history spans both sources",  JSON.stringify(customerIds) === JSON.stringify(expectIds));

  // No session rows remain.
  var afterSession = await s.rv.forSession(sid);
  check("merge: session rows fully consumed",          afterSession.length === 0);

  // The A row's view_count is the sum (1 from session + 1 from customer = 2).
  var aRow = afterCustomer.filter(function (r) { return r.product_id === pA.id; })[0];
  check("merge: collision row view_count summed",      Number(aRow.view_count) === 2);
}

async function _recommendCoViewSignal() {
  var s = await _makeStack();
  var seed = _uuid();
  var other1 = _uuid();
  var other2 = _uuid();
  var bought = await _seedProductWithVariant(s.catalog, { slug: "rec-bought-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var shared = await _seedProduct(s.catalog,            { slug: "rec-shared-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var rec1   = await _seedProduct(s.catalog,            { slug: "rec-1-"      + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var rec2   = await _seedProduct(s.catalog,            { slug: "rec-2-"      + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test

  // Seed customer viewed `shared` and `bought`.
  await s.rv.recordView({ customer_id: seed, product_id: shared.id });
  await s.rv.recordView({ customer_id: seed, product_id: bought.product.id });

  // Other customers also viewed `shared` AND their own picks — those
  // picks become recommend candidates.
  await s.rv.recordView({ customer_id: other1, product_id: shared.id });
  await s.rv.recordView({ customer_id: other1, product_id: rec1.id });
  await s.rv.recordView({ customer_id: other1, product_id: rec2.id });
  await s.rv.recordView({ customer_id: other2, product_id: shared.id });
  await s.rv.recordView({ customer_id: other2, product_id: rec1.id });        // rec1 gets two co-view votes

  // Seed customer purchased `bought` — must be excluded from recs.
  await _recordOrder(s.query, seed, bought.variant.id, bought.variant.sku);

  var recs = await s.rv.recommend(seed, { limit: 5 });
  var recIds = recs.map(function (r) { return r.product_id; });
  check("recommend: returns sorted candidates",       recs.length === 2);
  check("recommend: rec1 ranks first (two co-views)", recIds[0] === rec1.id && recIds[1] === rec2.id);
  check("recommend: rec1 score > rec2 score",         recs[0].score >= recs[1].score);
  check("recommend: seed-viewed excluded",            recIds.indexOf(shared.id) === -1);
  check("recommend: purchased excluded",              recIds.indexOf(bought.product.id) === -1);

  // Customer with no history → empty result.
  var emptySeed = _uuid();
  var empty = await s.rv.recommend(emptySeed);
  check("recommend: empty seed history returns []",   Array.isArray(empty) && empty.length === 0);
}

async function _cleanupOlderThan() {
  var s = await _makeStack();
  var customer = _uuid();
  var pFresh = await _seedProduct(s.catalog, { slug: "fresh-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var pOld   = await _seedProduct(s.catalog, { slug: "old-"   + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test

  await s.rv.recordView({ customer_id: customer, product_id: pFresh.id });
  await s.rv.recordView({ customer_id: customer, product_id: pOld.id });

  // Backdate pOld by 100 days.
  var oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000;
  await s.query(
    "UPDATE recently_viewed SET last_viewed_at = ?1, viewed_at = ?1 WHERE product_id = ?2",
    [oldTs, pOld.id],
  );

  var result = await s.rv.cleanupOlderThan(90);
  check("cleanupOlderThan: removes old row",          result.removed === 1);

  var remaining = await s.rv.forCustomer(customer);
  check("cleanupOlderThan: fresh row survives",        remaining.length === 1 && remaining[0].product_id === pFresh.id);

  await assert.rejects(s.rv.cleanupOlderThan(-1),   /days/);
  await assert.rejects(s.rv.cleanupOlderThan(1.5),  /days/);
  await assert.rejects(s.rv.cleanupOlderThan("7"),  /days/);
}

async function _purgeCustomer() {
  var s = await _makeStack();
  var customer = _uuid();
  var bystander = _uuid();
  var p1 = await _seedProduct(s.catalog, { slug: "purge-1-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test
  var p2 = await _seedProduct(s.catalog, { slug: "purge-2-" + Math.random().toString(36).slice(2, 6) });        // allow:math-random — unique slug per test

  await s.rv.recordView({ customer_id: customer, product_id: p1.id });
  await s.rv.recordView({ customer_id: customer, product_id: p2.id });
  await s.rv.recordView({ customer_id: bystander, product_id: p1.id });

  var result = await s.rv.purgeCustomer(customer);
  check("purgeCustomer: returns removed count",       result.removed === 2);

  var ours = await s.rv.forCustomer(customer);
  check("purgeCustomer: own rows gone",                ours.length === 0);

  var theirs = await s.rv.forCustomer(bystander);
  check("purgeCustomer: bystander untouched",          theirs.length === 1);

  await assert.rejects(s.rv.purgeCustomer("not-a-uuid"), /customer_id/);
}

async function _factoryRefusals() {
  var query = _makeQuery();
  var threw = false;
  try { recentlyViewed.create({ query: query }); } catch (e) { threw = /catalog/.test(e.message); }
  check("create: refuses without catalog",            threw === true);

  var catalog = bShop.catalog.create({ query: query });
  var bad = false;
  try { recentlyViewed.create({ query: query, catalog: catalog, perSubjectCap: 0 }); } catch (e) { bad = /perSubjectCap/.test(e.message); }
  check("create: refuses perSubjectCap <= 0",         bad === true);

  var bad2 = false;
  try { recentlyViewed.create({ query: query, catalog: catalog, recommendFanout: 0 }); } catch (e) { bad2 = /recommendFanout/.test(e.message); }
  check("create: refuses recommendFanout <= 0",       bad2 === true);

  // Smoke: factory accepts a valid config.
  var rv = recentlyViewed.create({ query: query, catalog: catalog });
  check("create: returns surface",                    typeof rv.recordView === "function" && typeof rv.recommend === "function");
}

async function run() {
  await _recordInsertAndDedup();
  await _recordResetsCountOutsideDedupWindow();
  await _recordRefusesWithoutSubject();
  await _sessionIdNamespaceHashed();
  await _perSubjectCapTrims();
  await _forCustomerExcludePurchased();
  await _mergeSessionIntoCustomer();
  await _recommendCoViewSignal();
  await _cleanupOlderThan();
  await _purgeCustomer();
  await _factoryRefusals();
}

if (require.main === module) {
  run().then(function () {
    console.log("recently-viewed: OK (" + helpers.getChecks() + " checks)");
  }).catch(function (e) {
    console.error(e && e.stack || e);
    process.exit(1);
  });
}

module.exports = { run: run };
