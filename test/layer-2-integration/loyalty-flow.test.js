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
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql", "0022_loyalty.sql", "0237_loyalty_txn_running_balance.sql", "0085_loyalty_redemptions.sql",
  "0163_loyalty_earn_rules.sql", "0217_loyalty_earn_reversal.sql",
  "0223_loyalty_txn_restored_points.sql", "0224_loyalty_earn_clawed_points.sql",
  "0141_tier_benefits.sql",
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

// Same as above but with $20 of (non-refundable) shipping on top of the
// $50 goods — subtotal 5000, shipping 2000, grand total 7000. Points are
// still earned on the 5000 subtotal.
async function _seedPendingOrderWithShipping(query, customerId, variantId, sku) {
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
    "VALUES (?1, ?2, ?3, ?4, 'pending', 'USD', 5000, 0, 0, 2000, 7000, NULL, '{}', ?5, ?5)",
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
  var tierBenefits      = bShop.tierBenefits.create({ query: query, loyalty: loyalty });
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

  // Tier benefits the operator authored. The buyer climbs to lifetime
  // 1050 below → SILVER tier (threshold 500), so the silver perks must
  // surface on their rewards page; the gold perk must NOT (wrong tier).
  await tierBenefits.defineBenefit({
    slug: "silver-free-ship", tier: "silver", kind: "free_shipping", value: { min_order_minor: 5000 },
  });
  await tierBenefits.defineBenefit({
    slug: "silver-early", tier: "silver", kind: "early_access", value: { hours: 24 },
  });
  await tierBenefits.defineBenefit({
    slug: "gold-15-off", tier: "gold", kind: "percent_off", value: { percent: 15 },
  });

  var buyer = b.uuid.v7();

  var handle = await _bootApp({
    catalog: catalog, cart: cart, order: order, customers: customers,
    loyalty: loyalty, loyaltyEarnRules: loyaltyEarnRules, loyaltyRedemption: loyaltyRedemption,
    tierBenefits: tierBenefits,
  });

  try {
    // A cookie jar (not a bare cookie header) so the double-submit CSRF
    // cookie set on the first authenticated GET is captured and echoed as
    // X-CSRF-Token on the redeem POSTs — the real gate, no bypass.
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // --- auth gate -----------------------------------------------------
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty" });
    check("anon loyalty then 303 login", anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    // --- zero-balance first load --------------------------------------
    var first = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty", jar: jar });
    check("loyalty page then 200",          first.status === 200);
    check("zero-balance shows 0 points",    first.body.indexOf("Points balance") !== -1);
    check("how-you-earn lists a rule",      first.body.indexOf("10 points per $1 spent") !== -1);
    check("reward catalog shows the reward", first.body.indexOf("$5 off") !== -1);
    check("empty ledger state",             first.body.indexOf("No points activity yet") !== -1);

    // --- tier progress + benefits at bronze (zero lifetime) -----------
    // A fresh account is bronze; the page shows progress toward silver
    // (500 lifetime points away) and NO benefits yet (bronze has none).
    check("progress section present",       first.body.indexOf("Your tier progress") !== -1);
    check("progress to silver remaining",   first.body.indexOf("500") !== -1 && first.body.indexOf("to reach") !== -1);
    check("bronze sees no tier benefits",   first.body.indexOf("Free shipping on orders over") === -1);
    check("bronze hides benefits heading",  first.body.indexOf("tier includes") === -1);

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
    var loaded = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty", jar: jar });
    check("page shows earned balance",  loaded.body.indexOf("525") !== -1);
    check("ledger shows an earn row",   loaded.body.indexOf("loyalty-tx--earn") !== -1);
    check("affordable reward redeemable", loaded.body.indexOf(">Redeem<") !== -1);
    check("unaffordable reward disabled", loaded.body.indexOf("Not enough points") !== -1);

    // --- tier benefits at silver (lifetime 525 ≥ 500) -----------------
    // The buyer is now silver, so their rewards page lists the SILVER
    // perks the operator authored — and not the gold one. The framing is
    // "what your silver tier includes" (an inclusion, not an auto-applied
    // guarantee), with the honest checkout footnote.
    check("silver benefits heading",        loaded.body.indexOf("what your silver tier includes".replace("what", "What")) !== -1);
    check("silver free-shipping perk",      loaded.body.indexOf("Free shipping on orders over") !== -1);
    check("silver early-access perk",       loaded.body.indexOf("shop new drops 24 hours before") !== -1);
    check("gold perk hidden at silver",     loaded.body.indexOf("15% off your order") === -1);
    check("honest non-auto framing",        loaded.body.indexOf("not applied automatically") !== -1 || loaded.body.indexOf("Ask at checkout or contact support") !== -1);
    // Progress now targets gold (2000 lifetime); 2000 − 1050-on-page... at
    // this point lifetime is 525, so 1475 remaining to gold.
    check("progress targets gold next",     loaded.body.indexOf("to reach <strong>gold</strong>") !== -1);

    // --- earn-reversal on refund --------------------------------------
    // A buy-then-refund must claw the awarded points back off the
    // balance, or a customer farms rewards for free. Seed + pay a second
    // $50 order (another 525 points → 1050 total), then refund it through
    // the order FSM. The reversal is fire-and-forget on the transition,
    // so poll for the balance to settle back to 525.
    var refundOrderId = await _seedPendingOrder(query, buyer, variant.id, variant.sku);
    await order.transition(refundOrderId, "mark_paid", { reason: "test" });
    await helpers.waitUntil(async function () {
      var bal = await loyalty.balance(buyer);
      return bal.balance >= 1050;
    }, { timeoutMs: 5000, label: "loyalty: second purchase posts 525 more points" });
    check("second purchase posted to 1050", (await loyalty.balance(buyer)).balance === 1050);

    await order.transition(refundOrderId, "refund", { reason: "test refund" });
    await helpers.waitUntil(async function () {
      var bal = await loyalty.balance(buyer);
      return bal.balance <= 525;
    }, { timeoutMs: 5000, label: "loyalty: refund reverses the 525 awarded points" });
    var balAfterRefund = await loyalty.balance(buyer);
    check("refund clawed the 525 back to 525", balAfterRefund.balance === 525);
    // Lifetime is not decremented — tier never downgrades retroactively.
    check("refund left lifetime at 1050", balAfterRefund.lifetime === 1050);

    // Idempotent: a re-delivered refund (or the reaper) doesn't double-claw.
    var reRev = await loyaltyEarnRules.reverseForEvent({
      customer_id: buyer, trigger_event_ref: "order:" + refundOrderId,
    });
    check("re-reverse is a no-op", reRev.reversed_points === 0 && reRev.clawed_points === 0);
    check("balance unchanged after re-reverse", (await loyalty.balance(buyer)).balance === 525);

    // --- partial goods refund keeps non-refundable shipping -> 100% claw ---
    // Points are earned on the SUBTOTAL (goods). Refunding the full $50 goods
    // value must claw ALL earned points even though the $20 shipping is kept,
    // because the claw ratios against the subtotal, not the grand total.
    // Against the grand total this would claw only floor(525*5000/7000)=375,
    // leaving the customer 150 free points on fully-returned goods.
    var shipOrderId = await _seedPendingOrderWithShipping(query, buyer, variant.id, variant.sku);
    await order.transition(shipOrderId, "mark_paid", { reason: "test" });
    await helpers.waitUntil(async function () {
      return (await loyalty.balance(buyer)).balance >= 1050;
    }, { timeoutMs: 5000, label: "loyalty: shipping order earned 525 on subtotal" });
    check("shipping order earned 525 on subtotal", (await loyalty.balance(buyer)).balance === 1050);
    await order.recordPartialRefund(shipOrderId, { amount_minor: 5000, metadata: { stripe_refund_id: "re_ship_goods_1" } });
    await helpers.waitUntil(async function () {
      return (await loyalty.balance(buyer)).balance <= 525;
    }, { timeoutMs: 5000, label: "loyalty: full goods refund claws all earned points (shipping kept)" });
    check("full goods refund clawed all 525 (shipping kept)", (await loyalty.balance(buyer)).balance === 525);

    // --- redeem a reward ----------------------------------------------
    var redeem = await helpers.httpRequest({
      port: handle.port, path: "/account/loyalty/redeem", method: "POST",
      jar: jar, form: { reward_slug: "five-off" },
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
      jar: jar, form: { reward_slug: "ten-off" },
    });
    check("insufficient redeem then 400",   poor.status === 400);
    check("insufficient shows a message",   poor.body.indexOf("enough points for that reward") !== -1);

    // Unknown reward slug → 400 re-render (TypeError, not 500).
    var unknown = await helpers.httpRequest({
      port: handle.port, path: "/account/loyalty/redeem", method: "POST",
      jar: jar, form: { reward_slug: "does-not-exist" },
    });
    check("unknown reward then 400",        unknown.status === 400);

    // Anon redeem → 303 login (gate covers the POST too).
    var anonRedeem = await helpers.httpRequest({
      port: handle.port, path: "/account/loyalty/redeem", method: "POST",
      form: { reward_slug: "five-off" },
    });
    check("anon redeem then 303 login", anonRedeem.status === 303 && (anonRedeem.headers["location"] || "") === "/account/login");

    // --- malformed history cursor degrades, never 500 ----------------
    var badCursor = await helpers.httpRequest({ port: handle.port, path: "/account/loyalty?cursor=not-a-number", jar: jar });
    check("malformed cursor then 200", badCursor.status === 200);

    // --- benefit labels are escaped (stored-XSS defense) --------------
    // The primitive validates tier/value shapes, so HTML can't reach the
    // label through the authoring path — but the renderer is manual HTML
    // concat, so it must escape DEFENSIVELY. Drive renderLoyalty directly
    // with a hostile benefit object (a tier carrying a <script> payload
    // and a collection slug carrying one) and assert neither escapes raw.
    var XSS = "<script>alert(1)</script>";
    var hostileHtml = bShop.storefront.renderLoyalty({
      balance: { balance: 600, lifetime: 600, tier: XSS },
      tiers: loyalty.TIERS,
      tier_thresholds: loyalty.TIER_THRESHOLDS,
      redemption_points_per_usd: 100,
      tier_benefits: [
        { slug: "x", tier: XSS, kind: "exclusive_access", value: { collection_slug: XSS }, conditions: null },
      ],
      history: [], earn_rules: [], rewards: [], redemptions: [],
      shop_name: "T", cart_count: 0,
    });
    check("hostile benefit not raw in page",  hostileHtml.indexOf(XSS) === -1);
    check("hostile benefit escaped",          hostileHtml.indexOf("&lt;script&gt;") !== -1);
  } finally {
    await _teardown(handle);
  }

  // --- progress-to-next helper (pure) ---------------------------------
  // Re-asserts the maths the live page renders, independent of HTTP, so a
  // threshold/ladder regression is caught even if the page markup shifts.
  var th = bShop.loyalty.DEFAULT_TIER_THRESHOLDS;
  var ladder = bShop.loyalty.TIERS;
  // The renderLoyalty progress helper isn't exported, but the rendered
  // page already asserts the copy; here we re-derive the expected values
  // from computeTier to pin the tier boundaries themselves.
  var loy2 = bShop.loyalty.create({ query: _makeQuery() });
  check("computeTier bronze at 0",     loy2.computeTier(0) === "bronze");
  check("computeTier silver at floor", loy2.computeTier(th.silver) === "silver");
  check("computeTier gold at floor",   loy2.computeTier(th.gold) === "gold");
  check("computeTier platinum at top", loy2.computeTier(th.platinum) === "platinum");
  void ladder;
}

module.exports = { run: _run };
