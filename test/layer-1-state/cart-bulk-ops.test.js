"use strict";
/**
 * cart-bulk-ops — B2B-style bulk cart operations. Layer 1 against
 * an in-memory node:sqlite database loaded with the live D1
 * migrations for catalog (0001), cart (0002), order (0003), and
 * the price-list overlay (0078).
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/cart-bulk-ops.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - addLines happy path resolves SKUs + snapshots prices
 *   - addLines atomicity: one bad SKU in the batch refuses the whole
 *     batch; no lines are written
 *   - addLines collapses duplicate SKUs in the input batch
 *   - replaceLines overwrites the cart's line set atomically
 *   - clearLines empties the cart
 *   - priceListApply rewrites unit_amount_minor from the overlay
 *     and leaves non-overlay SKUs untouched
 *   - priceListApply refuses on currency mismatch / archived list
 *   - priceListApply resolves the slug from a customer assignment
 *   - reorder clones an order's lines into a cart and skips SKUs
 *     whose variant is archived / missing
 *   - splitCart fans the cart into N child carts by vendor and
 *     marks the source cart abandoned
 *   - quoteForCart returns lines + totals without mutating
 *   - input refusals: bad cart_id / oversize batch / unknown
 *     price-list slug
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var cartBulkOps  = require("../../lib/cart-bulk-ops");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

void bShop;   // touch the entry point so the require cycle is exercised

var MIG_CATALOG     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART        = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");
var MIG_ORDER       = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0003_order.sql");
var MIG_PRICE_LISTS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0078_price_lists.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_CART, MIG_ORDER, MIG_PRICE_LISTS].forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
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

// Vendor encoded in the variant SKU prefix (everything up to the
// first hyphen) for the splitCart test. Real operators wire a real
// lookup; the SKU prefix is the simplest grouping for a fixture.
function _vendorGrouper(line, splitBy) {
  if (splitBy === "vendor") {
    var dash = line.sku.indexOf("-");
    return dash > 0 ? line.sku.slice(0, dash) : line.sku;
  }
  return "all";
}

function _newSessionId() {
  return "sess_" + _hex(24);
}
function _hex(n) {
  // Deterministic-shape helper for the cart session_id format.
  // Uses uuid.v7 (already required throughout this codebase) so the
  // test never reaches for Math.random.
  var raw = bShop.framework.uuid.v7().replace(/-/g, "");
  return raw.slice(0, n);
}

async function _seedCatalog(catalog) {
  // Two products from two "vendors" (encoded in the SKU prefix).
  var p1 = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro",   status: "active" });
  var p2 = await catalog.products.create({ slug: "gadget-max", title: "Gadget Max",   status: "active" });
  var v1 = await catalog.variants.create(p1.id, { sku: "ACME-WDG-001" });
  var v2 = await catalog.variants.create(p1.id, { sku: "ACME-WDG-002" });
  var v3 = await catalog.variants.create(p2.id, { sku: "BETA-GDG-001" });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2999 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 4999 });
  await catalog.prices.set(v3.id, { currency: "USD", amount_minor: 1999 });
  return { v1: v1, v2: v2, v3: v3 };
}

function _setup() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var bulk    = cartBulkOps.create({
    query:       query,
    cart:        cart,
    catalog:     catalog,
    lineGrouper: _vendorGrouper,
  });
  return { query: query, catalog: catalog, cart: cart, bulk: bulk };
}

async function _addLinesHappyAndAtomic() {
  var ctx = _setup();
  var v = await _seedCatalog(ctx.catalog);
  var c = await ctx.cart.create(_newSessionId(), { currency: "USD" });

  // Happy path — three valid SKUs.
  var r = await ctx.bulk.addLines({
    cart_id: c.id,
    lines: [
      { sku: v.v1.sku, qty: 2 },
      { sku: v.v2.sku, qty: 1 },
      { sku: v.v3.sku, qty: 4 },
    ],
  });
  check("addLines: returns written count",       r.written === 3);
  var lines = await ctx.cart.listLines(c.id);
  check("addLines: all 3 lines persisted",        lines.length === 3);
  // Price snapshots came from catalog.prices.current.
  var bySku = {};
  lines.forEach(function (l) { bySku[l.sku] = l; });
  check("addLines: ACME-WDG-001 snapshot",        bySku[v.v1.sku].unit_amount_minor === 2999);
  check("addLines: ACME-WDG-001 qty",             bySku[v.v1.sku].qty === 2);
  check("addLines: BETA-GDG-001 snapshot",        bySku[v.v3.sku].unit_amount_minor === 1999);

  // Atomicity: one bad SKU rolls back the whole batch.
  var c2 = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await assert.rejects(
    ctx.bulk.addLines({
      cart_id: c2.id,
      lines: [
        { sku: v.v1.sku,         qty: 1 },
        { sku: "NOT-A-REAL-SKU", qty: 1 },
        { sku: v.v2.sku,         qty: 1 },
      ],
    }),
    /lines\[1\]\.sku — variant 'NOT-A-REAL-SKU' not found/,
  );
  var afterFail = await ctx.cart.listLines(c2.id);
  check("addLines: atomicity — zero lines written when any row fails", afterFail.length === 0);

  // Duplicate SKUs in the same batch collapse by summing qty.
  var c3 = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  var r3 = await ctx.bulk.addLines({
    cart_id: c3.id,
    lines: [
      { sku: v.v1.sku, qty: 2 },
      { sku: v.v1.sku, qty: 3 },
      { sku: v.v2.sku, qty: 1 },
    ],
  });
  check("addLines: duplicate-SKU batch collapses to 2 lines", r3.written === 2);
  var c3Lines = await ctx.cart.listLines(c3.id);
  var c3BySku = {};
  c3Lines.forEach(function (l) { c3BySku[l.sku] = l; });
  check("addLines: duplicate SKUs sum to qty=5", c3BySku[v.v1.sku].qty === 5);

  // Bad cart_id refused.
  await assert.rejects(
    ctx.bulk.addLines({ cart_id: "not-a-uuid", lines: [{ sku: v.v1.sku, qty: 1 }] }),
    /cart_id/,
  );

  // Oversize batch refused.
  var oversize = [];
  for (var i = 0; i < cartBulkOps.MAX_BULK + 1; i += 1) {
    oversize.push({ sku: v.v1.sku, qty: 1 });
  }
  var c4 = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await assert.rejects(
    ctx.bulk.addLines({ cart_id: c4.id, lines: oversize }),
    /≤ 500 rows per call/,
  );
}

async function _replaceLines() {
  var ctx = _setup();
  var v = await _seedCatalog(ctx.catalog);
  var c = await ctx.cart.create(_newSessionId(), { currency: "USD" });

  await ctx.bulk.addLines({
    cart_id: c.id,
    lines: [{ sku: v.v1.sku, qty: 2 }, { sku: v.v2.sku, qty: 3 }],
  });

  // Replace overwrites — the v1+v2 set goes away, v3 takes their place.
  var r = await ctx.bulk.replaceLines({
    cart_id: c.id,
    lines: [{ sku: v.v3.sku, qty: 7 }],
  });
  check("replaceLines: returns written count",   r.written === 1);
  var lines = await ctx.cart.listLines(c.id);
  check("replaceLines: only the new line remains", lines.length === 1 && lines[0].sku === v.v3.sku);
  check("replaceLines: qty preserved",             lines[0].qty === 7);

  // Atomicity: bad SKU in the replacement set keeps the old lines.
  await ctx.bulk.replaceLines({
    cart_id: c.id,
    lines: [{ sku: v.v1.sku, qty: 1 }, { sku: v.v2.sku, qty: 1 }],
  });
  await assert.rejects(
    ctx.bulk.replaceLines({
      cart_id: c.id,
      lines: [{ sku: v.v3.sku, qty: 1 }, { sku: "BAD-SKU", qty: 1 }],
    }),
    /lines\[1\]\.sku/,
  );
  var stillTwo = await ctx.cart.listLines(c.id);
  check("replaceLines: atomicity — old lines survive a failed replacement",
    stillTwo.length === 2);
}

async function _clearLines() {
  var ctx = _setup();
  var v = await _seedCatalog(ctx.catalog);
  var c = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await ctx.bulk.addLines({
    cart_id: c.id,
    lines: [{ sku: v.v1.sku, qty: 1 }, { sku: v.v2.sku, qty: 1 }],
  });
  var r = await ctx.bulk.clearLines({ cart_id: c.id });
  check("clearLines: removes both lines", r.removed === 2);
  var after = await ctx.cart.listLines(c.id);
  check("clearLines: cart is empty afterwards", after.length === 0);
}

async function _priceListApplyOverride() {
  var ctx = _setup();
  var v = await _seedCatalog(ctx.catalog);
  var c = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await ctx.bulk.addLines({
    cart_id: c.id,
    lines: [
      { sku: v.v1.sku, qty: 2 },
      { sku: v.v2.sku, qty: 1 },
      { sku: v.v3.sku, qty: 3 },
    ],
  });

  // Stand up a wholesale list that overrides v1 + v3 (but not v2).
  await ctx.bulk.priceLists.create({
    slug:     "acme-wholesale",
    title:    "Acme Wholesale 2026",
    currency: "USD",
  });
  await ctx.bulk.priceLists.setMember({
    price_list_slug:     "acme-wholesale",
    sku:                 v.v1.sku,
    override_unit_minor: 1999,
  });
  await ctx.bulk.priceLists.setMember({
    price_list_slug:     "acme-wholesale",
    sku:                 v.v3.sku,
    override_unit_minor: 1499,
  });

  var r = await ctx.bulk.priceListApply({
    cart_id:         c.id,
    price_list_slug: "acme-wholesale",
  });
  check("priceListApply: 2 lines overridden",     r.overridden === 2);
  check("priceListApply: 1 line skipped",         r.skipped === 1);

  var lines = await ctx.cart.listLines(c.id);
  var bySku = {};
  lines.forEach(function (l) { bySku[l.sku] = l; });
  check("priceListApply: v1 unit rewritten",      bySku[v.v1.sku].unit_amount_minor === 1999);
  check("priceListApply: v3 unit rewritten",      bySku[v.v3.sku].unit_amount_minor === 1499);
  check("priceListApply: v2 unit untouched",      bySku[v.v2.sku].unit_amount_minor === 4999);

  // Currency mismatch refused.
  await ctx.bulk.priceLists.create({
    slug:     "eu-wholesale",
    title:    "EU Wholesale",
    currency: "EUR",
  });
  await assert.rejects(
    ctx.bulk.priceListApply({ cart_id: c.id, price_list_slug: "eu-wholesale" }),
    /price list currency EUR does not match cart currency USD/,
  );

  // Unknown slug refused.
  await assert.rejects(
    ctx.bulk.priceListApply({ cart_id: c.id, price_list_slug: "no-such-list" }),
    /price list 'no-such-list' not found/,
  );

  // Resolve via customer assignment.
  var customerId = bShop.framework.uuid.v7();
  await ctx.bulk.priceLists.assign({
    customer_id:     customerId,
    price_list_slug: "acme-wholesale",
  });
  var c2 = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await ctx.bulk.addLines({
    cart_id: c2.id,
    lines: [{ sku: v.v1.sku, qty: 1 }],
  });
  var r2 = await ctx.bulk.priceListApply({
    cart_id:     c2.id,
    customer_id: customerId,
  });
  check("priceListApply: resolves slug from customer assignment",
    r2.price_list_slug === "acme-wholesale" && r2.overridden === 1);
}

async function _reorderSkipsUnavailable() {
  var ctx = _setup();
  var v = await _seedCatalog(ctx.catalog);
  // Build a "prior order" by inserting straight into orders +
  // order_lines (the order primitive isn't required to exercise
  // this path; the schema is the contract).
  var cartId  = bShop.framework.uuid.v7();
  var orderId = bShop.framework.uuid.v7();
  var ts = Date.now();
  await ctx.query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'converted', ?3, ?3, ?4)",
    [cartId, _newSessionId(), ts, ts + 86400000],
  );
  await ctx.query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, NULL, ?3, 'paid', 'USD', 0, 0, 0, 0, 0, NULL, '{\"country\":\"US\"}', ?4, ?4)",
    [orderId, cartId, _newSessionId(), ts],
  );
  // Three order_lines — one of which references a SKU we'll archive
  // and one whose SKU we'll outright delete from variants.
  var lineRows = [
    { sku: v.v1.sku, qty: 2 },
    { sku: v.v2.sku, qty: 1 },   // we'll archive this variant
    { sku: "GHOST-SKU", qty: 5 },// no longer in variants table
  ];
  // Insert a placeholder variant for GHOST-SKU so the FK on
  // order_lines.variant_id (well — the schema has no FK on
  // order_lines.variant_id, but we still need a variant_id value)
  // can resolve.
  var ghostProduct = await ctx.catalog.products.create({ slug: "ghost", title: "Ghost", status: "active" });
  var ghostVariant = await ctx.catalog.variants.create(ghostProduct.id, { sku: "GHOST-SKU" });
  // Now drop the GHOST-SKU variant so the SKU lookup misses.
  await ctx.query("DELETE FROM variants WHERE id = ?1", [ghostVariant.id]);
  // Archive v2 directly — catalog.variants doesn't expose an
  // archived_at on the base variants table (it lives on
  // product_variants); the cart-bulk-ops reorder branch reads
  // variant.archived_at via catalog.variants.bySku and treats
  // missing variants as "variant-not-found". v2's archive case is
  // simulated by deleting its prices so the price-resolution branch
  // fires the "no-current-price" skip instead.
  await ctx.query("DELETE FROM prices WHERE variant_id = ?1", [v.v2.id]);

  for (var i = 0; i < lineRows.length; i += 1) {
    var lr = lineRows[i];
    var variantId = (lr.sku === "GHOST-SKU"
      ? ghostVariant.id
      : (lr.sku === v.v1.sku ? v.v1.id : v.v2.id));
    await ctx.query(
      "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [bShop.framework.uuid.v7(), orderId, variantId, lr.sku, lr.qty, 2000, "USD", lr.qty * 2000],
    );
  }

  // Now reorder into a fresh cart.
  var fresh = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  var r = await ctx.bulk.reorder({
    cart_id:         fresh.id,
    source_order_id: orderId,
  });
  check("reorder: 1 line added (the SKU that still resolves)", r.added === 1);
  check("reorder: 2 lines skipped",                             r.skipped.length === 2);
  // Reasons: v2 hits no-current-price, GHOST-SKU hits variant-not-found.
  var reasons = r.skipped.map(function (s) { return s.reason; }).sort();
  check("reorder: skip reasons surface",
    reasons.indexOf("no-current-price") !== -1 && reasons.indexOf("variant-not-found") !== -1);

  var freshLines = await ctx.cart.listLines(fresh.id);
  check("reorder: only the resolvable line is in the cart",     freshLines.length === 1 && freshLines[0].sku === v.v1.sku);
}

async function _splitCartByVendor() {
  var ctx = _setup();
  var v = await _seedCatalog(ctx.catalog);
  var c = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  // Three lines across two SKU prefixes (ACME / BETA).
  await ctx.bulk.addLines({
    cart_id: c.id,
    lines: [
      { sku: v.v1.sku, qty: 2 },   // ACME-...
      { sku: v.v2.sku, qty: 1 },   // ACME-...
      { sku: v.v3.sku, qty: 4 },   // BETA-...
    ],
  });

  var split = await ctx.bulk.splitCart({
    cart_id:  c.id,
    split_by: "vendor",
  });
  check("splitCart: two child carts",                    split.children.length === 2);

  var byGroup = {};
  split.children.forEach(function (ch) { byGroup[ch.group_key] = ch; });
  check("splitCart: ACME group has 2 lines",             byGroup.ACME.line_count === 2);
  check("splitCart: BETA group has 1 line",              byGroup.BETA.line_count === 1);

  var source = await ctx.cart.get(c.id);
  check("splitCart: source cart marked abandoned",       source.status === "abandoned");

  var acmeLines = await ctx.cart.listLines(byGroup.ACME.cart_id);
  check("splitCart: ACME child has both ACME lines",     acmeLines.length === 2);

  // Refuses when every line collapses to the same group.
  var c2 = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await ctx.bulk.addLines({
    cart_id: c2.id,
    lines: [{ sku: v.v1.sku, qty: 1 }, { sku: v.v2.sku, qty: 1 }],
  });
  await assert.rejects(
    ctx.bulk.splitCart({ cart_id: c2.id, split_by: "vendor" }),
    /nothing to split/,
  );

  // Refuses without a lineGrouper.
  var noGrouper = cartBulkOps.create({
    query:   ctx.query,
    cart:    ctx.cart,
    catalog: ctx.catalog,
  });
  var c3 = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await ctx.bulk.addLines({ cart_id: c3.id, lines: [{ sku: v.v1.sku, qty: 1 }] });
  await assert.rejects(
    noGrouper.splitCart({ cart_id: c3.id, split_by: "vendor" }),
    /lineGrouper required/,
  );

  // Bad split_by refused.
  var c4 = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await assert.rejects(
    ctx.bulk.splitCart({ cart_id: c4.id, split_by: "bogus" }),
    /split_by must be/,
  );
}

async function _quoteForCart() {
  var ctx = _setup();
  var v = await _seedCatalog(ctx.catalog);
  var c = await ctx.cart.create(_newSessionId(), { currency: "USD" });
  await ctx.bulk.addLines({
    cart_id: c.id,
    lines: [
      { sku: v.v1.sku, qty: 2 },   // 2 * 2999 = 5998
      { sku: v.v2.sku, qty: 1 },   // 1 * 4999 = 4999
    ],
  });

  var q = await ctx.bulk.quoteForCart({ cart_id: c.id });
  check("quoteForCart: returns cart id",          q.cart_id === c.id);
  check("quoteForCart: currency present",         q.currency === "USD");
  check("quoteForCart: line_count = 2",           q.line_count === 2);
  check("quoteForCart: unit_count = 3",           q.unit_count === 3);
  check("quoteForCart: subtotal_minor = 10997",   q.subtotal_minor === 10997);
  check("quoteForCart: per-line totals",
    q.lines[0].line_total_minor === q.lines[0].qty * q.lines[0].unit_amount_minor
    && q.lines[1].line_total_minor === q.lines[1].qty * q.lines[1].unit_amount_minor);

  // Mutation-free — cart still has both lines after the quote.
  var lines = await ctx.cart.listLines(c.id);
  check("quoteForCart: did not mutate the cart",  lines.length === 2);

  // Quote refused on a missing cart.
  await assert.rejects(
    ctx.bulk.quoteForCart({ cart_id: bShop.framework.uuid.v7() }),
    /not found/,
  );
}

async function _factoryRefusals() {
  // Both handles required at create() time.
  assert.throws(function () { cartBulkOps.create({}); }, /cart handle required/);
  assert.throws(function () { cartBulkOps.create({ cart: {} }); }, /catalog handle required/);
}

async function run() {
  await _addLinesHappyAndAtomic();
  await _replaceLines();
  await _clearLines();
  await _priceListApplyOverride();
  await _reorderSkipsUnavailable();
  await _splitCartByVendor();
  await _quoteForCart();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — " + helpers.getChecks() + " check(s) passed");
  }, function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
