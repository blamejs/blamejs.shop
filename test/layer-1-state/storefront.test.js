"use strict";
/**
 * storefront — HTML renderers.
 *
 * Layer 1 for the renderHome / renderProduct / renderCart pure
 * functions. Tests don't exercise the route mount (that's layer 2
 * HTTP integration) — just the HTML output shape + XSS escape +
 * empty-state behavior.
 */

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var storefront = bShop.storefront;

async function _home() {
  var html = storefront.renderHome({
    products: [
      { slug: "widget-pro", title: "Widget Pro", starting_price_minor: 2999, starting_price_currency: "USD" },
      { slug: "widget-lite", title: "Widget Lite", starting_price_minor: 1999, starting_price_currency: "USD" },
    ],
    shop_name:  "Acme Shop",
    cart_count: 2,
  });
  check("home includes shop name",      html.indexOf("Acme Shop") !== -1);
  check("home lists both products",      html.indexOf("Widget Pro") !== -1 && html.indexOf("Widget Lite") !== -1);
  check("home includes prices",          html.indexOf("$29.99") !== -1 && html.indexOf("$19.99") !== -1);
  check("home renders cart count",        html.indexOf("Cart · 2") !== -1);
  check("home has product links",         html.indexOf("/products/widget-pro") !== -1);
  check("home is full HTML doc",          html.indexOf("<!DOCTYPE html>") === 0);
}

async function _homeEmpty() {
  var html = storefront.renderHome({ products: [], shop_name: "Acme" });
  check("empty home shows no-products copy", html.indexOf("No products yet") !== -1);
}

