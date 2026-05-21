"use strict";
/**
 * discounts — coupon-code rules + redemption ledger.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog — needed for the orders FK chain), 0002 (cart),
 * 0003 (order), 0007 (discounts).
 *
 * Coverage:
 *   - create + get + byCode (case-insensitive lookup)
 *   - list (paginated, active filter)
 *   - update (field-level patch + UNIQUE-constraint refusal)
 *   - delete (returns boolean, idempotent re-delete)
 *   - resolve happy-path (percent_off + fixed_off, clamped to subtotal)
 *   - resolve refusals: unknown-code / not-active / expired /
 *     not-yet-active / below-min-subtotal / wrong-currency /
 *     max-uses-exhausted
 *   - redeem increments uses + appends ledger row
 *   - redeem refuses past max_uses cap (atomic UPDATE)
 *   - validation: bad code shape, missing currency for fixed_off,
 *     percent value > 10000
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0007_discounts.sql"].map(function (f) {
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

function _uuid() { return bShop.framework.uuid.v7(); }

// Seed an order row via the order primitive so `redeem(...)` can FK
// into a real orders.id (the discount_redemptions table FKs into
// orders). We only need a single order — the redemption count + FK
// integrity are the gates the test pins.
var _seedCounter = 0;
async function _seedOrder(query) {
  _seedCounter += 1;
  var n = _seedCounter;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });
  var p = await catalog.products.create({ slug: "disc-test-" + n, title: "DiscTest " + n, status: "active" });
  var sku = "DISC-" + n;
  var v = await catalog.variants.create(p.id, { sku: sku });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
  var sid = _uuid();
  var c   = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 1 });
  var o = await order.createFromCart({
    cart_id: c.id, session_id: sid, currency: "USD",
    subtotal_minor: 2999, discount_minor: 0, tax_minor: 0, shipping_minor: 0,
    grand_total_minor: 2999, ship_to: { country: "US" },
    lines: [{ variant_id: v.id, sku: sku, qty: 1, unit_amount_minor: 2999, unit_currency: "USD" }],
  });
  return o;
}

async function _crud() {
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });

  // Create — percent_off
  var d = await discounts.create({
    code: "summer-25", type: "percent_off", value_bps_or_minor: 2500,
  });
  check("create returns row",           d && d.id);
  check("create uppercases code",       d.code === "SUMMER-25");
  check("percent_off has null currency", d.currency === null);
  check("active defaults to 1",          d.active === 1);
  check("uses defaults to 0",            d.uses === 0);

  // get
  var g = await discounts.get(d.id);
  check("get round-trips",     g.id === d.id && g.code === "SUMMER-25");

  // byCode — case-insensitive
  var lower = await discounts.byCode("summer-25");
  check("byCode lowercase finds",  lower && lower.id === d.id);
  var upper = await discounts.byCode("SUMMER-25");
  check("byCode uppercase finds",  upper && upper.id === d.id);
  var mixed = await discounts.byCode("SuMmEr-25");
  check("byCode mixed finds",      mixed && mixed.id === d.id);
  var miss  = await discounts.byCode("NOPE-99");
  check("byCode missing → null",   miss === null);

  // List + pagination
  await discounts.create({ code: "fall-15", type: "percent_off", value_bps_or_minor: 1500 });
  await discounts.create({ code: "winter-fixed", type: "fixed_off", value_bps_or_minor: 500, currency: "USD" });
  var page = await discounts.list({ limit: 10 });
  check("list returns rows",       page.rows.length === 3);

  // Active filter
  var inactive = await discounts.create({ code: "inactive-rule", type: "percent_off", value_bps_or_minor: 1000, active: 0 });
  var activeOnly = await discounts.list({ limit: 10, active: true });
  check("active filter excludes inactive", activeOnly.rows.length === 3);
  var inactiveOnly = await discounts.list({ limit: 10, active: false });
  check("inactive filter includes only inactive", inactiveOnly.rows.length === 1 && inactiveOnly.rows[0].id === inactive.id);

  // Update
  var updated = await discounts.update(d.id, { value_bps_or_minor: 3000 });
  check("update returns row",            updated && updated.value_bps_or_minor === 3000);
  check("update bumps updated_at",       updated.updated_at >= d.updated_at);

  // UNIQUE refusal — try to rename to an existing code
  await assert.rejects(discounts.update(d.id, { code: "fall-15" }), /already exists/);

  // Delete
  check("delete returns true",   (await discounts.delete(d.id)) === true);
  check("delete missing → false", (await discounts.delete(d.id)) === false);
  check("get after delete → null", (await discounts.get(d.id)) === null);
}

async function _resolveHappyPercent() {
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });
  await discounts.create({ code: "pct25", type: "percent_off", value_bps_or_minor: 2500 });
  var r = await discounts.resolve({ code: "pct25", subtotal_minor: 10000, currency: "USD" });
  check("percent_off computes discount",   r.discount_minor === 2500);     // 10000 × 2500/10000
  check("percent_off no reason",            !r.reason);
  check("percent_off carries discount row", r.discount && r.discount.code === "PCT25");

  // Floor behavior
  var r2 = await discounts.resolve({ code: "pct25", subtotal_minor: 99, currency: "USD" });
  check("percent_off floors",   r2.discount_minor === Math.floor(99 * 2500 / 10000));   // 24

  // Case-insensitive at the resolver too
  var r3 = await discounts.resolve({ code: "PcT25", subtotal_minor: 1000, currency: "USD" });
  check("resolve case-insensitive", r3.discount_minor === 250);

  // 100% cap
  await discounts.create({ code: "fullpct", type: "percent_off", value_bps_or_minor: 10000 });
  var rFull = await discounts.resolve({ code: "fullpct", subtotal_minor: 5000, currency: "USD" });
  check("100% off matches subtotal", rFull.discount_minor === 5000);
}

async function _resolveHappyFixed() {
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });
  await discounts.create({ code: "fix500", type: "fixed_off", value_bps_or_minor: 500, currency: "USD" });
  var r = await discounts.resolve({ code: "fix500", subtotal_minor: 10000, currency: "USD" });
  check("fixed_off uses literal minor", r.discount_minor === 500);
  check("fixed_off no reason",          !r.reason);

  // Clamp to subtotal
  var r2 = await discounts.resolve({ code: "fix500", subtotal_minor: 300, currency: "USD" });
  check("fixed_off clamps to subtotal", r2.discount_minor === 300);
}

async function _resolveRefusals() {
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });
  var R = discounts.REASONS;

  // unknown-code
  var rUnknown = await discounts.resolve({ code: "noexist", subtotal_minor: 1000, currency: "USD" });
  check("unknown-code", rUnknown.reason === R.UNKNOWN_CODE && rUnknown.discount_minor === 0);

  // not-active
  await discounts.create({ code: "inactive", type: "percent_off", value_bps_or_minor: 1000, active: 0 });
  var rInactive = await discounts.resolve({ code: "inactive", subtotal_minor: 1000, currency: "USD" });
  check("not-active", rInactive.reason === R.NOT_ACTIVE && rInactive.discount_minor === 0);

  // not-yet-active
  var future = Date.now() + 24 * 60 * 60 * 1000;
  await discounts.create({ code: "future", type: "percent_off", value_bps_or_minor: 1000, starts_at: future });
  var rFuture = await discounts.resolve({ code: "future", subtotal_minor: 1000, currency: "USD" });
  check("not-yet-active", rFuture.reason === R.NOT_YET_ACTIVE);

  // expired
  var past = Date.now() - 24 * 60 * 60 * 1000;
  await discounts.create({ code: "past", type: "percent_off", value_bps_or_minor: 1000, ends_at: past });
  var rPast = await discounts.resolve({ code: "past", subtotal_minor: 1000, currency: "USD" });
  check("expired", rPast.reason === R.EXPIRED);

  // below-min-subtotal
  await discounts.create({ code: "min50", type: "percent_off", value_bps_or_minor: 1000, min_subtotal_minor: 5000 });
  var rBelow = await discounts.resolve({ code: "min50", subtotal_minor: 1000, currency: "USD" });
  check("below-min-subtotal", rBelow.reason === R.BELOW_MIN_SUBTOTAL);
  var rAt = await discounts.resolve({ code: "min50", subtotal_minor: 5000, currency: "USD" });
  check("at min subtotal applies", !rAt.reason && rAt.discount_minor === 500);

  // wrong-currency (fixed_off only)
  await discounts.create({ code: "eur500", type: "fixed_off", value_bps_or_minor: 500, currency: "EUR" });
  var rWrongCur = await discounts.resolve({ code: "eur500", subtotal_minor: 10000, currency: "USD" });
  check("wrong-currency", rWrongCur.reason === R.WRONG_CURRENCY);

  // max-uses-exhausted
  await discounts.create({ code: "once", type: "percent_off", value_bps_or_minor: 1000, max_uses: 0 });
  var rOnce = await discounts.resolve({ code: "once", subtotal_minor: 1000, currency: "USD" });
  check("max-uses-exhausted at zero", rOnce.reason === R.MAX_USES_EXHAUSTED);
}

async function _redeem() {
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });
  var d = await discounts.create({ code: "redeemtest", type: "percent_off", value_bps_or_minor: 1500, max_uses: 2 });

  var order = await _seedOrder(query);

  // First redemption — succeeds
  var r1 = await discounts.redeem(d.id, order.id);
  check("redeem returns id",      r1 && r1.id);
  check("redeem links discount",  r1.discount_id === d.id);
  check("redeem links order",     r1.order_id === order.id);

  var afterFirst = await discounts.get(d.id);
  check("uses incremented to 1",  afterFirst.uses === 1);

  // List redemptions
  var page = await discounts.redemptions(d.id);
  check("redemptions ledger has row", page.rows.length === 1);

  // Second redemption — also succeeds (max_uses = 2)
  var order2 = await _seedOrder(query);
  await discounts.redeem(d.id, order2.id);
  var afterSecond = await discounts.get(d.id);
  check("uses incremented to 2",  afterSecond.uses === 2);

  // Third redemption — refused (cap exhausted)
  var order3 = await _seedOrder(query);
  await assert.rejects(discounts.redeem(d.id, order3.id), /max-uses-exhausted/);
  var afterRefused = await discounts.get(d.id);
  check("uses stays at 2 after refusal", afterRefused.uses === 2);

  // resolve sees the now-exhausted code
  var rExhausted = await discounts.resolve({ code: "redeemtest", subtotal_minor: 1000, currency: "USD" });
  check("resolve sees max-uses-exhausted", rExhausted.reason === "max-uses-exhausted");
}

async function _redeemUnlimited() {
  // max_uses = null → unlimited; many redemptions all succeed
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });
  var d = await discounts.create({ code: "unlimited", type: "percent_off", value_bps_or_minor: 500 });
  for (var i = 0; i < 5; i += 1) {
    var o = await _seedOrder(query);
    await discounts.redeem(d.id, o.id);
  }
  var after = await discounts.get(d.id);
  check("unlimited cap allows N redemptions", after.uses === 5);
}

async function _validation() {
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });

  // Bad code shape — too short
  await assert.rejects(discounts.create({ code: "AB", type: "percent_off", value_bps_or_minor: 1000 }), /code must match/);

  // Bad code shape — illegal char
  await assert.rejects(discounts.create({ code: "BAD CODE", type: "percent_off", value_bps_or_minor: 1000 }), /code must match/);

  // Bad code shape — leading hyphen
  await assert.rejects(discounts.create({ code: "-NOPE", type: "percent_off", value_bps_or_minor: 1000 }), /code must match/);

  // Bad type
  await assert.rejects(discounts.create({ code: "TYPETEST", type: "weird", value_bps_or_minor: 1000 }), /type must be/);

  // percent_off > 10000
  await assert.rejects(discounts.create({ code: "TOOMUCH", type: "percent_off", value_bps_or_minor: 10001 }), /capped at 10000/);

  // fixed_off without currency
  await assert.rejects(discounts.create({ code: "NOCUR", type: "fixed_off", value_bps_or_minor: 500 }), /requires a currency/);

  // fixed_off with bad currency
  await assert.rejects(discounts.create({ code: "BADCUR", type: "fixed_off", value_bps_or_minor: 500, currency: "usd" }), /ISO 4217/);

  // percent_off with currency set
  await assert.rejects(discounts.create({ code: "PCTCUR", type: "percent_off", value_bps_or_minor: 1000, currency: "USD" }), /must not carry a currency/);

  // Negative value
  await assert.rejects(discounts.create({ code: "NEGVAL", type: "percent_off", value_bps_or_minor: -1 }), /non-negative integer/);

  // Bad resolve input
  await assert.rejects(discounts.resolve({ code: "any", subtotal_minor: -1, currency: "USD" }), /non-negative integer/);
  await assert.rejects(discounts.resolve({ code: "any", subtotal_minor: 1000, currency: "us" }), /ISO 4217/);
}

async function _resolveEmptyCode() {
  // Empty / missing / null code → unknown-code (doesn't throw)
  var query = _makeQuery();
  var discounts = bShop.discounts.create({ query: query });
  var r1 = await discounts.resolve({ code: "", subtotal_minor: 1000, currency: "USD" });
  check("empty code → unknown",  r1.reason === "unknown-code");
  var r2 = await discounts.resolve({ code: undefined, subtotal_minor: 1000, currency: "USD" });
  check("undefined code → unknown", r2.reason === "unknown-code");
  var r3 = await discounts.resolve({ code: "bad shape!", subtotal_minor: 1000, currency: "USD" });
  check("malformed code → unknown", r3.reason === "unknown-code");
}

async function run() {
  await _crud();
  await _resolveHappyPercent();
  await _resolveHappyFixed();
  await _resolveRefusals();
  await _redeem();
  await _redeemUnlimited();
  await _validation();
  await _resolveEmptyCode();
}

module.exports = { run: run };
