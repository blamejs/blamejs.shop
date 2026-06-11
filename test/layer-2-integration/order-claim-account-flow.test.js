"use strict";
/**
 * Post-checkout account claim — HTTP integration of the "save your details /
 * create an account" offer a guest buyer sees on the order confirmation page.
 *
 * The flow it covers, end to end through one real `b.createApp` storefront
 * over an in-memory `node:sqlite` backend:
 *
 *   - a guest who completes checkout (here: a gift card fully covers the
 *     order, so confirm lands straight on /orders/:id) gets the buyer email
 *     stashed in the sealed `shop_claim` cookie, and the confirmation page
 *     renders the "save your details" offer with the email MASKED — the full
 *     address never appears in the HTML;
 *   - a SIGNED-IN buyer never sees the offer (their order is already owned);
 *   - the one-click trigger (POST /orders/:id/claim-account, no email in the
 *     body — it's only in the sealed cookie) sends EXACTLY ONE sign-in mail,
 *     creates the account when none exists, and links the guest order to it;
 *   - clicking the mailed portal link signs the buyer in AND reconciles the
 *     order (it now shows on /account); a second click is single-use (bounced);
 *   - when an account already EXISTS for the email the copy says "Sign in"
 *     (not "Create"), but the trigger response is IDENTICAL — no enumeration;
 *   - the tight per-route rate limit caps the trigger (the /orders/ budget);
 *   - a trigger with no claim cookie (a forged / cross-order POST) sends
 *     nothing and never reveals whether an account exists.
 *
 * Outbound mail is captured via a recording stub mailer (the same shape
 * server.js wires for the magic-link surface). Every state-changing POST goes
 * through the real double-submit CSRF gate (the jar captures + echoes the
 * token). Network: zero — every request lands on 127.0.0.1.
 *
 * NO worker/ import: imports only ../../lib + test/helpers + node builtins.
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
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql",
  "0206_orders_email_hash.sql",
  "0226_guest_order_reconciliations.sql",
  "0006_customers.sql",
  "0004_shop_config.sql",
  "0013_giftcards.sql",
  "0081_gift_card_ledger.sql", "0220_gift_card_ledger_chain.sql",
  "0072_customer_portal_sessions.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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

// Recording stub mailer matching b.mail.create()'s .send() shape — used to
// build the SAME bShop.email instance server.js wires for the magic-link /
// portal surface, so the offer + the one-click send light up without a real
// SMTP server. `sent` is the captured outbound queue.
function _stubEmailHandle() {
  var sent = [];
  var mailer = { send: async function (msg) { sent.push(msg); return { ok: true, id: "msg_" + sent.length }; } };
  return { sent: sent, email: bShop.email.create({ mailer: mailer, from: "shop@example.com" }) };
}

// Stub Stripe payment adapter — never actually charged in this test (every
// order here is fully covered by a gift card, so no PaymentIntent is created),
// but the checkout primitive requires a payment dep to construct.
function _stubPayment() {
  var n = 0;
  var intents = [];
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      n += 1;
      intents.push({ amount_minor: input.amount_minor, currency: input.currency });
      return { id: "pi_" + n, client_secret: "pi_" + n + "_secret", status: "requires_payment_method" };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
    _intents: intents,
  };
}

function _teardownApp(handle) {
  if (!handle) return Promise.resolve();
  return Promise.resolve()
    .then(function () { return handle.app.shutdown(); })
    .catch(function () { /* best-effort */ })
    .then(function () { try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ } });
}

