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
  check("home renders cart count",        html.indexOf("Cart, 2 items") !== -1);
  check("home has product links",         html.indexOf("/products/widget-pro") !== -1);
  check("home is full HTML doc",          html.indexOf("<!DOCTYPE html>") === 0);
}

async function _homeEmpty() {
  var html = storefront.renderHome({ products: [], shop_name: "Acme" });
  // Empty catalog still ships the storefront shell + hero + supporting
  // sections — visitors see a designed surface, not a placeholder.
  check("empty home renders dark hero",            html.indexOf("class=\"hero hero--dark\"") !== -1);
  check("empty home has hero code preview",         html.indexOf("class=\"hero__card\"") !== -1);
  check("empty home shows marquee",                 html.indexOf("class=\"marquee\"") !== -1);
  check("empty home shows collections",            html.indexOf("class=\"collections__grid\"") !== -1);
  check("empty home shows framework band",         html.indexOf("class=\"framework-band\"") !== -1);
  check("empty home renders catalog section",      html.indexOf("class=\"catalog-section\"") !== -1);
  check("empty home shows admin curl snippet",      html.indexOf("class=\"catalog-empty__code\"") !== -1);
  check("empty home anchors at #catalog",          html.indexOf("id=\"catalog\"") !== -1);
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
  check("cart count = line count",  html.indexOf("Cart, 2 items") !== -1);
}

async function _cartEmpty() {
  var html = storefront.renderCart({
    lines: [],
    totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
    shop_name: "Acme",
  });
  check("empty cart renders empty-state card",  html.indexOf("cart-empty__card") !== -1);
  check("empty cart shows empty-state title",   html.indexOf("Your cart is empty") !== -1);
  check("empty cart offers browse CTA",         html.indexOf("Browse products") !== -1);
  check("empty cart count = 0",                  html.indexOf("Cart, 0 items") !== -1);
}

async function _search() {
  var html = storefront.renderSearch({
    q: "widget",
    products: [
      { slug: "widget-pro", title: "Widget Pro", starting_price_minor: 2999, starting_price_currency: "USD" },
    ],
    shop_name:  "Acme Shop",
    cart_count: 0,
  });
  check("search shows header",            html.indexOf("Search results") !== -1);
  check("search shows match summary",      html.indexOf("Showing 1 match") !== -1);
  check("search renders product card",     html.indexOf("Widget Pro") !== -1);
  check("search renders product price",     html.indexOf("$29.99") !== -1);
  check("search header form pre-fills q",   html.indexOf("value=\"widget\"") !== -1);
  check("search is a full HTML doc",        html.indexOf("<!DOCTYPE html>") === 0);

  var pluralHtml = storefront.renderSearch({
    q: "widget",
    products: [
      { slug: "a", title: "Widget A", starting_price_minor: 100 },
      { slug: "b", title: "Widget B", starting_price_minor: 200 },
    ],
    shop_name: "Acme",
  });
  check("search pluralizes 'matches'", pluralHtml.indexOf("Showing 2 matches") !== -1);
}

async function _searchEmpty() {
  var html = storefront.renderSearch({ q: "nothing-matches", products: [], shop_name: "Acme" });
  check("empty search shows no-match copy",  html.indexOf("Nothing in the catalog matched") !== -1);
  check("empty search includes the query",    html.indexOf("nothing-matches") !== -1);
  check("empty search shows browse fallback", html.indexOf("Browse the full catalog") !== -1);

  var emptyQ = storefront.renderSearch({ q: "", products: [], shop_name: "Acme" });
  check("blank q shows prompt copy",         emptyQ.indexOf("Use the search box in the header") !== -1);
}

async function _searchXss() {
  // Customer-supplied q with a `<script>` tag — must be HTML-escaped
  // both in the summary line AND in the header input's `value` so
  // there's no avenue for reflected-XSS via the search input.
  var html = storefront.renderSearch({
    q: "<script>alert(1)</script>",
    products: [],
    shop_name:  "Acme",
  });
  check("search XSS: <script> not rendered raw", html.indexOf("<script>alert(1)") === -1);
  check("search XSS: escaped form in summary",    html.indexOf("&lt;script&gt;") !== -1);
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
  assert.throws(function () { storefront.renderSearch();             }, /q \(string\) required/);
  assert.throws(function () { storefront.renderSearch({});             }, /q \(string\) required/);
  assert.throws(function () { storefront.renderSearch({ q: 42 });   }, /q \(string\) required/);
}

