"use strict";
/**
 * Cart + checkout pricing truth — full HTTP integration.
 *
 * Boots a real b.createApp with the storefront mounted exactly as
 * server.js mounts it with checkout wired: catalog + cart + order +
 * a stub Stripe payment + an operator tax table (US 8.75%) + a flat
 * $6.95 shipping service, sharing one in-memory SQLite query handle.
 *
 * The shopper must see the real grand total BEFORE paying. This pins:
 *   - /cart renders Subtotal + estimated tax + estimated shipping +
 *     an Estimated total computed from the same tax/shipping primitives
 *     the charge runs through (the grand total = subtotal + tax + ship);
 *   - the figures carry an estimate label while the address is unknown;
 *   - per-line stock state surfaces (out-of-stock + low-stock pills),
 *     never a hardcoded "in stock";
 *   - an empty cart stays the empty-state card (no fabricated totals);
 *   - the /checkout form summary shows the same breakdown;
 *   - a rejected address re-renders the form with the one bad field
 *     marked (aria-invalid + co-err-* span), every typed value
 *     preserved + escaped, and a corrected resubmit confirms.
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

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql",
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
  var n = 0;
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      n += 1;
      return { id: "pi_" + n, client_secret: "pi_" + n + "_secret", status: "requires_payment_method", _amount: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query, cursorSecret: "cart-totals-sf" });
  // US sales tax 8.75%; a single $6.95 flat US shipping service.
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 875 }] });
  var shipping = bShop.shipping.create({ services: [
    { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] },
  ] });
  var payment  = _stubPayment();
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
  });

  // A $29.99 product with stock; a $19.99 low-stock product; a $9.99
  // sold-out product. Low-stock threshold default is 5 → set the low
  // SKU to 3 available, the sold-out SKU to 0 available.
  var p1 = await catalog.products.create({ slug: "in-stock", title: "In Stock Widget", status: "active" });
  var v1 = await catalog.variants.create(p1.id, { sku: "OK-1", weight_grams: 100 });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create("OK-1", { stock_on_hand: 50 });

  var p2 = await catalog.products.create({ slug: "low-stock", title: "Low Stock Widget", status: "active" });
  var v2 = await catalog.variants.create(p2.id, { sku: "LOW-1", weight_grams: 100 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 1999 });
  await catalog.inventory.create("LOW-1", { stock_on_hand: 3 });

  var p3 = await catalog.products.create({ slug: "sold-out", title: "Sold Out Widget", status: "active" });
  var v3 = await catalog.variants.create(p3.id, { sku: "OUT-1", weight_grams: 100 });
  await catalog.prices.set(v3.id, { currency: "USD", amount_minor: 999 });
  await catalog.inventory.create("OUT-1", { stock_on_hand: 0 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-carttot-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, checkout: checkout,
        default_shipping_id: "std",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  // Build an active cart with the three lines and a session jar.
  async function _cartWith(lines) {
    var sid = b.uuid.v7();
    var c = await cart.create(sid, { currency: "USD" });
    for (var i = 0; i < lines.length; i += 1) {
      await cart.addLine(c.id, { variant_id: lines[i].variant_id, qty: lines[i].qty });
    }
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": ["shop_sid=" + sid + "; Path=/"] });
    return jar;
  }

  try {
    // ---- /cart shows the REAL estimated total before pay --------------
    // One unit of the $29.99 product: subtotal 2999, tax @8.75% = 262
    // (2999*875/10000 = 262.4 → banker's-round 262), shipping 695 →
    // estimated grand total 3956 ($39.56).
    var jar = await _cartWith([{ variant_id: v1.id, qty: 1 }]);
    var cartPage = await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    check("cart returns 200",                       cartPage.status === 200);
    check("cart shows the subtotal",                cartPage.body.indexOf("$29.99") !== -1);
    check("cart shows an estimated tax row",        /Estimated tax/.test(cartPage.body) && cartPage.body.indexOf("$2.62") !== -1);
    check("cart shows an estimated shipping row",   /Estimated shipping/.test(cartPage.body) && cartPage.body.indexOf("$6.95") !== -1);
    check("cart shows the estimated grand total",   /Estimated total/.test(cartPage.body) && cartPage.body.indexOf("$39.56") !== -1);
    check("cart total != subtotal (tax+ship added)", cartPage.body.indexOf("$39.56") !== -1 && cartPage.body.indexOf("$29.99") !== -1);
    check("cart note explains the estimate finalizes at the address step",
      cartPage.body.indexOf("exact total is confirmed once you enter your shipping address") !== -1);

    // ---- truthful per-line stock state --------------------------------
    var stockJar = await _cartWith([
      { variant_id: v1.id, qty: 1 },   // ok
      { variant_id: v2.id, qty: 1 },   // low (3 ≤ 5)
      { variant_id: v3.id, qty: 1 },   // out (0)
    ]);
    var stockPage = await helpers.httpRequest({ port: port, path: "/cart", jar: stockJar });
    check("cart surfaces an out-of-stock line",     stockPage.body.indexOf("cart-line__stock--out") !== -1 && stockPage.body.indexOf("Out of stock") !== -1);
    check("cart surfaces a low-stock line",          stockPage.body.indexOf("cart-line__stock--low") !== -1 && stockPage.body.indexOf("Low stock") !== -1);
    // Exactly two pills — the in-stock line shows none (the implied default).
    check("in-stock line carries no pill",           (stockPage.body.match(/cart-line__stock--/g) || []).length === 2);

    // ---- empty cart: no fabricated totals -----------------------------
    var emptyJar = helpers.cookieJar();
    var emptyPage = await helpers.httpRequest({ port: port, path: "/cart", jar: emptyJar });
    check("empty cart shows the empty-state card",   emptyPage.body.indexOf("cart-empty__card") !== -1);
    check("empty cart shows no estimated total",      emptyPage.body.indexOf("Estimated total") === -1);

    // ---- /checkout form shows the same breakdown ----------------------
    var coPage = await helpers.httpRequest({ port: port, path: "/checkout", jar: jar });
    check("checkout form returns 200",               coPage.status === 200);
    check("checkout form shows the subtotal",         coPage.body.indexOf("$29.99") !== -1);
    check("checkout summary shows estimated tax",     /Estimated tax/.test(coPage.body) && coPage.body.indexOf("$2.62") !== -1);
    check("checkout summary shows estimated shipping", /Estimated shipping/.test(coPage.body) && coPage.body.indexOf("$6.95") !== -1);
    check("checkout summary shows the grand total",   coPage.body.indexOf("$39.56") !== -1);

    // ---- the displayed estimate AGREES with the confirmed charge ------
    // Confirm the order for a US address and assert the order's grand
    // total equals the cart's estimated total ($39.56) — proving the
    // pre-pay number is the same math the charge uses.
    var confirm = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar,
      form: { email: "buyer@example.com", name: "Buyer", line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103" },
    });
    check("checkout confirm redirects to /pay",       confirm.status === 303 && (confirm.headers.location || "").indexOf("/pay/") === 0);
    var orderId = (confirm.headers.location || "").slice("/pay/".length);
    var placed = await order.get(orderId);
    check("confirmed order grand total = the estimate shown",  placed && placed.grand_total_minor === 3956);
    check("confirmed order tax = the estimated tax",  placed && placed.tax_minor === 262);
    check("confirmed order shipping = the estimated shipping", placed && placed.shipping_minor === 695);

    // ---- server-side address validation re-renders the form ------------
    // A rejected POST must land back ON the form (not a dead-end error
    // page) with the one bad field marked and everything the shopper
    // typed preserved. Rejected confirms never convert the cart, so one
    // fresh cart hosts the whole matrix.
    var vJar = await _cartWith([{ variant_id: v1.id, qty: 1 }]);
    // GET the form first — seeds the CSRF cookie into the jar so the POSTs
    // below carry the double-submit token (the gate is on in this app).
    var vSeed = await helpers.httpRequest({ port: port, path: "/checkout", jar: vJar });
    check("validation cart renders the form (200)", vSeed.status === 200);
    function _coPost(form) {
      return helpers.httpRequest({ port: port, path: "/checkout", method: "POST", jar: vJar, form: form });
    }
    var goodForm = { email: "buyer@example.com", name: "Buyer", line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103" };

    var badZip = await _coPost(Object.assign({}, goodForm, { postal: "abc", line1: "123 Preserved St" }));
    check("bad ZIP re-renders the checkout form (400)", badZip.status === 400 && badZip.body.indexOf("form-stack") !== -1);
    check("bad ZIP marks the postal field",             badZip.body.indexOf("aria-describedby=\"co-err-postal\"") !== -1);
    check("bad ZIP marks ONLY one field",               (badZip.body.match(/aria-invalid="true"/g) || []).length === 1);
    check("re-render preserves the typed street",       badZip.body.indexOf("value=\"123 Preserved St\"") !== -1);
    check("re-render preserves the typed email",        badZip.body.indexOf("value=\"buyer@example.com\"") !== -1);

    var badCountry = await _coPost(Object.assign({}, goodForm, { country: "XX" }));
    check("unknown country marks the country field (400)", badCountry.status === 400 && badCountry.body.indexOf("co-err-country") !== -1);

    var badState = await _coPost(Object.assign({}, goodForm, { state: "ZZ" }));
    check("bogus US state marks the state field (400)",  badState.status === 400 && badState.body.indexOf("co-err-state") !== -1);

    var noState = await _coPost(Object.assign({}, goodForm, { state: "" }));
    check("missing US state marks the state field (400)", noState.status === 400 && noState.body.indexOf("co-err-state") !== -1);

    var noCity = await _coPost(Object.assign({}, goodForm, { city: "" }));
    check("missing city marks the city field (400)",     noCity.status === 400 && noCity.body.indexOf("co-err-city") !== -1);

    var badEmail = await _coPost(Object.assign({}, goodForm, { email: "not-an-email" }));
    check("garbage email marks the email field (400)",   badEmail.status === 400 && badEmail.body.indexOf("co-err-email") !== -1);

    // Every echoed field is escaped at the echo sink — the raw payload
    // never appears (escape-by-default binding rule). A bad postal forces
    // the re-render; the payload rides the other fields.
    var payload = "\"><script>alert(9)</script>";
    var xss = await _coPost(Object.assign({}, goodForm, {
      name: "N" + payload, line1: "L" + payload, line2: "M" + payload, city: "C" + payload,
      postal: "abc",
    }));
    check("xss probe re-renders (400)",          xss.status === 400);
    check("raw script payload never appears",    xss.body.indexOf("<script>alert(9)</script>") === -1);
    check("payload is escaped into the value attr",
      xss.body.indexOf("&quot;&gt;&lt;script&gt;alert(9)&lt;/script&gt;") !== -1);

    // Dollar sequences survive the splice — String.replace's `$&`/"$`"
    // substitution would corrupt the document; _spliceRaw must not.
    var dollar = await _coPost(Object.assign({}, goodForm, { line1: "5 $& $` St", postal: "abc" }));
    check("dollar sequences round-trip the re-render intact", dollar.body.indexOf("5 $&amp; $` St") !== -1);

    // The same cart confirms once the shopper corrects the field.
    var fixed = await _coPost(goodForm);
    check("corrected resubmit confirms (303 → /pay)",
      fixed.status === 303 && (fixed.headers.location || "").indexOf("/pay/") === 0);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

async function run() { await _run(); }

module.exports = { run: run };
