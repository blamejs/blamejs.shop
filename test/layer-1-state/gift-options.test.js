"use strict";
/**
 * giftOptions — per-order wrap / message / recipient / hide-prices
 * attached to an order at checkout.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog) + 0002 (cart) + 0003 (order) + 0046 (gift options).
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/gift-options.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - create-time refusals (missing catalog)
 *   - defineWrap refusals (bad fee, bad image URL, unknown SKU)
 *   - defineWrap + listWraps active_only filter
 *   - setForOrder validation: message length cap, control bytes,
 *     zero-width chars, recipient length cap, unknown wrap_sku,
 *     archived wrap_sku
 *   - setForOrder UPSERT idempotency (re-run replaces every field)
 *   - feeForOrder math: with wrap, without wrap, no row
 *   - renderPackingSlipLine HTML-escapes hostile message + name
 *   - archiveWrap removes from active list but getForOrder for a
 *     prior order still resolves
 *   - clearForOrder removes the row
 *   - analytics: orders_with_gift, top_wrap_skus, gift_message_rate
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var giftOptions = require("../../lib/gift-options");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0046_gift_options.sql",
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

// Seed a minimal cart + order row so the FK from gift_options ->
// orders has a target. Mirrors the order-notes test's seed helper.
async function _seedOrder(query, opts) {
  opts = opts || {};
  var ts = Date.now();
  var cartId = _validUUID();
  await query(
    "INSERT INTO carts (id, session_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, 'USD', 'active', ?3, ?3, ?4)",
    [cartId, _validUUID(), ts, ts + 86400000],
  );
  var orderId = opts.id || _validUUID();
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'pending', 'USD', 0, 0, 0, 0, 0, '{\"country\":\"US\"}', ?5, ?5)",
    [orderId, cartId, opts.customer_id || null, _validUUID(), ts],
  );
  return orderId;
}

// Seed a product + variant so the gift_wraps.wrap_sku FK to
// variants(sku) resolves. Returns the sku for the test to pass to
// defineWrap.
async function _seedWrapVariant(catalog, opts) {
  opts = opts || {};
  var p = await catalog.products.create({
    slug:   opts.slug   || ("wrap-" + Math.random().toString(36).slice(2, 10)),        // allow:math-random — unique slug per test
    title:  opts.title  || "Gift wrap",
    status: "active",
  });
  var sku = opts.sku || ("WRAP-" + Math.random().toString(36).slice(2, 8).toUpperCase());        // allow:math-random — unique sku per test
  var v = await catalog.variants.create(p.id, { sku: sku });
  return v.sku;
}

async function _setup() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var gifts   = giftOptions.create({ query: query, catalog: catalog });
  return { query: query, catalog: catalog, gifts: gifts };
}

// ---- tests --------------------------------------------------------------

async function _createRefusesWithoutCatalog() {
  var query = _makeQuery();
  var threw = false;
  try {
    giftOptions.create({ query: query });
  } catch (e) {
    threw = /catalog/.test(e.message);
  }
  check("create: refuses without catalog", threw === true);
}

async function _defineWrapRefusals() {
  var ctx = await _setup();
  var sku = await _seedWrapVariant(ctx.catalog);

  // defineWrap entry-point shape
  await assert.rejects(ctx.gifts.defineWrap(),                                                     /input object required/);
  await assert.rejects(ctx.gifts.defineWrap({}),                                                   /wrap_sku/);
  await assert.rejects(ctx.gifts.defineWrap({ wrap_sku: "bad sku with spaces" }),                  /wrap_sku/);
  await assert.rejects(ctx.gifts.defineWrap({ wrap_sku: sku }),                                    /title/);
  await assert.rejects(ctx.gifts.defineWrap({ wrap_sku: sku, title: "" }),                         /title/);
  await assert.rejects(ctx.gifts.defineWrap({ wrap_sku: sku, title: "Wrap" }),                     /fee_minor/);
  await assert.rejects(ctx.gifts.defineWrap({ wrap_sku: sku, title: "Wrap", fee_minor: -1 }),      /fee_minor/);
  await assert.rejects(ctx.gifts.defineWrap({ wrap_sku: sku, title: "Wrap", fee_minor: 1.5 }),     /fee_minor/);
  // bad image URL — javascript: scheme is rejected
  await assert.rejects(ctx.gifts.defineWrap({
    wrap_sku: sku, title: "Wrap", fee_minor: 500, image_url: "javascript:alert(1)", active: true,
  }), /image_url/);
  // bad max_per_order
  await assert.rejects(ctx.gifts.defineWrap({
    wrap_sku: sku, title: "Wrap", fee_minor: 500, max_per_order: 0, active: true,
  }), /max_per_order/);
  // missing active
  await assert.rejects(ctx.gifts.defineWrap({
    wrap_sku: sku, title: "Wrap", fee_minor: 500,
  }), /active/);

  // unknown SKU — refuses
  await assert.rejects(ctx.gifts.defineWrap({
    wrap_sku: "UNKNOWN-SKU-XYZ", title: "Wrap", fee_minor: 500, active: true,
  }), /not a known catalog variant/);
}

async function _defineWrapHappyAndList() {
  var ctx = await _setup();
  var skuA = await _seedWrapVariant(ctx.catalog);
  var skuB = await _seedWrapVariant(ctx.catalog);
  var skuC = await _seedWrapVariant(ctx.catalog);

  var wrapA = await ctx.gifts.defineWrap({
    wrap_sku: skuA, title: "Premium silver wrap", fee_minor: 599,
    image_url: "https://cdn.example.com/wrap-silver.png",
    max_per_order: 5, active: true,
  });
  check("defineWrap: returns wrap_sku",   wrapA.wrap_sku === skuA);
  check("defineWrap: fee preserved",      wrapA.fee_minor === 599);
  check("defineWrap: max_per_order",      wrapA.max_per_order === 5);
  check("defineWrap: active true",        wrapA.active === true);
  check("defineWrap: archived_at null",   wrapA.archived_at === null);

  await ctx.gifts.defineWrap({
    wrap_sku: skuB, title: "Eco kraft wrap", fee_minor: 299, active: true,
  });
  // Inactive one — won't show up with active_only=true.
  await ctx.gifts.defineWrap({
    wrap_sku: skuC, title: "Discontinued wrap", fee_minor: 199, active: false,
  });

  var all = await ctx.gifts.listWraps();
  check("listWraps: returns all defined wraps", all.length === 3);

  var activeOnly = await ctx.gifts.listWraps({ active_only: true });
  check("listWraps active_only: filters inactive", activeOnly.length === 2);
  check("listWraps active_only: excludes inactive sku",
    activeOnly.every(function (w) { return w.wrap_sku !== skuC; }));

  // getWrap roundtrip
  var fetched = await ctx.gifts.getWrap(skuA);
  check("getWrap: roundtrip title", fetched.title === "Premium silver wrap");

  // unknown getWrap returns null
  var missing = await ctx.gifts.getWrap("NOT-DEFINED-WRAP-SKU");
  check("getWrap: unknown wrap_sku returns null", missing === null);

  // updateWrap happy
  var bumped = await ctx.gifts.updateWrap(skuB, { fee_minor: 399, title: "Eco kraft wrap (refreshed)" });
  check("updateWrap: fee bumped",  bumped.fee_minor === 399);
  check("updateWrap: title bumped", bumped.title === "Eco kraft wrap (refreshed)");

  // updateWrap refusals
  await assert.rejects(ctx.gifts.updateWrap(skuB, {}),                            /at least one column/);
  await assert.rejects(ctx.gifts.updateWrap(skuB, { wrap_sku: "OTHER" }),          /unsupported column/);
  await assert.rejects(ctx.gifts.updateWrap("MISSING-WRAP-SKU", { fee_minor: 1 }), /not found/);
}

async function _setForOrderRefusals() {
  var ctx = await _setup();
  var sku = await _seedWrapVariant(ctx.catalog);
  var orderId = await _seedOrder(ctx.query);
  var validId = _validUUID();

  await ctx.gifts.defineWrap({ wrap_sku: sku, title: "Wrap", fee_minor: 500, active: true });

  // shape
  await assert.rejects(ctx.gifts.setForOrder(),                                    /input object required/);
  await assert.rejects(ctx.gifts.setForOrder({}),                                  /order_id/);
  await assert.rejects(ctx.gifts.setForOrder({ order_id: "not-a-uuid" }),          /order_id/);

  // message length
  var bigMsg = new Array(502).join("a");        // 501 chars
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, gift_message: bigMsg }),
    /gift_message/,
  );

  // control bytes
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, gift_message: "happy\x00birthday" }),
    /gift_message/,
  );

  // zero-width chars (U+200B ZWSP)
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, gift_message: "happy​birthday" }),
    /gift_message/,
  );

  // non-string message
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, gift_message: 42 }),
    /gift_message/,
  );

  // recipient_name length
  var bigName = new Array(122).join("n");      // 121 chars
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, recipient_name: bigName }),
    /recipient_name/,
  );

  // recipient_name newline (refused — recipient_name is a single line)
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, recipient_name: "Alice\nB" }),
    /recipient_name/,
  );

  // unknown wrap_sku
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, wrap_sku: "UNKNOWN-WRAP-SKU" }),
    /not a defined wrap/,
  );

  // archived wrap_sku — define + archive then try to attach
  await ctx.gifts.archiveWrap(sku);
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, wrap_sku: sku }),
    /archived/,
  );

  // bad hide_prices type
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, hide_prices: "yes" }),
    /hide_prices/,
  );

  // bad wrap_sku shape
  await assert.rejects(
    ctx.gifts.setForOrder({ order_id: orderId, wrap_sku: "bad sku" }),
    /wrap_sku/,
  );

  // getForOrder rejects bad uuid
  await assert.rejects(ctx.gifts.getForOrder("not-a-uuid"),    /order_id/);
  await assert.rejects(ctx.gifts.clearForOrder("not-a-uuid"),  /order_id/);
  await assert.rejects(ctx.gifts.feeForOrder("not-a-uuid"),    /order_id/);

  // unused vars to keep eslint quiet
  void validId;
}

async function _setForOrderUpsertIdempotent() {
  var ctx = await _setup();
  var sku1 = await _seedWrapVariant(ctx.catalog);
  var sku2 = await _seedWrapVariant(ctx.catalog);
  var orderId = await _seedOrder(ctx.query);

  await ctx.gifts.defineWrap({ wrap_sku: sku1, title: "Silver", fee_minor: 599, active: true });
  await ctx.gifts.defineWrap({ wrap_sku: sku2, title: "Gold",   fee_minor: 899, active: true });

  var first = await ctx.gifts.setForOrder({
    order_id:       orderId,
    wrap_sku:       sku1,
    gift_message:   "Happy birthday\nLove, Alex",
    recipient_name: "Jordan",
    hide_prices:    true,
  });
  check("setForOrder: first call wrap_sku",       first.wrap_sku === sku1);
  check("setForOrder: gift_message persisted",    first.gift_message === "Happy birthday\nLove, Alex");
  check("setForOrder: recipient_name persisted",  first.recipient_name === "Jordan");
  check("setForOrder: hide_prices true",          first.hide_prices === true);

  // Second call — every field replaced (NOT merged).
  var second = await ctx.gifts.setForOrder({
    order_id:       orderId,
    wrap_sku:       sku2,
    gift_message:   null,
    recipient_name: null,
    hide_prices:    false,
  });
  check("setForOrder UPSERT: wrap_sku replaced",       second.wrap_sku === sku2);
  check("setForOrder UPSERT: gift_message cleared",    second.gift_message === null);
  check("setForOrder UPSERT: recipient_name cleared",  second.recipient_name === null);
  check("setForOrder UPSERT: hide_prices flipped",     second.hide_prices === false);
  check("setForOrder UPSERT: set_at preserved",        second.set_at === first.set_at);
  check("setForOrder UPSERT: updated_at moves forward", second.updated_at >= first.updated_at);

  // Still only one row.
  var count = (await ctx.query("SELECT COUNT(*) AS n FROM gift_options WHERE order_id = ?1", [orderId])).rows[0];
  check("setForOrder UPSERT: still single row per order", Number(count.n) === 1);

  // getForOrder roundtrips.
  var fetched = await ctx.gifts.getForOrder(orderId);
  check("getForOrder: roundtrip wrap_sku", fetched.wrap_sku === sku2);

  // clearForOrder removes the row.
  var cleared = await ctx.gifts.clearForOrder(orderId);
  check("clearForOrder: returns cleared true", cleared.cleared === true);
  var afterClear = await ctx.gifts.getForOrder(orderId);
  check("clearForOrder: row gone",             afterClear === null);

  // clearForOrder no-op on already-cleared order.
  var cleared2 = await ctx.gifts.clearForOrder(orderId);
  check("clearForOrder: no-op returns cleared false", cleared2.cleared === false);
}

async function _feeForOrderMath() {
  var ctx = await _setup();
  var skuA = await _seedWrapVariant(ctx.catalog);
  var orderWithWrap     = await _seedOrder(ctx.query);
  var orderWithoutWrap  = await _seedOrder(ctx.query);
  var orderNoOptions    = await _seedOrder(ctx.query);

  await ctx.gifts.defineWrap({ wrap_sku: skuA, title: "Premium", fee_minor: 750, active: true });

  // Order with a wrap.
  await ctx.gifts.setForOrder({ order_id: orderWithWrap, wrap_sku: skuA });
  var fee1 = await ctx.gifts.feeForOrder(orderWithWrap);
  check("feeForOrder: wrap fee returned", fee1 === 750);

  // Order with options but no wrap.
  await ctx.gifts.setForOrder({ order_id: orderWithoutWrap, gift_message: "no wrap, just a note" });
  var fee2 = await ctx.gifts.feeForOrder(orderWithoutWrap);
  check("feeForOrder: no wrap returns 0", fee2 === 0);

  // Order with no gift_options row at all.
  var fee3 = await ctx.gifts.feeForOrder(orderNoOptions);
  check("feeForOrder: no row returns 0", fee3 === 0);
}

async function _renderPackingSlipLineEscapes() {
  var ctx = await _setup();
  var orderId = await _seedOrder(ctx.query);

  var hostileMessage = "<script>alert('xss')</script>\nLine two & <b>bold</b>\nLine three";
  var hostileName    = "<img src=x onerror=alert(1)>";

  await ctx.gifts.setForOrder({
    order_id:       orderId,
    gift_message:   hostileMessage,
    recipient_name: hostileName,
    hide_prices:    true,
  });

  var rendered = await ctx.gifts.renderPackingSlipLine({ order_id: orderId, locale: "en-US" });

  check("renderPackingSlipLine: locale echoed",       rendered.locale === "en-US");
  check("renderPackingSlipLine: hide_prices true",    rendered.hide_prices === true);

  // Message lines are split on LF and HTML-escaped.
  check("renderPackingSlipLine: message split into 3 lines", rendered.message_lines.length === 3);
  check("renderPackingSlipLine: <script> escaped",
    rendered.message_lines[0].indexOf("<script>") === -1 &&
    rendered.message_lines[0].indexOf("&lt;script&gt;") !== -1);
  check("renderPackingSlipLine: ampersand escaped",
    rendered.message_lines[1].indexOf("&amp;") !== -1 &&
    rendered.message_lines[1].indexOf(" & ") === -1);
  check("renderPackingSlipLine: <b> tag escaped",
    rendered.message_lines[1].indexOf("<b>") === -1 &&
    rendered.message_lines[1].indexOf("&lt;b&gt;") !== -1);
  check("renderPackingSlipLine: third line preserved",
    rendered.message_lines[2] === "Line three");

  // Recipient name is HTML-escaped.
  check("renderPackingSlipLine: recipient escaped",
    rendered.recipient_name.indexOf("<img") === -1 &&
    rendered.recipient_name.indexOf("&lt;img") !== -1);

  // No gift_options row -> empty render.
  var blankOrder = await _seedOrder(ctx.query);
  var blankRender = await ctx.gifts.renderPackingSlipLine({ order_id: blankOrder, locale: "en-US" });
  check("renderPackingSlipLine: no row -> empty message_lines", blankRender.message_lines.length === 0);
  check("renderPackingSlipLine: no row -> null recipient",       blankRender.recipient_name === null);
  check("renderPackingSlipLine: no row -> hide_prices false",    blankRender.hide_prices === false);

  // Refusals: missing input, bad order_id, bad locale.
  await assert.rejects(ctx.gifts.renderPackingSlipLine(),                                /input object required/);
  await assert.rejects(ctx.gifts.renderPackingSlipLine({ order_id: orderId }),            /locale/);
  await assert.rejects(ctx.gifts.renderPackingSlipLine({ order_id: orderId, locale: "" }),/locale/);
  await assert.rejects(ctx.gifts.renderPackingSlipLine({ order_id: orderId, locale: 42 }),/locale/);
}

async function _archiveWrapPreservesHistory() {
  var ctx = await _setup();
  var sku = await _seedWrapVariant(ctx.catalog);
  var priorOrder = await _seedOrder(ctx.query);

  await ctx.gifts.defineWrap({ wrap_sku: sku, title: "Limited edition", fee_minor: 1299, active: true });
  await ctx.gifts.setForOrder({ order_id: priorOrder, wrap_sku: sku });

  // Confirm it's in the active list pre-archive.
  var active = await ctx.gifts.listWraps({ active_only: true });
  check("pre-archive: wrap in active list", active.some(function (w) { return w.wrap_sku === sku; }));

  // Archive.
  var archived = await ctx.gifts.archiveWrap(sku);
  check("archiveWrap: returns archived row with archived_at",
    archived.active === false && typeof archived.archived_at === "number");

  // Active list no longer includes it.
  var afterActive = await ctx.gifts.listWraps({ active_only: true });
  check("archiveWrap: removed from active list",
    afterActive.every(function (w) { return w.wrap_sku !== sku; }));

  // Full list still shows it.
  var afterAll = await ctx.gifts.listWraps();
  check("archiveWrap: still present in full list",
    afterAll.some(function (w) { return w.wrap_sku === sku; }));

  // The prior order's gift_options row + getForOrder + feeForOrder
  // still resolves — archiving doesn't break historical lookups.
  var historical = await ctx.gifts.getForOrder(priorOrder);
  check("archiveWrap: prior order getForOrder still resolves wrap_sku",
    historical != null && historical.wrap_sku === sku);
  var historicalFee = await ctx.gifts.feeForOrder(priorOrder);
  check("archiveWrap: prior order feeForOrder still returns fee", historicalFee === 1299);

  // Archiving a missing wrap throws.
  await assert.rejects(ctx.gifts.archiveWrap("NOT-A-WRAP-SKU"), /not found/);
}

async function _analyticsRollup() {
  var ctx = await _setup();
  var skuA = await _seedWrapVariant(ctx.catalog);
  var skuB = await _seedWrapVariant(ctx.catalog);

  await ctx.gifts.defineWrap({ wrap_sku: skuA, title: "Silver", fee_minor: 500, active: true });
  await ctx.gifts.defineWrap({ wrap_sku: skuB, title: "Gold",   fee_minor: 900, active: true });

  // Three orders — two with wraps (skuA twice, skuB once), one with
  // only a gift message, and a noise order with no options at all.
  var o1 = await _seedOrder(ctx.query);
  var o2 = await _seedOrder(ctx.query);
  var o3 = await _seedOrder(ctx.query);
  var o4 = await _seedOrder(ctx.query);
  await _seedOrder(ctx.query);    // noise — never gets a gift_options row

  await ctx.gifts.setForOrder({ order_id: o1, wrap_sku: skuA, gift_message: "Happy holidays!" });
  await ctx.gifts.setForOrder({ order_id: o2, wrap_sku: skuA });
  await ctx.gifts.setForOrder({ order_id: o3, wrap_sku: skuB, gift_message: "For my favorite person" });
  await ctx.gifts.setForOrder({ order_id: o4, recipient_name: "Sam" });

  var now = Date.now();
  var report = await ctx.gifts.analytics({ from: now - 60000, to: now + 60000 });

  check("analytics: 4 orders with gift options",       report.orders_with_gift === 4);
  check("analytics: top wrap_sku is skuA with count 2",
    report.top_wrap_skus.length >= 2 &&
    report.top_wrap_skus[0].wrap_sku === skuA &&
    report.top_wrap_skus[0].count === 2);
  check("analytics: skuB appears with count 1",
    report.top_wrap_skus.some(function (r) { return r.wrap_sku === skuB && r.count === 1; }));
  check("analytics: gift_message_count is 2",          report.gift_message_count === 2);
  check("analytics: gift_message_rate is 0.5",         report.gift_message_rate === 0.5);

  // Refusal — to < from.
  await assert.rejects(ctx.gifts.analytics({ from: now, to: now - 1 }),  /to/);
  await assert.rejects(ctx.gifts.analytics({ from: -1, to: now }),       /from/);
  await assert.rejects(ctx.gifts.analytics(),                            /input object required/);
}

async function run() {
  await _createRefusesWithoutCatalog();
  await _defineWrapRefusals();
  await _defineWrapHappyAndList();
  await _setForOrderRefusals();
  await _setForOrderUpsertIdempotent();
  await _feeForOrderMath();
  await _renderPackingSlipLineEscapes();
  await _archiveWrapPreservesHistory();
  await _analyticsRollup();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("gift-options.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("gift-options.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
