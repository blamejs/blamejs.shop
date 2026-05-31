"use strict";
/**
 * Loyalty console — browser-side admin manager for the loyalty program
 * the storefront already exposes to customers at /account/loyalty.
 *
 * Boots one b.createApp with BOTH the admin console (admin.mount with
 * token + catalog + order + config + loyalty + loyaltyEarnRules +
 * loyaltyRedemption) and the storefront (so the customer-facing
 * /account/loyalty reflects what the operator configures). One in-memory
 * node:sqlite DB loaded from the live loyalty migrations backs both.
 *
 * Exercises the whole program from the console:
 *   - the Loyalty overview (tiers + ratios + earn/reward summaries +
 *     adjustment form), HTML + bearer JSON, and the auth gate
 *   - EARN RULES: create via the browser form -> appears in the admin
 *     list AND (active) on the customer /account/loyalty page; edit
 *     points/unit; archive removes it from the customer page
 *   - REWARDS CATALOG: create an ACTIVE reward -> appears in the admin
 *     list AND the customer catalog; an inactive reward is hidden from
 *     the customer; archive removes it
 *   - POINTS ADJUSTMENT: grant points for a customer with a reason ->
 *     the balance changes and a ledger row records the reason; a deduct
 *     with a reason; the bad paths (missing reason / non-integer amount /
 *     bad customer id / over-deduction) are clean 4xx with NO change and
 *     no raw-error leak
 *   - the bearer JSON contract on each create path
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

var TOKEN = "admin-token-0123456789abcdef-loyalty";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0006_customers.sql",
  "0022_loyalty.sql", "0085_loyalty_redemptions.sql", "0163_loyalty_earn_rules.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _post(port, path, jar, form, extraHeaders) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST", jar: jar, form: form,
    headers: extraHeaders || undefined,
  });
}

async function _run() {
  var query             = _makeQuery();
  var catalog           = bShop.catalog.create({ query: query });
  var cart              = bShop.cart.create({ query: query, catalog: catalog });
  var order             = bShop.order.create({ query: query, cursorSecret: "loy-console-order" });
  var config            = bShop.config.create({ query: query });
  var customers         = bShop.customers.create({ query: query });
  var loyalty           = bShop.loyalty.create({ query: query });
  var loyaltyEarnRules  = bShop.loyaltyEarnRules.create({ query: query, loyalty: loyalty });
  var loyaltyRedemption = bShop.loyaltyRedemption.create({ query: query, loyalty: loyalty });

  // A customer the adjustment targets. The loyalty primitive keys on a
  // strict UUID customer_id — the same id the customers roster shows.
  var buyer = b.uuid.v7();
  await loyalty.ensureAccount(buyer);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-loy-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        customers: customers,
        loyalty: loyalty, loyaltyEarnRules: loyaltyEarnRules, loyaltyRedemption: loyaltyRedemption,
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        loyalty: loyalty, loyaltyEarnRules: loyaltyEarnRules, loyaltyRedemption: loyaltyRedemption,
        config: { shop_name: "Test Shop" },
      });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- overview ------------------------------------------------------
    var overview = await helpers.httpRequest({ port: port, path: "/admin/loyalty", jar: jar });
    check("loyalty overview then 200",       overview.status === 200);
    check("nav includes Loyalty",            overview.body.indexOf("\"/admin/loyalty\"") !== -1);
    check("overview shows the tier table",   overview.body.indexOf("Tiers") !== -1 && overview.body.indexOf("bronze") !== -1);
    check("overview shows the adjustment form", overview.body.indexOf("Adjust a customer's points") !== -1 && overview.body.indexOf("name=\"reason\"") !== -1);
    check("overview links earn-rule + reward management",
      overview.body.indexOf("/admin/loyalty/earn-rules") !== -1 && overview.body.indexOf("/admin/loyalty/rewards") !== -1);

    var overviewApi = await helpers.httpRequest({ port: port, path: "/admin/loyalty", headers: bearer });
    check("overview API JSON",               (overviewApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("overview API carries ratios",     JSON.parse(overviewApi.body).points_per_usd === loyalty.POINTS_PER_USD);

    // ---- earn rules: create via the browser form -----------------------
    var earnCreate = await _post(port, "/admin/loyalty/earn-rules", jar, {
      slug: "spend-1pt-per-dollar", trigger: "per_dollar_spent", points_per_unit: "1", active: "on",
    });
    check("earn-rule create then 303",       earnCreate.status === 303);
    check("earn-rule create redirects created", (earnCreate.headers.location || "").indexOf("created=1") !== -1);
    var rulesAfter = await loyaltyEarnRules.listRules({ limit: 50 });
    check("earn rule persisted",             rulesAfter.length === 1 && rulesAfter[0].slug === "spend-1pt-per-dollar");
    check("earn rule active + correct mult", rulesAfter[0].active === true && rulesAfter[0].points_per_unit === 1);

    // It appears in the admin earn-rules list.
    var earnList = await helpers.httpRequest({ port: port, path: "/admin/loyalty/earn-rules", jar: jar });
    check("admin earn list shows the rule",  earnList.body.indexOf("spend-1pt-per-dollar") !== -1);
    var earnListApi = await helpers.httpRequest({ port: port, path: "/admin/loyalty/earn-rules", headers: bearer });
    check("admin earn list API rows",        JSON.parse(earnListApi.body).rows.length === 1);

    // It appears on the customer-facing /account/loyalty (active rule).
    var custJar = helpers.cookieJar();
    custJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });
    var custPage1 = await helpers.httpRequest({ port: port, path: "/account/loyalty", jar: custJar });
    check("customer page then 200",          custPage1.status === 200);
    check("customer page shows the active rule", custPage1.body.indexOf("1 points per $1 spent") !== -1);

    // ---- earn rule: edit points/unit -----------------------------------
    var earnEdit = await _post(port, "/admin/loyalty/earn-rules/spend-1pt-per-dollar/edit", jar, {
      points_per_unit: "3", active: "on", active_present: "1",
    });
    check("earn-rule edit then 303",         earnEdit.status === 303);
    check("earn-rule edit redirects saved",  (earnEdit.headers.location || "").indexOf("saved=1") !== -1);
    var ruleEdited = await loyaltyEarnRules.getRule("spend-1pt-per-dollar");
    check("earn rule multiplier updated",    ruleEdited.points_per_unit === 3);

    // ---- earn rule: archive removes it from the customer page ----------
    var earnArchive = await helpers.httpRequest({ port: port, path: "/admin/loyalty/earn-rules/spend-1pt-per-dollar/archive", method: "POST", jar: jar });
    check("earn-rule archive then 303",      earnArchive.status === 303);
    var ruleArchived = await loyaltyEarnRules.getRule("spend-1pt-per-dollar");
    check("earn rule archived + inactive",   ruleArchived.archived_at != null && ruleArchived.active === false);
    var custAfterArchive = await helpers.httpRequest({ port: port, path: "/account/loyalty", jar: custJar });
    check("archived rule gone from customer page", custAfterArchive.body.indexOf("per $1 spent") === -1);

    // ---- rewards: create an ACTIVE reward ------------------------------
    var rewardCreate = await _post(port, "/admin/loyalty/rewards", jar, {
      slug: "five-off", kind: "discount_amount", title: "$5 off your order",
      point_cost: "500", value_number: "500", active: "on",
    });
    check("reward create then 303",          rewardCreate.status === 303);
    check("reward create redirects created", (rewardCreate.headers.location || "").indexOf("created=1") !== -1);
    var rewardRow = await loyaltyRedemption.getReward("five-off");
    check("reward persisted active",         rewardRow && rewardRow.active === true && rewardRow.point_cost === 500);
    check("reward value_json built per kind", rewardRow.value_json.amount_minor === 500);

    var rewardList = await helpers.httpRequest({ port: port, path: "/admin/loyalty/rewards", jar: jar });
    check("admin reward list shows it",      rewardList.body.indexOf("$5 off your order") !== -1);
    var custWithReward = await helpers.httpRequest({ port: port, path: "/account/loyalty", jar: custJar });
    check("active reward shows to customer", custWithReward.body.indexOf("$5 off your order") !== -1);

    // ---- rewards: an INACTIVE reward is hidden from the customer -------
    var inactiveCreate = await _post(port, "/admin/loyalty/rewards", jar, {
      slug: "hidden-ten", kind: "discount_amount", title: "Hidden $10 off",
      point_cost: "1000", value_number: "1000",   // no active checkbox -> inactive
    });
    check("inactive reward create then 303", inactiveCreate.status === 303);
    var hiddenRow = await loyaltyRedemption.getReward("hidden-ten");
    check("inactive reward stored inactive", hiddenRow && hiddenRow.active === false);
    var custInactive = await helpers.httpRequest({ port: port, path: "/account/loyalty", jar: custJar });
    check("inactive reward hidden from customer", custInactive.body.indexOf("Hidden $10 off") === -1);
    check("active reward still visible",     custInactive.body.indexOf("$5 off your order") !== -1);

    // ---- rewards: archive removes from customer ------------------------
    var rewardArchive = await helpers.httpRequest({ port: port, path: "/admin/loyalty/rewards/five-off/archive", method: "POST", jar: jar });
    check("reward archive then 303",         rewardArchive.status === 303);
    var custAfterRewardArchive = await helpers.httpRequest({ port: port, path: "/account/loyalty", jar: custJar });
    check("archived reward gone from customer", custAfterRewardArchive.body.indexOf("$5 off your order") === -1);

    // ---- points adjustment: grant with a reason ------------------------
    var balBefore = await loyalty.balance(buyer);
    check("buyer starts at zero",            balBefore.balance === 0);
    var grant = await _post(port, "/admin/loyalty/adjust", jar, {
      customer_id: buyer, direction: "grant", amount: "250", reason: "service recovery for order 1234",
    });
    check("grant then 303",                  grant.status === 303);
    check("grant redirects adjusted",        (grant.headers.location || "").indexOf("adjusted=1") !== -1);
    var balAfterGrant = await loyalty.balance(buyer);
    check("grant credited 250 points",       balAfterGrant.balance === 250);
    check("grant counted toward lifetime",   balAfterGrant.lifetime === 250);

    // The adjustment is recorded in the ledger WITH the reason in notes.
    var hist = await loyalty.history(buyer, { limit: 10 });
    var adjRow = hist.rows.filter(function (t) { return t.transaction_type === "adjust"; })[0];
    check("ledger recorded the adjustment",  !!adjRow && adjRow.points === 250);
    check("ledger row carries the reason",   adjRow.notes === "service recovery for order 1234");
    check("ledger row source is admin",      adjRow.source === "admin-adjustment");

    // The reason also surfaces on the customer's ledger.
    var custAfterGrant = await helpers.httpRequest({ port: port, path: "/account/loyalty", jar: custJar });
    check("customer sees the adjusted balance", custAfterGrant.body.indexOf("250") !== -1);
    check("customer ledger shows the reason", custAfterGrant.body.indexOf("service recovery for order 1234") !== -1);

    // ---- points adjustment: deduct with a reason -----------------------
    var deduct = await _post(port, "/admin/loyalty/adjust", jar, {
      customer_id: buyer, direction: "deduct", amount: "100", reason: "reversing a duplicate credit",
    });
    check("deduct then 303",                 deduct.status === 303);
    var balAfterDeduct = await loyalty.balance(buyer);
    check("deduct removed 100 points",       balAfterDeduct.balance === 150);
    check("deduct did NOT lower lifetime",   balAfterDeduct.lifetime === 250);

    // ---- bad adjustments: clean 4xx, no change, no raw-error leak ------
    // (1) missing reason.
    var noReason = await _post(port, "/admin/loyalty/adjust", jar, {
      customer_id: buyer, direction: "grant", amount: "50",
    });
    check("missing reason then 400",         noReason.status === 400);
    check("missing reason surfaces the requirement", noReason.body.indexOf("reason is required") !== -1);
    check("missing reason: no balance change", (await loyalty.balance(buyer)).balance === 150);

    // (2) non-integer amount.
    var badAmount = await _post(port, "/admin/loyalty/adjust", jar, {
      customer_id: buyer, direction: "grant", amount: "12.5", reason: "x",
    });
    check("non-integer amount then 400",     badAmount.status === 400);
    check("non-integer amount: no balance change", (await loyalty.balance(buyer)).balance === 150);

    // (3) zero amount.
    var zero = await _post(port, "/admin/loyalty/adjust", jar, {
      customer_id: buyer, direction: "grant", amount: "0", reason: "x",
    });
    check("zero amount then 400",            zero.status === 400);

    // (4) malformed customer id (loyalty.adjust throws a TypeError -> 400).
    var badCid = await _post(port, "/admin/loyalty/adjust", jar, {
      customer_id: "not-a-uuid", direction: "grant", amount: "50", reason: "x",
    });
    check("bad customer id then 400",        badCid.status === 400);

    // (5) over-deduction (balance 150, deduct 9999) -> 409, no change.
    var over = await _post(port, "/admin/loyalty/adjust", jar, {
      customer_id: buyer, direction: "deduct", amount: "9999", reason: "too much",
    });
    check("over-deduction then 409",         over.status === 409);
    check("over-deduction: no balance change", (await loyalty.balance(buyer)).balance === 150);
    check("over-deduction shows a clean message", over.body.indexOf("below zero") !== -1);

    // No bad path leaked a raw primitive/SQL string into the banner.
    [noReason, badAmount, zero, badCid, over].forEach(function (resp, idx) {
      check("bad adjust #" + idx + " leaks no SQL", resp.body.indexOf("SQLITE") === -1 && resp.body.indexOf("constraint failed") === -1);
      check("bad adjust #" + idx + " leaks no internal prefix", resp.body.indexOf("loyalty.adjust:") === -1);
    });

    // ---- bearer JSON contract on a create path -------------------------
    var apiEarn = await helpers.httpRequest({
      port: port, path: "/admin/loyalty/earn-rules", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "signup-bonus-100", trigger: "signup_bonus", points_per_unit: 100, active: true }),
    });
    check("bearer earn-rule create 201 JSON", apiEarn.status === 201 && (apiEarn.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer earn-rule persisted",       (await loyaltyEarnRules.getRule("signup-bonus-100")) != null);

    var apiReward = await helpers.httpRequest({
      port: port, path: "/admin/loyalty/rewards", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "free-ship", kind: "free_shipping", title: "Free shipping", point_cost: 300, value_json: {}, active: true }),
    });
    check("bearer reward create 201 JSON",    apiReward.status === 201);
    check("bearer reward persisted",          (await loyaltyRedemption.getReward("free-ship")) != null);

    var apiAdjust = await helpers.httpRequest({
      port: port, path: "/admin/loyalty/adjust", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ customer_id: buyer, direction: "grant", amount: 10, reason: "api credit" }),
    });
    check("bearer adjust 200 JSON",           apiAdjust.status === 200);
    check("bearer adjust applied",            (await loyalty.balance(buyer)).balance === 160);

    var apiAdjustNoReason = await helpers.httpRequest({
      port: port, path: "/admin/loyalty/adjust", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ customer_id: buyer, direction: "grant", amount: 10 }),
    });
    check("bearer adjust missing reason then 400", apiAdjustNoReason.status === 400);
    check("bearer missing reason: no change", (await loyalty.balance(buyer)).balance === 160);

    // ---- auth gate -----------------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: "/admin/loyalty" });
    check("anon loyalty console → login form", anon.body.indexOf("Admin API key") !== -1);
    var anonAdjust = await helpers.httpRequest({
      port: port, path: "/admin/loyalty/adjust", method: "POST",
      form: { customer_id: buyer, direction: "grant", amount: "10", reason: "x" },
    });
    check("anon adjust does not 5xx",        anonAdjust.status < 500);
    check("anon adjust did not apply",       (await loyalty.balance(buyer)).balance === 160);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
