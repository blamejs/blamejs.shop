"use strict";
/**
 * Gift cards — full HTTP integration across the storefront checkout, the
 * customer balance-check page, and the admin ledger console.
 *
 * Boots a real b.createApp with the storefront (checkout wired with a stub
 * Stripe payment + the giftcards/ledger primitives) and the admin console
 * mounted on the same router, sharing one in-memory SQLite query handle.
 *
 * Exercises:
 *   - admin issues a card (browser form + bearer JSON), code shown once
 *   - customer checks a balance (generic not-found for unknown/empty codes)
 *   - redeem at checkout reduces the amount due by the card balance, and
 *     the order records the full grand total it owed
 *   - a SECOND redeem of the same card on a new order uses only the
 *     REMAINING balance (no double-spend)
 *   - a card that fully covers the order pays it with no Stripe intent
 *   - the admin ledger lists the card + its transactions
 *   - an invalid/empty code is handled gracefully (no 500)
 *
 * Network: zero — every request lands on 127.0.0.1; payment is a stub.
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

var TOKEN = "admin-token-0123456789abcdef-gc-test";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0013_giftcards.sql", "0081_gift_card_ledger.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
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

// Stub Stripe payment adapter — captures the amount each PaymentIntent
// was created for so the test can assert the gift-card credit reduced it.
function _stubPayment() {
  var n = 0;
  var intents = [];
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      n += 1;
      intents.push({ amount_minor: input.amount_minor, currency: input.currency, metadata: input.metadata });
      return { id: "pi_" + n, client_secret: "pi_" + n + "_secret", status: "requires_payment_method" };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
    _intents: intents,
  };
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query, cursorSecret: "gc-sf" });
  var config   = bShop.config.create({ query: query });
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = _stubPayment();
  var giftcards = bShop.giftcards.create({ query: query });
  var ledger    = bShop.giftCardLedger.create({ query: query });
  var checkout  = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping,
    payment: payment, order: order, giftcards: giftcards, giftCardLedger: ledger,
  });

  // Seed a product priced at $30.00 so a $50 card covers it (zero-due)
  // and a $5 card partially covers it.
  var p = await catalog.products.create({ slug: "gc-prod", title: "GC Prod", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "GC-1", weight_grams: 100 });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 3000 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-gc-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        giftcards: giftcards, giftCardLedger: ledger, shop_name: "Test Shop",
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, checkout: checkout,
        giftcards: giftcards, default_shipping_id: "std",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  // Helper: seed a fresh active session cart with one unit of the product.
  // The trailing GET /cart seeds the double-submit CSRF cookie into the
  // jar so the checkout POST below carries a real X-CSRF-Token (the gate
  // is exercised, never bypassed).
  async function _freshCart() {
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: v.id, qty: 1 });
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/"] });
    await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    return jar;
  }

  try {
    // ---- admin issues a $5 card via the bearer JSON API ----------------
    var apiIssue = await helpers.httpRequest({
      port: port, path: "/admin/gift-cards", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount_minor: 500, currency: "USD" }),
    });
    check("admin issue then 201 JSON",        apiIssue.status === 201 && (apiIssue.headers["content-type"] || "").indexOf("application/json") === 0);
    var fiveCard = JSON.parse(apiIssue.body);
    check("issue returns plaintext code once", typeof fiveCard.code === "string" && fiveCard.code.length >= 16);
    check("issue returns a card id",           typeof fiveCard.id === "string");

    // ---- admin issues a $50 card via the browser form -----------------
    var jarAdmin = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jarAdmin });
    check("admin login then 303",             login.status === 303);
    var formIssue = await helpers.httpRequest({
      port: port, path: "/admin/gift-cards", method: "POST", jar: jarAdmin,
      form: { amount_minor: "5000", currency: "USD" },
    });
    // PRG: a refresh of the detail page can't re-issue. The one-time code
    // travels in a sealed HttpOnly cookie set on this 303 redirect — never
    // in the URL / Location header / browser history / access logs.
    check("form issue then 303 (PRG)",        formIssue.status === 303);
    check("redirect carries no code in URL",  (formIssue.headers.location || "").indexOf("/admin/gift-cards/") === 0 &&
                                              (formIssue.headers.location || "").indexOf("issued=") === -1);
    // Following the redirect reveals the code once (from the sealed cookie).
    var reveal = await helpers.httpRequest({ port: port, path: formIssue.headers.location, jar: jarAdmin });
    check("detail reveals code once",         reveal.body.indexOf("shown once") !== -1);
    var fiftyMatch = reveal.body.match(/Copy the code now[^<]*<code[^>]*>([^<]+)<\/code>/);
    var fiftyCode = fiftyMatch ? fiftyMatch[1] : "";
    check("recovered $50 code",               fiftyCode.length >= 16);
    // A reload no longer reveals the code (one-time cookie consumed).
    var reload = await helpers.httpRequest({ port: port, path: formIssue.headers.location, jar: jarAdmin });
    check("reload does not re-reveal code",   reload.body.indexOf("shown once") === -1);

    // ---- customer balance check ---------------------------------------
    var balPage = await helpers.httpRequest({ port: port, path: "/gift-cards" });
    check("balance page then 200",            balPage.status === 200 && balPage.body.indexOf("Check a gift card balance") !== -1);
    var balOk = await helpers.httpRequest({ port: port, path: "/gift-cards/balance", method: "POST", form: { code: fiveCard.code } });
    check("balance shows $5.00",              balOk.status === 200 && balOk.body.indexOf("$5.00") !== -1);
    var balUnknown = await helpers.httpRequest({ port: port, path: "/gift-cards/balance", method: "POST", form: { code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" } });
    check("unknown code → generic not-found", balUnknown.status === 200 && balUnknown.body.indexOf("couldn't find a balance") !== -1);
    var balMalformed = await helpers.httpRequest({ port: port, path: "/gift-cards/balance", method: "POST", form: { code: "not-a-code" } });
    check("malformed code → not 500",         balMalformed.status === 200 && balMalformed.body.indexOf("couldn't find a balance") !== -1);
    var balEmpty = await helpers.httpRequest({ port: port, path: "/gift-cards/balance", method: "POST", form: { code: "" } });
    check("empty code → not 500",             balEmpty.status === 200 && balEmpty.body.indexOf("couldn't find a balance") !== -1);

    // ---- redeem the $5 card at checkout (partial credit) --------------
    // Order is $30.00; $5 card → amount due $25.00.
    var jar1 = await _freshCart();
    var co1 = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar1,
      form: { email: "buyer@example.com", name: "Buyer", country: "US", postal: "94103", gift_card_code: fiveCard.code },
    });
    check("checkout w/ $5 card then 303",     co1.status === 303 && (co1.headers.location || "").indexOf("/pay/") === 0);
    // The PaymentIntent was created for $25.00 (3000 - 500), not $30.00.
    var firstIntent = payment._intents[payment._intents.length - 1];
    check("PI amount reduced by $5 credit",   firstIntent && firstIntent.amount_minor === 2500);
    check("PI metadata records credit",       firstIntent && firstIntent.metadata.gift_card_applied_minor === "500");

    var orderId1 = (co1.headers.location || "").replace("/pay/", "");
    var o1 = await order.get(orderId1);
    check("order records full grand total",   o1 && o1.grand_total_minor === 3000);

    // The card is fully spent ($5 of $5) → status redeemed, balance 0.
    var afterFive = await giftcards.balance(fiveCard.code);
    check("$5 card now zero balance",         afterFive && afterFive.balance_minor === 0);
    check("$5 card now redeemed",             afterFive && afterFive.status === "redeemed");

    // The ledger recorded EXACTLY ONE debit for this order.
    var ledgerForOrder1 = await ledger.transactionsForOrder(orderId1);
    var debits1 = ledgerForOrder1.filter(function (t) { return t.kind === "debit"; });
    check("ledger has exactly one debit",     debits1.length === 1 && debits1[0].amount_minor === 500);

    // ---- no double-spend: a re-used card spends only its remainder ----
    // Issue a $40 card. The order is $30, so the first checkout covers it
    // fully (zero due, paid outright, $10 left on the card); a SECOND
    // order with the same card must apply only the remaining $10, not the
    // original $40. A separate $20 card is issued but never used — it
    // must keep its full balance (no accidental cross-card burn).
    var twentyIssue = JSON.parse((await helpers.httpRequest({
      port: port, path: "/admin/gift-cards", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount_minor: 2000, currency: "USD" }),
    })).body);
    var fortyIssue = JSON.parse((await helpers.httpRequest({
      port: port, path: "/admin/gift-cards", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ amount_minor: 4000, currency: "USD" }),
    })).body);

    // First order with the $40 card: covers the full $30 → zero due, paid
    // outright with NO Stripe intent, $10 left on the card.
    var intentsBeforeFullCover = payment._intents.length;
    var jar2 = await _freshCart();
    var co2 = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar2,
      form: { email: "b2@example.com", name: "B2", country: "US", gift_card_code: fortyIssue.code },
    });
    check("full-cover checkout then 303",     co2.status === 303);
    check("full-cover skips /pay (→ /orders)", (co2.headers.location || "").indexOf("/orders/") === 0);
    var orderId2 = (co2.headers.location || "").replace("/orders/", "");
    var o2 = await order.get(orderId2);
    check("full-cover order is paid",         o2 && o2.status === "paid");
    check("full-cover created NO PaymentIntent", payment._intents.length === intentsBeforeFullCover);

    var afterForty1 = await giftcards.balance(fortyIssue.code);
    check("$40 card has $10 remaining",       afterForty1 && afterForty1.balance_minor === 1000);

    // Second order with the SAME $40 card (now $10): $10 applied, $20 due.
    var intentsBeforeSecond = payment._intents.length;
    var jar3 = await _freshCart();
    var co3 = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar3,
      form: { email: "b3@example.com", name: "B3", country: "US", gift_card_code: fortyIssue.code },
    });
    check("second redeem then 303 (/pay)",    co3.status === 303 && (co3.headers.location || "").indexOf("/pay/") === 0);
    check("second redeem made a PaymentIntent", payment._intents.length === intentsBeforeSecond + 1);
    var secondIntent = payment._intents[payment._intents.length - 1];
    // Only the REMAINING $10 applied → due is $30 - $10 = $20, not $30-$40.
    check("second redeem applies only remaining $10", secondIntent && secondIntent.amount_minor === 2000);
    var afterForty2 = await giftcards.balance(fortyIssue.code);
    check("$40 card now fully spent",         afterForty2 && afterForty2.balance_minor === 0);

    // The $20 card was never used — still full balance (no accidental burn).
    var twentyBal = await giftcards.balance(twentyIssue.code);
    check("unused $20 card untouched",        twentyBal && twentyBal.balance_minor === 2000);

    // ---- invalid code at checkout is handled (no 500) -----------------
    var jar4 = await _freshCart();
    var coBad = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar4,
      form: { email: "b4@example.com", name: "B4", country: "US", gift_card_code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" },
    });
    check("invalid code at checkout → 400 not 500", coBad.status === 400);

    // ---- admin ledger lists the card + transactions -------------------
    var jarA2 = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jarA2 });
    var listHtml = await helpers.httpRequest({ port: port, path: "/admin/gift-cards", jar: jarA2 });
    check("admin gift-cards page then 200",   listHtml.status === 200);
    check("list shows masked code hint",      listHtml.body.indexOf("••••" + fiveCard.code_hint) !== -1);
    check("list shows a remaining balance",   listHtml.body.indexOf("$0.00") !== -1 || listHtml.body.indexOf("$10.00") !== -1);
    check("nav includes Gift cards",          listHtml.body.indexOf("\"/admin/gift-cards\"") !== -1);

    var listApi = await helpers.httpRequest({ port: port, path: "/admin/gift-cards", headers: bearer });
    check("gift-cards API still JSON",        (listApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var apiRows = JSON.parse(listApi.body).rows;
    check("API lists all issued cards",       apiRows.length === 4);

    // Detail view: the $5 card's ledger shows the issue credit + the debit.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + fiveCard.id, jar: jarA2 });
    check("card detail then 200",             detail.status === 200);
    check("detail shows ledger heading",      detail.body.indexOf(">Ledger<") !== -1);
    check("detail shows a debit row",         detail.body.indexOf(">debit<") !== -1);
    check("detail shows the issue credit",    detail.body.indexOf(">credit<") !== -1);

    var detailApi = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + fiveCard.id, headers: bearer });
    var detailBody = JSON.parse(detailApi.body);
    check("detail API returns the card",      detailBody.card && detailBody.card.id === fiveCard.id);
    check("detail API returns ledger rows",   Array.isArray(detailBody.ledger) && detailBody.ledger.length >= 2);

    // Unknown card id → 404, not 500.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/00000000-0000-7000-8000-000000000000", headers: bearer });
    check("unknown card detail → 404",        miss.status === 404);

    // ---- void a mis-issued card --------------------------------------
    // The $20 card is still active + unused — the operator can revoke it.
    // The detail page offers a "Void card" button only while active; a
    // fully-redeemed card (the $5 one) must NOT offer it.
    var activeDetail = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + twentyIssue.id, jar: jarA2 });
    check("active card shows Void button",     activeDetail.body.indexOf("Void card") !== -1 &&
                                               activeDetail.body.indexOf("/admin/gift-cards/" + twentyIssue.id + "/void/confirm") !== -1);
    var redeemedDetail = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + fiveCard.id, jar: jarA2 });
    check("redeemed card hides Void button",   redeemedDetail.body.indexOf("Void card") === -1);

    // Browser confirm interstitial → real POST → PRG to the detail.
    var confirm = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + twentyIssue.id + "/void/confirm", method: "POST", jar: jarA2, form: {} });
    check("void confirm then 200",            confirm.status === 200);
    check("confirm warns it's permanent",     confirm.body.indexOf("Void this gift card?") !== -1 && confirm.body.indexOf("can no longer be redeemed") !== -1);
    check("confirm posts to the void action",  confirm.body.indexOf("action=\"/admin/gift-cards/" + twentyIssue.id + "/void\"") !== -1);

    var doVoid = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + twentyIssue.id + "/void", method: "POST", jar: jarA2, form: { reason: "mis-issued" } });
    check("void then 303 (PRG)",              doVoid.status === 303);
    check("void redirects to detail w/ flag",  (doVoid.headers.location || "").indexOf("/admin/gift-cards/" + twentyIssue.id + "?voided=1") === 0);
    var afterVoid = await giftcards.getById(twentyIssue.id);
    check("card status now voided",           afterVoid && afterVoid.status === "voided");
    var voidedView = await helpers.httpRequest({ port: port, path: doVoid.headers.location, jar: jarA2 });
    check("detail shows voided banner",       voidedView.body.indexOf("Gift card voided") !== -1);
    check("voided card hides Void button",    voidedView.body.indexOf("Void card") === -1);

    // The confirm interstitial refuses a non-active card (redirects, no 500).
    var confirmRedeemed = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + fiveCard.id + "/void/confirm", method: "POST", jar: jarA2, form: {} });
    check("confirm on redeemed → 303 err",    confirmRedeemed.status === 303 && (confirmRedeemed.headers.location || "").indexOf("err=1") !== -1);

    // Bearer JSON void path: voiding a fully-redeemed card → 409, not 500;
    // and voiding the (now already-voided) $20 card is idempotent → 200.
    var jsonVoidRedeemed = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + fiveCard.id + "/void", method: "POST", headers: bearer });
    check("bearer void redeemed → 409",       jsonVoidRedeemed.status === 409);
    var jsonVoidAgain = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/" + twentyIssue.id + "/void", method: "POST", headers: bearer });
    check("bearer void already-voided → 200",  jsonVoidAgain.status === 200 &&
                                               (jsonVoidAgain.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer void returns voided row",    JSON.parse(jsonVoidAgain.body).status === "voided");
    // Bearer void of an unknown id → 404, not 500.
    var jsonVoidMiss = await helpers.httpRequest({ port: port, path: "/admin/gift-cards/00000000-0000-7000-8000-000000000000/void", method: "POST", headers: bearer });
    check("bearer void unknown id → 404",     jsonVoidMiss.status === 404);

    // Anon → sign-in form, not card data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/gift-cards" });
    check("anon gift-cards → login form",     anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
