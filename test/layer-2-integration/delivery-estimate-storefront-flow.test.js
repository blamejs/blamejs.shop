"use strict";
/**
 * Delivery-estimate storefront render — the container-only "Get it by <date>"
 * line on the PDP + cart.
 *
 * Boots a real b.createApp storefront wired with { catalog, cart, customers,
 * addresses, config, deliveryEstimate } over in-memory node:sqlite loaded from
 * the live migrations, seeds the four delivery tables (a cutoff, a postal zone
 * for 90210 → us-west, a UPS GROUND transit) + a signed-in customer whose
 * default shipping address is in 90210, then asserts:
 *
 *   - a SIGNED-IN customer with a saved 90210 address sees the "Get it by
 *     <date>" line on the PDP (the real, configured estimate renders);
 *   - an ANONYMOUS visitor sees NO estimate (the date is per-customer; the
 *     edge-shared render bakes none) — the page still 200s;
 *   - the cart summary carries the same "Get it by" line for the signed-in
 *     customer;
 *   - DROP-SILENT: with the cutoff row removed (the primitive THROWS a config-
 *     state TypeError there), the PDP still renders 200 with no estimate and no
 *     500 — the storefront read tier swallows the throw.
 *
 * The worker/ tree is excluded from the container build; this test reads no
 * worker path, so no fs.existsSync guard is needed here (the byte-parity gate
 * lives in delivery-estimate-render-parity.test.js, which IS guarded).
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

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0004_shop_config.sql",
  "0006_customers.sql", "0026_customer_addresses.sql", "0117_delivery_estimate.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// A stable customer id so the sealed shop_auth cookie + the saved address agree.
var CUSTOMER_ID = "01900000-0000-7000-8000-00000000de11";
var ORIGIN = "dc-east";

// A request `now` before the 14:00 cutoff on a Monday so ship_by is deterministic
// — but the render doesn't pin the exact date string (the customer's clock
// drives it); the test asserts the LINE is present, not a specific weekday.

async function _run() {
  var mq        = helpers.memD1Query(MIGS);
  var query     = mq.query;
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query, cursorSecret: "delivery-storefront" });
  var addresses = bShop.addresses.create({ query: query });
  var deliveryEstimate = bShop.deliveryEstimate.create({ query: query });

  // A physical product (requires_shipping defaults true) with a weight.
  var prod = await catalog.products.create({ slug: "delivery-tee", title: "Delivery Tee", status: "active" });
  var variant = await catalog.variants.create(prod.id, { sku: "DEL-TEE-1", title: "Default", position: 0, weight_grams: 350, requires_shipping: true });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create("DEL-TEE-1", { stock_on_hand: 25 });

  // The signed-in customer's default shipping address in Beverly Hills (90210).
  await addresses.add({
    customer_id:         CUSTOMER_ID,
    recipient_name:      "Ada Lovelace",
    street_line1:        "1 Rodeo Dr",
    city:                "Beverly Hills",
    region:              "CA",
    postal_code:         "90210",
    country:             "US",
    is_default_shipping: true,
  });

  // The four delivery tables: an origin cutoff, a postal-prefix zone for 902xx,
  // and a UPS GROUND transit for dc-east → us-west.
  async function _seedDeliveryTables() {
    await deliveryEstimate.defineCutoff({ origin_location: ORIGIN, daily_cutoff_local_time: "14:00", timezone: "America/New_York" });
    await deliveryEstimate.definePostalZone({ country: "US", postal_prefix: "902", zone: "us-west" });
    await deliveryEstimate.defineCarrierTransit({ from_zone: ORIGIN, to_zone: "us-west", carrier: "ups", service_level: "GROUND", transit_days: 4 });
  }
  await _seedDeliveryTables();

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-delivery-sf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, customers: customers, addresses: addresses,
        deliveryEstimate: deliveryEstimate,
        // The storefront resolves the origin from this plain slug (sfDeps.config
        // is a bare stub in production); pass it directly here.
        delivery_estimate_origin: ORIGIN,
        config: { shop_name: "Delivery Shop" },
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, CUSTOMER_ID)] });

    // ---- PDP: signed-in customer sees the estimate --------------------
    var pdp = await helpers.httpRequest({ port: port, path: "/products/delivery-tee", jar: jar });
    check("PDP then 200 (signed-in)",            pdp.status === 200);
    check("PDP shows delivery estimate",         pdp.body.indexOf("class=\"delivery-est\"") !== -1);
    check("PDP estimate says 'Get it'",          pdp.body.indexOf("Get it ") !== -1);
    check("PDP estimate names the carrier",      pdp.body.indexOf("ups GROUND") !== -1);

    // ---- PDP: anonymous visitor sees NO estimate ----------------------
    var pdpAnon = await helpers.httpRequest({ port: port, path: "/products/delivery-tee" });
    check("PDP then 200 (anon)",                 pdpAnon.status === 200);
    check("anon PDP has NO estimate",            pdpAnon.body.indexOf("class=\"delivery-est\"") === -1);

    // ---- Cart: signed-in customer sees the estimate -------------------
    // Mint a cart for the session, add a line, then read /cart. The cart is
    // keyed off the shop_sid cookie; POST /cart/lines mints it.
    var add = await helpers.httpRequest({
      port: port, path: "/cart/lines", method: "POST", jar: jar,
      form: { variant_id: variant.id, qty: "1" },
    });
    check("add to cart then 303",                add.status === 303);
    var cartPage = await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    check("cart then 200",                       cartPage.status === 200);
    check("cart shows delivery estimate",        cartPage.body.indexOf("class=\"delivery-est\"") !== -1);

    // ---- DROP-SILENT: no cutoff row → the primitive throws, page still ok
    // Remove the cutoff so estimate() hits its config-state throw. The
    // storefront read tier must swallow it: 200, no estimate, no 500.
    await query("DELETE FROM shipping_cutoffs WHERE origin_location = ?1", [ORIGIN]);
    var pdpNoCutoff = await helpers.httpRequest({ port: port, path: "/products/delivery-tee", jar: jar });
    check("PDP 200 with no cutoff (drop-silent)", pdpNoCutoff.status === 200);
    check("no-cutoff PDP has NO estimate",        pdpNoCutoff.body.indexOf("class=\"delivery-est\"") === -1);
    check("no-cutoff PDP not a 500 page",         pdpNoCutoff.body.indexOf("delivery-tee") !== -1 || pdpNoCutoff.body.indexOf("Delivery Tee") !== -1);

    // Restore + confirm it comes back (proves the removal, not a render bug,
    // suppressed the line).
    await _seedDeliveryTables();
    var pdpAgain = await helpers.httpRequest({ port: port, path: "/products/delivery-tee", jar: jar });
    check("estimate returns after re-seed",       pdpAgain.body.indexOf("class=\"delivery-est\"") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
