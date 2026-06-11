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
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql", "0107_auto_discount.sql",
  "0209_auto_discount_unlock_code.sql", "0210_cart_discount_codes.sql",
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
  // Auto-discount engine — wired into BOTH checkout (so a coded discount is
  // honoured at confirm) and the storefront (so the cart-page coupon entry
  // mounts + the totals estimate reflects an applied code).
  var autoDiscount = bShop.autoDiscount.create({ query: query });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
    autoDiscount: autoDiscount,
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

  // A $5.00 DIGITAL good — requires_shipping = 0, no weight. A cart of
  // only this line ships nothing, so checkout must not force a street
  // address (mirrors the live "Buy Me a Coffee" product).
  var pd = await catalog.products.create({ slug: "digital-tip", title: "Buy Me a Coffee", status: "active" });
  var vd = await catalog.variants.create(pd.id, { sku: "TIP-1", weight_grams: 0, requires_shipping: false });
  await catalog.prices.set(vd.id, { currency: "USD", amount_minor: 500 });
  await catalog.inventory.create("TIP-1", { stock_on_hand: 9999 });

  // A code-gated discount: $4.00 off any cart, but only when the shopper
  // types code "SAVE4" on the cart page. Dormant until the code is applied.
  await autoDiscount.defineRule({
    slug:        "save4-code",
    title:       "Four off with code",
    trigger:     { kind: "cart_total_min", min_minor: 1 },
    value:       { kind: "amount_off_total", minor: 400 },
    unlock_code: "SAVE4",
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-carttot-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, checkout: checkout,
        autoDiscount: autoDiscount,
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

    // ---- cart-page coupon entry: apply / invalid / remove -------------
    // The coupon entry mounts when the discount engine is wired. The same
    // $29.99 cart (`jar`) hosts the whole apply→remove cycle.
    check("cart renders the coupon entry form",      cartPage.body.indexOf("action=\"/cart/coupon\"") !== -1);
    check("coupon form is CSRF-tokened (not edge-exempt)",
      cartPage.body.indexOf("action=\"/cart/coupon\"") !== -1 &&
      // _injectCsrfFields splices a hidden _csrf into every tokened container
      // form; the coupon form is one, so a _csrf input is present on the page.
      cartPage.body.indexOf("name=\"_csrf\"") !== -1);

    // CSRF posture pin: a POST WITHOUT the double-submit token is refused.
    var noTokenJar = await _cartWith([{ variant_id: v1.id, qty: 1 }]);
    var csrfMiss = await helpers.httpRequest({
      port: port, path: "/cart/coupon", method: "POST", jar: noTokenJar,
      form: { code: "SAVE4", _csrf: "" },   // explicit empty token defeats the helper's auto-attach
    });
    check("coupon POST without a CSRF token is 403", csrfMiss.status === 403);

    // Apply a VALID code → 303 with ?code_applied=1, and the followed cart
    // shows the discount in the totals + the applied-code chip.
    var applyOk = await helpers.httpRequest({ port: port, path: "/cart/coupon", method: "POST", jar: jar, form: { code: "SAVE4" } });
    check("valid code apply → 303 code_applied",     applyOk.status === 303 &&
      (applyOk.headers.location || "").indexOf("code_applied=1") !== -1);
    var afterApply = await helpers.httpRequest({ port: port, path: "/cart?code_applied=1", jar: jar });
    check("applied code shows the success notice",   afterApply.body.indexOf("Discount code applied.") !== -1);
    check("applied code shows the discount row",     afterApply.body.indexOf("totals-list__discount") !== -1 && afterApply.body.indexOf("$4.00") !== -1);
    check("applied code chip echoes the code",       afterApply.body.indexOf(">SAVE4<") !== -1);
    check("applied code offers a Remove control",    afterApply.body.indexOf("action=\"/cart/coupon/remove\"") !== -1);
    // The grand total dropped by $4.00 vs the un-coded $39.56 → $35.56.
    check("applied code reduces the grand total",    afterApply.body.indexOf("$35.56") !== -1);

    // Apply an UNKNOWN code → 303 with ?code_err=1 and a UNIFORM message.
    var applyBad = await helpers.httpRequest({ port: port, path: "/cart/coupon", method: "POST", jar: jar, form: { code: "NOPE-404" } });
    check("unknown code apply → 303 code_err",       applyBad.status === 303 &&
      (applyBad.headers.location || "").indexOf("code_err=1") !== -1);
    var afterBad = await helpers.httpRequest({ port: port, path: "/cart?code_err=1", jar: jar });
    check("unknown code shows the uniform error",    afterBad.body.indexOf("That code can't be applied to this cart.") !== -1);
    // The valid SAVE4 is still applied (the bad apply didn't clear it).
    check("unknown code didn't drop the valid one",  afterBad.body.indexOf("$35.56") !== -1);

    // XSS in the code echo: a payload-shaped code can't resolve to a rule
    // (so it never applies), but if it WERE echoed it must be escaped. Apply
    // a payload code, then confirm the raw script never reaches the page.
    var xssCode = "<script>alert(7)</script>";
    var applyXss = await helpers.httpRequest({ port: port, path: "/cart/coupon", method: "POST", jar: jar, form: { code: xssCode } });
    check("payload code apply → 303 code_err",       applyXss.status === 303 &&
      (applyXss.headers.location || "").indexOf("code_err=1") !== -1);
    var afterXss = await helpers.httpRequest({ port: port, path: "/cart?code_err=1", jar: jar });
    check("payload code never reaches the page raw", afterXss.body.indexOf("<script>alert(7)</script>") === -1);

    // Remove the applied code → totals restore to the un-coded $39.56.
    var removeOk = await helpers.httpRequest({ port: port, path: "/cart/coupon/remove", method: "POST", jar: jar, form: { code: "SAVE4" } });
    check("remove code → 303 code_removed",          removeOk.status === 303 &&
      (removeOk.headers.location || "").indexOf("code_removed=1") !== -1);
    var afterRemove = await helpers.httpRequest({ port: port, path: "/cart?code_removed=1", jar: jar });
    check("remove shows the removed notice",         afterRemove.body.indexOf("Discount code removed.") !== -1);
    check("remove restores the un-coded total",      afterRemove.body.indexOf("$39.56") !== -1);
    check("remove clears the discount row",          afterRemove.body.indexOf("totals-list__discount") === -1);

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

    // ---- a DIGITAL-only cart drops the shipping-address requirement ----
    // Every line is a no-shipment good → the form renders the address
    // block optional (line1 + city lose `required`) and the POST gate
    // requires only email + name + country. The shopper can complete the
    // order without typing a street address.
    var dJar = await _cartWith([{ variant_id: vd.id, qty: 1 }]);
    var dGet = await helpers.httpRequest({ port: port, path: "/checkout", jar: dJar });
    check("digital checkout form returns 200", dGet.status === 200);
    // line1 + city inputs have no `required` attr. Anchor on the input's
    // name= attribute and scan the tag up to its close for ` required`.
    function _inputHasRequired(html, name) {
      var at = html.indexOf("name=\"" + name + "\"");
      if (at === -1) return false;
      var end = html.indexOf(">", at);
      return html.slice(at, end).indexOf(" required") !== -1;
    }
    check("digital form: line1 input is NOT required", !_inputHasRequired(dGet.body, "line1"));
    check("digital form: city input is NOT required",  !_inputHasRequired(dGet.body, "city"));
    check("digital form: email input stays required",  _inputHasRequired(dGet.body, "email"));
    check("digital form: country input stays required (feeds tax)", _inputHasRequired(dGet.body, "country"));
    check("digital form: honest no-address note shown",
      dGet.body.indexOf("checkout-page__digital-note") !== -1 &&
      dGet.body.indexOf("digital order") !== -1);

    // POST with ONLY email + name + country (no street/city/state/postal)
    // confirms — the digital order ships nothing.
    function _dPost(form) {
      return helpers.httpRequest({ port: port, path: "/checkout", method: "POST", jar: dJar, form: form });
    }
    var dConfirm = await _dPost({ email: "tipper@example.com", name: "Tipper", country: "US" });
    check("digital confirm with no address redirects to /pay (303)",
      dConfirm.status === 303 && (dConfirm.headers.location || "").indexOf("/pay/") === 0);
    var dOrderId = (dConfirm.headers.location || "").slice("/pay/".length);
    var dPlaced = await order.get(dOrderId);
    // Subtotal 500; US tax @8.75% = 500*875/10000 = 43.75 → 44; shipping 0
    // (no-shipment cart) → grand total 544. Tax keys off country, which the
    // form still collects, so a digital order is still taxed correctly.
    check("digital order placed: $5 subtotal, taxed, ZERO shipping",
      dPlaced && dPlaced.subtotal_minor === 500 && dPlaced.tax_minor === 44 &&
      dPlaced.shipping_minor === 0 && dPlaced.grand_total_minor === 544);

    // Format validation still applies when a value IS supplied: a digital
    // cart that POSTs a garbage US postal still gets the postal field
    // error (relaxing presence never relaxes format).
    var dJar2 = await _cartWith([{ variant_id: vd.id, qty: 1 }]);
    await helpers.httpRequest({ port: port, path: "/checkout", jar: dJar2 });   // seed CSRF
    var dBadZip = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: dJar2,
      form: { email: "tipper@example.com", name: "Tipper", country: "US", postal: "abc" },
    });
    check("digital cart: garbage postal still fails with the postal field error (400)",
      dBadZip.status === 400 && dBadZip.body.indexOf("co-err-postal") !== -1);

    // ---- a MIXED cart (any shippable line) keeps the FULL requirement ----
    // One digital line + one physical line → the cart still ships, so the
    // address stays mandatory. A POST without line1 fails with co-err-line1.
    var mJar = await _cartWith([
      { variant_id: vd.id, qty: 1 },   // digital
      { variant_id: v1.id, qty: 1 },   // physical
    ]);
    var mGet = await helpers.httpRequest({ port: port, path: "/checkout", jar: mJar });
    check("mixed checkout form returns 200", mGet.status === 200);
    check("mixed form: line1 input STAYS required", _inputHasRequired(mGet.body, "line1"));
    check("mixed form: no digital no-address note", mGet.body.indexOf("checkout-page__digital-note") === -1);
    var mBad = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: mJar,
      form: { email: "buyer@example.com", name: "Buyer", country: "US", state: "CA", postal: "94103", city: "SF" },
    });
    check("mixed cart: missing line1 still fails (400 with co-err-line1)",
      mBad.status === 400 && mBad.body.indexOf("co-err-line1") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

async function run() { await _run(); }

module.exports = { run: run };
