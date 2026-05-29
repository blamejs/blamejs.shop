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
    canonical_url: "https://acme.example/",
    og_url:        "https://acme.example/",
  });
  check("home includes shop name",      html.indexOf("Acme Shop") !== -1);
  check("home lists both products",      html.indexOf("Widget Pro") !== -1 && html.indexOf("Widget Lite") !== -1);
  check("home includes prices",          html.indexOf("$29.99") !== -1 && html.indexOf("$19.99") !== -1);
  check("home renders cart count",        html.indexOf("Cart, 2 items") !== -1);
  check("home has product links",         html.indexOf("/products/widget-pro") !== -1);
  check("home is full HTML doc",          html.indexOf("<!DOCTYPE html>") === 0);
  // Canonical + og:url carry the absolute request URL the route threads.
  check("home emits canonical link",      html.indexOf("<link rel=\"canonical\" href=\"https://acme.example/\">") !== -1);
  check("home og:url is the absolute URL", html.indexOf("property=\"og:url\" content=\"https://acme.example/\"") !== -1);
  // Organization + WebSite JSON-LD is present on the container home page
  // (ported from the edge so both substrates emit it identically).
  check("home emits Organization JSON-LD", html.indexOf("\"@type\":\"Organization\"") !== -1);
  check("home emits WebSite SearchAction",  html.indexOf("\"SearchAction\"") !== -1);
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
    canonical_url: "https://acme.example/products/widget-pro",
    og_url:        "https://acme.example/products/widget-pro",
  });
  check("product page shows title",       html.indexOf("Widget Pro") !== -1);
  check("product page shows description",  html.indexOf("The pro variant") !== -1);
  check("product page lists variant SKUs", html.indexOf("WDG-PRO-BLK-L") !== -1 && html.indexOf("WDG-PRO-BLK-M") !== -1);
  check("product page shows prices",       html.indexOf("$29.99") !== -1);
  // Canonical link + absolute breadcrumb JSON-LD URLs.
  check("PDP emits canonical link",        html.indexOf("<link rel=\"canonical\" href=\"https://acme.example/products/widget-pro\">") !== -1);
  check("PDP breadcrumb item is absolute", html.indexOf("\"item\":\"https://acme.example/products/widget-pro\"") !== -1);
  // No inventory threaded → never-block stance: in stock + InStock LD.
  check("PDP defaults to In stock badge",  html.indexOf("pdp__badge--ok") !== -1);
  check("PDP JSON-LD is InStock by default", html.indexOf("schema.org/InStock") !== -1);
  // Shipping/returns line links the policy page.
  check("PDP shows shipping/returns note", html.indexOf("class=\"pdp__shipping-note\"") !== -1 &&
                                           html.indexOf("href=\"/terms\"") !== -1);
}

