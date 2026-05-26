"use strict";
/**
 * Loyalty — full HTTP integration of the customer rewards surface.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * loyalty + earn-rules + redemption + order + customers deps, against
 * one in-memory `node:sqlite` DB loaded from the live migrations. The
 * customer is read from the sealed `shop_auth` cookie (minted via
 * b.vault.seal after boot). Covers:
 *   - the /account/loyalty page (balance + earn rules + reward catalog
 *     + ledger), login-gated
 *   - earn-on-purchase: the order primitive fans a paid transition into
 *     the earn rules and the points land in the balance
 *   - redeem-a-reward from the catalog (debits points, records the
 *     redemption) + the insufficient-balance / unknown-reward failures
 *   - the auth gate (anon → login)
 *
 * The earn-on-purchase award is fire-and-forget on the transition, so
 * the balance assertion polls via helpers.waitUntil rather than
 * assuming the detached promise settled synchronously.
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql", "0022_loyalty.sql", "0085_loyalty_redemptions.sql",
  "0163_loyalty_earn_rules.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
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

// Seed a pending order with one line + a $50 subtotal for `customerId`.
// Returns the order id so the test can transition it to paid through the
// order primitive (which fires the earn fan-out).
async function _seedPendingOrder(query, customerId, variantId, sku) {
  var now = Date.now();
  var cartId = b.uuid.v7(); var orderId = b.uuid.v7(); var lineId = b.uuid.v7();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'pending', 'USD', 5000, 0, 0, 0, 5000, NULL, '{}', ?5, ?5)",
    [orderId, cartId, customerId, b.uuid.v7(), now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 5000, 'USD', 5000)",
    [lineId, orderId, variantId, sku],
  );
  return orderId;
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-loy-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var query             = _makeQuery();
  var catalog           = bShop.catalog.create({ query: query });
  var cart              = bShop.cart.create({ query: query, catalog: catalog });
  var loyalty           = bShop.loyalty.create({ query: query });
  var loyaltyEarnRules  = bShop.loyaltyEarnRules.create({ query: query, loyalty: loyalty });
  var loyaltyRedemption = bShop.loyaltyRedemption.create({ query: query, loyalty: loyalty });
  var order             = bShop.order.create({ query: query, cursorSecret: "loy-flow-order", loyaltyEarnRules: loyaltyEarnRules });
  var customers         = bShop.customers.create({ query: query });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "x", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });

  // Operator config: 10 points per $1 spent + a flat 25 points per
  // order; a $5 (500-point) reward customers can redeem.
  await loyaltyEarnRules.defineRule({ slug: "spend-10pt-per-dollar", trigger: "per_dollar_spent", points_per_unit: 10 });
  await loyaltyEarnRules.defineRule({ slug: "flat-25-per-order", trigger: "per_purchase", points_per_unit: 25 });
  await loyaltyRedemption.defineReward({
    slug: "five-off", kind: "discount_amount", title: "$5 off", point_cost: 500,
    value_json: { amount_minor: 500 }, active: true,
  });
  await loyaltyRedemption.defineReward({
    slug: "ten-off", kind: "discount_amount", title: "$10 off", point_cost: 1000,
    value_json: { amount_minor: 1000 }, active: true,
  });

  var buyer = b.uuid.v7();

  var handle = await _bootApp({
    catalog: catalog, cart: cart, order: order, customers: customers,
    loyalty: loyalty, loyaltyEarnRules: loyaltyEarnRules, loyaltyRedemption: loyaltyRedemption,
  });

  try {
    var cookie = helpers.authCookie(b, buyer);

    // --- auth gate -----------------------------------------------------
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty" });
    check("anon loyalty then 303 login", anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    // --- zero-balance first load --------------------------------------
    var first = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty", headers: { cookie: cookie } });
    check("loyalty page then 200",          first.status === 200);
    check("zero-balance shows 0 points",    first.body.indexOf("Points balance") !== -1);
    check("how-you-earn lists a rule",      first.body.indexOf("10 points per $1 spent") !== -1);
    check("reward catalog shows the reward", first.body.indexOf("$5 off") !== -1);
    check("empty ledger state",             first.body.indexOf("No points activity yet") !== -1);

    // --- earn-on-purchase ---------------------------------------------
    // Transition a seeded $50 order to paid through the order primitive;
    // the fire-and-forget award posts 10*50 + 25 = 525 points.
    var orderId = await _seedPendingOrder(query, buyer, variant.id, variant.sku);
    await order.transition(orderId, "mark_paid", { reason: "test" });
    await helpers.waitUntil(async function () {
      var bal = await loyalty.balance(buyer);
      return bal.balance >= 525;
    }, { timeoutMs: 5000, label: "loyalty: earn-on-purchase posts 525 points" });
    var balAfterEarn = await loyalty.balance(buyer);
    check("earn-on-purchase posted per_dollar + per_purchase", balAfterEarn.balance === 525);

    // Idempotent re-delivery: a second mark_paid attempt is refused by
    // the order FSM (already paid) so the award never double-fires; and
    // even a direct re-award is deduped on trigger_event_ref.
    var reAward = await loyaltyEarnRules.awardForEvent({
      trigger: "per_dollar_spent", customer_id: buyer, dollars_spent: 50,
      trigger_event_ref: "order:" + orderId,
    });
    check("re-award deduped on trigger_event_ref", reAward.awarded.length === 0 && reAward.skipped.length === 1);
    var balAfterDedup = await loyalty.balance(buyer);
    check("balance unchanged after dedup", balAfterDedup.balance === 525);

    // --- page reflects the earned balance -----------------------------
    var loaded = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty", headers: { cookie: cookie } });
    check("page shows earned balance",  loaded.body.indexOf("525") !== -1);
    check("ledger shows an earn row",   loaded.body.indexOf("loyalty-tx--earn") !== -1);
    check("affordable reward redeemable", loaded.body.indexOf(">Redeem<") !== -1);
    check("unaffordable reward disabled", loaded.body.indexOf("Not enough points") !== -1);

    // --- redeem a reward ----------------------------------------------
    var redeem = await helpers.httpRequest({
      port: handle.port, path: "/account/loyalty/redeem", method: "POST",
      headers: { cookie: cookie }, form: { reward_slug: "five-off" },
    });
    check("redeem reward then 303", redeem.status === 303 && (redeem.headers["location"] || "") === "/account/loyalty");
    var balAfterRedeem = await loyalty.balance(buyer);
    check("redeem debited 500 points", balAfterRedeem.balance === 25);
    var reds = await loyaltyRedemption.redemptionsForCustomer(buyer, { limit: 10 });
    check("redemption recorded active", reds.rows.length === 1 && reds.rows[0].status === "active" && reds.rows[0].reward_slug === "five-off");

    // --- redeem failure modes -----------------------------------------
    // Insufficient balance (25 points left, $10-off costs 1000).
    var poor = await helpers.httpRequest({
      port: handle.port, path: "/account/loyalty/redeem", method: "POST",
      headers: { cookie: cookie }, form: { reward_slug: "ten-off" },
    });
    check("insufficient redeem then 400",   poor.status === 400);
    check("insufficient shows a message",   poor.body.indexOf("enough points for that reward") !== -1);

    // Unknown reward slug → 400 re-render (TypeError, not 500).
    var unknown = await helpers.httpRequest({
      port: handle.port, path: "/account/loyalty/redeem", method: "POST",
      headers: { cookie: cookie }, form: { reward_slug: "does-not-exist" },
    });
    check("unknown reward then 400",        unknown.status === 400);

    // Anon redeem → 303 login (gate covers the POST too).
    var anonRedeem = await helpers.httpRequest({
      port: handle.port, path: "/account/loyalty/redeem", method: "POST",
      form: { reward_slug: "five-off" },
    });
    check("anon redeem then 303 login", anonRedeem.status === 303 && (anonRedeem.headers["location"] || "") === "/account/login");

    // --- malformed history cursor degrades, never 500 ----------------
    var badCursor = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty?cursor=not-a-number", headers: { cookie: cookie } });
    check("malformed cursor then 200", badCursor.status === 200);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
