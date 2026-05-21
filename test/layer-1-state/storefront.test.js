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
}

module.exports = { run: run };