// Extract a Set-Cookie value by name from a response's headers (the jar
// strips attributes; here we want to assert the raw cookie was set/cleared).
function _setCookieNamed(res, name) {
  var raw = (res.headers && res.headers["set-cookie"]) || [];
  var list = Array.isArray(raw) ? raw : [raw];
  for (var i = 0; i < list.length; i += 1) {
    if (String(list[i]).indexOf(name + "=") === 0) return String(list[i]);
  }
  return null;
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "claim-order" });
  var customers = bShop.customers.create({ query: query });
  var customerPortal = bShop.customerPortal.create({ query: query });
  var tax       = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping  = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment   = _stubPayment();
  var giftcards = bShop.giftcards.create({ query: query });
  var ledger    = bShop.giftCardLedger.create({ query: query });
  var stub      = _stubEmailHandle();
  var checkout  = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping,
    payment: payment, order: order, giftcards: giftcards, giftCardLedger: ledger,
    customers: customers,
  });

  // A product priced at $30.00 so a $50 gift card covers it fully (zero due →
  // confirm lands straight on /orders/:id, exercising the claim stash without
  // a live Stripe call).
  var product = await catalog.products.create({ slug: "claim-widget", title: "Claim Widget", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "CLAIM-1", weight_grams: 100 });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 3000 });
  await catalog.inventory.create("CLAIM-1", { stock_on_hand: 100 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-claim-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        checkout: checkout, giftcards: giftcards, default_shipping_id: "std",
        customerPortal: customerPortal, customerPortalEmail: stub.email,
        shop_name: "Claim Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var handle = { app: app, dataDir: dataDir };

  // Issue a gift card that fully covers the $30 order. Mirrors the admin
  // issue route: the card row + the opening ledger credit (so the checkout
  // debit has a balance to draw against), and returns the plaintext code once.
  async function _issueCard(amountMinor) {
    var card = await giftcards.issue({ amount_minor: amountMinor, currency: "USD" });
    await ledger.credit({ gift_card_id: card.id, amount_minor: amountMinor, source: "manual", source_ref: "test-issue" });
    return card.code;
  }

  // Seed a fresh session cart with one unit; the trailing GET /cart seeds the
  // CSRF cookie so the checkout POST carries a real token.
  async function _freshCart() {
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    await cart.addLine(c.id, { variant_id: variant.id, qty: 1 });
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/"] });
    await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    return jar;
  }

  // Drive a guest checkout fully covered by a gift card → 303 to /orders/:id.
  // Returns { order_id, jar, checkoutRes }.
  async function _guestCheckout(email, name, jar) {
    var code = await _issueCard(5000);
    var co = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar,
      form: {
        email: email, name: name, line1: "1 Main St", city: "SF",
        country: "US", state: "CA", postal: "94103", gift_card_code: code,
      },
    });
    return { checkoutRes: co, jar: jar };
  }

  try {
    var BUYER_EMAIL = "robert@example.com";
    var MASKED      = "r***@e***.com";

    // ===================================================================
    // A. Guest checkout stashes the email + renders the masked offer
    // ===================================================================
    var jarA = await _freshCart();
    var coA  = await _guestCheckout(BUYER_EMAIL, "Robert", jarA);
    check("full-cover checkout → 303 /orders", coA.checkoutRes.status === 303 &&
      (coA.checkoutRes.headers.location || "").indexOf("/orders/") === 0);
    var orderId = (coA.checkoutRes.headers.location || "").replace("/orders/", "");
    check("confirm set a sealed claim cookie", !!_setCookieNamed(coA.checkoutRes, "shop_claim"));

    // The order is a guest order (no owner) and the claim cookie is in the jar.
    var seededOrder = await order.get(orderId);
    check("checkout order has no owner (guest)", seededOrder && !seededOrder.customer_id);

    // The confirmation page renders the offer with the MASKED email; the full
    // address never appears in the HTML (privacy: plaintext only in the cookie).
    var pageA = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: coA.jar });
    check("guest confirmation page → 200",      pageA.status === 200);
    check("offer renders for the guest",        pageA.body.indexOf("/orders/" + orderId + "/claim-account") !== -1);
    check("offer shows the MASKED email",        pageA.body.indexOf(MASKED) !== -1);
    check("offer never leaks the full address",  pageA.body.indexOf(BUYER_EMAIL) === -1);
    check("no account yet → CREATE wording",     pageA.body.indexOf("Create my account") !== -1);

    // ===================================================================
    // B. A signed-in buyer never sees the offer
    // ===================================================================
    // Two angles: (1) a SIGNED-IN visitor on this guest order's capability URL
    // (a guest order has no owner, so it's reachable) sees NO offer — the
    // route suppresses it on `!orderAuth` being false; (2) a signed-in
    // customer viewing their OWN order sees no offer either, even with a
    // matching claim cookie present. (2) proves it's the SIGN-IN, not the
    // missing cookie, that hides the offer.
    var strangerJar = helpers.cookieJar();
    // Carry over THIS order's real claim cookie so the only difference from
    // Part A (where the offer DID render) is the auth cookie.
    var claimRaw = coA.jar.get("shop_claim");
    if (claimRaw) strangerJar.capture({ "set-cookie": ["shop_claim=" + claimRaw] });
    strangerJar.capture({ "set-cookie": [helpers.authCookie(b, b.uuid.v7())] });
    var pageStranger = await helpers.httpRequest({ port: port, path: "/orders/" + orderId, jar: strangerJar });
    check("signed-in visitor on guest order → 200", pageStranger.status === 200);
    check("signed-in visitor sees no claim offer",  pageStranger.body.indexOf("/claim-account") === -1);

    // (2) Seed an order OWNED by a signed-in customer, plus a claim cookie
    // pinned to it, and confirm the owner's own confirmation page suppresses
    // the offer (a buyer who is already signed in has no account to create).
    var ownerId = b.uuid.v7();
    await query(
      "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      [ownerId, customers.hashEmail("owner@example.com"), "Owner", Date.now()],
    );
    var ownedCartId = b.uuid.v7(); var ownedOrderId = b.uuid.v7();
    await query(
      "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
      "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
      [ownedCartId, b.uuid.v7(), ownerId, Date.now(), Date.now() + 86400000],
    );
    await query(
      "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
      "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, " +
      "customer_email_hash, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 3000, 0, 0, 0, 3000, NULL, '{\"country\":\"US\"}', ?5, ?6, ?6)",
      [ownedOrderId, ownedCartId, ownerId, b.uuid.v7(), customers.hashEmail("owner@example.com"), Date.now()],
    );
    var ownerJar = helpers.cookieJar();
    ownerJar.capture({ "set-cookie": [helpers.authCookie(b, ownerId)] });
    // Forge a claim cookie pinned to the owned order (the app is booted, so the
    // sealed cookie verifies) — proving the offer is suppressed by the sign-in,
    // not the absence of a stash.
    ownerJar.capture({ "set-cookie": [helpers.sealedCookie(b, "shop_claim", { order_id: ownedOrderId, email: "owner@example.com" })] });
    var ownerPage = await helpers.httpRequest({ port: port, path: "/orders/" + ownedOrderId, jar: ownerJar });
    check("signed-in owner page → 200",            ownerPage.status === 200);
    check("signed-in owner sees no claim offer",    ownerPage.body.indexOf("/claim-account") === -1 &&
      ownerPage.body.indexOf("Save your details") === -1 && ownerPage.body.indexOf("Sign in to save this order") === -1);

    // ===================================================================
    // C. One-click trigger → exactly one mail, account created (order links
    //    on sign-in, NOT here — see below)
    // ===================================================================
    var sentBefore = stub.sent.length;
    var trigger = await helpers.httpRequest({
      port: port, path: "/orders/" + orderId + "/claim-account", method: "POST", jar: coA.jar,
    });
    check("claim trigger → 303 sent",            trigger.status === 303 &&
      (trigger.headers.location || "") === "/orders/" + orderId + "?claim=sent");
    check("claim trigger sent EXACTLY one mail",  stub.sent.length === sentBefore + 1);
    var mail = stub.sent[stub.sent.length - 1];
    check("mail went to the checked-out address", mail.to === BUYER_EMAIL);
    var tokenMatch = mail.html.match(/\/account\/portal\/([A-Za-z0-9_-]+)/);
    check("mail carries a portal sign-in token",  !!tokenMatch);
    var plaintext = tokenMatch ? tokenMatch[1] : "";

    // The account now exists for that email. The guest order is NOT linked
    // yet — linking happens at sign-in (the buyer proving control of the
    // email by clicking the mailed link), so the guest keeps capability-URL
    // access to their own confirmation page in the meantime.
    var createdCust = await customers.byEmailHash(customers.hashEmail(BUYER_EMAIL));
    check("trigger created the account",          !!(createdCust && createdCust.id));
    var notYetLinked = await order.get(orderId);
    check("order stays a guest order pre-sign-in", !notYetLinked.customer_id);

    // The trigger cleared the claim cookie (one-shot).
    check("trigger cleared the claim cookie",      !!_setCookieNamed(trigger, "shop_claim"));

    // Following the redirect shows the neutral "check your inbox" confirmation,
    // not the form, and still no full address. The order is still a guest
    // order, so the capability URL still resolves for the (cookie-cleared)
    // buyer who is sitting on the page.
    var sentPage = await helpers.httpRequest({ port: port, path: "/orders/" + orderId + "?claim=sent", jar: coA.jar });
    check("?claim=sent → 200 (capability URL still works)", sentPage.status === 200);
    check("?claim=sent shows confirmation",        sentPage.body.indexOf("Check your inbox") !== -1);
    check("?claim=sent never leaks the address",   sentPage.body.indexOf(BUYER_EMAIL) === -1);

    // ===================================================================
    // D. Clicking the mailed link signs in AND reconciles; second click is
    //    single-use.
    // ===================================================================
    var redeemJar = helpers.cookieJar();
    var redeem = await helpers.httpRequest({
      port: port, path: "/account/portal/" + encodeURIComponent(plaintext), jar: redeemJar,
    });
    check("portal redeem → 303 /account",          redeem.status === 303 &&
      (redeem.headers.location || "") === "/account");
    check("portal redeem set an auth cookie",      !!_setCookieNamed(redeem, "shop_auth") ||
      (redeem.headers["set-cookie"] || []).join(";").indexOf("shop_auth") !== -1);

    // The now-authenticated session sees the order on its account.
    var orderList = await order.listForCustomer(createdCust.id, {});
    check("account now owns the linked order",     orderList.rows.some(function (o) { return o.id === orderId; }));
    // The magic-link attach wrote a "magic-link" audit row for the order.
    var claimRecons = await order.reconciliationsForCustomer(createdCust.id);
    check("magic-link attach wrote an audit row",  claimRecons.some(function (r) {
      return r.order_id === orderId && r.linked_via === "magic-link";
    }));

    // Single-use: re-clicking the same token is bounced to login.
    var reuse = await helpers.httpRequest({
      port: port, path: "/account/portal/" + encodeURIComponent(plaintext), jar: helpers.cookieJar(),
    });
    check("second click is single-use → login",    reuse.status === 303 &&
      (reuse.headers.location || "").indexOf("/account/login") === 0);

    // ===================================================================
    // E. Existing-account wording + no-enumeration parity
    // ===================================================================
    // A second guest order under the SAME (now-existing) email. The offer copy
    // flips to "Sign in", but the trigger response + send is identical.
    var jarE = await _freshCart();
    var coE  = await _guestCheckout(BUYER_EMAIL, "Robert", jarE);
    var orderIdE = (coE.checkoutRes.headers.location || "").replace("/orders/", "");
    var pageE = await helpers.httpRequest({ port: port, path: "/orders/" + orderIdE, jar: coE.jar });
    check("existing account → SIGN-IN wording",    pageE.body.indexOf("Sign in to save this order") !== -1 &&
      pageE.body.indexOf("Email me a sign-in link") !== -1);
    check("existing-account offer still masks email", pageE.body.indexOf(MASKED) !== -1 &&
      pageE.body.indexOf(BUYER_EMAIL) === -1);

    var sentBeforeE = stub.sent.length;
    var triggerE = await helpers.httpRequest({
      port: port, path: "/orders/" + orderIdE + "/claim-account", method: "POST", jar: coE.jar,
    });
    // IDENTICAL response shape to the create path → no account-existence oracle.
    check("existing-account trigger → 303 sent",   triggerE.status === 303 &&
      (triggerE.headers.location || "") === "/orders/" + orderIdE + "?claim=sent");
    check("existing-account trigger sent one mail", stub.sent.length === sentBeforeE + 1);
    // No second customer row was created for the same email.
    var sameCust = await customers.byEmailHash(customers.hashEmail(BUYER_EMAIL));
    check("no duplicate account for the email",    sameCust.id === createdCust.id);
    // Still a guest order until THIS link is clicked (linking is sign-in-gated).
    var preRedeemE = await order.get(orderIdE);
    check("second order unlinked until sign-in",   !preRedeemE.customer_id);
    // Redeeming THIS mail's link reconciles the second order onto the same
    // existing account (the redemption re-links any still-unowned order for
    // the account's email — idempotent for the already-linked first order).
    var mailE = stub.sent[stub.sent.length - 1];
    var tokenE = (mailE.html.match(/\/account\/portal\/([A-Za-z0-9_-]+)/) || [])[1];
    var redeemE = await helpers.httpRequest({
      port: port, path: "/account/portal/" + encodeURIComponent(tokenE), jar: helpers.cookieJar(),
    });
    check("existing-account redeem → 303 /account", redeemE.status === 303 &&
      (redeemE.headers.location || "") === "/account");
    var linkedE = await order.get(orderIdE);
    check("second guest order linked after its sign-in", linkedE.customer_id === createdCust.id);

    // ===================================================================
    // F. A trigger with NO claim cookie sends nothing + no enumeration
    // ===================================================================
    // A fresh guest order (cookie stash present) but POST the trigger from a
    // jar that carries the SESSION/CSRF context yet NO claim cookie — the send
    // cannot fire (no address), and the response reveals nothing.
    var jarF = await _freshCart();
    var coF  = await _guestCheckout("nobody@example.com", "Nobody", jarF);
    var orderIdF = (coF.checkoutRes.headers.location || "").replace("/orders/", "");
    // Seed the CSRF cookie for a cookie-less-claim jar via a NON-gated GET
    // (/cart always issues the token). The order page itself is now access-
    // gated: a fresh jar holding neither the placing-browser access cookie nor
    // a claim cookie 404s on the guest order's bare UUID — which is exactly
    // the anti-enumeration property under test here, so assert it too.
    var noClaimJar = helpers.cookieJar();
    var seedGet = await helpers.httpRequest({ port: port, path: "/cart", jar: noClaimJar });
    check("seed GET (/cart) for no-claim jar → 200", seedGet.status === 200);
    var bareUuidGet = await helpers.httpRequest({ port: port, path: "/orders/" + orderIdF, jar: noClaimJar });
    check("bare-UUID guest order, no access → 404",  bareUuidGet.status === 404);
    // noClaimJar never captured a shop_claim / shop_oacc (the stash + access
    // grant were set on jarF's checkout response, not this jar) → the trigger
    // has no address.
    var sentBeforeF = stub.sent.length;
    var triggerNoClaim = await helpers.httpRequest({
      port: port, path: "/orders/" + orderIdF + "/claim-account", method: "POST", jar: noClaimJar,
    });
    // Bounced to the order page WITHOUT ?claim=sent (no offer-state lie), and
    // NO mail dispatched — a forged / cross-order trigger can't mail a victim.
    check("no-claim trigger → 303 (no sent flag)", triggerNoClaim.status === 303 &&
      (triggerNoClaim.headers.location || "") === "/orders/" + orderIdF);
    check("no-claim trigger sent nothing",         stub.sent.length === sentBeforeF);
    check("nobody@ account was never created",     (await customers.byEmailHash(customers.hashEmail("nobody@example.com"))) === null);

    // ===================================================================
    // G. Rate limit caps the trigger (the /orders/ tight budget)
    // ===================================================================
    // Re-boot a storefront with the SAME security stack as production (tight
    // per-route limiters ON) and prove the trigger endpoint is throttled. The
    // limiter keys on (client-ip + path); ~10/min, so the 11th POST is 429.
    await _teardownApp(handle);
    handle = null;

    var dataDir2 = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-claim-rl-"));
    var app2 = await b.createApp({
      dataDir: dataDir2, vault: { mode: "plaintext" },
      db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
      middleware: {
        securityHeaders: bShop.securityMiddleware.securityHeadersOpts(),
        rateLimit:       bShop.securityMiddleware.globalRateLimitOpts(),
        csrf:            false, bodyParser: false, fetchMetadata: false, cspNonce: false,
      },
      routes: function (r) {
        r.use(b.middleware.bodyParser());
        bShop.securityMiddleware.mountRouteGuards(r);
        bShop.storefront.mount(r, {
          catalog: catalog, cart: cart, order: order, customers: customers,
          checkout: checkout, giftcards: giftcards, default_shipping_id: "std",
          customerPortal: customerPortal, customerPortalEmail: stub.email,
          shop_name: "Claim Shop",
        });
      },
    });
    var bound2 = await app2.listen({ port: 0, host: "127.0.0.1" });
    var port2 = bound2.port;
    var handle2 = { app: app2, dataDir: dataDir2 };

    try {
      // A guess-target order id (well-formed UUID, unknown) keeps every POST on
      // the SAME /orders/:id/claim-account path so they share one rate bucket;
      // the handler bounces (unknown order) but the limiter counts each hit.
      var targetId = b.uuid.v7();
      // Seed the CSRF cookie via a GET so each POST carries a token (the gate
      // is exercised, never bypassed).
      var rlJar = helpers.cookieJar();
      await helpers.httpRequest({ port: port2, path: "/orders/" + targetId, jar: rlJar });
      var saw429 = false;
      for (var i = 0; i < 14; i += 1) {
        var hit = await helpers.httpRequest({
          port: port2, path: "/orders/" + targetId + "/claim-account", method: "POST", jar: rlJar,
        });
        if (hit.status === 429) { saw429 = true; break; }
      }
      check("trigger is rate-limited (429 within budget)", saw429);
    } finally {
      await _teardownApp(handle2);
    }
  } finally {
    if (handle) await _teardownApp(handle);
  }
}

module.exports = { run: _run };