async function _product() {
  var html = storefront.renderProduct({
    product: {
      slug:        "widget-pro",
      title:       "Widget Pro",
      description: "The pro variant of the widget.",
    },
    variants: [
      { id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large", options: { color: "black", size: "L" } },
      { id: "v2", sku: "WDG-PRO-BLK-M", title: "Black / Medium", options: { color: "black", size: "M" } },
    ],
    prices: {
      v1: { amount_minor: 2999, currency: "USD" },
      v2: { amount_minor: 2999, currency: "USD" },
    },
    shop_name: "Acme",
  });
  check("product page shows title",       html.indexOf("Widget Pro") !== -1);
  check("product page shows description",  html.indexOf("The pro variant") !== -1);
  check("product page lists variant SKUs", html.indexOf("WDG-PRO-BLK-L") !== -1 && html.indexOf("WDG-PRO-BLK-M") !== -1);
  check("product page shows prices",       html.indexOf("$29.99") !== -1);
}

async function _productNoVariants() {
  var html = storefront.renderProduct({
    product: { slug: "x", title: "Empty", description: "" },
    variants: [], prices: {},
    shop_name: "Acme",
  });
  check("no-variant product shows empty row", html.indexOf("No variants available") !== -1);
}

async function _cart() {
  var html = storefront.renderCart({
    lines: [
      { sku: "ABC-1", qty: 2, unit_amount_minor: 2999, unit_currency: "USD" },
      { sku: "ABC-2", qty: 1, unit_amount_minor: 1999, unit_currency: "USD" },
    ],
    totals: { subtotal_minor: 7997, grand_total_minor: 7997, currency: "USD" },
    shop_name: "Acme",
  });
  check("cart lists both lines",   html.indexOf("ABC-1") !== -1 && html.indexOf("ABC-2") !== -1);
  check("cart shows line totals",   html.indexOf("$59.98") !== -1 && html.indexOf("$19.99") !== -1);
  check("cart shows subtotal",      html.indexOf("$79.97") !== -1);
  check("cart count = line count",  html.indexOf("Cart · 2") !== -1);
}

async function _cartEmpty() {
  var html = storefront.renderCart({
    lines: [],
    totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
    shop_name: "Acme",
  });
  check("empty cart shows empty copy",  html.indexOf("Your cart is empty") !== -1);
  check("empty cart shows $0",            html.indexOf("$0.00") !== -1);
  check("empty cart count = 0",            html.indexOf("Cart · 0") !== -1);
}

async function _xssEscape() {
  // Product title with XSS attempt — must be HTML-escaped.
  var html = storefront.renderHome({
    products: [{ slug: "x", title: "<script>alert(1)</script>", starting_price_minor: 100 }],
    shop_name: "Acme",
  });
  check("renderHome escapes <script>", html.indexOf("<script>alert") === -1);
  check("renderHome shows escaped form", html.indexOf("&lt;script&gt;") !== -1);

  // Slug in the link href — also escaped (otherwise href injection).
  // The slug went through HTML-escape, so quotes inside would be
  // escaped too. Plain alnum + hyphen slugs pass through unchanged.
  check("normal slug passes through", html.indexOf("/products/x") !== -1);
}

async function _checkoutForm() {
  var html = storefront.renderCheckoutForm({
    lines:  [{ sku: "X-1", qty: 1, unit_amount_minor: 2999, unit_currency: "USD" }],
    totals: { subtotal_minor: 2999, currency: "USD" },
    shop_name: "Acme",
  });
  check("checkout form has email field",    /name=\"email\"/.test(html));
  check("checkout form has country field",   /name=\"country\"/.test(html));
  check("checkout form shows subtotal",       html.indexOf("$29.99") !== -1);
  check("checkout form POSTs to /checkout",   /action=\"\/checkout\"/.test(html));
}

async function _payPage() {
  var html = storefront.renderPayPage({
    order:           { id: "ord_test", grand_total_minor: 7218, currency: "USD" },
    client_secret:   "pi_xxx_secret_yyy",
    publishable_key: "pk_test_123",
    shop_name:       "Acme",
  });
  check("pay page loads Stripe.js",          html.indexOf("https://js.stripe.com/v3/") !== -1);
  check("pay page injects pk as JSON",        html.indexOf("\"pk_test_123\"") !== -1);
  check("pay page injects client_secret",      html.indexOf("\"pi_xxx_secret_yyy\"") !== -1);
  check("pay page shows total",                html.indexOf("$72.18") !== -1);
  check("pay page references order id",        html.indexOf("ord_test") !== -1);
}

async function _orderPage() {
  var html = storefront.renderOrder({
    order: {
      id: "ord_test", status: "paid", currency: "USD",
      subtotal_minor:    5998,
      tax_minor:         525,
      shipping_minor:    695,
      grand_total_minor: 7218,
      lines: [{ sku: "X-1", qty: 2, unit_amount_minor: 2999, unit_currency: "USD", line_total_minor: 5998 }],
    },
    shop_name: "Acme",
  });
  check("order page shows status",        html.indexOf("paid") !== -1);
  check("order page lists line",           html.indexOf("X-1") !== -1);
  check("order page shows tax",            html.indexOf("$5.25") !== -1);
  check("order page shows total",          html.indexOf("$72.18") !== -1);
}

async function _validation() {
  assert.throws(function () { storefront.renderHome();             }, /products required/);
  assert.throws(function () { storefront.renderHome({});             }, /products required/);
  assert.throws(function () { storefront.renderProduct();          }, /product required/);
  assert.throws(function () { storefront.renderProduct({});          }, /product required/);
  assert.throws(function () { storefront.renderCart();             }, /opts required/);
}

async function _layoutTokens() {
  // Every page renderer hands back the same shell — assert the design-system
  // tokens, the reset hooks the page renderers depend on, and the new search
  // form land in every rendered document.
  var html = storefront.renderHome({ products: [], shop_name: "Acme" });

  // Palette tokens.
  check("layout declares --ink token",       html.indexOf("--ink:") !== -1);
  check("layout declares --ink-2 token",      html.indexOf("--ink-2:") !== -1);
  check("layout declares --mute token",       html.indexOf("--mute:") !== -1);
  check("layout declares --hair token",       html.indexOf("--hair:") !== -1);
  check("layout declares --paper token",      html.indexOf("--paper:") !== -1);
  check("layout declares --bg token",         html.indexOf("--bg:") !== -1);
  check("layout declares --accent token",     html.indexOf("--accent:") !== -1);
  check("layout declares --accent-d token",   html.indexOf("--accent-d:") !== -1);

  // Typography tokens.
  check("layout declares --font-display",    html.indexOf("--font-display:") !== -1);
  check("layout declares --font-body",       html.indexOf("--font-body:") !== -1);
  check("layout declares --text-xs",          html.indexOf("--text-xs:") !== -1);
  check("layout declares --text-sm",          html.indexOf("--text-sm:") !== -1);
  check("layout declares --text-base",        html.indexOf("--text-base:") !== -1);
  check("layout declares --text-lg",          html.indexOf("--text-lg:") !== -1);
  check("layout declares --text-xl",          html.indexOf("--text-xl:") !== -1);
  check("layout declares --text-2xl",         html.indexOf("--text-2xl:") !== -1);
  check("layout declares --text-3xl",         html.indexOf("--text-3xl:") !== -1);

  // Spacing scale.
  check("layout declares --space-0",   html.indexOf("--space-0:") !== -1);
  check("layout declares --space-1",   html.indexOf("--space-1:") !== -1);
  check("layout declares --space-2",   html.indexOf("--space-2:") !== -1);
  check("layout declares --space-3",   html.indexOf("--space-3:") !== -1);
  check("layout declares --space-4",   html.indexOf("--space-4:") !== -1);
  check("layout declares --space-5",   html.indexOf("--space-5:") !== -1);
  check("layout declares --space-6",   html.indexOf("--space-6:") !== -1);
  check("layout declares --space-7",   html.indexOf("--space-7:") !== -1);
  check("layout declares --space-8",   html.indexOf("--space-8:") !== -1);

  // Radius, shadow, motion.
  check("layout declares --radius-sm",     html.indexOf("--radius-sm:") !== -1);
  check("layout declares --radius-md",     html.indexOf("--radius-md:") !== -1);
  check("layout declares --radius-lg",     html.indexOf("--radius-lg:") !== -1);
  check("layout declares --shadow-sm",     html.indexOf("--shadow-sm:") !== -1);
  check("layout declares --shadow-md",     html.indexOf("--shadow-md:") !== -1);
  check("layout declares --ease-out",      html.indexOf("--ease-out:") !== -1);
  check("layout declares --duration-fast", html.indexOf("--duration-fast:") !== -1);
  check("layout declares --duration-mid",  html.indexOf("--duration-mid:") !== -1);

  // Reset + a11y hooks the page renderers rely on.
  check("layout sets box-sizing reset",       html.indexOf("box-sizing: border-box") !== -1);
  check("layout uses :focus-visible outline",  html.indexOf(":focus-visible") !== -1);
  check("layout respects reduced-motion",      html.indexOf("prefers-reduced-motion: no-preference") !== -1);
  check("layout uses tabular-nums for prices", html.indexOf("tabular-nums") !== -1);
  check("layout offers skip-link target",       html.indexOf("id=\"main\"") !== -1);

  // Shared classes the other page-redesign agents will compose against.
  check("layout defines .grid class",         html.indexOf(".grid") !== -1);
  check("layout defines .card class",         html.indexOf(".card") !== -1);
  check("layout defines .btn class",          html.indexOf(".btn") !== -1);
  check("layout defines .btn-secondary class", html.indexOf(".btn-secondary") !== -1);
  check("layout defines .summary-table class", html.indexOf(".summary-table") !== -1);
  check("layout defines .empty class",        html.indexOf(".empty") !== -1);
  check("layout defines .cart-pill class",    html.indexOf(".cart-pill") !== -1);
  check("layout defines .hero class",         html.indexOf(".hero") !== -1);

  // Header search form lands and POSTs to /search via GET.
  check("header has site-search form",      html.indexOf("class=\"site-search\"") !== -1);
  check("search form targets /search",      html.indexOf("action=\"/search\"") !== -1);
  check("search form uses GET method",       html.indexOf("method=\"get\"") !== -1);
  check("search form has q input",          html.indexOf("name=\"q\"") !== -1);
  check("search form input is type=search", html.indexOf("type=\"search\"") !== -1);

  // Footer ships brand + tagline + primitive list + copyright.
  check("footer is rendered",                 html.indexOf("class=\"site-footer\"") !== -1);
  check("footer lists 'Built on blamejs'",     html.indexOf("Built on blamejs") !== -1);
  check("footer lists 'Server-rendered'",     html.indexOf("Server-rendered") !== -1);
  check("footer lists 'PQC-first'",           html.indexOf("PQC-first") !== -1);
  check("footer shows copyright year",        /&copy; \d{4}/.test(html));

  // Fonts: both font families load + the display font binds h1-h3.
  check("layout loads Montserrat",  html.indexOf("family=Montserrat") !== -1);
  check("layout loads Inter",       html.indexOf("Inter:wght") !== -1);
}

async function run() {
  await _home();
  await _homeEmpty();
  await _product();
  await _productNoVariants();
  await _cart();
  await _cartEmpty();
  await _checkoutForm();
  await _payPage();
  await _orderPage();
  await _xssEscape();
  await _validation();
  await _layoutTokens();
}

module.exports = { run: run };
