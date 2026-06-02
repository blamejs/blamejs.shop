"use strict";
/**
 * Trust badges — full HTTP integration of the /admin/trust-badges authoring
 * console + the container-only render at the checkout + order-confirmation
 * placements.
 *
 * Boots ONE b.createApp with BOTH the admin console (wired { token, catalog,
 * order, trustBadges }) and the storefront (wired { catalog, cart, order,
 * trustBadges }) against one in-memory node:sqlite DB so the admin writes and
 * the storefront render share the same data.
 *
 * Asserts: create with a clean SVG + placements, render on the order-
 * confirmation page (a non-targeted placement absent), SVG sanitize refuses a
 * <script>/onload payload (400, nothing persisted), title/alt XSS escaped in
 * BOTH the admin list and the rendered badge, javascript:/protocol-relative
 * image URLs 400, the impression counter increments on render, and archive
 * drops the badge from the active set.
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql", "0206_orders_email_hash.sql", "0111_trust_badges.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// A clean inline SVG the strict guard accepts (only allowed tags).
var CLEAN_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><title>Secure</title><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M8 12l3 3 5-6\"/></svg>";

// Build an application/x-www-form-urlencoded body that supports ARRAY values
// (repeated keys) — the trust-badge create form's `placements` multi-checkbox
// submits repeated `placements=` fields, which the test helper's flat form
// encoder can't produce. Posting a raw body bypasses the helper's auto-CSRF
// replay, but this test app boots without the security middleware so no token
// is required.
function _urlencoded(fields) {
  var pairs = [];
  Object.keys(fields).forEach(function (k) {
    var v = fields[k];
    if (Array.isArray(v)) {
      v.forEach(function (item) { pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(item)); });
    } else {
      pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    }
  });
  return pairs.join("&");
}
function _post(port, path, jar, fields) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST", jar: jar,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: _urlencoded(fields),
  });
}

async function _run() {
  var mq      = helpers.memD1Query(MIGS);
  var query   = mq.query;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "tb-test" });
  var config  = bShop.config.create({ query: query });
  var trustBadges = bShop.trustBadges.create({ query: query });

  // Seed a paid order so the order-confirmation page renders (a guest order
  // with no owner; the page is reachable by id).
  var prod = await catalog.products.create({ slug: "tb-prod", title: "TB Product", status: "active" });
  var variant = await catalog.variants.create(prod.id, { sku: "TB-1", title: "Default", position: 0 });
  await catalog.inventory.create("TB-1", { stock_on_hand: 10 });
  var sessionId = b.uuid.v7();
  var seedCart = await cart.create(sessionId, { currency: "USD" });
  var ord = await order.createFromCart({
    cart_id:    seedCart.id,
    session_id: sessionId,
    currency:   "USD",
    lines:      [{ sku: "TB-1", variant_id: variant.id, qty: 1, unit_amount_minor: 1500, unit_currency: "USD" }],
    subtotal_minor: 1500, discount_minor: 0, tax_minor: 0, shipping_minor: 0, grand_total_minor: 1500,
    ship_to: { country: "US", city: "Testville" },
  });

  // The /orders/:order_id confirmation page (where the order_confirmation
  // badge renders) only mounts when deps.checkout is present. Wire a real
  // checkout instance with stub tax/shipping/payment adapters so the route
  // mounts; the test never drives a payment, only reads the confirmation page.
  var stubTax      = { name: "stub", calculate: function () { return Promise.resolve({ tax_minor: 0, jurisdiction: "—", rate_bps: 0 }); } };
  var stubShipping = { name: "stub", rates: function () { return Promise.resolve({ services: [] }); } };
  var stubPayment  = { name: "stub", createIntent: function () { return Promise.resolve({ id: "pi_stub", client_secret: "cs_stub" }); } };
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: stubTax, shipping: stubShipping, payment: stubPayment, order: order,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-tbadge-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, order: order, checkout: checkout, trustBadges: trustBadges });
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config,
        trustBadges: trustBadges, shop_name: "Test Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login 303",                        login.status === 303);

    // t1 — create a clean-SVG badge for checkout + order_confirmation.
    var create = await _post(port, "/admin/trust-badges", jar, { slug: "secure-checkout", title: "Secure checkout", alt_text: "Secure checkout badge", svg_payload: CLEAN_SVG, placements: ["checkout", "order_confirmation"] });
    check("t1 create 303",                          create.status === 303);
    var list = await helpers.httpRequest({ port: port, path: "/admin/trust-badges", jar: jar });
    check("t1 list shows the badge",                list.body.indexOf("secure-checkout") !== -1);

    // t2 — the order-confirmation page renders the badge; the badge isn't
    // shown anywhere it doesn't belong (the home page has no order_confirmation
    // placement, so the badge title is absent there).
    var ordPage = await helpers.httpRequest({ port: port, path: "/orders/" + ord.id });
    check("t2 order page 200",                       ordPage.status === 200);
    check("t2 order page renders the badge",         ordPage.body.indexOf("data-trust-badge-slug=\"secure-checkout\"") !== -1);
    var home = await helpers.httpRequest({ port: port, path: "/" });
    check("t2 home page does NOT render the badge",  home.body.indexOf("data-trust-badge-slug=\"secure-checkout\"") === -1);

    // t3 — SVG sanitize: a <script>/onload SVG → 400, nothing persisted.
    var before = await trustBadges.listBadges({});
    var hostileSvg = await _post(port, "/admin/trust-badges", jar, { slug: "evil-svg", title: "Evil", alt_text: "evil", svg_payload: "<svg onload=\"alert(1)\"><script>alert(1)</script></svg>", placements: ["checkout"] });
    check("t3 hostile SVG rejected (not 303)",       hostileSvg.status !== 303);
    var afterHostile = await trustBadges.listBadges({});
    check("t3 nothing persisted for hostile SVG",    afterHostile.length === before.length);

    // t4 — XSS: title + alt_text with a payload → escaped in the admin list
    // AND the rendered storefront badge.
    var xssCreate = await _post(port, "/admin/trust-badges", jar, { slug: "xss-badge", title: "<script>alert('t')</script>", alt_text: "<img src=x onerror=alert(1)>", svg_payload: CLEAN_SVG, placements: ["order_confirmation"] });
    check("t4 xss badge created 303",               xssCreate.status === 303);
    var listXss = await helpers.httpRequest({ port: port, path: "/admin/trust-badges", jar: jar });
    check("t4 admin list escapes the title",        listXss.body.indexOf("<script>alert('t')</script>") === -1);
    var ordXss = await helpers.httpRequest({ port: port, path: "/orders/" + ord.id });
    check("t4 rendered badge escapes the title",    ordXss.body.indexOf("<script>alert('t')</script>") === -1);
    check("t4 rendered badge escapes the alt",      ordXss.body.indexOf("<img src=x onerror=alert(1)>") === -1);

    // t5 — image_url with javascript: / protocol-relative → 400.
    var jsUrl = await _post(port, "/admin/trust-badges", jar, { slug: "js-url", title: "JS", alt_text: "js", image_url: "javascript:alert(1)", placements: ["checkout"] });
    check("t5 javascript: image_url rejected",      jsUrl.status !== 303);
    var protoRel = await _post(port, "/admin/trust-badges", jar, { slug: "proto-rel", title: "PR", alt_text: "pr", image_url: "//evil.example/x.png", placements: ["checkout"] });
    check("t5 protocol-relative image_url rejected", protoRel.status !== 303);

    // t6 — impression counter increments on render (the order page render
    // fires recordImpression fire-and-forget; poll until it lands).
    var bumped = false;
    await helpers.waitUntil(async function () {
      var bd = await trustBadges.getBadge("secure-checkout");
      bumped = bd && bd.impression_count > 0;
      return bumped;
    }, { timeoutMs: 5000, label: "t6: impression counter incremented" });
    check("t6 impression counter incremented",       bumped);

    // t7 — archive drops the badge from the active placement set.
    await _post(port, "/admin/trust-badges/secure-checkout/archive", jar, {});
    var active = await trustBadges.activeForPlacement({ placement: "order_confirmation" });
    var stillActive = active.some(function (bd) { return bd.slug === "secure-checkout"; });
    check("t7 archived badge not in active set",     !stillActive);
    var ordAfterArchive = await helpers.httpRequest({ port: port, path: "/orders/" + ord.id });
    check("t7 order page no longer renders it",       ordAfterArchive.body.indexOf("data-trust-badge-slug=\"secure-checkout\"") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };
