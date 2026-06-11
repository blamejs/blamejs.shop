"use strict";
/**
 * autoDiscount -- operator-authored rules that apply to a cart
 * without a coupon code. The cart-resolution layer consults this
 * primitive and applies every rule whose trigger matches.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0107_auto_discount.sql`. Optional `catalog` and
 * `customerSegments` handles are stubbed inline so the tests cover
 * the wired-handle paths without dragging the full catalog +
 * segment pipelines in.
 *
 * Coverage:
 *   - defineRule hydrates trigger / value / applies_to /
 *     exclusions / segment list
 *   - defineRule refuses bad slug / unknown trigger kind / unknown
 *     value kind / redefine
 *   - evaluate: cart_total_min trigger matches above floor, skips
 *     below
 *   - evaluate: item_count_min trigger matches when sum(quantity)
 *     >= min_count
 *   - evaluate: sku_purchase trigger matches when any listed sku
 *     reaches the min_quantity threshold
 *   - evaluate: percent_off / amount_off_total / amount_off_each
 *     produce expected savings (rounded half-away-from-zero)
 *   - evaluate: free_shipping flag + savings reflects
 *     cart.shipping_cost_minor
 *   - evaluate: BOGO computes free units per line, emits
 *     bogo_eligible breakdown
 *   - evaluate: exclusion by sku / category short-circuits
 *   - evaluate: max_redemptions_total cap blocks once
 *     redemptions_used reaches the cap
 *   - evaluate: max_redemptions_per_customer cap blocks the
 *     applicable customer
 *   - evaluate: priority orders the applied list (higher first,
 *     ties by created_at)
 *   - recordApplication bumps the counter + writes the event row
 *   - metricsForRule aggregates applications + savings + unique
 *     customers
 *   - listRules / updateRule / archiveRule round-trip
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var autoDiscount = require("../../lib/auto-discount");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIGS = ["0107_auto_discount.sql", "0231_auto_discount_application_unique.sql", "0209_auto_discount_unlock_code.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

function _segmentsStub(memberships) {
  var calls = [];
  return {
    calls: calls,
    isMember: async function (customerId, segmentSlug) {
      calls.push({ customer_id: customerId, segment_slug: segmentSlug });
      var k = customerId + "::" + segmentSlug;
      return memberships[k] === true;
    },
  };
}

function _catalogStub(metaMap) {
  var calls = [];
  return {
    calls: calls,
    getLineMeta: async function (sku) {
      calls.push({ sku: sku });
      return metaMap[sku] || null;
    },
  };
}

// ---- defineRule: happy path --------------------------------------------

async function _defineRuleHappy() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  var rule = await ad.defineRule({
    slug:    "free-ship-50",
    title:   "Free shipping over $50",
    trigger: { kind: "cart_total_min", min_minor: 5000 },
    value:   { kind: "free_shipping" },
    priority: 10,
  });
  check("defineRule slug",           rule.slug === "free-ship-50");
  check("defineRule title",          rule.title === "Free shipping over $50");
  check("defineRule trigger kind",   rule.trigger.kind === "cart_total_min");
  check("defineRule trigger min",    rule.trigger.min_minor === 5000);
  check("defineRule value kind",     rule.value.kind === "free_shipping");
  check("defineRule priority",       rule.priority === 10);
  check("defineRule active default", rule.active === true);
  check("defineRule archived null",  rule.archived_at === null);
  check("defineRule redemptions 0",  rule.redemptions_used === 0);
  check("defineRule created_at int", Number.isInteger(rule.created_at));

  // Larger surface — applies_to / exclusions / segment_in / windows.
  var ts = Date.now();
  var rule2 = await ad.defineRule({
    slug:    "vip-sale",
    title:   "VIP sale",
    trigger: { kind: "item_count_min", min_count: 3 },
    value:   { kind: "percent_off", basis_points: 1500 },
    applies_to:          { kind: "category", values: ["sale", "clearance"] },
    customer_segment_in: ["vip"],
    exclusions:          [{ kind: "sku", value: "GIFTCARD" }],
    priority:            100,
    starts_at:           ts,
    expires_at:          ts + 86400000,
    max_redemptions_total:        50,
    max_redemptions_per_customer: 2,
  });
  check("defineRule applies_to.kind",        rule2.applies_to.kind === "category");
  check("defineRule applies_to.values",      rule2.applies_to.values.length === 2);
  check("defineRule customer_segment_in",    rule2.customer_segment_in[0] === "vip");
  check("defineRule exclusions",             rule2.exclusions.length === 1 && rule2.exclusions[0].kind === "sku");
  check("defineRule starts_at",              rule2.starts_at === ts);
  check("defineRule expires_at",             rule2.expires_at === ts + 86400000);
  check("defineRule max_total",              rule2.max_redemptions_total === 50);
  check("defineRule max_per_customer",       rule2.max_redemptions_per_customer === 2);

  // getRule round-trips
  var g = await ad.getRule("vip-sale");
  check("getRule round-trips",               g.slug === "vip-sale" && g.priority === 100);

  // listRules sees both
  var list = await ad.listRules();
  check("listRules returns both",            list.length === 2);
  check("listRules sorted by priority DESC", list[0].slug === "vip-sale" && list[1].slug === "free-ship-50");
}

// ---- defineRule: refusals ----------------------------------------------

async function _defineRuleRefusals() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await assert.rejects(ad.defineRule(), /input object required/);
  await assert.rejects(ad.defineRule({
    slug: "Has Space", title: "x",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "percent_off", basis_points: 100 },
  }), /slug/);
  await assert.rejects(ad.defineRule({
    slug: "ok", title: "",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "percent_off", basis_points: 100 },
  }), /title/);
  await assert.rejects(ad.defineRule({
    slug: "ok", title: "x",
    trigger: { kind: "bogus_trigger" },
    value:   { kind: "percent_off", basis_points: 100 },
  }), /trigger\.kind/);
  await assert.rejects(ad.defineRule({
    slug: "ok", title: "x",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "bogus_value" },
  }), /value\.kind/);
  await assert.rejects(ad.defineRule({
    slug: "ok", title: "x",
    trigger: { kind: "sku_purchase", skus: [] },
    value:   { kind: "free_shipping" },
  }), /trigger\.skus/);
  await assert.rejects(ad.defineRule({
    slug: "ok", title: "x",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "percent_off", basis_points: 100 },
    starts_at: 200, expires_at: 100,
  }), /expires_at/);

  // Successful define
  await ad.defineRule({
    slug: "ok", title: "x",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "percent_off", basis_points: 100 },
  });
  // Redefine refused
  await assert.rejects(ad.defineRule({
    slug: "ok", title: "again",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "percent_off", basis_points: 100 },
  }), /already exists/);
}

// ---- evaluate: trigger kinds (cart_total_min) --------------------------

async function _evalCartTotalMin() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "over-50", title: "Over $50",
    trigger: { kind: "cart_total_min", min_minor: 5000 },
    value:   { kind: "free_shipping" },
  });

  // Below floor -- skipped.
  var rLow = await ad.evaluate({
    cart: { subtotal_minor: 1000, shipping_cost_minor: 500, lines: [{ sku: "A", quantity: 1, unit_price_minor: 1000 }] },
  });
  check("cart_total_min: below floor not applied", rLow.applied.length === 0);
  check("cart_total_min: below floor skipped reason",
    rLow.skipped.length === 1 && rLow.skipped[0].reason === "trigger_not_met");

  // At/above floor -- applied with free_shipping savings = shipping cost.
  var rHigh = await ad.evaluate({
    cart: { subtotal_minor: 6000, shipping_cost_minor: 700, lines: [{ sku: "A", quantity: 1, unit_price_minor: 6000 }] },
  });
  check("cart_total_min: above floor applied",     rHigh.applied.length === 1);
  check("cart_total_min: free_shipping flag",      rHigh.applied[0].free_shipping === true);
  check("cart_total_min: savings = shipping cost", rHigh.applied[0].savings_minor === 700);
  check("cart_total_min: value_kind reported",     rHigh.applied[0].value_kind === "free_shipping");
}

// ---- evaluate: trigger kinds (item_count_min) --------------------------

async function _evalItemCountMin() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "buy-3", title: "Buy 3+",
    trigger: { kind: "item_count_min", min_count: 3 },
    value:   { kind: "amount_off_total", minor: 200 },
  });

  // Two items -- skip.
  var r2 = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 2, unit_price_minor: 2500 }] },
  });
  check("item_count_min: 2 items skipped", r2.applied.length === 0);

  // Three items (across multiple lines) -- applied.
  var r3 = await ad.evaluate({
    cart: { subtotal_minor: 6000, lines: [
      { sku: "A", quantity: 2, unit_price_minor: 2000 },
      { sku: "B", quantity: 1, unit_price_minor: 2000 },
    ] },
  });
  check("item_count_min: 3 items applied", r3.applied.length === 1);
  check("item_count_min: amount_off_total savings", r3.applied[0].savings_minor === 200);

  // amount_off_total clamps to subtotal.
  await ad.defineRule({
    slug: "huge-off", title: "Huge off",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "amount_off_total", minor: 99999 },
    priority: 200,
  });
  var rClamp = await ad.evaluate({
    cart: { subtotal_minor: 6000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 6000 }] },
  });
  // Both rules apply; huge-off clamps to subtotal.
  var huge = rClamp.applied.filter(function (a) { return a.rule_slug === "huge-off"; })[0];
  check("amount_off_total clamped to subtotal", huge && huge.savings_minor === 6000);
}

// ---- evaluate: trigger kinds (sku_purchase) ----------------------------

async function _evalSkuPurchase() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "widget-deal", title: "Widget deal",
    trigger: { kind: "sku_purchase", skus: ["WIDGET-A", "WIDGET-B"], min_quantity: 2 },
    value:   { kind: "percent_off", basis_points: 1000 }, // 10%
  });

  // Missing trigger sku -- skip.
  var rMiss = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "OTHER", quantity: 5, unit_price_minor: 1000 }] },
  });
  check("sku_purchase: missing sku skipped", rMiss.applied.length === 0);

  // Has 2x WIDGET-A -- applied, 10% off subtotal.
  var rHit = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [
      { sku: "WIDGET-A", quantity: 2, unit_price_minor: 2000 },
      { sku: "OTHER",    quantity: 1, unit_price_minor: 1000 },
    ] },
  });
  check("sku_purchase: hit applied",     rHit.applied.length === 1);
  check("sku_purchase: percent savings", rHit.applied[0].savings_minor === 500);

  // 1x WIDGET-A < min_quantity 2 -- skip.
  var rUnder = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "WIDGET-A", quantity: 1, unit_price_minor: 2000 }] },
  });
  check("sku_purchase: under min_quantity skipped", rUnder.applied.length === 0);
}

// ---- evaluate: amount_off_each + percent_off rounding ------------------

async function _evalAmountOffEachAndRounding() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  // amount_off_each, no applies_to -> every line.
  await ad.defineRule({
    slug: "buck-off-each", title: "$1 off each",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "amount_off_each", minor: 100 },
  });
  var rEach = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [
      { sku: "A", quantity: 3, unit_price_minor: 1000 },
      { sku: "B", quantity: 2, unit_price_minor: 1000 },
    ] },
  });
  check("amount_off_each: savings = sum(minor * qty)", rEach.applied[0].savings_minor === 500);

  // amount_off_each clamps per-unit at the unit price.
  await ad.defineRule({
    slug: "huge-each", title: "huge each",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "amount_off_each", minor: 9999 },
    priority: 50,
  });
  var rClamp = await ad.evaluate({
    cart: { subtotal_minor: 200, lines: [{ sku: "A", quantity: 2, unit_price_minor: 100 }] },
  });
  var hugeEach = rClamp.applied.filter(function (a) { return a.rule_slug === "huge-each"; })[0];
  check("amount_off_each: clamped at unit price", hugeEach && hugeEach.savings_minor === 200);

  // percent_off rounding -- half-away-from-zero.
  var q2 = _makeQuery();
  var ad2 = autoDiscount.create({ query: q2 });
  await ad2.defineRule({
    slug: "round-test", title: "rounding",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "percent_off", basis_points: 1234 },
  });
  // base = 1001, 12.34% = 123.5234 -> 124 (half-away-from-zero)
  var rRound = await ad2.evaluate({
    cart: { subtotal_minor: 1001, lines: [{ sku: "A", quantity: 1, unit_price_minor: 1001 }] },
  });
  check("percent_off: half-away-from-zero rounding", rRound.applied[0].savings_minor === 124);

  // Exact-multiple sanity: 8250 * 1250 / 10000 = 1031.25 -> 1031
  // (half-away). No float drift at this magnitude; pins the result so a
  // future rounding-direction change is caught.
  var q3 = _makeQuery();
  var ad3 = autoDiscount.create({ query: q3 });
  await ad3.defineRule({
    slug: "round-exact", title: "exact",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "percent_off", basis_points: 1250 },
  });
  var rExact = await ad3.evaluate({
    cart: { subtotal_minor: 8250, lines: [{ sku: "A", quantity: 1, unit_price_minor: 8250 }] },
  });
  check("percent_off: 8250 * 12.50% = 1031", rExact.applied[0].savings_minor === 1031);

  // Float-drift guard: a JS float multiply of base*basis_points
  // overflows 2^53 here and lands one cent high. base=27048646418003,
  // bps=333 -> exact 900719925719, but (base*333)/10000 rounds to
  // 900719925720 in float. The exact-BigInt path must return 719.
  var q4 = _makeQuery();
  var ad4 = autoDiscount.create({ query: q4 });
  await ad4.defineRule({
    slug: "round-big", title: "big",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "percent_off", basis_points: 333 },
  });
  var bigBase = 27048646418003;
  var rBig = await ad4.evaluate({
    cart: { subtotal_minor: bigBase, lines: [{ sku: "A", quantity: 1, unit_price_minor: bigBase }] },
  });
  check("percent_off: large base exact (no float drift)", rBig.applied[0].savings_minor === 900719925719);
}

// ---- evaluate: BOGO ----------------------------------------------------

async function _evalBogo() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  // Buy 1 Get 1 free on category 'sale'.
  await ad.defineRule({
    slug: "bogo-sale", title: "BOGO sale tag",
    trigger: { kind: "item_count_min", min_count: 2 },
    value:   { kind: "bogo", buy_qty: 1, get_qty: 1 },
    applies_to: { kind: "category", values: ["sale"] },
  });

  // Line has 4 units of a SALE sku, unit price 1000 -- 2 groups of 2,
  // free units = 2, savings = 2000.
  var rBogo = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [
      { sku: "TEE-S", quantity: 4, unit_price_minor: 1000, category: "sale" },
      { sku: "MUG",   quantity: 1, unit_price_minor: 1000, category: "regular" },
    ] },
  });
  check("bogo: applied",                   rBogo.applied.length === 1);
  check("bogo: value_kind reported",       rBogo.applied[0].value_kind === "bogo");
  check("bogo: savings = free * price",    rBogo.applied[0].savings_minor === 2000);
  check("bogo: bogo_eligible present",     Array.isArray(rBogo.applied[0].bogo_eligible));
  check("bogo: bogo_eligible line entry",  rBogo.applied[0].bogo_eligible[0].sku === "TEE-S" && rBogo.applied[0].bogo_eligible[0].free_qty === 2);

  // Only 1 unit -- no full group, BOGO skipped via bogo_no_eligible_group.
  // Note item_count_min still requires 2 -- so we add another line.
  var rNoGroup = await ad.evaluate({
    cart: { subtotal_minor: 2000, lines: [
      { sku: "TEE-S", quantity: 1, unit_price_minor: 1000, category: "sale" },
      { sku: "MUG",   quantity: 1, unit_price_minor: 1000, category: "regular" },
    ] },
  });
  check("bogo: no full group skipped",
    rNoGroup.applied.length === 0 &&
    rNoGroup.skipped.some(function (s) { return s.reason === "bogo_no_eligible_group"; }));
}

// ---- evaluate: exclusions ----------------------------------------------

async function _evalExclusions() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "gen-10", title: "10% off",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "percent_off", basis_points: 1000 },
    exclusions: [{ kind: "sku", value: "GIFTCARD" }, { kind: "category", value: "clearance" }],
  });

  // Cart contains GIFTCARD -- excluded.
  var rGc = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [
      { sku: "GIFTCARD", quantity: 1, unit_price_minor: 5000 },
    ] },
  });
  check("exclusion sku: skipped",
    rGc.applied.length === 0 &&
    rGc.skipped[0].reason === "excluded_sku_present");

  // Cart contains a line tagged 'clearance' -- excluded by category.
  var rCl = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [
      { sku: "ITEM", quantity: 1, unit_price_minor: 5000, category: "clearance" },
    ] },
  });
  check("exclusion category: skipped",
    rCl.applied.length === 0 &&
    rCl.skipped[0].reason === "excluded_category_present");

  // Same exclusion satisfied via TAGS (line.tags = ["clearance"]).
  var rTag = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [
      { sku: "ITEM2", quantity: 1, unit_price_minor: 5000, tags: ["clearance"] },
    ] },
  });
  check("exclusion category: tag match also skipped",
    rTag.applied.length === 0 &&
    rTag.skipped[0].reason === "excluded_category_present");

  // No excluded items -- applied normally.
  var rOk = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [
      { sku: "ITEM3", quantity: 1, unit_price_minor: 5000, category: "regular" },
    ] },
  });
  check("exclusion: clean cart applied", rOk.applied.length === 1);
  check("exclusion: clean cart savings", rOk.applied[0].savings_minor === 500);
}

// ---- evaluate: catalog handle fallback ---------------------------------

async function _evalCatalogHandleFallback() {
  var q  = _makeQuery();
  var catalog = _catalogStub({
    "SHIRT-1": { category: "apparel", tags: ["sale"] },
  });
  var ad = autoDiscount.create({ query: q, catalog: catalog });

  await ad.defineRule({
    slug: "sale-10", title: "10% off sale tag",
    trigger: { kind: "item_count_min", min_count: 1 },
    value:   { kind: "percent_off", basis_points: 1000 },
    applies_to: { kind: "category", values: ["sale"] },
  });

  // Cart line carries NO category / tags inline -- catalog handle
  // resolves it.
  var r = await ad.evaluate({
    cart: { subtotal_minor: 2000, lines: [
      { sku: "SHIRT-1", quantity: 1, unit_price_minor: 2000 },
    ] },
  });
  check("catalog handle: rule applied",        r.applied.length === 1);
  check("catalog handle: savings on matched",  r.applied[0].savings_minor === 200);
  check("catalog handle: getLineMeta called",  catalog.calls.length > 0);
}

// ---- evaluate: max_redemptions cap -------------------------------------

async function _evalMaxRedemptions() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "cap-2", title: "Cap at 2 total",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "amount_off_total", minor: 100 },
    max_redemptions_total: 2,
  });

  // Two recorded applications -- counter hits cap.
  await ad.recordApplication({ rule_slug: "cap-2", order_id: "o-1", savings_minor: 100 });
  await ad.recordApplication({ rule_slug: "cap-2", order_id: "o-2", savings_minor: 100 });

  var rule = await ad.getRule("cap-2");
  check("recordApplication bumps counter", rule.redemptions_used === 2);

  // Next evaluate -- skipped via cap.
  var rCap = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
  });
  check("max_redemptions_total: skipped",
    rCap.applied.length === 0 &&
    rCap.skipped[0].reason === "max_redemptions_total_reached");
}

// ---- evaluate: per-customer cap ----------------------------------------

async function _evalPerCustomerCap() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "once-per-cust", title: "Once per customer",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "amount_off_total", minor: 50 },
    max_redemptions_per_customer: 1,
  });

  await ad.recordApplication({
    rule_slug: "once-per-cust", order_id: "o-1", savings_minor: 50, customer_id: "cust-1",
  });

  var rCust = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
    customer_id: "cust-1",
  });
  check("per_customer cap blocks repeat customer",
    rCust.applied.length === 0 &&
    rCust.skipped[0].reason === "max_redemptions_per_customer_reached");

  // Different customer -- still under their own cap.
  var rOther = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
    customer_id: "cust-2",
  });
  check("per_customer cap: other customer still applies", rOther.applied.length === 1);

  // Guest -- per-customer cap can't be evaluated, skip with typed reason.
  var rGuest = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
  });
  check("per_customer cap: guest skipped with reason",
    rGuest.applied.length === 0 &&
    rGuest.skipped[0].reason === "per_customer_cap_requires_customer");
}

// ---- evaluate: priority ordering ---------------------------------------

async function _evalPriorityOrdering() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "p-low", title: "Low priority",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "amount_off_total", minor: 50 },
    priority: 10,
  });
  await ad.defineRule({
    slug: "p-high", title: "High priority",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "free_shipping" },
    priority: 100,
  });
  await ad.defineRule({
    slug: "p-mid", title: "Mid priority",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "percent_off", basis_points: 500 },
    priority: 50,
  });

  var r = await ad.evaluate({
    cart: { subtotal_minor: 5000, shipping_cost_minor: 1000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
  });
  check("priority: 3 rules applied", r.applied.length === 3);
  check("priority: high first",       r.applied[0].rule_slug === "p-high");
  check("priority: mid second",       r.applied[1].rule_slug === "p-mid");
  check("priority: low last",         r.applied[2].rule_slug === "p-low");
}

// ---- evaluate: customer segment gate -----------------------------------

async function _evalSegmentGate() {
  var q  = _makeQuery();
  var seg = _segmentsStub({
    "cust-vip::vip":     true,
    "cust-regular::vip": false,
  });
  var ad = autoDiscount.create({ query: q, customerSegments: seg });

  await ad.defineRule({
    slug: "vip-only", title: "VIP only",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "amount_off_total", minor: 500 },
    customer_segment_in: ["vip"],
  });

  // VIP -- applied.
  var rVip = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
    customer_id: "cust-vip",
  });
  check("segment: VIP customer applies",       rVip.applied.length === 1);

  // Non-VIP -- skipped.
  var rReg = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
    customer_id: "cust-regular",
  });
  check("segment: non-VIP skipped",            rReg.applied.length === 0);
  check("segment: non-VIP skipped reason",
    rReg.skipped.some(function (s) { return s.reason === "customer_not_in_segment"; }));

  // Guest -- skipped with typed reason.
  var rGuest = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
  });
  check("segment: guest skipped reason",
    rGuest.skipped[0].reason === "segment_gate_requires_customer");

  // Stub recorded the membership lookups.
  check("segment: stub called",                seg.calls.length > 0);

  // Missing handle -- throws when a segment-gated rule reaches the gate.
  var adNoSeg = autoDiscount.create({ query: q });
  await assert.rejects(adNoSeg.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 1, unit_price_minor: 5000 }] },
    customer_id: "cust-vip",
  }), /customerSegments handle/);
}

// ---- recordApplication + metricsForRule --------------------------------

async function _recordAndMetrics() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "promo-1", title: "Promo 1",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "amount_off_total", minor: 100 },
  });

  var t0 = Date.now() - 60000;
  var t1 = Date.now() - 30000;
  var t2 = Date.now();

  var app1 = await ad.recordApplication({
    rule_slug: "promo-1", order_id: "o-1", savings_minor: 100, customer_id: "cust-a", applied_at: t0,
  });
  await ad.recordApplication({
    rule_slug: "promo-1", order_id: "o-2", savings_minor: 250, customer_id: "cust-a", applied_at: t1,
  });
  await ad.recordApplication({
    rule_slug: "promo-1", order_id: "o-3", savings_minor: 80,  customer_id: "cust-b", applied_at: t2,
  });

  check("recordApplication returns id",        typeof app1.id === "string" && app1.id.length > 0);
  check("recordApplication returns slug",      app1.rule_slug === "promo-1");
  check("recordApplication returns savings",   app1.savings_minor === 100);

  // Counter bumped 3x.
  var rule = await ad.getRule("promo-1");
  check("recordApplication bumps counter 3x",  rule.redemptions_used === 3);

  // Metrics across all time.
  var all = await ad.metricsForRule({ rule_slug: "promo-1" });
  check("metricsForRule: applications all",    all.applications === 3);
  check("metricsForRule: gross_savings all",   all.gross_savings_minor === 430);
  check("metricsForRule: unique_customers",    all.unique_customers === 2);

  // Window covering only the last two.
  var window = await ad.metricsForRule({ rule_slug: "promo-1", from: t1 });
  check("metricsForRule: windowed applications", window.applications === 2);
  check("metricsForRule: windowed savings",      window.gross_savings_minor === 330);

  // Recording against an unknown rule -- typed error.
  await assert.rejects(ad.recordApplication({
    rule_slug: "nothing", order_id: "o-x", savings_minor: 10,
  }), /not found/);

  // metricsForRule on unknown rule -- typed error.
  await assert.rejects(ad.metricsForRule({ rule_slug: "nothing" }), /not found/);
}

// ---- updateRule + archiveRule + listRules active_only ------------------

async function _updateAndArchive() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await ad.defineRule({
    slug: "u", title: "Original",
    trigger: { kind: "cart_total_min", min_minor: 0 },
    value:   { kind: "amount_off_total", minor: 100 },
    priority: 5,
  });

  var up = await ad.updateRule("u", {
    title:    "Mutated",
    trigger:  { kind: "item_count_min", min_count: 2 },
    value:    { kind: "percent_off", basis_points: 2000 },
    priority: 20,
    applies_to: { kind: "sku", values: ["WIDGET-A"] },
    max_redemptions_total: 10,
  });
  check("updateRule title",                up.title === "Mutated");
  check("updateRule trigger kind",         up.trigger.kind === "item_count_min");
  check("updateRule value kind",           up.value.kind === "percent_off");
  check("updateRule priority",             up.priority === 20);
  check("updateRule applies_to.kind",      up.applies_to.kind === "sku");
  check("updateRule max_total",            up.max_redemptions_total === 10);

  // Empty patch refused
  await assert.rejects(ad.updateRule("u", {}), /at least one column/);
  // Unsupported column refused
  await assert.rejects(ad.updateRule("u", { slug: "renamed" }), /unsupported column/);
  // Missing slug refused
  await assert.rejects(ad.updateRule("nonexistent", { title: "x" }), /not found/);

  // Clearing nullable fields via null.
  var up2 = await ad.updateRule("u", { applies_to: null, max_redemptions_total: null });
  check("updateRule clears applies_to",          up2.applies_to === null);
  check("updateRule clears max_total",           up2.max_redemptions_total === null);

  // Archive.
  var archived = await ad.archiveRule("u");
  check("archiveRule returns archived row",      archived.archived_at != null);
  check("archiveRule flips active to false",     archived.active === false);

  // Idempotent archive.
  var again = await ad.archiveRule("u");
  check("archiveRule idempotent",                again.archived_at != null);

  // list active_only hides archived.
  var actives = await ad.listRules({ active_only: true });
  check("listRules active_only hides archived",  actives.length === 0);

  // list default shows archived.
  var all = await ad.listRules();
  check("listRules default shows archived",      all.length === 1);

  // archiveRule on missing slug refused.
  await assert.rejects(ad.archiveRule("nothing"), /not found/);

  // Archived rule excluded from evaluate.
  var rEval = await ad.evaluate({
    cart: { subtotal_minor: 5000, lines: [{ sku: "A", quantity: 5, unit_price_minor: 1000 }] },
  });
  check("archived rule excluded from evaluate",  rEval.applied.length === 0 && rEval.skipped.length === 0);
}

// ---- evaluate input refusals ------------------------------------------

async function _evaluateInputRefusals() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  await assert.rejects(ad.evaluate(),                            /input object required/);
  await assert.rejects(ad.evaluate({ cart: null }),              /cart object required/);
  await assert.rejects(ad.evaluate({
    cart: { subtotal_minor: -1, lines: [] },
  }), /subtotal_minor/);
  await assert.rejects(ad.evaluate({
    cart: { subtotal_minor: 100, lines: "no" },
  }), /lines must be an array/);
  await assert.rejects(ad.evaluate({
    cart: { subtotal_minor: 100, lines: [{ sku: "", quantity: 1, unit_price_minor: 100 }] },
  }), /sku required/);
  await assert.rejects(ad.evaluate({
    cart: { subtotal_minor: 100, lines: [{ sku: "A", quantity: 0, unit_price_minor: 100 }] },
  }), /quantity/);
  await assert.rejects(ad.evaluate({
    cart: { subtotal_minor: 100, lines: [{ sku: "A", quantity: 1, unit_price_minor: -1 }] },
  }), /unit_price_minor/);
  await assert.rejects(ad.evaluate({
    cart: { subtotal_minor: 100, lines: [] }, customer_id: "",
  }), /customer_id/);
}

// Pre-charge claims: a capped rule is reserved ATOMICALLY before any money
// moves, so two concurrent checkouts racing the last redemption can't both
// receive the discount — the loser is refused closed, a release returns
// the reservation, the link re-keys to the real order, and a re-delivered
// recordApplication can't double-count a cap.
async function _claimsRaceReleaseAndIdempotency() {
  var q  = _makeQuery();
  var ad = autoDiscount.create({ query: q });

  // Total cap of 1 — two concurrent claims: exactly one wins.
  await ad.defineRule({
    slug: "one-shot", title: "One shot",
    trigger: { kind: "cart_total_min", min_minor: 100 },
    value:   { kind: "amount_off_total", minor: 500 },
    max_redemptions_total: 1,
  });
  var res = await Promise.all([
    ad.claimRedemption({ rule_slug: "one-shot", claim_ref: "claim:cart-a", savings_minor: 500 }),
    ad.claimRedemption({ rule_slug: "one-shot", claim_ref: "claim:cart-b", savings_minor: 500 }),
  ]);
  var winners = res.filter(function (r) { return r.claimed; });
  var losers  = res.filter(function (r) { return !r.claimed; });
  check("claim race: exactly one claim wins",         winners.length === 1);
  check("claim race: loser refused on the total cap", losers.length === 1 && losers[0].reason === "total-cap");

  // Release returns the reservation; a fresh claim succeeds again.
  var winRef = res[0].claimed ? "claim:cart-a" : "claim:cart-b";
  check("claim release returns the reservation",
        (await ad.releaseClaim({ rule_slug: "one-shot", claim_ref: winRef })) === true);
  check("released cap is claimable again",
        (await ad.claimRedemption({ rule_slug: "one-shot", claim_ref: "claim:cart-c", savings_minor: 500 })).claimed === true);
  check("double release is a no-op",
        (await ad.releaseClaim({ rule_slug: "one-shot", claim_ref: winRef })) === false);

  // Per-customer cap of 1, no total cap — two concurrent claims by the
  // SAME customer: one wins; a different customer still claims fine.
  await ad.defineRule({
    slug: "once-each", title: "Once each",
    trigger: { kind: "cart_total_min", min_minor: 100 },
    value:   { kind: "amount_off_total", minor: 300 },
    max_redemptions_per_customer: 1,
  });
  var custA = "cust-aaaa";
  var perCust = await Promise.all([
    ad.claimRedemption({ rule_slug: "once-each", claim_ref: "claim:pc-1", savings_minor: 300, customer_id: custA }),
    ad.claimRedemption({ rule_slug: "once-each", claim_ref: "claim:pc-2", savings_minor: 300, customer_id: custA }),
  ]);
  check("per-customer race: exactly one claim wins",
        perCust.filter(function (r) { return r.claimed; }).length === 1);
  check("per-customer race: loser refused on the customer cap",
        perCust.filter(function (r) { return !r.claimed && r.reason === "customer-cap"; }).length === 1);
  check("a different customer still claims",
        (await ad.claimRedemption({ rule_slug: "once-each", claim_ref: "claim:pc-3", savings_minor: 300, customer_id: "cust-bbbb" })).claimed === true);

  // Link re-keys the winning claim to the real order id.
  var pcWinRef = perCust[0].claimed ? "claim:pc-1" : "claim:pc-2";
  check("link re-keys the claim to the order",
        (await ad.linkClaimToOrder({ rule_slug: "once-each", claim_ref: pcWinRef, order_id: "ord-real-1" })) === true);

  // Re-claiming with the SAME ref (a retry whose rollback didn't finish)
  // reuses the claim instead of double-reserving.
  var reuse = await ad.claimRedemption({ rule_slug: "once-each", claim_ref: "claim:pc-3", savings_minor: 300, customer_id: "cust-bbbb" });
  check("same-ref re-claim reuses the held claim", reuse.claimed === true && reuse.reused === true);

  // recordApplication is idempotent per (rule, order): a re-delivery
  // advances the counter once.
  await ad.defineRule({
    slug: "rec-idem", title: "Record idem",
    trigger: { kind: "cart_total_min", min_minor: 100 },
    value:   { kind: "amount_off_total", minor: 100 },
  });
  await ad.recordApplication({ rule_slug: "rec-idem", order_id: "ord-x", savings_minor: 100 });
  await ad.recordApplication({ rule_slug: "rec-idem", order_id: "ord-x", savings_minor: 100 });
  var recRule = await ad.getRule("rec-idem");
  check("recordApplication re-delivery counts once", recRule.redemptions_used === 1);
}

async function run() {
  await _defineRuleHappy();
  await _defineRuleRefusals();
  await _claimsRaceReleaseAndIdempotency();
  await _evalCartTotalMin();
  await _evalItemCountMin();
  await _evalSkuPurchase();
  await _evalAmountOffEachAndRounding();
  await _evalBogo();
  await _evalExclusions();
  await _evalCatalogHandleFallback();
  await _evalMaxRedemptions();
  await _evalPerCustomerCap();
  await _evalPriorityOrdering();
  await _evalSegmentGate();
  await _recordAndMetrics();
  await _updateAndArchive();
  await _evaluateInputRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK -- auto-discount (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL -- auto-discount: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
