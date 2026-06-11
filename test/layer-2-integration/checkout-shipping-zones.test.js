"use strict";
/**
 * Operator-defined shipping zones at the checkout till.
 *
 * The admin console lets an operator register regional rate tables
 * (shippingZones). This pins that those rates actually reach the
 * shipping quote the shopper picks from — via the same adapter wrapper
 * server.js mounts (`_zoneShippingRates`, exported from server.js) wired
 * into a real `checkout` instance over one in-memory SQLite handle.
 *
 * Three cases, all asserted in minor units against `checkout.quote`:
 *
 *   (a) NO zones defined          → the flat config-services fallback
 *                                   ($6.95 Standard) — zero regression.
 *   (b) a zone covering the cart  → the zone's rate ($9.50 Express) is
 *       destination                 what the quote offers.
 *   (c) a zone that does NOT      → the fallback again, because the
 *       cover the destination       destination falls outside every
 *                                   zone.
 *
 * Network: zero — payment is a stub, lookups are local SQLite.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

// The shipping-zone → adapter-service mapper, exercised exactly as
// server.js mounts it. Requiring server.js is side-effect-free off the
// entry point (its boot is guarded by require.main === module).
var _zoneShippingRates = require("../../server.js")._zoneShippingRates;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0106_shipping_zones.sql",
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

function _stubPayment() {
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      return { id: "pi_1", client_secret: "pi_1_secret", status: "requires_payment_method", _amount: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "checkout-zones" });
  var tax     = bShop.tax.create({ rules: [] });   // zero-rate tax — isolate the shipping source
  var shippingZones = bShop.shippingZones.create({ query: query });

  // The flat config-services fallback — exactly the wrapper server.js
  // mounts: zone rates when a zone matches, else the flat table. The
  // fallback is a single $6.95 US Standard service.
  var FALLBACK_SERVICES = [
    { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] },
  ];
  var sfShipping = {
    name: "configured",
    rates: async function (ctx) {
      var zoneServices = await _zoneShippingRates(shippingZones, ctx);
      if (zoneServices && zoneServices.length) return { services: zoneServices };
      var adapter = bShop.shipping.create({ services: FALLBACK_SERVICES });
      return await adapter.rates(ctx);
    },
  };

  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: sfShipping, payment: _stubPayment(), order: order,
  });

  // A single $40.00 physical product, 250 g, USD.
  var p1 = await catalog.products.create({ slug: "zoned-widget", title: "Zoned Widget", status: "active" });
  var v1 = await catalog.variants.create(p1.id, { sku: "ZW-1", weight_grams: 250, requires_shipping: true });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 4000 });
  await catalog.inventory.create("ZW-1", { stock_on_hand: 100 });

  var shipToCA = { country: "US", state: "CA", line1: "1 Main St", city: "SF", postal: "94103" };

  // A fresh single-line ($40.00, USD) CA-bound cart per case — confirm
  // converts a cart, so each case quotes its own.
  async function _freshCart() {
    var sid = bShop.framework.uuid.v7();
    var cartRow = await cart.create(sid, { currency: "USD" });
    await cart.addLine(cartRow.id, { variant_id: v1.id, qty: 1 });
    return cartRow;
  }

  // ---- (a) NO zones defined → the flat fallback, byte-for-byte -------
  var cartA = await _freshCart();
  var quoteA = await checkout.quote({ cart_id: cartA.id, ship_to: shipToCA });
  check("no-zone: exactly the fallback service count", quoteA.shipping_rates.length === 1);
  check("no-zone: fallback id preserved",              quoteA.shipping_rates[0].id === "std");
  check("no-zone: fallback label preserved",           quoteA.shipping_rates[0].label === "Standard");
  check("no-zone: fallback amount is $6.95 (695 minor)", quoteA.shipping_rates[0].amount_minor === 695);

  // ---- (b) a zone covering the CA destination → the zone rate -------
  // Express at $9.50 (950 minor), USD, covering all of the US.
  await shippingZones.defineZone({
    slug:    "domestic-us",
    title:   "Domestic US",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 950, currency: "USD", service_label: "Express" }],
    active:  true,
  });
  var cartB = await _freshCart();
  var quoteB = await checkout.quote({ cart_id: cartB.id, ship_to: shipToCA });
  check("zone-match: exactly one zone service", quoteB.shipping_rates.length === 1);
  check("zone-match: zone label surfaces",       quoteB.shipping_rates[0].label === "Express");
  check("zone-match: zone amount is $9.50 (950 minor)", quoteB.shipping_rates[0].amount_minor === 950);
  check("zone-match: NOT the fallback amount",   quoteB.shipping_rates[0].amount_minor !== 695);
  check("zone-match: id is the deterministic zone id",  quoteB.shipping_rates[0].id === "zone-domestic-us-0");

  // The selected zone rate round-trips through confirm (the id resolves
  // back to the same rate the shopper saw), proving the deterministic id
  // survives the quote → confirm re-lookup.
  var confirmed = await checkout.confirm({
    cart_id: cartB.id, ship_to: shipToCA,
    selected_shipping_id: "zone-domestic-us-0",
    customer: { email: "buyer@example.com" },
    idempotency_key: "zone-confirm-key-1",
  });
  check("zone-match: confirmed order charges the zone rate (950 minor)",
    confirmed && confirmed.order && confirmed.order.shipping_minor === 950);

  // ---- (c) a zone that does NOT cover the destination → fallback ----
  // Archive the covering US zone; define one covering only Canada. The
  // CA-US cart now matches no zone → the flat fallback returns.
  await shippingZones.archiveZone("domestic-us");
  await shippingZones.defineZone({
    slug:    "canada-only",
    title:   "Canada Only",
    regions: [{ country: "CA" }],
    rates:   [{ rate_minor: 1500, currency: "USD", service_label: "Cross-border" }],
    active:  true,
  });
  var cartC = await _freshCart();
  var quoteC = await checkout.quote({ cart_id: cartC.id, ship_to: shipToCA });
  check("no-match: back to exactly the fallback service count", quoteC.shipping_rates.length === 1);
  check("no-match: fallback id again",                          quoteC.shipping_rates[0].id === "std");
  check("no-match: fallback amount is $6.95 (695 minor) again", quoteC.shipping_rates[0].amount_minor === 695);

  // ---- (d) a DIGITAL-only cart is never quoted physical zone shipping ----
  // Define a fresh active US zone. A SHIPPABLE US cart matches it (the
  // control, proving the zone is live), but a DIGITAL-only cart — no
  // shipping-requiring line — does NOT: it falls through to the digital path,
  // mirroring the flat adapter's anyShippable gate. Without this guard a
  // no-shipment order would be charged physical zone shipping.
  await shippingZones.defineZone({
    slug:    "domestic-us-2",
    title:   "Domestic US 2",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 950, currency: "USD", service_label: "Express" }],
    active:  true,
  });
  var cartShippable = await _freshCart();
  var quoteShippable = await checkout.quote({ cart_id: cartShippable.id, ship_to: shipToCA });
  check("digital-guard control: a SHIPPABLE cart matches the US zone (950)",
    quoteShippable.shipping_rates.some(function (r) { return r.amount_minor === 950; }));

  var pd = await catalog.products.create({ slug: "zoned-ebook", title: "Zoned Ebook", status: "active" });
  var vd = await catalog.variants.create(pd.id, { sku: "ZE-1", weight_grams: 0, requires_shipping: false });
  await catalog.prices.set(vd.id, { currency: "USD", amount_minor: 1500 });
  await catalog.inventory.create("ZE-1", { stock_on_hand: 100 });
  var sidD = bShop.framework.uuid.v7();
  var cartD = await cart.create(sidD, { currency: "USD" });
  await cart.addLine(cartD.id, { variant_id: vd.id, qty: 1 });
  var quoteD = await checkout.quote({ cart_id: cartD.id, ship_to: shipToCA });
  check("digital-only: NOT charged the zone rate (950)",
    quoteD.shipping_rates.every(function (r) { return r.amount_minor !== 950; }));
  check("digital-only: no physical shipping service", quoteD.shipping_rates.length === 0);
}

async function run() { await _run(); }

module.exports = { run: run };