// Truthful availability: a sold-out variant drives the Out-of-stock badge
// AND the JSON-LD `availability` to OutOfStock; a digital variant
// (requires_shipping = 0) suppresses the "Ships in 1–2 business days" line.
async function _productAvailability() {
  var soldOut = storefront.renderProduct({
    product:  { slug: "widget-pro", title: "Widget Pro", description: "" },
    variants: [{ id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large", requires_shipping: 1 }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
    inventory: { "WDG-PRO-BLK-L": { stock_on_hand: 5, stock_held: 5 } },
    shop_name: "Acme",
  });
  check("sold-out PDP shows Out of stock badge",  soldOut.indexOf("pdp__badge--out") !== -1);
  check("sold-out PDP omits In stock badge",      soldOut.indexOf("pdp__badge--ok") === -1);
  check("sold-out PDP JSON-LD is OutOfStock",     soldOut.indexOf("schema.org/OutOfStock") !== -1);

  var inStock = storefront.renderProduct({
    product:  { slug: "widget-pro", title: "Widget Pro", description: "" },
    variants: [{ id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large", requires_shipping: 1 }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
    inventory: { "WDG-PRO-BLK-L": { stock_on_hand: 10, stock_held: 2 } },
    shop_name: "Acme",
  });
  check("in-stock PDP shows In stock badge",      inStock.indexOf("pdp__badge--ok") !== -1);
  check("in-stock PDP JSON-LD is InStock",        inStock.indexOf("schema.org/InStock") !== -1);
  check("physical PDP keeps the ships-in line",   inStock.indexOf("Ships in 1–2 business days") !== -1);

  var digital = storefront.renderProduct({
    product:  { slug: "license", title: "License Key", description: "" },
    variants: [{ id: "v1", sku: "LIC-1", title: "Single seat", requires_shipping: 0 }],
    prices:   { v1: { amount_minor: 4900, currency: "USD" } },
    shop_name: "Acme",
  });
  check("digital PDP suppresses ships-in line",   digital.indexOf("Ships in 1–2 business days") === -1);
  check("digital PDP shows delivered-on-purchase", digital.indexOf("Digital — delivered on purchase") !== -1);
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

// Facet sidebar + active-filter chips + correction notice. The facet
// groups + applied filters arrive pre-computed (the route runs the
// searchFacets primitive); the renderer paints them. Filter links must
// round-trip the query + the toggled facet value through the query
// string, and every facet/value must be HTML-escaped at the href + label
// sink.
async function _searchFacets() {
  var facets = [
    { key: "collection", label: "collection", kind: "categorical", options: [
      { value: "summer", label: "summer", count: 2, selected: true },
      { value: "winter", label: "winter", count: 1, selected: false },
      { value: "gone",   label: "gone",   count: 0, selected: false },
    ] },
    { key: "availability", label: "availability", kind: "boolean", options: [
      { value: "true",  label: "Yes", count: 3, selected: false },
      { value: "false", label: "No",  count: 0, selected: false },
    ] },
  ];
  var html = storefront.renderSearch({
    q:         "tee",
    products:  [{ slug: "p1", title: "Summer Tee", starting_price_minor: 1999 }],
    facets:    facets,
    filters:   { collection: ["summer"] },
    shop_name: "Acme",
  });
  check("facets: renders the sidebar",            html.indexOf("class=\"search-facets\"") !== -1);
  check("facets: renders a facet group",          html.indexOf("class=\"facet-group\"") !== -1);
  check("facets: surfaces option counts",          html.indexOf("class=\"facet-option__count\">2<") !== -1);
  check("facets: hides zero-count unselected opt", html.indexOf(">gone<") === -1);
  check("facets: hides the all-zero boolean group", html.indexOf(">Yes<") !== -1 && html.indexOf(">No<") === -1);
  check("facets: wraps results in the two-col layout", html.indexOf("class=\"search-layout\"") !== -1);
  // Selected option carries the selection cue + a link that toggles it OFF
  // (removes the value), which for a sole filter clears back to `/search?q=tee`.
  check("facets: selected option marked",          html.indexOf("facet-option__link is-selected") !== -1);
  check("facets: selected option aria-current",    html.indexOf("aria-current=\"true\"") !== -1);
  // Toggle-on link for winter carries BOTH the query and the active filter
  // (q first, then the sorted facet values), HTML-escaped at the href sink.
  check("facets: winter link keeps q + active filter",
    html.indexOf("/search?q=tee&amp;collection=summer&amp;collection=winter") !== -1);
  // Active-filter chip + clear-all.
  check("facets: renders an active-filter chip",   html.indexOf("class=\"search-active-filters\"") !== -1);
  check("facets: chip labels group + value",        html.indexOf("collection: summer") !== -1);
  check("facets: offers clear-all",                html.indexOf("Clear all filters") !== -1);
}

// A facet value carrying an XSS / quote-breaking payload must be escaped
// at BOTH the href (query-string built via URLSearchParams, then HTML-
// escaped) and the visible chip/label, so a hostile facet value can't
// break out of the attribute or inject markup.
async function _searchFacetXss() {
  var facets = [
    { key: "collection", label: "collection", kind: "categorical", options: [
      { value: "\"><img src=x onerror=alert(1)>", label: "\"><img src=x onerror=alert(1)>", count: 1, selected: true },
    ] },
  ];
  var html = storefront.renderSearch({
    q:         "tee",
    products:  [],
    facets:    facets,
    filters:   { collection: ["\"><img src=x onerror=alert(1)>"] },
    shop_name: "Acme",
  });
  check("facet XSS: no raw <img onerror in output", html.indexOf("<img src=x onerror=alert(1)>") === -1);
  check("facet XSS: payload escaped in chip label", html.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1);
  check("facet XSS: no unescaped quote in any href", /href="[^"]*"><img/.test(html) === false);
}

// "Showing results for <correction>" — surfaced when a typo / stopword
// rewrite changed the canonical query and there are matches. The
// corrected term is escaped.
async function _searchCorrection() {
  var html = storefront.renderSearch({
    q:               "tshrit",
    products:        [{ slug: "p1", title: "Wool T-Shirt", starting_price_minor: 4999 }],
    corrected_query: "t-shirt",
    shop_name:       "Acme",
  });
  check("correction: surfaces the notice",   html.indexOf("Showing results for") !== -1);
  check("correction: shows the corrected term", html.indexOf("<strong>t-shirt</strong>") !== -1);

  // No notice when the canonical equals the typed query (pure synonym
  // expansion that didn't rewrite the displayed text).
  var same = storefront.renderSearch({
    q:               "tee",
    products:        [{ slug: "p1", title: "Cotton Tee", starting_price_minor: 1999 }],
    corrected_query: "tee",
    shop_name:       "Acme",
  });
  check("correction: no notice when canonical == query", same.indexOf("Showing results for") === -1);
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
    lines:  [{ variant_id: "v1", sku: "X-1", qty: 2, unit_amount_minor: 2999, unit_currency: "USD", line_total_minor: 5998 }],
    totals: { subtotal_minor: 5998, currency: "USD" },
    shop_name: "Acme",
    product_lookup: { v1: { product: { title: "Test Widget", slug: "widget" }, hero_media: null } },
  });
  check("checkout form has email field",    /name=\"email\"/.test(html));
  check("checkout form has country field",   /name=\"country\"/.test(html));
  check("checkout form has street line1",    /name=\"line1\"/.test(html));
  check("checkout form has apt/suite line2", /name=\"line2\"/.test(html));
  check("checkout form has city field",      /name=\"city\"/.test(html));
  check("checkout form shows subtotal",       html.indexOf("$59.98") !== -1);
  check("checkout form POSTs to /checkout",   /action=\"\/checkout\"/.test(html));

  // Two-column shell + sticky summary rail (reuses the cart's classes).
  check("checkout uses the cart grid shell",  html.indexOf("cart-page__grid") !== -1);
  check("checkout has a sticky summary rail",  html.indexOf("cart-page__summary") !== -1);

  // Order-summary line items are rendered (title + qty + line total).
  check("checkout summary lists the item title", html.indexOf("Test Widget") !== -1);
  check("checkout summary shows the line qty",    html.indexOf("Qty 2") !== -1);
  check("checkout summary shows the line total",  html.indexOf("checkout-line__total") !== -1);

  // Honest microcopy — NO fabricated "Total (plus tax + shipping)" line.
  check("checkout drops the fabricated Total line", html.indexOf("plus tax + shipping") === -1);
  check("checkout shows the honest tax/shipping note",
    html.indexOf("Tax and shipping are calculated on the next step") !== -1);

  // Edit-cart link back to /cart.
  check("checkout has an Edit cart link",  /href=\"\/cart\"[^>]*class=\"checkout-page__edit-cart\"|class=\"checkout-page__edit-cart\"[^>]*href=\"\/cart\"|<a href=\"\/cart\" class=\"checkout-page__edit-cart\">/.test(html));

  // Required-field accessible cue — the color-only `*` is paired with a
  // visually-hidden "(required)" so a screen reader announces it.
  check("required fields carry an sr-only (required) cue", html.indexOf("<span class=\"sr-only\">(required)</span>") !== -1);

  // A coded gift-card/loyalty error re-renders the form with the message inline.
  var withErr = storefront.renderCheckoutForm({
    lines:  [{ variant_id: "v1", sku: "X-1", qty: 1, unit_amount_minor: 2999, unit_currency: "USD" }],
    totals: { subtotal_minor: 2999, currency: "USD" },
    shop_name: "Acme",
    inline_error: "That gift card code was not recognized.",
  });
  check("checkout surfaces an inline error", withErr.indexOf("That gift card code was not recognized.") !== -1);
  check("inline error uses role=alert",       withErr.indexOf("role=\"alert\"") !== -1);

  // A signed-in customer's saved address pre-fills the fields (the
  // value is escaped into the input's value attribute).
  var prefilled = storefront.renderCheckoutForm({
    lines:  [{ sku: "X-1", qty: 1, unit_amount_minor: 2999, unit_currency: "USD" }],
    totals: { subtotal_minor: 2999, currency: "USD" },
    shop_name: "Acme",
    prefill: { name: "Ada Lovelace", line1: "500 Market St", city: "San Francisco", country: "US", state: "CA", postal: "94103" },
  });
  check("checkout form pre-fills street",    prefilled.indexOf("value=\"500 Market St\"") !== -1);
  check("checkout form pre-fills city",      prefilled.indexOf("value=\"San Francisco\"") !== -1);
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

async function _passkeysPage() {
  // List with two credentials → revoke is offered on each (more than one
  // sign-in method, so removing one never locks the customer out).
  var html = storefront.renderPasskeys({
    passkeys: [
      { id: "11111111-1111-1111-1111-111111111111", credential_id: "credAAAAAAAAAAAAAAAA", transports: "internal", created_at: Date.UTC(2026, 0, 2) },
      { id: "22222222-2222-2222-2222-222222222222", credential_id: "credBBBBBBBBBBBBBBBB", transports: "usb,nfc",  created_at: Date.UTC(2026, 0, 3) },
    ],
    has_oauth: false,
    shop_name: "Acme",
  });
  check("passkeys page is full HTML doc",      html.indexOf("<!DOCTYPE html>") === 0);
  check("passkeys page titled Passkeys",       html.indexOf("account-passkeys") !== -1);
  check("passkeys list shows both fingerprints", html.indexOf("credAAAAAAAA") !== -1 && html.indexOf("credBBBBBBBB") !== -1);
  check("passkeys list maps transports to labels", html.indexOf("This device") !== -1 && html.indexOf("Security key (USB)") !== -1);
  check("passkeys list shows the added date",     html.indexOf("2026-01-02") !== -1);
  check("passkeys offer per-credential revoke",   html.indexOf("/account/passkeys/11111111-1111-1111-1111-111111111111/remove") !== -1);
  check("passkeys add-another island present",    html.indexOf("id=\"passkey-add-btn\"") !== -1);
  check("passkeys add-another loads the island",  /\/assets\/themes\/default\/js\/passkey-add\.[a-f0-9]{8,}\.js/.test(html));

  // Last credential + NO oauth fallback → revoke is withheld, replaced by
  // a clear "only sign-in method" note so the customer can't lock out.
  var last = storefront.renderPasskeys({
    passkeys: [{ id: "33333333-3333-3333-3333-333333333333", credential_id: "soloCred", created_at: Date.UTC(2026, 0, 4) }],
    has_oauth: false,
    shop_name: "Acme",
  });
  check("last-credential withholds revoke",       last.indexOf("/account/passkeys/33333333-3333-3333-3333-333333333333/remove") === -1);
  check("last-credential surfaces a clear note",  last.indexOf("Only sign-in method") !== -1);

  // Last passkey but a linked OAuth identity → revoke IS offered (the
  // federated login is the fallback).
  var lastWithOauth = storefront.renderPasskeys({
    passkeys: [{ id: "44444444-4444-4444-4444-444444444444", credential_id: "soloCred2", created_at: Date.UTC(2026, 0, 5) }],
    has_oauth: true,
    shop_name: "Acme",
  });
  check("oauth fallback re-enables last revoke",   lastWithOauth.indexOf("/account/passkeys/44444444-4444-4444-4444-444444444444/remove") !== -1);

  // Empty state.
  var empty = storefront.renderPasskeys({ passkeys: [], has_oauth: false, shop_name: "Acme" });
  check("passkeys empty-state shown",             empty.indexOf("No passkeys enrolled") !== -1);
}

async function _passkeyRemoveConfirm() {
  var html = storefront.renderPasskeyRemoveConfirm({
    passkey: { id: "55555555-5555-5555-5555-555555555555", credential_id: "credToRevoke", created_at: Date.UTC(2026, 0, 6) },
    shop_name: "Acme",
  });
  check("confirm page asks before revoking",      html.indexOf("Revoke this passkey?") !== -1);
  check("confirm page POSTs to the revoke route",  html.indexOf("action=\"/account/passkeys/55555555-5555-5555-5555-555555555555/revoke\"") !== -1);
  check("confirm page offers a Cancel link",       html.indexOf("href=\"/account/passkeys\"") !== -1);
}

async function _profilePage() {
  var html = storefront.renderProfile({
    customer:  { id: "c1", display_name: "Ada Lovelace" },
    shop_name: "Acme",
  });
  check("profile page is full HTML doc",          html.indexOf("<!DOCTYPE html>") === 0);
  check("profile pre-fills the display name",      html.indexOf("value=\"Ada Lovelace\"") !== -1);
  check("profile posts to /account/profile",       html.indexOf("action=\"/account/profile\"") !== -1);
  check("profile email field is disabled",          html.indexOf("disabled") !== -1);
  check("profile explains hash-only email",         html.indexOf("never stored in readable form") !== -1);
  check("profile success notice via role=status",   storefront.renderProfile({ customer: { display_name: "x" }, success: "Profile updated.", shop_name: "Acme" }).indexOf("role=\"status\"") !== -1);

  // XSS: a display name with a script tag is escaped into the value attr.
  var xss = storefront.renderProfile({ customer: { display_name: "<script>alert(1)</script>" }, shop_name: "Acme" });
  check("profile escapes display name in value",    xss.indexOf("<script>alert(1)") === -1 && xss.indexOf("&lt;script&gt;") !== -1);
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
  // The default theme CSS is referenced by its content-fingerprinted name
  // (`main.<hash>.css`, no `?v=`), so match the fingerprinted shape rather
  // than the plain filename. (Fingerprint coverage lives in
  // asset-fingerprint.test.js; this just confirms the default path is wired.)
  check("layout points at fingerprinted default theme css",
    /\/assets\/themes\/default\/css\/main\.[a-f0-9]{8,}\.css/.test(html));

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
  check("footer has Your account column",             html.indexOf(">Your account</h4>") !== -1);
  // The footer's account column must not expose /admin to shoppers. Scope
  // the assertion to the footer block (the empty-catalog body still has an
  // operator "Open admin" CTA, which is intentional).
  var footerBlock = html.slice(html.indexOf("class=\"site-footer\""));
  check("footer drops the public Admin link",         footerBlock.indexOf("href=\"/admin\"") === -1);
  check("footer surfaces Shipping & returns",         html.indexOf(">Shipping &amp; returns</a>") !== -1);
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

// Subscription self-management renderer — the controls (pause / resume /
// skip / change-qty / change-freq / reactivate) are state-gated off the
// local control columns the subscriptionControls primitive owns, and the
// ?ok / ?error notices map to fixed copy (no reflected strings).
async function _subscriptionSelfManage() {
  var plan = { interval: "month", interval_count: 1, currency: "usd", amount_minor: 1999 };

  // Active row → pause + skip + quantity + frequency controls, no resume /
  // reactivate. Self-manage off → none of them render.
  var active = storefront.renderAccountSubscriptions({
    subscriptions: [{ id: "11111111-1111-7111-8111-111111111111", status: "active", plan: plan, quantity: 2, current_period_end: Date.now() + 2592000000 }],
    self_manage:   true,
    shop_name:     "Acme",
  });
  check("active offers pause control",       active.indexOf("/account/subscriptions/11111111-1111-7111-8111-111111111111/pause") !== -1);
  check("active offers skip control",        active.indexOf("/account/subscriptions/11111111-1111-7111-8111-111111111111/skip") !== -1);
  check("active offers quantity control",    active.indexOf("/account/subscriptions/11111111-1111-7111-8111-111111111111/quantity") !== -1);
  check("active offers frequency control",   active.indexOf("/account/subscriptions/11111111-1111-7111-8111-111111111111/frequency") !== -1);
  check("active prefills current quantity",  active.indexOf("name=\"quantity\" min=\"1\" step=\"1\" value=\"2\"") !== -1);
  check("active hides resume control",       active.indexOf("/11111111-1111-7111-8111-111111111111/resume") === -1);

  var noManage = storefront.renderAccountSubscriptions({
    subscriptions: [{ id: "11111111-1111-7111-8111-111111111111", status: "active", plan: plan }],
    shop_name:     "Acme",
  });
  check("self-manage off hides controls",    noManage.indexOf("/11111111-1111-7111-8111-111111111111/pause") === -1);

  // Paused row → resume only (no pause / skip).
  var paused = storefront.renderAccountSubscriptions({
    subscriptions: [{ id: "22222222-2222-7222-8222-222222222222", status: "active", plan: plan, paused_at: Date.now(), paused_until: Date.now() + 604800000 }],
    self_manage:   true,
    shop_name:     "Acme",
  });
  check("paused offers resume control",      paused.indexOf("/account/subscriptions/22222222-2222-7222-8222-222222222222/resume") !== -1);
  check("paused hides pause control",        paused.indexOf("/22222222-2222-7222-8222-222222222222/pause") === -1);
  check("paused shows paused-until note",    paused.indexOf("subscription-card__state") !== -1 && paused.indexOf("Paused until") !== -1);

  // Cancelled within grace → reactivate; cancelled past grace → no control.
  var cancelledFresh = storefront.renderAccountSubscriptions({
    subscriptions: [{ id: "33333333-3333-7333-8333-333333333333", status: "canceled", plan: plan, cancelled_at: Date.now() - 86400000 }],
    self_manage:   true,
    shop_name:     "Acme",
  });
  check("fresh cancel offers reactivate",    cancelledFresh.indexOf("/account/subscriptions/33333333-3333-7333-8333-333333333333/reactivate") !== -1);

  var cancelledStale = storefront.renderAccountSubscriptions({
    subscriptions: [{ id: "44444444-4444-7444-8444-444444444444", status: "canceled", plan: plan, cancelled_at: Date.now() - (120 * 24 * 60 * 60 * 1000) }],
    self_manage:   true,
    shop_name:     "Acme",
  });
  check("stale cancel hides reactivate",     cancelledStale.indexOf("/44444444-4444-7444-8444-444444444444/reactivate") === -1);

  // ?ok / ?error notice copy is fixed (no reflected strings).
  var okPage = storefront.renderAccountSubscriptions({ subscriptions: [], self_manage: true, notice: "Your next shipment has been skipped.", shop_name: "Acme" });
  check("ok notice renders role=status",     okPage.indexOf("role=\"status\"") !== -1 && okPage.indexOf("Your next shipment has been skipped.") !== -1);
  var errPage = storefront.renderAccountSubscriptions({ subscriptions: [], self_manage: true, error: "Enter a quantity of 1 or more.", shop_name: "Acme" });
  check("error notice renders role=alert",    errPage.indexOf("role=\"alert\"") !== -1 && errPage.indexOf("Enter a quantity of 1 or more.") !== -1);
}

async function run() {
  await _home();
  await _homeEmpty();
  await _product();
  await _productAvailability();
  await _productNoVariants();
  await _cart();
  await _cartEmpty();
  await _checkoutForm();
  await _payPage();
  await _orderPage();
  await _passkeysPage();
  await _passkeyRemoveConfirm();
  await _profilePage();
  await _search();
  await _searchEmpty();
  await _searchXss();
  await _searchFacets();
  await _searchFacetXss();
  await _searchCorrection();
  await _xssEscape();
  await _validation();
  await _subscriptionSelfManage();
  await _layoutTokens();
}

module.exports = { run: run };