async function _layoutTokens() {
  // The storefront layout MUST NOT inline its design system. CSS belongs
  // in the theme stylesheet so operators can override it without touching
  // the framework — and the framework's CSP defaults (style-src 'self')
  // block inline <style> blocks anyway. This test enforces that contract.
  var fs   = require("fs");
  var path = require("path");
  var html = storefront.renderHome({ products: [], shop_name: "Acme" });

  // (1) Layout: shell-only — no inline styles, no third-party font hosts.
  // The font-host regexes anchor on the scheme + dot-boundary so the
  // assertion isn't satisfied by a substring inside an unrelated URL —
  // it specifically refuses a `<link href="https://fonts.{googleapis,
  // gstatic}.com/…">` tag in the layout, regardless of attribute order.
  check("layout has NO inline <style> block",        html.indexOf("<style") === -1);
  check("layout has NO Google Fonts link",           !(/https?:\/\/fonts\.googleapis\.com\//.test(html)));
  check("layout has NO Google Fonts preconnect",     !(/https?:\/\/fonts\.gstatic\.com/.test(html)));
  check("layout links the theme stylesheet",         html.indexOf("rel=\"stylesheet\"") !== -1);
  check("layout points at default theme css",         html.indexOf("/assets/themes/default/css/main.css") !== -1);

  // (2) Layout: HTML structure the page renderers + a11y consumers depend on.
  check("layout offers skip-link target",             html.indexOf("id=\"main\"") !== -1);
  check("utility bar rendered",                       html.indexOf("class=\"utility-bar\"") !== -1);
  check("header has site-search form",                html.indexOf("class=\"site-search\"") !== -1);
  check("search form targets /search",                html.indexOf("action=\"/search\"") !== -1);
  check("search form uses GET method",                html.indexOf("method=\"get\"") !== -1);
  check("search form has q input",                    html.indexOf("name=\"q\"") !== -1);
  check("search form input is type=search",           html.indexOf("type=\"search\"") !== -1);
  check("nav has account icon link",                  html.indexOf("class=\"site-nav__icon\"") !== -1);
  check("cart pill has count badge",                  html.indexOf("class=\"cart-pill__count\"") !== -1);
  check("newsletter band rendered",                   html.indexOf("class=\"newsletter-band\"") !== -1);
  check("newsletter form posts email",                 html.indexOf("name=\"email\"") !== -1);
  check("footer is rendered",                         html.indexOf("class=\"site-footer\"") !== -1);
  check("footer has Shop column",                      html.indexOf(">Shop</h4>") !== -1);
  check("footer has Framework column",                html.indexOf(">Framework</h4>") !== -1);
  check("footer has Operators column",                html.indexOf(">Operators</h4>") !== -1);
  check("footer references blamejs",                  html.indexOf("built on blamejs") !== -1);
  check("footer shows copyright year",                 /&copy; \d{4}/.test(html));

  // (3) Operator override: passing `theme_css` swaps the stylesheet URL.
  var overridden = storefront.renderHome({
    products:  [],
    shop_name: "Acme",
    theme_css: "/assets/themes/acme/css/main.css",
  });
  check("theme_css override replaces stylesheet URL", overridden.indexOf("/assets/themes/acme/css/main.css") !== -1);
  check("theme_css override drops default URL",        overridden.indexOf("/assets/themes/default/css/main.css") === -1);

  // (4) The shipped default theme stylesheet carries the design system —
  //     palette tokens, typography scale, shared classes the page
  //     renderers compose against. Read it off disk because that's the
  //     artifact operators actually upload to R2.
  var css = fs.readFileSync(path.join(__dirname, "../../themes/default/assets/css/main.css"), "utf8");
  var tokens = [
    "--ink:", "--ink-2:", "--mute:", "--hair:", "--paper:", "--bg:",
    "--accent:", "--accent-d:",
    "--font-display:", "--font-body:",
    "--text-xs:", "--text-sm:", "--text-base:", "--text-lg:",
    "--text-xl:", "--text-2xl:", "--text-3xl:",
    "--space-0:", "--space-1:", "--space-2:", "--space-3:", "--space-4:",
    "--space-5:", "--space-6:", "--space-7:", "--space-8:",
    "--radius-sm:", "--radius-md:", "--radius-lg:",
    "--shadow-sm:", "--shadow-md:",
    "--ease-out:", "--duration-fast:", "--duration-mid:",
  ];
  for (var i = 0; i < tokens.length; i += 1) {
    check("theme css declares " + tokens[i] + " token", css.indexOf(tokens[i]) !== -1);
  }
  check("theme css sets box-sizing reset",        css.indexOf("box-sizing: border-box") !== -1);
  check("theme css uses :focus-visible outline",  css.indexOf(":focus-visible") !== -1);
  check("theme css respects reduced-motion",      css.indexOf("prefers-reduced-motion") !== -1);
  check("theme css uses tabular-nums for prices", css.indexOf("tabular-nums") !== -1);
  var classes = [".grid", ".card", ".btn", ".btn-secondary", ".summary-table", ".empty", ".cart-pill", ".hero"];
  for (var j = 0; j < classes.length; j += 1) {
    check("theme css defines " + classes[j] + " class", css.indexOf(classes[j]) !== -1);
  }
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
  await _search();
  await _searchEmpty();
  await _searchXss();
  await _xssEscape();
  await _validation();
  await _layoutTokens();
}

module.exports = { run: run };
